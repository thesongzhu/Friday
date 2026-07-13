/**
 * Phase 3 Batch 2 — HTTP server wrapping the route registry.
 *
 * Creates a Node.js `http.createServer` that dispatches incoming
 * requests to the matching route handler from the registry.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { URL } from "node:url";
import * as crypto from "node:crypto";
import type { FridayHttpRouteRegistry, FridayRouteEntry } from "./friday-http-route-registry.js";
import type { FridayRealtimeWsGateway } from "../realtime/friday-realtime-ws-gateway.js";
import type { FridayRealtimeEventBus } from "../realtime/friday-realtime-event-bus.types.js";
import type { FridayRealtimeClientFrame, FridayRealtimeServerFrame } from "../model/friday-api-realtime.types.js";
import type { FridayAuthMiddlewareFactory, FridayMiddlewareRejection } from "../auth/friday-auth-middleware.js";
import type { FridayHttpContext, FridayHttpMethod } from "../model/friday-api-common.types.js";
import type { FridayRateLimitPolicyId, FridayRole, FridayScope } from "../model/friday-api-auth.types.js";
import type { WebchatWsService } from "#channels";
import { buildErrorResponse } from "./friday-http-error-mapper.js";
import { isFridayHttpRawTextResponse } from "./friday-http-raw-response.js";
import { buildFridayApiError, FRIDAY_API_ERROR_CODES } from "../model/friday-api-error-codes.js";
import { type FridayHttpTrustProxyMode, resolveFridayClientIp } from "./friday-http-client-ip.js";
import { hashIdempotencyPayload, readIdempotencyKeyHeader } from "./routes/friday-route-idempotency.js";
import {
  type FridayHttpIdempotencyStore,
  FridayInMemoryOperationJournalStore,
} from "./persistence/friday-operation-journal-repository.js";
import { createFridayDefaultPublicHttpPrincipal } from "./friday-default-public-principal.js";
import { isFridaySensitiveReadRoute } from "./friday-sensitive-read-routes.js";
import {
  ERROR_CODE_BOUND_PRINCIPAL_REQUIRED,
  isUnauthenticatedPublicPrincipal,
  redactWebhookPathTokenInPath,
} from "../../security/friday-owner-session-channel-capability.js";

// ─── Types ───

export interface FridayHttpServerDeps {
  routes: FridayHttpRouteRegistry;
  wsGateway: FridayRealtimeWsGateway;
  eventBus?: FridayRealtimeEventBus;
  middleware: FridayAuthMiddlewareFactory;
  port: number;
  host?: string;
  /** CORS allowed origins. `[]` = disabled, `["*"]` = all origins. */
  corsOrigins?: string[];
  /** Enable request logging. Default: true. */
  logRequests?: boolean;
  /** Override the logger function. Default: console.log. */
  logger?: (line: string) => void;
  /** Directory containing static UI assets (dist/ui). */
  uiStaticDir?: string;
  /** Whether to trust proxy forwarding headers when resolving the client IP. */
  trustProxyMode?: FridayHttpTrustProxyMode;
  /** Optional Webchat WS service for /ws/chat style upgrades. */
  webchatWsService?: WebchatWsService;
  /** Optional cleanup callback invoked during server close (e.g. rate limiter dispose). */
  onClose?: () => void;
  /**
   * Durable store backing the generic non-GET idempotency guard. Defaults to an
   * in-memory store (byte-for-byte the previous volatile behavior) so callers that
   * build a server without a db keep working. Production wires a SQLite-backed store
   * (see the CLI run loop) so a completed idempotent response survives a restart
   * instead of the handler re-executing and duplicating its side-effect.
   */
  idempotencyStore?: FridayHttpIdempotencyStore;
}

export interface FridayHttpServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  readonly port: number;
}

// ─── Helpers ───

const FRIDAY_METHODS_WITH_BODY: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const FRIDAY_HTTP_MAX_BODY_BYTES = 1_048_576; // 1MB
const FRIDAY_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Base security headers applied to every response. */
const FRIDAY_BASE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

/**
 * Security headers, including HSTS by default.
 * Set `FRIDAY_ENABLE_HSTS=false` to disable explicitly.
 */
const FRIDAY_SECURITY_HEADERS: Readonly<Record<string, string>> =
  process.env.FRIDAY_ENABLE_HSTS !== "false"
    ? {
        ...FRIDAY_BASE_SECURITY_HEADERS,
        "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
      }
    : FRIDAY_BASE_SECURITY_HEADERS;

/**
 * Extract path params by matching a route pattern against an actual path.
 * Pattern segments starting with `:` are treated as named params.
 */
class MalformedUriError extends Error {
  constructor(segment: string) {
    super(`Malformed URI component: ${segment}`);
    this.name = "MalformedUriError";
  }
}

function isMissingFileError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

function extractParams(pattern: string, actual: string): Record<string, string> {
  const patternParts = pattern.split("/");
  const actualParts = actual.split("/");
  const params: Record<string, string> = {};

  for (let i = 0; i < patternParts.length; i++) {
    const segment = patternParts[i]!;
    if (segment.startsWith(":")) {
      try {
        params[segment.slice(1)] = decodeURIComponent(actualParts[i]!);
      } catch (err) {
        console.warn("[friday][http-server] operation failed:", err instanceof Error ? err.message : String(err));
        throw new MalformedUriError(actualParts[i]!);
      }
    }
  }

  return params;
}

/**
 * Parse query string into a plain object.
 */
function parseQuery(searchParams: URLSearchParams): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of searchParams) {
    query[key] = value;
  }
  return query;
}

/**
 * Read the full request body as a string with size limit enforcement.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > FRIDAY_HTTP_MAX_BODY_BYTES) {
        req.destroy();
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function hasJsonContentType(headers: IncomingMessage["headers"]): boolean {
  const raw = headers["content-type"];
  const contentType = Array.isArray(raw) ? raw.join(",") : raw;
  if (!contentType) return false;
  return contentType
    .split(";")[0]!
    .trim()
    .toLowerCase()
    .includes("json");
}

function assertSerializableJsonResponse(value: unknown, operationId: string): void {
  if (value === undefined) {
    throw new Error(`Route '${operationId}' returned undefined without taking over the response`);
  }
  try {
    JSON.stringify(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Route '${operationId}' returned a non-JSON-serializable response: ${message}`);
  }
}

class PayloadTooLargeError extends Error {
  constructor() {
    super("Payload Too Large");
    this.name = "PayloadTooLargeError";
  }
}

/**
 * Map a FridayMiddlewareRejection to a JSON error response.
 */
function sendMiddlewareRejection(
  res: ServerResponse,
  rejection: FridayMiddlewareRejection,
  requestId: string,
  extraHeaders: Record<string, string> = {},
  headOnly = false,
): void {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    ...FRIDAY_SECURITY_HEADERS,
    ...rejection.headers,
    ...extraHeaders,
  };
  if (rejection.retryAfterMs != null && rejection.retryAfterMs > 0) {
    headers["Retry-After"] = String(Math.ceil(rejection.retryAfterMs / 1000));
  }
  const body = JSON.stringify({
    ok: false,
    error: {
      code: rejection.code,
      message: rejection.message,
      retryable: rejection.statusCode === 429,
      ...(rejection.retryAfterMs != null ? { retryAfterMs: rejection.retryAfterMs } : {}),
    },
    requestId,
  });
  headers["Content-Length"] = String(Buffer.byteLength(body));
  res.writeHead(rejection.statusCode, headers);
  if (headOnly) {
    res.end();
  } else {
    res.end(body);
  }
}

/**
 * Send a JSON response with optional extra headers (e.g. CORS).
 * When `headOnly` is true, headers are sent but the body is suppressed (HEAD requests).
 */
function sendJsonWithHeaders(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
  headOnly = false,
): void {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    ...FRIDAY_SECURITY_HEADERS,
    ...extraHeaders,
  });
  if (headOnly) {
    res.end();
  } else {
    res.end(json);
  }
}

// ─── Static file serving helpers ───

/** Check whether a request path is an API path. */
function isApiPath(pathname: string): boolean {
  return pathname === "/v1" || pathname.startsWith("/v1/");
}

/** MIME type map for static assets. */
const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

function getMimeType(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Resolve a pathname to a safe absolute path within the UI static dir.
 * Returns null if the resolved path escapes the root (path traversal).
 */
function resolveSafeUiPath(uiStaticDir: string, pathname: string): string | null {
  const decoded = decodeURIComponent(pathname);
  const resolved = resolve(uiStaticDir, `.${decoded}`);
  const normalizedRoot = resolve(uiStaticDir);
  const rel = relative(normalizedRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return resolved;
}

/**
 * Serve a static file with proper headers.
 */
function serveStaticFile(
  res: ServerResponse,
  filePath: string,
  fileSize: number,
  headOnly: boolean,
  secHeaders: Readonly<Record<string, string>>,
): void {
  const mime = getMimeType(filePath);
  // Normalize Windows backslashes so asset cache semantics are cross-platform.
  const normalizedFilePath = filePath.replace(/\\/g, "/");
  const isAsset = normalizedFilePath.includes("/assets/");
  const cacheControl = isAsset
    ? "public, max-age=31536000, immutable"
    : "no-cache";

  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": fileSize,
    "Cache-Control": cacheControl,
    ...secHeaders,
  });

  if (headOnly) {
    res.end();
    return;
  }

  createReadStream(filePath).pipe(res);
}

/**
 * Try to serve a UI static asset. Returns true if served.
 */
async function tryServeUiAsset(
  uiStaticDir: string,
  pathname: string,
  rawRequestUrl: string,
  headOnly: boolean,
  res: ServerResponse,
  secHeaders: Readonly<Record<string, string>>,
): Promise<boolean> {
  // Try the exact file first
  const safePath = resolveSafeUiPath(uiStaticDir, pathname);
  if (safePath) {
    try {
      const fileStat = await stat(safePath);
      if (fileStat.isFile()) {
        serveStaticFile(res, safePath, fileStat.size, headOnly, secHeaders);
        return true;
      }
    } catch (err) {
      if (!isMissingFileError(err)) {
        console.warn("[friday][http-server] operation failed:", err instanceof Error ? err.message : String(err));
      }
      // File doesn't exist — fall through
    }
  }

  // SPA fallback: serve index.html only for clean frontend-like paths.
  // Reject traversal-like request targets and filesystem-like paths.
  const rawPath = rawRequestUrl.split("?")[0]?.split("#")[0] ?? rawRequestUrl;
  const rawPathLower = rawPath.toLowerCase();
  const pathSegments = pathname.split("/").filter((segment) => segment.length > 0);
  const firstSegment = pathSegments[0]?.toLowerCase();
  const blockedFsRoots = new Set([
    "bin",
    "boot",
    "dev",
    "etc",
    "lib",
    "lib64",
    "opt",
    "proc",
    "root",
    "sbin",
    "sys",
    "usr",
    "var",
  ]);
  const looksLikeSystemPath = pathSegments.length >= 2 && firstSegment != null && blockedFsRoots.has(firstSegment);
  if (
    !pathname.startsWith("/") ||
    !rawPath.startsWith("/") ||
    /(?:^|\/)\.\.(?:\/|$)/.test(pathname) ||
    rawPath.includes("..") ||
    rawPathLower.includes("%2e%2e") ||
    rawPathLower.includes("%2f") ||
    rawPathLower.includes("%5c") ||
    looksLikeSystemPath
  ) {
    return false;
  }
  const indexPath = join(uiStaticDir, "index.html");
  try {
    const indexStat = await stat(indexPath);
    if (indexStat.isFile()) {
      serveStaticFile(res, indexPath, indexStat.size, headOnly, secHeaders);
      return true;
    }
  } catch (err) {
    if (!isMissingFileError(err)) {
        console.warn("[friday][http-server] operation failed:", err instanceof Error ? err.message : String(err));
    }
    // index.html doesn't exist
  }

  return false;
}

function describeUiMountIssue(uiStaticDir: string | undefined, pathname: string): string | null {
  if (pathname !== "/") {
    return null;
  }

  if (!uiStaticDir) {
    return "This Friday instance is serving API routes only. Build the UI and mount dist/ui to open the web app at /.";
  }

  const normalizedUiDir = resolve(uiStaticDir);
  if (!existsSync(normalizedUiDir)) {
    return `UI static assets are unavailable. Directory not found: ${normalizedUiDir}. Run npm run build and point FRIDAY_UI_DIST_DIR at dist/ui.`;
  }

  const indexPath = join(normalizedUiDir, "index.html");
  if (!existsSync(indexPath)) {
    return `UI static assets are incomplete. Missing ${indexPath}. Run npm run build to regenerate dist/ui, then restart Friday.`;
  }

  return null;
}

// ─── Factory ───

/**
 * Check whether the given origin is allowed by the CORS config.
 */
function isOriginAllowed(origin: string, allowedOrigins: readonly string[]): boolean {
  if (allowedOrigins.length === 0) return false;
  if (allowedOrigins.includes("*")) return true;
  return allowedOrigins.includes(origin);
}

/**
 * Decide whether a WebSocket upgrade carrying this `Origin` may proceed.
 *
 * Browsers always attach an `Origin`; native / non-browser clients never do.
 * A cross-site browser origin is a cross-site WebSocket hijacking attempt and
 * MUST be rejected even when the CORS allowlist is empty (the production
 * default) — but without breaking the legitimate local UI or native app. So an
 * Origin, when present, is trusted only if it is (in order):
 *   1. an explicit allowlist match (or "*"),
 *   2. the same host as the request's `Host` header (true same-origin), or
 *   3. a loopback origin (localhost / 127.0.0.1 / ::1) — the local UI or a dev
 *      server on this machine, never a remote attacker.
 * An absent Origin is decided by the caller (allowed: non-browser client).
 */
function isTrustedWsOrigin(
  origin: string,
  hostHeader: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (isOriginAllowed(origin, allowedOrigins)) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (hostHeader && parsed.host === hostHeader.toLowerCase()) return true;
  const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  return LOOPBACK_HOSTNAMES.has(parsed.hostname);
}

// ─── RFC 6455 inbound (client→server) frame decoding ─────────────────────────

/** Reassembly cursor for a single realtime WebSocket connection (RFC 6455 §5.4). */
interface WsFrameReaderState {
  /** Bytes received but not yet fully parsed into frames. */
  buffer: Buffer;
  /** Opcode (0x1 text / 0x2 binary) of the in-progress fragmented message, or null. */
  fragmentedOpcode: number | null;
  /** Payload chunks accumulated for the in-progress message. */
  fragmentedChunks: Buffer[];
  /** Total bytes accumulated for the in-progress message. */
  fragmentedSize: number;
}

/** An event surfaced by {@link readWsClientFrames} for the connection loop to act on. */
type WsClientFrameEvent =
  | { type: "message"; opcode: number; payload: Buffer } // complete data message (0x1/0x2)
  | { type: "ping"; payload: Buffer }
  | { type: "pong" }
  | { type: "close" }
  | { type: "protocol-error"; code: number } // close with `code` then drop
  | { type: "drop" }; // silently destroy (oversized frame)

/**
 * Validate a client frame header against RFC 6455. Returns the close code to
 * fail the connection with, or null when the header is well-formed.
 */
function wsClientFrameHeaderViolation(
  fin: boolean,
  rsv: number,
  opcode: number,
  masked: boolean,
  payloadLen: number,
): number | null {
  // §5.2 reserved bits must be zero when no extension is negotiated.
  if (rsv !== 0) return 1002;
  // §5.2 opcodes 0x3-0x7 and 0xb-0xf are reserved.
  const known =
    opcode === 0x0 ||
    opcode === 0x1 ||
    opcode === 0x2 ||
    opcode === 0x8 ||
    opcode === 0x9 ||
    opcode === 0xa;
  if (!known) return 1002;
  // §5.1 client→server frames MUST be masked.
  if (!masked) return 1002;
  // §5.5 control frames MUST be ≤125 bytes and MUST NOT be fragmented.
  if (opcode >= 0x8 && (payloadLen > 125 || !fin)) return 1002;
  return null;
}

/**
 * Fold a data frame (0x0 continuation / 0x1 text / 0x2 binary) into the
 * reassembly `state`. Returns the completed message when this frame finished
 * one, an `errorCode` on a fragmentation protocol violation, or `{}` while more
 * fragments are still expected.
 */
function assembleWsDataFrame(
  state: WsFrameReaderState,
  opcode: number,
  fin: boolean,
  payload: Buffer,
  maxMessageSize: number,
): { done?: { opcode: number; payload: Buffer }; errorCode?: number } {
  if (opcode === 0x0) {
    // Continuation — a data message MUST already be in progress.
    if (state.fragmentedOpcode === null) return { errorCode: 1002 };
    state.fragmentedChunks.push(Buffer.from(payload));
    state.fragmentedSize += payload.length;
    if (state.fragmentedSize > maxMessageSize) return { errorCode: 1009 };
    if (!fin) return {}; // more fragments to come
    const done = {
      opcode: state.fragmentedOpcode,
      payload: Buffer.concat(state.fragmentedChunks),
    };
    state.fragmentedOpcode = null;
    state.fragmentedChunks = [];
    state.fragmentedSize = 0;
    return { done };
  }
  // New data frame — MUST NOT arrive while a message is being assembled.
  if (state.fragmentedOpcode !== null) return { errorCode: 1002 };
  if (fin) return { done: { opcode, payload } };
  // Begin a fragmented message.
  state.fragmentedOpcode = opcode;
  state.fragmentedChunks = [Buffer.from(payload)];
  state.fragmentedSize = payload.length;
  if (state.fragmentedSize > maxMessageSize) return { errorCode: 1009 };
  return {};
}

/**
 * Pull every fully-buffered client frame out of `state.buffer`, unmasking and
 * reassembling per RFC 6455 §5. Consumes parsed bytes from `state.buffer` and
 * yields one {@link WsClientFrameEvent} per frame/message. Stops (returns) when
 * only a partial frame remains, leaving it buffered for the next chunk.
 */
function* readWsClientFrames(
  state: WsFrameReaderState,
  maxFrameSize: number,
  maxMessageSize: number,
): Generator<WsClientFrameEvent> {
  while (state.buffer.length >= 2) {
    const buffer = state.buffer;
    const firstByte = buffer[0]!;
    const secondByte = buffer[1]!;
    const fin = (firstByte & 0x80) !== 0;
    const rsv = firstByte & 0x70;
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLen = secondByte & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (buffer.length < 4) return; // wait for more data
      payloadLen = buffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      if (buffer.length < 10) return;
      payloadLen = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }

    // Reject malformed/hostile headers before buffering the (possibly large) payload.
    const violation = wsClientFrameHeaderViolation(fin, rsv, opcode, masked, payloadLen);
    if (violation !== null) {
      yield { type: "protocol-error", code: violation };
      return;
    }

    // Guard against oversized frames (RFC 6455 §7.4.1). Prior behavior: silent drop.
    if (payloadLen > maxFrameSize) {
      yield { type: "drop" };
      return;
    }

    // Client frames are always masked (validated above) → 4-byte masking key.
    const totalLen = offset + 4 + payloadLen;
    if (buffer.length < totalLen) return; // wait for the full frame

    const maskKey = buffer.subarray(offset, offset + 4);
    const payload = buffer.subarray(offset + 4, totalLen);
    for (let i = 0; i < payload.length; i++) {
      payload[i] = payload[i]! ^ maskKey[i % 4]!;
    }

    // Consume the frame from the buffer.
    state.buffer = buffer.subarray(totalLen);

    // Control frames are handled independently of fragmentation state.
    if (opcode === 0x8) {
      yield { type: "close" };
      return;
    }
    if (opcode === 0x9) {
      yield { type: "ping", payload };
      continue;
    }
    if (opcode === 0xa) {
      yield { type: "pong" };
      continue;
    }

    // Data frame (0x0 / 0x1 / 0x2): reassemble.
    const res = assembleWsDataFrame(state, opcode, fin, payload, maxMessageSize);
    if (res.errorCode !== undefined) {
      yield { type: "protocol-error", code: res.errorCode };
      return;
    }
    if (res.done) {
      yield { type: "message", opcode: res.done.opcode, payload: res.done.payload };
    }
  }
}

/**
 * Build CORS headers for the given origin.
 */
function buildCorsHeaders(
  origin: string,
  allowedOrigins: readonly string[],
): Record<string, string> {
  if (!isOriginAllowed(origin, allowedOrigins)) return {};
  const allowOrigin = allowedOrigins.includes("*") ? "*" : origin;
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-Id, Idempotency-Key",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export function createFridayHttpServer(deps: FridayHttpServerDeps): FridayHttpServer {
  const { routes, port, host, middleware } = deps;
  const corsOrigins: readonly string[] = deps.corsOrigins ?? [];
  const logRequests = deps.logRequests ?? false;
  const logger = deps.logger ?? console.log;
  const uiStaticDir = deps.uiStaticDir ?? undefined;
  const trustProxyMode = deps.trustProxyMode ?? "off";
  const hasObservabilityRoutes = routes
    .getRoutes()
    .some((route) => route.path.startsWith("/v1/observability"));
  // Durable-by-default in production (SQLite journal survives restarts); falls back to an
  // in-memory store (byte-for-byte the previous behavior) when no db-backed store is injected.
  const idempotencyStore: FridayHttpIdempotencyStore =
    deps.idempotencyStore ?? new FridayInMemoryOperationJournalStore();

  function pruneExpiredIdempotencyEntries(nowMs: number): void {
    idempotencyStore.pruneExpired(nowMs);
  }

  // Track active connections so close() can destroy keep-alive sockets
  const connections = new Set<Socket>();

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = crypto.randomUUID();
    const receivedAt = new Date().toISOString();
    const startNs = process.hrtime.bigint();

    // Request logging on response finish.
    // Phase 14.5A module_28a: redact workflow webhook path tokens before they
    // hit the access log. Path tokens may be the only credential for bearer-
    // only-opt-in webhooks; leaking them into local stdout/file logs would
    // defeat the receipt-trust label.
    if (logRequests) {
      res.on("finish", () => {
        const elapsedNs = process.hrtime.bigint() - startNs;
        const elapsedMs = Number(elapsedNs / 1_000_000n);
        const method = req.method ?? "GET";
        const url = redactWebhookPathTokenInPath(req.url ?? "/");
        logger(`[FRIDAY] ${method} ${url} ${res.statusCode} ${elapsedMs}ms`);
      });
    }

    // CORS: get origin header
    const origin = req.headers.origin ?? "";
    const corsHeaders = origin ? buildCorsHeaders(origin, corsOrigins) : {};

    const rawMethod = (req.method ?? "GET").toUpperCase();
    const isHead = rawMethod === "HEAD";

    // Declared outside the request try so the catch block can release an in-flight idempotency
    // reservation if the handler throws.
    let idempotencyStoreKey: string | undefined;

    try {
      // Handle CORS preflight (before casting to FridayHttpMethod)
      if (rawMethod === "OPTIONS" && origin && isOriginAllowed(origin, corsOrigins)) {
        res.writeHead(204, { ...FRIDAY_SECURITY_HEADERS, ...corsHeaders });
        res.end();
        return;
      }

      const method = (isHead ? "GET" : rawMethod) as FridayHttpMethod;

      // Parse URL
      const rawRequestUrl = req.url ?? "/";
      const parsedUrl = new URL(rawRequestUrl, `http://${req.headers.host ?? "localhost"}`);
      const pathname = parsedUrl.pathname;

      // Serve static UI assets for non-API GET/HEAD requests
      if (uiStaticDir && !isApiPath(pathname) && (rawMethod === "GET" || rawMethod === "HEAD")) {
        const served = await tryServeUiAsset(
          uiStaticDir,
          pathname,
          rawRequestUrl,
          isHead,
          res,
          FRIDAY_SECURITY_HEADERS,
        );
        if (served) return;
      }

      // Match route (HEAD uses GET handler)
      const route: FridayRouteEntry | undefined = routes.findRoute(method, pathname);

      if (!route) {
        const uiMountIssue = (rawMethod === "GET" || rawMethod === "HEAD")
          ? describeUiMountIssue(uiStaticDir, pathname)
          : null;
        const isObservabilityPath = pathname.startsWith("/v1/observability");
        const notFoundMessage = uiMountIssue ?? (
          isObservabilityPath && !hasObservabilityRoutes
            ? "Observability API is not enabled on this Friday instance."
            : `No route matches ${method} ${pathname}`
        );
        sendJsonWithHeaders(res, 404, {
          ok: false,
          error: buildFridayApiError(FRIDAY_API_ERROR_CODES.NOT_FOUND, notFoundMessage),
          requestId,
        }, corsHeaders, isHead);
        return;
      }

      // Parse body for methods that carry one
      let body: unknown = {};
      let rawBody: string | undefined;
      if (FRIDAY_METHODS_WITH_BODY.has(method)) {
        let raw: string;
        try {
          raw = await readBody(req);
        } catch (err) {
          if (err instanceof PayloadTooLargeError) {
            sendJsonWithHeaders(res, 413, {
              ok: false,
              error: buildFridayApiError(FRIDAY_API_ERROR_CODES.PAYLOAD_TOO_LARGE, "Request body exceeds 1MB limit"),
              requestId,
            }, corsHeaders, isHead);
            return;
          }
          throw err;
        }
        rawBody = raw;
        if (raw.length > 0) {
          if (!hasJsonContentType(req.headers)) {
            sendJsonWithHeaders(res, 415, {
              ok: false,
              error: {
                code: "UNSUPPORTED_MEDIA_TYPE",
                message: "Request body must use an application/json content type",
                retryable: false,
              },
              requestId,
            }, corsHeaders, isHead);
            return;
          }
          try {
            body = JSON.parse(raw);
          } catch (err) {
        console.warn("[friday][http-server] operation failed:", err instanceof Error ? err.message : String(err));
            sendJsonWithHeaders(res, 400, {
              ok: false,
              error: buildFridayApiError(FRIDAY_API_ERROR_CODES.INVALID_JSON, "Request body is not valid JSON"),
              requestId,
            }, corsHeaders, isHead);
            return;
          }
        }
      }

      // Extract params and query
      let params: Record<string, string>;
      try {
        params = extractParams(route.path, pathname);
      } catch (err) {
        if (err instanceof MalformedUriError) {
          sendJsonWithHeaders(res, 400, {
            ok: false,
            error: buildFridayApiError(FRIDAY_API_ERROR_CODES.INVALID_PATH, "Malformed URL-encoded path parameter"),
            requestId,
          }, corsHeaders, isHead);
          return;
        }
        throw err;
      }
      const query = parseQuery(parsedUrl.searchParams);

      // Build headers map
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
      }
      const socketIp = req.socket.remoteAddress;
      const clientIp = resolveFridayClientIp({
        socketIp,
        headers,
        trustProxyMode,
      });

      // Build context
      const ctx: FridayHttpContext<unknown, unknown, unknown> = {
        requestId,
        receivedAt,
        ip: clientIp,
        socketIp,
        userAgent: req.headers["user-agent"],
        params,
        query,
        body,
        headers,
        principal: null,
        rawBody,
      };

      // Middleware headers to merge into the response
      let middlewareHeaders: Record<string, string> = {};

      // Enforce auth/scope/role/rate-limit middleware (always — middleware is required)
      // Auth enforcement
      if (route.auth.public === false) {
        const authResult = middleware.requireAuth(ctx);
        if (!authResult.passed) {
          sendMiddlewareRejection(res, authResult, requestId, corsHeaders, isHead);
          return;
        }
        if (authResult.headers) Object.assign(middlewareHeaders, authResult.headers);

        // Scope enforcement
        if (route.auth.anyOfScopes) {
          const scopeResult = middleware.requireAnyScope(
            ctx,
            route.auth.anyOfScopes as FridayScope[],
          );
          if (!scopeResult.passed) {
            sendMiddlewareRejection(res, scopeResult, requestId, corsHeaders, isHead);
            return;
          }
          if (scopeResult.headers) Object.assign(middlewareHeaders, scopeResult.headers);
        }

        // Role enforcement
        if (route.auth.anyOfRoles) {
          const roleResult = middleware.requireAnyRole(
            ctx,
            route.auth.anyOfRoles as FridayRole[],
          );
          if (!roleResult.passed) {
            sendMiddlewareRejection(res, roleResult, requestId, corsHeaders, isHead);
            return;
          }
          if (roleResult.headers) Object.assign(middlewareHeaders, roleResult.headers);
        }
      } else {
        // Public-route auth-boundary posture: every HTTP route is reachable without
        // an Authorization header. But if the caller DID supply a valid
        // `Authorization: Bearer <token>`, hydrate ctx.principal with the real
        // validated principal so token-backed identity (e.g. /v1/auth/me, audit
        // actor stamping, canonical-mutation-gate actor recording) keeps working
        // for authenticated clients. Malformed / invalid / missing Authorization
        // headers fall back to the synthetic default-public principal — they do
        // NOT downgrade to 401, because the product decision is no-login-required.
        const authHeader = ctx.headers["authorization"] ?? ctx.headers["Authorization"];
        if (authHeader) {
          const authResult = middleware.requireAuth(ctx);
          if (authResult.passed) {
            if (authResult.headers) Object.assign(middlewareHeaders, authResult.headers);
          } else {
            ctx.principal = createFridayDefaultPublicHttpPrincipal();
          }
        } else {
          ctx.principal = createFridayDefaultPublicHttpPrincipal();
        }
      }

      // Public-mutation safety floor (GEC-001/GEC-002/GEC-004/GEC-005).
      // The synthetic default-public principal cannot authorize POST/PUT/PATCH/DELETE
      // on `auth:{public:true}` routes. Routes that legitimately must remain reachable
      // pre-auth (first-boot setup, auth bootstrap, externally-HMAC'd channel webhooks,
      // WebAuthn handshakes, etc.) must opt in via `allowUnauthenticatedMutation: true`
      // AND enforce an alternative trust boundary in the handler before any side effect.
      if (
        route.auth.public === true &&
        route.auth.allowUnauthenticatedMutation !== true &&
        (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") &&
        isUnauthenticatedPublicPrincipal(ctx.principal)
      ) {
        sendMiddlewareRejection(
          res,
          {
            passed: false,
            statusCode: 401,
            code: ERROR_CODE_BOUND_PRINCIPAL_REQUIRED,
            message: `${route.operationId} requires a bound owner/session/channel principal; the synthetic public principal cannot approve mutating operations.`,
          },
          requestId,
          { ...corsHeaders, ...middlewareHeaders },
          isHead,
        );
        return;
      }

      // Sensitive-read auth floor (companion to the public-mutation floor above).
      // The synthetic default-public principal is shared across ALL anonymous callers, so
      // letting it READ sensitive surfaces (personal memory, secret metadata, security
      // posture, fleet inventory, diagnosis, session details) both leaks data between
      // anonymous callers and exposes those surfaces network-wide. Locked decision: sensitive
      // reads require a bound principal; anonymous access is only for minimal
      // setup/health/onboarding. A local user authenticates via the localhost bootstrap →
      // login → bearer flow (untouched here) to reach these. Core no-login UX surfaces are
      // intentionally not classified sensitive (see friday-sensitive-read-routes.ts).
      if (
        route.auth.public === true &&
        method === "GET" && // HEAD is normalized to "GET" above (isHead flag), so this covers both
        isFridaySensitiveReadRoute(route.path) &&
        isUnauthenticatedPublicPrincipal(ctx.principal)
      ) {
        sendMiddlewareRejection(
          res,
          {
            passed: false,
            statusCode: 401,
            code: ERROR_CODE_BOUND_PRINCIPAL_REQUIRED,
            message: `${route.operationId} reads sensitive data and requires a bound owner/session/channel principal; sign in (local passphrase) to access it.`,
          },
          requestId,
          { ...corsHeaders, ...middlewareHeaders },
          isHead,
        );
        return;
      }

      // Rate limit enforcement (applies to both public and authenticated routes)
      if (route.rateLimitPolicyId) {
        const rateLimitResult = middleware.enforceRateLimit(
          ctx,
          route.rateLimitPolicyId as FridayRateLimitPolicyId,
        );
        if (!rateLimitResult.passed) {
          sendMiddlewareRejection(res, rateLimitResult, requestId, corsHeaders, isHead);
          return;
        }
        if (rateLimitResult.headers) Object.assign(middlewareHeaders, rateLimitResult.headers);
      }

      const idempotencyKey = method === "GET" ? undefined : readIdempotencyKeyHeader(ctx.headers);
      if (idempotencyKey) {
        pruneExpiredIdempotencyEntries(Date.now());
        const principalId = ctx.principal?.principalId ?? "anonymous";
        const payloadHash = hashIdempotencyPayload({
          method,
          path: route.path,
          params,
          query,
          body,
        });
        const idempotencyLookupKey = `${principalId}:${route.operationId}:${idempotencyKey}`;
        const existing = idempotencyStore.get(idempotencyLookupKey);
        if (existing) {
          // Crash-orphaned reservation (marked indeterminate at boot): the prior request may
          // have committed its side-effect but never wrote its completed receipt. Fail closed —
          // never auto-retry, never re-execute. Non-retryable 409 takes precedence over every
          // other existing-entry outcome below.
          if (existing.status === "indeterminate") {
            sendJsonWithHeaders(res, 409, {
              ok: false,
              error: {
                code: "SECURITY_IDEMPOTENCY_INDETERMINATE",
                message: "a prior request with this Idempotency-Key did not complete; its outcome is indeterminate and will not be auto-retried.",
                retryable: false,
              },
              requestId,
            }, { ...corsHeaders, ...middlewareHeaders }, isHead);
            return;
          }
          if (existing.payloadHash !== payloadHash || existing.operationId !== route.operationId) {
            sendJsonWithHeaders(res, 409, {
              ok: false,
              error: {
                code: "SECURITY_IDEMPOTENCY_KEY_CONFLICT",
                message: `Idempotency-Key '${idempotencyKey}' was already used with a different payload for operation '${route.operationId}'.`,
                retryable: false,
              },
              requestId,
            }, { ...corsHeaders, ...middlewareHeaders }, isHead);
            return;
          }

          // A matching-payload request with this key is still executing (reservation set below
          // before the handler runs). Reject the concurrent duplicate instead of running the
          // handler a second time — closing the check-then-set race where two same-key requests
          // both miss the store and both execute. Retryable: the caller can retry once the
          // in-flight request completes and a replayable entry exists.
          if (existing.status === "in_flight") {
            sendJsonWithHeaders(res, 409, {
              ok: false,
              error: {
                code: "SECURITY_IDEMPOTENCY_IN_PROGRESS",
                message: `Idempotency-Key '${idempotencyKey}' is already being processed for operation '${route.operationId}'.`,
                retryable: true,
              },
              requestId,
            }, { ...corsHeaders, ...middlewareHeaders }, isHead);
            return;
          }

          const replayBody = JSON.stringify({
            ok: true,
            data: existing.data,
            requestId,
          });
          const replayHeaders: Record<string, string | number> = {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(replayBody),
            "Idempotency-Replayed": "true",
            ...FRIDAY_SECURITY_HEADERS,
            ...middlewareHeaders,
            ...corsHeaders,
          };
          res.writeHead(200, replayHeaders);
          if (isHead) {
            res.end();
          } else {
            res.end(replayBody);
          }
          return;
        }

        // Reserve the key BEFORE running the handler so a concurrent same-key request sees
        // `in_flight` and is rejected above, rather than both requests executing the handler.
        // The durable store's reserve is atomic: on a cross-process race it throws a typed 409
        // (mapped by the catch below) instead of silently overwriting. `idempotencyStoreKey` is
        // only set AFTER a successful reserve, so a reserve that loses the race does NOT let the
        // release paths delete the winner's reservation.
        idempotencyStore.reserve(idempotencyLookupKey, {
          operationId: route.operationId,
          principalId,
          payloadHash,
          expiresAtMs: Date.now() + FRIDAY_IDEMPOTENCY_TTL_MS,
        });
        idempotencyStoreKey = idempotencyLookupKey;
      }

      // Inject raw response reference for SSE streaming routes
      (ctx as FridayHttpContext<unknown, unknown, unknown> & { _raw?: ServerResponse })._raw = res;

      // Call handler
      const result = await route.handler(ctx);

      // If the handler already took over the response (e.g. SSE streaming), bail out.
      // The handler owns the response, so there is no replayable JSON body to cache — drop the
      // in-flight reservation so the key is not wedged until TTL.
      if (res.headersSent || res.writableEnded) {
        if (idempotencyStoreKey) idempotencyStore.release(idempotencyStoreKey);
        return;
      }

      if (isFridayHttpRawTextResponse(result)) {
        // Raw-text responses are not cached for replay (original behavior); release the
        // reservation so a later same-key request is not rejected against a never-completed entry.
        if (idempotencyStoreKey) idempotencyStore.release(idempotencyStoreKey);
        const responseBody = result.body;
        const responseHeaders: Record<string, string | number> = {
          "Content-Type": result.contentType ?? "text/plain; charset=utf-8",
          "Content-Length": Buffer.byteLength(responseBody),
          ...FRIDAY_SECURITY_HEADERS,
          ...middlewareHeaders,
          ...corsHeaders,
          ...(result.headers ?? {}),
        };
        res.writeHead(result.statusCode, responseHeaders);
        if (isHead) {
          res.end();
        } else {
          res.end(responseBody);
        }
        return;
      }

      assertSerializableJsonResponse(result, route.operationId);

      if (idempotencyStoreKey) {
        // Upgrade the in-flight reservation to a completed, replayable entry.
        idempotencyStore.complete(idempotencyStoreKey, {
          operationId: route.operationId,
          principalId: ctx.principal?.principalId ?? "anonymous",
          payloadHash: hashIdempotencyPayload({
            method,
            path: route.path,
            params,
            query,
            body,
          }),
          data: result,
          expiresAtMs: Date.now() + FRIDAY_IDEMPOTENCY_TTL_MS,
        });
      }

      // Send success response with middleware + CORS headers merged in
      const successBody = JSON.stringify({
        ok: true,
        data: result,
        requestId,
      });
      const responseHeaders: Record<string, string | number> = {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(successBody),
        ...FRIDAY_SECURITY_HEADERS,
        ...middlewareHeaders,
        ...corsHeaders,
      };
      res.writeHead(200, responseHeaders);
      // HEAD requests get headers but no body
      if (isHead) {
        res.end();
      } else {
        res.end(successBody);
      }
    } catch (error: unknown) {
      // The handler threw, so no completed entry was written. Release the in-flight reservation
      // so this idempotency key is retryable rather than wedged in_flight until TTL. Only set when
      // THIS request won the reservation, so a lost cross-process reserve race never releases the
      // winner's row.
      if (idempotencyStoreKey) idempotencyStore.release(idempotencyStoreKey);
      // If headers were already sent (e.g. SSE stream errored mid-flight), we cannot send JSON
      if (res.headersSent || res.writableEnded) {
        res.end();
        return;
      }
      const mapped = buildErrorResponse(error, requestId);
      const mergedHeaders = { ...corsHeaders, ...mapped.headers };
      sendJsonWithHeaders(res, mapped.statusCode, mapped.body, mergedHeaders, isHead);
    }
  });

  // Track connections for graceful shutdown
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });

  // ─── WebSocket upgrade (RFC 6455) ───
  //
  // Performs the Sec-WebSocket-Accept handshake, then bridges text frames
  // to the WsGateway's handleClientFrame / shouldDeliverEvent protocol.

  const wsConnections = new Set<Socket>();

  /** RFC 6455 §4.2.2 — compute Sec-WebSocket-Accept from client key. */
  function computeWsAccept(key: string): string {
    return crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
  }

  /** Encode a string payload into a WebSocket text frame (opcode 0x1). */
  function encodeWsTextFrame(payload: string): Buffer {
    const data = Buffer.from(payload, "utf-8");
    const len = data.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81; // FIN + text opcode
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, data]);
  }

  /** Send a close frame (opcode 0x8) with a status code. */
  function sendWsClose(socket: Socket, code = 1000): void {
    const frame = Buffer.alloc(4);
    frame[0] = 0x88; // FIN + close opcode
    frame[1] = 2; // payload length = 2
    frame.writeUInt16BE(code, 2);
    socket.write(frame);
  }

  function handleRealtimeUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const wsKey = req.headers["sec-websocket-key"];
    if (
      !wsKey ||
      req.headers["upgrade"]?.toLowerCase() !== "websocket"
    ) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    // Reject cross-site WebSocket hijacking. A browser always sends `Origin`;
    // native / non-browser clients never do. When an Origin IS present it must
    // be trusted (allowlist / same-origin / loopback) — this holds even for the
    // DEFAULT empty allowlist, where the previous `corsOrigins.length > 0` guard
    // let ANY hostile cross-site page through. A missing Origin is a non-browser
    // client and is allowed, so the local UI and native app keep working.
    const origin = req.headers.origin;
    if (origin && !isTrustedWsOrigin(origin, req.headers.host, corsOrigins)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    // Complete the handshake
    const accept = computeWsAccept(wsKey);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        "\r\n",
    );

    wsConnections.add(socket);

    // Create a gateway-level connection
    const connId = crypto.randomUUID();
    const conn = deps.wsGateway.createConnection(connId);

    // ─── Per-connection frame rate limiter ───
    const WS_RATE_LIMIT_WINDOW_MS = 1_000;
    const WS_RATE_LIMIT_MAX_FRAMES = 100;
    let wsRateLimitWindowStart = Date.now();
    let wsRateLimitFrameCount = 0;

    function checkWsRateLimit(): boolean {
      const now = Date.now();
      if (now - wsRateLimitWindowStart > WS_RATE_LIMIT_WINDOW_MS) {
        wsRateLimitWindowStart = now;
        wsRateLimitFrameCount = 0;
      }
      wsRateLimitFrameCount++;
      return wsRateLimitFrameCount <= WS_RATE_LIMIT_MAX_FRAMES;
    }

    /** Send gateway server frames to the WS client. */
    function sendFrames(frames: FridayRealtimeServerFrame[]): void {
      for (const f of frames) {
        if (!socket.writable) break;
        const wireFrame = deps.wsGateway.encodeServerFrame?.(f) ?? f;
        socket.write(encodeWsTextFrame(JSON.stringify(wireFrame)));
      }
    }

    // Subscribe to event bus for push delivery
    let unsubscribe: (() => void) | undefined;
    if (deps.eventBus) {
      unsubscribe = deps.eventBus.subscribe((envelope) => {
        if (deps.wsGateway.shouldDeliverEvent(conn, envelope)) {
          const serverFrame: FridayRealtimeServerFrame = { type: "event", envelope };
          if (socket.writable) {
            const wireFrame = deps.wsGateway.encodeServerFrame?.(serverFrame) ?? serverFrame;
            socket.write(encodeWsTextFrame(JSON.stringify(wireFrame)));
          }
        }
      });
    }

    // Ping interval to keep the connection alive
    const pingInterval = setInterval(() => {
      if (socket.writable) {
        // WS ping frame (opcode 0x9)
        const ping = Buffer.alloc(2);
        ping[0] = 0x89; // FIN + ping
        ping[1] = 0;
        socket.write(ping);
      }
    }, 30_000);

    function cleanup(): void {
      clearInterval(pingInterval);
      unsubscribe?.();
      wsConnections.delete(socket);
    }

    // Inbound frame state: accumulated bytes + RFC 6455 §5.4 reassembly cursor.
    const frameState: WsFrameReaderState = {
      buffer: head.length > 0 ? Buffer.from(head) : Buffer.alloc(0),
      fragmentedOpcode: null,
      fragmentedChunks: [],
      fragmentedSize: 0,
    };
    const MAX_WS_FRAME_SIZE = 1_048_576; // 1 MB — single frame ceiling (§7.4.1 → 1009)
    const MAX_WS_MESSAGE_SIZE = 4_194_304; // 4 MB — assembled (multi-fragment) message ceiling
    const MAX_WS_BUFFER_SIZE = 4_194_304; // 4 MB — accumulated un-parsed buffer ceiling

    /**
     * Dispatch a complete TEXT message: rate-limit, strict-UTF-8 decode (§8.1),
     * then JSON-parse and forward to the gateway. Returns true when the
     * connection was torn down (the caller must then stop reading).
     */
    function handleCompletedTextMessage(payload: Buffer): boolean {
      // Rate limit: drop connection if client sends too many frames.
      if (!checkWsRateLimit()) {
        console.warn(`[friday][http-server] WebSocket rate limit exceeded for conn ${connId}`);
        const errFrame: FridayRealtimeServerFrame = {
          type: "error",
          code: "RATE_LIMITED",
          message: "Too many frames per second",
          retryable: true,
        };
        socket.write(encodeWsTextFrame(JSON.stringify(errFrame)));
        sendWsClose(socket, 1008); // Policy Violation
        cleanup();
        socket.destroy();
        return true;
      }

      // §8.1 text frames MUST be valid UTF-8. Reject (1007) before JSON.parse
      // rather than silently substituting U+FFFD.
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
      } catch {
        sendWsClose(socket, 1007); // Invalid frame payload data
        cleanup();
        socket.destroy();
        return true;
      }

      try {
        const clientFrame = JSON.parse(text) as FridayRealtimeClientFrame;
        const responses = deps.wsGateway.handleClientFrame(conn, clientFrame);
        sendFrames(responses);
      } catch (err) {
        console.warn("[friday][http-server] operation failed:", err instanceof Error ? err.message : String(err));
        // Malformed JSON — send error frame (connection stays open, prior behavior).
        const errFrame: FridayRealtimeServerFrame = {
          type: "error",
          code: "INVALID_FRAME",
          message: "Failed to parse client frame as JSON",
          retryable: false,
        };
        socket.write(encodeWsTextFrame(JSON.stringify(errFrame)));
      }
      return false;
    }

    socket.on("data", (chunk: Buffer) => {
      frameState.buffer = Buffer.concat([frameState.buffer, chunk]);

      // Guard against accumulated buffer exceeding max size (prevents DoS via fragmented frames)
      if (frameState.buffer.length > MAX_WS_BUFFER_SIZE) {
        socket.destroy();
        return;
      }

      for (const ev of readWsClientFrames(frameState, MAX_WS_FRAME_SIZE, MAX_WS_MESSAGE_SIZE)) {
        if (ev.type === "drop") {
          // Oversized frame — silent teardown (matches prior behavior).
          socket.destroy();
          return;
        }
        if (ev.type === "protocol-error") {
          sendWsClose(socket, ev.code); // RFC 6455 §7.1.7
          cleanup();
          socket.destroy();
          return;
        }
        if (ev.type === "close") {
          sendWsClose(socket, 1000);
          cleanup();
          socket.destroy();
          return;
        }
        if (ev.type === "ping") {
          // Ping → respond with pong echoing the (≤125B, validated) payload.
          const pong = Buffer.alloc(2 + ev.payload.length);
          pong[0] = 0x8a; // FIN + pong
          pong[1] = ev.payload.length; // ≤125 by the control-frame cap
          ev.payload.copy(pong, 2);
          socket.write(pong);
          continue;
        }
        if (ev.type === "pong") {
          continue; // no action needed
        }
        // ev.type === "message": a complete data message.
        if (ev.opcode === 0x1 && handleCompletedTextMessage(ev.payload)) return;
        // Binary messages (opcode 0x2) are not part of the realtime protocol;
        // they are ignored, preserving the prior silent-drop behavior.
      }
    });

    socket.on("close", () => { cleanup(); });
    socket.on("error", () => { cleanup(); socket.destroy(); });
  }

  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = parsedUrl.pathname;

    // Route to webchat WS service first when configured and path matches.
    if (
      deps.webchatWsService &&
      deps.webchatWsService.matchesPath(pathname)
    ) {
      const handled = deps.webchatWsService.handleUpgrade(req, socket, head);
      if (handled) {
        return;
      }
    }

    // Realtime WS gateway supports the canonical path and the retired SSD alias.
    if (pathname === "/v1/realtime/ws" || pathname === "/v1/ws") {
      handleRealtimeUpgrade(req, socket, head);
      return;
    }

    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });

  return {
    port,

    listen(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        server.on("error", reject);
        server.listen(port, host ?? "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    },

    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
        // Destroy all existing keep-alive connections so close() can complete
        for (const socket of connections) {
          socket.destroy();
        }
        // Run optional cleanup (e.g. clear rate-limiter pruning timer)
        deps.onClose?.();
      });
    },
  };
}

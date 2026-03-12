/**
 * Phase 3 Batch 2 — HTTP server wrapping the route registry.
 *
 * Creates a Node.js `http.createServer` that dispatches incoming
 * requests to the matching route handler from the registry.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { createReadStream } from "node:fs";
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
  /** Optional Webchat WS service for /ws/chat style upgrades. */
  webchatWsService?: WebchatWsService;
}

export interface FridayHttpServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  readonly port: number;
}

// ─── Helpers ───

const FRIDAY_METHODS_WITH_BODY: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH"]);
const FRIDAY_HTTP_MAX_BODY_BYTES = 1_048_576; // 1MB

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

function extractParams(pattern: string, actual: string): Record<string, string> {
  const patternParts = pattern.split("/");
  const actualParts = actual.split("/");
  const params: Record<string, string> = {};

  for (let i = 0; i < patternParts.length; i++) {
    const segment = patternParts[i]!;
    if (segment.startsWith(":")) {
      try {
        params[segment.slice(1)] = decodeURIComponent(actualParts[i]!);
      } catch {
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
    } catch {
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
  } catch {
    // index.html doesn't exist
  }

  return false;
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-Id",
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
  const hasObservabilityRoutes = routes
    .getRoutes()
    .some((route) => route.path.startsWith("/v1/observability"));

  // Track active connections so close() can destroy keep-alive sockets
  const connections = new Set<Socket>();

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = crypto.randomUUID();
    const receivedAt = new Date().toISOString();
    const startNs = process.hrtime.bigint();

    // Request logging on response finish
    if (logRequests) {
      res.on("finish", () => {
        const elapsedNs = process.hrtime.bigint() - startNs;
        const elapsedMs = Number(elapsedNs / 1_000_000n);
        const method = req.method ?? "GET";
        const url = req.url ?? "/";
        logger(`[FRIDAY] ${method} ${url} ${res.statusCode} ${elapsedMs}ms`);
      });
    }

    // CORS: get origin header
    const origin = req.headers.origin ?? "";
    const corsHeaders = origin ? buildCorsHeaders(origin, corsOrigins) : {};

    const rawMethod = (req.method ?? "GET").toUpperCase();
    const isHead = rawMethod === "HEAD";

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
        const isObservabilityPath = pathname.startsWith("/v1/observability");
        const notFoundMessage = isObservabilityPath && !hasObservabilityRoutes
          ? "Observability API is not enabled on this Friday instance."
          : `No route matches ${method} ${pathname}`;
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
          try {
            body = JSON.parse(raw);
          } catch {
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

      // Build context
      const ctx: FridayHttpContext<unknown, unknown, unknown> = {
        requestId,
        receivedAt,
        ip: req.socket.remoteAddress,
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

      // Inject raw response reference for SSE streaming routes
      (ctx as FridayHttpContext<unknown, unknown, unknown> & { _raw?: ServerResponse })._raw = res;

      // Call handler
      const result = await route.handler(ctx);

      // If the handler already took over the response (e.g. SSE streaming), bail out
      if (res.headersSent || res.writableEnded) return;

      if (isFridayHttpRawTextResponse(result)) {
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
      .update(key + "258EAFA5-E914-47DA-95CA-5ABB0DC85B12")
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

    /** Send gateway server frames to the WS client. */
    function sendFrames(frames: FridayRealtimeServerFrame[]): void {
      for (const f of frames) {
        if (!socket.writable) break;
        socket.write(encodeWsTextFrame(JSON.stringify(f)));
      }
    }

    // Subscribe to event bus for push delivery
    let unsubscribe: (() => void) | undefined;
    if (deps.eventBus) {
      unsubscribe = deps.eventBus.subscribe((envelope) => {
        if (deps.wsGateway.shouldDeliverEvent(conn, envelope)) {
          const serverFrame: FridayRealtimeServerFrame = { type: "event", envelope };
          if (socket.writable) {
            socket.write(encodeWsTextFrame(JSON.stringify(serverFrame)));
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

    // Process any data that arrived during the upgrade (head buffer)
    let buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Parse WebSocket frames
      while (buffer.length >= 2) {
        const firstByte = buffer[0]!;
        const secondByte = buffer[1]!;
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

        const maskSize = masked ? 4 : 0;
        const totalLen = offset + maskSize + payloadLen;
        if (buffer.length < totalLen) return; // wait for more data

        const maskKey = masked ? buffer.subarray(offset, offset + 4) : undefined;
        const payloadData = buffer.subarray(offset + maskSize, totalLen);

        // Unmask if masked (client→server frames are always masked per RFC 6455)
        if (maskKey) {
          for (let i = 0; i < payloadData.length; i++) {
            payloadData[i] = payloadData[i]! ^ maskKey[i % 4]!;
          }
        }

        // Consume the frame from the buffer
        buffer = buffer.subarray(totalLen);

        // Handle by opcode
        if (opcode === 0x1) {
          // Text frame → parse as client frame and forward to gateway
          try {
            const clientFrame = JSON.parse(payloadData.toString("utf-8")) as FridayRealtimeClientFrame;
            const responses = deps.wsGateway.handleClientFrame(conn, clientFrame);
            sendFrames(responses);
          } catch {
            // Malformed JSON — send error frame
            const errFrame: FridayRealtimeServerFrame = {
              type: "error",
              code: "INVALID_FRAME",
              message: "Failed to parse client frame as JSON",
              retryable: false,
            };
            socket.write(encodeWsTextFrame(JSON.stringify(errFrame)));
          }
        } else if (opcode === 0x8) {
          // Close frame
          sendWsClose(socket, 1000);
          cleanup();
          socket.destroy();
          return;
        } else if (opcode === 0x9) {
          // Ping → respond with pong
          const pong = Buffer.alloc(2 + payloadData.length);
          pong[0] = 0x8a; // FIN + pong
          pong[1] = payloadData.length;
          payloadData.copy(pong, 2);
          socket.write(pong);
        } else if (opcode === 0xa) {
          // Pong — no action needed
        }
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
      });
    },
  };
}

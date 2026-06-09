import { createHash, randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

import * as wsModule from "ws";

import { FridayDomainError } from "#errors";

import {
  agree,
  buildAuthProof,
  decodeSealed,
  deviceKeypairFromSecret,
  encodeSealed,
  hexDecode,
  open,
  seal,
  sha256Hex,
  X25519_PUBKEY_LEN,
} from "./friday-rust-hub-agent-run-ws-sealed-crypto.js";

/**
 * PROOF-ONLY (Rust-wired), DARK (no production route consumes this) TS->Rust AGENT-RUN
 * SEALED WS CLIENT for the executeRun-replacement (sub-slice B1) — the REAL sealed-protocol
 * client half.
 *
 * ## What this is (and how it differs from the S-D stub)
 * The S-D client (`friday-rust-hub-agent-run-ws-client.ts`) is a DARK STUB: it opens a plain
 * `new WebSocket(url)` and sends the INNER message JSON UNSEALED. It does NOT speak the
 * server's protocol. THIS client speaks the server's REAL sealed ECDH protocol
 * (`hub_agent_run_server.rs` + `friday-crypto` + `friday-transport`):
 *   1. `net.connect` → a RAW TCP socket (NOT `new WebSocket(url)`, whose HTTP upgrade fires
 *      immediately and would corrupt the raw preamble).
 *   2. RAW length-prefixed preamble frames BEFORE the WS upgrade:
 *        write client X25519 pubkey (32B) → read server pubkey (32B) → read session_nonce (64B).
 *   3. A MANUAL RFC6455 client upgrade over the SAME socket, then `ws`'s `Sender`/`Receiver`
 *      drive masked WebSocket frames (tungstenite rejects UNMASKED client frames).
 *   4. `session_key = HKDF(X25519(client_priv, server_pub))`.
 *   5. Send an `AgentRunRequest` Envelope sealed under the session key (XChaCha20-Poly1305),
 *      with a per-request `auth_proof` sealed over `AUTH_CHALLENGE || session_nonce`.
 *   6. Read TWO inbound sealed envelopes: the refs-only `AgentRunResult` FIRST, then (only if
 *      a body was delivered) a SECOND `AskFridayStream{seq:0, chunk:hex}` carrying the
 *      DOUBLY-sealed body. A denied/no-answer outcome sends NO body envelope.
 *
 * ## Threat model (HONEST — loopback only)
 * The server binds 127.0.0.1 only; this client connects only to loopback. The client
 * INTENTIONALLY does NOT authenticate the server (NO server-pubkey pinning) — acceptable on
 * loopback because there is no relay to substitute keys. The load-bearing properties are
 * SERVER-side and are NOT confidentiality: (1) peer-pubkey allowlist (SecureStore), (2)
 * owner-allowlist, (3) per-handshake nonce anti-replay. This client is the client half of
 * that handshake; it does not defend confidentiality against a non-existent relay.
 *
 * ## Fail-closed contract (the load-bearing invariant)
 * Any non-clean settle — connect error, socket close before a result, bounded timeout, a
 * preamble of the wrong width, an envelope that fails to open/parse, a missing required ref —
 * throws the SAME 503-shaped {@link FridayDomainError}. A non-allowlisted / forged client
 * pubkey (the server establishes NO session and sends NOTHING) and a non-allowlisted forwarded
 * principal (the server ends the session with no result) BOTH surface as this fail-closed
 * error — never a hang, never a partial success, never a surfaced body on an error.
 *
 * ## Truth labels
 * - DARK substrate for the executeRun-replacement: no production route consumes it.
 * - `rust_wired` ceiling: confers NO v1 GO. Reversible / inert until the composition slice
 *   live-flips it (operator gate).
 */

/**
 * S-C session AAD — `SESSION_AAD` in `hub_agent_run_server.rs`. Every envelope on the session
 * is sealed under this AAD. Byte-identical to the Rust constant (asserted in the KATs).
 */
const SESSION_AAD = Buffer.from("friday:execrun:ws:s-c:agent-run-session:aad:v1", "utf8");
/**
 * S-C auth challenge — `AUTH_CHALLENGE` in `hub_agent_run_server.rs`. The peer seals
 * `AUTH_CHALLENGE || session_nonce` as its possession-of-session proof.
 */
const AUTH_CHALLENGE = Buffer.from("friday:execrun:ws:s-c:authed-run:challenge:v1", "utf8");

/** Protocol schema version — `CURRENT_SCHEMA_VERSION` in friday-protocol (must be 12). */
const SCHEMA_VERSION = 12;
/** The expected width of the server's per-handshake session nonce (used VERBATIM). */
const SESSION_NONCE_LEN = 64;
/** Max length-prefixed preamble frame (defensive; mirrors transport `MAX_FRAME`). */
const MAX_FRAME = 1 << 20;
/** The RFC6455 GUID used to compute `Sec-WebSocket-Accept`. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const DEFAULT_TIMEOUT_MS = 30_000;

// `@types/ws` types only the default `WebSocket` export (`export = WebSocket`); it does NOT type
// the low-level `Sender`/`Receiver` classes (which `ws` DOES export at runtime). We need those for
// socket adoption AFTER the raw preamble (a plain `new WebSocket(url)` would fire its HTTP upgrade
// immediately and corrupt the preamble). Pull them off the module at runtime with a precise, minimal
// local typing of exactly the surface we use.
interface WsSender {
  send(data: Buffer, options: { binary: boolean; mask: boolean; fin: boolean }): void;
}
interface WsReceiver {
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: "conclude" | "error", listener: (...args: unknown[]) => void): void;
  write(chunk: Buffer): void;
  removeAllListeners(): void;
}
interface WsRuntime {
  Sender: new (socket: Socket, extensions: undefined, generateMask: () => Buffer) => WsSender;
  Receiver: new (options: { isServer: boolean; binaryType: string; skipUTF8Validation: boolean }) => WsReceiver;
}
// `@types/ws` declares `export = WebSocket` and types the namespace's extra exports loosely; the
// `Sender`/`Receiver` runtime classes are reached off the module namespace via this minimal cast.
// A namespace import bundles correctly in BOTH esm and cjs (unlike `createRequire(import.meta.url)`,
// which esbuild stubs to `undefined` in a cjs bundle).
const wsRuntime = wsModule as unknown as WsRuntime;

/** A dispatched agent-run, TS-side (camelCase; mapped to the snake_case wire fields). */
export interface FridayRustHubAgentRunSealedRequest {
  /** Caller-chosen idempotency/run identifier. */
  readonly runId: string;
  /** The agent task/prompt to run on the Rust loop. */
  readonly task: string;
  /** The TS-token-resolved principal the trusted peer forwards (allowlist-checked by the server). */
  readonly forwardedPrincipal: string;
}

/**
 * The result of a sealed dispatch: the REFS-ONLY receipt PLUS the opened owner-sealed body,
 * when the run delivered one. The body is surfaced ONLY to the authed in-process caller (it
 * arrived doubly-sealed over the owner-only channel); it is NEVER on the refs receipt itself.
 */
export interface FridayRustHubAgentRunSealedResult {
  readonly truthLabel: "rust_wired";
  /** The run this result terminates (echoes the request run id). */
  readonly runId: string;
  /** Coarse loop-status label (e.g. `delivered_to_authenticated_owner` / denied / no_answer). */
  readonly status: string;
  /** sha256 of the answer body — a REF — when an answer exists. */
  readonly answerSha256?: string;
  /** Byte length of the answer body — a measure — when an answer exists. */
  readonly answerLen?: number;
  /**
   * The OPENED answer body, when the run delivered one to this owner. Absent on a denied /
   * no-answer outcome. NOT a refs field — it arrived doubly-sealed over the owner channel.
   */
  readonly body?: string;
}

export interface CreateFridayRustHubAgentRunSealedClientOptions {
  /** Loopback host for the Rust agent-run WS server. Defaults to `127.0.0.1`. */
  readonly host?: string;
  /** Port the Rust agent-run WS server listens on. */
  readonly port: number;
  /**
   * The client's 32-byte X25519 SECRET scalar. The matching pubkey MUST be enrolled in the
   * server's SecureStore peer-allowlist or the server establishes NO session (fail-closed).
   * Held in-process only; never logged.
   */
  readonly clientSecret: Uint8Array;
  /** Bounded await (ms) for the dispatch to settle before failing closed. */
  readonly timeoutMs?: number;
}

export interface FridayRustHubAgentRunSealedClient {
  /**
   * Dispatch one agent-run over a sealed session and await its result. Connects, runs the
   * preamble + WS upgrade, seals the request, reads the refs result + optional owner-sealed
   * body, then closes. Fails closed (503) on any non-clean settle.
   */
  dispatchRun(
    request: FridayRustHubAgentRunSealedRequest,
  ): Promise<FridayRustHubAgentRunSealedResult>;
}

function unavailable(message: string): FridayDomainError {
  return new FridayDomainError("MISSION_SPINE_RUST_AGENT_RUN_SEALED_WS_CLIENT_UNAVAILABLE", message, {
    httpStatus: 503,
    details: {
      surface: "service:rust_hub_agent_run_sealed_ws_client",
      bridge: "rust_wired",
      proofOnly: true,
      proofReady: false,
    },
  });
}

/** Read exactly `n` bytes from a buffered socket reader, or fail closed on EOF/timeout. */
type FrameReader = {
  readFrame(): Promise<Uint8Array>;
  /** Hand the remaining buffered bytes + the socket to the WS layer after the preamble. */
  takeover(): { socket: Socket; leftover: Buffer };
};

/**
 * A minimal buffered reader over the raw socket for the cleartext length-prefixed preamble
 * (`[u32 big-endian length][payload]`). Buffers inbound data; resolves one frame at a time.
 * After the preamble, `takeover()` returns the socket plus any already-buffered bytes (there
 * should be none before the WS upgrade, but we hand them on defensively).
 */
function createPreambleReader(socket: Socket): FrameReader {
  // Typed as the wide `Buffer` (= `Buffer<ArrayBufferLike>`) so inbound socket chunks (also wide)
  // can be assigned directly without an ArrayBuffer-vs-ArrayBufferLike mismatch.
  let buffer: Buffer = Buffer.alloc(0);
  let pending: { need: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  let fatal: Error | null = null;

  function settlePending(): void {
    if (!pending) return;
    if (fatal) {
      const p = pending;
      pending = null;
      p.reject(fatal);
      return;
    }
    if (buffer.length >= pending.need) {
      const p = pending;
      const out = buffer.subarray(0, p.need);
      buffer = buffer.subarray(p.need);
      pending = null;
      p.resolve(out);
    }
  }

  function onData(chunk: Buffer): void {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    settlePending();
  }
  function onError(err: Error): void {
    fatal = err;
    settlePending();
  }
  function onClose(): void {
    fatal = fatal ?? new Error("socket closed during preamble");
    settlePending();
  }

  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);

  function readExact(n: number): Promise<Buffer> {
    if (fatal) return Promise.reject(fatal);
    return new Promise<Buffer>((resolve, reject) => {
      pending = { need: n, resolve, reject };
      settlePending();
    });
  }

  return {
    async readFrame(): Promise<Uint8Array> {
      const header = await readExact(4);
      const len = header.readUInt32BE(0);
      if (len > MAX_FRAME) {
        throw new Error(`preamble frame too large: ${len}`);
      }
      const payload = await readExact(len);
      return new Uint8Array(payload);
    },
    takeover(): { socket: Socket; leftover: Buffer } {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      const leftover = buffer;
      buffer = Buffer.alloc(0);
      return { socket, leftover };
    },
  };
}

/** Build a length-prefixed preamble frame `[u32be len][payload]`. */
function frameBytes(payload: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(4 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  Buffer.from(payload).copy(out, 4);
  return out;
}

/**
 * Perform the manual RFC6455 client upgrade over the (preamble-consumed) raw socket: send the
 * GET/Upgrade request, await the `101 Switching Protocols` response, and validate
 * `Sec-WebSocket-Accept`. Resolves once the response headers are fully read; any leftover bytes
 * after the header terminator are post-upgrade WS frame data and are returned for the Receiver.
 */
function wsClientUpgrade(socket: Socket, host: string, port: number): Promise<Buffer> {
  const key = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1").update(key + WS_GUID).digest("base64");
  const request =
    `GET / HTTP/1.1\r\n` +
    `Host: ${host}:${port}\r\n` +
    `Upgrade: websocket\r\n` +
    `Connection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\n` +
    `Sec-WebSocket-Version: 13\r\n` +
    `\r\n`;

  return new Promise<Buffer>((resolve, reject) => {
    let buf: Buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const head = buf.subarray(0, sep).toString("utf8");
      const leftover = buf.subarray(sep + 4);
      cleanup();
      const statusLine = head.split("\r\n")[0] ?? "";
      if (!/HTTP\/1\.1\s+101/i.test(statusLine)) {
        reject(new Error(`ws upgrade rejected: ${statusLine}`));
        return;
      }
      const acceptMatch = head.match(/sec-websocket-accept:\s*(.+)\r?/i);
      if (!acceptMatch || acceptMatch[1].trim() !== expectedAccept) {
        reject(new Error("ws upgrade: bad Sec-WebSocket-Accept"));
        return;
      }
      resolve(leftover);
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("socket closed during ws upgrade"));
    };
    function cleanup(): void {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    }
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.write(request);
  });
}

/** A decoded inbound envelope: the inner message kind plus the fields we read. */
interface InboundEnvelope {
  readonly kind: string;
  readonly fields: Record<string, unknown>;
}

/** Seal + frame an Envelope as a masked WS Binary message and send it. */
function sealAndSend(sender: WsSender, sessionKey: Uint8Array, envelope: unknown): void {
  const json = Buffer.from(JSON.stringify(envelope), "utf8");
  const wire = encodeSealed(seal(sessionKey, json, SESSION_AAD));
  // CLIENT frames MUST be masked (tungstenite rejects unmasked client frames). The Sender was
  // constructed with a mask generator, so mask:true uses it.
  sender.send(Buffer.from(wire), { binary: true, mask: true, fin: true });
}

/** Open + decode one inbound sealed WS Binary payload into its inner message. */
function openInbound(sessionKey: Uint8Array, payload: Buffer): InboundEnvelope {
  const sealed = decodeSealed(new Uint8Array(payload));
  const ptBytes = open(sessionKey, sealed, SESSION_AAD);
  const env = JSON.parse(Buffer.from(ptBytes).toString("utf8")) as Record<string, unknown>;
  const message = env.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("inbound envelope has no message object");
  }
  const fields = message as Record<string, unknown>;
  const kind = typeof fields.kind === "string" ? fields.kind : "";
  return { kind, fields };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The refs accumulated from the FIRST inbound envelope (the refs-only `AgentRunResult`). */
interface ResultRefs {
  runId: string;
  status: string;
  answerSha256?: string;
  answerLen?: number;
}

/**
 * The two-envelope read state + settlement callbacks, shared between the inbound-message handler
 * and the server-close handler. Extracted to a module-level factory so the dispatch closure stays
 * small and the read-loop logic is testable in isolation.
 */
interface InboundContext {
  /** Set once the handshake derives the session key (mutated in the async setup). */
  sessionKey: Uint8Array;
  /** Mutable refs slot — set by the result handler, read by the close handler. */
  refs: ResultRefs | null;
  succeed(result: FridayRustHubAgentRunSealedResult): void;
  fail(error: FridayDomainError): void;
}

/** Settle from the accumulated refs + the (optional) opened body. */
function finishWithBody(ctx: InboundContext, body: string | undefined): void {
  const { refs } = ctx;
  if (!refs) {
    ctx.fail(unavailable("Sealed agent-run client never received a result ref."));
    return;
  }
  ctx.succeed({
    truthLabel: "rust_wired",
    runId: refs.runId,
    status: refs.status,
    ...(refs.answerSha256 !== undefined ? { answerSha256: refs.answerSha256 } : {}),
    ...(refs.answerLen !== undefined ? { answerLen: refs.answerLen } : {}),
    ...(body !== undefined ? { body } : {}),
  });
}

/** Handle the refs-only `AgentRunResult` envelope (the FIRST inbound). */
function handleResult(ctx: InboundContext, fields: Record<string, unknown>): void {
  const runId = asString(fields.run_id);
  const status = asString(fields.status);
  if (!runId || !status) {
    ctx.fail(unavailable("Sealed agent-run client result is missing a required ref."));
    return;
  }
  const answerSha256 = asString(fields.answer_sha256);
  const answerLen = asNumber(fields.answer_len);
  ctx.refs = {
    runId,
    status,
    ...(answerSha256 !== undefined ? { answerSha256 } : {}),
    ...(answerLen !== undefined ? { answerLen } : {}),
  };
  // No fingerprint ⇒ no answer ⇒ no body envelope follows; settle now. Otherwise wait (bounded)
  // for the SECOND (body) envelope.
  if (answerSha256 === undefined && answerLen === undefined) {
    finishWithBody(ctx, undefined);
  }
}

/** Handle the owner-sealed body envelope (`AskFridayStream`, the optional SECOND inbound). */
function handleBody(ctx: InboundContext, fields: Record<string, unknown>): void {
  // chunk = hex(encode_sealed(seal(session_key, body, SESSION_AAD))). DOUBLY sealed: the
  // transport already opened the OUTER seal; the chunk hex-decodes to a SECOND sealed blob we
  // open again under the session key.
  const chunk = asString(fields.chunk);
  if (chunk === undefined) {
    ctx.fail(unavailable("Sealed agent-run client body chunk missing."));
    return;
  }
  let body: string;
  try {
    const innerSealed = decodeSealed(hexDecode(chunk));
    body = Buffer.from(open(ctx.sessionKey, innerSealed, SESSION_AAD)).toString("utf8");
  } catch {
    ctx.fail(unavailable("Sealed agent-run client could not open the owner-sealed body."));
    return;
  }
  // Defensive: a DELIVERED body MUST carry a refs fingerprint, and that fingerprint MUST match the
  // opened body — on BOTH sha256 AND byte length. The server always emits sha256+len together with a
  // body; a body with no sha256 ref, a sha256 mismatch, or a len mismatch is fail-closed (never
  // surfaced unverified). This holds the integrity check independent of the loopback trust model.
  if (ctx.refs?.answerSha256 === undefined) {
    ctx.fail(unavailable("Sealed agent-run client received a body with no fingerprint ref."));
    return;
  }
  if (ctx.refs.answerSha256 !== sha256Hex(Buffer.from(body, "utf8"))) {
    ctx.fail(unavailable("Sealed agent-run client body fingerprint mismatch."));
    return;
  }
  if (ctx.refs.answerLen !== undefined && ctx.refs.answerLen !== Buffer.byteLength(body, "utf8")) {
    ctx.fail(unavailable("Sealed agent-run client body length mismatch."));
    return;
  }
  finishWithBody(ctx, body);
}

/** Dispatch one opened inbound envelope to its handler (result / body / unknown ⇒ fail-closed). */
function handleInbound(ctx: InboundContext, payload: Buffer): void {
  let inbound: InboundEnvelope;
  try {
    inbound = openInbound(ctx.sessionKey, payload);
  } catch {
    ctx.fail(unavailable("Sealed agent-run client could not open an inbound envelope."));
    return;
  }
  if (inbound.kind === "AgentRunResult") {
    handleResult(ctx, inbound.fields);
    return;
  }
  if (inbound.kind === "AskFridayStream") {
    handleBody(ctx, inbound.fields);
    return;
  }
  ctx.fail(unavailable("Sealed agent-run client received an unknown message shape."));
}

/**
 * Handle the server ending the session. A close BEFORE any refs is the FAIL-CLOSED path (forged
 * peer / bad principal — the server established no session or ran nothing). With refs present, a
 * missing body is fail-closed only when the refs indicated an answer exists.
 */
function handleServerClose(ctx: InboundContext): void {
  if (!ctx.refs) {
    ctx.fail(unavailable("Sealed agent-run client connection closed before a result."));
    return;
  }
  if (ctx.refs.answerSha256 !== undefined || ctx.refs.answerLen !== undefined) {
    ctx.fail(unavailable("Sealed agent-run client connection closed before the body."));
    return;
  }
  finishWithBody(ctx, undefined);
}

export function createFridayRustHubAgentRunSealedClient(
  options: CreateFridayRustHubAgentRunSealedClientOptions,
): FridayRustHubAgentRunSealedClient {
  const host = options.host ?? "127.0.0.1";
  const { port } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (options.clientSecret.length !== X25519_PUBKEY_LEN) {
    throw new RangeError(`clientSecret must be ${X25519_PUBKEY_LEN} bytes`);
  }
  const keypair = deviceKeypairFromSecret(options.clientSecret);

  return {
    dispatchRun(
      request: FridayRustHubAgentRunSealedRequest,
    ): Promise<FridayRustHubAgentRunSealedResult> {
      if (!request.runId) {
        return Promise.reject(unavailable("Sealed agent-run client requires a run id."));
      }

      return new Promise<FridayRustHubAgentRunSealedResult>((resolve, reject) => {
        let settled = false;
        let socket: Socket | null = null;
        let receiver: WsReceiver | null = null;

        const timer = setTimeout(() => {
          fail(unavailable("Sealed agent-run client timed out awaiting a result."));
        }, timeoutMs);
        if (typeof timer.unref === "function") timer.unref();

        function teardown(): void {
          clearTimeout(timer);
          if (receiver) {
            receiver.removeAllListeners();
          }
          if (socket) {
            socket.removeAllListeners();
            // Drop a late inbound frame onto a no-op so the destroyed socket cannot throw.
            socket.on("error", () => {});
            try {
              socket.destroy();
            } catch {
              // best-effort; the result is already decided.
            }
          }
        }
        function succeed(result: FridayRustHubAgentRunSealedResult): void {
          if (settled) return;
          settled = true;
          teardown();
          resolve(result);
        }
        function fail(error: FridayDomainError): void {
          if (settled) return;
          settled = true;
          teardown();
          reject(error);
        }

        // The accumulated read state across the two inbound envelopes (refs first, body optional),
        // bundled with the settlement callbacks so the module-level handlers can drive it.
        const ctx: InboundContext = { sessionKey: new Uint8Array(0), refs: null, succeed, fail };

        void (async () => {
          // (1) RAW TCP connect (NOT new WebSocket(url) — its HTTP upgrade would corrupt the
          // raw preamble). connect first, then run the preamble on the raw socket.
          let connected: Socket;
          try {
            connected = await new Promise<Socket>((res, rej) => {
              const s = connect({ host, port }, () => res(s));
              // Capture the connecting socket into the outer slot SYNCHRONOUSLY, so a timeout that
              // fires DURING a slow connect still has teardown destroy it (no leaked half-open socket).
              socket = s;
              s.once("error", rej);
            });
          } catch {
            fail(unavailable("Sealed agent-run client could not open a connection."));
            return;
          }
          socket = connected;
          socket.setNoDelay(true);

          const reader = createPreambleReader(socket);
          try {
            // (2) preamble: write client pubkey → read server pubkey (32B) → read nonce (64B).
            socket.write(frameBytes(keypair.publicKey));
            const serverPub = await reader.readFrame();
            if (serverPub.length !== X25519_PUBKEY_LEN) {
              throw new Error("server pubkey wrong width");
            }
            const sessionNonce = await reader.readFrame();
            if (sessionNonce.length !== SESSION_NONCE_LEN) {
              throw new Error("session nonce wrong width");
            }

            // (3) derive the session key (X25519 + HKDF) over the agreed peer pubkey.
            const sessionKey = agree(keypair.secret, serverPub);
            ctx.sessionKey = sessionKey;

            // (4) hand off to the WS layer over the SAME socket: manual RFC6455 upgrade, then
            // Sender/Receiver. The preamble reader detaches its listeners on takeover().
            const { socket: sock, leftover: preambleLeftover } = reader.takeover();
            // INVARIANT: tungstenite cannot send the 101 before it receives our GET (written inside
            // wsClientUpgrade, AFTER takeover), so the preamble reader cannot have buffered any
            // upgrade-response bytes. If it somehow did (a pipelining non-loopback server), the fresh
            // upgrade read would silently lose them — so fail CLOSED here instead of dropping them.
            if (preambleLeftover.length > 0) {
              throw new Error("unexpected buffered bytes before ws upgrade");
            }
            const leftover = await wsClientUpgrade(sock, host, port);

            const sender = new wsRuntime.Sender(sock, undefined, () => randomBytes(4));
            const recv = new wsRuntime.Receiver({ isServer: false, binaryType: "nodebuffer", skipUTF8Validation: true });
            receiver = recv;

            recv.on("message", (data: Buffer, isBinary: boolean) => {
              if (!isBinary) {
                fail(unavailable("Sealed agent-run client received a non-binary frame."));
                return;
              }
              handleInbound(ctx, data);
            });
            // The server closed the session. Before any refs ⇒ fail-closed (forged peer / bad
            // principal); after refs ⇒ settle (or fail if a promised body never arrived).
            recv.on("conclude", () => handleServerClose(ctx));
            recv.on("error", () => {
              fail(unavailable("Sealed agent-run client received a malformed WS frame."));
            });

            sock.on("data", (chunk: Buffer) => recv.write(chunk));
            sock.on("error", () => {
              fail(unavailable("Sealed agent-run client connection error."));
            });
            sock.on("close", () => handleServerClose(ctx));
            // Feed any bytes that arrived bundled with the upgrade response.
            if (leftover.length > 0) {
              recv.write(leftover);
            }

            // (5) seal + send the AgentRunRequest envelope.
            const authProof = buildAuthProof({
              sessionKey,
              sessionNonce,
              sessionAad: SESSION_AAD,
              authChallenge: AUTH_CHALLENGE,
              forwardedPrincipal: request.forwardedPrincipal,
              runId: request.runId,
            });
            const envelope = {
              schema_version: SCHEMA_VERSION,
              msg_id: `agent-run-${request.runId}`,
              correlation_id: `agent-run-${request.runId}`,
              sent_at: Date.now(),
              message: {
                kind: "AgentRunRequest",
                run_id: request.runId,
                task: request.task,
                forwarded_principal: request.forwardedPrincipal,
                // serde `Vec<u8>` serializes as a JSON ARRAY of byte numbers (NOT base64/hex).
                auth_proof: Array.from(authProof),
              },
            };
            sealAndSend(sender, sessionKey, envelope);
          } catch {
            fail(unavailable("Sealed agent-run client handshake failed."));
          }
        })();
      });
    },
  };
}

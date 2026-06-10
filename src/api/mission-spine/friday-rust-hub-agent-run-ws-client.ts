import WebSocket from "ws";

import { FridayDomainError } from "#errors";

/**
 * PROOF-ONLY (Rust-wired), DARK (no production route consumes this) TS->Rust
 * AGENT-RUN WS CLIENT for the executeRun-replacement (WS-transport substrate,
 * sub-slice S-D).
 *
 * ## Why this exists
 * Today every production agent-run is driven by a per-run `execFile` of a Rust bin
 * (see `friday-rust-hub-run-task-bridge-service` — the thing being replaced). The
 * target topology is a SINGLE long-lived Rust agent-run WS SERVER (sub-slice S-B):
 * the TS API holds ONE persistent WebSocket and dispatches each agent-run as a
 * message over it, instead of spawning a process per run. This file is the TS-side
 * CLIENT of that server.
 *
 * It mirrors the per-run bridge's discipline — a service factory, a REFS-ONLY parse,
 * and FAIL-CLOSED (503) error handling — but over a socket instead of a child
 * process.
 *
 * ## Truth labels (read before trusting this)
 * - **DARK — and SUPERSEDED.** This S-D plain/unsealed stub is consumed by NO production
 *   route and by no barrel/index/bootstrap; its ONLY importer is its own unit test. B1-compose
 *   did NOT wire this stub — it wired the REAL sealed client
 *   (`friday-rust-hub-agent-run-ws-sealed-client.ts`, via the sealed-client service adapter)
 *   into `composeRustReadOnlyAgentRun` instead, bypassing this file. So this stub stays dark /
 *   reversible / inert; it was kept as the S-A wire-contract reference, not on any live path.
 * - **`rust_wired` ceiling**: this speaks the S-A wire contract to a (later) Rust
 *   server; it is NOT a product path and confers NO v1 GO. In tests it is driven by a
 *   hermetic in-process loopback stub server — never a real Rust bin, never a
 *   provider, never network egress beyond loopback.
 *
 * ## Wire contract (S-A) — what crosses the socket
 * The wire messages are S-A's `Message::AgentRunRequest` / `Message::AgentRunResult`
 * (rust-core/crates/friday-protocol/src/lib.rs). They are tagged JSON objects with a
 * `kind` discriminator.
 *
 *   - Request  (TS -> server): `{ kind: "AgentRunRequest", run_id, task,
 *     forwarded_principal, auth_proof }`. `forwarded_principal` / `auth_proof` are
 *     SHAPE-ONLY on the wire and are VERIFIED by a later sub-slice (S-C) against the
 *     sealed session; this client never asserts they are trusted.
 *   - Result   (server -> TS): `{ kind: "AgentRunResult", run_id, status,
 *     answer_sha256?, answer_len? }`. **REFS-ONLY**: it carries the answer
 *     FINGERPRINT (sha256 + byte length) when an answer exists, and **NEVER** the
 *     answer body / `final_message`. The body is delivered SEALED over the session by
 *     a later sub-slice, never as a refs field.
 *
 * **Framing decision (documented per slice spec):** this dark client consumes the
 * INNER `Message` JSON object (the `{ kind, ... }` payload), NOT the full versioned
 * `Envelope` wrapper (`schema_version`/`msg_id`/`sent_at`) nor the sealed-session
 * ciphertext. Envelope versioning and session sealing are the server/auth sub-slices'
 * job (S-B/S-C); modeling only the inner message keeps this slice honest about what it
 * owns. The client owns both ends against its hermetic stub, so this choice is
 * test-faithful without pulling in the transport layer.
 *
 * ## Connection lifecycle (documented choice)
 * The INTENT is a single PERSISTENT socket shared across dispatches; that is what the
 * composition slice will hold. For this dark, single-call-shaped slice the client
 * (re)connects PER CALL: `connect -> send one AgentRunRequest -> await exactly one
 * AgentRunResult (bounded timeout) -> close`. Per-call connect keeps teardown trivial
 * and each dispatch independently fail-closed; promoting it to a held socket is a
 * mechanical change for S-F and does not alter the refs-only / fail-closed contract.
 *
 * ## Hard contracts enforced here (the load-bearing invariants)
 * 1. **REFS-ONLY allowlist parse** — the result is read through a STRICT allowlist of
 *    exactly `{ run_id, status, answer_sha256?, answer_len? }`. The receipt is built
 *    as a FRESH object literal reading only those keys; the raw payload is NEVER
 *    spread. If the server ever sent an `answer` / `final_message` / body field, this
 *    client does NOT surface it — a body-bearing payload still yields a SUCCESSFUL
 *    refs-only receipt with the body absent (it is dropped, not 503'd).
 * 2. **FAIL-CLOSED (503)** on any non-clean settle: connection error, an unexpected
 *    socket close before a result, a bounded timeout, malformed JSON, a wrong/missing
 *    `kind` (unknown shape), or a result missing a required ref (`run_id` / `status`).
 *    Every failure throws the same 503-shaped {@link FridayDomainError}; none surface a
 *    body and none return a partial success.
 * 3. **Single-settle** — the awaited result settles AT MOST ONCE. On the first of
 *    {message, error, close, timeout} the timer is cleared and all listeners removed,
 *    so a late frame can neither resolve a second time nor flip a rejection.
 */

/** Default sentinel port — the real server port is supplied by the composition slice. */
const DEFAULT_AGENT_RUN_WS_PORT = 0;

/** Default bounded await for one AgentRunResult before failing closed. */
const DEFAULT_RESULT_TIMEOUT_MS = 30_000;

/** The S-A request wire kind. */
const REQUEST_KIND = "AgentRunRequest" as const;
/** The S-A result wire kind. */
const RESULT_KIND = "AgentRunResult" as const;

/**
 * A dispatched agent-run, TS-side. `forwardedPrincipal` / `authProof` are conveyed
 * SHAPE-ONLY on the wire; the Rust server's later auth sub-slice (S-C) verifies them
 * against the sealed session. This client never treats them as trusted.
 */
export interface FridayRustHubAgentRunWsRequest {
  /** Caller-chosen idempotency/run identifier for this agent-run. */
  readonly runId: string;
  /** The agent task/prompt to run on the Rust loop. */
  readonly task: string;
  /** TS-token-resolved principal — SHAPE-ONLY on the wire (verified later by S-C). */
  readonly forwardedPrincipal: string;
  /** Sealed proof bytes — SHAPE-ONLY on the wire (opaque, verified later by S-C). */
  readonly authProof: Uint8Array;
}

/**
 * REFS-ONLY agent-run result receipt — the answer FINGERPRINT only, NEVER the body.
 * `answerSha256` / `answerLen` are present only when the run produced an answer.
 */
export interface FridayRustHubAgentRunWsResult {
  /** Always `rust_wired` — a loud reminder this is a substrate path, not a product one. */
  readonly truthLabel: "rust_wired";
  /** The run this result terminates (echoes the request's run id). */
  readonly runId: string;
  /** Coarse loop-status label (e.g. `completed` / `denied` / `no_answer`). */
  readonly status: string;
  /** sha256 of the answer body — a REF, NEVER the body text. Absent when no answer. */
  readonly answerSha256?: string;
  /** Byte length of the answer body — a measure, NEVER the body text. Absent when no answer. */
  readonly answerLen?: number;
}

export interface CreateFridayRustHubAgentRunWsClientServiceOptions {
  /** Loopback host for the Rust agent-run WS server. Defaults to `127.0.0.1`. */
  readonly host?: string;
  /** Port the Rust agent-run WS server listens on. Defaults to a sentinel (0). */
  readonly port?: number;
  /** Bounded await (ms) for one AgentRunResult before failing closed. */
  readonly timeoutMs?: number;
}

export interface FridayRustHubAgentRunWsClientService {
  /**
   * Dispatch one agent-run over the WS connection and await its REFS-ONLY result.
   * Fails closed (503) on any non-clean settle. Body-free by construction.
   */
  dispatchRun(
    request: FridayRustHubAgentRunWsRequest,
  ): Promise<FridayRustHubAgentRunWsResult>;
}

function unavailable(message: string): FridayDomainError {
  return new FridayDomainError("MISSION_SPINE_RUST_AGENT_RUN_WS_CLIENT_UNAVAILABLE", message, {
    httpStatus: 503,
    details: {
      surface: "service:rust_hub_agent_run_ws_client",
      bridge: "rust_wired",
      proofOnly: true,
      proofReady: false,
    },
  });
}

function readTimeoutMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readPort(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Validate + normalize ONE inbound result frame into a refs-only receipt. Fails closed
 * on malformed JSON, a wrong/missing `kind` (unknown shape), or a missing required ref.
 *
 * REFS-ONLY allowlist: the receipt is built as a FRESH object literal reading ONLY
 * `run_id` / `status` / `answer_sha256` / `answer_len`. The raw payload is never
 * spread, so a body/`answer`/`final_message` field — if the server ever sent one — is
 * silently DROPPED (it never reaches the receipt), NOT 503'd. Surfacing a body is the
 * one outcome this client structurally cannot produce.
 */
function parseResult(raw: string): FridayRustHubAgentRunWsResult {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw unavailable("Rust agent-run WS client received invalid JSON.");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw unavailable("Rust agent-run WS client received a non-object frame.");
  }
  const root = payload as Record<string, unknown>;

  // Unknown shape: anything that is not an AgentRunResult is rejected (the request
  // kind, an Error kind, a typo'd kind, or a kind-less blob) — fail closed.
  if (root.kind !== RESULT_KIND) {
    throw unavailable("Rust agent-run WS client received an unknown message shape.");
  }

  const runId = asString(root.run_id);
  const status = asString(root.status);
  if (!runId || !status) {
    throw unavailable("Rust agent-run WS client result is missing a required ref.");
  }

  // Strict allowlist: read ONLY the known refs. answer_sha256 / answer_len are
  // optional (S-A `Option` + skip_serializing_if). Anything else on `root` —
  // including any body field — is intentionally never read onto the receipt.
  const answerSha256 = asString(root.answer_sha256);
  const answerLen = asNumber(root.answer_len);

  return {
    truthLabel: "rust_wired",
    runId,
    status,
    ...(answerSha256 !== undefined ? { answerSha256 } : {}),
    ...(answerLen !== undefined ? { answerLen } : {}),
  };
}

/** The S-A request frame, inner-message JSON (no envelope wrapper — see file header). */
function encodeRequest(request: FridayRustHubAgentRunWsRequest): string {
  return JSON.stringify({
    kind: REQUEST_KIND,
    run_id: request.runId,
    task: request.task,
    forwarded_principal: request.forwardedPrincipal,
    // Wire the proof bytes as a plain number array (shape-only; never trusted here).
    auth_proof: Array.from(request.authProof),
  });
}

export function createFridayRustHubAgentRunWsClientService(
  options: CreateFridayRustHubAgentRunWsClientServiceOptions = {},
): FridayRustHubAgentRunWsClientService {
  const host = options.host ?? process.env.FRIDAY_HUB_AGENT_RUN_WS_HOST ?? "127.0.0.1";
  const port =
    options.port ?? readPort(process.env.FRIDAY_HUB_AGENT_RUN_WS_PORT, DEFAULT_AGENT_RUN_WS_PORT);
  const timeoutMs =
    options.timeoutMs ??
    readTimeoutMs(process.env.FRIDAY_HUB_AGENT_RUN_WS_TIMEOUT_MS, DEFAULT_RESULT_TIMEOUT_MS);

  return {
    dispatchRun(
      request: FridayRustHubAgentRunWsRequest,
    ): Promise<FridayRustHubAgentRunWsResult> {
      if (!request.runId) {
        return Promise.reject(unavailable("Rust agent-run WS client requires a run id."));
      }

      const url = `ws://${host}:${port}`;
      return new Promise<FridayRustHubAgentRunWsResult>((resolve, reject) => {
        let settled = false;
        let socket: WebSocket;
        const timer = setTimeout(() => {
          fail(unavailable("Rust agent-run WS client timed out awaiting a result."));
        }, timeoutMs);
        // Never let the bounded timer keep the event loop (or a forked test worker) alive.
        if (typeof timer.unref === "function") timer.unref();

        /** Settle exactly once: clear the timer, drop listeners, close the socket. */
        function teardown(): void {
          clearTimeout(timer);
          if (socket) {
            socket.removeAllListeners();
            try {
              socket.close();
            } catch {
              // best-effort close; the result has already been decided.
            }
          }
        }

        function succeed(result: FridayRustHubAgentRunWsResult): void {
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

        try {
          socket = new WebSocket(url);
        } catch {
          fail(unavailable("Rust agent-run WS client could not open a connection."));
          return;
        }

        socket.on("open", () => {
          try {
            socket.send(encodeRequest(request));
          } catch {
            fail(unavailable("Rust agent-run WS client failed to send the request."));
          }
        });

        socket.on("message", (data: WebSocket.RawData) => {
          let result: FridayRustHubAgentRunWsResult;
          try {
            result = parseResult(data.toString());
          } catch (error) {
            fail(
              error instanceof FridayDomainError
                ? error
                : unavailable("Rust agent-run WS client could not parse a result."),
            );
            return;
          }
          succeed(result);
        });

        // Connection error (e.g. ECONNREFUSED) → fail closed, no detail surfaced.
        socket.on("error", () => {
          fail(unavailable("Rust agent-run WS client connection error."));
        });

        // An unexpected close before a result is delivered is a fail-closed condition.
        socket.on("close", () => {
          fail(unavailable("Rust agent-run WS client connection closed before a result."));
        });
      });
    },
  };
}

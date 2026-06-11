import { FridayDomainError } from "#errors";

import {
  createFridayRustHubAgentRunSealedClient,
  type CreateFridayRustHubAgentRunSealedClientOptions,
  type FridayRustHubAgentRunConstraints,
  type FridayRustHubAgentRunSealedClient,
} from "./friday-rust-hub-agent-run-ws-sealed-client.js";

/**
 * WIRED into the production read-only Rust agent-run route, gated DEFAULT-OFF — SERVICE
 * ADAPTER that lets the composition (`composeRustReadOnlyAgentRun` in friday-api-runtime.ts,
 * reached from the live `routeStartRun`) drive the PROVEN sealed WS client
 * (`friday-rust-hub-agent-run-ws-sealed-client.ts`) through the SAME `dispatchRun(...)` seam the
 * old plain-WS client exposed — but over the REAL sealed ECDH protocol (sub-slice B1-compose).
 * As of B1-compose this adapter IS imported + constructed by friday-api-runtime.ts and its
 * `dispatchRun(...)` runs on the live route path, so the prior "no production route consumes
 * this" claim is no longer true. It does NOT run in default prod: the route branch is gated
 * DEFAULT-OFF behind `FRIDAY_ROUTE_AGENT_RUN_VIA_RUST` (operator cutover pending) and only fires
 * for a qualifying read-only run.
 *
 * ## Why an adapter (and not a direct swap)
 * The old `FridayRustHubAgentRunWsClientService.dispatchRun` took a pre-built SYMMETRIC
 * `authProof` and returned a refs-only result. The sealed client instead takes the client's
 * X25519 SECRET, runs the ECDH handshake, builds the `auth_proof` ITSELF, and returns refs PLUS
 * an in-band owner-sealed body. This adapter bridges the two: it accepts the per-dispatch
 * `clientSecret` (resolved by the SecureStore X25519 resolver in compose), constructs the
 * underlying sealed client, dispatches, and maps the sealed result down to the REFS-ONLY shape
 * the composition consumes. The sealed client's in-band `body` is DROPPED here — it is
 * belt-and-suspenders for compose, whose authoritative body source stays the slice-3 owner-gated
 * DB readback (the Rust loop persists the owner-sealed body to the Hub DB; readback reads it).
 *
 * ## Construction seam (load-bearing for flag-off byte-identical)
 * The factory captures ONLY host/port/timeout; it does NOT resolve a secret and does NOT
 * construct the underlying client. The underlying client is built LAZILY, INSIDE `dispatchRun`,
 * via the injectable `createClient` seam (default = the real sealed-client factory). So the
 * factory is side-effect-free — the route can construct it eagerly at startup with NO key
 * resolution, NO socket, and NO `RangeError` from a not-yet-resolved secret — which is exactly
 * what keeps the DEFAULT-OFF route byte-identical to today (the dark services are constructed but
 * never consulted). Tests mock `createClient` to map/fail-closed WITHOUT a socket and WITHOUT
 * re-proving the (already-proven) interop.
 *
 * ## Fail-closed contract
 * The underlying sealed client already funnels EVERY non-clean settle (connect error, closed
 * session, bad seal, missing ref, timeout, malformed frame, fingerprint mismatch) to a 503-shaped
 * {@link FridayDomainError}. This adapter adds no new success path: any throw/reject from the
 * underlying dispatch surfaces unchanged (503), and a result is mapped to refs-only.
 *
 * ## Truth labels
 * - WIRED into the production route handler but gated DEFAULT-OFF: friday-api-runtime.ts imports
 *   + constructs this adapter and `composeRustReadOnlyAgentRun` calls `dispatchRun(...)` on the
 *   live `routeStartRun` path, so it IS consumed by a production route (NOT "no production route
 *   consumes it"). It stays inert in default prod until the operator flips
 *   `FRIDAY_ROUTE_AGENT_RUN_VIA_RUST` (6b cutover pending) and a run qualifies.
 * - `rust_wired` ceiling: confers NO v1 GO. Narrow (read-only / refs-only); not a full
 *   executeRun replacement.
 */

/** A sealed agent-run dispatch, TS-side. Carries the client's X25519 SECRET (NOT a pre-built proof). */
export interface FridayRustHubAgentRunSealedClientServiceRequest {
  /** Caller-chosen idempotency/run identifier for this agent-run. */
  readonly runId: string;
  /** The agent task/prompt to run on the Rust loop. */
  readonly task: string;
  /** The TS-token-resolved principal the trusted peer forwards (allowlist-checked by the server). */
  readonly forwardedPrincipal: string;
  /**
   * The client's 32-byte X25519 SECRET scalar (resolved from SecureStore by compose). The matching
   * pubkey MUST be enrolled in the server's peer-allowlist or the server establishes NO session
   * (fail-closed). Held in-process only; never logged. A non-32-byte secret fails closed (503).
   */
  readonly clientSecret: Uint8Array;
  /**
   * (A2a Phase 1) The session key for a MULTI-TURN read-only chat run. Forwarded UNCHANGED to the
   * underlying sealed client, which emits it as `session_id` ONLY when non-empty (absent/blank ⇒
   * byte-identical sessionless wire). The Rust server scopes the session to the authenticated
   * `forwardedPrincipal`, never this key.
   */
  readonly sessionKey?: string;
  /**
   * (A1 run-controls) Per-run CONSTRAINTS forwarded UNCHANGED to the underlying sealed client,
   * which emits the snake_case `constraints` wire block ONLY when something tightens (else OMITS
   * it ⇒ byte-identical pre-A1 wire). The Rust server COMPOSES them onto the run policy (read-only
   * / disabled-tools / max-turns), tightening only, behind its default-off run-control flag.
   */
  readonly constraints?: FridayRustHubAgentRunConstraints;
}

/**
 * REFS-ONLY agent-run result receipt — the answer FINGERPRINT only, NEVER the body. The sealed
 * client's in-band opened `body` is intentionally NOT surfaced here (compose's body source is the
 * slice-3 DB readback). Shape-identical to the old client's `FridayRustHubAgentRunWsResult` so the
 * composition's downstream (projector loopStatus + finalMessage refs) is untouched.
 */
export interface FridayRustHubAgentRunSealedClientServiceResult {
  /** Always `rust_wired` — a loud reminder this is a substrate path, not a product one. */
  readonly truthLabel: "rust_wired";
  /** The run this result terminates (echoes the request's run id). */
  readonly runId: string;
  /** Coarse loop-status label (e.g. `finished` / denied / no_answer). */
  readonly status: string;
  /** sha256 of the answer body — a REF, NEVER the body text. Absent when no answer. */
  readonly answerSha256?: string;
  /** Byte length of the answer body — a measure, NEVER the body text. Absent when no answer. */
  readonly answerLen?: number;
  /**
   * (A1 transport-truth) REFS-surface run COUNTS — counts only, NEVER a body/turn/tool name.
   * `undefined` when the server omits them (an OLD server that predates A1, or a non-delivered
   * outcome). Token counts are DEFERRED server-side ⇒ currently always `undefined`.
   */
  readonly turns?: number;
  readonly executedTools?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
}

export interface FridayRustHubAgentRunSealedClientService {
  /**
   * Dispatch one agent-run over a sealed ECDH session and await its REFS-ONLY result. Builds the
   * underlying sealed client from the request's `clientSecret`, runs the handshake + auth_proof +
   * send INTERNALLY, then maps the sealed result to refs-only. Fails closed (503) on any non-clean
   * settle. The in-band owner-sealed body is dropped (compose uses the DB readback).
   */
  dispatchRun(
    request: FridayRustHubAgentRunSealedClientServiceRequest,
  ): Promise<FridayRustHubAgentRunSealedClientServiceResult>;
}

/**
 * Factory seam for the underlying sealed client. Defaults to the real
 * {@link createFridayRustHubAgentRunSealedClient}; tests inject a fake to map/fail-closed without
 * a socket (and without re-proving the interop, which is already proven).
 */
export type CreateSealedClientFn = (
  options: CreateFridayRustHubAgentRunSealedClientOptions,
) => FridayRustHubAgentRunSealedClient;

export interface CreateFridayRustHubAgentRunSealedClientServiceOptions {
  /** Loopback host for the Rust agent-run WS server. Defaults to `127.0.0.1` (in the client). */
  readonly host?: string;
  /** Port the Rust agent-run WS server listens on. */
  readonly port: number;
  /** Bounded await (ms) for one dispatch before failing closed. */
  readonly timeoutMs?: number;
  /**
   * Injectable factory for the underlying sealed client (test seam). Default = the real sealed
   * client. Constructed LAZILY per-dispatch so the service factory itself is side-effect-free.
   */
  readonly createClient?: CreateSealedClientFn;
}

function unavailable(message: string): FridayDomainError {
  return new FridayDomainError("MISSION_SPINE_RUST_AGENT_RUN_SEALED_WS_CLIENT_UNAVAILABLE", message, {
    httpStatus: 503,
    details: {
      surface: "service:rust_hub_agent_run_sealed_ws_client_service",
      bridge: "rust_wired",
      proofOnly: true,
      proofReady: false,
    },
  });
}

/**
 * Build the sealed-client SERVICE adapter the composition wires in place of the old plain-WS
 * client. SIDE-EFFECT-FREE: captures host/port/timeout/createClient only; resolves no secret and
 * opens no socket until `dispatchRun` is actually called on a qualifying run.
 */
export function createFridayRustHubAgentRunSealedClientService(
  options: CreateFridayRustHubAgentRunSealedClientServiceOptions,
): FridayRustHubAgentRunSealedClientService {
  const { host, port, timeoutMs } = options;
  const createClient = options.createClient ?? createFridayRustHubAgentRunSealedClient;

  return {
    async dispatchRun(
      request: FridayRustHubAgentRunSealedClientServiceRequest,
    ): Promise<FridayRustHubAgentRunSealedClientServiceResult> {
      // Build the underlying sealed client from the per-dispatch X25519 secret. A non-32-byte
      // secret throws a RangeError from the sealed client constructor; map it to fail-closed (503)
      // so a malformed resolve surfaces as today's 503 rather than an unhandled throw.
      let client: FridayRustHubAgentRunSealedClient;
      try {
        client = createClient({
          ...(host !== undefined ? { host } : {}),
          port,
          clientSecret: request.clientSecret,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
      } catch {
        throw unavailable("Sealed agent-run client could not be constructed.");
      }

      // The sealed client's dispatch already fails closed (503) on every non-clean settle; surface
      // its FridayDomainError unchanged, wrap any non-domain throw as fail-closed.
      let sealed;
      try {
        sealed = await client.dispatchRun({
          runId: request.runId,
          task: request.task,
          forwardedPrincipal: request.forwardedPrincipal,
          // (A2a Phase 1) forward the session key; the inner client emits `session_id` only when
          // non-empty (absent/blank ⇒ byte-identical sessionless wire).
          ...(request.sessionKey !== undefined ? { sessionKey: request.sessionKey } : {}),
          // (A1 run-controls) forward the per-run constraints; the inner client emits the
          // `constraints` wire block only when something tightens (absent ⇒ byte-identical wire).
          ...(request.constraints !== undefined ? { constraints: request.constraints } : {}),
        });
      } catch (error) {
        throw error instanceof FridayDomainError
          ? error
          : unavailable("Sealed agent-run client dispatch failed.");
      }

      // Map to the REFS-ONLY shape the composition consumes — DROP the in-band `body` (compose's
      // authoritative body source is the slice-3 owner-gated DB readback). (A1) Thread the run
      // COUNTS through when present (absent ⇒ omitted, never 0-faked); these are counts, not body.
      return {
        truthLabel: "rust_wired",
        runId: sealed.runId,
        status: sealed.status,
        ...(sealed.answerSha256 !== undefined ? { answerSha256: sealed.answerSha256 } : {}),
        ...(sealed.answerLen !== undefined ? { answerLen: sealed.answerLen } : {}),
        ...(sealed.turns !== undefined ? { turns: sealed.turns } : {}),
        ...(sealed.executedTools !== undefined ? { executedTools: sealed.executedTools } : {}),
        ...(sealed.promptTokens !== undefined ? { promptTokens: sealed.promptTokens } : {}),
        ...(sealed.completionTokens !== undefined
          ? { completionTokens: sealed.completionTokens }
          : {}),
      };
    },
  };
}

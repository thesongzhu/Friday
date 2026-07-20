import { FridayDomainError } from "#errors";

import type { FridayRustSessionLifecycleBridge } from "../http/routes/friday-session-routes.js";
import type { FridaySessionRunResponse } from "../model/friday-api-session.types.js";
import {
  createFridayRustHubAgentRunSealedClientService,
  type CreateSealedClientFn,
  type FridayRustHubAgentRunSealedClientService,
  isPausedDispatchOutcome,
} from "./friday-rust-hub-agent-run-sealed-client-service.js";
import {
  createFridayRustHubRunAnswerReadbackService,
  type FridayRustHubRunAnswerReadbackService,
} from "./friday-rust-hub-run-answer-readback-service.js";
import type { FridayRustAgentRunWsClientX25519SecretResolver } from "./friday-rust-hub-agent-run-ws-client-x25519-secret.js";

/**
 * (CORE-RUNNABLE-001 / CORE-A CR-3) The bootstrap-side REAL ADAPTER that makes the SESSION
 * Rust-owned lifecycle bridge PRODUCTION-WIRED — the sibling of
 * {@link createFridayMissionSpineDispatchAdapter}. Until this exists, the session route's
 * {@link FridayRustSessionLifecycleBridge} is only ever reachable in mock-injected route unit
 * tests (nothing constructs a REAL one and threads it into the runtime), so the Rust session
 * path is "mock-test-only". This adapter is what the DEFAULT-OFF operator flag
 * (`FRIDAY_ROUTE_SESSIONS_VIA_RUST`, resolved by `resolveRouteSessionsViaRust`) wires in.
 *
 * ## What is REAL here (and what is honestly fail-closed)
 * - `runSession` is REAL: it dispatches a session-scoped agent run over the SAME sealed-WS
 *   ECDH transport the agent-run path uses ({@link createFridayRustHubAgentRunSealedClientService}
 *   → the proven `friday-rust-hub-agent-run-ws-sealed-client`), forwarding the `sessionKey` as
 *   the wire `session_id` (the sealed client explicitly supports a multi-turn session run), then
 *   sources the answer body from the SAME owner-gated DB readback
 *   ({@link FridayRustHubRunAnswerReadbackService.readAnswer}) `composeRustReadOnlyAgentRun`
 *   uses. It is NOT a mock — the low-level sealed client + readback are injectable ONLY as a
 *   test transport (a fake `createClient` / `readback` that maps/fail-closes WITHOUT a socket,
 *   exactly like the agent-run + mission-spine adapters' tests); the default is the real client.
 * - `createSession` / `appendMessage` / `getMemoryNamespace` are HONESTLY fail-closed (503).
 *   These are pure Hub STORAGE lifecycle ops with NO agent-run analog: the existing sealed-WS
 *   client exposes NO session-create / append-message / memory-namespace RPC, and the Rust hub
 *   server exposes NO matching handler. Building a "real" round-trip for them would require
 *   inventing a session-lifecycle wire protocol + a Rust server handler + a deploy — a
 *   LIVE/operator dependency out of scope for this agent-doable wiring slice. Rather than FAKE a
 *   success (a mock), this adapter surfaces the honest 503
 *   `RUST_SESSION_LIFECYCLE_PROTOCOL_UNAVAILABLE` and FLAGS the gap. When the Rust session
 *   lifecycle protocol ships, these become real round-trips here (the seam is already threaded).
 *
 * ## Construction seam (load-bearing for flag-OFF byte-identical)
 * SIDE-EFFECT-FREE: the factory captures host/port/timeout + resolver/createClient/readback seams
 * only. It resolves NO secret and opens NO socket until `runSession` is actually called on a real
 * request — so a flag-ON-but-unprovisioned host FAILS CLOSED (503) per call rather than crashing
 * boot, and when the flag is OFF the adapter is never constructed at all (bootstrap leaves the
 * runtime dep unset ⇒ the session routes resolve their retired 503 ⇒ byte-identical to today).
 *
 * ## Fail-closed contract (never a fake success)
 * - The X25519 secret resolver returns `null` (missing / disabled / non-32-byte / misconfigured)
 *   ⇒ typed 503 BEFORE any socket is opened.
 * - The owner-gated readback DB path is absent (no `FRIDAY_HUB_AGENT_RUN_DB_PATH`) ⇒ typed 503.
 * - The underlying dispatch / readback rejects (connect / closed / timeout / bad seal / non-owner
 *   / not-found) ⇒ its `FridayDomainError` (503) surfaces UNCHANGED; any non-domain throw is
 *   wrapped as a typed 503. A PAUSED outcome (run-control off in this slice) fails closed.
 *
 * ## Truth label
 * `rust_wired` ceiling: confers NO v1 GO. End-to-end session-loop closure ALSO needs the Rust
 * server flags + the provisioned sealed-WS host + the answer-readback DB + an operator cutover
 * (`FRIDAY_ROUTE_SESSIONS_VIA_RUST` default-off) + a real turn. This adapter only makes the TS
 * session run route reachable-and-real when the flag is on.
 */

/** Plan lifetime is not relevant here; this adapter is stateless per call. */
export interface CreateFridayRustHubSessionLifecycleDispatchAdapterOptions {
  /** Loopback host for the Rust agent-run WS server. Defaults to `127.0.0.1` (in the client). */
  readonly host?: string;
  /** Port the Rust agent-run WS server listens on (the SAME server the agent-run path dials). */
  readonly port: number;
  /** Bounded await (ms) for one dispatch before failing closed. */
  readonly timeoutMs?: number;
  /**
   * SecureStore resolver for the sealed WS client's X25519 SECRET — the SAME ECDH-model resolver
   * the agent-run + mission-spine paths use. A `null`/short resolve fails closed → no WS call.
   * Tests inject a fixture secret. NEVER logs it.
   */
  readonly secretResolver: FridayRustAgentRunWsClientX25519SecretResolver;
  /** Mints the per-run id for a session run dispatch. */
  readonly idGenerator: () => string;
  /**
   * Filesystem path to the Rust Hub DB the owner-gated answer readback reads from. Default =
   * `process.env.FRIDAY_HUB_AGENT_RUN_DB_PATH`. Absent → `runSession` fails closed (no body).
   */
  readonly hubDbPath?: string;
  /**
   * Injectable factory for the underlying LOW-LEVEL sealed client (test seam). Default = the real
   * sealed client. Constructed LAZILY per-call so this factory itself is side-effect-free. Tests
   * inject a fake to map/fail-closed WITHOUT a socket (and without re-proving the proven interop).
   */
  readonly createClient?: CreateSealedClientFn;
  /**
   * Injectable owner-gated answer readback service (test seam). Default = the real service. Tests
   * inject a fake `delivered`/`denied`/`not_found` receipt to map/fail-closed WITHOUT a Rust bin.
   */
  readonly readback?: FridayRustHubRunAnswerReadbackService;
}

function unavailable(message: string): FridayDomainError {
  return new FridayDomainError("RUST_SESSION_LIFECYCLE_DISPATCH_UNAVAILABLE", message, {
    httpStatus: 503,
    details: {
      surface: "service:rust_hub_session_lifecycle_dispatch_adapter",
      bridge: "rust_wired",
      proofOnly: true,
      proofReady: false,
    },
  });
}

/**
 * The three pure-storage lifecycle ops have NO Rust WS RPC + NO Rust server handler yet. Surface an
 * honest 503 (never a fake success). This is the FLAGGED live/operator dependency — closing it is a
 * later slice that ships the session-lifecycle wire protocol + a Rust handler + a deploy.
 */
function sessionLifecycleProtocolUnavailable(op: string): FridayDomainError {
  return new FridayDomainError(
    "RUST_SESSION_LIFECYCLE_PROTOCOL_UNAVAILABLE",
    `Rust session lifecycle op '${op}' has no sealed-WS RPC / server handler yet; ` +
      "it fails closed until the Rust session-lifecycle protocol ships (operator-gated).",
    {
      httpStatus: 503,
      details: {
        surface: "service:rust_hub_session_lifecycle_dispatch_adapter",
        op,
        bridge: "rust_wired",
        proofOnly: true,
        proofReady: false,
      },
    },
  );
}

/**
 * Build the session-lifecycle dispatch ADAPTER the bootstrap injects into the runtime's
 * `rustSessionLifecycleBridge` dep when `FRIDAY_ROUTE_SESSIONS_VIA_RUST` is on. SIDE-EFFECT-FREE:
 * captures host/port/timeout + resolver/createClient/readback seams only; resolves no secret and
 * opens no socket until `runSession` actually runs on a real request.
 */
export function createFridayRustHubSessionLifecycleDispatchAdapter(
  options: CreateFridayRustHubSessionLifecycleDispatchAdapterOptions,
): FridayRustSessionLifecycleBridge {
  const { host, port, timeoutMs, secretResolver, idGenerator } = options;
  const readback = options.readback ?? createFridayRustHubRunAnswerReadbackService();
  const hubDbPath = options.hubDbPath ?? process.env.FRIDAY_HUB_AGENT_RUN_DB_PATH;

  /**
   * Construct the sealed-WS SERVICE adapter (the SAME one the agent-run compose path uses) once —
   * side-effect-free (no secret resolved, no socket opened at construction). The per-dispatch
   * X25519 secret is passed to `dispatchRun` below.
   */
  const sealedService: FridayRustHubAgentRunSealedClientService =
    createFridayRustHubAgentRunSealedClientService({
      ...(host !== undefined ? { host } : {}),
      port,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(options.createClient !== undefined ? { createClient: options.createClient } : {}),
    });

  return {
    // ── Pure-storage lifecycle ops: HONEST fail-closed (no Rust RPC/handler yet). ──
    async createSession(): Promise<never> {
      throw sessionLifecycleProtocolUnavailable("sessions.create");
    },
    async appendMessage(): Promise<never> {
      throw sessionLifecycleProtocolUnavailable("sessions.messages.create");
    },
    async getMemoryNamespace(): Promise<never> {
      throw sessionLifecycleProtocolUnavailable("sessions.memory.namespace.get");
    },

    // ── Session RUN: REAL — dispatch over the sealed-WS transport + owner-gated body readback. ──
    async runSession(input: {
      sessionKey: string;
      task: string;
      principalId: string;
      providerId?: string;
      model?: string;
      timezone?: string;
      timeoutMs?: number;
    }): Promise<FridaySessionRunResponse["run"]> {
      const callerPrincipal = input.principalId.trim();
      if (!callerPrincipal) {
        // Owner-binding requires a canonical, non-blank principal (the readback ownership gate
        // matches `caller == owner`). A blank principal fails closed rather than reading anonymously.
        throw unavailable("Session Rust run requires a bound owner principal.");
      }
      const clientSecret = secretResolver();
      if (!clientSecret) {
        throw unavailable("Session Rust run could not resolve the sealed-WS client secret.");
      }
      if (!hubDbPath) {
        // The answer body is owner-gated in the Rust Hub DB; without a DB path there is nothing to
        // read back → fail closed rather than returning a body-less (dishonest) run result.
        throw unavailable("Session Rust run has no Hub DB path for the owner-gated answer readback.");
      }

      const runId = idGenerator();
      // (1) Dispatch the session-scoped run over the sealed ECDH transport. `sessionKey` becomes the
      //     wire `session_id`; the run is read-only in this slice (defense-in-depth on the wire).
      let outcome;
      try {
        outcome = await sealedService.dispatchRun({
          runId,
          task: input.task,
          forwardedPrincipal: callerPrincipal,
          clientSecret,
          sessionKey: input.sessionKey,
          constraints: { readOnly: true },
        });
      } catch (error) {
        throw error instanceof FridayDomainError ? error : unavailable("Session Rust run dispatch failed.");
      }
      // A PAUSED outcome (run-control transport) is not admitted in this slice → fail closed.
      if (isPausedDispatchOutcome(outcome)) {
        throw unavailable("Session Rust run returned a paused outcome, which is not supported in this slice.");
      }
      const wsResult = outcome;

      // (2) Owner-gated body readback — the SAME authoritative body source `composeRustReadOnlyAgentRun`
      //     uses. A non-`delivered` outcome carries no body ⇒ fail closed.
      let receipt;
      try {
        receipt = await readback.readAnswer({ dbPath: hubDbPath, runId, callerPrincipal });
      } catch (error) {
        throw error instanceof FridayDomainError ? error : unavailable("Session Rust run readback failed.");
      }
      if (receipt.outcome !== "delivered") {
        throw unavailable(`Session Rust run body readback was not delivered (outcome: ${receipt.outcome}).`);
      }

      // (3) Map the refs-only WS result + owner-released body to the session run response. The Rust
      //     server's wire status echoes the persisted RunResult status ("finished" for a finished
      //     loop) → map "finished" → "completed", else "failed". Token/tool counts are the carried
      //     wire counts (0 when the server omits them — no fabricated numbers); `durationMs` stays 0
      //     (the refs-only result carries no start time — honest 0, not invented).
      return {
        runId,
        status: wsResult.status === "finished" ? "completed" : "failed",
        response: receipt.answer,
        toolCallCount: wsResult.executedTools ?? 0,
        durationMs: 0,
        usageInput: wsResult.promptTokens ?? 0,
        usageOutput: wsResult.completionTokens ?? 0,
      };
    },
  };
}

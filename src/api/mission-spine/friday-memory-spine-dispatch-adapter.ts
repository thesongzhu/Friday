import { FridayDomainError } from "#errors";

import type { FridayMemorySpineDispatchService } from "../http/routes/friday-memory-spine-routes.js";
import {
  createFridayRustHubAgentRunSealedClient,
  type CreateFridayRustHubAgentRunSealedClientOptions,
  type FridayRustHubAgentRunSealedClient,
  type FridayRustHubMemoryDecisionRequest,
  type FridayRustHubMemoryDecisionResult,
} from "./friday-rust-hub-agent-run-ws-sealed-client.js";
import type { FridayRustAgentRunWsClientX25519SecretResolver } from "./friday-rust-hub-agent-run-ws-client-x25519-secret.js";

/**
 * (Lane M) The bootstrap-side ADAPTER that makes the ORGANIC `POST /v1/memory-spine/decide` route
 * CALLABLE — by satisfying the route's `deps.dispatch` ({@link FridayMemorySpineDispatchService}).
 * Until something provides that dispatcher, the POST route is PERMANENTLY 503
 * (`MEMORY_SPINE_DISPATCH_UNAVAILABLE`); this adapter is what an operator flag wires in to flip it
 * from honest-unavailable to live. It is the DIRECT MIRROR of the mission-spine dispatch adapter
 * ({@link createFridayMissionSpineDispatchAdapter}) — same construction seam, same lazy per-call
 * build, same fail-closed contract — delegating to the SAME low-level sealed client's `decideMemory`.
 *
 * ## Construction seam (load-bearing for flag-OFF byte-identical)
 * SIDE-EFFECT-FREE: captures host/port/timeout + the injectable resolver/createClient seams only. It
 * resolves NO secret and constructs NO underlying client at construction time — that happens LAZILY,
 * INSIDE the method, so a flag-ON-but-unprovisioned host FAILS CLOSED (503) per call rather than
 * crashing boot. When the route flag is OFF this adapter is never constructed at all and the route's
 * `dispatch` stays unset (null) → byte-identical to today.
 *
 * ## Fail-closed contract (never a fake success)
 * - The X25519 secret resolver returns `null` ⇒ this throws a typed 503 BEFORE any socket is opened.
 * - The underlying client constructor throws (malformed secret) ⇒ caught and surfaced as a typed 503.
 * - The underlying round-trip rejects (connect error / closed session / timeout / wrong inbound kind /
 *   the server's `Error` envelope / unparseable result) ⇒ its `FridayDomainError` (503) surfaces
 *   UNCHANGED; any non-domain throw is wrapped as a typed 503. A `status:"blocked"` from the Hub is a
 *   SUCCESSFUL round-trip of a refusal (resolved, not thrown) — passed through verbatim, never coerced.
 *
 * ## Truth labels (read before trusting this)
 * - `rust_wired` ceiling: confers NO v1 GO. End-to-end Memory-confirmation closure ALSO needs the
 *   SERVER flag `FRIDAY_MEMORY_CONFIRM` (the merged Rust arm is DEFAULT-OFF) + `FRIDAY_RUN_LOOP_
 *   MEMORY_EXTRACTION` (to produce candidates) + a deploy (operator-gated). This adapter only makes
 *   the TS route callable.
 */

/**
 * Factory seam for the underlying sealed client. Defaults to the real
 * {@link createFridayRustHubAgentRunSealedClient}; tests inject a fake to delegate/fail-closed
 * WITHOUT a socket (and without re-proving the already-proven interop).
 */
export type CreateMemorySpineSealedClientFn = (
  options: CreateFridayRustHubAgentRunSealedClientOptions,
) => FridayRustHubAgentRunSealedClient;

export interface CreateFridayMemorySpineDispatchAdapterOptions {
  /** Loopback host for the Rust agent-run WS server. Defaults to `127.0.0.1` (in the client). */
  readonly host?: string;
  /** Port the Rust agent-run WS server listens on (the SAME server the agent-run path dials). */
  readonly port: number;
  /** Bounded await (ms) for one memory-decision round-trip before failing closed. */
  readonly timeoutMs?: number;
  /**
   * SecureStore resolver for the sealed WS client's X25519 SECRET — the SAME ECDH-model resolver the
   * agent-run + mission-spine paths use. A `null`/short resolve fails closed → no WS call, today's
   * 503. Tests inject a fixture secret. NEVER logs it.
   */
  readonly secretResolver: FridayRustAgentRunWsClientX25519SecretResolver;
  /**
   * Injectable factory for the underlying sealed client (test seam). Default = the real sealed client.
   * Constructed LAZILY per-call so this factory itself is side-effect-free.
   */
  readonly createClient?: CreateMemorySpineSealedClientFn;
}

function unavailable(message: string): FridayDomainError {
  return new FridayDomainError("MEMORY_SPINE_DISPATCH_RUST_UNAVAILABLE", message, {
    httpStatus: 503,
    details: {
      surface: "service:memory_spine_dispatch_adapter",
      bridge: "rust_wired",
      proofOnly: true,
      proofReady: false,
    },
  });
}

/**
 * Build the memory-spine dispatch ADAPTER the bootstrap injects into the memory-spine route's
 * `dispatch` when the operator flag is on. SIDE-EFFECT-FREE: captures host/port/timeout +
 * resolver/createClient seams only; resolves no secret and opens no socket until the route actually
 * calls `decideMemory` on a real request.
 */
export function createFridayMemorySpineDispatchAdapter(
  options: CreateFridayMemorySpineDispatchAdapterOptions,
): FridayMemorySpineDispatchService {
  const { host, port, timeoutMs } = options;
  const createClient = options.createClient ?? createFridayRustHubAgentRunSealedClient;
  const secretResolver = options.secretResolver;

  /**
   * Resolve the X25519 secret + construct the underlying sealed client. Fail-closed (503): a
   * `null`/short resolve → no client; a constructor throw (non-32-byte secret) → mapped to 503.
   */
  function buildClient(): FridayRustHubAgentRunSealedClient {
    const clientSecret = secretResolver();
    if (!clientSecret) {
      throw unavailable("Memory-spine dispatch could not resolve the sealed-WS client secret.");
    }
    try {
      return createClient({
        ...(host !== undefined ? { host } : {}),
        port,
        clientSecret,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
    } catch {
      throw unavailable("Memory-spine dispatch could not construct the sealed-WS client.");
    }
  }

  return {
    async decideMemory(
      request: FridayRustHubMemoryDecisionRequest,
    ): Promise<FridayRustHubMemoryDecisionResult> {
      const client = buildClient();
      try {
        return await client.decideMemory(request);
      } catch (error) {
        throw error instanceof FridayDomainError
          ? error
          : unavailable("Memory-spine decision dispatch failed.");
      }
    },
  };
}

/**
 * Parse the Rust agent-run WS port from a raw env string — REPLICATES `readMissionSpineRustWsPort`
 * EXACTLY so the memory-spine adapter dials the SAME port as the agent-run / mission-spine paths:
 * absent/blank/non-finite/negative ⇒ `0` (with the flag off this port is never dialed).
 */
export function readMemorySpineRustWsPort(raw: string | undefined): number {
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

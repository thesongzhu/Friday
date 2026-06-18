import { FridayDomainError } from "#errors";

import type { FridayMissionAutoDispatchDriver } from "./friday-mission-auto-dispatch-driver.js";
import type { FridayMissionSpineDispatchService } from "../http/routes/friday-mission-spine-routes.js";
import {
  createFridayRustHubAgentRunSealedClient,
  type CreateFridayRustHubAgentRunSealedClientOptions,
  type FridayRustHubAgentRunSealedClient,
  type FridayRustHubMissionIntakeRequest,
  type FridayRustHubMissionIntakeResult,
  type FridayRustHubMissionLifecycleRequest,
  type FridayRustHubMissionLifecycleResult,
  type FridayRustHubRouteDecisionControlRequest,
  type FridayRustHubRouteDecisionControlResult,
  type FridayRustHubWorkItemStatusRequest,
  type FridayRustHubWorkItemStatusResult,
} from "./friday-rust-hub-agent-run-ws-sealed-client.js";
import type { FridayRustAgentRunWsClientX25519SecretResolver } from "./friday-rust-hub-agent-run-ws-client-x25519-secret.js";

/**
 * (Lane B-2) The bootstrap-side ADAPTER that makes the three ORGANIC mission-spine POST routes
 * (`/v1/mission-spine/intake|lifecycle|work-item-status`) CALLABLE — by satisfying the routes'
 * `deps.dispatch` ({@link FridayMissionSpineDispatchService}). Until something provides that
 * dispatcher, every POST route is PERMANENTLY 503 (`MISSION_SPINE_DISPATCH_UNAVAILABLE`); this
 * adapter is what an operator flag (`FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST`) wires in to flip them
 * from honest-unavailable to live.
 *
 * ## Why a separate adapter (and not the agent-run Service wrapper)
 * The agent-run `createFridayRustHubAgentRunSealedClientService` takes a per-DISPATCH `clientSecret`
 * (compose resolves it from SecureStore per qualifying run) and exposes `dispatchRun`/`resumeWithApproval`.
 * The mission-spine route interface instead exposes `intakeMission`/`transitionMission`/`transitionWorkItem`
 * — the THREE PURE-Hub mutations the low-level sealed client (`createFridayRustHubAgentRunSealedClient`)
 * already implements (`runMissionRoundTrip`: connect → ECDH preamble → WS upgrade → seal+send → await the
 * FIRST matching `*Result`, refs-only, NO DB). This adapter bridges those: it resolves the X25519 SECRET,
 * constructs the underlying sealed client, and delegates each method 1:1.
 *
 * ## Construction seam (load-bearing for flag-OFF byte-identical)
 * The factory captures ONLY host/port/timeout + the injectable resolver/createClient seams. It does NOT
 * resolve a secret and does NOT construct the underlying client at construction time — that happens LAZILY,
 * INSIDE each method (mirrors the agent-run Service wrapper's per-dispatch `buildClient` idiom). So the
 * factory is SIDE-EFFECT-FREE: bootstrap can construct it eagerly when the flag is ON with NO key
 * resolution, NO socket, and NO synchronous `RangeError` from a not-yet-provisioned secret — a flag-ON
 * but unprovisioned host FAILS CLOSED (503) per call rather than crashing boot. When the flag is OFF the
 * adapter is never constructed at all and `missionSpine.dispatch` stays unset (null) → byte-identical to
 * today.
 *
 * ## Fail-closed contract (never a fake success)
 * - The X25519 secret resolver returns `null` (missing / disabled / non-32-byte / SecureStore misconfig)
 *   ⇒ this throws a typed 503 BEFORE any socket is opened.
 * - The underlying client constructor throws (e.g. a malformed secret slipped past the resolver) ⇒ caught
 *   and surfaced as a typed 503.
 * - The underlying mission round-trip rejects (connect error / closed session / timeout / wrong inbound
 *   kind / the server's `Error` envelope / unparseable result) ⇒ its `FridayDomainError` (503) surfaces
 *   UNCHANGED; any non-domain throw is wrapped as a typed 503. There is NO new success path — a result is
 *   the refs-only `*Result` the low-level client already returns, passed through verbatim.
 *
 * ## Truth labels (read before trusting this)
 * - `rust_wired` ceiling: confers NO v1 GO. End-to-end Loop1 closure ALSO needs the SERVER flags
 *   (`FRIDAY_MISSION_INTAKE` for intake, `FRIDAY_MISSION_SPINE_DISPATCH` for lifecycle/work-item) + a
 *   deploy + a real test mission (operator-gated). This adapter only makes the TS routes callable.
 */

/**
 * Factory seam for the underlying sealed client. Defaults to the real
 * {@link createFridayRustHubAgentRunSealedClient}; tests inject a fake to delegate/fail-closed
 * WITHOUT a socket (and without re-proving the already-proven interop).
 */
export type CreateMissionSpineSealedClientFn = (
  options: CreateFridayRustHubAgentRunSealedClientOptions,
) => FridayRustHubAgentRunSealedClient;

export interface CreateFridayMissionSpineDispatchAdapterOptions {
  /** Loopback host for the Rust agent-run WS server. Defaults to `127.0.0.1` (in the client). */
  readonly host?: string;
  /** Port the Rust agent-run WS server listens on (the SAME server the agent-run path dials). */
  readonly port: number;
  /** Bounded await (ms) for one mission round-trip before failing closed. */
  readonly timeoutMs?: number;
  /**
   * SecureStore resolver for the sealed WS client's X25519 SECRET — the SAME ECDH-model resolver the
   * agent-run path uses. A `null`/short resolve fails closed → no WS call, today's 503. Tests inject a
   * fixture secret. NEVER logs it.
   */
  readonly secretResolver: FridayRustAgentRunWsClientX25519SecretResolver;
  /**
   * Injectable factory for the underlying sealed client (test seam). Default = the real sealed client.
   * Constructed LAZILY per-call so this factory itself is side-effect-free.
   */
  readonly createClient?: CreateMissionSpineSealedClientFn;
  /**
   * (Organic mission→run binding PRODUCER — DARK, default-OFF) Optional auto-dispatch driver. When
   * PRESENT (bootstrap injects it only behind `FRIDAY_MISSION_AUTO_DISPATCH` + the route flag), a
   * SUCCESSFUL `intakeMission` invokes `onIntakeReady(request, result)` AFTER the dispatch returns
   * but BEFORE the result is handed back — firing a read-only bound agent-run for a fresh-ready
   * intake (async, non-blocking, fully error-isolated inside the driver). When ABSENT (the default)
   * `intakeMission` is BYTE-IDENTICAL to today: no hook, no auto-dispatch. NEVER awaited and NEVER
   * able to throw into the intake path (the driver isolates all errors), so an absent OR present
   * driver leaves the intake response unchanged.
   */
  readonly autoDispatchDriver?: FridayMissionAutoDispatchDriver;
}

function unavailable(message: string): FridayDomainError {
  return new FridayDomainError("MISSION_SPINE_DISPATCH_RUST_UNAVAILABLE", message, {
    httpStatus: 503,
    details: {
      surface: "service:mission_spine_dispatch_adapter",
      bridge: "rust_wired",
      proofOnly: true,
      proofReady: false,
    },
  });
}

/**
 * Build the mission-spine dispatch ADAPTER the bootstrap injects into `missionSpine.dispatch` when
 * `FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST` is on. SIDE-EFFECT-FREE: captures host/port/timeout +
 * resolver/createClient seams only; resolves no secret and opens no socket until a route actually
 * calls one of the three methods on a real request.
 */
export function createFridayMissionSpineDispatchAdapter(
  options: CreateFridayMissionSpineDispatchAdapterOptions,
): FridayMissionSpineDispatchService {
  const { host, port, timeoutMs } = options;
  const createClient = options.createClient ?? createFridayRustHubAgentRunSealedClient;
  const secretResolver = options.secretResolver;
  const autoDispatchDriver = options.autoDispatchDriver;

  /**
   * Resolve the X25519 secret + construct the underlying sealed client — shared by all three methods.
   * Fail-closed (503): a `null`/short resolve → no client; a constructor throw (non-32-byte secret) →
   * mapped to 503 so a malformed resolve surfaces as today's 503 rather than an unhandled throw.
   */
  function buildClient(): FridayRustHubAgentRunSealedClient {
    const clientSecret = secretResolver();
    if (!clientSecret) {
      throw unavailable("Mission-spine dispatch could not resolve the sealed-WS client secret.");
    }
    try {
      return createClient({
        ...(host !== undefined ? { host } : {}),
        port,
        clientSecret,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
    } catch {
      throw unavailable("Mission-spine dispatch could not construct the sealed-WS client.");
    }
  }

  return {
    async intakeMission(
      request: FridayRustHubMissionIntakeRequest,
    ): Promise<FridayRustHubMissionIntakeResult> {
      const client = buildClient();
      let result: FridayRustHubMissionIntakeResult;
      try {
        result = await client.intakeMission(request);
      } catch (error) {
        throw error instanceof FridayDomainError
          ? error
          : unavailable("Mission-spine intake dispatch failed.");
      }
      // (Organic mission→run binding PRODUCER — DARK) When the auto-dispatch driver is injected
      // (flag-ON only), fire the bound read-only run for a fresh-ready intake. The driver's
      // `onIntakeReady` is SYNCHRONOUS + void + fully error-isolated and does NOT await the run,
      // so the intake result returns immediately and the intake path is NEVER perturbed. When the
      // driver is absent (the default) this is a no-op ⇒ byte-identical to today.
      autoDispatchDriver?.onIntakeReady(request, result);
      return result;
    },

    async transitionMission(
      request: FridayRustHubMissionLifecycleRequest,
    ): Promise<FridayRustHubMissionLifecycleResult> {
      const client = buildClient();
      try {
        return await client.transitionMission(request);
      } catch (error) {
        throw error instanceof FridayDomainError
          ? error
          : unavailable("Mission-spine lifecycle dispatch failed.");
      }
    },

    async transitionWorkItem(
      request: FridayRustHubWorkItemStatusRequest,
    ): Promise<FridayRustHubWorkItemStatusResult> {
      const client = buildClient();
      try {
        return await client.transitionWorkItem(request);
      } catch (error) {
        throw error instanceof FridayDomainError
          ? error
          : unavailable("Mission-spine work-item dispatch failed.");
      }
    },

    async controlRouteDecision(
      request: FridayRustHubRouteDecisionControlRequest,
    ): Promise<FridayRustHubRouteDecisionControlResult> {
      const client = buildClient();
      try {
        return await client.controlRouteDecision(request);
      } catch (error) {
        throw error instanceof FridayDomainError
          ? error
          : unavailable("Mission-spine route-decision control dispatch failed.");
      }
    },
  };
}

/**
 * Parse the Rust agent-run WS port from a raw env string — REPLICATES `readRustAgentRunWsPort` in
 * friday-api-runtime.ts EXACTLY so the mission-spine adapter dials the SAME port as the agent-run
 * path: absent/blank/non-finite/negative ⇒ `0` (with the flag off this port is never dialed; 6b
 * provisions the real port via `FRIDAY_HUB_AGENT_RUN_WS_PORT`).
 */
export function readMissionSpineRustWsPort(raw: string | undefined): number {
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

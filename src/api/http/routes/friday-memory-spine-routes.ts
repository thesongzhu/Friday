import { FridayDomainError } from "#errors";
import { assertBoundPrincipalForOperation } from "../../../security/friday-owner-session-channel-capability.js";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayRustHubMemoryDecisionRequest,
  FridayRustHubMemoryDecisionResult,
} from "../../mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js";

/**
 * (Lane M) The memory-confirmation loop's TERMINAL driver: the `POST /v1/memory-spine/decide`
 * route that lets an authenticated OWNER confirm/reject ONE pending memory candidate, transitioning
 * it Candidate→Confirmed (recallable) or Candidate→Rejected (terminal) in the Rust Hub. This MIRRORS
 * the mission-spine dispatch routes exactly (`friday-mission-spine-routes.ts`): the handler validates
 * the body, refuses the synthetic public principal, then hands a typed request to a (flag-gated) Rust
 * sealed-WS dispatch service which seals + sends a `Message::MemoryDecisionRequest` and returns the
 * refs-only `MemoryDecisionResult`.
 *
 * ## DARK by default (503 until wired + flag-ON)
 * When this service is `null` (the DEFAULT — no adapter wired) the POST route is honest-unavailable
 * (503 `MEMORY_SPINE_DISPATCH_UNAVAILABLE`). PROVIDING it (an operator step in bootstrap) makes the
 * route LIVE — and live closure of the confirmation loop ALSO needs the SERVER flag
 * `FRIDAY_MEMORY_CONFIRM` (the merged Rust arm #753 is DEFAULT-OFF; a `MemoryDecisionRequest` is a
 * benign keepalive echo until it is flipped) plus `FRIDAY_RUN_LOOP_MEMORY_EXTRACTION` to produce
 * candidates to decide on. Registering this route with the service `null` is byte-additive to today.
 */
export interface FridayMemorySpineDispatchService {
  decideMemory(
    request: FridayRustHubMemoryDecisionRequest,
  ): Promise<FridayRustHubMemoryDecisionResult>;
}

export interface FridayMemorySpineRoutesDeps {
  /**
   * (Lane M) The organic memory-decision dispatcher, DEFAULT-OFF (`null`). `null` ⇒ the POST route
   * is honest-unavailable (503); a real adapter ⇒ it seals + dispatches over the sealed-WS client.
   * Registering the route with this `null` is byte-identical to today for existing traffic.
   */
  readonly dispatch?: FridayMemorySpineDispatchService | null;
  /** (Lane M) Optional reason for the dispatch-unavailable 503; falls back to a default message. */
  readonly dispatchDisabledReason?: string | null;
}

/** (Lane M) Response envelope for the memory-decision route — refs-only result passthrough. */
export interface FridayMemorySpineDecideResponse {
  readonly result: FridayRustHubMemoryDecisionResult;
}

const DEFAULT_DISPATCH_DISABLED_MESSAGE =
  "Memory Spine confirmation dispatch is unavailable in this runtime; the Rust Hub sealed-WS memory-decision seam has not been wired.";

const MEMORY_DECISION_SURFACE = "api:/v1/memory-spine/decide";
const VALID_DECISIONS = new Set(["confirm", "reject"]);

/** Throw a typed 400 for an invalid memory-decision body. Never echoes the raw body. */
function throwInvalidBody(failures: readonly string[]): never {
  throw new FridayDomainError(
    "MEMORY_SPINE_DECISION_REQUEST_INVALID",
    "Memory Spine confirmation request body did not satisfy the dispatch contract.",
    {
      httpStatus: 400,
      details: { surface: MEMORY_DECISION_SURFACE, failures },
    },
  );
}

function asBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** A required, trimmed, non-empty string field — or `undefined` (pushes a failure code). */
function readRequiredString(
  body: Record<string, unknown>,
  field: string,
  failures: string[],
): string | undefined {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    failures.push(`${field}_missing_or_empty`);
    return undefined;
  }
  return value.trim();
}

/**
 * (Lane M) Validate a memory-decision body into the typed request (or throw a typed 400). `memoryId`
 * + `ownerPrincipal` are required non-empty strings; `decision` is required AND must be exactly
 * `"confirm"` or `"reject"` (an extra-invariant enum check beyond presence — mirrors the
 * proof-on-completion check in the mission-spine work-item validator). The Rust side ALSO parses
 * `decision` fail-closed (an invalid token → `status:"blocked"`); this edge check is a fail-fast
 * convenience that rejects with a 400 (never a 500) BEFORE any send.
 */
export function validateMemoryDecisionBody(body: unknown): FridayRustHubMemoryDecisionRequest {
  const b = asBody(body);
  const failures: string[] = [];
  const memoryId = readRequiredString(b, "memoryId", failures);
  const ownerPrincipal = readRequiredString(b, "ownerPrincipal", failures);
  const decision = readRequiredString(b, "decision", failures);
  if (decision !== undefined && !VALID_DECISIONS.has(decision)) {
    failures.push("decision_not_confirm_or_reject");
  }
  if (
    failures.length > 0 ||
    memoryId === undefined ||
    ownerPrincipal === undefined ||
    decision === undefined
  ) {
    throwInvalidBody(failures);
  }
  return {
    memoryId,
    ownerPrincipal,
    decision: decision as "confirm" | "reject",
  };
}

export function createFridayMemorySpineRoutes(
  deps: FridayMemorySpineRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  // (Lane M) DEFAULT-OFF: `deps.dispatch` is null/undefined unless an adapter is wired, so the POST
  // route is honest-unavailable (503) by default — byte-additive to today (a new flag-OFF route
  // never alters any existing route's behavior).
  const dispatch = deps.dispatch ?? null;

  function dispatchDisabledMessage(): string {
    return deps.dispatchDisabledReason && deps.dispatchDisabledReason.trim().length > 0
      ? deps.dispatchDisabledReason
      : DEFAULT_DISPATCH_DISABLED_MESSAGE;
  }

  function throwDispatchDisabled(): never {
    throw new FridayDomainError(
      "MEMORY_SPINE_DISPATCH_UNAVAILABLE",
      dispatchDisabledMessage(),
      {
        httpStatus: 503,
        details: { surface: MEMORY_DECISION_SURFACE, dispatch: "rust_hub_unavailable", proofReady: false },
      },
    );
  }

  return [
    // (Lane M) ORGANIC MEMORY DECISION — POST. Guard order mirrors the mission-spine dispatch
    // routes exactly: (1) dispatch-disabled (flag-OFF) → 503 FIRST regardless of caller, so a
    // flag-OFF route is a uniform honest-unavailable; (2) bound-principal (refuse the synthetic
    // public principal) → 401; (3) body validation → 400; (4) seal + dispatch over the sealed-WS
    // client. Refs-only result passthrough (a `status:"blocked"` is the Hub's honest refusal).
    {
      operationId: "memory.spine.decide.apply",
      method: "POST",
      path: "/v1/memory-spine/decide",
      auth: { public: true },
      async handler(ctx): Promise<FridayMemorySpineDecideResponse> {
        if (!dispatch) {
          throwDispatchDisabled();
        }
        assertBoundPrincipalForOperation(ctx.principal ?? null, "memory.spine.decide", "api");
        const request = validateMemoryDecisionBody(ctx.body);
        const result = await dispatch.decideMemory(request);
        return { result };
      },
    },
  ];
}

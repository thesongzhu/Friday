import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayRealtimeAckRequest,
  FridayRealtimeAckResponse,
  FridayRealtimePullRequest,
  FridayRealtimePullResponse,
  FridayRealtimeSubscribeRequest,
  FridayRealtimeSubscribeResponse,
} from "../../model/friday-api-realtime.types.js";
import type { FridayRealtimeSubscriptionService } from "../../realtime/friday-realtime-subscription-service.js";
import { FridayDomainError } from "#errors";

/** Maximum value for realtime pull limit. */
const REALTIME_MAX_PULL_LIMIT = 200;

export interface FridayRealtimeRoutesDeps {
  subscriptionService: FridayRealtimeSubscriptionService;
  currentEpoch: number;
  /**
   * Test-oracle only: allow the legacy TypeScript realtime checkpoint-ack
   * mutation (POST /v1/realtime/ack) in isolated mock/unit validation.
   * Production/runtime callers must leave this unset so the ack surface
   * fail-closes until Rust owns the realtime delivery engine. The
   * subscribe/pull surfaces are pure reads and are never gated.
   */
  allowTestOnlyRealtimeExecution?: boolean;
}

// ─── Retirement helper ───
//
// POST /v1/realtime/ack advances/persists the realtime checkpoint cursor via
// withWriteTransaction (checkpointRepo.upsert). It fail-closes by default/live
// until Rust owns the realtime delivery entrypoint; legacy behavior is reachable
// only through the explicit allowTestOnlyRealtimeExecution test-oracle flag. The
// realtime.subscribe (in-memory RBAC validation) and realtime.pull (read via
// withReadConnection) surfaces are pure reads and stay compat_shim, NOT gated.

function assertRealtimeTestOracleAllowed(deps: FridayRealtimeRoutesDeps): void {
  if (deps.allowTestOnlyRealtimeExecution !== true) {
    throw new FridayDomainError(
      "TS_RUNTIME_REALTIME_RETIRED",
      "TypeScript realtime checkpoint-ack is fail-closed in default/live runtime; use the Rust-owned realtime delivery entrypoint.",
      {
        httpStatus: 503,
        details: {
          classification: "fail_closed",
          replacement: "rust_owned_realtime_delivery_entrypoint_required",
        },
      },
    );
  }
}

export function createFridayRealtimeRoutes(
  deps: FridayRealtimeRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "realtime.subscribe",
      method: "POST",
      path: "/v1/realtime/subscriptions",
      auth: { public: true },
      rateLimitPolicyId: "realtime.subscribe",
      async handler(ctx) {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || !Array.isArray(body.subscriptions)) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "subscriptions is required and must be an array",
            { httpStatus: 400 },
          );
        }
        const { subscriptions } = body as unknown as FridayRealtimeSubscribeRequest;
        const result = deps.subscriptionService.validateSubscriptions(
          subscriptions,
          ctx.principal!,
        );
        return {
          subscriptions: result.accepted,
          epoch: deps.currentEpoch,
        } satisfies FridayRealtimeSubscribeResponse;
      },
    },
    {
      operationId: "realtime.pull",
      method: "POST",
      path: "/v1/realtime/pull",
      auth: { public: true },
      rateLimitPolicyId: "realtime.pull",
      async handler(ctx) {
        const pullBody = ctx.body as Record<string, unknown> | null;
        if (!pullBody || typeof pullBody.streamId !== "string" || pullBody.streamId.trim() === "") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "streamId is required and must be a non-empty string",
            { httpStatus: 400 },
          );
        }
        const { streamId, afterSeq, limit, cursor } = pullBody as unknown as FridayRealtimePullRequest;

        // Verify stream authorization per principal
        if (!deps.subscriptionService.isStreamAuthorized(ctx.principal!, streamId)) {
          throw Object.assign(new Error(`Not authorized for stream '${streamId}'`), {
            code: "STREAM_NOT_AUTHORIZED",
            statusCode: 403,
          });
        }

        // Verify cursor HMAC if provided
        if (cursor && !deps.subscriptionService.verifyCursor(cursor, streamId, afterSeq ?? 0, deps.currentEpoch)) {
          throw Object.assign(new Error("Invalid cursor"), {
            code: "CURSOR_INVALID",
            statusCode: 400,
          });
        }

        const clampedLimit = Math.min(limit ?? 50, REALTIME_MAX_PULL_LIMIT);
        const events = deps.subscriptionService.pullEvents(
          streamId,
          afterSeq ?? 0,
          clampedLimit,
        );
        return {
          items: events,
          streamId,
          epoch: deps.currentEpoch,
        } satisfies FridayRealtimePullResponse;
      },
    },
    {
      operationId: "realtime.ack",
      method: "POST",
      path: "/v1/realtime/ack",
      auth: { public: true },
      async handler(ctx) {
        const ackBody = ctx.body as Record<string, unknown> | null;
        if (!ackBody || typeof ackBody.streamId !== "string" || ackBody.streamId.trim() === "") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "streamId is required and must be a non-empty string",
            { httpStatus: 400 },
          );
        }
        if (typeof ackBody.seq !== "number") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "seq is required and must be a number",
            { httpStatus: 400 },
          );
        }
        if (typeof ackBody.epoch !== "number") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "epoch is required and must be a number",
            { httpStatus: 400 },
          );
        }
        const { streamId, seq, epoch, cursor } = ackBody as unknown as FridayRealtimeAckRequest;

        // Verify stream authorization per principal
        if (!deps.subscriptionService.isStreamAuthorized(ctx.principal!, streamId)) {
          throw Object.assign(new Error(`Not authorized for stream '${streamId}'`), {
            code: "STREAM_NOT_AUTHORIZED",
            statusCode: 403,
          });
        }

        // Verify cursor HMAC if provided
        if (cursor && !deps.subscriptionService.verifyCursor(cursor, streamId, seq, epoch)) {
          throw Object.assign(new Error("Invalid cursor"), {
            code: "CURSOR_INVALID",
            statusCode: 400,
          });
        }

        assertRealtimeTestOracleAllowed(deps);
        const ackResult = deps.subscriptionService.ackEvent(
          ctx.principal!.principalId,
          streamId,
          seq,
          epoch,
          cursor,
        );
        if (!ackResult.accepted) {
          throw Object.assign(new Error("ACK_REJECTED"), {
            code: "ACK_REJECTED",
            statusCode: 409,
          });
        }
        return {
          accepted: true as const,
          streamId,
          seq,
        } satisfies FridayRealtimeAckResponse;
      },
    },
  ];
}

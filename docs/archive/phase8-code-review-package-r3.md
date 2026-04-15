> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Phase 8 Code Review Package — Round 3

## Test Results: 123 test files, 1187 tests, ALL PASSED

## R2 Fixes Applied:
1. HIGH (partial R1#7) — Seq allocation + append now in ONE atomic transaction in publish(). No more separate transactions.
2. HIGH (new) — HTTP ack route now uses ackEvent return value instead of hardcoding accepted:true

---

## `src/api/realtime/friday-realtime-event-bus.ts` (R2 FIX)
```ts
import type {
  FridayRealtimeEventName,
  FridayRealtimeEventPayloadMap,
  FridayRealtimeEventEnvelope,
} from "../model/friday-api-realtime.types.js";
import type {
  FridayRealtimeEventBus,
  FridayEventBusListener,
  CreateFridayRealtimeEventBusDeps,
} from "./friday-realtime-event-bus.types.js";

export function createFridayRealtimeEventBus(
  deps: CreateFridayRealtimeEventBusDeps,
): FridayRealtimeEventBus {
  const listeners = new Set<FridayEventBusListener>();
  // In-memory cache used only when DB is not available (tests without DB)
  const streamSeqs = new Map<string, number>();

  /**
   * Get next seq for a stream.
   * When DB + eventRepo are available, source from DB in a transaction (durable).
   * Otherwise fall back to in-memory counter.
   */
  function nextSeq(streamId: string): number {
    if (deps.db && deps.eventRepo) {
      // Durable path: query max seq from DB
      return deps.db.withWriteTransaction((db) => {
        return deps.eventRepo!.getNextSeq(db, streamId);
      });
    }
    // Fallback: process-local counter
    const current = streamSeqs.get(streamId) ?? 0;
    const next = current + 1;
    streamSeqs.set(streamId, next);
    return next;
  }

  function getSeq(streamId: string): number {
    if (deps.db && deps.eventRepo) {
      return deps.db.withReadConnection((db) => {
        return deps.eventRepo!.getLatestSeq(db, streamId);
      });
    }
    return streamSeqs.get(streamId) ?? 0;
  }

  return {
    publish<TEvent extends FridayRealtimeEventName>(
      streamId: string,
      event: TEvent,
      payload: FridayRealtimeEventPayloadMap[TEvent],
      correlationId?: string,
    ): FridayRealtimeEventEnvelope<TEvent> {
      let envelope: FridayRealtimeEventEnvelope<TEvent>;

      if (deps.db && deps.eventRepo) {
        // Durable path: allocate seq + persist in ONE atomic transaction
        envelope = deps.db.withWriteTransaction((db) => {
          const seq = deps.eventRepo!.getNextSeq(db, streamId);
          const env: FridayRealtimeEventEnvelope<TEvent> = {
            eventId: deps.idGenerator(),
            streamId,
            seq,
            event,
            payload,
            emittedAt: deps.nowIso(),
            correlationId,
          };
          deps.eventRepo!.append(db, env);
          return env;
        });
        streamSeqs.set(streamId, envelope.seq);
      } else {
        // Fallback: process-local counter (tests without DB)
        const seq = nextSeq(streamId);
        envelope = {
          eventId: deps.idGenerator(),
          streamId,
          seq,
          event,
          payload,
          emittedAt: deps.nowIso(),
          correlationId,
        };
        streamSeqs.set(streamId, seq);
        if (deps.persistEvent) {
          deps.persistEvent(envelope);
        }
      }

      // Notify all in-process listeners
      for (const listener of listeners) {
        try {
          listener(envelope);
        } catch {
          // Swallow listener errors to avoid breaking event flow
        }
      }

      return envelope;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getStreamSeq(streamId) {
      return getSeq(streamId);
    },
  };
}
```

## `src/api/http/routes/friday-realtime-routes.ts` (R2 FIX)
```ts
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayRealtimeSubscribeRequest,
  FridayRealtimeSubscribeResponse,
  FridayRealtimePullRequest,
  FridayRealtimePullResponse,
  FridayRealtimeAckRequest,
  FridayRealtimeAckResponse,
} from "../../model/friday-api-realtime.types.js";
import type { FridayRealtimeSubscriptionService } from "../../realtime/friday-realtime-subscription-service.js";

export interface FridayRealtimeRoutesDeps {
  subscriptionService: FridayRealtimeSubscriptionService;
  currentEpoch: number;
}

export function createFridayRealtimeRoutes(
  deps: FridayRealtimeRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "realtime.subscribe",
      method: "POST",
      path: "/v1/realtime/subscriptions",
      auth: { public: false, anyOfScopes: ["workflow.read", "fleet.read"] },
      rateLimitPolicyId: "realtime.subscribe",
      async handler(ctx) {
        const { subscriptions } = ctx.body as FridayRealtimeSubscribeRequest;
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
      auth: { public: false, anyOfScopes: ["workflow.read", "fleet.read"] },
      rateLimitPolicyId: "realtime.pull",
      async handler(ctx) {
        const { streamId, afterSeq, limit, cursor } = ctx.body as FridayRealtimePullRequest;

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

        const events = deps.subscriptionService.pullEvents(
          streamId,
          afterSeq ?? 0,
          limit ?? 50,
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
      auth: { public: false, anyOfScopes: ["workflow.read", "fleet.read"] },
      async handler(ctx) {
        const { streamId, seq, epoch, cursor } = ctx.body as FridayRealtimeAckRequest;

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

        const ackResult = deps.subscriptionService.ackEvent(
          ctx.principal!.principalId,
          streamId,
          seq,
          epoch,
          cursor,
        );
        return {
          accepted: ackResult.accepted,
          streamId,
          seq,
        } satisfies FridayRealtimeAckResponse;
      },
    },
  ];
}
```


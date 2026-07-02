import type {
  FridayRealtimeEventEnvelope,
  FridayRealtimeEventName,
  FridayRealtimeEventPayloadMap,
} from "../model/friday-api-realtime.types.js";
import type {
  CreateFridayRealtimeEventBusDeps,
  FridayEventBusListener,
  FridayRealtimeEventBus,
} from "./friday-realtime-event-bus.types.js";
import { redactEventPayload } from "./friday-event-payload-redactor.js";

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
      const redactedPayload = redactEventPayload(payload);

      if (deps.db && deps.eventRepo) {
        // Durable path: allocate seq + persist in ONE atomic transaction
        envelope = deps.db.withWriteTransaction((db) => {
          const seq = deps.eventRepo!.getNextSeq(db, streamId);
          const env: FridayRealtimeEventEnvelope<TEvent> = {
            eventId: deps.idGenerator(),
            streamId,
            seq,
            event,
            payload: redactedPayload,
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
          payload: redactedPayload,
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
        } catch (err) {
          console.warn("[friday][realtime-event-bus] operation failed:", err instanceof Error ? err.message : String(err));
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

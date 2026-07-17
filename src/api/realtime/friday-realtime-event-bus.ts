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
import { pseudonymizeEventIdentifiers, redactEventPayload } from "./friday-event-payload-redactor.js";

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
      // SEC-EVENT-REDACTION-001 / P0-A: pseudonymize at THIS sink (the unavoidable
      // boundary for every producer) BEFORE building the envelope, so the SAME
      // opaque envelope is used for both persistence and in-memory (WS) delivery --
      // no producer, including the Hub's direct eventBus.publish, can bypass it.
      const opaqueStreamId = deps.pseudonymizer
        ? deps.pseudonymizer.streamId(streamId)
        : streamId;
      // SEC-REALTIME-EVENT-PII-BY-VALUE / round-7 F1: the envelope `correlationId` is
      // an arbitrary caller-supplied identifier (e.g. `assistant-template:<templateId>`,
      // a runId, or free text) that was previously copied VERBATIM into the persisted
      // row (realtime_events.correlation_id) AND the delivered/WS envelope — a raw
      // identifier leak that bypassed the sink. Pseudonymize it here with the SAME
      // owner-scoped DETERMINISTIC key as the streamId id-part (`value`, not the
      // topic-preserving `streamId`, since a correlationId has no authz-bearing prefix).
      // Deterministic ⇒ the same raw correlationId maps to the same opaque, so
      // correlation semantics survive while nothing raw reaches rest or the wire. When
      // the pseudonymizer is fail-closed + inactive, `value()` THROWS (same fail-closed
      // guarantee as streamId) — the publish is refused rather than degraded to raw.
      const opaqueCorrelationId =
        correlationId !== undefined && deps.pseudonymizer
          ? deps.pseudonymizer.value(correlationId)
          : correlationId;
      const pseudonymizedPayload = deps.pseudonymizer
        ? pseudonymizeEventIdentifiers(payload, (raw) => deps.pseudonymizer!.value(raw))
        : payload;
      const redactedPayload = redactEventPayload(pseudonymizedPayload);

      if (deps.db && deps.eventRepo) {
        // Durable path: allocate seq + persist in ONE atomic transaction
        envelope = deps.db.withWriteTransaction((db) => {
          const seq = deps.eventRepo!.getNextSeq(db, opaqueStreamId);
          const env: FridayRealtimeEventEnvelope<TEvent> = {
            eventId: deps.idGenerator(),
            streamId: opaqueStreamId,
            seq,
            event,
            payload: redactedPayload,
            emittedAt: deps.nowIso(),
            correlationId: opaqueCorrelationId,
          };
          deps.eventRepo!.append(db, env);
          return env;
        });
        streamSeqs.set(opaqueStreamId, envelope.seq);
      } else {
        // Fallback: process-local counter (tests without DB). The real Hub always takes
        // the DB path, so this branch never fires in prod — but keep it CONSISTENT with the
        // durable path: use the OPAQUE streamId, redacted payload AND the opaque
        // correlationId (never the raw caller-supplied one), so no sink can differ by path.
        const seq = nextSeq(opaqueStreamId);
        envelope = {
          eventId: deps.idGenerator(),
          streamId: opaqueStreamId,
          seq,
          event,
          payload: redactedPayload,
          emittedAt: deps.nowIso(),
          correlationId: opaqueCorrelationId,
        };
        streamSeqs.set(opaqueStreamId, seq);
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

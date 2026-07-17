import type {
  FridayRealtimeEventEnvelope,
  FridayRealtimeEventName,
  FridayRealtimeEventPayloadMap,
} from "../model/friday-api-realtime.types.js";
import type { FridaySqliteLayer } from "#state";
import type { FridayRealtimeEventRepository } from "../persistence/friday-realtime-event-repository.js";
import type { FridayRealtimePseudonymizer } from "./friday-realtime-pseudonym.js";

export type FridayEventBusListener = (envelope: FridayRealtimeEventEnvelope) => void;

export interface FridayRealtimeEventBus {
  publish<TEvent extends FridayRealtimeEventName>(
    streamId: string,
    event: TEvent,
    payload: FridayRealtimeEventPayloadMap[TEvent],
    correlationId?: string,
  ): FridayRealtimeEventEnvelope<TEvent>;

  subscribe(listener: FridayEventBusListener): () => void;

  getStreamSeq(streamId: string): number;
}

export interface CreateFridayRealtimeEventBusDeps {
  idGenerator: () => string;
  nowIso: () => string;
  persistEvent?: (envelope: FridayRealtimeEventEnvelope) => void;
  /** When provided, seq numbers are sourced from the DB (durable). */
  db?: FridaySqliteLayer;
  eventRepo?: FridayRealtimeEventRepository;
  /**
   * SEC-EVENT-REDACTION-001 / P0-A -- identifier pseudonymizer applied at THIS
   * unavoidable sink: every producer (Hub direct `eventBus.publish`, the api-runtime
   * fallback publisher, self-healing, etc.) lands here, so pseudonymizing the
   * streamId + payload id fields in `publish()` BEFORE the envelope is built means
   * no producer can bypass it -- the envelope used for BOTH persistence and
   * in-memory listener (WS) delivery carries only the opaque form. Omitted
   * (legacy/test) -> identity, byte-identical to before.
   */
  pseudonymizer?: FridayRealtimePseudonymizer;
}

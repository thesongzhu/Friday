import type {
  FridayRealtimeEventEnvelope,
  FridayRealtimeEventName,
  FridayRealtimeEventPayloadMap,
} from "../model/friday-api-realtime.types.js";
import type { FridaySqliteLayer } from "#state";
import type { FridayRealtimeEventRepository } from "../persistence/friday-realtime-event-repository.js";

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
}

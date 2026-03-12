import type {
  FridayAgentEventMap,
  FridayAgentEventName,
} from "../model/friday-agent.types.js";

// ─── Listener type ───

export type FridayAgentEventListener<K extends FridayAgentEventName> = (
  payload: FridayAgentEventMap[K],
) => void;

// ─── Event emitter interface ───

export interface FridayAgentEventEmitter {
  on<K extends FridayAgentEventName>(event: K, listener: FridayAgentEventListener<K>): void;
  off<K extends FridayAgentEventName>(event: K, listener: FridayAgentEventListener<K>): void;
  emit<K extends FridayAgentEventName>(event: K, payload: FridayAgentEventMap[K]): void;
}

// ─── Factory ───

export function createFridayAgentEventEmitter(): FridayAgentEventEmitter {
  const listeners = new Map<string, Set<FridayAgentEventListener<FridayAgentEventName>>>();

  return {
    on<K extends FridayAgentEventName>(event: K, listener: FridayAgentEventListener<K>): void {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener as FridayAgentEventListener<FridayAgentEventName>);
    },

    off<K extends FridayAgentEventName>(event: K, listener: FridayAgentEventListener<K>): void {
      const set = listeners.get(event);
      if (set) {
        set.delete(listener as FridayAgentEventListener<FridayAgentEventName>);
        if (set.size === 0) {
          listeners.delete(event);
        }
      }
    },

    emit<K extends FridayAgentEventName>(event: K, payload: FridayAgentEventMap[K]): void {
      const set = listeners.get(event);
      if (!set) {
        return;
      }
      for (const listener of set) {
        try {
          listener(payload);
        } catch {
          // Swallow listener errors to prevent breaking the agent loop
        }
      }
    },
  };
}

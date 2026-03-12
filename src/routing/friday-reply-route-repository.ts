/**
 * Reply Route Repository — In-memory store for session route contexts.
 * Records where each session's inbound message originated so outbound
 * replies can be routed back correctly.
 *
 * @module routing/friday-reply-route-repository
 */

import type { FridayReplyRouteContext } from "./friday-reply-routing.types.js";

// ─── Interface ───

export interface FridayReplyRouteRepository {
  /** Store or update the route context for a session. */
  set(context: FridayReplyRouteContext): void;

  /** Retrieve the most recent route context for a session. */
  get(sessionKey: string): FridayReplyRouteContext | null;

  /** Remove route context for a session. */
  remove(sessionKey: string): boolean;

  /** List all stored route contexts. */
  listAll(): ReadonlyArray<FridayReplyRouteContext>;

  /** Number of stored contexts. */
  size(): number;

  /** Remove contexts older than a given cutoff ISO string. */
  pruneOlderThan(cutoff: string): number;
}

// ─── Factory ───

export function createFridayReplyRouteRepository(): FridayReplyRouteRepository {
  const store = new Map<string, FridayReplyRouteContext>();

  return {
    set(context: FridayReplyRouteContext): void {
      store.set(context.sessionKey, context);
    },

    get(sessionKey: string): FridayReplyRouteContext | null {
      return store.get(sessionKey) ?? null;
    },

    remove(sessionKey: string): boolean {
      return store.delete(sessionKey);
    },

    listAll(): ReadonlyArray<FridayReplyRouteContext> {
      return [...store.values()];
    },

    size(): number {
      return store.size;
    },

    pruneOlderThan(cutoff: string): number {
      const cutoffMs = new Date(cutoff).getTime();
      let pruned = 0;
      for (const [key, ctx] of store) {
        if (new Date(ctx.capturedAt).getTime() < cutoffMs) {
          store.delete(key);
          pruned++;
        }
      }
      return pruned;
    },
  };
}

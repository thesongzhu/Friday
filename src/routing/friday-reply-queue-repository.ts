/**
 * Reply Queue Repository — In-memory queue for undeliverable replies
 * awaiting retry. Supports batch leasing, status transitions, and
 * dead-letter expiry.
 *
 * @module routing/friday-reply-queue-repository
 */

import type { FridayQueuedReply } from "./friday-reply-routing.types.js";

// ─── Interface ───

export interface FridayReplyQueueRepository {
  /** Enqueue a new reply for later delivery. */
  enqueue(reply: FridayQueuedReply): void;

  /** Lease a batch of queued replies ready for retry. */
  leaseReady(now: string, limit: number): FridayQueuedReply[];

  /** Mark a queued reply as delivered. */
  markDelivered(id: string): boolean;

  /** Mark a queued reply as failed, incrementing attempts. */
  markFailed(id: string, error: string, nextRetryAt: string): boolean;

  /** Mark a queued reply as dead-letter. */
  markDeadLetter(id: string, error: string): boolean;

  /** Remove expired entries older than a cutoff. */
  removeExpired(cutoff: string): number;

  /** Get a single queued reply by ID. */
  get(id: string): FridayQueuedReply | null;

  /** Count entries by status. */
  countByStatus(status: FridayQueuedReply["status"]): number;

  /** Total queue size. */
  size(): number;
}

// ─── Factory ───

export function createFridayReplyQueueRepository(): FridayReplyQueueRepository {
  const store = new Map<string, FridayQueuedReply>();

  function update(id: string, patch: Partial<FridayQueuedReply>): boolean {
    const existing = store.get(id);
    if (!existing) return false;
    store.set(id, { ...existing, ...patch } as FridayQueuedReply);
    return true;
  }

  return {
    enqueue(reply: FridayQueuedReply): void {
      store.set(reply.id, reply);
    },

    leaseReady(now: string, limit: number): FridayQueuedReply[] {
      const nowMs = new Date(now).getTime();
      const results: FridayQueuedReply[] = [];
      for (const reply of store.values()) {
        if (results.length >= limit) break;
        if (reply.status === "queued" && new Date(reply.nextRetryAt).getTime() <= nowMs) {
          results.push(reply);
        }
      }
      return results;
    },

    markDelivered(id: string): boolean {
      return update(id, { status: "delivered" });
    },

    markFailed(id: string, error: string, nextRetryAt: string): boolean {
      const existing = store.get(id);
      if (!existing) return false;
      return update(id, {
        status: "queued",
        attempts: existing.attempts + 1,
        lastError: error,
        nextRetryAt,
      });
    },

    markDeadLetter(id: string, error: string): boolean {
      return update(id, { status: "dead_letter", lastError: error });
    },

    removeExpired(cutoff: string): number {
      const cutoffMs = new Date(cutoff).getTime();
      let removed = 0;
      for (const [id, reply] of store) {
        if (new Date(reply.createdAt).getTime() < cutoffMs && reply.status !== "delivered") {
          store.delete(id);
          removed++;
        }
      }
      return removed;
    },

    get(id: string): FridayQueuedReply | null {
      return store.get(id) ?? null;
    },

    countByStatus(status: FridayQueuedReply["status"]): number {
      let count = 0;
      for (const reply of store.values()) {
        if (reply.status === status) count++;
      }
      return count;
    },

    size(): number {
      return store.size;
    },
  };
}

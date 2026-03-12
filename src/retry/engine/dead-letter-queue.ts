/**
 * Dead Letter Queue — In-memory DLQ for items that exhausted all retries.
 *
 * When a retry sequence fails after all attempts (or is denied by budget /
 * policy), the item is placed in the dead letter queue for manual review.
 * Each DLQ entry captures the full failure context: classified failure,
 * last retry decision, cost summary, and correlation IDs.
 *
 * The DLQ is bounded: when the maximum size is reached, the oldest entries
 * are evicted (FIFO). Entries can be acknowledged (removed), requeued for
 * another retry attempt, or queried for inspection.
 *
 * @module retry/engine
 */

import type {
  FridayClassifiedFailure,
  FridayFailureCategory,
  FridayRetryCostDimensions,
  FridayRetryDecision,
} from "../model/friday-retry-engine.types.js";

import type { ISODateTime, UUID } from "../../rules/model/friday-rules-engine.types.js";

// ─── Types ───

/** A single entry in the dead letter queue. */
export interface DeadLetterEntry {
  /** Unique DLQ entry ID. */
  id: UUID;
  /** Parent workflow run ID. */
  runId: UUID;
  /** Parent workflow definition ID. */
  workflowId: UUID;
  /** Node ID within the workflow graph. */
  nodeId: string;
  /** Retry trace ID (if a trace was created). */
  traceId?: UUID;
  /** The classified failure that could not be resolved. */
  classifiedFailure: FridayClassifiedFailure;
  /** The last retry decision (which decided not to retry). */
  lastDecision: FridayRetryDecision;
  /** Total retry attempts made before DLQ admission. */
  totalAttempts: number;
  /** Total cost consumed before DLQ admission. */
  totalCost: FridayRetryCostDimensions;
  /** Reason the item was sent to the DLQ. */
  reason: string;
  /** When the item was added to the DLQ. */
  enqueuedAt: ISODateTime;
  /** Whether the item has been acknowledged by an operator. */
  acknowledged: boolean;
  /** When the item was acknowledged (if applicable). */
  acknowledgedAt?: ISODateTime;
  /** Acknowledgement note from the operator. */
  acknowledgeNote?: string;
}

/** Configuration for the dead letter queue. */
export interface DeadLetterQueueConfig {
  /** Maximum number of entries in the DLQ. Oldest entries are evicted when full. Default: 1000. */
  maxSize: number;
  /** Generate a new UUID. */
  generateId: () => UUID;
  /** Get current ISO timestamp. */
  nowIso: () => ISODateTime;
}

/** Parameters to enqueue a new DLQ entry. */
export interface EnqueueParams {
  runId: UUID;
  workflowId: UUID;
  nodeId: string;
  traceId?: UUID;
  classifiedFailure: FridayClassifiedFailure;
  lastDecision: FridayRetryDecision;
  totalAttempts: number;
  totalCost: FridayRetryCostDimensions;
  reason: string;
}

/** Filter criteria for querying DLQ entries. */
export interface DeadLetterQueryFilter {
  /** Filter by workflow run ID. */
  runId?: UUID;
  /** Filter by workflow definition ID. */
  workflowId?: UUID;
  /** Filter by node ID. */
  nodeId?: string;
  /** Filter by failure category. */
  failureCategory?: FridayFailureCategory;
  /** Filter by acknowledgement status. */
  acknowledged?: boolean;
}

// ─── Default Configuration ───

/** Default maximum DLQ size. */
export const DEFAULT_DLQ_MAX_SIZE = 1000;

// ─── Dead Letter Queue Implementation ───

/**
 * Creates an in-memory dead letter queue.
 *
 * @param config - DLQ configuration.
 * @returns A DLQ instance with enqueue, acknowledge, query, and management methods.
 */
export function createDeadLetterQueue(config: DeadLetterQueueConfig) {
  const entries: DeadLetterEntry[] = [];

  /**
   * Add a failed item to the dead letter queue.
   *
   * If the queue is at capacity, the oldest unacknowledged entry is evicted.
   * If all entries are acknowledged, the oldest acknowledged entry is evicted.
   *
   * @param params - DLQ entry parameters.
   * @returns The created DLQ entry.
   */
  function enqueue(params: EnqueueParams): DeadLetterEntry {
    // Evict if at capacity.
    if (entries.length >= config.maxSize) {
      // Prefer evicting oldest unacknowledged, then oldest acknowledged.
      const unackIdx = entries.findIndex((e) => !e.acknowledged);
      const evictIdx = unackIdx !== -1 ? unackIdx : 0;
      entries.splice(evictIdx, 1);
    }

    const entry: DeadLetterEntry = {
      id: config.generateId(),
      runId: params.runId,
      workflowId: params.workflowId,
      nodeId: params.nodeId,
      traceId: params.traceId,
      classifiedFailure: params.classifiedFailure,
      lastDecision: params.lastDecision,
      totalAttempts: params.totalAttempts,
      totalCost: params.totalCost,
      reason: params.reason,
      enqueuedAt: config.nowIso(),
      acknowledged: false,
    };

    entries.push(entry);
    return entry;
  }

  /**
   * Acknowledge a DLQ entry, marking it as reviewed.
   *
   * @param entryId - DLQ entry ID.
   * @param note - Optional acknowledgement note.
   * @returns The updated entry, or undefined if not found.
   */
  function acknowledge(entryId: UUID, note?: string): DeadLetterEntry | undefined {
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) return undefined;

    entry.acknowledged = true;
    entry.acknowledgedAt = config.nowIso();
    entry.acknowledgeNote = note;
    return entry;
  }

  /**
   * Remove a DLQ entry entirely.
   *
   * @param entryId - DLQ entry ID.
   * @returns True if the entry was found and removed.
   */
  function remove(entryId: UUID): boolean {
    const idx = entries.findIndex((e) => e.id === entryId);
    if (idx === -1) return false;
    entries.splice(idx, 1);
    return true;
  }

  /**
   * Get a single DLQ entry by ID.
   */
  function get(entryId: UUID): DeadLetterEntry | undefined {
    return entries.find((e) => e.id === entryId);
  }

  /**
   * Query DLQ entries with optional filters.
   *
   * @param filter - Query filter criteria.
   * @returns Matching DLQ entries (newest first).
   */
  function query(filter: DeadLetterQueryFilter = {}): readonly DeadLetterEntry[] {
    let result: DeadLetterEntry[] = [...entries];

    if (filter.runId !== undefined) {
      result = result.filter((e) => e.runId === filter.runId);
    }
    if (filter.workflowId !== undefined) {
      result = result.filter((e) => e.workflowId === filter.workflowId);
    }
    if (filter.nodeId !== undefined) {
      result = result.filter((e) => e.nodeId === filter.nodeId);
    }
    if (filter.failureCategory !== undefined) {
      result = result.filter(
        (e) => e.classifiedFailure.category === filter.failureCategory,
      );
    }
    if (filter.acknowledged !== undefined) {
      result = result.filter((e) => e.acknowledged === filter.acknowledged);
    }

    // Newest first.
    return result.reverse();
  }

  /**
   * Get the current queue size.
   */
  function size(): number {
    return entries.length;
  }

  /**
   * Get count of unacknowledged entries.
   */
  function pendingCount(): number {
    return entries.filter((e) => !e.acknowledged).length;
  }

  /**
   * Clear all entries from the DLQ.
   */
  function clear(): void {
    entries.length = 0;
  }

  return {
    enqueue,
    acknowledge,
    remove,
    get,
    query,
    size,
    pendingCount,
    clear,
  };
}

/** Type of the DLQ returned by {@link createDeadLetterQueue}. */
export type DeadLetterQueueInstance = ReturnType<typeof createDeadLetterQueue>;

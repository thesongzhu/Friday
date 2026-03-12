/**
 * Reply Queue Drain Job — Periodically drains the retry queue, attempting
 * to deliver queued replies with exponential backoff. Moves exhausted
 * entries to dead-letter.
 *
 * @module routing/friday-reply-queue-job
 */

import type {
  FridayReplyDeliveryResult,
  FridayReplyRoutingConfig,
} from "./friday-reply-routing.types.js";
import { DEFAULT_REPLY_ROUTING_CONFIG } from "./friday-reply-routing.types.js";
import type { FridayReplyQueueRepository } from "./friday-reply-queue-repository.js";

// ─── Result ───

export interface FridayReplyQueueDrainResult {
  readonly attempted: number;
  readonly delivered: number;
  readonly failed: number;
  readonly deadLettered: number;
  readonly expired: number;
  readonly errors: string[];
}

// ─── Deps ───

export interface FridayReplyQueueJobDeps {
  readonly queueRepo: FridayReplyQueueRepository;
  readonly config?: FridayReplyRoutingConfig;
  readonly nowIso: () => string;

  /** Attempt to deliver a queued reply. */
  readonly deliver: (input: {
    channelKind: string;
    channelId: string;
    chatId: string;
    threadId?: string;
    replyToMessageId?: string;
    text: string;
  }) => Promise<FridayReplyDeliveryResult>;
}

// ─── Interface ───

export interface FridayReplyQueueJob {
  runOnce(): Promise<FridayReplyQueueDrainResult>;
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

// ─── Factory ───

export function createFridayReplyQueueJob(
  deps: FridayReplyQueueJobDeps,
): FridayReplyQueueJob {
  const config = deps.config ?? DEFAULT_REPLY_ROUTING_CONFIG;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  function computeNextRetry(attempts: number): string {
    const delayMs = config.retryBaseDelayMs * Math.pow(2, attempts);
    return new Date(new Date(deps.nowIso()).getTime() + delayMs).toISOString();
  }

  async function runCycle(): Promise<void> {
    if (!running) return;
    try {
      await job.runOnce();
    } catch {
      // continue
    }
    if (running) {
      const jitter = Math.floor(Math.random() * config.drainJitterMs);
      timer = setTimeout(() => void runCycle(), config.drainIntervalMs + jitter);
    }
  }

  const job: FridayReplyQueueJob = {
    async runOnce() {
      const result: {
        attempted: number;
        delivered: number;
        failed: number;
        deadLettered: number;
        expired: number;
        errors: string[];
      } = { attempted: 0, delivered: 0, failed: 0, deadLettered: 0, expired: 0, errors: [] };

      const now = deps.nowIso();

      // Phase 1: Drain ready entries
      const batch = deps.queueRepo.leaseReady(now, config.drainBatchSize);

      for (const entry of batch) {
        result.attempted++;

        try {
          const deliveryResult = await deps.deliver({
            channelKind: entry.channelKind,
            channelId: entry.channelId,
            chatId: entry.chatId,
            threadId: entry.threadId,
            replyToMessageId: entry.replyToMessageId,
            text: entry.text,
          });

          if (deliveryResult.ok) {
            deps.queueRepo.markDelivered(entry.id);
            result.delivered++;
          } else if (entry.attempts + 1 >= entry.maxAttempts) {
            deps.queueRepo.markDeadLetter(entry.id, deliveryResult.error);
            result.deadLettered++;
          } else {
            const nextRetry = computeNextRetry(entry.attempts + 1);
            deps.queueRepo.markFailed(entry.id, deliveryResult.error, nextRetry);
            result.failed++;
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          if (entry.attempts + 1 >= entry.maxAttempts) {
            deps.queueRepo.markDeadLetter(entry.id, errorMsg);
            result.deadLettered++;
          } else {
            const nextRetry = computeNextRetry(entry.attempts + 1);
            deps.queueRepo.markFailed(entry.id, errorMsg, nextRetry);
            result.failed++;
          }
          result.errors.push(`Failed to deliver ${entry.id}: ${errorMsg}`);
        }
      }

      // Phase 2: Expire old entries
      const expiryCutoff = new Date(
        new Date(now).getTime() - config.queueMaxAgeMs,
      ).toISOString();
      result.expired = deps.queueRepo.removeExpired(expiryCutoff);

      return result;
    },

    start() {
      if (running) return;
      running = true;
      timer = setTimeout(() => void runCycle(), 1000);
    },

    stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },

    isRunning() {
      return running;
    },
  };

  return job;
}

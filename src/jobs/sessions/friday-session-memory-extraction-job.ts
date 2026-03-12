import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import { computeFridayBackoff } from "#utilities";

import {
  createFridaySessionMemoryExtractionRepository,
  FRIDAY_SESSION_MEMORY_EXTRACTION_RETRY_BASE_DELAY_MS,
  FRIDAY_SESSION_MEMORY_EXTRACTION_WORKER_CLAIM_LIMIT,
} from "#sessions";
import type { FridaySessionMemoryExtractionService } from "#sessions";
import type { FridaySessionMemoryExtractionWorkerResult } from "./friday-session-memory-extraction-job.types.js";

// ─── Interface ───

export interface FridaySessionMemoryExtractionWorkerJob {
  run(): Promise<FridaySessionMemoryExtractionWorkerResult>;
}

// ─── Deps ───

export interface CreateFridaySessionMemoryExtractionWorkerJobDeps {
  db: FridaySqliteLayer;
  extractionService: FridaySessionMemoryExtractionService;
  nowIso: () => string;
}

// ─── Factory ───

export function createFridaySessionMemoryExtractionWorkerJob(
  deps: CreateFridaySessionMemoryExtractionWorkerJobDeps,
): FridaySessionMemoryExtractionWorkerJob {
  const extractionRepo = createFridaySessionMemoryExtractionRepository();

  return {
    async run() {
      const now = deps.nowIso();
      const result: FridaySessionMemoryExtractionWorkerResult = {
        processedJobs: 0,
        completedJobs: 0,
        failedJobs: 0,
        results: [],
      };

      // Claim queued jobs
      const jobs = deps.db.withWriteTransaction((db) => {
        const claimed = extractionRepo.claimQueuedJobs(db, {
          limit: FRIDAY_SESSION_MEMORY_EXTRACTION_WORKER_CLAIM_LIMIT,
          nowIso: now,
        });

        // Mark them all as running
        const running = [];
        for (const job of claimed) {
          const updated = extractionRepo.markRunning(db, { id: job.id, nowIso: now });
          if (updated) {
            running.push(updated);
          }
        }
        return running;
      });

      for (const job of jobs) {
        result.processedJobs++;

        try {
          // Determine messages to process
          let extractResult;
          if (job.requestedMessageIds && job.requestedMessageIds.length > 0) {
            extractResult = await deps.extractionService.extractSpecificMessages(
              job.sessionKey,
              job.requestedMessageIds,
              { mode: "inline" },
            );
          } else {
            extractResult = await deps.extractionService.extractFromSession(
              job.sessionKey,
              {
                trigger: job.trigger,
                mode: "inline",
                batchSize: job.batchSize,
                maxBatches: job.maxBatches,
              },
            );
          }

          // Mark job completed
          deps.db.withWriteTransaction((db) =>
            extractionRepo.markCompleted(db, {
              id: job.id,
              resultJson: JSON.stringify(extractResult),
              nowIso: deps.nowIso(),
            }),
          );

          result.completedJobs++;
          result.results.push({ ...extractResult, jobId: job.id });
        } catch (error) {
          // Mark job failed
          const errorCode = error instanceof FridayDomainError
            ? error.code
            : "UNKNOWN_ERROR";
          const errorMessage = error instanceof Error
            ? error.message
            : "Unknown error";

          // Calculate next attempt time with exponential backoff (shared utility)
          let nextAttemptAt: string | undefined;
          if (job.attempts < job.maxAttempts) {
            const delayMs = computeFridayBackoff(job.attempts, {
              baseMs: FRIDAY_SESSION_MEMORY_EXTRACTION_RETRY_BASE_DELAY_MS,
            });
            nextAttemptAt = new Date(
              new Date(deps.nowIso()).getTime() + delayMs,
            ).toISOString();
          }

          deps.db.withWriteTransaction((db) => {
            extractionRepo.markFailed(db, {
              id: job.id,
              errorCode,
              errorMessage,
              nextAttemptAt,
              nowIso: deps.nowIso(),
            });

            // Re-queue for retry if attempts remain
            if (nextAttemptAt && job.attempts < job.maxAttempts) {
              db.prepare(
                `UPDATE session_memory_extraction_jobs
                 SET status = 'queued', next_attempt_at = ?, updated_at = ?
                 WHERE id = ?`,
              ).run(nextAttemptAt, deps.nowIso(), job.id);
            }
          });

          result.failedJobs++;
        }
      }

      return result;
    },
  };
}

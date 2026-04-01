import { FridayDomainError } from "#errors";
import { safeJsonParse } from "#utilities";

import {
  FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_BATCH_SIZE,
  FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_JOB_MAX_ATTEMPTS,
  FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_MAX_BATCHES,
  FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_MAX_ITEMS_PER_BATCH,
  FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES,
  FRIDAY_SESSION_MEMORY_EXTRACTION_MAX_BATCH_SIZE,
  FRIDAY_SESSION_MEMORY_EXTRACTION_MIN_BATCH_SIZE,
  FRIDAY_SESSION_MEMORY_EXTRACTION_TAG_AUTO,
  FRIDAY_SESSION_MEMORY_EXTRACTION_TAG_MANUAL,
  FRIDAY_SESSION_MEMORY_EXTRACTION_TAG_PREFIX_KIND,
} from "../friday-session-memory-extraction.constants.js";
import type {
  FridaySessionMemoryExtractionRunResult,
  FridaySessionMemoryExtractionStatus,
  FridaySessionMemoryExtractionTrigger,
  FridaySessionMemoryRetryResult,
} from "../model/friday-session-memory-extraction.types.js";
import type { FridaySessionMessageRecord } from "../model/friday-session.types.js";
import { createFridaySessionMemoryExtractionRepository } from "../persistence/friday-session-memory-extraction-repository.js";
import { buildFridaySessionMemorySource } from "./friday-session-memory-namespace.js";
import { createFridaySessionMemoryExtractionLlmClient } from "./friday-session-memory-extraction-llm-client.js";
import type {
  CreateFridaySessionMemoryExtractionServiceDeps,
  FridaySessionMemoryExtractionService,
} from "./friday-session-memory-extraction-service.types.js";

// ─── Factory ───

export function createFridaySessionMemoryExtractionService(
  deps: CreateFridaySessionMemoryExtractionServiceDeps,
): FridaySessionMemoryExtractionService {
  const extractionRepo = createFridaySessionMemoryExtractionRepository();
  const llmClient = createFridaySessionMemoryExtractionLlmClient({
    providerService: deps.providerService,
  });

  // ─── Internal helpers ───

  function fetchPendingMessages(sessionKey: string, limit: number): FridaySessionMessageRecord[] {
    return deps.db.withReadConnection((db) => {
      const rows = db.prepare(
        `SELECT * FROM session_messages
         WHERE session_key = ? AND memory_extract_status = 'pending' AND is_inherited = 0
         ORDER BY occurred_at ASC
         LIMIT ?`,
      ).all(sessionKey, limit) as Array<Record<string, unknown>>;

      return rows.map(mapMessageRow);
    });
  }

  function fetchFailedMessages(sessionKey: string, limit: number): FridaySessionMessageRecord[] {
    return deps.db.withReadConnection((db) => {
      const rows = db.prepare(
        `SELECT * FROM session_messages
         WHERE session_key = ? AND memory_extract_status = 'failed' AND is_inherited = 0
         ORDER BY occurred_at ASC
         LIMIT ?`,
      ).all(sessionKey, limit) as Array<Record<string, unknown>>;

      return rows.map(mapMessageRow);
    });
  }

  function fetchMessagesByIds(sessionKey: string, messageIds: string[]): FridaySessionMessageRecord[] {
    if (messageIds.length === 0) return [];

    return deps.db.withReadConnection((db) => {
      const placeholders = messageIds.map(() => "?").join(", ");
      const rows = db.prepare(
        `SELECT * FROM session_messages
         WHERE session_key = ? AND id IN (${placeholders})
         ORDER BY occurred_at ASC`,
      ).all(sessionKey, ...messageIds) as Array<Record<string, unknown>>;

      return rows.map(mapMessageRow);
    });
  }

  function mapMessageRow(row: Record<string, unknown>): FridaySessionMessageRecord {
    return {
      id: row["id"] as string,
      sessionId: row["session_id"] as string,
      sessionKey: (row["session_key"] as string | null) ?? "",
      sequence: row["sequence"] as number,
      role: row["role"] as FridaySessionMessageRecord["role"],
      content: safeJsonParse(row["content_json"] as string) as unknown,
      contentText: (row["content_text"] as string | null) ?? "",
      toolCalls: row["tool_calls_json"]
        ? (safeJsonParse(row["tool_calls_json"] as string) as unknown[])
        : undefined,
      tokenCount: row["token_count"] as number,
      idempotencyKey: (row["idempotency_key"] as string | null) ?? undefined,
      parentMessageId: (row["parent_message_id"] as string | null) ?? undefined,
      metadata: row["metadata_json"]
        ? (safeJsonParse(row["metadata_json"] as string) as Record<string, unknown>)
        : {},
      memoryExtractStatus: row["memory_extract_status"] as FridaySessionMessageRecord["memoryExtractStatus"],
      memoryExtractedAt: (row["memory_extracted_at"] as string | null) ?? undefined,
      occurredAt: (row["occurred_at"] as string | null) ?? (row["created_at"] as string),
      createdAt: row["created_at"] as string,
      updatedAt: row["updated_at"] as string,
    };
  }

  function updateMessageExtractStatus(
    messageIds: string[],
    status: "extracted" | "skipped" | "failed",
    nowIso: string,
  ): void {
    if (messageIds.length === 0) return;

    deps.db.withWriteTransaction((db) => {
      const placeholders = messageIds.map(() => "?").join(", ");
      const extractedAt = status === "extracted" ? nowIso : null;
      db.prepare(
        `UPDATE session_messages
         SET memory_extract_status = ?,
             memory_extracted_at = ?,
             updated_at = ?
         WHERE id IN (${placeholders})`,
      ).run(status, extractedAt, nowIso, ...messageIds);
    });
  }

  function countMessagesByExtractStatus(
    sessionKey: string,
  ): { pending: number; extracted: number; skipped: number; failed: number } {
    return deps.db.withReadConnection((db) => {
      const rows = db.prepare(
        `SELECT memory_extract_status AS status, COUNT(*) AS cnt
         FROM session_messages
         WHERE session_key = ?
         GROUP BY memory_extract_status`,
      ).all(sessionKey) as Array<{ status: string; cnt: number }>;

      const counts = { pending: 0, extracted: 0, skipped: 0, failed: 0 };
      for (const row of rows) {
        const key = row.status as keyof typeof counts;
        if (key in counts) {
          counts[key] = row.cnt;
        }
      }
      return counts;
    });
  }

  async function processInline(
    sessionKey: string,
    trigger: FridaySessionMemoryExtractionTrigger,
    messages: FridaySessionMessageRecord[],
    options?: { jobId?: string; batchSize?: number; maxBatches?: number },
  ): Promise<FridaySessionMemoryExtractionRunResult> {
    const result: FridaySessionMemoryExtractionRunResult = {
      jobId: options?.jobId,
      sessionKey,
      trigger,
      mode: "inline",
      queued: false,
      processedMessageCount: 0,
      extractedMessageCount: 0,
      skippedMessageCount: 0,
      failedMessageCount: 0,
      memoryItemsCreated: 0,
    };

    if (messages.length === 0) {
      return result;
    }

    // Resolve namespace
    const namespace = await deps.sessionService.getSessionMemoryNamespace(sessionKey);
    const session = await deps.sessionService.getSession(sessionKey);
    if (!session) {
      throw new FridayDomainError(
        FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.SESSION_NOT_FOUND,
        `Session '${sessionKey}' not found`,
        { httpStatus: 404 },
      );
    }

    const source = buildFridaySessionMemorySource(sessionKey);
    const sourceTag = trigger === "manual"
      ? FRIDAY_SESSION_MEMORY_EXTRACTION_TAG_MANUAL
      : FRIDAY_SESSION_MEMORY_EXTRACTION_TAG_AUTO;

    // Process in batches — honour caller-supplied sizes, clamped to safe range
    const batchSize = Math.max(
      FRIDAY_SESSION_MEMORY_EXTRACTION_MIN_BATCH_SIZE,
      Math.min(
        options?.batchSize ?? FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_BATCH_SIZE,
        FRIDAY_SESSION_MEMORY_EXTRACTION_MAX_BATCH_SIZE,
      ),
    );
    const maxBatches = options?.maxBatches ?? FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_MAX_BATCHES;
    let batchCount = 0;

    for (let offset = 0; offset < messages.length && batchCount < maxBatches; offset += batchSize) {
      batchCount++;
      const batch = messages.slice(offset, offset + batchSize);
      result.processedMessageCount += batch.length;

      try {
        const llmResponse = await llmClient.extractMemoryItems(
          batch,
          FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_MAX_ITEMS_PER_BATCH,
          {
            hubId: session.accountId,
            channelKind: session.channel,
            ...(session.userId ? { userId: session.userId } : {}),
          },
        );

        if (llmResponse.items.length === 0) {
          // No items — mark all as skipped
          updateMessageExtractStatus(
            batch.map((m) => m.id),
            "skipped",
            deps.nowIso(),
          );
          result.skippedMessageCount += batch.length;
          continue;
        }

        // Collect which message IDs were referenced by items
        const referencedIds = new Set<string>();
        for (const item of llmResponse.items) {
          for (const id of item.sourceMessageIds) {
            referencedIds.add(id);
          }
        }

        // Store memory items
        for (const item of llmResponse.items) {
          const tags = [
            sourceTag,
            `session:${sessionKey}`,
            `channel:${session.channel}`,
            `chat_kind:${session.chatKind}`,
            `${FRIDAY_SESSION_MEMORY_EXTRACTION_TAG_PREFIX_KIND}:${item.kind}`,
            ...(item.tags ?? []),
          ];

          const metadata: Record<string, unknown> = {
            sessionKey,
            messageIds: item.sourceMessageIds,
            trigger,
            jobId: options?.jobId,
            accountId: session.accountId,
            chatId: session.chatId,
            extractedAt: deps.nowIso(),
          };

          await deps.memoryService.store(namespace, item.content, {
            source,
            tags,
            metadata,
          });
          result.memoryItemsCreated++;
        }

        // Mark referenced messages as extracted, others as skipped
        const now = deps.nowIso();
        const batchIds = batch.map((m) => m.id);
        const extractedIds = batchIds.filter((id) => referencedIds.has(id));
        const skippedIds = batchIds.filter((id) => !referencedIds.has(id));

        updateMessageExtractStatus(extractedIds, "extracted", now);
        updateMessageExtractStatus(skippedIds, "skipped", now);

        result.extractedMessageCount += extractedIds.length;
        result.skippedMessageCount += skippedIds.length;
      } catch (error) {
        // Batch failed — mark all as failed
        updateMessageExtractStatus(
          batch.map((m) => m.id),
          "failed",
          deps.nowIso(),
        );
        result.failedMessageCount += batch.length;

        // Re-throw if it's a provider error (for job-level failure tracking)
        if (error instanceof FridayDomainError) {
          throw error;
        }

        throw new FridayDomainError(
          FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.PROVIDER_ERROR,
          error instanceof Error ? error.message : "Unknown extraction error",
          { httpStatus: 502, retryable: true, cause: error },
        );
      }
    }

    return result;
  }

  // ─── Service implementation ───

  return {
    async extractFromSession(sessionKey, options) {
      const session = await deps.sessionService.getSession(sessionKey);
      if (!session) {
        throw new FridayDomainError(
          FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.SESSION_NOT_FOUND,
          `Session '${sessionKey}' not found`,
          { httpStatus: 404 },
        );
      }

      const trigger = options?.trigger ?? "auto";
      const effectiveMode = options?.mode ?? (trigger === "auto" ? "queue" : "inline");
      const batchSize = Math.max(
        FRIDAY_SESSION_MEMORY_EXTRACTION_MIN_BATCH_SIZE,
        Math.min(
          options?.batchSize ?? FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_BATCH_SIZE,
          FRIDAY_SESSION_MEMORY_EXTRACTION_MAX_BATCH_SIZE,
        ),
      );
      const maxBatches = options?.maxBatches ?? FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_MAX_BATCHES;

      if (effectiveMode === "queue") {
        // Dedupe: check for open auto job
        if (trigger === "auto") {
          const hasOpen = deps.db.withReadConnection((db) =>
            extractionRepo.hasOpenAutoJob(db, sessionKey),
          );
          if (hasOpen) {
            return {
              sessionKey,
              trigger,
              mode: "queued",
              queued: false,
              processedMessageCount: 0,
              extractedMessageCount: 0,
              skippedMessageCount: 0,
              failedMessageCount: 0,
              memoryItemsCreated: 0,
            };
          }
        }

        const jobId = deps.idGenerator();
        const now = deps.nowIso();

        try {
          const job = deps.db.withWriteTransaction((db) =>
            extractionRepo.insert(db, {
              id: jobId,
              sessionKey,
              trigger,
              batchSize,
              maxBatches,
              maxAttempts: FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_JOB_MAX_ATTEMPTS,
              nowIso: now,
            }),
          );

          return {
            jobId: job.id,
            sessionKey,
            trigger,
            mode: "queued",
            queued: true,
            processedMessageCount: 0,
            extractedMessageCount: 0,
            skippedMessageCount: 0,
            failedMessageCount: 0,
            memoryItemsCreated: 0,
          };
        } catch (error) {
          // Unique constraint violation for auto dedupe
          if (
            error instanceof Error &&
            error.message.includes("UNIQUE constraint failed")
          ) {
            return {
              sessionKey,
              trigger,
              mode: "queued",
              queued: false,
              processedMessageCount: 0,
              extractedMessageCount: 0,
              skippedMessageCount: 0,
              failedMessageCount: 0,
              memoryItemsCreated: 0,
            };
          }
          throw error;
        }
      }

      // Inline mode
      const messages = trigger === "retry"
        ? fetchFailedMessages(sessionKey, batchSize * maxBatches)
        : fetchPendingMessages(sessionKey, batchSize * maxBatches);

      return processInline(sessionKey, trigger, messages, { batchSize, maxBatches });
    },

    async extractSpecificMessages(sessionKey, messageIds, options) {
      if (!messageIds.length) {
        throw new FridayDomainError(
          FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.INVALID_INPUT,
          "messageIds must not be empty",
          { httpStatus: 400 },
        );
      }

      const session = await deps.sessionService.getSession(sessionKey);
      if (!session) {
        throw new FridayDomainError(
          FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.SESSION_NOT_FOUND,
          `Session '${sessionKey}' not found`,
          { httpStatus: 404 },
        );
      }

      const effectiveMode = options?.mode ?? "inline";

      if (effectiveMode === "queue") {
        const jobId = deps.idGenerator();
        const now = deps.nowIso();

        const job = deps.db.withWriteTransaction((db) =>
          extractionRepo.insert(db, {
            id: jobId,
            sessionKey,
            trigger: "manual",
            requestedMessageIds: messageIds,
            batchSize: messageIds.length,
            maxBatches: 1,
            maxAttempts: FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_JOB_MAX_ATTEMPTS,
            nowIso: now,
          }),
        );

        return {
          jobId: job.id,
          sessionKey,
          trigger: "manual" as const,
          mode: "queued" as const,
          queued: true,
          processedMessageCount: 0,
          extractedMessageCount: 0,
          skippedMessageCount: 0,
          failedMessageCount: 0,
          memoryItemsCreated: 0,
        };
      }

      // Inline: fetch and validate messages belong to session
      const messages = fetchMessagesByIds(sessionKey, messageIds);

      if (messages.length !== messageIds.length) {
        const foundIds = new Set(messages.map((m) => m.id));
        const missing = messageIds.filter((id) => !foundIds.has(id));
        throw new FridayDomainError(
          FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.MESSAGE_SCOPE_VIOLATION,
          `Messages not found in session '${sessionKey}': ${missing.join(", ")}`,
          { httpStatus: 400, details: { missingIds: missing } },
        );
      }

      return processInline(sessionKey, "manual", messages, {
        batchSize: messages.length,
        maxBatches: 1,
      });
    },

    async getExtractionStatus(sessionKey) {
      const session = await deps.sessionService.getSession(sessionKey);
      if (!session) {
        throw new FridayDomainError(
          FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.SESSION_NOT_FOUND,
          `Session '${sessionKey}' not found`,
          { httpStatus: 404 },
        );
      }

      const counts = countMessagesByExtractStatus(sessionKey);

      const queuedJobs = deps.db.withReadConnection((db) =>
        extractionRepo.countBySessionAndStatus(db, sessionKey, ["queued"]),
      );
      const runningJobs = deps.db.withReadConnection((db) =>
        extractionRepo.countBySessionAndStatus(db, sessionKey, ["running"]),
      );

      const lastJob = deps.db.withReadConnection((db) =>
        extractionRepo.getLastCompletedOrFailed(db, sessionKey),
      );

      const status: FridaySessionMemoryExtractionStatus = {
        sessionKey,
        pendingMessages: counts.pending,
        extractedMessages: counts.extracted,
        skippedMessages: counts.skipped,
        failedMessages: counts.failed,
        queuedJobs,
        runningJobs,
      };

      if (lastJob) {
        if (lastJob.status === "completed" && lastJob.completedAt) {
          status.lastCompletedAt = lastJob.completedAt;
        }
        if (lastJob.status === "failed") {
          status.lastFailedAt = lastJob.failedAt;
          status.lastErrorCode = lastJob.lastErrorCode;
          status.lastErrorMessage = lastJob.lastErrorMessage;
        }
      }

      return status;
    },

    async retryFailedExtractions(sessionKey) {
      const result: FridaySessionMemoryRetryResult = {
        sessionsQueued: [],
        resetMessageCount: 0,
      };

      const sessionKeys = sessionKey
        ? [sessionKey]
        : deps.db.withReadConnection((db) => extractionRepo.listFailedSessionKeys(db));

      for (const key of sessionKeys) {
        // Count failed messages (do NOT reset to pending — the retry path reads
        // 'failed' directly, so resetting would cause zero messages to process).
        const failedCount = deps.db.withReadConnection((db) => {
          const row = db.prepare(
            `SELECT COUNT(*) AS cnt FROM session_messages
             WHERE session_key = ? AND memory_extract_status = 'failed'`,
          ).get(key) as { cnt: number };
          return row.cnt;
        });

        result.resetMessageCount += failedCount;

        if (failedCount > 0) {
          // Queue a retry job
          const jobId = deps.idGenerator();
          const now = deps.nowIso();

          try {
            deps.db.withWriteTransaction((db) =>
              extractionRepo.insert(db, {
                id: jobId,
                sessionKey: key,
                trigger: "retry",
                batchSize: FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_BATCH_SIZE,
                maxBatches: FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_MAX_BATCHES,
                maxAttempts: FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_JOB_MAX_ATTEMPTS,
                nowIso: now,
              }),
            );
            result.sessionsQueued.push(key);
          } catch (err) {
            // Ignore unique constraint violations (already has an open job)
            console.warn("[friday][session-memory-extraction-service] job queue insert failed:", err instanceof Error ? err.message : String(err));
          }
        }
      }

      return result;
    },
  };
}

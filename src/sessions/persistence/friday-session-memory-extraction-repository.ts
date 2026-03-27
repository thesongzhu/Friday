import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";

import type {
  FridaySessionMemoryExtractionJobRecord,
  FridaySessionMemoryExtractionJobStatus,
  FridaySessionMemoryExtractionTrigger,
} from "../model/friday-session-memory-extraction.types.js";

// ─── Row shape from SQLite ───

interface FridayExtractionJobRow {
  id: string;
  session_key: string;
  trigger: string;
  status: string;
  requested_message_ids_json: string | null;
  batch_size: number;
  max_batches: number;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: FridayExtractionJobRow): FridaySessionMemoryExtractionJobRecord {
  return {
    id: row.id,
    sessionKey: row.session_key,
    trigger: row.trigger as FridaySessionMemoryExtractionTrigger,
    status: row.status as FridaySessionMemoryExtractionJobStatus,
    requestedMessageIds: safeJsonParse<string[]>(row.requested_message_ids_json),
    batchSize: row.batch_size,
    maxBatches: row.max_batches,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    failedAt: row.failed_at ?? undefined,
    lastErrorCode: row.last_error_code ?? undefined,
    lastErrorMessage: row.last_error_message ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Repository interface ───

export interface FridaySessionMemoryExtractionRepository {
  insert(
    db: Database.Database,
    input: {
      id: string;
      sessionKey: string;
      trigger: FridaySessionMemoryExtractionTrigger;
      requestedMessageIds?: string[];
      batchSize: number;
      maxBatches: number;
      maxAttempts: number;
      nowIso: string;
    },
  ): FridaySessionMemoryExtractionJobRecord;

  getById(db: Database.Database, id: string): FridaySessionMemoryExtractionJobRecord | null;

  hasOpenAutoJob(db: Database.Database, sessionKey: string): boolean;

  claimQueuedJobs(
    db: Database.Database,
    input: { limit: number; nowIso: string },
  ): FridaySessionMemoryExtractionJobRecord[];

  markRunning(
    db: Database.Database,
    input: { id: string; nowIso: string },
  ): FridaySessionMemoryExtractionJobRecord | null;

  markCompleted(
    db: Database.Database,
    input: { id: string; resultJson?: string; nowIso: string },
  ): FridaySessionMemoryExtractionJobRecord | null;

  markFailed(
    db: Database.Database,
    input: { id: string; errorCode: string; errorMessage: string; nextAttemptAt?: string; nowIso: string },
  ): FridaySessionMemoryExtractionJobRecord | null;

  countBySessionAndStatus(
    db: Database.Database,
    sessionKey: string,
    statuses: FridaySessionMemoryExtractionJobStatus[],
  ): number;

  getLastCompletedOrFailed(
    db: Database.Database,
    sessionKey: string,
  ): FridaySessionMemoryExtractionJobRecord | null;

  listFailedSessionKeys(db: Database.Database): string[];
}

// ─── Factory ───

export function createFridaySessionMemoryExtractionRepository(): FridaySessionMemoryExtractionRepository {
  return {
    insert(db, input) {
      db.prepare(
        `INSERT INTO session_memory_extraction_jobs (
          id, session_key, trigger, status,
          requested_message_ids_json, batch_size, max_batches,
          attempts, max_attempts, created_at, updated_at
        ) VALUES (
          ?, ?, ?, 'queued',
          ?, ?, ?,
          0, ?, ?, ?
        )`,
      ).run(
        input.id,
        input.sessionKey,
        input.trigger,
        input.requestedMessageIds ? JSON.stringify(input.requestedMessageIds) : null,
        input.batchSize,
        input.maxBatches,
        input.maxAttempts,
        input.nowIso,
        input.nowIso,
      );

      const row = db.prepare(
        "SELECT * FROM session_memory_extraction_jobs WHERE id = ?",
      ).get(input.id) as FridayExtractionJobRow;

      return rowToRecord(row);
    },

    getById(db, id) {
      const row = db.prepare(
        "SELECT * FROM session_memory_extraction_jobs WHERE id = ?",
      ).get(id) as FridayExtractionJobRow | undefined;

      return row ? rowToRecord(row) : null;
    },

    hasOpenAutoJob(db, sessionKey) {
      const row = db.prepare(
        `SELECT 1 FROM session_memory_extraction_jobs
         WHERE session_key = ? AND trigger = 'auto' AND status IN ('queued', 'running')
         LIMIT 1`,
      ).get(sessionKey) as { "1": number } | undefined;

      return row !== undefined;
    },

    claimQueuedJobs(db, input) {
      const rows = db.prepare(
        `SELECT * FROM session_memory_extraction_jobs
         WHERE status = 'queued'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC
         LIMIT ?`,
      ).all(input.nowIso, input.limit) as FridayExtractionJobRow[];

      return rows.map(rowToRecord);
    },

    markRunning(db, input) {
      const result = db.prepare(
        `UPDATE session_memory_extraction_jobs
         SET status = 'running',
             started_at = ?,
             attempts = attempts + 1,
             updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      ).run(input.nowIso, input.nowIso, input.id);

      if (result.changes === 0) return null;

      return this.getById(db, input.id);
    },

    markCompleted(db, input) {
      const result = db.prepare(
        `UPDATE session_memory_extraction_jobs
         SET status = 'completed',
             completed_at = ?,
             result_json = ?,
             updated_at = ?
         WHERE id = ?`,
      ).run(input.nowIso, input.resultJson ?? null, input.nowIso, input.id);

      if (result.changes === 0) return null;

      return this.getById(db, input.id);
    },

    markFailed(db, input) {
      const result = db.prepare(
        `UPDATE session_memory_extraction_jobs
         SET status = 'failed',
             failed_at = ?,
             last_error_code = ?,
             last_error_message = ?,
             next_attempt_at = ?,
             updated_at = ?
         WHERE id = ?`,
      ).run(
        input.nowIso,
        input.errorCode,
        input.errorMessage,
        input.nextAttemptAt ?? null,
        input.nowIso,
        input.id,
      );

      if (result.changes === 0) return null;

      return this.getById(db, input.id);
    },

    countBySessionAndStatus(db, sessionKey, statuses) {
      const placeholders = statuses.map(() => "?").join(", ");
      const row = db.prepare(
        `SELECT COUNT(*) AS cnt FROM session_memory_extraction_jobs
         WHERE session_key = ? AND status IN (${placeholders})`,
      ).get(sessionKey, ...statuses) as { cnt: number };

      return row.cnt;
    },

    getLastCompletedOrFailed(db, sessionKey) {
      const row = db.prepare(
        `SELECT * FROM session_memory_extraction_jobs
         WHERE session_key = ? AND status IN ('completed', 'failed')
         ORDER BY created_at DESC
         LIMIT 1`,
      ).get(sessionKey) as FridayExtractionJobRow | undefined;

      return row ? rowToRecord(row) : null;
    },

    listFailedSessionKeys(db) {
      const rows = db.prepare(
        `SELECT DISTINCT session_key FROM session_memory_extraction_jobs
         WHERE status = 'failed'`,
      ).all() as Array<{ session_key: string }>;

      return rows.map((r) => r.session_key);
    },
  };
}

import type Database from "better-sqlite3";

import type {
  FridayBriefDeliveryAttempt,
  FridayBriefRunRecord,
  FridayBriefRunSourceResult,
  FridayBriefRunStatus,
  FridayBriefSkipReason,
  FridayBriefTtsProviderKind,
} from "./friday-brief.types.js";

interface RunRow {
  id: string;
  triggered_by: string;
  window_start_at: string;
  window_end_at: string;
  status: string;
  skip_reason: string | null;
  transcript: string | null;
  language: string | null;
  source_results_json: string;
  delivery_attempts_json: string;
  audio_json: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface FridayBriefHistoryRepository {
  create(
    db: Database.Database,
    input: {
      id: string;
      triggeredBy: FridayBriefRunRecord["triggeredBy"];
      windowStartAt: string;
      windowEndAt: string;
      nowIso: string;
    },
  ): FridayBriefRunRecord;
  get(db: Database.Database, id: string): FridayBriefRunRecord | null;
  list(
    db: Database.Database,
    input?: { limit?: number; beforeId?: string },
  ): FridayBriefRunRecord[];
  update(
    db: Database.Database,
    id: string,
    patch: Partial<{
      status: FridayBriefRunStatus;
      skipReason: FridayBriefSkipReason | null;
      transcript: string | null;
      language: string | null;
      sourceResults: readonly FridayBriefRunSourceResult[];
      deliveryAttempts: readonly FridayBriefDeliveryAttempt[];
      audio: { provider: FridayBriefTtsProviderKind; voice: string; bytes: number; durationSec?: number } | null;
      error: { code: string; message: string } | null;
    }>,
    nowIso: string,
  ): FridayBriefRunRecord | null;
  prune(
    db: Database.Database,
    options: { keepLatestCount?: number; maxAgeDays?: number; nowMs: number },
  ): { deletedIds: string[] };
}

function rowToRecord(row: RunRow): FridayBriefRunRecord {
  const audio = row.audio_json ? (JSON.parse(row.audio_json) as FridayBriefRunRecord["audio"]) : undefined;
  const error = row.error_json ? (JSON.parse(row.error_json) as FridayBriefRunRecord["error"]) : undefined;
  return {
    id: row.id,
    triggeredBy: row.triggered_by as FridayBriefRunRecord["triggeredBy"],
    windowStartAt: row.window_start_at,
    windowEndAt: row.window_end_at,
    status: row.status as FridayBriefRunStatus,
    skipReason: row.skip_reason ? (row.skip_reason as FridayBriefSkipReason) : undefined,
    transcript: row.transcript ?? undefined,
    language: row.language ?? undefined,
    sourceResults: JSON.parse(row.source_results_json) as readonly FridayBriefRunSourceResult[],
    deliveryAttempts: JSON.parse(row.delivery_attempts_json) as readonly FridayBriefDeliveryAttempt[],
    audio,
    error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayBriefHistoryRepository(): FridayBriefHistoryRepository {
  return {
    create(db, input) {
      db.prepare(
        `INSERT INTO friday_brief_runs (
           id, triggered_by, window_start_at, window_end_at, status,
           source_results_json, delivery_attempts_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'pending', '[]', '[]', ?, ?)`,
      ).run(input.id, input.triggeredBy, input.windowStartAt, input.windowEndAt, input.nowIso, input.nowIso);
      const row = db
        .prepare("SELECT * FROM friday_brief_runs WHERE id = ?")
        .get(input.id) as RunRow;
      return rowToRecord(row);
    },

    get(db, id) {
      const row = db
        .prepare("SELECT * FROM friday_brief_runs WHERE id = ?")
        .get(id) as RunRow | undefined;
      return row ? rowToRecord(row) : null;
    },

    list(db, input) {
      const limit = Math.max(1, Math.min(input?.limit ?? 50, 200));
      if (input?.beforeId) {
        const rows = db
          .prepare(
            `SELECT * FROM friday_brief_runs
             WHERE created_at < (SELECT created_at FROM friday_brief_runs WHERE id = ?)
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
          )
          .all(input.beforeId, limit) as RunRow[];
        return rows.map(rowToRecord);
      }
      const rows = db
        .prepare(
          `SELECT * FROM friday_brief_runs
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(limit) as RunRow[];
      return rows.map(rowToRecord);
    },

    update(db, id, patch, nowIso) {
      const existing = db
        .prepare("SELECT * FROM friday_brief_runs WHERE id = ?")
        .get(id) as RunRow | undefined;
      if (!existing) return null;
      const next: RunRow = {
        ...existing,
        status: patch.status ?? existing.status,
        skip_reason:
          patch.skipReason === undefined ? existing.skip_reason : patch.skipReason ?? null,
        transcript:
          patch.transcript === undefined ? existing.transcript : patch.transcript ?? null,
        language:
          patch.language === undefined ? existing.language : patch.language ?? null,
        source_results_json:
          patch.sourceResults === undefined
            ? existing.source_results_json
            : JSON.stringify(patch.sourceResults),
        delivery_attempts_json:
          patch.deliveryAttempts === undefined
            ? existing.delivery_attempts_json
            : JSON.stringify(patch.deliveryAttempts),
        audio_json:
          patch.audio === undefined
            ? existing.audio_json
            : patch.audio
              ? JSON.stringify(patch.audio)
              : null,
        error_json:
          patch.error === undefined
            ? existing.error_json
            : patch.error
              ? JSON.stringify(patch.error)
              : null,
        updated_at: nowIso,
      };
      db.prepare(
        `UPDATE friday_brief_runs SET
           status = ?, skip_reason = ?, transcript = ?, language = ?,
           source_results_json = ?, delivery_attempts_json = ?,
           audio_json = ?, error_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        next.status,
        next.skip_reason,
        next.transcript,
        next.language,
        next.source_results_json,
        next.delivery_attempts_json,
        next.audio_json,
        next.error_json,
        next.updated_at,
        id,
      );
      return rowToRecord(next);
    },

    prune(db, options) {
      const keepLatestCount =
        options.keepLatestCount !== undefined && options.keepLatestCount >= 0
          ? Math.floor(options.keepLatestCount)
          : undefined;
      const maxAgeDays =
        options.maxAgeDays !== undefined && options.maxAgeDays > 0 ? options.maxAgeDays : undefined;
      if (keepLatestCount === undefined && maxAgeDays === undefined) {
        return { deletedIds: [] };
      }

      const idsToDelete = new Set<string>();

      if (keepLatestCount !== undefined) {
        const rows = db
          .prepare(
            `SELECT id FROM friday_brief_runs
             ORDER BY created_at DESC, id DESC
             LIMIT -1 OFFSET ?`,
          )
          .all(keepLatestCount) as Array<{ id: string }>;
        for (const row of rows) idsToDelete.add(row.id);
      }

      if (maxAgeDays !== undefined) {
        const cutoffMs = options.nowMs - maxAgeDays * 24 * 60 * 60 * 1000;
        const cutoffIso = new Date(cutoffMs).toISOString();
        const rows = db
          .prepare("SELECT id FROM friday_brief_runs WHERE created_at < ?")
          .all(cutoffIso) as Array<{ id: string }>;
        for (const row of rows) idsToDelete.add(row.id);
      }

      if (idsToDelete.size === 0) return { deletedIds: [] };

      const ids = Array.from(idsToDelete);
      const placeholders = ids.map(() => "?").join(",");
      db.prepare(`DELETE FROM friday_brief_runs WHERE id IN (${placeholders})`).run(...ids);
      return { deletedIds: ids };
    },
  };
}

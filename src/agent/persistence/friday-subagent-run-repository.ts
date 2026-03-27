import type Database from "better-sqlite3";

import { FridayDomainError } from "#errors";
import { safeJsonParse } from "#utilities";

import { FRIDAY_SUBAGENT_ERROR_CODES } from "../subagent/friday-subagent-constants.js";
import type {
  FridaySubagentListFilters,
  FridaySubagentOutcome,
  FridaySubagentRunRecord,
  FridaySubagentRunStatus,
} from "../subagent/friday-subagent.types.js";

// ─── Row shape from SQLite ───

interface FridaySubagentRunRow {
  id: string;
  parent_run_id: string;
  parent_session_key: string;
  child_run_id: string;
  child_session_key: string;
  task: string;
  label: string | null;
  model: string | null;
  depth: number;
  status: string;
  outcome: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  requester_session_key: string | null;
  root_run_id: string | null;
  cleanup_requested: number;
  archival_deadline: string | null;
}

function rowToRecord(row: FridaySubagentRunRow): FridaySubagentRunRecord {
  return {
    id: row.id,
    parentRunId: row.parent_run_id,
    parentSessionKey: row.parent_session_key,
    childRunId: row.child_run_id,
    childSessionKey: row.child_session_key,
    task: row.task,
    label: row.label ?? undefined,
    model: row.model ?? undefined,
    depth: row.depth,
    status: row.status as FridaySubagentRunStatus,
    outcome: safeJsonParse<FridaySubagentOutcome>(row.outcome),
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    requesterSessionKey: row.requester_session_key ?? undefined,
    rootRunId: row.root_run_id ?? undefined,
    cleanupRequested: row.cleanup_requested === 1,
    archivalDeadline: row.archival_deadline ?? undefined,
  };
}

// ─── Repository interface ───

export interface FridaySubagentRunRepository {
  create(
    db: Database.Database,
    input: {
      id: string;
      parentRunId: string;
      parentSessionKey: string;
      childRunId: string;
      childSessionKey: string;
      task: string;
      label?: string;
      model?: string;
      depth: number;
      nowIso: string;
      requesterSessionKey?: string;
      rootRunId?: string;
    },
  ): FridaySubagentRunRecord;

  getById(
    db: Database.Database,
    id: string,
  ): FridaySubagentRunRecord | null;

  update(
    db: Database.Database,
    input: {
      id: string;
      status?: FridaySubagentRunStatus;
      outcome?: FridaySubagentOutcome;
      startedAt?: string;
      completedAt?: string;
      durationMs?: number;
      childRunId?: string;
      cleanupRequested?: boolean;
      archivalDeadline?: string;
    },
  ): FridaySubagentRunRecord | null;

  listByParentRunId(
    db: Database.Database,
    parentRunId: string,
  ): FridaySubagentRunRecord[];

  list(
    db: Database.Database,
    filters?: FridaySubagentListFilters,
  ): FridaySubagentRunRecord[];

  countActiveByParentRunId(
    db: Database.Database,
    parentRunId: string,
  ): number;

  /** List all pending/running records (for boot resume). */
  listPendingOrRunning(
    db: Database.Database,
  ): FridaySubagentRunRecord[];

  /** Delete records with cleanup_requested=1 and archival_deadline < beforeIso. */
  deleteCleanedUp(
    db: Database.Database,
    beforeIso: string,
  ): number;
}

// ─── Factory ───

export function createFridaySubagentRunRepository(): FridaySubagentRunRepository {
  return {
    create(db, input) {
      db.prepare(
        `INSERT INTO friday_subagent_runs (
          id, parent_run_id, parent_session_key, child_run_id, child_session_key,
          task, label, model, depth, status, created_at,
          requester_session_key, root_run_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      ).run(
        input.id,
        input.parentRunId,
        input.parentSessionKey,
        input.childRunId,
        input.childSessionKey,
        input.task,
        input.label ?? null,
        input.model ?? null,
        input.depth,
        input.nowIso,
        input.requesterSessionKey ?? null,
        input.rootRunId ?? null,
      );

      const row = db.prepare(
        "SELECT * FROM friday_subagent_runs WHERE id = ?",
      ).get(input.id) as FridaySubagentRunRow | undefined;

      if (!row) {
        throw new FridayDomainError(
          FRIDAY_SUBAGENT_ERROR_CODES.SPAWN_FAILED,
          "Subagent run insert failed — row not found after insert",
          { httpStatus: 500 },
        );
      }

      return rowToRecord(row);
    },

    getById(db, id) {
      const row = db.prepare(
        "SELECT * FROM friday_subagent_runs WHERE id = ?",
      ).get(id) as FridaySubagentRunRow | undefined;

      return row ? rowToRecord(row) : null;
    },

    update(db, input) {
      const sets: string[] = [];
      const params: unknown[] = [];

      if (input.status !== undefined) {
        sets.push("status = ?");
        params.push(input.status);
      }
      if (input.outcome !== undefined) {
        sets.push("outcome = ?");
        params.push(JSON.stringify(input.outcome));
      }
      if (input.startedAt !== undefined) {
        sets.push("started_at = ?");
        params.push(input.startedAt);
      }
      if (input.completedAt !== undefined) {
        sets.push("completed_at = ?");
        params.push(input.completedAt);
      }
      if (input.durationMs !== undefined) {
        sets.push("duration_ms = ?");
        params.push(input.durationMs);
      }
      if (input.childRunId !== undefined) {
        sets.push("child_run_id = ?");
        params.push(input.childRunId);
      }
      if (input.cleanupRequested !== undefined) {
        sets.push("cleanup_requested = ?");
        params.push(input.cleanupRequested ? 1 : 0);
      }
      if (input.archivalDeadline !== undefined) {
        sets.push("archival_deadline = ?");
        params.push(input.archivalDeadline);
      }

      if (sets.length === 0) {
        return this.getById(db, input.id);
      }

      params.push(input.id);
      db.prepare(
        `UPDATE friday_subagent_runs SET ${sets.join(", ")} WHERE id = ?`,
      ).run(...params);

      return this.getById(db, input.id);
    },

    listByParentRunId(db, parentRunId) {
      const rows = db.prepare(
        "SELECT * FROM friday_subagent_runs WHERE parent_run_id = ? ORDER BY created_at ASC",
      ).all(parentRunId) as FridaySubagentRunRow[];

      return rows.map(rowToRecord);
    },

    list(db, filters) {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (filters?.parentRunId) {
        conditions.push("parent_run_id = ?");
        params.push(filters.parentRunId);
      }
      if (filters?.status) {
        conditions.push("status = ?");
        params.push(filters.status);
      }
      if (filters?.requesterSessionKey) {
        conditions.push("requester_session_key = ?");
        params.push(filters.requesterSessionKey);
      }
      if (filters?.rootRunId) {
        conditions.push("root_run_id = ?");
        params.push(filters.rootRunId);
      }
      if (filters?.cursor) {
        conditions.push("created_at < ?");
        params.push(filters.cursor);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = Math.min(filters?.limit ?? 50, 500);
      params.push(limit);

      const rows = db.prepare(
        `SELECT * FROM friday_subagent_runs ${where} ORDER BY created_at DESC LIMIT ?`,
      ).all(...params) as FridaySubagentRunRow[];

      return rows.map(rowToRecord);
    },

    countActiveByParentRunId(db, parentRunId) {
      const row = db.prepare(
        "SELECT COUNT(*) as count FROM friday_subagent_runs WHERE parent_run_id = ? AND status IN ('pending', 'running')",
      ).get(parentRunId) as { count: number };

      return row.count;
    },

    listPendingOrRunning(db) {
      const rows = db.prepare(
        "SELECT * FROM friday_subagent_runs WHERE status IN ('pending', 'running') ORDER BY created_at ASC",
      ).all() as FridaySubagentRunRow[];

      return rows.map(rowToRecord);
    },

    deleteCleanedUp(db, beforeIso) {
      const result = db.prepare(
        "DELETE FROM friday_subagent_runs WHERE cleanup_requested = 1 AND archival_deadline IS NOT NULL AND archival_deadline < ?",
      ).run(beforeIso);

      return result.changes;
    },
  };
}

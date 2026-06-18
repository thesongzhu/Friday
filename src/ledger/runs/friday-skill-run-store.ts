import type Database from "better-sqlite3";
import type { FridaySqliteLayer } from "#state";
import type { SkillRunStatus } from "#skills";
import { safeJsonParse } from "#utilities";
import type { FridaySkillRunListInput, FridaySkillRunSnapshot } from "./friday-skill-run-store.types.js";

export interface FridaySkillRunStore {
  upsertRun<TState>(snapshot: FridaySkillRunSnapshot<TState>): void;
  getRun<TState = unknown>(runId: string): FridaySkillRunSnapshot<TState> | null;
  listRuns(input?: FridaySkillRunListInput): FridaySkillRunSnapshot[];
  pruneTerminalRunsBefore(cutoffIso: string): number;
}

export interface CreateSkillRunStoreDeps {
  db: FridaySqliteLayer;
}

const NAMESPACE = "skill_runs";
const TABLE_NAME = "skill_run_snapshots";

/** Terminal statuses that can be pruned. */
const TERMINAL_STATUSES: SkillRunStatus[] = ["completed", "failed", "cancelled"];

interface SkillRunRow {
  value_json: string;
}

function snapshotTags(snapshot: FridaySkillRunSnapshot): string[] {
  return [`skill:${snapshot.skillId}`, `status:${snapshot.status}`, `user:${snapshot.userId}`];
}

function rowToSnapshot<TState = unknown>(
  row: SkillRunRow | undefined,
): FridaySkillRunSnapshot<TState> | null {
  if (!row) return null;
  return safeJsonParse<FridaySkillRunSnapshot<TState>>(row.value_json) ?? null;
}

export function upsertFridaySkillRunSnapshotRow<TState>(
  db: Database.Database,
  snapshot: FridaySkillRunSnapshot<TState>,
): void {
  db.prepare(
    `INSERT INTO skill_run_snapshots (
      run_id, skill_id, version, status, user_id, session_id, channel,
      current_step_id, started_at, updated_at, last_transition_at, value_json, tags_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      skill_id = excluded.skill_id,
      version = excluded.version,
      status = excluded.status,
      user_id = excluded.user_id,
      session_id = excluded.session_id,
      channel = excluded.channel,
      current_step_id = excluded.current_step_id,
      started_at = excluded.started_at,
      updated_at = excluded.updated_at,
      last_transition_at = excluded.last_transition_at,
      value_json = excluded.value_json,
      tags_json = excluded.tags_json`,
  ).run(
    snapshot.runId,
    snapshot.skillId,
    snapshot.version,
    snapshot.status,
    snapshot.userId,
    snapshot.sessionId,
    snapshot.channel,
    snapshot.currentStepId ?? null,
    snapshot.startedAt,
    snapshot.updatedAt,
    snapshot.lastTransitionAt,
    JSON.stringify(snapshot),
    JSON.stringify(snapshotTags(snapshot)),
  );
}

function readRunRowById(
  db: Database.Database,
  runId: string,
): FridaySkillRunSnapshot | null {
  const row = db
    .prepare(`SELECT value_json FROM ${TABLE_NAME} WHERE run_id = ?`)
    .get(runId) as SkillRunRow | undefined;
  return rowToSnapshot(row);
}

function readLegacyRunById(
  db: Database.Database,
  runId: string,
): FridaySkillRunSnapshot | null {
  const row = db
    .prepare("SELECT value_json FROM memory_items WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, runId) as SkillRunRow | undefined;
  return rowToSnapshot(row);
}

function listRunRows(
  db: Database.Database,
  input?: FridaySkillRunListInput,
): FridaySkillRunSnapshot[] {
  let sql = `SELECT value_json FROM ${TABLE_NAME} WHERE 1 = 1`;
  const params: unknown[] = [];
  if (input?.skillId) {
    sql += " AND skill_id = ?";
    params.push(input.skillId);
  }
  if (input?.status) {
    sql += " AND status = ?";
    params.push(input.status);
  }
  if (input?.userId) {
    sql += " AND user_id = ?";
    params.push(input.userId);
  }
  sql += " ORDER BY updated_at DESC";
  const rows = db.prepare(sql).all(...params) as SkillRunRow[];
  return rows
    .map((row) => rowToSnapshot(row))
    .filter((snapshot): snapshot is FridaySkillRunSnapshot => snapshot !== null);
}

function listLegacyRuns(
  db: Database.Database,
  input?: FridaySkillRunListInput,
): FridaySkillRunSnapshot[] {
  let sql = "SELECT value_json FROM memory_items WHERE namespace = ?";
  const params: unknown[] = [NAMESPACE];

  if (input?.skillId) {
    sql += " AND tags_json LIKE ?";
    params.push(`%"skill:${input.skillId}"%`);
  }
  if (input?.status) {
    sql += " AND tags_json LIKE ?";
    params.push(`%"status:${input.status}"%`);
  }
  if (input?.userId) {
    sql += " AND tags_json LIKE ?";
    params.push(`%"user:${input.userId}"%`);
  }

  sql += " ORDER BY updated_at DESC";
  const rows = db.prepare(sql).all(...params) as SkillRunRow[];
  return rows
    .map((row) => rowToSnapshot(row))
    .filter((snapshot): snapshot is FridaySkillRunSnapshot => snapshot !== null);
}

function mergeRuns(
  rows: FridaySkillRunSnapshot[],
  legacyRows: FridaySkillRunSnapshot[],
  limit?: number,
): FridaySkillRunSnapshot[] {
  const seen = new Set(rows.map((row) => row.runId));
  const merged = [
    ...rows,
    ...legacyRows.filter((row) => !seen.has(row.runId)),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return limit === undefined ? merged : merged.slice(0, limit);
}

export function createFridaySkillRunStore(
  deps: CreateSkillRunStoreDeps,
): FridaySkillRunStore {
  return {
    upsertRun<TState>(snapshot: FridaySkillRunSnapshot<TState>) {
      deps.db.withWriteTransaction((db) => {
        upsertFridaySkillRunSnapshotRow(db, snapshot);
      });
    },

    getRun<TState = unknown>(runId: string): FridaySkillRunSnapshot<TState> | null {
      return deps.db.withReadConnection((db) => {
        return (readRunRowById(db, runId) ??
          readLegacyRunById(db, runId)) as FridaySkillRunSnapshot<TState> | null;
      });
    },

    listRuns(input) {
      return deps.db.withReadConnection((db) => {
        return mergeRuns(listRunRows(db, input), listLegacyRuns(db, input), input?.limit);
      });
    },

    pruneTerminalRunsBefore(cutoffIso) {
      return deps.db.withWriteTransaction((db) => {
        let total = 0;
        for (const status of TERMINAL_STATUSES) {
          const result = db
            .prepare(
              `DELETE FROM ${TABLE_NAME} WHERE status = ? AND updated_at < ?`,
            )
            .run(status, cutoffIso);
          total += result.changes;
        }
        return total;
      });
    },
  };
}

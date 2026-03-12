import type {
  CreateFridayHeartbeatStateRepositoryDeps,
  FridayHeartbeatRunRecord,
  FridayHeartbeatState,
  FridayHeartbeatStateRepository,
} from "./friday-heartbeat.types.js";

interface HeartbeatStateRow {
  last_run_at: string | null;
  last_action_at: string | null;
  cooldown_until: string | null;
  updated_at: string;
}

interface HeartbeatRunRow {
  id: string;
  started_at: string;
  finished_at: string;
  status: "ok" | "skipped" | "error";
  reason: string | null;
  action_required: number;
  run_id: string | null;
  response_text: string | null;
}

export function createFridayHeartbeatStateRepository(
  deps: CreateFridayHeartbeatStateRepositoryDeps,
): FridayHeartbeatStateRepository {
  const { db, nowIso } = deps;

  return {
    getState(): FridayHeartbeatState {
      return db.withWriteTransaction((conn) => {
        conn
          .prepare(
            `INSERT OR IGNORE INTO friday_heartbeat_state
             (id, last_run_at, last_action_at, cooldown_until, updated_at)
             VALUES ('singleton', NULL, NULL, NULL, ?)`,
          )
          .run(nowIso());

        const row = conn
          .prepare(
            "SELECT last_run_at, last_action_at, cooldown_until, updated_at FROM friday_heartbeat_state WHERE id = 'singleton'",
          )
          .get() as HeartbeatStateRow | undefined;

        return {
          lastRunAt: row?.last_run_at ?? null,
          lastActionAt: row?.last_action_at ?? null,
          cooldownUntil: row?.cooldown_until ?? null,
          updatedAt: row?.updated_at ?? nowIso(),
        };
      });
    },

    saveState(state: FridayHeartbeatState): void {
      db.withWriteTransaction((conn) => {
        conn
          .prepare(
            `INSERT INTO friday_heartbeat_state
             (id, last_run_at, last_action_at, cooldown_until, updated_at)
             VALUES ('singleton', ?, ?, ?, ?)
             ON CONFLICT(id)
             DO UPDATE SET
               last_run_at = excluded.last_run_at,
               last_action_at = excluded.last_action_at,
               cooldown_until = excluded.cooldown_until,
               updated_at = excluded.updated_at`,
          )
          .run(
            state.lastRunAt,
            state.lastActionAt,
            state.cooldownUntil,
            state.updatedAt,
          );
      });
    },

    appendRun(record: FridayHeartbeatRunRecord): void {
      db.withWriteTransaction((conn) => {
        conn
          .prepare(
            `INSERT INTO friday_heartbeat_runs
             (id, started_at, finished_at, status, reason, action_required, run_id, response_text, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            record.id,
            record.startedAt,
            record.finishedAt,
            record.status,
            record.reason ?? null,
            record.actionRequired ? 1 : 0,
            record.runId ?? null,
            record.responseText ?? null,
            record.finishedAt,
          );
      });
    },

    listRuns(limit = 20): FridayHeartbeatRunRecord[] {
      const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
      return db.withReadConnection((conn) => {
        const rows = conn
          .prepare(
            `SELECT id, started_at, finished_at, status, reason, action_required, run_id, response_text
             FROM friday_heartbeat_runs
             ORDER BY started_at DESC
             LIMIT ?`,
          )
          .all(safeLimit) as HeartbeatRunRow[];
        return rows.map((row) => ({
          id: row.id,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          status: row.status,
          reason: row.reason ?? undefined,
          actionRequired: row.action_required === 1,
          runId: row.run_id ?? undefined,
          responseText: row.response_text ?? undefined,
        }));
      });
    },
  };
}


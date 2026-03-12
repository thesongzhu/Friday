import type { FridaySqliteLayer } from "#state";
import type { SkillRunStatus } from "#skills";
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

/** Terminal statuses that can be pruned. */
const TERMINAL_STATUSES: SkillRunStatus[] = ["completed", "failed", "cancelled"];

export function createFridaySkillRunStore(
  deps: CreateSkillRunStoreDeps,
): FridaySkillRunStore {
  return {
    upsertRun<TState>(snapshot: FridaySkillRunSnapshot<TState>) {
      deps.db.withWriteTransaction((db) => {
        db.prepare(
          `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(namespace, key) DO UPDATE SET
             value_json = excluded.value_json,
             tags_json = excluded.tags_json,
             updated_at = excluded.updated_at`,
        ).run(
          snapshot.runId,
          NAMESPACE,
          snapshot.runId,
          JSON.stringify(snapshot),
          JSON.stringify([`skill:${snapshot.skillId}`, `status:${snapshot.status}`, `user:${snapshot.userId}`]),
          snapshot.startedAt,
          snapshot.updatedAt,
        );
      });
    },

    getRun<TState = unknown>(runId: string): FridaySkillRunSnapshot<TState> | null {
      return deps.db.withReadConnection((db) => {
        const row = db
          .prepare("SELECT value_json FROM memory_items WHERE namespace = ? AND key = ?")
          .get(NAMESPACE, runId) as { value_json: string } | undefined;
        if (!row) return null;
        return JSON.parse(row.value_json) as FridaySkillRunSnapshot<TState>;
      });
    },

    listRuns(input) {
      return deps.db.withReadConnection((db) => {
        let sql = "SELECT value_json FROM memory_items WHERE namespace = ?";
        const params: unknown[] = [NAMESPACE];

        // We filter by tags to support skill/status/user filtering
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

        if (input?.limit) {
          sql += " LIMIT ?";
          params.push(input.limit);
        }

        const rows = db.prepare(sql).all(...params) as Array<{ value_json: string }>;
        return rows.map((row) => JSON.parse(row.value_json) as FridaySkillRunSnapshot);
      });
    },

    pruneTerminalRunsBefore(cutoffIso) {
      return deps.db.withWriteTransaction((db) => {
        // Build tag-based filter for terminal statuses
        let total = 0;
        for (const status of TERMINAL_STATUSES) {
          const result = db
            .prepare(
              "DELETE FROM memory_items WHERE namespace = ? AND tags_json LIKE ? AND updated_at < ?",
            )
            .run(NAMESPACE, `%"status:${status}"%`, cutoffIso);
          total += result.changes;
        }
        return total;
      });
    },
  };
}

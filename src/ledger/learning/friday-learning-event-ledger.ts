import type { FridaySqliteLayer } from "#state";
import { safeJsonParse } from "#utilities";
import type {
  FridayLearningEventAppendInput,
  FridayLearningEventKind,
} from "./friday-learning-event-ledger.types.js";

export interface FridayLearningEventLedger {
  appendEvent(input: FridayLearningEventAppendInput): { inserted: boolean };
  appendBatch(inputs: FridayLearningEventAppendInput[]): Array<{ eventId: string; inserted: boolean }>;
  listByUser(input: {
    userId: string;
    kinds?: FridayLearningEventKind[];
    fromTs?: string;
    toTs?: string;
    limit?: number;
  }): FridayLearningEventAppendInput[];
  pruneBefore(cutoffIso: string): number;
}

export interface CreateLearningEventLedgerDeps {
  db: FridaySqliteLayer;
}

export function createFridayLearningEventLedger(
  deps: CreateLearningEventLedgerDeps,
): FridayLearningEventLedger {
  return {
    appendEvent(input) {
      return deps.db.withWriteTransaction((db) => {
        const result = db
          .prepare(
            `INSERT OR IGNORE INTO learning_events (
              event_id, ts, user_id, session_id, run_id, kind, payload_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.eventId,
            input.ts,
            input.userId,
            input.sessionId ?? null,
            input.runId ?? null,
            input.kind,
            JSON.stringify(input.payload),
            input.ts,
          );
        return { inserted: result.changes > 0 };
      });
    },

    appendBatch(inputs) {
      return deps.db.withWriteTransaction((db) => {
        const stmt = db.prepare(
          `INSERT OR IGNORE INTO learning_events (
            event_id, ts, user_id, session_id, run_id, kind, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        return inputs.map((input) => {
          const result = stmt.run(
            input.eventId,
            input.ts,
            input.userId,
            input.sessionId ?? null,
            input.runId ?? null,
            input.kind,
            JSON.stringify(input.payload),
            input.ts,
          );
          return { eventId: input.eventId, inserted: result.changes > 0 };
        });
      });
    },

    listByUser(input) {
      return deps.db.withReadConnection((db) => {
        let sql = "SELECT * FROM learning_events WHERE user_id = ?";
        const params: unknown[] = [input.userId];

        if (input.kinds?.length) {
          const placeholders = input.kinds.map(() => "?").join(", ");
          sql += ` AND kind IN (${placeholders})`;
          params.push(...input.kinds);
        }

        if (input.fromTs) {
          sql += " AND ts >= ?";
          params.push(input.fromTs);
        }

        if (input.toTs) {
          sql += " AND ts <= ?";
          params.push(input.toTs);
        }

        sql += " ORDER BY ts DESC";

        if (input.limit) {
          sql += " LIMIT ?";
          params.push(input.limit);
        }

        const rows = db.prepare(sql).all(...params) as Array<{
          event_id: string;
          ts: string;
          user_id: string;
          session_id: string | null;
          run_id: string | null;
          kind: FridayLearningEventKind;
          payload_json: string;
        }>;

        return rows.map((row) => ({
          eventId: row.event_id,
          ts: row.ts,
          userId: row.user_id,
          sessionId: row.session_id ?? undefined,
          runId: row.run_id ?? undefined,
          kind: row.kind,
          payload: safeJsonParse<Record<string, unknown>>(row.payload_json) ?? {},
        }));
      });
    },

    pruneBefore(cutoffIso) {
      return deps.db.withWriteTransaction((db) => {
        const result = db
          .prepare("DELETE FROM learning_events WHERE ts < ?")
          .run(cutoffIso);
        return result.changes;
      });
    },
  };
}

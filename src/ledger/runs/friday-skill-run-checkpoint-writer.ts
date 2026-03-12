import type { FridaySqliteLayer } from "#state";
import type { FridayLearningEventAppendInput } from "../friday-ledger-internal.types.js";
import type { FridaySkillRunSnapshot } from "./friday-skill-run-store.types.js";

export interface FridaySkillRunCheckpointWriter {
  persistCheckpoint<TState>(input: {
    run: FridaySkillRunSnapshot<TState>;
    learningEvent?: FridayLearningEventAppendInput;
  }): { runPersisted: true; eventInserted?: boolean };
}

export interface CreateCheckpointWriterDeps {
  db: FridaySqliteLayer;
}

const NAMESPACE = "skill_runs";

/**
 * Persists a skill run snapshot and an optional learning event
 * atomically within a single SQLite write transaction.
 */
export function createFridaySkillRunCheckpointWriter(
  deps: CreateCheckpointWriterDeps,
): FridaySkillRunCheckpointWriter {
  return {
    persistCheckpoint<TState>(input: {
      run: FridaySkillRunSnapshot<TState>;
      learningEvent?: FridayLearningEventAppendInput;
    }) {
      return deps.db.withWriteTransaction((db) => {
        const snapshot = input.run;

        // 1. Upsert run snapshot in memory_items
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
          JSON.stringify([
            `skill:${snapshot.skillId}`,
            `status:${snapshot.status}`,
            `user:${snapshot.userId}`,
          ]),
          snapshot.startedAt,
          snapshot.updatedAt,
        );

        // 2. Append learning event (optional)
        let eventInserted: boolean | undefined;
        if (input.learningEvent) {
          const ev = input.learningEvent;
          const result = db
            .prepare(
              `INSERT OR IGNORE INTO learning_events (
                event_id, ts, user_id, session_id, run_id, kind, payload_json, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              ev.eventId,
              ev.ts,
              ev.userId,
              ev.sessionId ?? null,
              ev.runId ?? null,
              ev.kind,
              JSON.stringify(ev.payload),
              ev.ts,
            );
          eventInserted = result.changes > 0;
        }

        return { runPersisted: true as const, eventInserted };
      });
    },
  };
}

import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";
import { pseudonymizeEventIdentifiers, redactEventPayload } from "../../api/realtime/friday-event-payload-redactor.js";

// ─── Run event record ───

export interface FridayAgentRunEventRecord {
  eventId: string;
  runId: string;
  seq: number;
  eventName: string;
  payload: Record<string, unknown>;
  emittedAt: string;
  createdAt: string;
}

// ─── Row shape from SQLite ───

interface FridayAgentRunEventRow {
  event_id: string;
  run_id: string;
  seq: number;
  event_name: string;
  payload_json: string;
  emitted_at: string;
  created_at: string;
}

function rowToRecord(row: FridayAgentRunEventRow): FridayAgentRunEventRecord {
  return {
    eventId: row.event_id,
    runId: row.run_id,
    seq: row.seq,
    eventName: row.event_name,
    payload: safeJsonParse<Record<string, unknown>>(row.payload_json) ?? {},
    emittedAt: row.emitted_at,
    createdAt: row.created_at,
  };
}

// ─── Repository interface ───

export interface FridayAgentRunEventRepository {
  append(
    db: Database.Database,
    input: {
      eventId: string;
      runId: string;
      seq: number;
      eventName: string;
      payload: Record<string, unknown>;
      emittedAt: string;
      createdAt: string;
    },
  ): void;

  list(
    db: Database.Database,
    runId: string,
    afterSeq?: number,
  ): FridayAgentRunEventRecord[];
}

// ─── Factory ───

export interface CreateFridayAgentRunEventRepositoryDeps {
  /**
   * SEC-EVENT-REDACTION-001 / FINDING 1 — pseudonymize identifier VALUES carried in
   * the agent-event payload (executionId etc.) before persistence, so no raw
   * sensitive bytes land in `friday_agent_run_events.payload_json`. Deterministic +
   * owner-scoped (the realtime pseudonymizer). Identity/omitted → legacy raw
   * behavior (test-safe). NOTE: the `run_id` COLUMN is intentionally left raw — it
   * is a foreign key to `friday_agent_runs(id)` and the list query key, so it cannot
   * be pseudonymized here; that is the agent forming-site's concern (out of scope).
   */
  pseudonymizeIdentifierValue?: (rawValue: string) => string;
}

export function createFridayAgentRunEventRepository(
  deps: CreateFridayAgentRunEventRepositoryDeps = {},
): FridayAgentRunEventRepository {
  return {
    append(db, input) {
      const pseudonymized = deps.pseudonymizeIdentifierValue
        ? pseudonymizeEventIdentifiers(input.payload, deps.pseudonymizeIdentifierValue)
        : input.payload;
      const redactedPayload = redactEventPayload(pseudonymized);
      db.prepare(
        `INSERT INTO friday_agent_run_events
          (event_id, run_id, seq, event_name, payload_json, emitted_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.eventId,
        input.runId,
        input.seq,
        input.eventName,
        JSON.stringify(redactedPayload),
        input.emittedAt,
        input.createdAt,
      );
    },

    list(db, runId, afterSeq) {
      if (afterSeq !== undefined) {
        const rows = db.prepare(
          `SELECT * FROM friday_agent_run_events
           WHERE run_id = ? AND seq > ?
           ORDER BY seq ASC`,
        ).all(runId, afterSeq) as FridayAgentRunEventRow[];
        return rows.map(rowToRecord);
      }

      const rows = db.prepare(
        `SELECT * FROM friday_agent_run_events
         WHERE run_id = ?
         ORDER BY seq ASC`,
      ).all(runId) as FridayAgentRunEventRow[];
      return rows.map(rowToRecord);
    },
  };
}

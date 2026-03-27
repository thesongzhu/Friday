import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";
import type { FridayRealtimeEventEnvelope, FridayRealtimeEventName } from "../model/friday-api-realtime.types.js";

// ─── Row type ───

export interface FridayRealtimeEventRow {
  event_id: string;
  stream_id: string;
  seq: number;
  event: string;
  payload_json: string;
  emitted_at: string;
  correlation_id: string | null;
  state_version_json: string | null;
  created_at: string;
}

// ─── Repository ───

export interface FridayRealtimeEventRepository {
  append(db: Database.Database, envelope: FridayRealtimeEventEnvelope): void;
  getNextSeq(db: Database.Database, streamId: string): number;
  listAfterSeq(
    db: Database.Database,
    streamId: string,
    afterSeq: number,
    limit: number,
  ): FridayRealtimeEventEnvelope[];
  listByStream(
    db: Database.Database,
    streamId: string,
    limit: number,
  ): FridayRealtimeEventEnvelope[];
  deleteOlderThan(db: Database.Database, before: string): number;
  getLatestSeq(db: Database.Database, streamId: string): number;
}

function rowToEnvelope(row: FridayRealtimeEventRow): FridayRealtimeEventEnvelope {
  return {
    eventId: row.event_id,
    streamId: row.stream_id,
    seq: row.seq,
    event: row.event as FridayRealtimeEventName,
    payload: safeJsonParse<FridayRealtimeEventEnvelope["payload"]>(row.payload_json)!,
    emittedAt: row.emitted_at,
    correlationId: row.correlation_id ?? undefined,
    stateVersion: safeJsonParse<FridayRealtimeEventEnvelope["stateVersion"]>(row.state_version_json),
  };
}

// ─── Factory ───

export function createFridayRealtimeEventRepository(): FridayRealtimeEventRepository {
  return {
    append(db, envelope) {
      db.prepare(
        `INSERT INTO realtime_events (event_id, stream_id, seq, event, payload_json, emitted_at, correlation_id, state_version_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        envelope.eventId,
        envelope.streamId,
        envelope.seq,
        envelope.event,
        JSON.stringify(envelope.payload),
        envelope.emittedAt,
        envelope.correlationId ?? null,
        envelope.stateVersion ? JSON.stringify(envelope.stateVersion) : null,
        envelope.emittedAt,
      );
    },

    getNextSeq(db, streamId) {
      const row = db
        .prepare("SELECT MAX(seq) as max_seq FROM realtime_events WHERE stream_id = ?")
        .get(streamId) as { max_seq: number | null };
      return (row.max_seq ?? 0) + 1;
    },

    listAfterSeq(db, streamId, afterSeq, limit) {
      const rows = db
        .prepare(
          "SELECT * FROM realtime_events WHERE stream_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
        )
        .all(streamId, afterSeq, limit) as FridayRealtimeEventRow[];
      return rows.map(rowToEnvelope);
    },

    listByStream(db, streamId, limit) {
      const rows = db
        .prepare(
          "SELECT * FROM realtime_events WHERE stream_id = ? ORDER BY seq ASC LIMIT ?",
        )
        .all(streamId, limit) as FridayRealtimeEventRow[];
      return rows.map(rowToEnvelope);
    },

    deleteOlderThan(db, before) {
      const result = db
        .prepare("DELETE FROM realtime_events WHERE emitted_at < ?")
        .run(before);
      return result.changes;
    },

    getLatestSeq(db, streamId) {
      const row = db
        .prepare("SELECT MAX(seq) as max_seq FROM realtime_events WHERE stream_id = ?")
        .get(streamId) as { max_seq: number | null };
      return row.max_seq ?? 0;
    },
  };
}

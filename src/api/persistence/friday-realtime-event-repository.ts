import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";
import type { FridayRealtimeEventEnvelope, FridayRealtimeEventName } from "../model/friday-api-realtime.types.js";
import { redactEventPayload } from "../realtime/friday-event-payload-redactor.js";
import { FRIDAY_REALTIME_PSEUDONYM_KEY_VERSION } from "../realtime/friday-realtime-pseudonym.js";

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
  /**
   * Pseudonym key version this row's identifiers are opaque under (round-6 P1-3/P1-4
   * durable rewrite provenance). Sink-written rows are born at the current version;
   * NULL marks a legacy row pending the one-time boot rewrite.
   */
  identifier_epoch: number | null;
}

// ─── Repository ───

export interface FridayRealtimeEventRepository {
  append(db: Database.Database, envelope: FridayRealtimeEventEnvelope): void;
  getNextSeq(db: Database.Database, streamId: string): number;
  /**
   * Read events after `afterSeq`. When `ownerId` is supplied the read is
   * owner-scoped (`owner_id = ?`) so a NULL-owner (legacy/sentinel) row and any
   * other owner's row are NEVER returned (fail-closed). Callers on an
   * authenticated read path MUST pass the reader's canonical owner id.
   */
  listAfterSeq(
    db: Database.Database,
    streamId: string,
    afterSeq: number,
    limit: number,
    ownerId?: string,
  ): FridayRealtimeEventEnvelope[];
  listByStream(
    db: Database.Database,
    streamId: string,
    limit: number,
    ownerId?: string,
  ): FridayRealtimeEventEnvelope[];
  deleteOlderThan(db: Database.Database, before: string): number;
  getLatestSeq(db: Database.Database, streamId: string): number;
}

export interface CreateFridayRealtimeEventRepositoryDeps {
  /**
   * Resolve the canonical hub owner id that OWNS every realtime event this repo
   * persists (SEC-EVENT-REDACTION-001 / P0#2). Written to `owner_id` on append.
   * If it resolves to nullish/blank, `owner_id` is written NULL → the row is an
   * inaccessible fail-closed sentinel (never returned by an owner-scoped read).
   */
  resolveOwnerId?: () => string | null | undefined;
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

export function createFridayRealtimeEventRepository(
  deps: CreateFridayRealtimeEventRepositoryDeps = {},
): FridayRealtimeEventRepository {
  function resolveOwnerIdOrNull(): string | null {
    let ownerId: string | null | undefined;
    try {
      ownerId = deps.resolveOwnerId?.();
    } catch {
      ownerId = null;
    }
    // Fail-closed: an unresolvable/blank owner is persisted as NULL so the row is
    // an inaccessible sentinel — never returned by an owner-scoped read.
    return typeof ownerId === "string" && ownerId.trim().length > 0 ? ownerId : null;
  }

  return {
    append(db, envelope) {
      const redactedPayload = redactEventPayload(envelope.payload);
      // Born-current: the sink writes opaque identifiers, so stamp the current
      // pseudonym key version. This is a DURABLE fact that the boot legacy-rewrite
      // reads (round-6 P1-3/P1-4) to skip rows that never need conversion — never a
      // shape check over the value.
      db.prepare(
        `INSERT INTO realtime_events (event_id, stream_id, seq, event, payload_json, emitted_at, correlation_id, state_version_json, created_at, owner_id, identifier_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        envelope.eventId,
        envelope.streamId,
        envelope.seq,
        envelope.event,
        JSON.stringify(redactedPayload),
        envelope.emittedAt,
        envelope.correlationId ?? null,
        envelope.stateVersion ? JSON.stringify(envelope.stateVersion) : null,
        envelope.emittedAt,
        resolveOwnerIdOrNull(),
        FRIDAY_REALTIME_PSEUDONYM_KEY_VERSION,
      );
    },

    getNextSeq(db, streamId) {
      const row = db
        .prepare("SELECT MAX(seq) as max_seq FROM realtime_events WHERE stream_id = ?")
        .get(streamId) as { max_seq: number | null };
      return (row.max_seq ?? 0) + 1;
    },

    listAfterSeq(db, streamId, afterSeq, limit, ownerId) {
      // Owner-scoped when ownerId is provided: `owner_id = ?` excludes NULL-owner
      // (legacy/sentinel) rows and every other owner's rows (fail-closed).
      const rows =
        ownerId === undefined
          ? (db
              .prepare(
                "SELECT * FROM realtime_events WHERE stream_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
              )
              .all(streamId, afterSeq, limit) as FridayRealtimeEventRow[])
          : (db
              .prepare(
                "SELECT * FROM realtime_events WHERE owner_id = ? AND stream_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
              )
              .all(ownerId, streamId, afterSeq, limit) as FridayRealtimeEventRow[]);
      return rows.map(rowToEnvelope);
    },

    listByStream(db, streamId, limit, ownerId) {
      const rows =
        ownerId === undefined
          ? (db
              .prepare(
                "SELECT * FROM realtime_events WHERE stream_id = ? ORDER BY seq ASC LIMIT ?",
              )
              .all(streamId, limit) as FridayRealtimeEventRow[])
          : (db
              .prepare(
                "SELECT * FROM realtime_events WHERE owner_id = ? AND stream_id = ? ORDER BY seq ASC LIMIT ?",
              )
              .all(ownerId, streamId, limit) as FridayRealtimeEventRow[]);
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

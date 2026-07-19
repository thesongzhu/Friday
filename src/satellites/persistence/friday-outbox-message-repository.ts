import type Database from "better-sqlite3";
import type {
  FridayOutboxEnqueueInput,
  FridayOutboxLeasedItem,
  FridayOutboxMessageRow,
  FridayOutboxStatus,
} from "../model/friday-outbox.types.js";

export interface FridayOutboxMessageRepository {
  insertMessage(
    db: Database.Database,
    id: string,
    input: FridayOutboxEnqueueInput,
    nowIso: string,
    /**
     * sha ref over the stable message identity, recorded so a later enqueue that reuses the
     * same `(satellite_id, idempotency_key)` with a DIFFERENT identity can be surfaced as a
     * typed conflict instead of silently resolving to the existing id. Optional/null for
     * legacy callers that do not compute a digest (guard simply does not fire).
     */
    payloadDigest?: string | null,
  ): void;
  leaseBatch(
    db: Database.Database,
    satelliteId: string,
    limit: number,
    leaseUntilIso: string,
    nowIso: string,
    messageTypes?: readonly string[],
  ): FridayOutboxLeasedItem[];
  ackUpToSeq(db: Database.Database, satelliteId: string, seq: number, ackedAt: string): number;
  ackById(db: Database.Database, satelliteId: string, id: string, ackedAt: string): boolean;
  getMessage(db: Database.Database, id: string): FridayOutboxMessageRow | undefined;
  updateStatusAndError(
    db: Database.Database,
    id: string,
    status: FridayOutboxStatus,
    errorCode: string | null,
    errorMessage: string | null,
    deliverAfter: string | null,
    nowIso: string,
  ): void;
  incrementAttempts(db: Database.Database, id: string): void;
  requeueExpiredLeases(db: Database.Database, nowIso: string): number;
  expireByTtl(db: Database.Database, nowIso: string): number;
  deleteTerminalBefore(db: Database.Database, cutoffIso: string): number;
}

export function createFridayOutboxMessageRepository(): FridayOutboxMessageRepository {
  return {
    insertMessage(db, id, input, nowIso, payloadDigest = null) {
      db.prepare(
        `INSERT OR IGNORE INTO outbox_messages (
          id, satellite_id, queue_key, message_type, payload_ciphertext,
          nonce, key_id, idempotency_key, status, max_attempts,
          deliver_after, expires_at, created_at, updated_at, payload_digest,
          logical_payload_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.satelliteId,
        input.queueKey,
        input.messageType,
        input.payloadCiphertext,
        input.nonce,
        input.keyId,
        input.idempotencyKey,
        input.maxAttempts ?? 10,
        input.deliverAfter ?? null,
        input.expiresAt ?? null,
        nowIso,
        nowIso,
        payloadDigest,
        input.logicalPayloadDigest,
      );
    },

    leaseBatch(db, satelliteId, limit, leaseUntilIso, nowIso, messageTypes) {
      // Select eligible messages: queued, deliver_after satisfied, not expired
      const filteredMessageTypes = (messageTypes ?? []).filter((type) => type.trim().length > 0);
      if (messageTypes !== undefined && filteredMessageTypes.length === 0) {
        return [];
      }
      const messageTypeClause = filteredMessageTypes.length > 0
        ? `AND message_type IN (${filteredMessageTypes.map(() => "?").join(", ")})`
        : "";
      const rows = db
        .prepare(
          `SELECT id, rowid AS seq, payload_ciphertext, message_type
           FROM outbox_messages
           WHERE satellite_id = ?
             AND status = 'queued'
             ${messageTypeClause}
             AND (deliver_after IS NULL OR deliver_after <= ?)
             AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY created_at ASC
           LIMIT ?`,
        )
        .all(satelliteId, ...filteredMessageTypes, nowIso, nowIso, limit) as Array<{
        id: string;
        seq: number;
        payload_ciphertext: string;
        message_type: string;
      }>;

      if (rows.length === 0) return [];

      const update = db.prepare(
        "UPDATE outbox_messages SET status = 'leased', leased_until = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?",
      );
      for (const row of rows) {
        update.run(leaseUntilIso, nowIso, row.id);
      }

      return rows.map((r) => ({
        id: r.id,
        seq: r.seq,
        payloadCiphertext: r.payload_ciphertext,
        messageType: r.message_type,
      }));
    },

    ackUpToSeq(db, satelliteId, seq, ackedAt) {
      const result = db
        .prepare(
          `UPDATE outbox_messages
           SET status = 'acked', acked_at = ?, leased_until = NULL, updated_at = ?
           WHERE satellite_id = ? AND status = 'leased' AND rowid <= ?`,
        )
        .run(ackedAt, ackedAt, satelliteId, seq);
      return result.changes;
    },

    ackById(db, satelliteId, id, ackedAt) {
      const result = db
        .prepare(
          `UPDATE outbox_messages
           SET status = 'acked', acked_at = ?, leased_until = NULL, updated_at = ?
           WHERE id = ? AND satellite_id = ? AND status = 'leased'`,
        )
        .run(ackedAt, ackedAt, id, satelliteId);
      return result.changes > 0;
    },

    getMessage(db, id) {
      return db
        .prepare("SELECT * FROM outbox_messages WHERE id = ?")
        .get(id) as FridayOutboxMessageRow | undefined;
    },

    updateStatusAndError(db, id, status, errorCode, errorMessage, deliverAfter, nowIso) {
      db.prepare(
        `UPDATE outbox_messages
         SET status = ?, last_error_code = ?, last_error_message = ?,
             deliver_after = ?, leased_until = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(status, errorCode, errorMessage, deliverAfter, nowIso, id);
    },

    incrementAttempts(db, id) {
      db.prepare("UPDATE outbox_messages SET attempts = attempts + 1 WHERE id = ?").run(id);
    },

    requeueExpiredLeases(db, nowIso) {
      const result = db
        .prepare(
          `UPDATE outbox_messages
           SET status = 'queued', leased_until = NULL, updated_at = ?
           WHERE status = 'leased' AND leased_until < ?`,
        )
        .run(nowIso, nowIso);
      return result.changes;
    },

    expireByTtl(db, nowIso) {
      const result = db
        .prepare(
          `UPDATE outbox_messages
           SET status = 'expired', updated_at = ?
           WHERE status IN ('queued', 'failed', 'leased') AND expires_at IS NOT NULL AND expires_at <= ?`,
        )
        .run(nowIso, nowIso);
      return result.changes;
    },

    deleteTerminalBefore(db, cutoffIso) {
      const result = db
        .prepare(
          "DELETE FROM outbox_messages WHERE status IN ('acked', 'dead_letter', 'expired') AND updated_at < ?",
        )
        .run(cutoffIso);
      return result.changes;
    },
  };
}

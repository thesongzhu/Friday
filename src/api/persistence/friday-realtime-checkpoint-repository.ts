import type Database from "better-sqlite3";

// ─── Row type ───

export interface FridayRealtimeCheckpointRow {
  principal_id: string;
  stream_id: string;
  last_acked_seq: number;
  epoch: number;
  cursor: string | null;
  updated_at: string;
}

// ─── Repository ───

export interface FridayRealtimeCheckpointRepository {
  get(
    db: Database.Database,
    principalId: string,
    streamId: string,
  ): FridayRealtimeCheckpointRow | null;
  upsert(
    db: Database.Database,
    principalId: string,
    streamId: string,
    seq: number,
    epoch: number,
    cursor: string | undefined,
    now: string,
  ): void;
}

// ─── Factory ───

export function createFridayRealtimeCheckpointRepository(): FridayRealtimeCheckpointRepository {
  return {
    get(db, principalId, streamId) {
      return (
        (db
          .prepare(
            "SELECT * FROM realtime_checkpoints WHERE principal_id = ? AND stream_id = ?",
          )
          .get(principalId, streamId) as FridayRealtimeCheckpointRow | undefined) ?? null
      );
    },

    upsert(db, principalId, streamId, seq, epoch, cursor, now) {
      const existing = db
        .prepare(
          "SELECT last_acked_seq FROM realtime_checkpoints WHERE principal_id = ? AND stream_id = ?",
        )
        .get(principalId, streamId) as { last_acked_seq: number } | undefined;

      if (existing) {
        // Monotonic ack: only update if seq is higher
        if (seq > existing.last_acked_seq) {
          db.prepare(
            "UPDATE realtime_checkpoints SET last_acked_seq = ?, epoch = ?, cursor = ?, updated_at = ? WHERE principal_id = ? AND stream_id = ?",
          ).run(seq, epoch, cursor ?? null, now, principalId, streamId);
        }
      } else {
        db.prepare(
          "INSERT INTO realtime_checkpoints (principal_id, stream_id, last_acked_seq, epoch, cursor, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(principalId, streamId, seq, epoch, cursor ?? null, now);
      }
    },
  };
}

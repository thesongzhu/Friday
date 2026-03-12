import type Database from "better-sqlite3";

/**
 * Manages protocol epoch and per-stream ack checkpoints
 * using the hub_settings table.
 */
export interface FridayStreamCheckpointRepository {
  getEpoch(db: Database.Database): number;
  bumpEpoch(db: Database.Database, nowIso: string): number;
  getLastAckedSeq(db: Database.Database, satelliteId: string, streamId: string): number;
  setLastAckedSeq(
    db: Database.Database,
    input: { satelliteId: string; streamId: string; seq: number; nowIso: string },
  ): void;
}

const EPOCH_KEY = "protocol_epoch";

function checkpointKey(satelliteId: string, streamId: string): string {
  return `ack_checkpoint:${satelliteId}:${streamId}`;
}

export function createFridayStreamCheckpointRepository(): FridayStreamCheckpointRepository {
  return {
    getEpoch(db) {
      const row = db
        .prepare("SELECT value_json FROM hub_settings WHERE key = ?")
        .get(EPOCH_KEY) as { value_json: string } | undefined;
      if (!row) return 0;
      return JSON.parse(row.value_json) as number;
    },

    bumpEpoch(db, nowIso) {
      const current = this.getEpoch(db);
      const next = current + 1;
      db.prepare(
        `INSERT INTO hub_settings (key, value_json, revision, created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, 1, ?, ?, NULL, NULL)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           revision = hub_settings.revision + 1,
           updated_at = excluded.updated_at`,
      ).run(EPOCH_KEY, JSON.stringify(next), nowIso, nowIso);
      return next;
    },

    getLastAckedSeq(db, satelliteId, streamId) {
      const key = checkpointKey(satelliteId, streamId);
      const row = db
        .prepare("SELECT value_json FROM hub_settings WHERE key = ?")
        .get(key) as { value_json: string } | undefined;
      if (!row) return 0;
      return JSON.parse(row.value_json) as number;
    },

    setLastAckedSeq(db, input) {
      const key = checkpointKey(input.satelliteId, input.streamId);
      db.prepare(
        `INSERT INTO hub_settings (key, value_json, revision, created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, 1, ?, ?, NULL, NULL)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           revision = hub_settings.revision + 1,
           updated_at = excluded.updated_at`,
      ).run(key, JSON.stringify(input.seq), input.nowIso, input.nowIso);
    },
  };
}

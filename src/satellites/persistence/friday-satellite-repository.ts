import type Database from "better-sqlite3";
import type {
  FridaySatellitePairingStatus,
  FridaySatelliteRegistrationInput,
  FridaySatelliteRow,
} from "../model/friday-satellite.types.js";

export interface FridaySatelliteRepository {
  insertSatellite(db: Database.Database, input: InsertSatelliteInput): void;
  getSatellite(db: Database.Database, id: string): FridaySatelliteRow | undefined;
  updatePairingStatus(
    db: Database.Database,
    id: string,
    status: FridaySatellitePairingStatus,
    nowIso: string,
  ): void;
  updateLastSeen(db: Database.Database, id: string, nowIso: string): void;
  incrementTokenVersion(db: Database.Database, id: string, nowIso: string): void;
  listByStatus(
    db: Database.Database,
    statuses: FridaySatellitePairingStatus[],
  ): FridaySatelliteRow[];
}

export interface InsertSatelliteInput {
  id: string;
  registration: FridaySatelliteRegistrationInput;
  nowIso: string;
}

export function createFridaySatelliteRepository(): FridaySatelliteRepository {
  return {
    insertSatellite(db, input) {
      const { id, registration: r, nowIso } = input;
      db.prepare(
        `INSERT INTO satellites (
          id, type, display_name, pairing_status, trust_level, public_key,
          token_version, transport, platform, arch, app_version, node_version,
          tags_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', 'restricted', ?, 1, ?, ?, ?, ?, ?, '[]', ?, ?)`,
      ).run(
        id,
        r.type,
        r.displayName,
        r.publicKey,
        r.transport,
        r.runtime.platform,
        r.runtime.arch,
        r.runtime.appVersion,
        r.runtime.nodeVersion,
        nowIso,
        nowIso,
      );
    },

    getSatellite(db, id) {
      return db
        .prepare("SELECT * FROM satellites WHERE id = ? AND deleted_at IS NULL")
        .get(id) as FridaySatelliteRow | undefined;
    },

    updatePairingStatus(db, id, status, nowIso) {
      db.prepare(
        "UPDATE satellites SET pairing_status = ?, updated_at = ? WHERE id = ?",
      ).run(status, nowIso, id);
    },

    updateLastSeen(db, id, nowIso) {
      db.prepare(
        "UPDATE satellites SET last_seen_at = ?, updated_at = ? WHERE id = ?",
      ).run(nowIso, nowIso, id);
    },

    incrementTokenVersion(db, id, nowIso) {
      db.prepare(
        "UPDATE satellites SET token_version = token_version + 1, updated_at = ? WHERE id = ?",
      ).run(nowIso, id);
    },

    listByStatus(db, statuses) {
      const placeholders = statuses.map(() => "?").join(", ");
      return db
        .prepare(
          `SELECT * FROM satellites WHERE pairing_status IN (${placeholders}) AND deleted_at IS NULL`,
        )
        .all(...statuses) as FridaySatelliteRow[];
    },
  };
}

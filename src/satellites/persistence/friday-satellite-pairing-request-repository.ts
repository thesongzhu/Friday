import type Database from "better-sqlite3";
import type { FridaySatellitePairingRequestRow } from "../model/friday-satellite.types.js";

export interface InsertPairingRequestInput {
  id: string;
  satelliteId: string;
  code: string;
  nonce: string;
  requestedByIp?: string;
  requestedByUserAgent?: string;
  expiresAt: string;
  nowIso: string;
}

export interface FridaySatellitePairingRequestRepository {
  insertRequest(db: Database.Database, input: InsertPairingRequestInput): void;
  getRequest(db: Database.Database, id: string): FridaySatellitePairingRequestRow | undefined;
  getRequestBySatelliteId(
    db: Database.Database,
    satelliteId: string,
    status: string,
  ): FridaySatellitePairingRequestRow | undefined;
  updateStatus(
    db: Database.Database,
    id: string,
    status: "approved" | "rejected" | "expired",
    resolverUserId: string | null,
    nowIso: string,
  ): void;
  listPendingExpiredBefore(db: Database.Database, cutoffIso: string): FridaySatellitePairingRequestRow[];
  deleteResolvedBefore(db: Database.Database, cutoffIso: string): number;
}

export function createFridaySatellitePairingRequestRepository(): FridaySatellitePairingRequestRepository {
  return {
    insertRequest(db, input) {
      db.prepare(
        `INSERT INTO satellite_pairing_requests (
          id, satellite_id, code, nonce, requested_by_ip, requested_by_user_agent,
          status, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      ).run(
        input.id,
        input.satelliteId,
        input.code,
        input.nonce,
        input.requestedByIp ?? null,
        input.requestedByUserAgent ?? null,
        input.expiresAt,
        input.nowIso,
        input.nowIso,
      );
    },

    getRequest(db, id) {
      return db
        .prepare("SELECT * FROM satellite_pairing_requests WHERE id = ?")
        .get(id) as FridaySatellitePairingRequestRow | undefined;
    },

    getRequestBySatelliteId(db, satelliteId, status) {
      return db
        .prepare(
          "SELECT * FROM satellite_pairing_requests WHERE satellite_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(satelliteId, status) as FridaySatellitePairingRequestRow | undefined;
    },

    updateStatus(db, id, status, resolverUserId, nowIso) {
      db.prepare(
        `UPDATE satellite_pairing_requests
         SET status = ?, resolved_at = ?, resolver_user_id = ?, updated_at = ?
         WHERE id = ?`,
      ).run(status, nowIso, resolverUserId, nowIso, id);
    },

    listPendingExpiredBefore(db, cutoffIso) {
      return db
        .prepare(
          "SELECT * FROM satellite_pairing_requests WHERE status = 'pending' AND expires_at < ?",
        )
        .all(cutoffIso) as FridaySatellitePairingRequestRow[];
    },

    deleteResolvedBefore(db, cutoffIso) {
      const result = db
        .prepare(
          "DELETE FROM satellite_pairing_requests WHERE status IN ('approved', 'rejected', 'expired') AND updated_at < ?",
        )
        .run(cutoffIso);
      return result.changes;
    },
  };
}

import type Database from "better-sqlite3";
import type { FridayApiTokenRow } from "../model/friday-satellite.types.js";

export interface InsertApiTokenInput {
  id: string;
  userId: string | null;
  principalType: string;
  label: string;
  tokenHash: string;
  scopes: string[];
  expiresAt?: string;
  nowIso: string;
}

export interface FridayApiTokenRepository {
  insertToken(db: Database.Database, input: InsertApiTokenInput): void;
  getByHash(db: Database.Database, tokenHash: string, nowIso?: string): FridayApiTokenRow | undefined;
  revokeAllForSatellite(db: Database.Database, satelliteId: string, nowIso: string): number;
}

export function createFridayApiTokenRepository(): FridayApiTokenRepository {
  return {
    insertToken(db, input) {
      db.prepare(
        `INSERT INTO api_tokens (
          id, user_id, principal_type, label, token_hash,
          scopes_json, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.userId,
        input.principalType,
        input.label,
        input.tokenHash,
        JSON.stringify(input.scopes),
        input.expiresAt ?? null,
        input.nowIso,
        input.nowIso,
      );
    },

    getByHash(db, tokenHash, nowIso?) {
      const now = nowIso ?? new Date().toISOString();
      return db
        .prepare(
          "SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
        )
        .get(tokenHash, now) as FridayApiTokenRow | undefined;
    },

    revokeAllForSatellite(db, satelliteId, nowIso) {
      // Revoke tokens where the label contains the satellite ID
      // (tokens are labeled "satellite:<satelliteId>")
      const result = db
        .prepare(
          `UPDATE api_tokens
           SET revoked_at = ?, updated_at = ?
           WHERE principal_type = 'satellite'
             AND label LIKE ?
             AND revoked_at IS NULL`,
        )
        .run(nowIso, nowIso, `satellite:${satelliteId}%`);
      return result.changes;
    },
  };
}

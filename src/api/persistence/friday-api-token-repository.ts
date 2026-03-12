import type Database from "better-sqlite3";
import type { FridayApiTokenRow } from "#satellites";

// ─── Repository ───

export interface FridayRevokedAccessTokenRow {
  token_id: string;
  expires_at_epoch: number;
  revoked_at: string;
}

export interface FridayApiTokenRepository {
  findById(db: Database.Database, tokenId: string): FridayApiTokenRow | null;
  isRevoked(db: Database.Database, tokenId: string): boolean;
  revoke(db: Database.Database, tokenId: string, now: string): boolean;
  listActive(db: Database.Database, limit?: number): FridayApiTokenRow[];
  countActive(db: Database.Database): number;
  countExpired(db: Database.Database, now: string): number;
  countRevokedSince(db: Database.Database, since: string): number;
  countHighPrivilegeActive(db: Database.Database, now: string): number;

  /** Persist an access token revocation (SEC-005). */
  revokeAccessToken(db: Database.Database, tokenId: string, expSec: number, now: string): void;
  /** Check if an access token has been revoked (SEC-005). */
  isAccessTokenRevoked(db: Database.Database, tokenId: string): boolean;
  /** Load all non-expired revoked access tokens (SEC-005). */
  loadRevokedAccessTokens(db: Database.Database, nowEpochSec: number): FridayRevokedAccessTokenRow[];
  /** Purge expired revoked access token entries (SEC-005). */
  purgeExpiredAccessTokenRevocations(db: Database.Database, nowEpochSec: number): number;
}

// ─── Factory ───

export function createFridayApiTokenRepository(): FridayApiTokenRepository {
  return {
    findById(db, tokenId) {
      return (
        (db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(tokenId) as
          | FridayApiTokenRow
          | undefined) ?? null
      );
    },

    isRevoked(db, tokenId) {
      const row = db
        .prepare("SELECT revoked_at FROM api_tokens WHERE id = ?")
        .get(tokenId) as { revoked_at: string | null } | undefined;
      return row?.revoked_at !== null && row?.revoked_at !== undefined;
    },

    revoke(db, tokenId, now) {
      const result = db
        .prepare("UPDATE api_tokens SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(now, now, tokenId);
      return result.changes > 0;
    },

    listActive(db, limit = 100) {
      return db
        .prepare(
          "SELECT * FROM api_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT ?",
        )
        .all(limit) as FridayApiTokenRow[];
    },

    countActive(db) {
      const row = db
        .prepare("SELECT COUNT(*) as count FROM api_tokens WHERE revoked_at IS NULL")
        .get() as { count: number };
      return row.count;
    },

    countExpired(db, now) {
      const row = db
        .prepare(
          "SELECT COUNT(*) as count FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at < ? AND revoked_at IS NULL",
        )
        .get(now) as { count: number };
      return row.count;
    },

    countRevokedSince(db, since) {
      const row = db
        .prepare("SELECT COUNT(*) as count FROM api_tokens WHERE revoked_at IS NOT NULL AND revoked_at >= ?")
        .get(since) as { count: number };
      return row.count;
    },

    countHighPrivilegeActive(db, now) {
      // High privilege = tokens with hub.admin or security.write scope
      const rows = db
        .prepare(
          "SELECT scopes_json FROM api_tokens WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
        )
        .all(now) as Array<{ scopes_json: string }>;

      return rows.filter((row) => {
        const scopes = JSON.parse(row.scopes_json) as string[];
        return scopes.includes("hub.admin") || scopes.includes("security.write");
      }).length;
    },

    revokeAccessToken(db, tokenId, expSec, now) {
      db.prepare(
        "INSERT OR IGNORE INTO revoked_access_tokens (token_id, expires_at_epoch, revoked_at) VALUES (?, ?, ?)",
      ).run(tokenId, expSec, now);
    },

    isAccessTokenRevoked(db, tokenId) {
      const row = db
        .prepare("SELECT token_id FROM revoked_access_tokens WHERE token_id = ?")
        .get(tokenId) as { token_id: string } | undefined;
      return row !== undefined;
    },

    loadRevokedAccessTokens(db, nowEpochSec) {
      return db
        .prepare(
          "SELECT token_id, expires_at_epoch, revoked_at FROM revoked_access_tokens WHERE expires_at_epoch >= ?",
        )
        .all(nowEpochSec) as FridayRevokedAccessTokenRow[];
    },

    purgeExpiredAccessTokenRevocations(db, nowEpochSec) {
      const result = db
        .prepare("DELETE FROM revoked_access_tokens WHERE expires_at_epoch < ?")
        .run(nowEpochSec);
      return result.changes;
    },
  };
}

import type Database from "better-sqlite3";

// ─── Row type ───

export interface FridayAuthSessionRow {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  expires_at: string;
  revoked_at: string | null;
  device_label: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Repository ───

export interface FridayAuthSessionRepository {
  findById(db: Database.Database, sessionId: string): FridayAuthSessionRow | null;
  findByRefreshHash(db: Database.Database, hash: string, now: string): FridayAuthSessionRow | null;
  findByRefreshHashAny(db: Database.Database, hash: string): FridayAuthSessionRow | null;
  create(db: Database.Database, input: FridayCreateAuthSessionInput): void;
  revokeById(db: Database.Database, sessionId: string, now: string): void;
  revokeAllForUser(db: Database.Database, userId: string, now: string): void;
  /**
   * Atomically updates the refresh hash using compare-and-swap.
   * Returns the number of rows changed. If 0, the old hash didn't match (potential replay).
   */
  updateRefreshHash(db: Database.Database, sessionId: string, newHash: string, expiresAt: string, now: string): void;
  /**
   * Atomically updates the refresh hash only if the current hash matches `oldHash`.
   * Returns true if the swap succeeded, false if the old hash didn't match (concurrent replay).
   */
  compareAndSwapRefreshHash(
    db: Database.Database,
    sessionId: string,
    oldHash: string,
    newHash: string,
    expiresAt: string,
    now: string,
  ): boolean;
}

export interface FridayCreateAuthSessionInput {
  id: string;
  userId: string;
  refreshTokenHash: string;
  expiresAt: string;
  deviceLabel?: string;
  ipAddress?: string;
  userAgent?: string;
  now: string;
}

// ─── Factory ───

export function createFridayAuthSessionRepository(): FridayAuthSessionRepository {
  return {
    findById(db, sessionId) {
      return (
        (db
          .prepare("SELECT * FROM auth_sessions WHERE id = ?")
          .get(sessionId) as FridayAuthSessionRow | undefined) ?? null
      );
    },

    findByRefreshHash(db, hash, now) {
      return (
        (db
          .prepare(
            "SELECT * FROM auth_sessions WHERE refresh_token_hash = ? AND revoked_at IS NULL AND expires_at > ?",
          )
          .get(hash, now) as FridayAuthSessionRow | undefined) ?? null
      );
    },

    findByRefreshHashAny(db, hash) {
      return (
        (db
          .prepare("SELECT * FROM auth_sessions WHERE refresh_token_hash = ?")
          .get(hash) as FridayAuthSessionRow | undefined) ?? null
      );
    },

    create(db, input) {
      db.prepare(
        `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at, device_label, ip_address, user_agent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.userId,
        input.refreshTokenHash,
        input.expiresAt,
        input.deviceLabel ?? null,
        input.ipAddress ?? null,
        input.userAgent ?? null,
        input.now,
        input.now,
      );
    },

    revokeById(db, sessionId, now) {
      db.prepare("UPDATE auth_sessions SET revoked_at = ?, updated_at = ? WHERE id = ?").run(
        now,
        now,
        sessionId,
      );
    },

    revokeAllForUser(db, userId, now) {
      db.prepare(
        "UPDATE auth_sessions SET revoked_at = ?, updated_at = ? WHERE user_id = ? AND revoked_at IS NULL",
      ).run(now, now, userId);
    },

    updateRefreshHash(db, sessionId, newHash, expiresAt, now) {
      db.prepare(
        "UPDATE auth_sessions SET refresh_token_hash = ?, expires_at = ?, updated_at = ? WHERE id = ?",
      ).run(newHash, expiresAt, now, sessionId);
    },

    compareAndSwapRefreshHash(db, sessionId, oldHash, newHash, expiresAt, now) {
      const result = db.prepare(
        "UPDATE auth_sessions SET refresh_token_hash = ?, expires_at = ?, updated_at = ? WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL",
      ).run(newHash, expiresAt, now, sessionId, oldHash);
      return result.changes > 0;
    },
  };
}

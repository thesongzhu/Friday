import type Database from "better-sqlite3";

// ─── Row type ───

export interface FridayUserRow {
  id: string;
  email: string | null;
  display_name: string;
  role: string;
  password_hash: string | null;
  is_local_only: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

// ─── Repository interface ───

export interface FridayUserRepository {
  findById(db: Database.Database, userId: string): FridayUserRow | null;
  findByEmail(db: Database.Database, email: string): FridayUserRow | null;
  findLocalUser(db: Database.Database): FridayUserRow | null;
}

// ─── Factory ───

export function createFridayUserRepository(): FridayUserRepository {
  return {
    findById(db, userId) {
      return (
        (db
          .prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL")
          .get(userId) as FridayUserRow | undefined) ?? null
      );
    },

    findByEmail(db, email) {
      return (
        (db
          .prepare("SELECT * FROM users WHERE email = ? AND deleted_at IS NULL")
          .get(email) as FridayUserRow | undefined) ?? null
      );
    },

    findLocalUser(db) {
      return (
        (db
          .prepare("SELECT * FROM users WHERE is_local_only = 1 AND deleted_at IS NULL LIMIT 1")
          .get() as FridayUserRow | undefined) ?? null
      );
    },
  };
}

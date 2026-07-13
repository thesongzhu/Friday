import type Database from "better-sqlite3";

import type { FridaySecretRow } from "../model/friday-provider.types.js";
import type { FridaySecretAadContext } from "../security/friday-secret-crypto.js";

// ─── AAD context binding (SEC-SECRET-AAD-001) ───

/** Logical store namespace bound into every `secrets`-table AAD context. */
export const FRIDAY_SECRETS_AAD_STORE = "friday-secrets"; // pragma: allowlist secret

/**
 * Canonical AAD binding context for a `secrets` table row.
 *
 * Binds the STABLE primary key (`id`) and `scope`. The `id` is durable across
 * `ref_key` renames and (because every writer's `id` is either insert-only or a
 * deterministic function of its ref) always equals the persisted row's `id`, so
 * writer and reader reconstruct byte-identical AAD. A ciphertext moved to a
 * different row (different `id`) therefore fails to decrypt (fail-closed).
 */
export function fridaySecretAadContext(entity: {
  readonly scope: string;
  readonly id: string;
}): FridaySecretAadContext {
  return { store: FRIDAY_SECRETS_AAD_STORE, scope: entity.scope, ref: entity.id };
}

// ─── Repository interface ───

export interface FridaySecretEntity {
  id: string;
  scope: string;
  refKey: string;
  encryptedValue: string;
  keyId: string;
  expiresAt?: string;
  rotatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridaySecretRepository {
  getById(
    db: Database.Database,
    id: string,
  ): FridaySecretEntity | null;

  getByRef(
    db: Database.Database,
    scope: string,
    refKey: string,
  ): FridaySecretEntity | null;

  list(
    db: Database.Database,
    input?: {
      scope?: string;
      refKey?: string;
      limit?: number;
    },
  ): FridaySecretEntity[];

  upsert(
    db: Database.Database,
    input: {
      id: string;
      scope: string;
      refKey: string;
      encryptedValue: string;
      keyId: string;
      expiresAt?: string;
      nowIso: string;
    },
  ): void;

  updateById(
    db: Database.Database,
    input: {
      secretId: string;
      refKey?: string;
      encryptedValue?: string;
      keyId?: string;
      expiresAt?: string | null;
      nowIso: string;
    },
  ): FridaySecretEntity | null;

  deleteByRef(
    db: Database.Database,
    scope: string,
    refKey: string,
  ): boolean;

  deleteById(
    db: Database.Database,
    secretId: string,
  ): boolean;
}

// ─── Row → Entity mapping ───

function rowToEntity(row: FridaySecretRow): FridaySecretEntity {
  return {
    id: row.id,
    scope: row.scope,
    refKey: row.ref_key,
    encryptedValue: row.encrypted_value,
    keyId: row.key_id,
    expiresAt: row.expires_at ?? undefined,
    rotatedAt: row.rotated_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Factory ───

export function createFridaySecretRepository(): FridaySecretRepository {
  return {
    getById(db, id) {
      const row = db
        .prepare("SELECT * FROM secrets WHERE id = ?")
        .get(id) as FridaySecretRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    getByRef(db, scope, refKey) {
      const row = db
        .prepare("SELECT * FROM secrets WHERE scope = ? AND ref_key = ?")
        .get(scope, refKey) as FridaySecretRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    list(db, input) {
      const clauses: string[] = [];
      const params: unknown[] = [];

      if (input?.scope) {
        clauses.push("scope = ?");
        params.push(input.scope);
      }
      if (input?.refKey) {
        clauses.push("ref_key LIKE ?");
        params.push(`%${input.refKey}%`);
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const limit = Math.max(1, Math.min(input?.limit ?? 100, 200));
      const rows = db
        .prepare(
          `SELECT * FROM secrets
           ${where}
           ORDER BY updated_at DESC, id DESC
           LIMIT ?`,
        )
        .all(...params, limit) as FridaySecretRow[];
      return rows.map(rowToEntity);
    },

    upsert(db, input) {
      const existing = db
        .prepare("SELECT id FROM secrets WHERE scope = ? AND ref_key = ?")
        .get(input.scope, input.refKey) as { id: string } | undefined;

      if (existing) {
        db.prepare(
          `UPDATE secrets
           SET encrypted_value = ?, key_id = ?, expires_at = ?, rotated_at = ?, updated_at = ?
           WHERE scope = ? AND ref_key = ?`,
        ).run(
          input.encryptedValue,
          input.keyId,
          input.expiresAt ?? null,
          input.nowIso,
          input.nowIso,
          input.scope,
          input.refKey,
        );
      } else {
        db.prepare(
          `INSERT INTO secrets
           (id, scope, ref_key, encrypted_value, key_id, expires_at, rotated_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        ).run(
          input.id,
          input.scope,
          input.refKey,
          input.encryptedValue,
          input.keyId,
          input.expiresAt ?? null,
          input.nowIso,
          input.nowIso,
        );
      }
    },

    updateById(db, input) {
      const existing = db
        .prepare("SELECT * FROM secrets WHERE id = ?")
        .get(input.secretId) as FridaySecretRow | undefined;
      if (!existing) {
        return null;
      }

      const nextRefKey = input.refKey ?? existing.ref_key;
      const nextEncryptedValue = input.encryptedValue ?? existing.encrypted_value;
      const nextKeyId = input.keyId ?? existing.key_id;
      const nextExpiresAt =
        input.expiresAt === undefined ? existing.expires_at : input.expiresAt;
      const rotatedAt = input.encryptedValue ? input.nowIso : existing.rotated_at;

      db.prepare(
        `UPDATE secrets
         SET ref_key = ?, encrypted_value = ?, key_id = ?, expires_at = ?, rotated_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        nextRefKey,
        nextEncryptedValue,
        nextKeyId,
        nextExpiresAt ?? null,
        rotatedAt ?? null,
        input.nowIso,
        input.secretId,
      );

      return this.getById(db, input.secretId);
    },

    deleteByRef(db, scope, refKey) {
      const result = db
        .prepare("DELETE FROM secrets WHERE scope = ? AND ref_key = ?")
        .run(scope, refKey);
      return result.changes > 0;
    },

    deleteById(db, secretId) {
      const result = db
        .prepare("DELETE FROM secrets WHERE id = ?")
        .run(secretId);
      return result.changes > 0;
    },
  };
}

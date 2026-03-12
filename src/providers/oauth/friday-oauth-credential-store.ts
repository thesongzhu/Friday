/**
 * SQLite-backed OAuth credential storage with envelope encryption.
 */

import type { FridaySqliteLayer } from "#state";

import type {
  FridayOAuthCredential,
  FridayOAuthCredentialRow,
  FridayOAuthProviderId,
  FridayOAuthTokenSet,
} from "../model/friday-provider.types.js";

import {
  decryptSecret,
  encryptSecret,
  getMasterKey,
} from "../security/friday-secret-crypto.js";
import type { FridayEncryptedEnvelope } from "../security/friday-secret-crypto.js";

// ─── Store interface ───

export interface FridayOAuthCredentialStore {
  /** Reads and decrypts OAuth credentials for a provider profile. */
  getByProviderProfileId(providerProfileId: string): FridayOAuthCredential | null;
  /** Inserts or updates OAuth credentials for a provider profile. */
  upsert(input: {
    providerProfileId: string;
    oauthProvider: FridayOAuthProviderId;
    tokenSet: FridayOAuthTokenSet;
  }): FridayOAuthCredential;
  /** Deletes OAuth credentials bound to a provider profile. */
  deleteByProviderProfileId(providerProfileId: string): boolean;
}

export interface CreateFridayOAuthCredentialStoreDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
}

// ─── Row ↔ Entity mapping ───

function parseEnvelope(raw: string, field: string): FridayEncryptedEnvelope {
  try {
    return JSON.parse(raw) as FridayEncryptedEnvelope;
  } catch {
    throw new Error(`OAuth credential row has invalid JSON in ${field}`);
  }
}

function rowToCredential(row: FridayOAuthCredentialRow): FridayOAuthCredential {
  const masterKey = getMasterKey();
  const accessEnvelope = parseEnvelope(row.access_token_encrypted, "access_token_encrypted");
  const refreshEnvelope = parseEnvelope(row.refresh_token_encrypted, "refresh_token_encrypted");

  return {
    id: row.id,
    providerProfileId: row.provider_profile_id,
    oauthProvider: row.oauth_provider as FridayOAuthProviderId,
    accessToken: decryptSecret(accessEnvelope, masterKey),
    refreshToken: decryptSecret(refreshEnvelope, masterKey),
    tokenType: row.token_type,
    scope: row.scope,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Factory ───

/** Creates SQLite-backed OAuth credential storage with envelope encryption. */
export function createFridayOAuthCredentialStore(
  deps: CreateFridayOAuthCredentialStoreDeps,
): FridayOAuthCredentialStore {
  return {
    getByProviderProfileId(providerProfileId) {
      const row = deps.db.withReadConnection((db) =>
        db
          .prepare(
            `SELECT id, provider_profile_id, oauth_provider,
                    access_token_encrypted, refresh_token_encrypted,
                    token_type, scope, expires_at, created_at, updated_at
             FROM oauth_credentials
             WHERE provider_profile_id = ?`,
          )
          .get(providerProfileId) as FridayOAuthCredentialRow | undefined,
      );
      if (!row) return null;
      return rowToCredential(row);
    },

    upsert(input) {
      const masterKey = getMasterKey();
      const accessEncrypted = JSON.stringify(
        encryptSecret(input.tokenSet.accessToken, masterKey),
      );
      const refreshEncrypted = JSON.stringify(
        encryptSecret(input.tokenSet.refreshToken, masterKey),
      );
      const now = deps.nowIso();
      const id = deps.idGenerator();

      deps.db.withWriteTransaction((db) => {
        db.prepare(
          `INSERT INTO oauth_credentials
             (id, provider_profile_id, oauth_provider,
              access_token_encrypted, refresh_token_encrypted,
              token_type, scope, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider_profile_id, oauth_provider)
           DO UPDATE SET
             access_token_encrypted = excluded.access_token_encrypted,
             refresh_token_encrypted = excluded.refresh_token_encrypted,
             token_type = excluded.token_type,
             scope = excluded.scope,
             expires_at = excluded.expires_at,
             updated_at = excluded.updated_at`,
        ).run(
          id,
          input.providerProfileId,
          input.oauthProvider,
          accessEncrypted,
          refreshEncrypted,
          input.tokenSet.tokenType,
          input.tokenSet.scope,
          input.tokenSet.expiresAt,
          now,
          now,
        );
      });

      // Re-read to get the actual persisted row (may use existing id on conflict)
      const stored = this.getByProviderProfileId(input.providerProfileId);
      if (!stored) {
        throw new Error("Failed to read back OAuth credential after upsert");
      }
      return stored;
    },

    deleteByProviderProfileId(providerProfileId) {
      let deleted = false;
      deps.db.withWriteTransaction((db) => {
        const result = db
          .prepare("DELETE FROM oauth_credentials WHERE provider_profile_id = ?")
          .run(providerProfileId);
        deleted = result.changes > 0;
      });
      return deleted;
    },
  };
}

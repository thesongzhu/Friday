/**
 * SQLite-backed OAuth credential storage with envelope encryption.
 */

import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";

import type {
  FridayOAuthCredential,
  FridayOAuthCredentialRow,
  FridayOAuthProviderId,
  FridayOAuthTokenSet,
} from "../model/friday-provider.types.js";
import { FRIDAY_GLOBAL_OAUTH_OWNER_USER_ID } from "../model/friday-provider.types.js";

import {
  decryptSecret,
  encryptSecret,
  getMasterKey,
} from "../security/friday-secret-crypto.js";
import type { FridayEncryptedEnvelope } from "../security/friday-secret-crypto.js";

// ─── Store interface ───

export interface FridayOAuthCredentialStore {
  /** Reads and decrypts OAuth credentials for a provider profile. */
  getByProviderProfileId(
    providerProfileId: string,
    ownerUserId?: string,
    oauthProvider?: FridayOAuthProviderId,
  ): FridayOAuthCredential | null;
  /** Inserts or updates OAuth credentials for a provider profile. */
  upsert(input: {
    providerProfileId: string;
    ownerUserId?: string;
    oauthProvider: FridayOAuthProviderId;
    tokenSet: FridayOAuthTokenSet;
  }): FridayOAuthCredential;
  /** Deletes OAuth credentials bound to a provider profile. */
  deleteByProviderProfileId(providerProfileId: string, ownerUserId?: string): boolean;
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
  } catch (err) {
    console.warn("[friday][oauth-credential-store] invalid JSON in credential:", err instanceof Error ? err.message : String(err));
    throw new FridayDomainError("INTERNAL_ERROR", `OAuth credential row has invalid JSON in ${field}`, { httpStatus: 500 });
  }
}

function rowToCredential(row: FridayOAuthCredentialRow): FridayOAuthCredential {
  const masterKey = getMasterKey();
  const accessEnvelope = parseEnvelope(row.access_token_encrypted, "access_token_encrypted");
  const refreshEnvelope = parseEnvelope(row.refresh_token_encrypted, "refresh_token_encrypted");
  let metadata: Record<string, unknown> = {};
  if (row.metadata_json) {
    try {
      const parsed = JSON.parse(row.metadata_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch (err) {
      console.warn("[friday][oauth-credential-store] invalid JSON in credential metadata:", err instanceof Error ? err.message : String(err));
    }
  }

  return {
    id: row.id,
    providerProfileId: row.provider_profile_id,
    ownerUserId: row.owner_user_id,
    oauthProvider: row.oauth_provider as FridayOAuthProviderId,
    accessToken: decryptSecret(accessEnvelope, masterKey),
    refreshToken: decryptSecret(refreshEnvelope, masterKey),
    tokenType: row.token_type,
    scope: row.scope,
    expiresAt: row.expires_at,
    metadata,
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
    getByProviderProfileId(providerProfileId, ownerUserId = FRIDAY_GLOBAL_OAUTH_OWNER_USER_ID, oauthProvider) {
      const row = deps.db.withReadConnection((db) =>
        db
          .prepare(
            `SELECT id, provider_profile_id, owner_user_id, oauth_provider,
                    access_token_encrypted, refresh_token_encrypted,
                    token_type, scope, expires_at, metadata_json, created_at, updated_at
             FROM oauth_credentials
             WHERE provider_profile_id = ?
               AND owner_user_id = ?
               AND (? IS NULL OR oauth_provider = ?)
             ORDER BY updated_at DESC
             LIMIT 1`,
          )
          .get(providerProfileId, ownerUserId, oauthProvider ?? null, oauthProvider ?? null) as FridayOAuthCredentialRow | undefined,
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
      const ownerUserId = input.ownerUserId?.trim() || FRIDAY_GLOBAL_OAUTH_OWNER_USER_ID;
      const metadataJson = JSON.stringify(input.tokenSet.metadata ?? {});

      deps.db.withWriteTransaction((db) => {
        db.prepare(
          `INSERT INTO oauth_credentials
             (id, provider_profile_id, owner_user_id, oauth_provider,
              access_token_encrypted, refresh_token_encrypted,
              token_type, scope, expires_at, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider_profile_id, oauth_provider, owner_user_id)
           DO UPDATE SET
             access_token_encrypted = excluded.access_token_encrypted,
             refresh_token_encrypted = excluded.refresh_token_encrypted,
             token_type = excluded.token_type,
             scope = excluded.scope,
             expires_at = excluded.expires_at,
             metadata_json = excluded.metadata_json,
             updated_at = excluded.updated_at`,
        ).run(
          id,
          input.providerProfileId,
          ownerUserId,
          input.oauthProvider,
          accessEncrypted,
          refreshEncrypted,
          input.tokenSet.tokenType,
          input.tokenSet.scope,
          input.tokenSet.expiresAt,
          metadataJson,
          now,
          now,
        );
      });

      // Re-read to get the actual persisted row (may use existing id on conflict)
      const stored = this.getByProviderProfileId(input.providerProfileId, ownerUserId, input.oauthProvider);
      if (!stored) {
        throw new FridayDomainError("INTERNAL_ERROR", "Failed to read back OAuth credential after upsert", { httpStatus: 500 });
      }
      return stored;
    },

    deleteByProviderProfileId(providerProfileId, ownerUserId) {
      let deleted = false;
      deps.db.withWriteTransaction((db) => {
        const result = db
          .prepare(
            ownerUserId
              ? "DELETE FROM oauth_credentials WHERE provider_profile_id = ? AND owner_user_id = ?"
              : "DELETE FROM oauth_credentials WHERE provider_profile_id = ?",
          )
          .run(...(ownerUserId ? [providerProfileId, ownerUserId] : [providerProfileId]));
        deleted = result.changes > 0;
      });
      return deleted;
    },
  };
}

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
  decryptSecretWithMigration,
  encryptSecret,
  getStrictMasterKey,
} from "../security/friday-secret-crypto.js";
import type {
  FridayEncryptedEnvelope,
  FridaySecretAadContext,
} from "../security/friday-secret-crypto.js";

/** Logical store namespace bound into every OAuth-credential AAD context. */
const FRIDAY_OAUTH_AAD_STORE = "friday-oauth";

/**
 * Canonical AAD binding context for one encrypted OAuth token column.
 *
 * Binds the STABLE natural key of the row — `(owner_user_id, provider_profile_id,
 * oauth_provider)` (the `ON CONFLICT` upsert key) — plus the token `field`, so a
 * ciphertext cannot be transplanted across owners, provider profiles, oauth
 * providers, or between the access/refresh columns. The natural key is stable
 * across upsert-on-conflict, so writer and reader reconstruct identical AAD.
 */
function oauthCredentialAadContext(parts: {
  readonly ownerUserId: string;
  readonly providerProfileId: string;
  readonly oauthProvider: string;
  readonly field: "access" | "refresh";
}): FridaySecretAadContext {
  return {
    store: FRIDAY_OAUTH_AAD_STORE,
    owner: parts.ownerUserId,
    scope: parts.providerProfileId,
    tenant: parts.oauthProvider,
    field: parts.field,
  };
}

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

interface RowToCredentialResult {
  credential: FridayOAuthCredential;
  /**
   * Present when either token column was a legacy v1 envelope and has been
   * re-wrapped to v2. The caller persists these so no unbound envelope survives.
   */
  rewrap: { access: FridayEncryptedEnvelope; refresh: FridayEncryptedEnvelope } | null;
}

function rowToCredential(row: FridayOAuthCredentialRow): RowToCredentialResult {
  const masterKey = getStrictMasterKey();
  const accessEnvelope = parseEnvelope(row.access_token_encrypted, "access_token_encrypted");
  const refreshEnvelope = parseEnvelope(row.refresh_token_encrypted, "refresh_token_encrypted");
  const commonParts = {
    ownerUserId: row.owner_user_id,
    providerProfileId: row.provider_profile_id,
    oauthProvider: row.oauth_provider,
  };
  const accessResult = decryptSecretWithMigration(
    accessEnvelope,
    masterKey,
    oauthCredentialAadContext({ ...commonParts, field: "access" }),
  );
  const refreshResult = decryptSecretWithMigration(
    refreshEnvelope,
    masterKey,
    oauthCredentialAadContext({ ...commonParts, field: "refresh" }),
  );
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

  const credential: FridayOAuthCredential = {
    id: row.id,
    providerProfileId: row.provider_profile_id,
    ownerUserId: row.owner_user_id,
    oauthProvider: row.oauth_provider as FridayOAuthProviderId,
    accessToken: accessResult.plaintext,
    refreshToken: refreshResult.plaintext,
    tokenType: row.token_type,
    scope: row.scope,
    expiresAt: row.expires_at,
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  const rewrap =
    accessResult.rewrapped || refreshResult.rewrapped
      ? {
          access: accessResult.rewrapped ?? accessEnvelope,
          refresh: refreshResult.rewrapped ?? refreshEnvelope,
        }
      : null;

  return { credential, rewrap };
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
      const { credential, rewrap } = rowToCredential(row);
      if (rewrap) {
        // Read-repair (SEC-SECRET-AAD-001): persist v2 re-wraps in place; the
        // logical token is unchanged so updated_at is intentionally preserved.
        try {
          deps.db.withWriteTransaction((db) => {
            db.prepare(
              `UPDATE oauth_credentials
                 SET access_token_encrypted = ?, refresh_token_encrypted = ?
               WHERE id = ?`,
            ).run(JSON.stringify(rewrap.access), JSON.stringify(rewrap.refresh), row.id);
          });
        } catch (err) {
          console.warn(
            "[friday][oauth-credential-store] AAD read-repair failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      return credential;
    },

    upsert(input) {
      const masterKey = getStrictMasterKey();
      const ownerUserId = input.ownerUserId?.trim() || FRIDAY_GLOBAL_OAUTH_OWNER_USER_ID;
      const accessEncrypted = JSON.stringify(
        encryptSecret(
          input.tokenSet.accessToken,
          masterKey,
          oauthCredentialAadContext({
            ownerUserId,
            providerProfileId: input.providerProfileId,
            oauthProvider: input.oauthProvider,
            field: "access",
          }),
        ),
      );
      const refreshEncrypted = JSON.stringify(
        encryptSecret(
          input.tokenSet.refreshToken,
          masterKey,
          oauthCredentialAadContext({
            ownerUserId,
            providerProfileId: input.providerProfileId,
            oauthProvider: input.oauthProvider,
            field: "refresh",
          }),
        ),
      );
      const now = deps.nowIso();
      const id = deps.idGenerator();
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

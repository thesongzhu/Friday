import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridayOAuthCredentialStore, resetMasterKeyCache } from "#providers";
import type { FridayOAuthCredentialStore } from "#providers";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";

describe("FridayOAuthCredentialStore", () => {
  let db: FridaySqliteLayer;
  let idGen: () => string;
  let store: FridayOAuthCredentialStore;
  const NOW = "2026-02-18T10:00:00.000Z";

  function insertTestProvider(id: string): void {
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO provider_profiles (id, kind, display_name, endpoint_url, enabled, default_model, config_json, created_at, updated_at)
         VALUES (?, 'anthropic', 'Test Anthropic', 'https://api.anthropic.com', 1, 'claude-3', '{}', ?, ?)`,
      ).run(id, NOW, NOW);
    });
  }

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
    resetMasterKeyCache();
    store = createFridayOAuthCredentialStore({
      db,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
    // Create a provider profile for FK constraint
    insertTestProvider("prov-1");
  });

  afterEach(() => {
    db.close();
    resetMasterKeyCache();
  });

  describe("upsert + getByProviderProfileId", () => {
    it("stores and retrieves encrypted OAuth credentials", () => {
      const credential = store.upsert({
        providerProfileId: "prov-1",
        oauthProvider: "anthropic",
        tokenSet: {
          accessToken: "at-secret-123",
          refreshToken: "rt-secret-456",
          expiresAt: "2026-02-18T11:00:00.000Z",
          tokenType: "Bearer",
          scope: "org:create_api_key user:profile user:inference",
        },
      });

      expect(credential.providerProfileId).toBe("prov-1");
      expect(credential.oauthProvider).toBe("anthropic");
      expect(credential.accessToken).toBe("at-secret-123");
      expect(credential.refreshToken).toBe("rt-secret-456");
      expect(credential.tokenType).toBe("Bearer");
      expect(credential.expiresAt).toBe("2026-02-18T11:00:00.000Z");

      // Re-read from store
      const retrieved = store.getByProviderProfileId("prov-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.accessToken).toBe("at-secret-123");
      expect(retrieved!.refreshToken).toBe("rt-secret-456");
    });

    it("upserts (updates) existing credentials on conflict", () => {
      store.upsert({
        providerProfileId: "prov-1",
        oauthProvider: "anthropic",
        tokenSet: {
          accessToken: "at-old",
          refreshToken: "rt-old",
          expiresAt: "2026-02-18T11:00:00.000Z",
          tokenType: "Bearer",
          scope: "scope1",
        },
      });

      store.upsert({
        providerProfileId: "prov-1",
        oauthProvider: "anthropic",
        tokenSet: {
          accessToken: "at-new",
          refreshToken: "rt-new",
          expiresAt: "2026-02-18T12:00:00.000Z",
          tokenType: "Bearer",
          scope: "scope2",
        },
      });

      const retrieved = store.getByProviderProfileId("prov-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.accessToken).toBe("at-new");
      expect(retrieved!.refreshToken).toBe("rt-new");
      expect(retrieved!.scope).toBe("scope2");
    });

    it("stores tokens encrypted in the database", () => {
      store.upsert({
        providerProfileId: "prov-1",
        oauthProvider: "anthropic",
        tokenSet: {
          accessToken: "at-secret",
          refreshToken: "rt-secret",
          expiresAt: "2026-02-18T11:00:00.000Z",
          tokenType: "Bearer",
          scope: "test",
        },
      });

      // Read raw row to verify encryption
      const rawRow = db.withReadConnection((conn) =>
        conn
          .prepare("SELECT access_token_encrypted, refresh_token_encrypted FROM oauth_credentials WHERE provider_profile_id = ?")
          .get("prov-1") as { access_token_encrypted: string; refresh_token_encrypted: string } | undefined,
      );

      expect(rawRow).not.toBeUndefined();
      // Raw values should be JSON envelope, not plaintext
      expect(rawRow!.access_token_encrypted).not.toBe("at-secret");
      expect(rawRow!.refresh_token_encrypted).not.toBe("rt-secret");
      // Should be valid JSON (encrypted envelope)
      const accessEnv = JSON.parse(rawRow!.access_token_encrypted) as Record<string, unknown>;
      expect(accessEnv).toHaveProperty("ciphertext");
      expect(accessEnv).toHaveProperty("iv");
      expect(accessEnv).toHaveProperty("tag");
    });
  });

  describe("getByProviderProfileId", () => {
    it("returns null for non-existent credentials", () => {
      const result = store.getByProviderProfileId("no-such-provider");
      expect(result).toBeNull();
    });
  });

  describe("deleteByProviderProfileId", () => {
    it("deletes existing credentials and returns true", () => {
      store.upsert({
        providerProfileId: "prov-1",
        oauthProvider: "anthropic",
        tokenSet: {
          accessToken: "at",
          refreshToken: "rt",
          expiresAt: "2026-02-18T11:00:00.000Z",
          tokenType: "Bearer",
          scope: "test",
        },
      });

      const deleted = store.deleteByProviderProfileId("prov-1");
      expect(deleted).toBe(true);

      const afterDelete = store.getByProviderProfileId("prov-1");
      expect(afterDelete).toBeNull();
    });

    it("returns false when no credentials exist", () => {
      const deleted = store.deleteByProviderProfileId("no-such-provider");
      expect(deleted).toBe(false);
    });
  });
});

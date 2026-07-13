import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { FridaySqliteLayer } from "#state";
import {
  createFridaySecretAdminService,
  createFridayOAuthCredentialStore,
  createFridaySecretRepository,
  decryptSecret,
  decryptSecretWithMigration,
  encryptSecret,
  fridaySecretAadContext,
  resetMasterKeyCache,
  FRIDAY_SECRET_ENVELOPE_V2,
  type FridayEncryptedEnvelope,
} from "#providers";
import { createXhsSessionManager } from "#xhs";
import type { XhsCookie } from "#xhs";
import { createFridayMcpConfigStore } from "../../../src/agent/mcp/friday-mcp-config-store.js";
import { createTestDb, createTestIdGenerator } from "../satellites/_helpers/create-test-db.helper.js";

// SEC-SECRET-AAD-001 — NO-DEGRADE migration proofs, driving REAL consumers for
// EACH at-rest secret class's on-disk shape. All secrets below are SYNTHETIC.
//
// A legacy v1 envelope is exactly what the old code produced: the current
// primitive still emits v1 when called WITHOUT a binding context, so
// `encryptSecret(pt, key)` reproduces the pre-AAD on-disk shape.

const MASTER_KEY_HEX = "11".repeat(32);
const KEY = Buffer.from(MASTER_KEY_HEX, "hex");
const NOW = "2026-07-13T00:00:00.000Z";

function makeLegacyV1(plaintext: string): FridayEncryptedEnvelope {
  const env = encryptSecret(plaintext, KEY); // no context → legacy v1
  expect(env.v).toBeUndefined();
  return env;
}

describe("SEC-SECRET-AAD-001 per-class no-degrade migration proofs", () => {
  let db: FridaySqliteLayer;
  let idGen: () => string;
  const previousMasterKey = process.env.FRIDAY_MASTER_KEY;

  beforeEach(() => {
    process.env.FRIDAY_MASTER_KEY = MASTER_KEY_HEX;
    resetMasterKeyCache();
    db = createTestDb();
    idGen = createTestIdGenerator();
  });

  afterEach(() => {
    db.close();
    if (previousMasterKey === undefined) delete process.env.FRIDAY_MASTER_KEY;
    else process.env.FRIDAY_MASTER_KEY = previousMasterKey;
    resetMasterKeyCache();
  });

  // ─── Class A: `secrets` table (provider / secret-admin / observability / channel / webhook) ───
  describe("Class A — secrets table", () => {
    it("real secret-admin write produces a v2 (AAD-bound) envelope, transplant fails closed", () => {
      const admin = createFridaySecretAdminService({ db, idGenerator: idGen, nowIso: () => NOW });
      const created = admin.createSecret({ scope: "provider", refKey: "provider:openai:apiKey", value: "synthetic-A" });

      const row = db.withReadConnection((conn) =>
        conn.prepare("SELECT encrypted_value FROM secrets WHERE id = ?").get(created.id) as
          | { encrypted_value: string }
          | undefined,
      );
      const envelope = JSON.parse(row!.encrypted_value) as FridayEncryptedEnvelope;
      expect(envelope.v).toBe(FRIDAY_SECRET_ENVELOPE_V2);

      // Correct context round-trips …
      expect(decryptSecret(envelope, KEY, fridaySecretAadContext({ scope: "provider", id: created.id }))).toBe("synthetic-A");
      // … a different row id (transplant) fails closed.
      expect(() =>
        decryptSecret(envelope, KEY, fridaySecretAadContext({ scope: "provider", id: "secret:OTHER" })),
      ).toThrow();
    });

    it("a legacy v1 secrets row survives and re-wraps to v2 on read (repository read-repair path)", () => {
      const repo = createFridaySecretRepository();
      const secretId = "secret:provider:legacy:apiKey"; // pragma: allowlist secret
      // Seed exactly what OLD code stored: a v1 envelope JSON in encrypted_value.
      db.withWriteTransaction((conn) =>
        repo.upsert(conn, {
          id: secretId,
          scope: "provider",
          refKey: "provider:legacy:apiKey",
          encryptedValue: JSON.stringify(makeLegacyV1("synthetic-legacy-A")),
          keyId: "master-v1",
          nowIso: NOW,
        }),
      );

      // Reader path (identical across every Class-A consumer): getByRef →
      // decryptSecretWithMigration(fridaySecretAadContext(entity)) → updateById.
      const entity = db.withReadConnection((conn) => repo.getByRef(conn, "provider", "provider:legacy:apiKey"));
      expect(entity).not.toBeNull();
      const { plaintext, rewrapped } = decryptSecretWithMigration(
        JSON.parse(entity!.encryptedValue) as FridayEncryptedEnvelope,
        KEY,
        fridaySecretAadContext(entity!),
      );
      expect(plaintext).toBe("synthetic-legacy-A"); // survived (no brick)
      expect(rewrapped?.v).toBe(FRIDAY_SECRET_ENVELOPE_V2);
      db.withWriteTransaction((conn) =>
        repo.updateById(conn, { secretId, encryptedValue: JSON.stringify(rewrapped), keyId: "master-v1", nowIso: NOW }),
      );

      // After migration the row at rest is v2 and still decrypts under context.
      const after = db.withReadConnection((conn) => repo.getByRef(conn, "provider", "provider:legacy:apiKey"));
      const afterEnv = JSON.parse(after!.encryptedValue) as FridayEncryptedEnvelope;
      expect(afterEnv.v).toBe(FRIDAY_SECRET_ENVELOPE_V2);
      expect(decryptSecret(afterEnv, KEY, fridaySecretAadContext(after!))).toBe("synthetic-legacy-A");
    });
  });

  // ─── Class B: oauth_credentials table ───
  describe("Class B — oauth credential store", () => {
    function insertProvider(id: string): void {
      db.withWriteTransaction((conn) => {
        conn
          .prepare(
            `INSERT INTO provider_profiles (id, kind, display_name, endpoint_url, enabled, default_model, config_json, created_at, updated_at)
             VALUES (?, 'anthropic', 'Test', 'https://api.anthropic.com', 1, 'claude-3', '{}', ?, ?)`,
          )
          .run(id, NOW, NOW);
      });
    }

    it("legacy v1 access/refresh columns survive and re-wrap to v2 on getByProviderProfileId", () => {
      insertProvider("prov-1");
      const store = createFridayOAuthCredentialStore({ db, idGenerator: idGen, nowIso: () => NOW });
      // Create the row via the real store (writes v2) …
      store.upsert({
        providerProfileId: "prov-1",
        oauthProvider: "anthropic",
        tokenSet: {
          accessToken: "placeholder-at",
          refreshToken: "placeholder-rt",
          expiresAt: NOW,
          tokenType: "Bearer",
          scope: "user:inference",
        },
      });
      // … then downgrade BOTH columns to legacy v1 envelopes of known tokens.
      db.withWriteTransaction((conn) => {
        conn
          .prepare("UPDATE oauth_credentials SET access_token_encrypted = ?, refresh_token_encrypted = ? WHERE provider_profile_id = ?")
          .run(JSON.stringify(makeLegacyV1("synthetic-access")), JSON.stringify(makeLegacyV1("synthetic-refresh")), "prov-1");
      });

      const cred = store.getByProviderProfileId("prov-1", "__global__", "anthropic");
      expect(cred?.accessToken).toBe("synthetic-access"); // survived
      expect(cred?.refreshToken).toBe("synthetic-refresh");

      // Row at rest is now v2 on both columns.
      const row = db.withReadConnection((conn) =>
        conn.prepare("SELECT access_token_encrypted, refresh_token_encrypted FROM oauth_credentials WHERE provider_profile_id = ?").get("prov-1") as
          | { access_token_encrypted: string; refresh_token_encrypted: string }
          | undefined,
      );
      expect((JSON.parse(row!.access_token_encrypted) as FridayEncryptedEnvelope).v).toBe(FRIDAY_SECRET_ENVELOPE_V2);
      expect((JSON.parse(row!.refresh_token_encrypted) as FridayEncryptedEnvelope).v).toBe(FRIDAY_SECRET_ENVELOPE_V2);
    });
  });

  // ─── Class C: MCP secret vault (JSON file) ───
  describe("Class C — mcp config vault", () => {
    let stateDir: string;
    beforeEach(() => {
      stateDir = join(tmpdir(), `friday-aad-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      mkdirSync(stateDir, { recursive: true });
    });
    afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

    it("a legacy v1 vault entry survives load() and is re-wrapped to v2 in the vault file", () => {
      const refKey = "abctelemetry0123456789abcdef0000";
      // Seed the on-disk shape old code produced: v1 vault entry + config ref.
      writeFileSync(
        join(stateDir, "mcp-secrets.json"),
        JSON.stringify({ version: 1, entries: { [refKey]: makeLegacyV1("synthetic-mcp-token") } }),
        "utf8",
      );
      writeFileSync(
        join(stateDir, "mcp-servers.json"),
        JSON.stringify([{ id: "gh", transport: "stdio", command: "node", env: { TOKEN: `secret://${refKey}` } }]),
        "utf8",
      );

      const store = createFridayMcpConfigStore(stateDir, { masterKey: KEY });
      const configs = store.load();
      expect(configs[0]?.env?.TOKEN).toBe("synthetic-mcp-token"); // survived

      const vault = JSON.parse(readFileSync(join(stateDir, "mcp-secrets.json"), "utf8")) as {
        entries: Record<string, FridayEncryptedEnvelope>;
      };
      expect(vault.entries[refKey]?.v).toBe(FRIDAY_SECRET_ENVELOPE_V2); // re-wrapped at rest
    });
  });

  // ─── Class E: xhs_sessions table ───
  describe("Class E — xhs session cookies", () => {
    it("legacy v1 cookies survive loadCookies and re-wrap to v2 at rest", () => {
      const mgr = createXhsSessionManager({ sqlite: db, nowIso: () => NOW });
      const cookies = [{ name: "web_session", value: "syn", domain: ".xhs", path: "/" }] as unknown as XhsCookie[];
      // Create the row via the real manager (writes v2), then downgrade the
      // cookies column to a legacy v1 envelope of the known cookies JSON.
      mgr.saveCookies("sess-1", "acct", cookies);
      db.withWriteTransaction((conn) => {
        conn.prepare("UPDATE xhs_sessions SET cookies_encrypted = ? WHERE id = ?").run(
          JSON.stringify(makeLegacyV1(JSON.stringify(cookies))),
          "sess-1",
        );
      });

      const loaded = mgr.loadCookies("sess-1");
      expect(loaded).toEqual(cookies); // survived

      const row = db.withReadConnection((conn) =>
        conn.prepare("SELECT cookies_encrypted FROM xhs_sessions WHERE id = ?").get("sess-1") as
          | { cookies_encrypted: string }
          | undefined,
      );
      expect((JSON.parse(row!.cookies_encrypted) as FridayEncryptedEnvelope).v).toBe(FRIDAY_SECRET_ENVELOPE_V2);
    });
  });
});

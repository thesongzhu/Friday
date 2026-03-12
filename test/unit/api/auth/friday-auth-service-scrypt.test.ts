import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayAuthService, FridayAuthError, hashPasswordScrypt } from "#api";
import type { FridayAuthService } from "#api";

describe("FridayAuthService — scrypt password hashing (SEC-004)", () => {
  let db: FridaySqliteLayer;
  let idCounter: number;
  const NOW = "2025-06-15T10:00:00.000Z";
  const TOKEN_SECRET = "test-secret-key-for-tokens";

  function createService(): FridayAuthService {
    return createFridayAuthService({
      db,
      idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604800,
    });
  }

  beforeEach(() => {
    db = createTestDb();
    idCounter = 0;
  });

  afterEach(() => {
    db.close();
  });

  it("hashPasswordScrypt produces scrypt$<salt>$<key> format", () => {
    const hash = hashPasswordScrypt("my-password");
    const parts = hash.split("$");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("scrypt");
    // salt: 32 bytes hex = 64 chars
    expect(parts[1]).toMatch(/^[0-9a-f]{64}$/);
    // derived key: 64 bytes hex = 128 chars
    expect(parts[2]).toMatch(/^[0-9a-f]{128}$/);
  });

  it("authenticates with scrypt-hashed password", () => {
    const scryptHash = hashPasswordScrypt("correct-password");
    db.writer.prepare(
      `INSERT OR IGNORE INTO users (id, email, display_name, role, is_local_only, password_hash, created_at, updated_at)
       VALUES ('scrypt-user', 'scrypt@example.com', 'Scrypt User', 'admin', 0, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run(scryptHash);

    const service = createService();
    const result = service.login({ email: "scrypt@example.com", password: "correct-password" });
    expect(result.user.id).toBe("scrypt-user");
  });

  it("rejects wrong password with scrypt hash", () => {
    const scryptHash = hashPasswordScrypt("correct-password");
    db.writer.prepare(
      `INSERT OR IGNORE INTO users (id, email, display_name, role, is_local_only, password_hash, created_at, updated_at)
       VALUES ('scrypt-user-2', 'scrypt2@example.com', 'Scrypt User 2', 'admin', 0, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run(scryptHash);

    const service = createService();
    expect(() => service.login({ email: "scrypt2@example.com", password: "wrong-password" })).toThrow(FridayAuthError);
  });

  it("authenticates with legacy SHA-256 hash (backward compat)", () => {
    const legacyHash = crypto.createHash("sha256").update("legacy-password").digest("hex");
    db.writer.prepare(
      `INSERT OR IGNORE INTO users (id, email, display_name, role, is_local_only, password_hash, created_at, updated_at)
       VALUES ('legacy-user', 'legacy@example.com', 'Legacy User', 'admin', 0, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run(legacyHash);

    const service = createService();
    const result = service.login({ email: "legacy@example.com", password: "legacy-password" });
    expect(result.user.id).toBe("legacy-user");
  });

  it("auto-upgrades legacy SHA-256 hash to scrypt on successful login", () => {
    const legacyHash = crypto.createHash("sha256").update("upgrade-me").digest("hex");
    db.writer.prepare(
      `INSERT OR IGNORE INTO users (id, email, display_name, role, is_local_only, password_hash, created_at, updated_at)
       VALUES ('upgrade-user', 'upgrade@example.com', 'Upgrade User', 'admin', 0, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run(legacyHash);

    const service = createService();
    service.login({ email: "upgrade@example.com", password: "upgrade-me" });

    // Verify hash was upgraded
    const row = db.writer.prepare("SELECT password_hash FROM users WHERE id = 'upgrade-user'").get() as { password_hash: string };
    expect(row.password_hash).toMatch(/^scrypt\$/);

    // Verify login still works with new hash
    const result = service.login({ email: "upgrade@example.com", password: "upgrade-me" });
    expect(result.user.id).toBe("upgrade-user");
  });

  it("auto-upgrades local passphrase hash from SHA-256 to scrypt", () => {
    const legacyHash = crypto.createHash("sha256").update("local-pass").digest("hex");
    db.writer.prepare(
      "UPDATE users SET password_hash = ? WHERE id = 'test-user'",
    ).run(legacyHash);

    const service = createService();
    service.login({ localPassphrase: "local-pass" });

    const row = db.writer.prepare("SELECT password_hash FROM users WHERE id = 'test-user'").get() as { password_hash: string };
    expect(row.password_hash).toMatch(/^scrypt\$/);
  });

  it("rejects wrong password on legacy SHA-256 hash without upgrading", () => {
    const legacyHash = crypto.createHash("sha256").update("real-password").digest("hex");
    db.writer.prepare(
      `INSERT OR IGNORE INTO users (id, email, display_name, role, is_local_only, password_hash, created_at, updated_at)
       VALUES ('no-upgrade-user', 'noup@example.com', 'No Upgrade', 'admin', 0, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run(legacyHash);

    const service = createService();
    expect(() => service.login({ email: "noup@example.com", password: "wrong" })).toThrow(FridayAuthError);

    // Hash should NOT be upgraded on failed login
    const row = db.writer.prepare("SELECT password_hash FROM users WHERE id = 'no-upgrade-user'").get() as { password_hash: string };
    expect(row.password_hash).toBe(legacyHash);
  });
});

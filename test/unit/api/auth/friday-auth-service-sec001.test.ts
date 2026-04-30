import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayAuthService, FridayAuthError } from "#api";

describe("FridayAuthService — SEC-001: Login hardening", () => {
  let db: FridaySqliteLayer;
  let idCounter: number;
  const NOW = "2025-06-15T10:00:00.000Z";
  const TOKEN_SECRET = "test-secret-key-for-tokens";

  beforeEach(() => {
    db = createTestDb();
    idCounter = 0;
  });

  afterEach(() => {
    db.close();
  });

  // ─── Problem 1: null password_hash on localPassphrase login ───

  it("rejects localPassphrase login when password_hash is null", () => {
    // Replace default test-user with one that has no password hash
    db.writer.prepare("DELETE FROM users WHERE id = 'test-user'").run();
    db.writer.prepare(
      `INSERT INTO users (id, display_name, role, is_local_only, password_hash, created_at, updated_at)
       VALUES ('test-user', 'Test User', 'admin', 1, NULL, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run();

    const service = createFridayAuthService({
      db,
      idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604800,
    });

    expect(() => service.login({ localPassphrase: "anything" })).toThrow(FridayAuthError);
    try {
      service.login({ localPassphrase: "anything" });
    } catch (err) {
      expect((err as FridayAuthError).code).toBe("NO_PASSWORD_CONFIGURED");
    }
  });

  it("rejects localPassphrase login when password_hash is empty string", () => {
    db.writer.prepare("UPDATE users SET password_hash = '' WHERE id = 'test-user'").run();

    const service = createFridayAuthService({
      db,
      idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604800,
    });

    // Empty string is falsy, so should hit the NO_PASSWORD_CONFIGURED check
    expect(() => service.login({ localPassphrase: "anything" })).toThrow(FridayAuthError);
    try {
      service.login({ localPassphrase: "anything" });
    } catch (err) {
      expect((err as FridayAuthError).code).toBe("NO_PASSWORD_CONFIGURED");
    }
  });

  it("succeeds localPassphrase login when password_hash is valid and password matches", () => {
    // Default test user from createTestDb() has a password hash for "any"
    const service = createFridayAuthService({
      db,
      idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604800,
    });

    const result = service.login({ localPassphrase: "any" });
    expect(result.user.id).toBe("test-user");
  });

  it("still rejects {} in strict mode (non-dev)", () => {
    const service = createFridayAuthService({
      db,
      idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604800,
    });

    expect(() => service.login({}, "127.0.0.1")).toThrow(FridayAuthError);
    try {
      service.login({}, "127.0.0.1");
    } catch (err) {
      expect((err as FridayAuthError).code).toBe("AUTH_METHOD_REQUIRED");
    }
  });
});

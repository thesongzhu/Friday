import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayAuthService, FridayAuthError, hashPasswordScrypt, createFridayRateLimitService, createFridayTokenValidator } from "#api";
import type { FridayAuthService } from "#api";
import * as crypto from "node:crypto";

describe("FridayAuthService", () => {
  let db: FridaySqliteLayer;
  let service: FridayAuthService;
  let idCounter: number;
  const NOW = "2025-06-15T10:00:00.000Z";
  const TOKEN_SECRET = "test-secret-key-for-tokens";

  beforeEach(() => {
    db = createTestDb();
    idCounter = 0;
    service = createFridayAuthService({
      db,
      idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604800,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("rejects empty {} login in strict mode (default)", () => {
    expect(() => service.login({})).toThrow(FridayAuthError);
    try {
      service.login({});
    } catch (err) {
      expect((err as FridayAuthError).code).toBe("AUTH_METHOD_REQUIRED");
    }
  });

  it("logs in with correct localPassphrase", () => {
    const result = service.login({ localPassphrase: "any" });
    expect(result.user.id).toBe("test-user");
  });

  it("issues tenant-aware claims via resolver hook", () => {
    const resolverService = createFridayAuthService({
      db,
      idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604800,
      resolveTenantId: () => "tenant-ops",
    });
    const validator = createFridayTokenValidator({
      tokenSecret: TOKEN_SECRET,
      nowMs: () => Date.parse(NOW),
      lookupTokenRevocation: () => false,
    });

    const result = resolverService.login({ localPassphrase: "any" });
    const validated = validator.validate(result.accessToken);

    expect(validated.principal.tenantId).toBe("tenant-ops");
  });

  it("defaults tenant-aware claims to self-tenant when no resolver is configured", () => {
    const validator = createFridayTokenValidator({
      tokenSecret: TOKEN_SECRET,
      nowMs: () => Date.parse(NOW),
      lookupTokenRevocation: () => false,
    });

    const result = service.login({ localPassphrase: "any" });
    const validated = validator.validate(result.accessToken);

    expect(validated.principal.tenantId).toBe("test-user");
  });

  it("reports bootstrapRequired when local user has no password and passwordless is disabled", () => {
    db.writer.prepare("UPDATE users SET password_hash = NULL WHERE id = 'test-user'").run();
    const status = service.getBootstrapStatus();
    expect(status.bootstrapRequired).toBe(true);
    expect(status.allowPasswordlessLocalLogin).toBe(false);
    expect(status.allowLocalBypassLogin).toBe(false);
  });

  it("bootstraps local passphrase from localhost exactly once", () => {
    db.writer.prepare("UPDATE users SET password_hash = NULL WHERE id = 'test-user'").run();

    const first = service.bootstrapLocalPassphrase(
      { passphrase: "super-secret-passphrase" },
      "127.0.0.1",
    );
    expect(first.initialized).toBe(true);

    expect(() =>
      service.bootstrapLocalPassphrase(
        { passphrase: "another-super-secret-passphrase" },
        "127.0.0.1",
      ),
    ).toThrow("already been completed");
  });

  it("rejects bootstrap from non-localhost IP", () => {
    db.writer.prepare("UPDATE users SET password_hash = NULL WHERE id = 'test-user'").run();
    expect(() =>
      service.bootstrapLocalPassphrase(
        { passphrase: "super-secret-passphrase" },
        "8.8.8.8",
      ),
    ).toThrow("only allowed from localhost");
  });

  it("rejects localPassphrase login when password_hash is null (SEC-001)", () => {
    // Create a user with no password hash
    db.writer.prepare(
      `INSERT INTO users (id, display_name, role, is_local_only, password_hash, created_at, updated_at)
       VALUES ('no-pass-user', 'No Pass User', 'admin', 1, NULL, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run();
    // Remove the default test-user so findLocalUser returns no-pass-user
    db.writer.prepare("DELETE FROM users WHERE id = 'test-user'").run();

    expect(() => service.login({ localPassphrase: "any" })).toThrow(FridayAuthError);
    try {
      service.login({ localPassphrase: "any" });
    } catch (err) {
      expect((err as FridayAuthError).code).toBe("NO_PASSWORD_CONFIGURED");
    }
  });

  it("rejects localPassphrase login with wrong passphrase", () => {
    expect(() => service.login({ localPassphrase: "wrong-passphrase" })).toThrow(FridayAuthError);
    try {
      service.login({ localPassphrase: "wrong-passphrase" });
    } catch (err) {
      expect((err as FridayAuthError).code).toBe("INVALID_CREDENTIALS");
    }
  });

  it("creates an auth session on login", () => {
    service.login({ localPassphrase: "any" });
    const sessions = db.writer
      .prepare("SELECT * FROM auth_sessions WHERE user_id = 'test-user'")
      .all();
    expect(sessions).toHaveLength(1);
  });

  it("refreshes a token", () => {
    const loginResult = service.login({ localPassphrase: "any" });
    const refreshResult = service.refresh({ refreshToken: loginResult.refreshToken });
    expect(refreshResult.accessToken).toBeTruthy();
    expect(refreshResult.expiresInSec).toBe(900);
  });

  it("rejects invalid refresh token", () => {
    expect(() => service.refresh({ refreshToken: "invalid" })).toThrow(FridayAuthError);
  });

  it("logs out by revoking session", () => {
    const loginResult = service.login({ localPassphrase: "any" });
    const principal = {
      principalType: "user" as const,
      principalId: "test-user",
      userId: "test-user",
      role: "admin" as const,
      scopes: ["session.write" as const],
      tokenId: "tok-1",
      tokenKind: "access" as const,
      issuedAt: NOW,
      sessionId: "id-0001",
    };

    const result = service.logout({ refreshToken: loginResult.refreshToken }, principal);
    expect(result.ok).toBe(true);

    // Refresh should now fail
    expect(() => service.refresh({ refreshToken: loginResult.refreshToken })).toThrow(FridayAuthError);
  });

  it("logs out all sessions", () => {
    service.login({ localPassphrase: "any" });
    service.login({ localPassphrase: "any" });

    const principal = {
      principalType: "user" as const,
      principalId: "test-user",
      userId: "test-user",
      role: "admin" as const,
      scopes: ["session.write" as const],
      tokenId: "tok-1",
      tokenKind: "access" as const,
      issuedAt: NOW,
    };

    service.logout({ allSessions: true }, principal);

    const active = db.writer
      .prepare("SELECT * FROM auth_sessions WHERE user_id = 'test-user' AND revoked_at IS NULL")
      .all();
    expect(active).toHaveLength(0);
  });

  it("returns user info via me()", () => {
    const loginResult = service.login({ localPassphrase: "any" });
    const principal = {
      principalType: "user" as const,
      principalId: "test-user",
      userId: "test-user",
      role: "admin" as const,
      scopes: ["session.read" as const],
      tokenId: "tok-1",
      tokenKind: "access" as const,
      issuedAt: NOW,
      sessionId: "id-0001",
    };

    const me = service.me(principal);
    expect(me.user.id).toBe("test-user");
    expect(me.user.displayName).toBe("Test User");
    expect(me.scopes).toContain("session.read");
  });

  // ─── Email login password enforcement ───

  it("rejects email login without password", () => {
    db.writer.prepare(
      `INSERT INTO users (id, email, display_name, role, is_local_only, password_hash, created_at, updated_at)
       VALUES ('email-user', 'user@example.com', 'Email User', 'admin', 0, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run(crypto.createHash("sha256").update("secret123").digest("hex"));

    expect(() => service.login({ email: "user@example.com" })).toThrow(FridayAuthError);
    try {
      service.login({ email: "user@example.com" });
    } catch (err) {
      // VULN-2: unified to INVALID_CREDENTIALS to prevent user enumeration
      expect((err as FridayAuthError).code).toBe("INVALID_CREDENTIALS");
    }
  });

  it("rejects email login with wrong password", () => {
    db.writer.prepare(
      `INSERT OR IGNORE INTO users (id, email, display_name, role, is_local_only, password_hash, created_at, updated_at)
       VALUES ('email-user-2', 'user2@example.com', 'Email User 2', 'admin', 0, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run(crypto.createHash("sha256").update("correct-password").digest("hex"));

    expect(() => service.login({ email: "user2@example.com", password: "wrong-password" })).toThrow(FridayAuthError);
    try {
      service.login({ email: "user2@example.com", password: "wrong-password" });
    } catch (err) {
      expect((err as FridayAuthError).code).toBe("INVALID_CREDENTIALS");
    }
  });

  it("succeeds email login with correct password", () => {
    const passwordHash = crypto.createHash("sha256").update("correct-password").digest("hex");
    db.writer.prepare(
      `INSERT OR IGNORE INTO users (id, email, display_name, role, is_local_only, password_hash, created_at, updated_at)
       VALUES ('email-user-3', 'user3@example.com', 'Email User 3', 'viewer', 0, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run(passwordHash);

    const result = service.login({ email: "user3@example.com", password: "correct-password" });
    expect(result.user.id).toBe("email-user-3");
    expect(result.user.email).toBe("user3@example.com");
    expect(result.accessToken).toBeTruthy();
  });

  it("rejects email login when user has no password hash set", () => {
    db.writer.prepare(
      `INSERT OR IGNORE INTO users (id, email, display_name, role, is_local_only, password_hash, created_at, updated_at)
       VALUES ('email-user-4', 'user4@example.com', 'Email User 4', 'admin', 0, NULL, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run();

    expect(() => service.login({ email: "user4@example.com", password: "anything" })).toThrow(FridayAuthError);
    try {
      service.login({ email: "user4@example.com", password: "anything" });
    } catch (err) {
      // VULN-2: unified to INVALID_CREDENTIALS to prevent user enumeration
      expect((err as FridayAuthError).code).toBe("INVALID_CREDENTIALS");
    }
  });

  // ─── Dev mode passwordless login (SEC-001 hardening) ───

  it("rejects dev-mode {} login without local:true flag", () => {
    // Create a no-password user for dev mode
    db.writer.prepare("DELETE FROM users WHERE id = 'test-user'").run();
    db.writer.prepare(
      `INSERT INTO users (id, display_name, role, is_local_only, password_hash, created_at, updated_at)
       VALUES ('test-user', 'Test User', 'admin', 1, NULL, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run();

    const devService = createFridayAuthService({
      db,
      idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604800,
      allowPasswordlessLocalLogin: true,
      warn: () => {},
    });

    expect(() => devService.login({}, "127.0.0.1")).toThrow(FridayAuthError);
    try {
      devService.login({}, "127.0.0.1");
    } catch (err) {
      expect((err as FridayAuthError).code).toBe("LOCAL_FLAG_REQUIRED");
    }
  });

  it("allows dev-mode login with { local: true } when user has no password", () => {
    // Create a no-password user for dev mode
    db.writer.prepare("DELETE FROM users WHERE id = 'test-user'").run();
    db.writer.prepare(
      `INSERT INTO users (id, display_name, role, is_local_only, password_hash, created_at, updated_at)
       VALUES ('test-user', 'Test User', 'admin', 1, NULL, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run();

    const devService = createFridayAuthService({
      db,
      idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604800,
      allowPasswordlessLocalLogin: true,
      warn: () => {},
    });

    const result = devService.login({ local: true }, "127.0.0.1");
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(result.expiresInSec).toBe(900);
    expect(result.user.id).toBe("test-user");
    expect(result.user.role).toBe("admin");
  });

  it("rejects dev-mode { local: true } when user has a password configured", () => {
    // Default test-user already has a password hash
    const devService = createFridayAuthService({
      db,
      idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604800,
      allowPasswordlessLocalLogin: true,
      warn: () => {},
    });

    expect(() => devService.login({ local: true }, "127.0.0.1")).toThrow(FridayAuthError);
    try {
      devService.login({ local: true }, "127.0.0.1");
    } catch (err) {
      expect((err as FridayAuthError).code).toBe("PASSPHRASE_REQUIRED");
    }
  });

  it("dev mode passwordless login logs a warning", () => {
    // Create a no-password user for dev mode
    db.writer.prepare("DELETE FROM users WHERE id = 'test-user'").run();
    db.writer.prepare(
      `INSERT INTO users (id, display_name, role, is_local_only, password_hash, created_at, updated_at)
       VALUES ('test-user', 'Test User', 'admin', 1, NULL, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run();

    const warnings: string[] = [];
    const devService = createFridayAuthService({
      db,
      idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604800,
      allowPasswordlessLocalLogin: true,
      warn: (msg) => warnings.push(msg),
    });
    devService.login({ local: true }, "127.0.0.1");
    // P1-SEC-004/005: Now also logs token secret + rate limiter warnings at construction
    const passwordlessWarning = warnings.find((w) => w.includes("Passwordless"));
    expect(passwordlessWarning).toBeDefined();
  });

  it("allows no-signin local bypass with { local: true } even when passphrase exists", () => {
    const warnings: string[] = [];
    const bypassService = createFridayAuthService({
      db,
      idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604800,
      allowLocalBypassLogin: true,
      warn: (msg) => warnings.push(msg),
    });

    const result = bypassService.login({ local: true }, "127.0.0.1");
    expect(result.user.id).toBe("test-user");
    expect(result.accessToken).toBeTruthy();
    expect(warnings.some((w) => w.includes("Local bypass login"))).toBe(true);
  });

  it("rejects local bypass login from remote IP even with allowLocalBypassLogin", () => {
    const bypassService = createFridayAuthService({
      db,
      idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604800,
      allowLocalBypassLogin: true,
    });

    expect(() => bypassService.login({ local: true }, "203.0.113.20")).toThrow(FridayAuthError);
    try {
      bypassService.login({ local: true }, "203.0.113.20");
    } catch (err) {
      expect((err as FridayAuthError).code).toBe("PASSWORDLESS_LOCALHOST_ONLY");
    }
  });

  it("still requires explicit local:true in no-signin bypass mode", () => {
    const bypassService = createFridayAuthService({
      db,
      idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604800,
      allowLocalBypassLogin: true,
    });

    expect(() => bypassService.login({}, "127.0.0.1")).toThrow(FridayAuthError);
    try {
      bypassService.login({}, "127.0.0.1");
    } catch (err) {
      expect((err as FridayAuthError).code).toBe("AUTH_METHOD_REQUIRED");
    }
  });

  it("throws when me() has no userId", () => {
    const principal = {
      principalType: "service" as const,
      principalId: "svc-1",
      scopes: ["session.read" as const],
      tokenId: "tok-1",
      tokenKind: "access" as const,
      issuedAt: NOW,
    };
    expect(() => service.me(principal)).toThrow(FridayAuthError);
  });

  // ─── VULN-2: Constant-time auth + no user enumeration ───

  describe("VULN-2: Auth timing side-channel elimination", () => {
    it("returns INVALID_CREDENTIALS (not USER_NOT_FOUND) for unknown email with password", () => {
      db.writer.prepare(
        `INSERT OR IGNORE INTO users (id, email, display_name, role, is_local_only, password_hash, created_at, updated_at)
         VALUES ('vuln2-user', 'real@example.com', 'Real User', 'admin', 0, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
      ).run(hashPasswordScrypt("correct-pw"));

      let error: FridayAuthError | null = null;
      try {
        service.login({ email: "nonexistent@example.com", password: "any-password" });
      } catch (err) {
        error = err as FridayAuthError;
      }

      expect(error).toBeTruthy();
      expect(error!.code).toBe("INVALID_CREDENTIALS");
      expect(error!.message).toBe("Invalid credentials");
    });

    it("returns identical code and message for wrong-password existing user and unknown user", () => {
      db.writer.prepare(
        `INSERT OR IGNORE INTO users (id, email, display_name, role, is_local_only, password_hash, created_at, updated_at)
         VALUES ('vuln2-user-2', 'known@example.com', 'Known User', 'admin', 0, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
      ).run(hashPasswordScrypt("right-pw"));

      let existingErr: FridayAuthError | null = null;
      let unknownErr: FridayAuthError | null = null;

      try {
        service.login({ email: "known@example.com", password: "wrong-pw" });
      } catch (err) {
        existingErr = err as FridayAuthError;
      }

      try {
        service.login({ email: "ghost@example.com", password: "wrong-pw" });
      } catch (err) {
        unknownErr = err as FridayAuthError;
      }

      expect(existingErr).toBeTruthy();
      expect(unknownErr).toBeTruthy();
      expect(existingErr!.code).toBe(unknownErr!.code);
      expect(existingErr!.message).toBe(unknownErr!.message);
      expect(existingErr!.code).toBe("INVALID_CREDENTIALS");
    });

    it("unknown-user attempt takes comparable time to existing-user attempt (constant-time)", () => {
      // Seed a user for comparison
      db.writer.prepare(
        `INSERT OR IGNORE INTO users (id, email, display_name, role, is_local_only, password_hash, created_at, updated_at)
         VALUES ('timing-user', 'timing@example.com', 'Timing User', 'admin', 0, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
      ).run(hashPasswordScrypt("password"));

      // Measure existing-user wrong-password (includes scrypt)
      const t1 = performance.now();
      try { service.login({ email: "timing@example.com", password: "wrong" }); } catch { /* expected */ }
      const existingTime = performance.now() - t1;

      // Measure unknown-user (should also include scrypt via dummy hash)
      const t2 = performance.now();
      try { service.login({ email: "unknown-timing@example.com", password: "wrong" }); } catch { /* expected */ }
      const unknownTime = performance.now() - t2;

      // Both should be non-trivial (scrypt runs, not instant)
      // Unknown user should take at least 20% of existing user time (not instant skip)
      expect(unknownTime).toBeGreaterThan(existingTime * 0.2);
    });

    it("returns INVALID_CREDENTIALS for email login without password", () => {
      db.writer.prepare(
        `INSERT OR IGNORE INTO users (id, email, display_name, role, is_local_only, password_hash, created_at, updated_at)
         VALUES ('vuln2-user-3', 'nopw@example.com', 'NoPW User', 'admin', 0, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
      ).run(hashPasswordScrypt("secret"));

      let error: FridayAuthError | null = null;
      try {
        service.login({ email: "nopw@example.com" });
      } catch (err) {
        error = err as FridayAuthError;
      }

      expect(error).toBeTruthy();
      expect(error!.code).toBe("INVALID_CREDENTIALS");
    });

    it("legacy SHA-256 user login takes comparable time to scrypt user (timing pad active)", () => {
      // Seed a legacy SHA-256 user
      const legacyHash = crypto.createHash("sha256").update("legacy-pass").digest("hex");
      db.writer.prepare(
        `INSERT OR IGNORE INTO users (id, email, display_name, role, is_local_only, password_hash, created_at, updated_at)
         VALUES ('legacy-timing-user', 'legacy@example.com', 'Legacy User', 'admin', 0, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
      ).run(legacyHash);

      // Seed a scrypt user for baseline
      db.writer.prepare(
        `INSERT OR IGNORE INTO users (id, email, display_name, role, is_local_only, password_hash, created_at, updated_at)
         VALUES ('scrypt-timing-user', 'scrypt@example.com', 'Scrypt User', 'admin', 0, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
      ).run(hashPasswordScrypt("scrypt-pass"));

      // Measure scrypt user (baseline)
      const t1 = performance.now();
      try { service.login({ email: "scrypt@example.com", password: "wrong" }); } catch { /* expected */ }
      const scryptTime = performance.now() - t1;

      // Measure legacy user (should include scrypt pad)
      const t2 = performance.now();
      try { service.login({ email: "legacy@example.com", password: "wrong" }); } catch { /* expected */ }
      const legacyTime = performance.now() - t2;

      // Legacy user should take comparable time (at least 20% of scrypt baseline)
      // Without the timing pad, legacy would be near-instant (<1ms)
      expect(legacyTime).toBeGreaterThan(scryptTime * 0.2);
      // Both should be non-trivial (>1ms due to scrypt work)
      expect(scryptTime).toBeGreaterThan(1);
      expect(legacyTime).toBeGreaterThan(1);
    });

    it("legacy-user and unknown-user paths both take non-trivial time (same work class)", () => {
      // Seed a legacy SHA-256 user
      const legacyHash = crypto.createHash("sha256").update("legacy-pass-2").digest("hex");
      db.writer.prepare(
        `INSERT OR IGNORE INTO users (id, email, display_name, role, is_local_only, password_hash, created_at, updated_at)
         VALUES ('legacy-timing-2', 'legacy2@example.com', 'Legacy User 2', 'admin', 0, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
      ).run(legacyHash);

      // Legacy user attempt
      const t1 = performance.now();
      try { service.login({ email: "legacy2@example.com", password: "wrong" }); } catch { /* expected */ }
      const legacyTime = performance.now() - t1;

      // Unknown user attempt
      const t2 = performance.now();
      try { service.login({ email: "ghost-timing@example.com", password: "wrong" }); } catch { /* expected */ }
      const unknownTime = performance.now() - t2;

      // Both paths should be non-trivial (scrypt runs in both cases)
      expect(legacyTime).toBeGreaterThan(1);
      expect(unknownTime).toBeGreaterThan(1);
      // And comparable: each should be at least 20% of the other
      expect(legacyTime).toBeGreaterThan(unknownTime * 0.2);
      expect(unknownTime).toBeGreaterThan(legacyTime * 0.2);
    });

    it("malformed scrypt hash (scrypt$bad) still runs scrypt derivation before rejecting (VULN-2)", () => {
      // Seed a user whose password_hash is a malformed scrypt string
      db.writer.prepare("DELETE FROM users WHERE id = 'test-user'").run();
      db.writer.prepare(
        `INSERT INTO users (id, display_name, role, is_local_only, password_hash, created_at, updated_at)
         VALUES ('test-user', 'Test User', 'admin', 1, 'scrypt$bad', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
      ).run();

      // Seed a well-formed scrypt user for baseline comparison
      const wellFormedHash = hashPasswordScrypt("baseline-pw");
      db.writer.prepare(
        `INSERT OR IGNORE INTO users (id, email, display_name, role, is_local_only, password_hash, created_at, updated_at)
         VALUES ('scrypt-baseline', 'baseline@example.com', 'Baseline', 'admin', 0, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
      ).run(wellFormedHash);

      // Measure well-formed scrypt baseline (wrong password)
      const t1 = performance.now();
      try { service.login({ email: "baseline@example.com", password: "wrong" }); } catch { /* expected */ }
      const baselineTime = performance.now() - t1;

      // Measure malformed scrypt hash path
      const t2 = performance.now();
      let error: FridayAuthError | null = null;
      try {
        service.login({ localPassphrase: "any-password" });
      } catch (err) {
        error = err as FridayAuthError;
      }
      const malformedTime = performance.now() - t2;

      expect(error).toBeTruthy();
      expect(error!.code).toBe("INVALID_CREDENTIALS");
      // Malformed path must take non-trivial time (>1ms), proving scrypt ran
      expect(malformedTime).toBeGreaterThan(1);
      // And comparable to baseline (at least 20% — not an instant skip)
      expect(malformedTime).toBeGreaterThan(baselineTime * 0.2);
    });

    it("locks out repeated unknown-user failures", () => {
      const svcWithLimiter = createFridayAuthService({
        db,
        idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
        nowIso: () => NOW,
        tokenSecret: TOKEN_SECRET,
        accessTokenTtlSec: 900,
        refreshTokenTtlSec: 604800,
        rateLimiter: createFridayRateLimitService({ db, nowIso: () => NOW }),
      });

      // Exhaust lockout attempts
      for (let i = 0; i < 15; i++) {
        try {
          svcWithLimiter.login({ email: "nobody@example.com", password: "bad" });
        } catch {
          // expected
        }
      }

      let lockedError: FridayAuthError | null = null;
      try {
        svcWithLimiter.login({ email: "nobody@example.com", password: "bad" });
      } catch (err) {
        lockedError = err as FridayAuthError;
      }

      expect(lockedError).toBeTruthy();
      expect(lockedError!.code).toBe("AUTH_LOCKED_OUT");
    });
  });

  // ─── Dual-subject lockout (principal + IP) ───

  describe("Dual-subject lockout (principal + IP)", () => {
    it("records both principal and IP failures on bad login", () => {
      const rateLimiter = createFridayRateLimitService({
        db,
        nowIso: () => NOW,
        authLockoutConfig: { maxAttempts: 3, windowMs: 60_000, lockoutMs: 10_000, maxLockoutLevel: 3 },
      });
      const svc = createFridayAuthService({
        db,
        idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
        nowIso: () => NOW,
        tokenSecret: TOKEN_SECRET,
        accessTokenTtlSec: 900,
        refreshTokenTtlSec: 604800,
        rateLimiter,
      });

      // 2 failed attempts from a specific IP
      for (let i = 0; i < 2; i++) {
        try {
          svc.login({ localPassphrase: "wrong" }, "10.0.0.50");
        } catch { /* expected */ }
      }

      // IP should have 2 failures recorded
      const ipStatus = rateLimiter.checkIpLockout("10.0.0.50");
      expect(ipStatus.failureCount).toBe(2);
    });

    it("resets both principal and IP failures on successful login", () => {
      const rateLimiter = createFridayRateLimitService({
        db,
        nowIso: () => NOW,
        authLockoutConfig: { maxAttempts: 10, windowMs: 60_000, lockoutMs: 10_000, maxLockoutLevel: 3 },
      });
      const svc = createFridayAuthService({
        db,
        idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
        nowIso: () => NOW,
        tokenSecret: TOKEN_SECRET,
        accessTokenTtlSec: 900,
        refreshTokenTtlSec: 604800,
        rateLimiter,
      });

      // Record a few failures
      for (let i = 0; i < 3; i++) {
        try {
          svc.login({ localPassphrase: "wrong" }, "10.0.0.60");
        } catch { /* expected */ }
      }
      expect(rateLimiter.checkIpLockout("10.0.0.60").failureCount).toBe(3);

      // Successful login should reset both
      svc.login({ localPassphrase: "any" }, "10.0.0.60");
      expect(rateLimiter.checkIpLockout("10.0.0.60").failureCount).toBe(0);
    });

    it("records IP failures even when IP is undefined (no bypass)", () => {
      const rateLimiter = createFridayRateLimitService({
        db,
        nowIso: () => NOW,
        authLockoutConfig: { maxAttempts: 3, windowMs: 60_000, lockoutMs: 10_000, maxLockoutLevel: 3 },
      });
      const svc = createFridayAuthService({
        db,
        idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
        nowIso: () => NOW,
        tokenSecret: TOKEN_SECRET,
        accessTokenTtlSec: 900,
        refreshTokenTtlSec: 604800,
        rateLimiter,
      });

      // 3 failed attempts with undefined IP — should accumulate under "unknown"
      for (let i = 0; i < 3; i++) {
        try {
          svc.login({ localPassphrase: "wrong" }, undefined);
        } catch { /* expected */ }
      }

      // IP lockout should now be triggered for undefined IP
      try {
        svc.login({ localPassphrase: "any" }, undefined);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as FridayAuthError).code).toBe("AUTH_LOCKED_OUT");
      }
    });

    it("records IP failures even when IP is empty string (no bypass)", () => {
      const rateLimiter = createFridayRateLimitService({
        db,
        nowIso: () => NOW,
        authLockoutConfig: { maxAttempts: 3, windowMs: 60_000, lockoutMs: 10_000, maxLockoutLevel: 3 },
      });
      const svc = createFridayAuthService({
        db,
        idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
        nowIso: () => NOW,
        tokenSecret: TOKEN_SECRET,
        accessTokenTtlSec: 900,
        refreshTokenTtlSec: 604800,
        rateLimiter,
      });

      // 3 failed attempts with empty string IP
      for (let i = 0; i < 3; i++) {
        try {
          svc.login({ localPassphrase: "wrong" }, "");
        } catch { /* expected */ }
      }

      // IP lockout should now be triggered for empty string IP
      try {
        svc.login({ localPassphrase: "any" }, "");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as FridayAuthError).code).toBe("AUTH_LOCKED_OUT");
      }
    });

    it("resets IP failures on success even when IP is undefined", () => {
      const rateLimiter = createFridayRateLimitService({
        db,
        nowIso: () => NOW,
        authLockoutConfig: { maxAttempts: 10, windowMs: 60_000, lockoutMs: 10_000, maxLockoutLevel: 3 },
      });
      const svc = createFridayAuthService({
        db,
        idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
        nowIso: () => NOW,
        tokenSecret: TOKEN_SECRET,
        accessTokenTtlSec: 900,
        refreshTokenTtlSec: 604800,
        rateLimiter,
      });

      // Record some failures with undefined IP
      for (let i = 0; i < 3; i++) {
        try {
          svc.login({ localPassphrase: "wrong" }, undefined);
        } catch { /* expected */ }
      }
      expect(rateLimiter.checkIpLockout(undefined).failureCount).toBe(3);

      // Successful login should reset
      svc.login({ localPassphrase: "any" }, undefined);
      expect(rateLimiter.checkIpLockout(undefined).failureCount).toBe(0);
    });

    it("IP lockout blocks even when principal is not locked", () => {
      const rateLimiter = createFridayRateLimitService({
        db,
        nowIso: () => NOW,
        authLockoutConfig: { maxAttempts: 3, windowMs: 60_000, lockoutMs: 10_000, maxLockoutLevel: 3 },
      });
      const svc = createFridayAuthService({
        db,
        idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
        nowIso: () => NOW,
        tokenSecret: TOKEN_SECRET,
        accessTokenTtlSec: 900,
        refreshTokenTtlSec: 604800,
        rateLimiter,
      });

      // Lock IP by spraying different emails (each principal only 1 failure)
      for (let i = 0; i < 3; i++) {
        try {
          svc.login({ email: `user${i}@example.com`, password: "wrong" }, "10.0.0.70");
        } catch { /* expected */ }
      }

      // IP is locked
      expect(rateLimiter.checkIpLockout("10.0.0.70").locked).toBe(true);

      // Even a fresh principal from the same IP should be blocked
      try {
        svc.login({ localPassphrase: "any" }, "10.0.0.70");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as FridayAuthError).code).toBe("AUTH_LOCKED_OUT");
      }
    });
  });

  // ─── Retry metadata in lockout errors ───

  describe("Retry metadata in AUTH_LOCKED_OUT errors", () => {
    it("includes retryAfterMs in error details", () => {
      const rateLimiter = createFridayRateLimitService({
        db,
        nowIso: () => NOW,
        authLockoutConfig: { maxAttempts: 2, windowMs: 60_000, lockoutMs: 30_000, maxLockoutLevel: 3 },
      });
      const svc = createFridayAuthService({
        db,
        idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
        nowIso: () => NOW,
        tokenSecret: TOKEN_SECRET,
        accessTokenTtlSec: 900,
        refreshTokenTtlSec: 604800,
        rateLimiter,
      });

      // Trigger lockout
      for (let i = 0; i < 2; i++) {
        try { svc.login({ localPassphrase: "wrong" }, "10.0.0.80"); } catch { /* */ }
      }

      try {
        svc.login({ localPassphrase: "wrong" }, "10.0.0.80");
        expect.unreachable("should have thrown");
      } catch (err) {
        const authErr = err as FridayAuthError;
        expect(authErr.code).toBe("AUTH_LOCKED_OUT");
        expect(authErr.httpStatus).toBe(429);
        expect(authErr.retryable).toBe(true);
        expect(authErr.details).toBeTruthy();
        expect((authErr.details as Record<string, unknown>).retryAfterMs).toBeGreaterThan(0);
      }
    });
  });
});

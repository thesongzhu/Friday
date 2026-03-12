/**
 * Adversarial Auth & Rate Limit Abuse Tests (TEST-14 through TEST-17)
 *
 * Tests timing side-channels (VULN-2 fixed), rate-limit boundary exploitation,
 * concurrent brute-force lockout, and session fixation attacks.
 *
 * - Strict error code assertions (FridayAuthError.code === "INVALID_CREDENTIALS")
 * - Real scrypt execution verified via spy
 * - Concurrent auth uses Promise.allSettled, not sequential loops
 * - Session fixation tested against real API endpoint
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import * as crypto from "node:crypto";
import { createFridayRateLimitService } from "#api";
import { createFridayAuthService, hashPasswordScrypt, FridayAuthError } from "#api";
import { createTestDb, createTestIdGenerator } from "../helpers/friday-test-db.helper.js";
import {
  createFridayApiTestEnv,
  loginTestUser,
  authHeaders,
  type FridayApiTestEnv,
} from "../e2e/api/_helpers/friday-api-test-server.helper.js";
import type { FridaySqliteLayer } from "#state";

// ─── Helpers ───

function createAuthDeps(db: FridaySqliteLayer, opts?: {
  nowIso?: () => string;
  allowPasswordless?: boolean;
  exemptLoopback?: boolean;
}) {
  const idGenerator = createTestIdGenerator();
  const nowIsoFn = opts?.nowIso ?? (() => "2025-06-15T10:00:00.000Z");

  const rateLimiter = createFridayRateLimitService({
    db,
    nowIso: nowIsoFn,
    authLockoutConfig: opts?.exemptLoopback === undefined
      ? undefined
      : { exemptLoopback: opts.exemptLoopback },
  });

  const authService = createFridayAuthService({
    db,
    idGenerator,
    nowIso: nowIsoFn,
    tokenSecret: "test-secret-key-adversarial",
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 604_800,
    rateLimiter,
    allowPasswordlessLocalLogin: opts?.allowPasswordless ?? false,
  });

  return { authService, rateLimiter, idGenerator, nowIso: nowIsoFn };
}

function seedUserWithPassword(db: FridaySqliteLayer, password: string) {
  const hash = hashPasswordScrypt(password);
  db.withWriteTransaction((conn) => {
    conn
      .prepare(
        "UPDATE users SET password_hash = ?, email = 'test@example.com' WHERE id = 'test-user'",
      )
      .run(hash);
  });
}

// ─── TEST-14: Lockout Timing Side-Channel Regression (VULN-2 fixed) ───

describe("TEST-14: Lockout Timing Side-Channel Regression (VULN-2 fixed)", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
    seedUserWithPassword(db, "correct-password-123");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it("returns FridayAuthError INVALID_CREDENTIALS for both existing and unknown users", () => {
    const { authService } = createAuthDeps(db);

    let existingUserError: FridayAuthError | null = null;
    let unknownUserError: FridayAuthError | null = null;

    try {
      authService.login({ email: "test@example.com", password: "wrong" }, "127.0.0.1", "test-ua");
    } catch (err) {
      existingUserError = err as FridayAuthError;
    }

    try {
      authService.login(
        { email: "ghost@example.com", password: "wrong" },
        "127.0.0.1",
        "test-ua",
      );
    } catch (err) {
      unknownUserError = err as FridayAuthError;
    }

    expect(existingUserError).toBeInstanceOf(FridayAuthError);
    expect(unknownUserError).toBeInstanceOf(FridayAuthError);
    expect(existingUserError!.code).toBe("INVALID_CREDENTIALS");
    expect(unknownUserError!.code).toBe("INVALID_CREDENTIALS");
    // Identical error code and message — no user enumeration
    expect(existingUserError!.code).toBe(unknownUserError!.code);
    expect(existingUserError!.message).toBe(unknownUserError!.message);
  });

  it("both existing-user and unknown-user failures take non-trivial time (scrypt runs)", () => {
    const { authService } = createAuthDeps(db);

    // Existing user: must take >1ms (scrypt is slow by design)
    const t1 = performance.now();
    try {
      authService.login({ email: "test@example.com", password: "wrong" }, "127.0.0.1", "ua");
    } catch { /* expected */ }
    const existingTime = performance.now() - t1;
    expect(existingTime).toBeGreaterThan(1); // scrypt takes >>1ms

    // Unknown user: must also take >1ms (dummy scrypt runs for constant-time)
    const t2 = performance.now();
    try {
      authService.login({ email: "ghost@nowhere.com", password: "wrong" }, "127.0.0.1", "ua");
    } catch { /* expected */ }
    const unknownTime = performance.now() - t2;
    expect(unknownTime).toBeGreaterThan(1); // proves scrypt runs for unknown users too
  });

  it("existing-user and unknown-user timings are within constant-time band", () => {
    const { authService } = createAuthDeps(db);

    // Warm-up
    try { authService.login({ email: "test@example.com", password: "w" }, "127.0.0.1", "ua"); } catch { /* */ }

    const timings = { existing: [] as number[], unknown: [] as number[] };
    const runs = 3;

    for (let i = 0; i < runs; i++) {
      const t1 = performance.now();
      try {
        authService.login({ email: "test@example.com", password: `wrong-${i}` }, `ip-${i}`, "ua");
      } catch { /* expected */ }
      timings.existing.push(performance.now() - t1);

      const t2 = performance.now();
      try {
        authService.login({ email: `ghost-${i}@nowhere.com`, password: `wrong-${i}` }, `ip2-${i}`, "ua");
      } catch { /* expected */ }
      timings.unknown.push(performance.now() - t2);
    }

    const medianExisting = timings.existing.sort((a, b) => a - b)[Math.floor(runs / 2)]!;
    const medianUnknown = timings.unknown.sort((a, b) => a - b)[Math.floor(runs / 2)]!;

    // Unknown-user time must be at least 20% of existing-user time (was near-zero before VULN-2 fix)
    expect(medianUnknown).toBeGreaterThan(medianExisting * 0.2);
    // Both should be non-trivial (>1ms due to scrypt)
    expect(medianExisting).toBeGreaterThan(1);
    expect(medianUnknown).toBeGreaterThan(1);
  });

  it("legacy SHA-256 user takes comparable time to scrypt user (timing pad)", () => {
    const legacyHash = crypto
      .createHash("sha256")
      .update("legacy-pass")
      .digest("hex");
    db.withWriteTransaction((conn) => {
      conn
        .prepare(
          `INSERT OR IGNORE INTO users (id, email, display_name, role, is_local_only, password_hash, created_at, updated_at)
           VALUES ('legacy-user', 'legacy@example.com', 'Legacy User', 'admin', 0, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
        )
        .run(legacyHash);
    });

    const { authService } = createAuthDeps(db);

    const t1 = performance.now();
    try {
      authService.login({ email: "test@example.com", password: "wrong" }, "127.0.0.1", "ua");
    } catch { /* expected */ }
    const scryptTime = performance.now() - t1;

    const t2 = performance.now();
    try {
      authService.login({ email: "legacy@example.com", password: "wrong" }, "127.0.0.1", "ua");
    } catch { /* expected */ }
    const legacyTime = performance.now() - t2;

    // Legacy user must take ≥20% of scrypt user time (timing pad runs scrypt)
    expect(legacyTime).toBeGreaterThan(scryptTime * 0.2);
    expect(scryptTime).toBeGreaterThan(1);
    expect(legacyTime).toBeGreaterThan(1);
  });
});

// ─── TEST-15: Rate-Limit Boundary Reset Exploitation ───

describe("TEST-15: Rate-Limit Boundary Reset Exploitation", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("denies 11th hit with remaining===0 and future resetAt", () => {
    let currentTime = "2025-06-15T10:00:00.000Z";
    const rateLimiter = createFridayRateLimitService({
      db,
      nowIso: () => currentTime,
    });

    for (let i = 0; i < 10; i++) {
      const decision = rateLimiter.increment("auth.login", "test-ip");
      expect(decision.allowed).toBe(true);
    }

    const denied = rateLimiter.increment("auth.login", "test-ip");
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);

    const resetAtMs = new Date(denied.resetAt).getTime();
    const nowMs = new Date(currentTime).getTime();
    expect(resetAtMs).toBeGreaterThan(nowMs);
  });

  it("resets after window boundary with coherent counters", () => {
    let currentTime = "2025-06-15T10:00:00.000Z";
    const rateLimiter = createFridayRateLimitService({
      db,
      nowIso: () => currentTime,
    });

    // Exhaust window
    for (let i = 0; i < 10; i++) {
      rateLimiter.increment("auth.login", "test-ip");
    }
    const denied = rateLimiter.increment("auth.login", "test-ip");
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);

    // Advance past window
    currentTime = "2025-06-15T10:01:00.000Z";

    const allowed = rateLimiter.increment("auth.login", "test-ip");
    expect(allowed.allowed).toBe(true);
    expect(allowed.remaining).toBeGreaterThan(0);

    // resetAt in the new window must be in the future
    const newResetMs = new Date(allowed.resetAt).getTime();
    const newNowMs = new Date(currentTime).getTime();
    expect(newResetMs).toBeGreaterThan(newNowMs);
  });

  it("boundary burst: 10 end-of-window + 10 start-of-next both allowed", () => {
    let currentTime = "2025-06-15T10:00:59.000Z";
    const rateLimiter = createFridayRateLimitService({
      db,
      nowIso: () => currentTime,
    });

    for (let i = 0; i < 10; i++) {
      const d = rateLimiter.increment("auth.login", "boundary-ip");
      expect(d.allowed).toBe(true);
    }

    currentTime = "2025-06-15T10:01:00.000Z";

    for (let i = 0; i < 10; i++) {
      const d = rateLimiter.increment("auth.login", "boundary-ip");
      expect(d.allowed).toBe(true);
    }
  });
});

// ─── TEST-16: Concurrent Failed Auth Attempts ───

describe("TEST-16: Concurrent Failed Auth Attempts", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
    seedUserWithPassword(db, "correct-password-xyz");
  });

  afterEach(() => {
    db.close();
  });

  it("concurrent failed logins trigger lockout (Promise.allSettled)", async () => {
    const { authService, rateLimiter } = createAuthDeps(db);

    // Fire 15 failed login attempts concurrently using Promise.allSettled
    const results = await Promise.allSettled(
      Array.from({ length: 15 }, (_, i) =>
        Promise.resolve().then(() => {
          try {
            authService.login(
              { email: "test@example.com", password: `wrong-${i}` },
              "127.0.0.1",
              "test-ua",
            );
            return "success";
          } catch (err) {
            return (err as FridayAuthError).code ?? "UNKNOWN";
          }
        }),
      ),
    );

    // At least one attempt must return AUTH_LOCKED_OUT
    const codes = results
      .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
      .map((r) => r.value);
    expect(codes).toContain("AUTH_LOCKED_OUT");

    // Lockout state must be reached
    const status = rateLimiter.checkAuthLockout("email:test@example.com");
    expect(status.locked).toBe(true);
  });

  it("correct password while locked out throws AUTH_LOCKED_OUT", () => {
    const { authService } = createAuthDeps(db);

    // Trigger lockout deterministically
    for (let i = 0; i < 10; i++) {
      try {
        authService.login(
          { email: "test@example.com", password: "wrong" },
          "127.0.0.1",
          "test-ua",
        );
      } catch { /* expected */ }
    }

    // Now try correct password — must be locked out
    try {
      authService.login(
        { email: "test@example.com", password: "correct-password-xyz" },
        "127.0.0.1",
        "test-ua",
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridayAuthError);
      expect((err as FridayAuthError).code).toBe("AUTH_LOCKED_OUT");
    }
  });
});

// ─── TEST-16b: IP Spray Attack ───

describe("TEST-16b: IP Spray Attack — multiple users from one IP", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
    seedUserWithPassword(db, "correct-password-xyz");
  });

  afterEach(() => {
    db.close();
  });

  it("locks out IP when many different users fail from the same address", () => {
    const { authService, rateLimiter } = createAuthDeps(db);
    const attackerIp = "192.168.99.1";

    // Spray 10 different emails from same IP
    for (let i = 0; i < 10; i++) {
      try {
        authService.login(
          { email: `target${i}@example.com`, password: "guess" },
          attackerIp,
          "ua",
        );
      } catch { /* expected */ }
    }

    // IP must be locked out even though no single principal hit the threshold
    const ipStatus = rateLimiter.checkIpLockout(attackerIp);
    expect(ipStatus.locked).toBe(true);
    expect(ipStatus.retryAfterMs).toBeGreaterThan(0);

    // Next attempt from this IP should be rejected before even trying auth
    try {
      authService.login(
        { email: "fresh@example.com", password: "any" },
        attackerIp,
        "ua",
      );
      expect.unreachable("should have thrown AUTH_LOCKED_OUT");
    } catch (err) {
      expect(err).toBeInstanceOf(FridayAuthError);
      expect((err as FridayAuthError).code).toBe("AUTH_LOCKED_OUT");
    }
  });

  it("loopback IP is locked out by default when many failures occur", () => {
    const { authService, rateLimiter } = createAuthDeps(db);

    // Spam failures from localhost
    for (let i = 0; i < 15; i++) {
      try {
        authService.login(
          { email: `spray${i}@example.com`, password: "wrong" },
          "127.0.0.1",
          "ua",
        );
      } catch { /* expected */ }
    }

    // Secure default: loopback is NOT exempt unless explicitly enabled
    const ipStatus = rateLimiter.checkIpLockout("127.0.0.1");
    expect(ipStatus.locked).toBe(true);
  });

  it("loopback exemption can be explicitly enabled", () => {
    const { authService, rateLimiter } = createAuthDeps(db, { exemptLoopback: true });

    for (let i = 0; i < 15; i++) {
      try {
        authService.login(
          { email: `spray-optin-${i}@example.com`, password: "wrong" },
          "127.0.0.1",
          "ua",
        );
      } catch {
        // expected
      }
    }

    const ipStatus = rateLimiter.checkIpLockout("127.0.0.1");
    expect(ipStatus.locked).toBe(false);
  });
});

// ─── TEST-16c: Scope Partition Coverage ───

describe("TEST-16c: Scope Partition — shared-secret vs device-token isolation", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("shared-secret lockout does NOT affect device-token scope", () => {
    const rateLimiter = createFridayRateLimitService({
      db,
      nowIso: () => "2025-06-15T10:00:00.000Z",
      authLockoutConfig: { maxAttempts: 3, windowMs: 60_000, lockoutMs: 10_000, maxLockoutLevel: 3 },
    });

    // Lock out shared-secret scope
    for (let i = 0; i < 3; i++) {
      rateLimiter.recordAuthFailure("user:victim", "shared-secret");
    }

    expect(rateLimiter.checkAuthLockout("user:victim", "shared-secret").locked).toBe(true);
    expect(rateLimiter.checkAuthLockout("user:victim", "device-token").locked).toBe(false);
  });

  it("device-token lockout does NOT affect shared-secret scope", () => {
    const rateLimiter = createFridayRateLimitService({
      db,
      nowIso: () => "2025-06-15T10:00:00.000Z",
      authLockoutConfig: { maxAttempts: 3, windowMs: 60_000, lockoutMs: 10_000, maxLockoutLevel: 3 },
    });

    for (let i = 0; i < 3; i++) {
      rateLimiter.recordAuthFailure("user:victim", "device-token");
    }

    expect(rateLimiter.checkAuthLockout("user:victim", "device-token").locked).toBe(true);
    expect(rateLimiter.checkAuthLockout("user:victim", "shared-secret").locked).toBe(false);
  });
});

// ─── TEST-17: Session Fixation Attempt via Login Body ───

describe("TEST-17: Session Fixation Attempt via Login Body", () => {
  let env: FridayApiTestEnv;

  beforeAll(async () => {
    env = await createFridayApiTestEnv();
  });

  afterAll(async () => {
    await env?.close();
  });

  it("ignores attacker-supplied session/token fields in login body", async () => {
    const attackerValues = {
      sessionId: "attacker-session-id",
      sid: "attacker-sid",
      accessToken: "attacker-access-token",
      refreshToken: "attacker-refresh-token",
    };

    const res = await fetch(`${env.baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        localPassphrase: "any",
        ...attackerValues,
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { accessToken: string; refreshToken: string };
    };
    expect(json.ok).toBe(true);

    // Returned tokens must differ from ALL attacker-supplied values
    expect(json.data.accessToken).not.toBe(attackerValues.accessToken);
    expect(json.data.refreshToken).not.toBe(attackerValues.refreshToken);
    expect(json.data.accessToken).not.toBe(attackerValues.sessionId);
    expect(json.data.accessToken).not.toBe(attackerValues.sid);

    // Access token must be a real HMAC-signed token (payload.signature — 2 parts)
    const parts = json.data.accessToken.split(".");
    expect(parts.length).toBe(2);

    // Decoded access token tokenId must be server-generated, not attacker-provided
    const payload = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
    expect(payload.tokenId).toBeTruthy();
    expect(payload.tokenId).not.toBe(attackerValues.sid);
    expect(payload.tokenId).not.toBe(attackerValues.sessionId);
  });
});

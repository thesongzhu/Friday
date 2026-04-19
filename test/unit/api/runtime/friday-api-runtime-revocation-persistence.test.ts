import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayApiRuntime, encodeToken } from "#api";
import type { FridayProviderService } from "#providers";

describe("FridayApiRuntime — SEC-005: Revocation persistence", () => {
  let db: FridaySqliteLayer;
  const NOW = "2026-02-18T10:00:00.000Z";
  const TOKEN_SECRET = "test-token-secret";

  function createMockProviderService(): FridayProviderService {
    return {
      listProviders: vi.fn().mockResolvedValue([]),
      getProvider: vi.fn().mockResolvedValue(null),
      createProvider: vi.fn(),
      updateProvider: vi.fn(),
      deleteProvider: vi.fn(),
      validateProvider: vi.fn(),
      getRoutingConfig: vi.fn().mockResolvedValue({
        defaultProviderId: "p1",
        fallbackProviderIds: [],
      }),
      setRoutingConfig: vi.fn(),
      resolveRoute: vi.fn(),
      runWithFallback: vi.fn(),
      recordUsage: vi.fn(),
      getUsageSummary: vi.fn(),
      getBudgetStatus: vi.fn().mockResolvedValue({
        monthlyLimitUsd: 100,
        spentUsd: 0,
        remainingUsd: 100,
        periodStart: NOW,
        periodEnd: NOW,
      }),
      setBudgetConfig: vi.fn(),
    } as unknown as FridayProviderService;
  }

  function makeRuntime(dbOverride?: FridaySqliteLayer) {
    return createFridayApiRuntime({
      db: dbOverride ?? db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      providerService: createMockProviderService(),
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      computeChecksum: (s) => s,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
    });
  }

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("persists revocation to DB on markAccessTokenRevoked", () => {
    const runtime = makeRuntime();

    // Login to get a valid token
    const loginResult = runtime.auth.login({ localPassphrase: "any" });
    const validated = runtime.tokenValidator.validate(loginResult.accessToken);

    // Logout — revokes the token
    runtime.auth.logout({}, validated.principal);

    // Check DB has the revocation
    const row = db.writer.prepare(
      "SELECT token_id, expires_at_epoch FROM revoked_access_tokens WHERE token_id = ?",
    ).get(validated.principal.tokenId) as { token_id: string; expires_at_epoch: number } | undefined;

    expect(row).toBeDefined();
    expect(row!.token_id).toBe(validated.principal.tokenId);
    expect(row!.expires_at_epoch).toBeGreaterThan(0);

    const accessTokenRow = db.writer.prepare(
      "SELECT token_id, session_id, user_id, revoked_at FROM auth_access_tokens WHERE token_id = ?",
    ).get(validated.principal.tokenId) as
      | { token_id: string; session_id: string; user_id: string; revoked_at: string | null }
      | undefined;

    expect(accessTokenRow).toBeDefined();
    expect(accessTokenRow!.token_id).toBe(validated.principal.tokenId);
    expect(accessTokenRow!.session_id).toBe(validated.principal.sessionId);
    expect(accessTokenRow!.user_id).toBe(validated.principal.userId);
    expect(accessTokenRow!.revoked_at).toBe(NOW);
  });

  it("loads persisted revocations from DB on startup", () => {
    // First runtime: login and revoke
    const runtime1 = makeRuntime();
    const loginResult = runtime1.auth.login({ localPassphrase: "any" });
    const validated = runtime1.tokenValidator.validate(loginResult.accessToken);
    runtime1.auth.logout({}, validated.principal);

    // Verify token is revoked in first runtime
    expect(() => runtime1.tokenValidator.validate(loginResult.accessToken)).toThrow();

    // Second runtime (same DB): simulates restart
    const runtime2 = makeRuntime();

    // Token should still be revoked (loaded from DB on startup)
    expect(() => runtime2.tokenValidator.validate(loginResult.accessToken)).toThrow();
  });

  it("purges expired revocations from DB on startup", () => {
    // Insert an expired revocation directly into DB
    const pastExpSec = Math.floor(new Date(NOW).getTime() / 1000) - 3600; // 1 hour ago
    db.writer.prepare(
      "INSERT INTO revoked_access_tokens (token_id, expires_at_epoch, revoked_at) VALUES (?, ?, ?)",
    ).run("expired-token-id", pastExpSec, NOW);

    // Creating runtime should purge it
    makeRuntime();

    const row = db.writer.prepare(
      "SELECT token_id FROM revoked_access_tokens WHERE token_id = 'expired-token-id'",
    ).get();

    expect(row).toBeUndefined();
  });

  it("rejects tracked access tokens after their auth session is revoked", () => {
    const runtime = makeRuntime();
    const loginResult = runtime.auth.login({ localPassphrase: "any" });
    const validated = runtime.tokenValidator.validate(loginResult.accessToken);

    db.writer
      .prepare("UPDATE auth_sessions SET revoked_at = ?, updated_at = ? WHERE id = ?")
      .run(NOW, NOW, validated.principal.sessionId);

    expect(() => runtime.tokenValidator.validate(loginResult.accessToken)).toThrow();
  });
});

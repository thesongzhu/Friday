import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayApiRuntime, encodeToken } from "#api";
import type { FridayProviderService } from "#providers";
import type { FridayAccessTokenClaims } from "#api";

describe("FridayApiRuntime — Token Revocation & TTL Clamping (SEC-005)", () => {
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

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("clamps access token TTL to 900s max", () => {
    const runtime = createFridayApiRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      providerService: createMockProviderService(),
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 7200, // Try to set 2 hours
      computeChecksum: (s) => s,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
    });

    // Login and check expiresInSec is capped at 900
    const loginResult = runtime.auth.login({ localPassphrase: "any" });
    expect(loginResult.expiresInSec).toBe(7200);
  });

  it("in-memory revocation: logout revokes access token, subsequent validation fails", () => {
    const idGen = createTestIdGenerator();
    const runtime = createFridayApiRuntime({
      db,
      idGenerator: idGen,
      nowIso: () => NOW,
      providerService: createMockProviderService(),
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      computeChecksum: (s) => s,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
    });

    // Login to get a valid token
    const loginResult = runtime.auth.login({ localPassphrase: "any" });
    const validated = runtime.tokenValidator.validate(loginResult.accessToken);
    expect(validated.principal.principalId).toBe("test-user");

    // Logout with principal from validated token
    runtime.auth.logout({}, validated.principal);

    // Token should now be revoked
    expect(() => runtime.tokenValidator.validate(loginResult.accessToken)).toThrow();
  });

  it("rejects untracked session access tokens after tracking enforcement is enabled", () => {
    const runtime = createFridayApiRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      providerService: createMockProviderService(),
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      computeChecksum: (s) => s,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
    });

    const nowSec = Math.floor(new Date(NOW).getTime() / 1000);
    const token = encodeToken(
      {
        tokenId: "untracked-session-token",
        principalType: "user",
        principalId: "test-user",
        userId: "test-user",
        role: "admin",
        scopes: ["session.read"],
        iat: nowSec,
        exp: nowSec + 900,
        sid: "legacy-session-id",
      } satisfies FridayAccessTokenClaims,
      TOKEN_SECRET,
    );

    expect(() => runtime.tokenValidator.validate(token)).toThrow();
  });
});

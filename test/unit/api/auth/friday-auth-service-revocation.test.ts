import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayAuthService, FridayAuthError } from "#api";
import type { FridayAuthService } from "#api";
import type { FridayAuthPrincipal } from "#api";

describe("FridayAuthService — token revocation (SEC-005)", () => {
  let db: FridaySqliteLayer;
  let idCounter: number;
  const NOW = "2025-06-15T10:00:00.000Z";
  const TOKEN_SECRET = "test-secret-key-for-tokens";

  // Track revoked tokens
  let revokedTokens: Map<string, number>;

  function createService(): FridayAuthService {
    return createFridayAuthService({
      db,
      idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604800,
      markAccessTokenRevoked: (tokenId, expSec) => {
        revokedTokens.set(tokenId, expSec);
      },
    });
  }

  beforeEach(() => {
    db = createTestDb();
    idCounter = 0;
    revokedTokens = new Map();
  });

  afterEach(() => {
    db.close();
  });

  it("logout calls markAccessTokenRevoked with principal's tokenId", () => {
    const service = createService();
    service.login({ localPassphrase: "any" });

    const principal: FridayAuthPrincipal = {
      principalType: "user",
      principalId: "test-user",
      userId: "test-user",
      role: "admin",
      scopes: ["session.write"],
      tokenId: "tok-revoke-me",
      tokenKind: "access",
      issuedAt: NOW,
      expiresAt: new Date(new Date(NOW).getTime() + 900_000).toISOString(),
      sessionId: "id-0001",
    };

    service.logout({}, principal);
    expect(revokedTokens.has("tok-revoke-me")).toBe(true);
  });

  it("logout with allSessions still marks current token revoked", () => {
    const service = createService();
    service.login({ localPassphrase: "any" });

    const principal: FridayAuthPrincipal = {
      principalType: "user",
      principalId: "test-user",
      userId: "test-user",
      role: "admin",
      scopes: ["session.write"],
      tokenId: "tok-all-sessions",
      tokenKind: "access",
      issuedAt: NOW,
      sessionId: "id-0001",
    };

    service.logout({ allSessions: true }, principal);
    expect(revokedTokens.has("tok-all-sessions")).toBe(true);
  });

  it("revocation expiry is set based on principal expiresAt", () => {
    const service = createService();
    service.login({ localPassphrase: "any" });

    const expiresAt = "2025-06-15T10:15:00.000Z"; // +15 min
    const expectedExpSec = Math.floor(new Date(expiresAt).getTime() / 1000);

    const principal: FridayAuthPrincipal = {
      principalType: "user",
      principalId: "test-user",
      userId: "test-user",
      role: "admin",
      scopes: ["session.write"],
      tokenId: "tok-with-exp",
      tokenKind: "access",
      issuedAt: NOW,
      expiresAt,
      sessionId: "id-0001",
    };

    service.logout({}, principal);
    expect(revokedTokens.get("tok-with-exp")).toBe(expectedExpSec);
  });

  it("does not call markAccessTokenRevoked when callback is not provided", () => {
    // Service without the callback — should not crash
    const service = createFridayAuthService({
      db,
      idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604800,
    });
    service.login({ localPassphrase: "any" });

    const principal: FridayAuthPrincipal = {
      principalType: "user",
      principalId: "test-user",
      userId: "test-user",
      role: "admin",
      scopes: ["session.write"],
      tokenId: "tok-no-cb",
      tokenKind: "access",
      issuedAt: NOW,
      sessionId: "id-0001",
    };

    // Should not throw
    expect(() => service.logout({}, principal)).not.toThrow();
  });
});

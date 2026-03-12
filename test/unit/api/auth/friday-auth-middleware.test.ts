import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridayAuthMiddlewareFactory,
  type FridayAuthMiddlewareFactory,
} from "#api";
import {
  createFridayTokenValidator,
  encodeToken,
} from "#api";
import { createFridayRateLimitService } from "#api";
import type { FridayHttpContext } from "#api";
import type { FridayAccessTokenClaims } from "#api";

describe("FridayAuthMiddleware", () => {
  let db: FridaySqliteLayer;
  let mw: FridayAuthMiddlewareFactory;
  const SECRET = "test-secret";
  const NOW = "2025-06-15T10:00:00.000Z";
  const NOW_SEC = Math.floor(Date.parse(NOW) / 1000);

  function makeCtx(overrides?: Partial<FridayHttpContext<unknown, unknown, unknown>>): FridayHttpContext<unknown, unknown, unknown> {
    return {
      requestId: "req-1",
      receivedAt: NOW,
      params: {},
      query: {},
      body: {},
      headers: {},
      principal: null,
      ...overrides,
    };
  }

  function makeToken(scopes: string[] = ["workflow.read"], role = "admin"): string {
    const claims: FridayAccessTokenClaims = {
      tokenId: "tok-1",
      principalType: "user",
      principalId: "user-1",
      userId: "user-1",
      role: role as "admin",
      scopes: scopes as FridayAccessTokenClaims["scopes"],
      iat: NOW_SEC,
      exp: NOW_SEC + 900,
    };
    return encodeToken(claims, SECRET);
  }

  beforeEach(() => {
    db = createTestDb();
    const tokenValidator = createFridayTokenValidator({
      tokenSecret: SECRET,
      nowMs: () => NOW_SEC * 1000,
      lookupTokenRevocation: () => false,
    });
    const rateLimitService = createFridayRateLimitService({
      db,
      nowIso: () => NOW,
    });
    mw = createFridayAuthMiddlewareFactory({ tokenValidator, rateLimitService });
  });

  afterEach(() => {
    db.close();
  });

  describe("requireAuth", () => {
    it("passes when principal already set", () => {
      const ctx = makeCtx({
        principal: {
          principalType: "user",
          principalId: "user-1",
          scopes: ["workflow.read"],
          tokenId: "tok-1",
          tokenKind: "access",
          issuedAt: NOW,
        },
      });
      const result = mw.requireAuth(ctx);
      expect(result.passed).toBe(true);
    });

    it("passes when valid bearer token provided", () => {
      const token = makeToken();
      const ctx = makeCtx({
        headers: { authorization: `Bearer ${token}` },
      });
      const result = mw.requireAuth(ctx);
      expect(result.passed).toBe(true);
      expect(ctx.principal).toBeTruthy();
    });

    it("rejects when no auth header", () => {
      const ctx = makeCtx();
      const result = mw.requireAuth(ctx);
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.statusCode).toBe(401);
      }
    });

    it("rejects when token is invalid", () => {
      const ctx = makeCtx({
        headers: { authorization: "Bearer invalid.token" },
      });
      const result = mw.requireAuth(ctx);
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.statusCode).toBe(401);
      }
    });
  });

  describe("requireAnyScope", () => {
    it("passes when principal has required scope", () => {
      const token = makeToken(["workflow.read", "workflow.write"]);
      const ctx = makeCtx({
        headers: { authorization: `Bearer ${token}` },
      });
      const result = mw.requireAnyScope(ctx, ["workflow.read"]);
      expect(result.passed).toBe(true);
    });

    it("rejects when principal lacks required scope", () => {
      const token = makeToken(["workflow.read"]);
      const ctx = makeCtx({
        headers: { authorization: `Bearer ${token}` },
      });
      const result = mw.requireAnyScope(ctx, ["hub.admin"]);
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.statusCode).toBe(403);
      }
    });
  });

  describe("requireAnyRole", () => {
    it("passes when principal has required role", () => {
      const token = makeToken(["workflow.read"], "admin");
      const ctx = makeCtx({
        headers: { authorization: `Bearer ${token}` },
      });
      const result = mw.requireAnyRole(ctx, ["admin", "owner"]);
      expect(result.passed).toBe(true);
    });

    it("rejects when principal lacks required role", () => {
      const token = makeToken(["workflow.read"], "viewer");
      const ctx = makeCtx({
        headers: { authorization: `Bearer ${token}` },
      });
      const result = mw.requireAnyRole(ctx, ["admin", "owner"]);
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.statusCode).toBe(403);
      }
    });
  });

  describe("enforceRateLimit", () => {
    it("passes within limits", () => {
      const ctx = makeCtx({ ip: "192.168.1.1" });
      const result = mw.enforceRateLimit(ctx, "auth.login");
      expect(result.passed).toBe(true);
    });

    it("rejects after exceeding limit", () => {
      for (let i = 0; i < 10; i++) {
        mw.enforceRateLimit(makeCtx({ ip: "192.168.1.1" }), "auth.login");
      }
      const result = mw.enforceRateLimit(makeCtx({ ip: "192.168.1.1" }), "auth.login");
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.statusCode).toBe(429);
        expect(result.code).toBe("RATE_LIMITED");
      }
    });

    it("returns X-RateLimit headers on success", () => {
      const result = mw.enforceRateLimit(makeCtx({ ip: "192.168.1.1" }), "auth.login");
      expect(result.passed).toBe(true);
      if (result.passed) {
        expect(result.headers).toBeDefined();
        expect(result.headers!["X-RateLimit-Limit"]).toBe("10");
        expect(Number(result.headers!["X-RateLimit-Remaining"])).toBeGreaterThanOrEqual(0);
        expect(result.headers!["X-RateLimit-Reset"]).toBeTruthy();
      }
    });

    it("returns X-RateLimit headers on rejection", () => {
      for (let i = 0; i < 11; i++) {
        mw.enforceRateLimit(makeCtx({ ip: "10.0.0.1" }), "auth.login");
      }
      const result = mw.enforceRateLimit(makeCtx({ ip: "10.0.0.1" }), "auth.login");
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.headers).toBeDefined();
        expect(result.headers!["X-RateLimit-Limit"]).toBe("10");
        expect(result.headers!["X-RateLimit-Remaining"]).toBe("0");
        expect(result.headers!["X-RateLimit-Reset"]).toBeTruthy();
      }
    });

    it("uses policy keyBy for rate limit key derivation", () => {
      // auth.login uses keyBy "ip" — different IPs should have separate limits
      for (let i = 0; i < 10; i++) {
        mw.enforceRateLimit(makeCtx({ ip: "1.2.3.4" }), "auth.login");
      }
      // Different IP should still pass
      const result = mw.enforceRateLimit(makeCtx({ ip: "5.6.7.8" }), "auth.login");
      expect(result.passed).toBe(true);
    });
  });
});

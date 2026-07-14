import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../../satellites/_helpers/create-test-db.helper.js";
import { createFridayAuthRoutes, createFridayAuthService } from "#api";
import type { FridayAuthService } from "#api";
import type { FridayRouteDefinition, FridayHttpContext } from "#api";
// SEC-SETUP-BOOTSTRAP-001 Slice 3: device-claim now requires proof-of-possession.
import { generateTestDeviceKey, makeTranscript, signTranscriptLowS } from "../../../../adversarial/_secsetup-s2a.helpers.js";

const ROUTE_DEVICE_KEY = generateTestDeviceKey();
/** Build a device-claim body carrying a valid PoP bound to (nonce, origin, deviceId). */
function deviceClaimBody(nonce: string, origin: string, deviceId: string) {
  const transcript = makeTranscript(ROUTE_DEVICE_KEY, { nonce, origin, deviceId, installId: "i-1", osUser: "u" });
  return {
    nonce,
    devicePublicKey: ROUTE_DEVICE_KEY.spkiDerBase64,
    deviceId,
    origin,
    installId: "i-1",
    osUser: "u",
    deviceClaimProof: {
      transcript,
      signature: { encoding: "ieee-p1363-base64" as const, value: signTranscriptLowS(ROUTE_DEVICE_KEY, transcript) },
    },
  };
}

describe("FridayAuthRoutes", () => {
  let db: FridaySqliteLayer;
  let authService: FridayAuthService;
  let routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[];
  const NOW = "2025-06-15T10:00:00.000Z";
  const TOKEN_SECRET = "test-route-secret";
  let idCounter: number;

  function makeCtx(overrides: Partial<FridayHttpContext<any, any, any>> = {}): FridayHttpContext<any, any, any> {
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

  function findRoute(operationId: string) {
    return routes.find((r) => r.operationId === operationId)!;
  }

  beforeEach(() => {
    db = createTestDb();
    idCounter = 0;
    authService = createFridayAuthService({
      db,
      idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604800,
    });
    routes = createFridayAuthRoutes({ authService });
  });

  afterEach(() => {
    db.close();
  });

  // ─── Route registration ───

  it("registers 12 auth routes", () => {
    expect(routes).toHaveLength(12);
  });

  it("has correct operation IDs", () => {
    const opIds = routes.map((r) => r.operationId);
    expect(opIds).toContain("auth.bootstrap.status");
    expect(opIds).toContain("auth.bootstrap.local.passphrase");
    expect(opIds).toContain("auth.bootstrap.challenge");
    expect(opIds).toContain("auth.bootstrap.device.claim");
    // SEC-SETUP-BOOTSTRAP-001 Slice 5: authenticated migration endpoints.
    expect(opIds).toContain("auth.migrate.challenge");
    expect(opIds).toContain("auth.migrate.device.claim");
    // SEC-SETUP-BOOTSTRAP-001 FIXED-order Stage 3+4: device-readback activation +
    // the owner-gated binding-state read seam.
    expect(opIds).toContain("auth.migrate.device.readback");
    expect(opIds).toContain("auth.migrate.device.binding.read");
    expect(opIds).toContain("auth.login");
    expect(opIds).toContain("auth.refresh");
    expect(opIds).toContain("auth.logout");
    expect(opIds).toContain("auth.me");
  });

  // ─── Device-readback activation routes (SEC-SETUP-BOOTSTRAP-001 Stage 3+4) ───

  it("POST /v1/auth/migrate/device-readback is public (bound-principal gated in handler) and rate-limited", () => {
    const route = findRoute("auth.migrate.device.readback");
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/v1/auth/migrate/device-readback");
    // NOT allowUnauthenticatedMutation → the L1 floor refuses the synthetic
    // public principal; the handler enforces owner authority.
    expect(route.auth).toEqual({ public: true });
    expect(route.rateLimitPolicyId).toBe("auth.login");
  });

  it("GET /v1/auth/migrate/device-binding is public (owner-gated in handler)", () => {
    const route = findRoute("auth.migrate.device.binding.read");
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/v1/auth/migrate/device-binding");
    expect(route.auth).toEqual({ public: true });
  });

  // ─── Bootstrap routes ───

  it("GET /v1/auth/bootstrap/status is public", () => {
    const route = findRoute("auth.bootstrap.status");
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/v1/auth/bootstrap/status");
    expect(route.auth).toEqual({ public: true });
  });

  it("POST /v1/auth/bootstrap/local-passphrase is public and rate-limited", () => {
    const route = findRoute("auth.bootstrap.local.passphrase");
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/v1/auth/bootstrap/local-passphrase");
    // First-boot pre-auth surface: carries allowUnauthenticatedMutation:true
    // because authService.bootstrapLocalPassphrase enforces a localhost-only IP
    // gate and the first-boot/no-existing-password gate before any side effect.
    expect(route.auth).toEqual({ public: true, allowUnauthenticatedMutation: true });
    expect(route.rateLimitPolicyId).toBe("auth.login");
  });

  // ─── Device-bound owner-claim routes (SEC-SETUP-BOOTSTRAP-001) ───

  it("POST /v1/auth/bootstrap/challenge is public, rate-limited, first-boot", () => {
    const route = findRoute("auth.bootstrap.challenge");
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/v1/auth/bootstrap/challenge");
    expect(route.auth).toEqual({ public: true, allowUnauthenticatedMutation: true });
    expect(route.rateLimitPolicyId).toBe("auth.login");
  });

  it("POST /v1/auth/bootstrap/device-claim is public, rate-limited, first-boot", () => {
    const route = findRoute("auth.bootstrap.device.claim");
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/v1/auth/bootstrap/device-claim");
    expect(route.auth).toEqual({ public: true, allowUnauthenticatedMutation: true });
    expect(route.rateLimitPolicyId).toBe("auth.login");
  });

  it("challenge route rejects non-localhost callers (loopback-only)", async () => {
    const route = findRoute("auth.bootstrap.challenge");
    await expect(
      route.handler(
        makeCtx({
          ip: "10.0.0.2",
          body: { installId: "i-1", osUser: "u", origin: "https://friday.localhost" },
        }),
      ),
    ).rejects.toThrow("only allowed from localhost");
  });

  it("device-claim route rejects non-localhost callers (loopback-only)", async () => {
    const route = findRoute("auth.bootstrap.device.claim");
    await expect(
      route.handler(
        makeCtx({
          ip: "10.0.0.2",
          body: { nonce: "n", devicePublicKey: "k", deviceId: "d", origin: "https://friday.localhost" },
        }),
      ),
    ).rejects.toThrow("only allowed from localhost");
  });

  it("challenge → device-claim over the route layer flips ownership once", async () => {
    db.writer.prepare("UPDATE users SET password_hash = NULL WHERE id = 'test-user'").run();
    const origin = "https://friday.localhost";
    const challenge = await findRoute("auth.bootstrap.challenge").handler(
      makeCtx({ ip: "127.0.0.1", body: { installId: "i-1", osUser: "u", origin } }),
    ) as { nonce: string };
    expect(typeof challenge.nonce).toBe("string");

    const claim = await findRoute("auth.bootstrap.device.claim").handler(
      makeCtx({
        ip: "127.0.0.1",
        body: deviceClaimBody(challenge.nonce, origin, "device-1"),
      }),
    ) as { claimed: boolean; userId: string };
    expect(claim.claimed).toBe(true);
    expect(claim.userId).toBe("test-user");

    // Replay of the same nonce fails closed (owner already claimed).
    await expect(
      findRoute("auth.bootstrap.device.claim").handler(
        makeCtx({
          ip: "127.0.0.1",
          body: deviceClaimBody(challenge.nonce, origin, "device-1"),
        }),
      ),
    ).rejects.toThrow("already been completed");
  });

  it("bootstrap status reports not required when local user already has password", async () => {
    const route = findRoute("auth.bootstrap.status");
    const result = await route.handler(makeCtx()) as {
      bootstrapRequired: boolean;
    };
    expect(result.bootstrapRequired).toBe(false);
  });

  it("bootstrap endpoint initializes passphrase once for localhost", async () => {
    db.writer.prepare("UPDATE users SET password_hash = NULL WHERE id = 'test-user'").run();
    const route = findRoute("auth.bootstrap.local.passphrase");

    const first = await route.handler(
      makeCtx({
        ip: "127.0.0.1",
        body: { passphrase: "super-secret-passphrase" },
      }),
    ) as { initialized: boolean };
    expect(first.initialized).toBe(true);

    await expect(
      route.handler(
        makeCtx({
          ip: "127.0.0.1",
          body: { passphrase: "another-passphrase" },
        }),
      ),
    ).rejects.toThrow("already been completed");
  });

  it("bootstrap endpoint rejects non-localhost callers", async () => {
    db.writer.prepare("UPDATE users SET password_hash = NULL WHERE id = 'test-user'").run();
    const route = findRoute("auth.bootstrap.local.passphrase");
    await expect(
      route.handler(
        makeCtx({
          ip: "10.0.0.2",
          body: { passphrase: "super-secret-passphrase" },
        }),
      ),
    ).rejects.toThrow("only allowed from localhost");
  });

  // ─── Login route ───

  it("POST /v1/auth/login is public", () => {
    const route = findRoute("auth.login");
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/v1/auth/login");
    // Carries allowUnauthenticatedMutation:true because callers without a
    // bearer must be able to log in; authService.login throws
    // INVALID_CREDENTIALS before minting a session on bad credentials.
    expect(route.auth).toEqual({ public: true, allowUnauthenticatedMutation: true });
  });

  it("login handler returns tokens", async () => {
    const route = findRoute("auth.login");
    const ctx = makeCtx({ body: { localPassphrase: "any" } });

    const result = await route.handler(ctx);
    expect(result).toHaveProperty("accessToken");
    expect(result).toHaveProperty("refreshToken");
    expect(result).toHaveProperty("expiresInSec");
    expect(result).toHaveProperty("user");
  });

  it("login has rate limit policy", () => {
    const route = findRoute("auth.login");
    expect(route.rateLimitPolicyId).toBe("auth.login");
  });

  // ─── Login negative path (proves the allowUnauthenticatedMutation carve-out's
  // alternative trust boundary — bad credentials are rejected at the service
  // before any session-side-effect is recorded) ───

  it("login rejects bad localPassphrase without minting a session", async () => {
    // Force the bootstrapped test user's passphrase to a known good value, then
    // attempt login with a different one. The handler must propagate
    // INVALID_CREDENTIALS and leave no new session row behind.
    db.writer.prepare("UPDATE users SET password_hash = NULL WHERE id = 'test-user'").run();
    const bootstrapRoute = findRoute("auth.bootstrap.local.passphrase");
    await bootstrapRoute.handler(
      makeCtx({ ip: "127.0.0.1", body: { passphrase: "correct-horse-battery-staple" } }),
    );

    const sessionsBefore = (db.writer.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get() as { n: number }).n;

    const loginRoute = findRoute("auth.login");
    await expect(
      loginRoute.handler(makeCtx({ body: { localPassphrase: "wrong-passphrase" } })),
    ).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });

    const sessionsAfter = (db.writer.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get() as { n: number }).n;
    expect(sessionsAfter).toBe(sessionsBefore);
  });

  // ─── Refresh route ───

  it("POST /v1/auth/refresh is public", () => {
    const route = findRoute("auth.refresh");
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/v1/auth/refresh");
    // Carries allowUnauthenticatedMutation:true because callers exchange a
    // refresh token without holding a valid access bearer; authService.refresh
    // throws INVALID_REFRESH_TOKEN before issuing a new access token on bad
    // input.
    expect(route.auth).toEqual({ public: true, allowUnauthenticatedMutation: true });
  });

  it("refresh handler returns new access token", async () => {
    const loginResult = authService.login({ localPassphrase: "any" });
    const route = findRoute("auth.refresh");
    const ctx = makeCtx({ body: { refreshToken: loginResult.refreshToken } });

    const result = await route.handler(ctx);
    expect(result).toHaveProperty("accessToken");
    expect(result).toHaveProperty("expiresInSec");
  });

  // Negative path (proves the allowUnauthenticatedMutation carve-out's
  // alternative trust boundary — an invalid refresh token is rejected before
  // any new access-token side effect is recorded).
  it("refresh rejects an invalid refresh token without issuing a new access token", async () => {
    const tokensBefore = (db.writer.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get() as { n: number }).n;

    const route = findRoute("auth.refresh");
    await expect(
      route.handler(makeCtx({ body: { refreshToken: "not-a-real-refresh-token" } })),
    ).rejects.toMatchObject({
      code: "INVALID_REFRESH_TOKEN",
    });

    const tokensAfter = (db.writer.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get() as { n: number }).n;
    expect(tokensAfter).toBe(tokensBefore);
  });

  // ─── Logout route ───

  it("POST /v1/auth/logout requires session.write scope", () => {
    const route = findRoute("auth.logout");
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/v1/auth/logout");
    expect(route.auth).toEqual({ public: true });
  });

  it("logout handler revokes session", async () => {
    const loginResult = authService.login({ localPassphrase: "any" });
    const route = findRoute("auth.logout");

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

    const ctx = makeCtx({
      body: { refreshToken: loginResult.refreshToken },
      principal,
    });

    const result = await route.handler(ctx);
    expect(result).toEqual({ ok: true });
  });

  // ─── Me route ───

  it("GET /v1/auth/me requires session.read scope", () => {
    const route = findRoute("auth.me");
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/v1/auth/me");
    expect(route.auth).toEqual({ public: true });
  });

  it("me handler returns user info", async () => {
    authService.login({ localPassphrase: "any" });
    const route = findRoute("auth.me");

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

    const ctx = makeCtx({ principal });
    const result = await route.handler(ctx);
    expect(result).toHaveProperty("user");
    expect((result as { user: { id: string } }).user.id).toBe("test-user");
  });
});

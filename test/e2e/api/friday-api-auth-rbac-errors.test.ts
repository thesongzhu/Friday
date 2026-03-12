import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createFridayApiTestEnv,
  loginTestUser,
  authHeaders,
  createTokenWithScopes,
  type FridayApiTestEnv,
} from "./_helpers/friday-api-test-server.helper.js";

const INTERNAL_ERROR_ENDPOINT = process.env.FRIDAY_E2E_INTERNAL_ERROR_ENDPOINT;
const RUN_INTERNAL_ERROR_CASE =
  typeof INTERNAL_ERROR_ENDPOINT === "string" &&
  INTERNAL_ERROR_ENDPOINT.trim().length > 0;

describe("API — Auth / RBAC / Error mapping", () => {
  let env: FridayApiTestEnv;

  beforeAll(async () => {
    env = await createFridayApiTestEnv();
  });

  afterAll(async () => {
    await env.close();
  });

  // ── auth_login_returns_tokens ──────────────────────────────────────────

  it("auth_login_returns_tokens", async () => {
    const res = await fetch(`${env.baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPassphrase: "any" }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: {
        accessToken: string;
        refreshToken: string;
        expiresInSec: number;
        user: { id: string; displayName: string; role: string };
      };
      requestId: string;
    };
    expect(json.ok).toBe(true);
    expect(json.data.accessToken).toBeTruthy();
    expect(json.data.refreshToken).toBeTruthy();
    expect(json.data.expiresInSec).toBe(900);
    expect(json.data.user.id).toBe("test-user");
    expect(json.data.user.role).toBe("admin");
    expect(typeof json.requestId).toBe("string");
  });

  // ── auth_refresh_returns_new_access_token ──────────────────────────────

  it("auth_refresh_returns_new_access_token", async () => {
    const { refreshToken } = await loginTestUser(env.baseUrl);

    const res = await fetch(`${env.baseUrl}/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { accessToken: string; expiresInSec: number };
      requestId: string;
    };
    expect(json.ok).toBe(true);
    expect(json.data.accessToken).toBeTruthy();
    expect(json.data.expiresInSec).toBe(900);
    expect(typeof json.requestId).toBe("string");
  });

  // ── auth_me_returns_principal ──────────────────────────────────────────

  it("auth_me_returns_principal", async () => {
    const { accessToken } = await loginTestUser(env.baseUrl);

    const res = await fetch(`${env.baseUrl}/v1/auth/me`, {
      headers: authHeaders(accessToken),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: {
        user: { id: string; displayName: string; role: string };
        scopes: string[];
      };
      requestId: string;
    };
    expect(json.ok).toBe(true);
    expect(json.data.user.id).toBe("test-user");
    expect(json.data.user.role).toBe("admin");
    expect(json.data.scopes).toContain("hub.admin");
    expect(typeof json.requestId).toBe("string");
  });

  // ── missing_token_returns_401 ──────────────────────────────────────────

  it("missing_token_returns_401", async () => {
    const res = await fetch(`${env.baseUrl}/v1/auth/me`);
    expect(res.status).toBe(401);
    const json = (await res.json()) as {
      ok: boolean;
      error: { code: string; message: string };
      requestId: string;
    };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("UNAUTHORIZED");
    expect(typeof json.error.message).toBe("string");
    expect(typeof json.requestId).toBe("string");
  });

  // ── invalid_token_returns_401 ──────────────────────────────────────────

  it("invalid_token_returns_401", async () => {
    const res = await fetch(`${env.baseUrl}/v1/auth/me`, {
      headers: authHeaders("garbage.token.here"),
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as {
      ok: boolean;
      error: { code: string; message: string };
      requestId: string;
    };
    expect(json.ok).toBe(false);
    expect(typeof json.error.code).toBe("string");
    expect(typeof json.requestId).toBe("string");
  });

  // ── domain_error_maps_to_correct_status ────────────────────────────────

  it("domain_error_maps_to_correct_status", async () => {
    const { accessToken } = await loginTestUser(env.baseUrl);

    const res = await fetch(`${env.baseUrl}/v1/workflows/nonexistent-id`, {
      headers: authHeaders(accessToken),
    });

    expect(res.status).toBe(404);
    const json = (await res.json()) as {
      ok: boolean;
      error: { code: string; message: string };
      requestId: string;
    };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("WORKFLOW_NOT_FOUND");
    expect(typeof json.error.message).toBe("string");
    expect(typeof json.requestId).toBe("string");
  });

  // ── 404_for_unknown_route ──────────────────────────────────────────────

  it("404_for_unknown_route", async () => {
    const res = await fetch(`${env.baseUrl}/v1/nonexistent`);
    expect(res.status).toBe(404);
    const json = (await res.json()) as {
      ok: boolean;
      error: { code: string; message: string };
      requestId: string;
    };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(typeof json.requestId).toBe("string");
  });

  // ── insufficient_scope_returns_403 ─────────────────────────────────────

  it("insufficient_scope_returns_403", async () => {
    // Create a token with only session.read scope — not enough for session.write endpoints
    const limitedToken = createTokenWithScopes(["session.read"]);

    // Call session create which requires session.write scope
    const res = await fetch(`${env.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(limitedToken),
      body: JSON.stringify({
        channel: "test-channel",
        chatId: "scope-test-001",
      }),
    });

    expect(res.status).toBe(403);
    const json = (await res.json()) as {
      ok: boolean;
      error: { code: string; message: string };
      requestId: string;
    };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("FORBIDDEN");
    expect(json.error.message).toContain("scope");
    expect(typeof json.requestId).toBe("string");
  });

  // ── rate_limit_returns_429 ─────────────────────────────────────────────
  // Uses a separate env to avoid poisoning the shared env's rate limiter

  it("rate_limit_returns_429", async () => {
    const rlEnv = await createFridayApiTestEnv();
    try {
      // auth.login has rate limit policy: windowMs=60_000, maxHits=10, keyBy=ip
      // Hit it 11 times (the 11th should be rejected)
      let lastRes: Response | undefined;
      let got429 = false;

      for (let i = 0; i < 12; i++) {
        lastRes = await fetch(`${rlEnv.baseUrl}/v1/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ localPassphrase: "any" }),
        });

        if (lastRes.status === 429) {
          got429 = true;
          break;
        }
      }

      expect(got429).toBe(true);
      expect(lastRes).toBeDefined();
      expect(lastRes!.status).toBe(429);

      // Check rate-limit headers
      expect(lastRes!.headers.get("X-RateLimit-Limit")).toBeTruthy();
      expect(lastRes!.headers.get("X-RateLimit-Reset")).toBeTruthy();

      const json = (await lastRes!.json()) as {
        ok: boolean;
        error: { code: string; message: string; retryable: boolean; retryAfterMs?: number };
        requestId: string;
      };
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe("RATE_LIMITED");
      expect(json.error.retryable).toBe(true);
      expect(typeof json.requestId).toBe("string");
      // retryAfterMs should be present in the error body
      expect(typeof json.error.retryAfterMs).toBe("number");
    } finally {
      await rlEnv.close();
    }
  });

  // ── request_id_propagated_in_all_responses ─────────────────────────────

  it("request_id_propagated_in_all_responses", async () => {
    const { accessToken } = await loginTestUser(env.baseUrl);

    // 200 response
    const res200 = await fetch(`${env.baseUrl}/v1/auth/me`, {
      headers: authHeaders(accessToken),
    });
    expect(res200.status).toBe(200);
    const json200 = (await res200.json()) as { ok: boolean; requestId: string };
    expect(json200.ok).toBe(true);
    expect(typeof json200.requestId).toBe("string");
    expect(json200.requestId.length).toBeGreaterThan(0);

    // 401 response
    const res401 = await fetch(`${env.baseUrl}/v1/auth/me`);
    expect(res401.status).toBe(401);
    const json401 = (await res401.json()) as { ok: boolean; requestId: string };
    expect(json401.ok).toBe(false);
    expect(typeof json401.requestId).toBe("string");
    expect(json401.requestId.length).toBeGreaterThan(0);

    // 404 response (unknown route)
    const res404 = await fetch(`${env.baseUrl}/v1/nonexistent`);
    expect(res404.status).toBe(404);
    const json404 = (await res404.json()) as { ok: boolean; requestId: string };
    expect(json404.ok).toBe(false);
    expect(typeof json404.requestId).toBe("string");
    expect(json404.requestId.length).toBeGreaterThan(0);

    // All request IDs should be distinct
    expect(json200.requestId).not.toBe(json401.requestId);
    expect(json200.requestId).not.toBe(json404.requestId);
    expect(json401.requestId).not.toBe(json404.requestId);
  });

  // ── error_envelope_consistent ──────────────────────────────────────────

  it("error_envelope_consistent", async () => {
    // Check that all error responses conform to { ok: false, error: { code, message }, requestId }

    // 401 — missing auth
    const res401 = await fetch(`${env.baseUrl}/v1/auth/me`);
    expect(res401.status).toBe(401);
    const json401 = (await res401.json()) as Record<string, unknown>;
    expect(json401.ok).toBe(false);
    expect(json401.requestId).toBeDefined();
    expect(typeof json401.requestId).toBe("string");
    const err401 = json401.error as { code: string; message: string };
    expect(typeof err401.code).toBe("string");
    expect(typeof err401.message).toBe("string");

    // 403 — insufficient scope
    const limitedToken = createTokenWithScopes(["fleet.read"]);
    const res403 = await fetch(`${env.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(limitedToken),
      body: JSON.stringify({ channel: "c", chatId: "c" }),
    });
    expect(res403.status).toBe(403);
    const json403 = (await res403.json()) as Record<string, unknown>;
    expect(json403.ok).toBe(false);
    expect(typeof json403.requestId).toBe("string");
    const err403 = json403.error as { code: string; message: string };
    expect(typeof err403.code).toBe("string");
    expect(typeof err403.message).toBe("string");

    // 404 — unknown route
    const res404 = await fetch(`${env.baseUrl}/v1/nonexistent`);
    expect(res404.status).toBe(404);
    const json404 = (await res404.json()) as Record<string, unknown>;
    expect(json404.ok).toBe(false);
    expect(typeof json404.requestId).toBe("string");
    const err404 = json404.error as { code: string; message: string };
    expect(typeof err404.code).toBe("string");
    expect(typeof err404.message).toBe("string");

    // 404 — domain error (nonexistent workflow)
    const { accessToken } = await loginTestUser(env.baseUrl);
    const resDomain = await fetch(`${env.baseUrl}/v1/workflows/nonexistent-wf`, {
      headers: authHeaders(accessToken),
    });
    expect(resDomain.status).toBe(404);
    const jsonDomain = (await resDomain.json()) as Record<string, unknown>;
    expect(jsonDomain.ok).toBe(false);
    expect(typeof jsonDomain.requestId).toBe("string");
    const errDomain = jsonDomain.error as { code: string; message: string };
    expect(typeof errDomain.code).toBe("string");
    expect(typeof errDomain.message).toBe("string");
  });

  // ── unexpected_error_returns_500 ───────────────────────────────────────
  // Env-gated: provide FRIDAY_E2E_INTERNAL_ERROR_ENDPOINT as a path to a
  // dedicated test hook route that throws a raw Error in the HTTP layer.
  // Example: FRIDAY_E2E_INTERNAL_ERROR_ENDPOINT=/v1/__test/error-500
  it.runIf(RUN_INTERNAL_ERROR_CASE)("unexpected_error_returns_500", async () => {
    const endpoint = INTERNAL_ERROR_ENDPOINT!;
    const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    const res = await fetch(`${env.baseUrl}${normalizedEndpoint}`);
    expect(res.status).toBe(500);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(typeof json.requestId).toBe("string");
    const err = json.error as { code?: string; message?: string };
    expect(typeof err.code).toBe("string");
    expect(typeof err.message).toBe("string");
  });
});

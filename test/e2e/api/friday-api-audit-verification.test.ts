import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createFridayApiTestEnv,
  loginTestUser,
  authHeaders,
  type FridayApiTestEnv,
} from "./_helpers/friday-api-test-server.helper.js";

/**
 * Real HTTP integration tests that verify findings from the CX API audit
 * (docs/cx-api-audit.md). Each test sends actual HTTP requests to a real
 * Friday server instance backed by an in-memory SQLite database.
 */
describe("API Audit Verification", () => {
  let env: FridayApiTestEnv;
  let token: string;

  beforeAll(async () => {
    env = await createFridayApiTestEnv();
    const { accessToken } = await loginTestUser(env.baseUrl);
    token = accessToken;
  });

  afterAll(async () => {
    await env.close();
  });

  // ────────────────────────────────────────────────────────────────────────
  // P0: Route Shadowing (API-ROUTE-001)
  // ────────────────────────────────────────────────────────────────────────

  describe("P0 — Route Shadowing", () => {
    it("GET /v1/providers/usage should NOT be captured by /v1/providers/:providerId", async () => {
      // If shadowed, the server would treat "usage" as a providerId and return
      // PROVIDER_NOT_FOUND (404) instead of a VALIDATION_ERROR about missing
      // query params (the usage endpoint requires 'from' and 'to' params).
      const res = await fetch(`${env.baseUrl}/v1/providers/usage`, {
        headers: authHeaders(token),
      });

      const json = (await res.json()) as {
        ok: boolean;
        error?: { code: string; message: string };
        data?: unknown;
      };

      // The usage endpoint requires 'from' and 'to' query params.
      // If NOT shadowed: we get a VALIDATION_ERROR (400) about missing params.
      // If shadowed: we get PROVIDER_NOT_FOUND (404) for providerId="usage".
      if (!json.ok) {
        // Should be a validation error about query params, not a provider lookup miss
        expect(json.error?.code).not.toBe("PROVIDER_NOT_FOUND");
        expect(json.error?.code).toBe("VALIDATION_ERROR");
        expect(res.status).toBe(400);
      } else {
        // Also acceptable: if from/to default is added, it returns usage data
        expect(json.data).toBeDefined();
      }
    });

    it("GET /v1/providers/budget should NOT be captured by /v1/providers/:providerId", async () => {
      // The budget endpoint should return budget data, not PROVIDER_NOT_FOUND.
      const res = await fetch(`${env.baseUrl}/v1/providers/budget`, {
        headers: authHeaders(token),
      });

      const json = (await res.json()) as {
        ok: boolean;
        error?: { code: string; message: string };
        data?: { budget: unknown };
      };

      // Budget endpoint should respond with budget data (200) or a domain error
      // that is NOT about a provider lookup for providerId="budget".
      if (!json.ok) {
        expect(json.error?.code).not.toBe("PROVIDER_NOT_FOUND");
      } else {
        expect(res.status).toBe(200);
        expect(json.data).toBeDefined();
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // P1: Input Validation (API-VALID-001, API-VALID-002)
  // ────────────────────────────────────────────────────────────────────────

  describe("P1 — Input Validation", () => {
    it("POST /v1/auth/refresh with empty body returns 4xx not 500", async () => {
      const res = await fetch(`${env.baseUrl}/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const json = (await res.json()) as {
        ok: boolean;
        error?: { code: string; message: string };
      };

      // The audit found this returns 500 instead of 400. We verify the current behavior.
      // Ideal: 400 with meaningful error about missing refreshToken.
      expect(json.ok).toBe(false);
      expect(res.status).toBeLessThan(500);
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("POST /v1/auth/refresh with missing refreshToken returns 4xx not 500", async () => {
      const res = await fetch(`${env.baseUrl}/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ foo: "bar" }),
      });

      const json = (await res.json()) as {
        ok: boolean;
        error?: { code: string; message: string };
      };

      expect(json.ok).toBe(false);
      expect(res.status).toBeLessThan(500);
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("POST /v1/security/tokens/revoke with nonexistent tokenId returns accurate result", async () => {
      const res = await fetch(`${env.baseUrl}/v1/security/tokens/revoke`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ tokenId: "nonexistent-uuid-that-does-not-exist" }),
      });

      const json = (await res.json()) as {
        ok: boolean;
        data?: { revoked: boolean; tokenId: string };
        error?: { code: string; message: string };
      };

      // The audit found this returns { revoked: true } even for nonexistent tokens
      // (false success). We verify: it should either return an error (404) or
      // indicate that nothing was actually revoked.
      if (json.ok) {
        // If it returns success, the 'revoked' field should reflect reality
        // A false-success bug means revoked=true for a token that doesn't exist
        expect(json.data?.revoked).toBe(false);
      } else {
        // Alternatively, a 404 is appropriate
        expect(res.status).toBe(404);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // P1: Realtime Errors (RT-ERR-001, RT-VAL-002)
  // ────────────────────────────────────────────────────────────────────────

  describe("P1 — Realtime Errors", () => {
    it("POST /v1/realtime/subscriptions with empty body returns 4xx not 500", async () => {
      const res = await fetch(`${env.baseUrl}/v1/realtime/subscriptions`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({}),
      });

      const json = (await res.json()) as {
        ok: boolean;
        error?: { code: string; message: string };
      };

      // Empty body has no 'subscriptions' array → should be validated as 4xx
      expect(json.ok).toBe(false);
      expect(res.status).toBeLessThan(500);
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("POST /v1/realtime/ack with empty body returns 4xx not 500", async () => {
      const res = await fetch(`${env.baseUrl}/v1/realtime/ack`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({}),
      });

      const json = (await res.json()) as {
        ok: boolean;
        error?: { code: string; message: string };
      };

      // Empty body has no 'streamId', 'seq', 'epoch' → should be validated as 4xx
      expect(json.ok).toBe(false);
      expect(res.status).toBeLessThan(500);
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // P1: Workflow Validation (WF-VAL-003)
  // ────────────────────────────────────────────────────────────────────────

  describe("P1 — Workflow Validation", () => {
    it("POST /v1/workflows with empty body returns 4xx not 500", async () => {
      const res = await fetch(`${env.baseUrl}/v1/workflows`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({}),
      });

      const json = (await res.json()) as {
        ok: boolean;
        error?: { code: string; message: string };
      };

      // Empty body is missing required workflow fields → should be 4xx
      expect(json.ok).toBe(false);
      expect(res.status).toBeLessThan(500);
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("POST /v1/workflow-runs with empty body returns 4xx not 500", async () => {
      const res = await fetch(`${env.baseUrl}/v1/workflow-runs`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({}),
      });

      const json = (await res.json()) as {
        ok: boolean;
        error?: { code: string; message: string };
      };

      // Empty body is missing required run fields → should be 4xx
      expect(json.ok).toBe(false);
      expect(res.status).toBeLessThan(500);
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // P2: Error Handling (API-ERR-001, API-HTTP-002)
  // ────────────────────────────────────────────────────────────────────────

  describe("P2 — Error Handling", () => {
    it("GET /v1/providers/%ZZ (malformed URL encoding) returns 4xx not 500", async () => {
      const res = await fetch(`${env.baseUrl}/v1/providers/%ZZ`, {
        headers: authHeaders(token),
      });

      // Malformed percent-encoding in path param should be caught gracefully
      expect(res.status).toBeLessThan(500);
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("security headers present on success responses", async () => {
      const res = await fetch(`${env.baseUrl}/v1/auth/me`, {
        headers: authHeaders(token),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    });

    it("security headers present on 404 responses", async () => {
      const res = await fetch(`${env.baseUrl}/v1/nonexistent-route-for-header-check`);

      expect(res.status).toBe(404);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    });
  });
});

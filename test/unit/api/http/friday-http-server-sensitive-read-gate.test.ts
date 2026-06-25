import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFridayHttpRouteRegistry,
  createFridayHttpServer,
  type FridayAuthMiddlewareFactory,
  type FridayHttpServer,
  type FridayRealtimeWsGateway,
} from "#api";
import { FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID } from "../../../../src/api/http/friday-default-public-principal.js";
import {
  FRIDAY_SENSITIVE_READ_ROUTE_PREFIXES,
  isFridaySensitiveReadRoute,
} from "../../../../src/api/http/friday-sensitive-read-routes.js";
import { ERROR_CODE_BOUND_PRINCIPAL_REQUIRED } from "../../../../src/security/friday-owner-session-channel-capability.js";

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("failed to allocate free port"));
        return;
      }
      const port = addr.port;
      server.close((closeErr) => (closeErr ? reject(closeErr) : resolve(port)));
    });
    server.on("error", reject);
  });
}

function makeStubWsGateway(): FridayRealtimeWsGateway {
  return {
    handleClientFrame: () => ({ handled: false }),
    addConnection: () => {},
    removeConnection: () => {},
    broadcastEvent: () => {},
  } as unknown as FridayRealtimeWsGateway;
}

// Missing/invalid Authorization leaves ctx.principal untouched (server falls back to the
// synthetic public principal); a valid bearer mutates ctx.principal to the real bound principal.
function makeBearerStubMiddleware(
  validTokens: Record<string, { principalId: string; userId: string; tenantId: string; role: string; scopes: string[]; tokenId: string }>,
): FridayAuthMiddlewareFactory {
  return {
    requireAuth: (ctx) => {
      if (ctx.principal) return { passed: true as const };
      const auth = ctx.headers["authorization"] ?? ctx.headers["Authorization"];
      if (!auth) return { passed: false as const, statusCode: 401, code: "UNAUTHORIZED", message: "missing token" };
      const parts = auth.split(" ");
      if (parts.length !== 2 || parts[0] !== "Bearer") {
        return { passed: false as const, statusCode: 401, code: "UNAUTHORIZED", message: "malformed header" };
      }
      const principal = validTokens[parts[1]];
      if (!principal) return { passed: false as const, statusCode: 401, code: "UNAUTHORIZED", message: "invalid token" };
      (ctx as { principal: unknown }).principal = principal;
      return { passed: true as const };
    },
    requireAnyScope: () => ({ passed: true as const }),
    requireAnyRole: () => ({ passed: true as const }),
    enforceRateLimit: () => ({ passed: true as const }),
  };
}

describe("isFridaySensitiveReadRoute", () => {
  it("matches the sensitive prefixes and their sub-paths", () => {
    for (const prefix of FRIDAY_SENSITIVE_READ_ROUTE_PREFIXES) {
      expect(isFridaySensitiveReadRoute(prefix)).toBe(true);
      expect(isFridaySensitiveReadRoute(`${prefix}/items/:id`)).toBe(true);
    }
    expect(isFridaySensitiveReadRoute("/v1/memory/items/:id")).toBe(true);
    expect(isFridaySensitiveReadRoute("/v1/secrets")).toBe(true);
    expect(isFridaySensitiveReadRoute("/v1/grants")).toBe(true);
    expect(isFridaySensitiveReadRoute("/v1/grants/active")).toBe(true);
    expect(isFridaySensitiveReadRoute("/v1/audit/logs")).toBe(true);
    expect(isFridaySensitiveReadRoute("/v1/observability/audit/:entryId")).toBe(true);
    // Gated 2026-06-24 (operator-authorized): provider-spend + remote device/session posture.
    expect(isFridaySensitiveReadRoute("/v1/providers/usage")).toBe(true);
    expect(isFridaySensitiveReadRoute("/v1/providers/budget")).toBe(true);
    expect(isFridaySensitiveReadRoute("/v1/system/remote/devices")).toBe(true);
    expect(isFridaySensitiveReadRoute("/v1/system/remote/devices/:deviceId")).toBe(true);
    expect(isFridaySensitiveReadRoute("/v1/system/remote/sessions")).toBe(true);
  });

  it("does NOT match the core no-login UX or minimal-public surfaces", () => {
    for (const path of [
      "/v1/health",
      "/v1/setup/status",
      "/v1/auth/login",
      "/v1/agent/runs",
      "/v1/skills",
      "/v1/workflows",
      "/v1/capabilities",
      "/v1/version",
    ]) {
      expect(isFridaySensitiveReadRoute(path)).toBe(false);
    }
  });

  it("no-degrade: the bare /v1/providers reads (accepted operator_external_adapter) stay un-gated", () => {
    // Gating /v1/providers/usage + /v1/providers/budget must NOT over-floor the bare prefix.
    for (const path of [
      "/v1/providers",
      "/v1/providers/health",
      "/v1/providers/capability-health",
      "/v1/providers/detect",
      "/v1/providers/templates",
      "/v1/providers/:providerId",
      "/v1/providers/:providerId/doctor",
      "/v1/providers/routing/explain",
    ]) {
      expect(isFridaySensitiveReadRoute(path)).toBe(false);
    }
  });

  it("respects the trailing-slash boundary (no sibling-prefix false positives)", () => {
    expect(isFridaySensitiveReadRoute("/v1/secretspolicy")).toBe(false);
    expect(isFridaySensitiveReadRoute("/v1/securityx")).toBe(false);
    expect(isFridaySensitiveReadRoute("/v1/grantsx")).toBe(false);
    expect(isFridaySensitiveReadRoute("/v1/auditx")).toBe(false);
    expect(isFridaySensitiveReadRoute("/v1/observability/auditor")).toBe(false);
    // 2026-06-24 sub-path prefixes: a sibling that only shares the textual prefix must NOT match.
    expect(isFridaySensitiveReadRoute("/v1/providers/usagex")).toBe(false);
    expect(isFridaySensitiveReadRoute("/v1/providers/budgetx")).toBe(false);
    expect(isFridaySensitiveReadRoute("/v1/system/remote/devicesx")).toBe(false);
    expect(isFridaySensitiveReadRoute("/v1/system/remote/sessionsx")).toBe(false);
  });
});

describe("FridayHttpServer sensitive-read floor", () => {
  let server: FridayHttpServer | null = null;
  let port = 0;
  let baseUrl = "";

  beforeEach(async () => {
    port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  function startWith(register: (routes: ReturnType<typeof createFridayHttpRouteRegistry>) => void, tokens = {}) {
    const routes = createFridayHttpRouteRegistry();
    register(routes);
    server = createFridayHttpServer({
      routes,
      wsGateway: makeStubWsGateway(),
      middleware: makeBearerStubMiddleware(tokens),
      port,
      host: "127.0.0.1",
    });
    return server.listen();
  }

  it("negative: anonymous GET on a sensitive read route → 401 before handler runs", async () => {
    let handlerCalls = 0;
    await startWith((routes) => {
      routes.register({
        operationId: "memory.items.list",
        method: "GET",
        path: "/v1/memory/items",
        auth: { public: true },
        async handler() {
          handlerCalls += 1;
          return { items: [] };
        },
      });
    });

    const response = await fetch(`${baseUrl}/v1/memory/items`);
    expect(response.status).toBe(401);
    const body = await response.json() as { ok: false; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe(ERROR_CODE_BOUND_PRINCIPAL_REQUIRED);
    expect(body.error.message).toMatch(/sensitive data/);
    // Critical: the handler must not run for an anonymous caller — no data leaks.
    expect(handlerCalls).toBe(0);
  });

  it("negative: anonymous GET on /v1/learning (diagnosis-data alias of /v1/diagnosis) → 401", async () => {
    let handlerCalls = 0;
    await startWith((routes) => {
      // createFridayDiagnosisRoutes mounts the same incident handlers under BOTH
      // /v1/diagnosis and /v1/learning; the floor must gate the alias too.
      routes.register({
        operationId: "learning.incidents.list",
        method: "GET",
        path: "/v1/learning/incidents",
        auth: { public: true },
        async handler() {
          handlerCalls += 1;
          return { incidents: [] };
        },
      });
    });

    const response = await fetch(`${baseUrl}/v1/learning/incidents`);
    expect(response.status).toBe(401);
    const body = await response.json() as { ok: false; error: { code: string } };
    expect(body.error.code).toBe(ERROR_CODE_BOUND_PRINCIPAL_REQUIRED);
    expect(handlerCalls).toBe(0);
  });

  it("negative: anonymous GET on control-plane audit/grant read routes → 401 before handlers run", async () => {
    const handlerCalls: Record<string, number> = {
      grants: 0,
      audit: 0,
      observabilityAudit: 0,
    };
    await startWith((routes) => {
      routes.register({
        operationId: "grants.list",
        method: "GET",
        path: "/v1/grants",
        auth: { public: true },
        async handler() {
          handlerCalls.grants += 1;
          return { grants: [] };
        },
      });
      routes.register({
        operationId: "audit.logs.list",
        method: "GET",
        path: "/v1/audit/logs",
        auth: { public: true },
        async handler() {
          handlerCalls.audit += 1;
          return { logs: [] };
        },
      });
      routes.register({
        operationId: "observability.audit.get",
        method: "GET",
        path: "/v1/observability/audit/:entryId",
        auth: { public: true },
        async handler() {
          handlerCalls.observabilityAudit += 1;
          return { entry: null };
        },
      });
    });

    for (const path of ["/v1/grants", "/v1/audit/logs", "/v1/observability/audit/entry-1"]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(401);
      const body = await response.json() as { ok: false; error: { code: string } };
      expect(body.error.code).toBe(ERROR_CODE_BOUND_PRINCIPAL_REQUIRED);
    }
    expect(handlerCalls).toEqual({ grants: 0, audit: 0, observabilityAudit: 0 });
  });

  it("negative: anonymous HEAD on a sensitive read route → 401 (HEAD is a read)", async () => {
    await startWith((routes) => {
      routes.register({
        operationId: "secrets.list",
        method: "GET",
        path: "/v1/secrets",
        auth: { public: true },
        async handler() {
          return { secrets: [] };
        },
      });
    });
    const response = await fetch(`${baseUrl}/v1/secrets`, { method: "HEAD" });
    expect(response.status).toBe(401);
  });

  it("positive: GET on a sensitive route WITH a valid Bearer → 200 (bound principal reads)", async () => {
    await startWith(
      (routes) => {
        routes.register({
          operationId: "memory.items.list",
          method: "GET",
          path: "/v1/memory/items",
          auth: { public: true },
          async handler(ctx) {
            return { principalId: ctx.principal!.principalId };
          },
        });
      },
      {
        "real-token-abc": {
          principalId: "user:alice",
          userId: "11111111-1111-1111-1111-111111111111",
          tenantId: "22222222-2222-2222-2222-222222222222",
          role: "viewer",
          scopes: ["session.read"],
          tokenId: "33333333-3333-3333-3333-333333333333",
        },
      },
    );

    const response = await fetch(`${baseUrl}/v1/memory/items`, {
      headers: { Authorization: "Bearer real-token-abc" },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: true; data: { principalId: string } };
    expect(body.data.principalId).toBe("user:alice");
    expect(body.data.principalId).not.toBe(FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID);
  });

  it("positive: valid Bearer still reaches control-plane audit/grant read handlers", async () => {
    await startWith(
      (routes) => {
        routes.register({
          operationId: "grants.list",
          method: "GET",
          path: "/v1/grants",
          auth: { public: true },
          async handler(ctx) {
            return { surface: "grants", principalId: ctx.principal!.principalId };
          },
        });
        routes.register({
          operationId: "audit.logs.list",
          method: "GET",
          path: "/v1/audit/logs",
          auth: { public: true },
          async handler(ctx) {
            return { surface: "audit", principalId: ctx.principal!.principalId };
          },
        });
        routes.register({
          operationId: "observability.audit.get",
          method: "GET",
          path: "/v1/observability/audit/:entryId",
          auth: { public: true },
          async handler(ctx) {
            return { surface: "observabilityAudit", principalId: ctx.principal!.principalId };
          },
        });
      },
      {
        "real-token-abc": {
          principalId: "user:alice",
          userId: "11111111-1111-1111-1111-111111111111",
          tenantId: "22222222-2222-2222-2222-222222222222",
          role: "viewer",
          scopes: ["session.read"],
          tokenId: "33333333-3333-3333-3333-333333333333",
        },
      },
    );

    for (const path of ["/v1/grants", "/v1/audit/logs", "/v1/observability/audit/entry-1"]) {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { Authorization: "Bearer real-token-abc" },
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { ok: true; data: { principalId: string } };
      expect(body.data.principalId).toBe("user:alice");
    }
  });

  it("negative: malformed/invalid bearer on a sensitive route → 401 (falls back to synthetic, then gated)", async () => {
    let handlerCalls = 0;
    await startWith((routes) => {
      routes.register({
        operationId: "memory.items.list",
        method: "GET",
        path: "/v1/memory/items",
        auth: { public: true },
        async handler() {
          handlerCalls += 1;
          return { items: [] };
        },
      });
    }); // no valid tokens registered → any bearer is invalid

    // Invalid/malformed Authorization → requireAuth fails → server falls back to the synthetic
    // public principal → the sensitive-read gate then denies. Pins the fallback→gate interaction.
    const response = await fetch(`${baseUrl}/v1/memory/items`, {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect(response.status).toBe(401);
    const body = await response.json() as { ok: false; error: { code: string } };
    expect(body.error.code).toBe(ERROR_CODE_BOUND_PRINCIPAL_REQUIRED);
    expect(handlerCalls).toBe(0);
  });

  it("negative: anonymous GET on the 2026-06-24 gated spend/posture reads → 401 before handlers run", async () => {
    const handlerCalls: Record<string, number> = {
      usage: 0,
      budget: 0,
      devices: 0,
      sessions: 0,
    };
    await startWith((routes) => {
      routes.register({
        operationId: "providers.usage.get",
        method: "GET",
        path: "/v1/providers/usage",
        auth: { public: true },
        async handler() {
          handlerCalls.usage += 1;
          return { summary: {} };
        },
      });
      routes.register({
        operationId: "providers.budget.get",
        method: "GET",
        path: "/v1/providers/budget",
        auth: { public: true },
        async handler() {
          handlerCalls.budget += 1;
          return { budget: {} };
        },
      });
      routes.register({
        operationId: "system.remote.devices.list",
        method: "GET",
        path: "/v1/system/remote/devices",
        auth: { public: true },
        async handler() {
          handlerCalls.devices += 1;
          return { devices: [] };
        },
      });
      routes.register({
        operationId: "system.remote.sessions.list",
        method: "GET",
        path: "/v1/system/remote/sessions",
        auth: { public: true },
        async handler() {
          handlerCalls.sessions += 1;
          return { sessions: [] };
        },
      });
    });

    for (const path of [
      "/v1/providers/usage",
      "/v1/providers/budget",
      "/v1/system/remote/devices",
      "/v1/system/remote/sessions",
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(401);
      const body = (await response.json()) as { ok: false; error: { code: string } };
      expect(body.error.code).toBe(ERROR_CODE_BOUND_PRINCIPAL_REQUIRED);
    }
    expect(handlerCalls).toEqual({ usage: 0, budget: 0, devices: 0, sessions: 0 });
  });

  it("no-degrade: anonymous GET on the bare /v1/providers reads stays 200 (NOT over-floored)", async () => {
    const handlerCalls: Record<string, number> = { list: 0, health: 0 };
    await startWith((routes) => {
      routes.register({
        operationId: "providers.list",
        method: "GET",
        path: "/v1/providers",
        auth: { public: true },
        async handler() {
          handlerCalls.list += 1;
          return { providers: [] };
        },
      });
      routes.register({
        operationId: "providers.health.list",
        method: "GET",
        path: "/v1/providers/health",
        auth: { public: true },
        async handler() {
          handlerCalls.health += 1;
          return { health: [] };
        },
      });
    });

    for (const path of ["/v1/providers", "/v1/providers/health"]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(200);
    }
    // Both accepted operator_external_adapter reads still reach their handlers anonymously.
    expect(handlerCalls).toEqual({ list: 1, health: 1 });
  });

  it("regression: anonymous GET on a core no-login UX route (non-sensitive) → 200 (unaffected)", async () => {
    let handlerCalls = 0;
    await startWith((routes) => {
      routes.register({
        operationId: "agent.runs.list",
        method: "GET",
        path: "/v1/agent/runs",
        auth: { public: true },
        async handler() {
          handlerCalls += 1;
          return { runs: [] };
        },
      });
    });
    const response = await fetch(`${baseUrl}/v1/agent/runs`);
    expect(response.status).toBe(200);
    expect(handlerCalls).toBe(1);
  });
});

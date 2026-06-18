import { describe, it, expect } from "vitest";
import { createFridayHealthRoutes } from "#api";
import type { FridayRouteDefinition, FridayHttpContext } from "#api";

// ─── Helpers ───

function makeCtx(overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {}): FridayHttpContext<unknown, unknown, unknown> {
  return {
    requestId: "req-health-1",
    receivedAt: "2025-06-15T10:00:00.000Z",
    params: {},
    query: {},
    body: {},
    headers: {},
    principal: null,
    ...overrides,
  };
}

function findRoute(routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[], operationId: string) {
  return routes.find((r) => r.operationId === operationId)!;
}

// ─── Tests ───

describe("createFridayHealthRoutes", () => {
  it("returns exactly two routes", () => {
    const routes = createFridayHealthRoutes({ version: "1.0.0" });
    expect(routes).toHaveLength(2);
  });

  it("registers GET /v1/health with correct operationId", () => {
    const routes = createFridayHealthRoutes({ version: "1.0.0" });
    const route = findRoute(routes, "health.check");
    expect(route).toBeDefined();
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/v1/health");
  });

  it("registers GET /v1/health/capabilities with correct operationId", () => {
    const routes = createFridayHealthRoutes({ version: "1.0.0" });
    const route = findRoute(routes, "health.capabilities");
    expect(route).toBeDefined();
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/v1/health/capabilities");
    expect(route.auth).toEqual({ public: true });
  });

  it("is public (no auth)", () => {
    const routes = createFridayHealthRoutes({ version: "1.0.0" });
    const route = findRoute(routes, "health.check");
    expect(route.auth).toEqual({ public: true });
  });

  it("returns status, version, and uptime", async () => {
    const routes = createFridayHealthRoutes({
      version: "0.1.0",
      getUptimeSeconds: () => 42,
    });
    const route = findRoute(routes, "health.check");
    const result = await route.handler(makeCtx());
    expect(result).toMatchObject({
      status: "ok",
      version: "0.1.0",
      uptime: 42,
    });
  });

  it("omits capabilities for unauthenticated callers", async () => {
    const routes = createFridayHealthRoutes({
      version: "0.1.0",
      getUptimeSeconds: () => 42,
    });
    const route = findRoute(routes, "health.check");
    const result = await route.handler(makeCtx()) as {
      capabilities?: unknown;
    };
    expect(result.capabilities).toBeUndefined();
  });

  it("returns capabilities from the authenticated route", async () => {
    const routes = createFridayHealthRoutes({
      version: "0.1.0",
      getUptimeSeconds: () => 42,
    });
    const route = findRoute(routes, "health.capabilities");
    const result = await route.handler(makeCtx({
      principal: {
        principalType: "user",
        principalId: "user-1",
        userId: "user-1",
        role: "admin",
        scopes: ["session.read"],
        tokenId: "token-1",
        tokenKind: "access",
        issuedAt: "2025-06-15T10:00:00.000Z",
      },
    }));
    expect(result).toMatchObject({
      status: "ok",
      version: "0.1.0",
      uptime: 42,
      capabilities: {
        schemaVersion: "1.0",
        plugins: {
          runtimeMode: "stub",
        },
        channels: {
          supportedKinds: [],
          enabledKinds: [],
          webhookEndpoints: {
            line: false,
            whatsapp: false,
            lark: false,
          },
        },
        mcp: {
          enabled: false,
        },
        packaging: {
          enabled: false,
        },
        search: {
          provider: "duckduckgo_html",
          latestness: "unverified",
        },
        system: {
          enabled: false,
          remoteMode: "unavailable",
          companionReadiness: "unavailable",
        },
      },
    });
    expect((result as { capabilities: { executionIsolation?: unknown } }).capabilities.executionIsolation).toMatchObject({
      disposition: "open_no_os_sandbox",
      osSandbox: false,
      surfaces: {
        "skill.node": {
          boundary: "disabled_in_production_unisolated_test_harness_only",
          osSandbox: false,
          defaultLive: false,
        },
        "skill.node.bundled_system": {
          boundary: "disabled_in_production_unisolated_test_harness_only",
          osSandbox: false,
          defaultLive: false,
        },
        "agent.exec": {
          boundary: "logical_workspace_guard_host_spawn",
          osSandbox: false,
          defaultLive: true,
        },
      },
    });
  });

  it("uses default uptime when getUptimeSeconds is not provided", async () => {
    const routes = createFridayHealthRoutes({ version: "2.0.0" });
    const route = findRoute(routes, "health.check");
    const result = await route.handler(makeCtx()) as { status: string; version: string; uptime: number };
    expect(result.status).toBe("ok");
    expect(result.version).toBe("2.0.0");
    expect(typeof result.uptime).toBe("number");
    expect(result.uptime).toBeGreaterThanOrEqual(0);
    expect(result).not.toHaveProperty("capabilities");
  });

  it("passes version through unchanged", async () => {
    const routes = createFridayHealthRoutes({
      version: "custom-version-string",
      getUptimeSeconds: () => 0,
    });
    const route = findRoute(routes, "health.check");
    const result = await route.handler(makeCtx()) as { version: string };
    expect(result.version).toBe("custom-version-string");
  });

  it("returns caller-provided capabilities payload", async () => {
    const routes = createFridayHealthRoutes({
      version: "1.2.3",
      getUptimeSeconds: () => 5,
      getCapabilities: () => ({
        schemaVersion: "1.0",
        plugins: {
          runtimeMode: "full",
        },
        channels: {
          supportedKinds: ["discord", "slack"],
          enabledKinds: ["discord"],
          webhookEndpoints: {
            line: false,
            whatsapp: false,
            lark: false,
          },
        },
        mcp: {
          enabled: true,
        },
        packaging: {
          enabled: true,
        },
        search: {
          provider: "serper",
          latestness: "provider_backed",
        },
        system: {
          enabled: true,
          remoteMode: "trusted_private_network",
          healthStatus: "degraded",
          companionConnected: false,
          companionReadiness: "degraded",
          reasons: ["companion_disconnected"],
          warning: "System companion unavailable; Friday is continuing in degraded mode for local device actions.",
        },
      }),
    });
    const route = findRoute(routes, "health.capabilities");
    const result = await route.handler(makeCtx({
      principal: {
        principalType: "user",
        principalId: "user-1",
        userId: "user-1",
        role: "admin",
        scopes: ["session.read"],
        tokenId: "token-1",
        tokenKind: "access",
        issuedAt: "2025-06-15T10:00:00.000Z",
      },
    })) as {
      capabilities: {
        plugins: { runtimeMode: string };
        search: { provider: string };
        system: { companionReadiness?: string };
      };
    };
    expect(result.capabilities.plugins.runtimeMode).toBe("full");
    expect(result.capabilities.search.provider).toBe("serper");
    expect(result.capabilities.system.companionReadiness).toBe("degraded");
  });
});

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
  it("returns exactly one route", () => {
    const routes = createFridayHealthRoutes({ version: "1.0.0" });
    expect(routes).toHaveLength(1);
  });

  it("registers GET /v1/health with correct operationId", () => {
    const routes = createFridayHealthRoutes({ version: "1.0.0" });
    const route = findRoute(routes, "health.check");
    expect(route).toBeDefined();
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/v1/health");
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
    expect(result).toEqual({
      status: "ok",
      version: "0.1.0",
      uptime: 42,
      capabilities: {
        schemaVersion: "1.0",
        auth: {
          allowPasswordlessLocalLogin: false,
          allowLocalBypassLogin: false,
        },
        plugins: {
          runtimeMode: "stub",
          marketplaceAvailable: false,
        },
        marketplace: {
          commerceEnabled: false,
          skillSourceEnabled: false,
          pluginMarketplaceEnabled: false,
        },
        channels: {
          supportedKinds: [],
          enabledKinds: [],
        },
        system: {
          enabled: false,
          remoteMode: "unavailable",
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
    expect(result).toHaveProperty("capabilities");
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
        auth: {
          allowPasswordlessLocalLogin: true,
          allowLocalBypassLogin: true,
        },
        plugins: {
          runtimeMode: "full",
          marketplaceAvailable: true,
        },
        marketplace: {
          commerceEnabled: true,
          skillSourceEnabled: true,
          pluginMarketplaceEnabled: true,
        },
        channels: {
          supportedKinds: ["discord", "slack"],
          enabledKinds: ["discord"],
        },
        system: {
          enabled: true,
          remoteMode: "trusted_private_network",
        },
      }),
    });
    const route = findRoute(routes, "health.check");
    const result = await route.handler(makeCtx()) as {
      capabilities: { plugins: { runtimeMode: string } };
    };
    expect(result.capabilities.plugins.runtimeMode).toBe("full");
  });
});

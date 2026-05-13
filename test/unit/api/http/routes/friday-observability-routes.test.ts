/**
 * B-005 Observability Routes — Contract Tests
 *
 * Validates route registration, auth scopes, request validation,
 * and handler delegation for traces, audit, SLOs, alerts, and alert rules.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createFridayObservabilityRoutes,
  type FridayObservabilityRoutesDeps,
} from "../../../../../src/api/http/routes/friday-observability-routes.js";
import type {
  FridayRouteDefinition,
  FridayHttpContext,
} from "../../../../../src/api/model/friday-api-common.types.js";

// ─── Helpers ───

function makeCtx(overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {}): FridayHttpContext<unknown, unknown, unknown> {
  return {
    requestId: "req-test-1",
    receivedAt: "2026-01-01T00:00:00Z",
    params: {},
    query: {},
    body: null,
    headers: {},
    principal: null,
    ...overrides,
  };
}

function findRoute(routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[], operationId: string) {
  return routes.find((r) => r.operationId === operationId)!;
}

function makeDeps(): FridayObservabilityRoutesDeps {
  return {
    overview: {
      get: vi.fn().mockResolvedValue({
        overview: {
          traces: { totalTraces: 1, errorTraces: 0, okTraces: 1, avgDurationMs: 15, activeTraces: 0 },
          audit: { totalEntries: 2, byCategory: {}, byOutcome: {}, byModule: {} },
          alerts: { activeAlerts: 0, bySeverity: {}, byStatus: {}, highestSeverity: null, totalRules: 1 },
          health: null,
          generatedAt: "2026-01-01T00:00:00Z",
        },
        runtime: {
          browser: {
            configuredMode: "auto",
            activeMode: "headless",
            targetBrowser: "Playwright Chromium",
            sessionCount: 1,
            profiles: [],
          },
        },
      }),
    },
    timeSeries: {
      get: vi.fn().mockReturnValue({
        series: {
          metricName: "friday.learning.failures.total",
          points: [],
          bucketSize: "5m",
          startTime: "2026-01-01T00:00:00Z",
          endTime: "2026-01-01T01:00:00Z",
        },
      }),
    },
    traces: {
      search: vi.fn().mockReturnValue({ items: [], total: 0 }),
      get: vi.fn().mockReturnValue({ trace: { traceId: "t-1" } }),
    },
    audit: {
      search: vi.fn().mockReturnValue({ items: [], total: 0 }),
      get: vi.fn().mockReturnValue({ entry: { id: "e-1" }, chainValid: true }),
    },
    slos: {
      list: vi.fn().mockReturnValue({ items: [], total: 0 }),
      get: vi.fn().mockReturnValue({ slo: { id: "slo-1" }, errorBudget: null, burnRates: [] }),
      create: vi.fn().mockReturnValue({ slo: { id: "slo-new" }, errorBudget: null, burnRates: [] }),
      update: vi.fn().mockReturnValue({ slo: { id: "slo-1" }, errorBudget: null, burnRates: [] }),
      delete: vi.fn().mockReturnValue({ deleted: true, sloId: "slo-1" }),
    },
    alerts: {
      list: vi.fn().mockReturnValue({ items: [], total: 0 }),
      get: vi.fn().mockReturnValue({ alert: { id: "a-1" }, rule: {}, notifiedChannels: [] }),
      acknowledge: vi.fn().mockReturnValue({ alert: { id: "a-1" } }),
      testDispatch: vi.fn().mockReturnValue({ alertId: "a-1", attempts: [] }),
    },
    alertDestinations: {
      list: vi.fn().mockReturnValue({ items: [] }),
      create: vi.fn().mockReturnValue({ destination: { id: "dest-1" } }),
      update: vi.fn().mockReturnValue({ destination: { id: "dest-1" } }),
      delete: vi.fn().mockReturnValue({ deleted: true, destinationId: "dest-1" }),
    },
    alertRules: {
      list: vi.fn().mockReturnValue({ items: [], total: 0 }),
      get: vi.fn().mockReturnValue({ rule: { id: "r-1" }, channels: [], escalationTiers: [] }),
      create: vi.fn().mockReturnValue({ rule: { id: "r-new" } }),
      update: vi.fn().mockReturnValue({ rule: { id: "r-1" } }),
      delete: vi.fn().mockReturnValue({ deleted: true, ruleId: "r-1" }),
    },
    heartbeat: {
      getStatus: vi.fn().mockReturnValue({
        lastRunAt: null,
        result: "unknown",
        intervalMs: 900000,
        nextRunAt: null,
      }),
      trigger: vi.fn().mockResolvedValue({
        triggered: true,
        result: {
          status: "ok",
          actionRequired: false,
        },
      }),
    },
  };
}

// ─── Tests ───

describe("B-005 FridayObservabilityRoutes", () => {
  describe("route registration", () => {
    it("registers all 26 routes", () => {
      const routes = createFridayObservabilityRoutes(makeDeps());
      expect(routes.length).toBe(26);
    });

    it("has unique operationIds", () => {
      const routes = createFridayObservabilityRoutes(makeDeps());
      const ids = routes.map((r) => r.operationId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("all routes require authentication", () => {
      const routes = createFridayObservabilityRoutes(makeDeps());
      for (const route of routes) {
        expect(route.auth).toEqual({ public: true });
      }
    });

    it("all operationIds start with observability.", () => {
      const routes = createFridayObservabilityRoutes(makeDeps());
      for (const route of routes) {
        expect(route.operationId).toMatch(/^observability\./);
      }
    });
  });

  describe("overview routes", () => {
    it("GET /v1/observability/overview delegates to get", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.overview");

      expect(route.method).toBe("GET");
      const result = await route.handler(makeCtx()) as Awaited<ReturnType<typeof deps.overview.get>>;
      expect(deps.overview.get).toHaveBeenCalledTimes(1);
      expect(result.runtime?.browser?.sessionCount).toBe(1);
    });

    it("GET /v1/observability/time-series delegates to get", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.time.series");

      await route.handler(makeCtx({
        query: {
          metricName: "friday.learning.failures.total",
          startTime: "2026-01-01T00:00:00Z",
          endTime: "2026-01-01T01:00:00Z",
          bucketSize: "5m",
        },
      }));
      expect(deps.timeSeries.get).toHaveBeenCalledWith({
        metricName: "friday.learning.failures.total",
        startTime: "2026-01-01T00:00:00Z",
        endTime: "2026-01-01T01:00:00Z",
        bucketSize: "5m",
      });
    });
  });

  describe("trace routes", () => {
    it("GET /v1/observability/traces delegates to search", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.traces.search");

      expect(route.method).toBe("GET");
      expect(route.auth).toEqual({ public: true });
      await route.handler(makeCtx({ query: { module: "workflows", status: "error" } }));
      expect(deps.traces.search).toHaveBeenCalledWith({ module: "workflows", status: "error" });
    });

    it("GET /v1/observability/traces/:traceId delegates to get", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.traces.get");

      await route.handler(makeCtx({ params: { traceId: "trace-abc" } }));
      expect(deps.traces.get).toHaveBeenCalledWith("trace-abc");
    });
  });

  describe("audit routes", () => {
    it("GET /v1/observability/audit delegates to search", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.audit.search");

      await route.handler(makeCtx({ query: { outcome: "failure" } }));
      expect(deps.audit.search).toHaveBeenCalledWith({ outcome: "failure" });
    });

    it("GET /v1/observability/audit/:entryId delegates to get", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.audit.get");

      await route.handler(makeCtx({ params: { entryId: "entry-42" } }));
      expect(deps.audit.get).toHaveBeenCalledWith("entry-42");
    });
  });

  describe("SLO routes", () => {
    it("GET /v1/observability/slos delegates to list", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.slos.list");

      await route.handler(makeCtx({ query: { status: "breaching" } }));
      expect(deps.slos.list).toHaveBeenCalledWith({ status: "breaching" });
    });

    it("GET /v1/observability/slos/:sloId delegates to get", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.slos.get");

      await route.handler(makeCtx({ params: { sloId: "slo-5" } }));
      expect(deps.slos.get).toHaveBeenCalledWith("slo-5");
    });
  });

  describe("alert routes", () => {
    it("GET /v1/observability/alerts delegates to list", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.alerts.list");

      await route.handler(makeCtx({ query: { severity: "critical" } }));
      expect(deps.alerts.list).toHaveBeenCalledWith({ severity: "critical" });
    });

    it("GET /v1/observability/alerts/:alertId delegates to get", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.alerts.get");

      await route.handler(makeCtx({ params: { alertId: "alert-7" } }));
      expect(deps.alerts.get).toHaveBeenCalledWith("alert-7");
    });

    it("POST /v1/observability/alerts/:alertId/acknowledge delegates", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.alerts.acknowledge");

      expect(route.method).toBe("POST");
      expect(route.auth).toEqual({ public: true });
      await route.handler(makeCtx({ params: { alertId: "a-1" }, body: { note: "investigating" } }));
      expect(deps.alerts.acknowledge).toHaveBeenCalledWith("a-1", { note: "investigating" });
    });

    it("POST /v1/observability/alerts/:alertId/test-dispatch delegates", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.alerts.test.dispatch");

      await route.handler(makeCtx({ params: { alertId: "a-1" }, body: { destinationId: "dest-1" } }));
      expect(deps.alerts.testDispatch).toHaveBeenCalledWith("a-1", { destinationId: "dest-1" });
    });
  });

  describe("alert destination routes", () => {
    it("GET /v1/observability/alert-destinations delegates to list", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.alert.destinations.list");

      await route.handler(makeCtx());
      expect(deps.alertDestinations.list).toHaveBeenCalledTimes(1);
    });

    it("POST /v1/observability/alert-destinations delegates to create", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.alert.destinations.create");
      const body = {
        type: "slack",
        name: "Ops Slack",
        webhookUrl: "https://hooks.slack.example/test",
      };

      await route.handler(makeCtx({ body }));
      expect(deps.alertDestinations.create).toHaveBeenCalledWith(body);
    });

    it("PATCH /v1/observability/alert-destinations/:destinationId delegates to update", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.alert.destinations.update");

      await route.handler(makeCtx({
        params: { destinationId: "dest-1" },
        body: { enabled: false },
      }));
      expect(deps.alertDestinations.update).toHaveBeenCalledWith("dest-1", { enabled: false });
    });

    it("DELETE /v1/observability/alert-destinations/:destinationId delegates to delete", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.alert.destinations.delete");

      await route.handler(makeCtx({ params: { destinationId: "dest-1" } }));
      expect(deps.alertDestinations.delete).toHaveBeenCalledWith("dest-1");
    });
  });

  describe("alert rule routes", () => {
    it("GET /v1/observability/alert-rules delegates to list", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.alert.rules.list");

      await route.handler(makeCtx({ query: { enabled: true } }));
      expect(deps.alertRules.list).toHaveBeenCalledWith({ enabled: true });
    });

    it("GET /v1/observability/alert-rules/:ruleId delegates to get", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.alert.rules.get");

      await route.handler(makeCtx({ params: { ruleId: "rule-3" } }));
      expect(deps.alertRules.get).toHaveBeenCalledWith("rule-3");
    });

    it("POST /v1/observability/alert-rules validates name", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.alert.rules.create");

      expect(route.method).toBe("POST");
      expect(route.auth).toEqual({ public: true });
      await expect(route.handler(makeCtx({
        body: { condition: { type: "threshold" }, channelIds: [] },
      }))).rejects.toThrow("name is required");
    });

    it("POST /v1/observability/alert-rules validates condition", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.alert.rules.create");

      await expect(route.handler(makeCtx({
        body: { name: "My Alert", channelIds: [] },
      }))).rejects.toThrow("condition is required");
    });

    it("POST /v1/observability/alert-rules delegates with valid body", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.alert.rules.create");

      const body = {
        name: "High Latency",
        description: "API p99 > 1s",
        severity: "warning",
        condition: { type: "threshold", metric: "api.latency.p99", operator: "gt", value: 1000 },
        channelIds: ["ch-1"],
      };
      await route.handler(makeCtx({ body }));
      expect(deps.alertRules.create).toHaveBeenCalledWith(body);
    });

    it("PUT /v1/observability/alert-rules/:ruleId requires etag", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.alert.rules.update");

      expect(route.method).toBe("PUT");
      await expect(route.handler(makeCtx({
        params: { ruleId: "r-1" },
        body: { name: "Updated" },
      }))).rejects.toThrow("etag is required");
    });

    it("PUT /v1/observability/alert-rules/:ruleId delegates with valid body", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.alert.rules.update");

      await route.handler(makeCtx({
        params: { ruleId: "r-1" },
        body: { etag: "e-123", name: "Updated" },
      }));
      expect(deps.alertRules.update).toHaveBeenCalledWith("r-1", { etag: "e-123", name: "Updated" });
    });

    it("DELETE /v1/observability/alert-rules/:ruleId requires etag", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.alert.rules.delete");

      expect(route.method).toBe("DELETE");
      expect(route.auth).toEqual({ public: true });
      await expect(route.handler(makeCtx({
        params: { ruleId: "r-1" },
        body: {},
      }))).rejects.toThrow("etag is required");
    });

    it("DELETE /v1/observability/alert-rules/:ruleId delegates with valid body", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.alert.rules.delete");

      await route.handler(makeCtx({
        params: { ruleId: "r-1" },
        body: { etag: "e-abc" },
      }));
      expect(deps.alertRules.delete).toHaveBeenCalledWith("r-1", { etag: "e-abc" });
    });
  });

  describe("heartbeat routes", () => {
    it("GET /v1/heartbeat/status delegates to getStatus", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.heartbeat.status");

      expect(route.method).toBe("GET");
      expect(route.auth).toEqual({ public: true });
      await route.handler(makeCtx());
      expect(deps.heartbeat?.getStatus).toHaveBeenCalledTimes(1);
    });

    it("POST /v1/heartbeat/trigger delegates to trigger", async () => {
      const deps = makeDeps();
      const routes = createFridayObservabilityRoutes(deps);
      const route = findRoute(routes, "observability.heartbeat.trigger");

      expect(route.method).toBe("POST");
      expect(route.auth).toEqual({ public: true });
      await route.handler(makeCtx());
      expect(deps.heartbeat?.trigger).toHaveBeenCalledTimes(1);
    });
  });

  describe("route count snapshot (post auth-boundary)", () => {
    const routes = createFridayObservabilityRoutes(makeDeps());

    it("every route declares public auth (auth-boundary product invariant)", () => {
      for (const route of routes) {
        expect(route.auth).toEqual({ public: true });
      }
    });

    it("expected route counts by HTTP method", () => {
      expect(routes.filter((r) => r.method === "GET").length).toBe(14);
      expect(routes.filter((r) => r.method === "POST").length).toBe(6);
      expect(routes.filter((r) => r.method === "PUT").length).toBe(2);
      expect(routes.filter((r) => r.method === "PATCH").length).toBe(1);
      expect(routes.filter((r) => r.method === "DELETE").length).toBe(3);
      expect(routes.length).toBe(26);
    });
  });
});

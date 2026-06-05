import { describe, it, expect, vi } from "vitest";
import { createFridayDesktopRoutes } from "../../../../../src/api/http/routes/friday-desktop-routes.js";
import type { FridayDesktopRoutesDeps } from "../../../../../src/api/http/routes/friday-desktop-routes.js";
import type { FridayRouteDefinition } from "../../../../../src/api/model/friday-api-common.types.js";

// ─── Mock deps factory ───

function makeDeps(overrides?: Partial<FridayDesktopRoutesDeps>): FridayDesktopRoutesDeps {
  return {
    actions: {
      execute: vi.fn().mockResolvedValue({ result: { id: "a-1", status: "success", durationMs: 10 } }),
      batch: vi.fn().mockResolvedValue({ results: [], allSucceeded: true, successCount: 0, failureCount: 0, skippedCount: 0 }),
      cancel: vi.fn().mockResolvedValue({ result: { id: "a-1", status: "cancelled" } }),
      log: vi.fn().mockReturnValue({ items: [], nextCursor: undefined }),
    },
    recordings: {
      start: vi.fn().mockReturnValue({ recording: { id: "rec-1", name: "Test", state: "recording" } }),
      stop: vi.fn().mockReturnValue({ recording: { id: "rec-1", state: "stopped" } }),
      pause: vi.fn().mockReturnValue({ recording: { id: "rec-1", state: "paused" } }),
      resume: vi.fn().mockReturnValue({ recording: { id: "rec-1", state: "recording" } }),
      list: vi.fn().mockReturnValue({ items: [], nextCursor: undefined }),
      get: vi.fn().mockReturnValue({ recording: { id: "rec-1", name: "Test" } }),
      listSteps: vi.fn().mockReturnValue({ items: [], nextCursor: undefined }),
      replay: vi.fn().mockResolvedValue({ recordingId: "rec-1", stepResults: [], allSucceeded: true, successCount: 0, failureCount: 0, skippedCount: 0, totalDurationMs: 0 }),
      delete: vi.fn().mockReturnValue({ deleted: true }),
    },
    policies: {
      create: vi.fn().mockReturnValue({ policy: { id: "pol-1", name: "Default" }, rules: [] }),
      get: vi.fn().mockReturnValue({ policy: { id: "pol-1" }, rules: [] }),
      list: vi.fn().mockReturnValue({ items: [], nextCursor: undefined }),
      update: vi.fn().mockReturnValue({ policy: { id: "pol-1" } }),
      delete: vi.fn().mockReturnValue({ deleted: true }),
      addRule: vi.fn().mockReturnValue({ rule: { id: "rule-1" }, etag: "e2" }),
      removeRule: vi.fn().mockReturnValue({ deleted: true, etag: "e3" }),
    },
    permissions: {
      list: vi.fn().mockResolvedValue({ permissions: [], platform: "darwin" }),
      respond: vi.fn().mockReturnValue({ decision: { id: "dec-1" } }),
      listDecisions: vi.fn().mockReturnValue({ items: [], nextCursor: undefined }),
    },
    platform: {
      get: vi.fn().mockResolvedValue({ adapter: { id: "darwin-v1" }, supportedActions: [], permissions: [] }),
    },
    elements: {
      inspect: vi.fn().mockResolvedValue({ element: null }),
      search: vi.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
    },
    ...overrides,
  };
}

function makeCtx(overrides?: Record<string, unknown>) {
  return {
    requestId: "req-001",
    receivedAt: "2026-02-25T10:00:00Z",
    params: {},
    query: {},
    body: {},
    headers: {},
    principal: { principalType: "user", principalId: "u-1", userId: "u-1", role: "admin", scopes: ["desktop.execute", "desktop.read", "desktop.write"], tokenId: "t-1", tokenKind: "access", issuedAt: "2026-02-25T10:00:00Z" },
    ...overrides,
  } as Parameters<FridayRouteDefinition<unknown, unknown, unknown, unknown>["handler"]>[0];
}

function findRoute(
  routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[],
  operationId: string,
): FridayRouteDefinition<unknown, unknown, unknown, unknown> {
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route;
}

// ─── Tests ───

describe("createFridayDesktopRoutes", () => {
  it("returns an array of route definitions", () => {
    const routes = createFridayDesktopRoutes(makeDeps());
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) {
      expect(r.operationId).toBeTruthy();
      expect(r.method).toMatch(/^(GET|POST|PUT|PATCH|DELETE)$/);
      expect(r.path).toMatch(/^\/v1\/desktop\//);
    }
  });

  it("all routes require authentication", () => {
    const routes = createFridayDesktopRoutes(makeDeps());
    for (const r of routes) {
      expect(r.auth).toEqual({ public: true });
    }
  });

  // ─── Actions ───

  describe("actions", () => {
    it("fail-closes desktop action execution routes by default without invoking TypeScript services", async () => {
      const deps = makeDeps();
      const routes = createFridayDesktopRoutes(deps);
      const executeRoute = findRoute(routes, "desktop.actions.execute");
      const batchRoute = findRoute(routes, "desktop.actions.batch");

      await expect(
        executeRoute.handler(makeCtx({ body: { action: { type: "click" }, idempotencyKey: "k-retired-1" } })),
      ).rejects.toMatchObject({ code: "TS_RUNTIME_DESKTOP_ACTION_EXECUTION_RETIRED" });
      await expect(
        batchRoute.handler(makeCtx({
          body: {
            actions: [{ clientId: "c1", action: { type: "click" } }],
            idempotencyKey: "k-retired-2",
          },
        })),
      ).rejects.toMatchObject({ code: "TS_RUNTIME_DESKTOP_ACTION_EXECUTION_RETIRED" });

      expect(deps.actions.execute).not.toHaveBeenCalled();
      expect(deps.actions.batch).not.toHaveBeenCalled();
    });

    it("executes an action", async () => {
      const deps = makeDeps({ allowTestOnlyDesktopActionExecution: true });
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.actions.execute");
      expect(route.method).toBe("POST");
      expect(route.path).toBe("/v1/desktop/actions/execute");

      const ctx = makeCtx({ body: { action: { type: "click" }, idempotencyKey: "k1" } });
      const result = await route.handler(ctx);
      expect(deps.actions.execute).toHaveBeenCalledWith(ctx.body);
      expect(result).toHaveProperty("result");
    });

    it("validates action field is present", async () => {
      const routes = createFridayDesktopRoutes(makeDeps());
      const route = findRoute(routes, "desktop.actions.execute");
      const ctx = makeCtx({ body: { idempotencyKey: "k1" } });
      await expect(route.handler(ctx)).rejects.toThrow("action is required");
    });

    it("validates idempotencyKey for execute", async () => {
      const routes = createFridayDesktopRoutes(makeDeps());
      const route = findRoute(routes, "desktop.actions.execute");
      const ctx = makeCtx({ body: { action: { type: "click" }, idempotencyKey: "" } });
      await expect(route.handler(ctx)).rejects.toThrow("idempotencyKey is required");
    });

    it("batches actions", async () => {
      const deps = makeDeps({ allowTestOnlyDesktopActionExecution: true });
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.actions.batch");
      expect(route.method).toBe("POST");

      const ctx = makeCtx({
        body: { actions: [{ clientId: "c1", action: { type: "click" } }], idempotencyKey: "k2" },
      });
      await route.handler(ctx);
      expect(deps.actions.batch).toHaveBeenCalled();
    });

    it("validates batch actions array", async () => {
      const routes = createFridayDesktopRoutes(makeDeps());
      const route = findRoute(routes, "desktop.actions.batch");
      const ctx = makeCtx({ body: { actions: [], idempotencyKey: "k1" } });
      await expect(route.handler(ctx)).rejects.toThrow("actions array is required");
    });

    it("cancels an action", async () => {
      const deps = makeDeps({ allowTestOnlyDesktopActionControlExecution: true });
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.actions.cancel");
      expect(route.method).toBe("POST");
      expect(route.path).toBe("/v1/desktop/actions/:actionId/cancel");

      const ctx = makeCtx({ params: { actionId: "a-1" }, body: { idempotencyKey: "k3" } });
      await route.handler(ctx);
      expect(deps.actions.cancel).toHaveBeenCalledWith("a-1", ctx.body);
    });

    it("lists action log", async () => {
      const deps = makeDeps({ allowTestOnlyDesktopActionControlExecution: true });
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.actions.log");
      expect(route.method).toBe("GET");

      const ctx = makeCtx({ query: { status: "success" } });
      await route.handler(ctx);
      expect(deps.actions.log).toHaveBeenCalledWith(ctx.query);
    });

    it("fail-closes desktop action control/log by default without invoking TypeScript services", async () => {
      const deps = makeDeps();
      const routes = createFridayDesktopRoutes(deps);
      const cancelRoute = findRoute(routes, "desktop.actions.cancel");
      const logRoute = findRoute(routes, "desktop.actions.log");

      await expect(
        cancelRoute.handler(makeCtx({ params: { actionId: "a-1" }, body: { idempotencyKey: "k-fc-cancel" } })),
      ).rejects.toMatchObject({ code: "TS_RUNTIME_DESKTOP_ACTION_CONTROL_RETIRED", httpStatus: 503 });
      await expect(
        logRoute.handler(makeCtx({ query: { status: "success" } })),
      ).rejects.toMatchObject({ code: "TS_RUNTIME_DESKTOP_ACTION_CONTROL_RETIRED", httpStatus: 503 });

      expect(deps.actions.cancel).not.toHaveBeenCalled();
      expect(deps.actions.log).not.toHaveBeenCalled();
    });
  });

  // ─── Recordings ───

  describe("recordings", () => {
    it("starts a recording", async () => {
      const deps = makeDeps({ allowTestOnlyDesktopRecordingExecution: true });
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.recordings.start");
      expect(route.method).toBe("POST");

      const ctx = makeCtx({ body: { name: "My Flow", idempotencyKey: "k4" } });
      await route.handler(ctx);
      expect(deps.recordings.start).toHaveBeenCalledWith(ctx.body);
    });

    it("validates recording name", async () => {
      const routes = createFridayDesktopRoutes(makeDeps());
      const route = findRoute(routes, "desktop.recordings.start");
      const ctx = makeCtx({ body: { idempotencyKey: "k4" } });
      await expect(route.handler(ctx)).rejects.toThrow("name is required");
    });

    it("lists recordings", async () => {
      const deps = makeDeps();
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.recordings.list");
      expect(route.method).toBe("GET");

      await route.handler(makeCtx({ query: { state: "recording" } }));
      expect(deps.recordings.list).toHaveBeenCalled();
    });

    it("gets a recording by ID", async () => {
      const deps = makeDeps();
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.recordings.get");

      await route.handler(makeCtx({ params: { recordingId: "rec-1" } }));
      expect(deps.recordings.get).toHaveBeenCalledWith("rec-1");
    });

    it("stops a recording", async () => {
      const deps = makeDeps({ allowTestOnlyDesktopRecordingExecution: true });
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.recordings.stop");

      await route.handler(makeCtx({ params: { recordingId: "rec-1" }, body: { idempotencyKey: "k5" } }));
      expect(deps.recordings.stop).toHaveBeenCalledWith("rec-1", { idempotencyKey: "k5" });
    });

    it("pauses a recording", async () => {
      const deps = makeDeps({ allowTestOnlyDesktopRecordingExecution: true });
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.recordings.pause");

      await route.handler(makeCtx({ params: { recordingId: "rec-1" }, body: { idempotencyKey: "k6" } }));
      expect(deps.recordings.pause).toHaveBeenCalledWith("rec-1", { idempotencyKey: "k6" });
    });

    it("resumes a recording", async () => {
      const deps = makeDeps({ allowTestOnlyDesktopRecordingExecution: true });
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.recordings.resume");

      await route.handler(makeCtx({ params: { recordingId: "rec-1" }, body: { idempotencyKey: "k7" } }));
      expect(deps.recordings.resume).toHaveBeenCalledWith("rec-1", { idempotencyKey: "k7" });
    });

    it("lists recording steps", async () => {
      const deps = makeDeps({ allowTestOnlyDesktopRecordingExecution: true });
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.recordings.steps.list");

      await route.handler(makeCtx({ params: { recordingId: "rec-1" }, query: { limit: 20 } }));
      expect(deps.recordings.listSteps).toHaveBeenCalledWith("rec-1", { limit: 20 });
    });

    it("replays a recording", async () => {
      const deps = makeDeps({ allowTestOnlyDesktopRecordingExecution: true });
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.recordings.replay");

      await route.handler(makeCtx({
        params: { recordingId: "rec-1" },
        body: { parameters: { url: "https://example.com" }, idempotencyKey: "k8" },
      }));
      expect(deps.recordings.replay).toHaveBeenCalledWith("rec-1", { parameters: { url: "https://example.com" }, idempotencyKey: "k8" });
    });

    it("deletes a recording", async () => {
      const deps = makeDeps({ allowTestOnlyDesktopRecordingExecution: true });
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.recordings.delete");
      expect(route.method).toBe("DELETE");

      await route.handler(makeCtx({ params: { recordingId: "rec-1" }, body: { idempotencyKey: "k9" } }));
      expect(deps.recordings.delete).toHaveBeenCalledWith("rec-1", { idempotencyKey: "k9" });
    });

    it("fail-closes desktop recording lifecycle/replay/steps by default without invoking TypeScript services", async () => {
      const deps = makeDeps();
      const routes = createFridayDesktopRoutes(deps);

      await expect(
        findRoute(routes, "desktop.recordings.start").handler(
          makeCtx({ body: { name: "Flow", idempotencyKey: "k-fc-start" } }),
        ),
      ).rejects.toMatchObject({ code: "TS_RUNTIME_DESKTOP_RECORDING_RETIRED", httpStatus: 503 });
      await expect(
        findRoute(routes, "desktop.recordings.replay").handler(
          makeCtx({ params: { recordingId: "rec-1" }, body: { idempotencyKey: "k-fc-replay" } }),
        ),
      ).rejects.toMatchObject({ code: "TS_RUNTIME_DESKTOP_RECORDING_RETIRED", httpStatus: 503 });
      await expect(
        findRoute(routes, "desktop.recordings.steps.list").handler(
          makeCtx({ params: { recordingId: "rec-1" }, query: {} }),
        ),
      ).rejects.toMatchObject({ code: "TS_RUNTIME_DESKTOP_RECORDING_RETIRED", httpStatus: 503 });

      expect(deps.recordings.start).not.toHaveBeenCalled();
      expect(deps.recordings.replay).not.toHaveBeenCalled();
      expect(deps.recordings.listSteps).not.toHaveBeenCalled();
    });
  });

  // ─── Policies ───

  describe("policies", () => {
    it("creates a policy", async () => {
      const deps = makeDeps();
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.policies.create");
      expect(route.method).toBe("POST");
      expect(route.auth).toEqual({ public: true });

      const ctx = makeCtx({ body: { name: "Safe", rules: [], idempotencyKey: "k10" } });
      await route.handler(ctx);
      expect(deps.policies.create).toHaveBeenCalledWith(ctx.body);
    });

    it("validates policy name", async () => {
      const routes = createFridayDesktopRoutes(makeDeps());
      const route = findRoute(routes, "desktop.policies.create");
      const ctx = makeCtx({ body: { rules: [], idempotencyKey: "k10" } });
      await expect(route.handler(ctx)).rejects.toThrow("name is required");
    });

    it("lists policies", async () => {
      const deps = makeDeps();
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.policies.list");
      expect(route.method).toBe("GET");

      await route.handler(makeCtx());
      expect(deps.policies.list).toHaveBeenCalled();
    });

    it("gets a policy by ID", async () => {
      const deps = makeDeps();
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.policies.get");

      await route.handler(makeCtx({ params: { policyId: "pol-1" } }));
      expect(deps.policies.get).toHaveBeenCalledWith("pol-1");
    });

    it("updates a policy with etag", async () => {
      const deps = makeDeps();
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.policies.update");
      expect(route.method).toBe("PATCH");

      await route.handler(makeCtx({
        params: { policyId: "pol-1" },
        body: { name: "Updated", etag: "e1", idempotencyKey: "k11" },
      }));
      expect(deps.policies.update).toHaveBeenCalledWith("pol-1", { name: "Updated", etag: "e1", idempotencyKey: "k11" });
    });

    it("validates etag for update", async () => {
      const routes = createFridayDesktopRoutes(makeDeps());
      const route = findRoute(routes, "desktop.policies.update");
      const ctx = makeCtx({ params: { policyId: "pol-1" }, body: { idempotencyKey: "k11" } });
      await expect(route.handler(ctx)).rejects.toThrow("etag is required");
    });

    it("deletes a policy", async () => {
      const deps = makeDeps();
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.policies.delete");
      expect(route.method).toBe("DELETE");

      await route.handler(makeCtx({
        params: { policyId: "pol-1" },
        body: { etag: "e1", idempotencyKey: "k12" },
      }));
      expect(deps.policies.delete).toHaveBeenCalledWith("pol-1", { etag: "e1", idempotencyKey: "k12" });
    });

    it("adds a rule to a policy", async () => {
      const deps = makeDeps();
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.policies.rules.create");

      await route.handler(makeCtx({
        params: { policyId: "pol-1" },
        body: { rule: { actionType: "click", appFilter: "*", riskLevel: "low", decision: "allow" }, etag: "e1", idempotencyKey: "k13" },
      }));
      expect(deps.policies.addRule).toHaveBeenCalled();
    });

    it("removes a rule from a policy", async () => {
      const deps = makeDeps();
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.policies.rules.delete");
      expect(route.method).toBe("DELETE");

      await route.handler(makeCtx({
        params: { policyId: "pol-1", ruleId: "rule-1" },
        body: { etag: "e1", idempotencyKey: "k14" },
      }));
      expect(deps.policies.removeRule).toHaveBeenCalledWith("pol-1", "rule-1", { etag: "e1", idempotencyKey: "k14" });
    });
  });

  // ─── Permissions ───

  describe("permissions", () => {
    it("lists OS permissions", async () => {
      const deps = makeDeps();
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.permissions.list");
      expect(route.method).toBe("GET");

      const result = await route.handler(makeCtx());
      expect(deps.permissions.list).toHaveBeenCalled();
      expect(result).toHaveProperty("permissions");
    });

    it("responds to a permission prompt", async () => {
      const deps = makeDeps();
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.permissions.respond");
      expect(route.method).toBe("POST");

      await route.handler(makeCtx({
        params: { promptId: "p-1" },
        body: { decision: "allow_once", idempotencyKey: "k15" },
      }));
      expect(deps.permissions.respond).toHaveBeenCalledWith("p-1", { decision: "allow_once", idempotencyKey: "k15" });
    });

    it("validates decision field for prompt response", async () => {
      const routes = createFridayDesktopRoutes(makeDeps());
      const route = findRoute(routes, "desktop.permissions.respond");
      const ctx = makeCtx({ params: { promptId: "p-1" }, body: { idempotencyKey: "k15" } });
      await expect(route.handler(ctx)).rejects.toThrow("decision is required");
    });

    it("lists permission decisions", async () => {
      const deps = makeDeps();
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.permissions.decisions.list");
      expect(route.method).toBe("GET");

      await route.handler(makeCtx({ query: { actionType: "click" } }));
      expect(deps.permissions.listDecisions).toHaveBeenCalled();
    });
  });

  // ─── Platform ───

  describe("platform", () => {
    it("returns platform info", async () => {
      const deps = makeDeps();
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.platform.get");
      expect(route.method).toBe("GET");

      const result = await route.handler(makeCtx());
      expect(deps.platform.get).toHaveBeenCalled();
      expect(result).toHaveProperty("adapter");
    });
  });

  // ─── Elements ───

  describe("elements", () => {
    it("inspects an element", async () => {
      const deps = makeDeps({ allowTestOnlyDesktopElementInspectionExecution: true });
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.elements.inspect");
      expect(route.method).toBe("POST");

      await route.handler(makeCtx({
        body: { selector: { strategy: "accessibility_id", value: "btn-ok" } },
      }));
      expect(deps.elements.inspect).toHaveBeenCalled();
    });

    it("searches elements", async () => {
      const deps = makeDeps({ allowTestOnlyDesktopElementInspectionExecution: true });
      const routes = createFridayDesktopRoutes(deps);
      const route = findRoute(routes, "desktop.elements.search");
      expect(route.method).toBe("GET");

      await route.handler(makeCtx({ query: { query: "Submit" } }));
      expect(deps.elements.search).toHaveBeenCalledWith({ query: "Submit" });
    });

    it("validates search query is present", async () => {
      const routes = createFridayDesktopRoutes(makeDeps());
      const route = findRoute(routes, "desktop.elements.search");
      const ctx = makeCtx({ query: {} });
      await expect(route.handler(ctx)).rejects.toThrow("query is required");
    });

    it("fail-closes live desktop element inspect/search by default without invoking TypeScript services", async () => {
      const deps = makeDeps();
      const routes = createFridayDesktopRoutes(deps);

      await expect(
        findRoute(routes, "desktop.elements.inspect").handler(
          makeCtx({ body: { selector: { strategy: "accessibility_id", value: "btn-ok" } } }),
        ),
      ).rejects.toMatchObject({ code: "TS_RUNTIME_DESKTOP_ELEMENT_INSPECTION_RETIRED", httpStatus: 503 });
      await expect(
        findRoute(routes, "desktop.elements.search").handler(makeCtx({ query: { query: "Submit" } })),
      ).rejects.toMatchObject({ code: "TS_RUNTIME_DESKTOP_ELEMENT_INSPECTION_RETIRED", httpStatus: 503 });

      expect(deps.elements.inspect).not.toHaveBeenCalled();
      expect(deps.elements.search).not.toHaveBeenCalled();
    });
  });

  // ─── Route coverage ───

  describe("route coverage", () => {
    it("covers all expected operation IDs", () => {
      const routes = createFridayDesktopRoutes(makeDeps());
      const opIds = routes.map((r) => r.operationId).sort();

      expect(opIds).toEqual([
        "desktop.actions.batch",
        "desktop.actions.cancel",
        "desktop.actions.execute",
        "desktop.actions.log",
        "desktop.elements.inspect",
        "desktop.elements.search",
        "desktop.permissions.decisions.list",
        "desktop.permissions.list",
        "desktop.permissions.respond",
        "desktop.platform.get",
        "desktop.policies.create",
        "desktop.policies.delete",
        "desktop.policies.get",
        "desktop.policies.list",
        "desktop.policies.rules.create",
        "desktop.policies.rules.delete",
        "desktop.policies.update",
        "desktop.recordings.delete",
        "desktop.recordings.get",
        "desktop.recordings.list",
        "desktop.recordings.pause",
        "desktop.recordings.replay",
        "desktop.recordings.resume",
        "desktop.recordings.start",
        "desktop.recordings.steps.list",
        "desktop.recordings.stop",
      ]);
    });

    it("expected operationId coverage across desktop families", () => {
      const routes = createFridayDesktopRoutes(makeDeps());
      const opIds = new Set(routes.map((r) => r.operationId));

      // action execution + replay surface present
      expect(opIds.has("desktop.actions.execute")).toBe(true);
      expect(opIds.has("desktop.actions.batch")).toBe(true);
      expect(opIds.has("desktop.recordings.replay")).toBe(true);

      // listing/get surface present
      expect(opIds.has("desktop.actions.log")).toBe(true);
      expect(opIds.has("desktop.recordings.list")).toBe(true);
      expect(opIds.has("desktop.platform.get")).toBe(true);

      // mutation surface present
      expect(opIds.has("desktop.recordings.start")).toBe(true);
      expect(opIds.has("desktop.policies.create")).toBe(true);
    });

    it("policy mutation routes are present (auth-boundary product invariant: all public)", () => {
      const routes = createFridayDesktopRoutes(makeDeps());
      const policyMutations = routes.filter(
        (r) => r.operationId.startsWith("desktop.policies.") && r.method !== "GET",
      );
      expect(policyMutations.length).toBeGreaterThan(0);
      for (const r of policyMutations) {
        expect(r.auth).toEqual({ public: true });
      }
    });
  });
});

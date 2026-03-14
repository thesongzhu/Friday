import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFridayAgentRoutes } from "#api";
import type { FridayAgentRoutesDeps } from "#api";
import type { FridayAgentEventEmitter } from "#agent";
import type { FridayAgentRunRecord, FridayAgentRuntimeResult, FridayAgentAutomationService } from "#agent";

function createStubEventEmitter(): FridayAgentEventEmitter {
  return {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  };
}

function createStubAutomationService(): FridayAgentAutomationService {
  return {
    attachSchedulerBridge: vi.fn(),
    syncScheduledAutomations: vi.fn(),
    save: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
    update: vi.fn(),
    remove: vi.fn(),
    run: vi.fn().mockResolvedValue(createStubResult()),
  };
}

function createStubRun(overrides?: Partial<FridayAgentRunRecord>): FridayAgentRunRecord {
  return {
    id: "run-1",
    task: "test task",
    status: "executing",
    sessionKey: "agent:run:run-1",
    attempt: 0,
    maxAttempts: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createStubResult(overrides?: Partial<FridayAgentRuntimeResult>): FridayAgentRuntimeResult {
  return {
    runId: "run-1",
    status: "completed",
    response: "Done",
    toolCallCount: 2,
    durationMs: 1000,
    usageInput: 100,
    usageOutput: 50,
    ...overrides,
  };
}

function createAutomationStub(overrides?: Record<string, unknown>) {
  return {
    id: "auto-1",
    name: "Automation",
    taskTemplate: "task",
    enabled: true,
    runCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("FridayAgentRoutes", () => {
  let stubDeps: FridayAgentRoutesDeps;

  beforeEach(() => {
    stubDeps = {
      startRun: vi.fn<[{ task: string }], Promise<FridayAgentRuntimeResult>>().mockResolvedValue(createStubResult()),
      getRun: vi.fn<[string], FridayAgentRunRecord | null>().mockReturnValue(createStubRun()),
      listRuns: vi.fn().mockReturnValue([]),
      listRunEvents: vi.fn().mockReturnValue([]),
      cancelRun: vi.fn(),
      eventEmitter: createStubEventEmitter(),
      automationService: createStubAutomationService(),
    };
  });

  it("registers 11 agent routes", () => {
    const routes = createFridayAgentRoutes(stubDeps);
    expect(routes).toHaveLength(11);
  });

  it("POST /v1/agent/runs requires agent.run scope with workflow.run compatibility", () => {
    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.start");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.path).toBe("/v1/agent/runs");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["agent.run", "workflow.run"] });
  });

  it("GET /v1/agent/runs requires agent.read scope with workflow.run compatibility", () => {
    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.list");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.path).toBe("/v1/agent/runs");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["agent.read", "workflow.run"] });
  });

  it("GET /v1/agent/runs/:runId requires agent.read scope with workflow.run compatibility", () => {
    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.get");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.path).toBe("/v1/agent/runs/:runId");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["agent.read", "workflow.run"] });
  });

  it("POST /v1/agent/runs/:runId/cancel requires agent.write scope with workflow.run compatibility", () => {
    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.cancel");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.path).toBe("/v1/agent/runs/:runId/cancel");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["agent.write", "workflow.run"] });
  });

  it("GET /v1/agent/runs/:runId/events requires agent.read scope with workflow.run compatibility", () => {
    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.events");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.path).toBe("/v1/agent/runs/:runId/events");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["agent.read", "workflow.run"] });
  });

  // ─── Handler tests ───

  describe("POST /v1/agent/runs handler", () => {
    it("validates task is required", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const ctx = {
        body: {},
        params: {},
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      await expect(route.handler(ctx)).rejects.toThrow("task is required");
    });

    it("validates task is non-empty string", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const ctx = {
        body: { task: "   " },
        params: {},
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      await expect(route.handler(ctx)).rejects.toThrow("task is required");
    });

    it("calls startRun with valid input", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const ctx = {
        body: { task: "Build a feature", providerId: "openai", model: "gpt-4", timeoutMs: 60000 },
        params: {},
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      const result = await route.handler(ctx);
      expect(stubDeps.startRun).toHaveBeenCalledWith({
        task: "Build a feature",
        providerId: "openai",
        model: "gpt-4",
        timeoutMs: 60000,
      });
      expect(result).toEqual(createStubResult());
    });

    it("forwards sessionKey when provided", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const ctx = {
        body: { task: "Continue", sessionKey: "agent:chat:abc123" },
        params: {},
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      await route.handler(ctx);
      expect(stubDeps.startRun).toHaveBeenCalledWith(
        expect.objectContaining({ task: "Continue", sessionKey: "agent:chat:abc123" }),
      );
    });

    it("validates sessionKey is non-empty when provided", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const ctx = {
        body: { task: "Continue", sessionKey: "   " },
        params: {},
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      await expect(route.handler(ctx)).rejects.toThrow("sessionKey must be a non-empty string when provided");
    });

    it("validates timeoutMs is positive", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const ctx = {
        body: { task: "test", timeoutMs: -1 },
        params: {},
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      await expect(route.handler(ctx)).rejects.toThrow("timeoutMs must be a positive number");
    });

    it("forwards requireReview flag", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const ctx = {
        body: { task: "Review me", requireReview: true },
        params: {},
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      await route.handler(ctx);
      expect(stubDeps.startRun).toHaveBeenCalledWith(
        expect.objectContaining({ task: "Review me", requireReview: true }),
      );
    });

    it("forwards constraints.readOnly", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const ctx = {
        body: { task: "Read only", constraints: { readOnly: true } },
        params: {},
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      await route.handler(ctx);
      expect(stubDeps.startRun).toHaveBeenCalledWith(
        expect.objectContaining({ constraints: { readOnly: true } }),
      );
    });

    it("forwards principal context when authenticated", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const ctx = {
        body: { task: "Secure run" },
        params: {},
        query: {},
        headers: {},
        principal: {
          principalType: "user",
          principalId: "principal-1",
          userId: "user-1",
          role: "owner",
          scopes: ["agent.run"],
          tokenId: "token-1",
          tokenKind: "access",
          issuedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-01T01:00:00.000Z",
        },
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      await route.handler(ctx);
      expect(stubDeps.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          principalId: "principal-1",
          scopes: ["agent.run"],
        }),
      );
    });

    it("checks marketplace entitlement when marketplaceListingId is provided", async () => {
      const assertListingEntitled = vi.fn().mockResolvedValue(undefined);
      const routes = createFridayAgentRoutes({
        ...stubDeps,
        assertListingEntitled,
      });
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const ctx = {
        body: { task: "Secure run", marketplaceListingId: "listing-1" },
        params: {},
        query: {},
        headers: {},
        principal: {
          principalType: "user",
          principalId: "principal-1",
          userId: "user-1",
          role: "owner",
          scopes: ["agent.run"],
          tokenId: "token-1",
          tokenKind: "access",
          issuedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-01T01:00:00.000Z",
        },
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      await route.handler(ctx);
      expect(assertListingEntitled).toHaveBeenCalledWith("listing-1", "principal-1");
    });

    it("validates marketplaceListingId is non-empty when provided", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const ctx = {
        body: { task: "Secure run", marketplaceListingId: "   " },
        params: {},
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      await expect(route.handler(ctx)).rejects.toThrow("marketplaceListingId must be a non-empty string when provided");
    });
  });

  describe("GET /v1/agent/runs handler", () => {
    it("returns items from listRuns", async () => {
      const runs = [createStubRun()];
      stubDeps.listRuns = vi.fn().mockReturnValue(runs);
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.list")!;
      const ctx = {
        body: null,
        params: {},
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      const result = await route.handler(ctx) as { items: FridayAgentRunRecord[] };
      expect(result.items).toEqual(runs);
    });

    it("validates limit is a positive integer", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.list")!;
      const ctx = {
        body: null,
        params: {},
        query: { limit: "abc" },
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      await expect(route.handler(ctx)).rejects.toThrow("limit must be a positive integer");
    });

  });

  describe("GET /v1/agent/runs/:runId handler", () => {
    it("returns run when found", async () => {
      const run = createStubRun();
      stubDeps.getRun = vi.fn().mockReturnValue(run);
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.get")!;
      const ctx = {
        body: null,
        params: { runId: "run-1" },
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      const result = await route.handler(ctx) as { run: FridayAgentRunRecord };
      expect(result.run).toEqual(run);
    });

    it("throws 404 when run not found", async () => {
      stubDeps.getRun = vi.fn().mockReturnValue(null);
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.get")!;
      const ctx = {
        body: null,
        params: { runId: "nonexistent" },
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      await expect(route.handler(ctx)).rejects.toThrow("Agent run not found");
    });
  });

  describe("POST /v1/agent/runs/:runId/cancel handler", () => {
    it("cancels a running agent", async () => {
      stubDeps.getRun = vi.fn().mockReturnValue(createStubRun({ status: "executing" }));
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.cancel")!;
      const ctx = {
        body: null,
        params: { runId: "run-1" },
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      const result = await route.handler(ctx) as { cancelled: boolean; runId: string };
      expect(result.cancelled).toBe(true);
      expect(result.runId).toBe("run-1");
      expect(stubDeps.cancelRun).toHaveBeenCalledWith("run-1");
    });

    it("throws 404 when run not found", async () => {
      stubDeps.getRun = vi.fn().mockReturnValue(null);
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.cancel")!;
      const ctx = {
        body: null,
        params: { runId: "nonexistent" },
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      await expect(route.handler(ctx)).rejects.toThrow("Agent run not found");
    });

    it("throws 409 when run is already terminal", async () => {
      stubDeps.getRun = vi.fn().mockReturnValue(createStubRun({ status: "completed" }));
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.cancel")!;
      const ctx = {
        body: null,
        params: { runId: "run-1" },
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      await expect(route.handler(ctx)).rejects.toThrow("Agent run is already in terminal status");
    });
  });

  describe("GET /v1/agent/runs/:runId/events handler", () => {
    it("throws 404 when run not found", async () => {
      stubDeps.getRun = vi.fn().mockReturnValue(null);
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.events")!;
      const ctx = {
        body: null,
        params: { runId: "nonexistent" },
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      await expect(route.handler(ctx)).rejects.toThrow("Agent run not found");
    });

    it("returns fallback JSON when no raw response available", async () => {
      const run = createStubRun({ status: "executing" });
      stubDeps.getRun = vi.fn().mockReturnValue(run);
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.events")!;
      const ctx = {
        body: null,
        params: { runId: "run-1" },
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      const result = await route.handler(ctx) as { run: FridayAgentRunRecord; streaming: boolean };
      expect(result.run).toEqual(run);
      expect(result.streaming).toBe(false);
    });

    it("replays persisted events and closes for terminal runs with raw response", async () => {
      const run = createStubRun({ status: "completed" });
      stubDeps.getRun = vi.fn().mockReturnValue(run);
      stubDeps.listRunEvents = vi.fn().mockReturnValue([
        {
          eventId: "evt-1",
          runId: "run-1",
          seq: 1,
          eventName: "agent.run.tool_end",
          payload: {
            runId: "run-1",
            toolName: "browser",
            toolCallId: "call-1",
            summary: "facebook.com · visible desktop",
          },
          emittedAt: "2026-01-01T00:00:01.000Z",
          createdAt: "2026-01-01T00:00:01.000Z",
        },
        {
          eventId: "evt-2",
          runId: "run-1",
          seq: 2,
          eventName: "agent.run.completed",
          payload: {
            runId: "run-1",
            durationMs: 1000,
            toolCallCount: 1,
          },
          emittedAt: "2026-01-01T00:00:02.000Z",
          createdAt: "2026-01-01T00:00:02.000Z",
        },
      ]);
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.events")!;

      const mockRes = {
        writeHead: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
      };

      const ctx = {
        body: null,
        params: { runId: "run-1" },
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
        _raw: mockRes,
      };

      await route.handler(ctx);

      expect(mockRes.writeHead).toHaveBeenCalledWith(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      expect(mockRes.write).toHaveBeenCalledWith(
        expect.stringContaining('"type":"agent.run.tool_end"'),
      );
      expect(mockRes.write).toHaveBeenCalledWith(
        expect.stringContaining('"replayed":true'),
      );
      expect(mockRes.write).toHaveBeenCalledWith(
        expect.stringContaining('"type":"agent.run.completed"'),
      );
      expect(mockRes.end).toHaveBeenCalled();
    });

    it("subscribes to event emitter for active runs", async () => {
      const run = createStubRun({ status: "executing" });
      stubDeps.getRun = vi.fn().mockReturnValue(run);
      const emitter = createStubEventEmitter();
      stubDeps.eventEmitter = emitter;
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.events")!;

      const mockRes = {
        writeHead: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
      };

      const ctx = {
        body: null,
        params: { runId: "run-1" },
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
        _raw: mockRes,
      };

      await route.handler(ctx);

      // Should subscribe to 11 event types (9 run events + 2 subagent events)
      expect(emitter.on).toHaveBeenCalledTimes(11);
      // Should register close handler
      expect(mockRes.on).toHaveBeenCalledWith("close", expect.any(Function));
    });

    it("replays persisted events before subscribing for active runs", async () => {
      const run = createStubRun({ status: "executing" });
      stubDeps.getRun = vi.fn().mockReturnValue(run);
      stubDeps.listRunEvents = vi.fn().mockReturnValue([
        {
          eventId: "evt-1",
          runId: "run-1",
          seq: 7,
          eventName: "agent.run.tool_start",
          payload: {
            runId: "run-1",
            toolName: "provider",
            toolCallId: "call-7",
          },
          emittedAt: "2026-01-01T00:00:07.000Z",
          createdAt: "2026-01-01T00:00:07.000Z",
        },
      ]);
      const emitter = createStubEventEmitter();
      stubDeps.eventEmitter = emitter;
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.events")!;

      const mockRes = {
        writeHead: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
      };

      const ctx = {
        body: null,
        params: { runId: "run-1" },
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
        _raw: mockRes,
      };

      await route.handler(ctx);

      expect(stubDeps.listRunEvents).toHaveBeenCalledWith("run-1", 0);
      expect(mockRes.write).toHaveBeenCalledWith(
        expect.stringContaining('"seq":7'),
      );
      expect(mockRes.write).toHaveBeenCalledWith(
        expect.stringContaining('"replayed":true'),
      );
      expect(emitter.on).toHaveBeenCalledTimes(11);
    });
  });

  describe("automation schedule validation", () => {
    it("accepts cron schedule on create", async () => {
      const save = vi.fn().mockReturnValue(
        createAutomationStub({
          schedule: { type: "cron", cron: "0 9 * * *", timezone: "UTC" },
        }),
      );
      stubDeps.automationService.save = save;

      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.automations.create")!;
      const ctx = {
        body: {
          name: "Daily digest",
          taskTemplate: "send digest",
          schedule: { type: "cron", cron: "0 9 * * *", timezone: "UTC" },
        },
        params: {},
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };

      await route.handler(ctx);

      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          schedule: { type: "cron", cron: "0 9 * * *", timezone: "UTC" },
        }),
      );
    });

    it("rejects invalid cron schedule on create", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.automations.create")!;
      const ctx = {
        body: {
          name: "Broken",
          taskTemplate: "task",
          schedule: { type: "cron", cron: "invalid cron" },
        },
        params: {},
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };

      await expect(route.handler(ctx)).rejects.toThrow("schedule.cron is not a valid cron expression");
    });

    it("allows clearing schedule on update", async () => {
      const update = vi.fn().mockReturnValue(createAutomationStub({ schedule: undefined }));
      stubDeps.automationService.update = update;

      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.automations.update")!;
      const ctx = {
        body: { schedule: null },
        params: { automationId: "auto-1" },
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };

      await route.handler(ctx);

      expect(update).toHaveBeenCalledWith("auto-1", expect.objectContaining({ schedule: null }));
    });
  });
});

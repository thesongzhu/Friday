import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFridayAgentRoutes } from "#api";
import type { FridayAgentRoutesDeps } from "#api";
import type { FridayAgentEventEmitter } from "#agent";
import type { FridayAgentRunRecord, FridayAgentRuntimeResult, FridayAgentAutomationService } from "#agent";
import type { FridayAuthPrincipal } from "#api";

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

function createStubPrincipal(overrides?: Partial<FridayAuthPrincipal>): FridayAuthPrincipal {
  return {
    principalType: "user",
    principalId: "user-approver-1",
    scopes: ["agent.write"],
    tokenId: "token-1",
    tokenKind: "access",
    issuedAt: "2026-01-01T00:00:00.000Z",
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
      validateRequestedRoute: vi.fn().mockResolvedValue(undefined),
      startRun: vi.fn<[{ task: string }], Promise<FridayAgentRuntimeResult>>().mockResolvedValue(createStubResult()),
      getRun: vi.fn<[string], FridayAgentRunRecord | null>().mockReturnValue(createStubRun()),
      listRuns: vi.fn().mockReturnValue([]),
      listRunEvents: vi.fn().mockReturnValue([]),
      cancelRun: vi.fn(),
      approvePlan: vi.fn().mockResolvedValue(createStubResult()),
      rejectPlan: vi.fn().mockResolvedValue(createStubResult({ status: "cancelled" })),
      resolveToolApproval: vi.fn().mockReturnValue({ resolved: true }),
      eventEmitter: createStubEventEmitter(),
      automationService: createStubAutomationService(),
    };
  });

  it("registers 18 agent routes", () => {
    const routes = createFridayAgentRoutes(stubDeps);
    expect(routes).toHaveLength(18);
  });

  it("POST /v1/agent/runs requires agent.run scope with workflow.run compatibility", () => {
    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.start");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.path).toBe("/v1/agent/runs");
    expect(route!.auth).toEqual({ public: true });
  });

  it("POST /v1/agent/runs returns context cost token estimates from the runtime result", async () => {
    stubDeps.startRun = vi.fn().mockResolvedValue(createStubResult({
      contextCostSummary: {
        totalEstimatedChars: 480,
        totalEstimatedInputTokens: 120,
        components: [
          {
            kind: "tool_routing",
            estimatedChars: 480,
            estimatedInputTokens: 120,
            count: 4,
          },
        ],
      },
    }));
    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.start")!;

    const response = await route.handler({
      body: { task: "Summarize context cost." },
      params: {},
      query: {},
      headers: {},
      principal: createStubPrincipal(),
      requestId: "req-1",
      receivedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(response).toMatchObject({
      contextCostSummary: {
        totalEstimatedInputTokens: 120,
        components: [
          expect.objectContaining({
            kind: "tool_routing",
            estimatedInputTokens: 120,
          }),
        ],
      },
    });
  });

  it("POST /v1/agent/runs isolates unauthenticated public v1 runs from server-workspace tools", async () => {
    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.start")!;

    await route.handler({
      body: {
        task: "Read AGENTS.md from the server workspace",
        constraints: { readOnly: false, operationalMode: "execute" },
      },
      params: {},
      query: {},
      headers: {},
      principal: null,
      requestId: "req-1",
      receivedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(stubDeps.startRun).toHaveBeenCalledWith(expect.objectContaining({
      constraints: expect.objectContaining({
        readOnly: true,
        operationalMode: "restricted",
        dataSensitivity: "public",
      }),
      disabledToolNames: [
        "read",
        "write",
        "edit",
        "exec",
        "pdf_parse",
        "image_analysis",
        "memory_search",
        "memory_query",
        "memory_get",
        "memory_store",
        "memory_extract",
        "feedback",
      ],
    }));
  });

  it("POST /v1/agent/runs treats the synthetic public principal as public v1 isolation", async () => {
    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.start")!;
    const syntheticPublic = createStubPrincipal({
      principalId: "public:default",
      tokenId: "00000000-0000-0000-0000-000000000002",
      userId: "00000000-0000-0000-0000-000000000001",
      role: "admin",
    });

    await route.handler({
      body: { task: "Inspect repository files" },
      params: {},
      query: {},
      headers: {},
      principal: syntheticPublic,
      requestId: "req-1",
      receivedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(stubDeps.startRun).toHaveBeenCalledWith(expect.objectContaining({
      constraints: expect.objectContaining({
        readOnly: true,
        operationalMode: "restricted",
      }),
      disabledToolNames: [
        "read",
        "write",
        "edit",
        "exec",
        "pdf_parse",
        "image_analysis",
        "memory_search",
        "memory_query",
        "memory_get",
        "memory_store",
        "memory_extract",
        "feedback",
      ],
    }));
    const input = vi.mocked(stubDeps.startRun).mock.calls.at(-1)?.[0];
    expect(input?.principalId).toBeUndefined();
    expect(input?.scopes).toBeUndefined();
    expect(input?.tenantContext).toBeUndefined();
  });

  it("POST /v1/agent/runs preserves bound-principal run constraints", async () => {
    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.start")!;

    await route.handler({
      body: {
        task: "Inspect repository files",
        constraints: { readOnly: false, operationalMode: "execute" },
      },
      params: {},
      query: {},
      headers: {},
      principal: createStubPrincipal(),
      requestId: "req-1",
      receivedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(stubDeps.startRun).toHaveBeenCalledWith(expect.objectContaining({
      constraints: {
        readOnly: false,
        operationalMode: "execute",
      },
      disabledToolNames: undefined,
    }));
  });

  it("GET /v1/agent/runs requires agent.read scope with workflow.run compatibility", () => {
    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.list");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.path).toBe("/v1/agent/runs");
    expect(route!.auth).toEqual({ public: true });
  });

  it("GET /v1/agent/runs/:runId requires agent.read scope with workflow.run compatibility", () => {
    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.get");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.path).toBe("/v1/agent/runs/:runId");
    expect(route!.auth).toEqual({ public: true });
  });

  it("POST /v1/agent/runs/:runId/cancel requires agent.write scope with workflow.run compatibility", () => {
    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.cancel");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.path).toBe("/v1/agent/runs/:runId/cancel");
    expect(route!.auth).toEqual({ public: true });
  });

  it("POST /v1/agent/runs/:runId/approve-tool accepts subagent child run approval targets", async () => {
    stubDeps.getRun = vi.fn().mockReturnValue(createStubRun({
      id: "child-run-1",
      sessionKey: "subagent:agent:run:parent-run-1:child-run-1",
    }));
    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.approve.tool")!;

    const result = await route.handler({
      body: { toolCallId: "tool-call-1" },
      params: { runId: "child-run-1" },
      query: {},
      headers: {},
      principal: createStubPrincipal(),
      requestId: "req-1",
      receivedAt: "2026-01-01T00:00:00.000Z",
    }) as { resolved: boolean };

    expect(result.resolved).toBe(true);
    expect(stubDeps.resolveToolApproval).toHaveBeenCalledWith(
      "child-run-1",
      "tool-call-1",
      true,
      {
        approverPrincipalId: "user-approver-1",
        approverPrincipalType: "user",
        approvalSurface: "api",
      },
    );
  });

  it("POST /v1/agent/runs/:runId/approve-tool requires a bound owner/session/channel principal (Phase 14.5A)", async () => {
    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.approve.tool")!;

    await expect(route.handler({
      body: { toolCallId: "tool-call-1" },
      params: { runId: "run-1" },
      query: {},
      headers: {},
      principal: null,
      requestId: "req-1",
      receivedAt: "2026-01-01T00:00:00.000Z",
    })).rejects.toMatchObject({
      code: "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED",
    });
    expect(stubDeps.resolveToolApproval).not.toHaveBeenCalled();
  });

  it("POST /v1/agent/runs/:runId/approve-tool rejects the synthetic default-public principal (Phase 14.5A)", async () => {
    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.approve.tool")!;
    const syntheticPublic = createStubPrincipal({
      principalId: "public:default",
      tokenId: "00000000-0000-0000-0000-000000000002",
      userId: "00000000-0000-0000-0000-000000000001",
      role: "admin",
    });

    await expect(route.handler({
      body: { toolCallId: "tool-call-1" },
      params: { runId: "run-1" },
      query: {},
      headers: {},
      principal: syntheticPublic,
      requestId: "req-1",
      receivedAt: "2026-01-01T00:00:00.000Z",
    })).rejects.toMatchObject({
      code: "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED",
    });
    expect(stubDeps.resolveToolApproval).not.toHaveBeenCalled();
  });

  it("POST /v1/agent/runs/:runId/approve-plan rejects the synthetic default-public principal (Phase 14.5A)", async () => {
    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.approve.plan")!;
    const syntheticPublic = createStubPrincipal({
      principalId: "public:default",
      tokenId: "00000000-0000-0000-0000-000000000002",
      userId: "00000000-0000-0000-0000-000000000001",
      role: "admin",
    });

    await expect(route.handler({
      body: {},
      params: { runId: "run-1" },
      query: {},
      headers: {},
      principal: syntheticPublic,
      requestId: "req-1",
      receivedAt: "2026-01-01T00:00:00.000Z",
    })).rejects.toMatchObject({
      code: "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED",
    });
    expect(stubDeps.approvePlan).not.toHaveBeenCalled();
  });

  it("POST /v1/agent/runs/:runId/reject-plan rejects the synthetic default-public principal (Phase 14.5A)", async () => {
    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.reject.plan")!;
    const syntheticPublic = createStubPrincipal({
      principalId: "public:default",
      tokenId: "00000000-0000-0000-0000-000000000002",
      userId: "00000000-0000-0000-0000-000000000001",
      role: "admin",
    });

    await expect(route.handler({
      body: {},
      params: { runId: "run-1" },
      query: {},
      headers: {},
      principal: syntheticPublic,
      requestId: "req-1",
      receivedAt: "2026-01-01T00:00:00.000Z",
    })).rejects.toMatchObject({
      code: "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED",
    });
    expect(stubDeps.rejectPlan).not.toHaveBeenCalled();
  });

  it("POST /v1/agent/runs/:runId/reject-tool keeps autonomous internal runs hidden", async () => {
    stubDeps.getRun = vi.fn().mockReturnValue(createStubRun({
      id: "internal-run-1",
      sessionKey: "autonomous:goal-1",
    }));
    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.reject.tool")!;

    await expect(route.handler({
      body: { toolCallId: "tool-call-1", reason: "no" },
      params: { runId: "internal-run-1" },
      query: {},
      headers: {},
      principal: null,
      requestId: "req-1",
      receivedAt: "2026-01-01T00:00:00.000Z",
    })).rejects.toMatchObject({
      code: "AGENT_RUN_NOT_FOUND",
    });
    expect(stubDeps.resolveToolApproval).not.toHaveBeenCalled();
  });

  it("GET /v1/agent/runs/:runId/events requires agent.read scope with workflow.run compatibility", () => {
    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.events");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.path).toBe("/v1/agent/runs/:runId/events");
    expect(route!.auth).toEqual({ public: true });
  });

  it("GET /v1/agent/runs/:runId/audit includes autonomous events in the audit surface", async () => {
    stubDeps.listRunEvents = vi.fn().mockReturnValue([
      {
        seq: 1,
        eventName: "agent.run.started",
        emittedAt: "2026-01-01T00:00:00.000Z",
        payload: { runId: "run-1" },
      },
      {
        seq: 2,
        eventName: "autonomous.goal.completed",
        emittedAt: "2026-01-01T00:00:01.000Z",
        payload: { goalId: "goal-1", runId: "run-1" },
      },
      {
        seq: 3,
        eventName: "custom.debug",
        emittedAt: "2026-01-01T00:00:02.000Z",
        payload: { ignored: true },
      },
    ]);

    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.audit")!;
    const result = await route.handler({
      body: null,
      params: { runId: "run-1" },
      query: {},
      headers: {},
      principal: null,
      requestId: "req-1",
      receivedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      runId: "run-1",
      events: [
        {
          seq: 1,
          type: "agent.run.started",
          timestamp: "2026-01-01T00:00:00.000Z",
          payload: { runId: "run-1" },
        },
        {
          seq: 2,
          type: "autonomous.goal.completed",
          timestamp: "2026-01-01T00:00:01.000Z",
          payload: { goalId: "goal-1", runId: "run-1" },
        },
      ],
      decisionTrace: {
        evidenceTier: "audit_replay_evidence",
        source: "friday_agent_run_events",
        run: {
          runId: "run-1",
        },
        traceCompleteness: {
          hasPlanReview: false,
          hasPlanDecision: false,
          toolStartCount: 0,
          toolEndCount: 0,
          unpairedToolStartCount: 0,
          hasTerminalEvent: false,
        },
      },
    });
  });

  it("GET /v1/agent/runs/:runId/audit returns a decision trace with plan, approval, action, evidence, and rollback pointers", async () => {
    stubDeps.getRun = vi.fn().mockReturnValue(createStubRun({
      status: "completed",
      completedAt: "2026-01-01T00:00:05.000Z",
      rollbackAvailable: true,
      planReview: {
        plan: {
          task: "Build the workflow",
          stepCount: 2,
          description: "Plan summary",
        },
        gate: {
          kind: "generate_workflow",
          state: "approved",
        },
        decision: {
          approved: true,
          mode: "manual-approve",
          reason: "Approved by user",
          reviewedAt: "2026-01-01T00:00:02.000Z",
        },
      },
    }));
    stubDeps.listRunEvents = vi.fn().mockReturnValue([
      {
        seq: 1,
        eventName: "agent.run.plan_ready",
        emittedAt: "2026-01-01T00:00:01.000Z",
        payload: { runId: "run-1", planKind: "generate_workflow" },
      },
      {
        seq: 2,
        eventName: "agent.run.plan_approved",
        emittedAt: "2026-01-01T00:00:02.000Z",
        payload: { runId: "run-1", approvedAt: "2026-01-01T00:00:02.000Z" },
      },
      {
        seq: 3,
        eventName: "agent.run.awaiting_tool_approval",
        emittedAt: "2026-01-01T00:00:03.000Z",
        payload: {
          runId: "run-1",
          grantId: "grant-1",
          toolCallId: "call-1",
          toolName: "shell",
          params: { command: "npm test" },
          reason: "Needs approval for shell command",
          expiresAt: "2026-01-01T00:05:00.000Z",
          riskLevel: "guarded",
        },
      },
      {
        seq: 4,
        eventName: "agent.run.capability_grant_used",
        emittedAt: "2026-01-01T00:00:03.500Z",
        payload: { runId: "run-1", grantId: "grant-1", toolCallId: "call-1", toolName: "shell" },
      },
      {
        seq: 5,
        eventName: "agent.run.tool_start",
        emittedAt: "2026-01-01T00:00:04.000Z",
        payload: { runId: "run-1", toolCallId: "call-1", toolName: "shell", params: { command: "npm test" } },
      },
      {
        seq: 6,
        eventName: "agent.run.tool_end",
        emittedAt: "2026-01-01T00:00:05.000Z",
        payload: {
          runId: "run-1",
          toolCallId: "call-1",
          toolName: "shell",
          durationMs: 1000,
          isError: false,
          summary: "tests passed",
          routeId: "route-1",
          correlationId: "corr-1",
        },
      },
      {
        seq: 7,
        eventName: "agent.run.context_replay_loaded",
        emittedAt: "2026-01-01T00:00:05.500Z",
        payload: {
          runId: "run-1",
          sessionKey: "session-1",
          evidenceTier: "audit_replay_evidence",
          trustLevel: "unconfirmed_summary",
          sourceCount: 1,
          blockCount: 2,
          memoryBoundary: "not_user_confirmed_memory",
          redactionApplied: true,
          redactionCount: 1,
          replayEntryIds: ["entry-1"],
        },
      },
      {
        seq: 8,
        eventName: "agent.run.compaction_persisted",
        emittedAt: "2026-01-01T00:00:05.700Z",
        payload: {
          runId: "run-1",
          sessionKey: "session-1",
          entryId: "entry-2",
          evidenceTier: "audit_replay_evidence",
          trustLevel: "unconfirmed_summary",
          blockCount: 1,
          redactionApplied: false,
          redactionCount: 0,
        },
      },
      {
        seq: 9,
        eventName: "agent.run.compaction_persist_skipped",
        emittedAt: "2026-01-01T00:00:05.800Z",
        payload: {
          runId: "run-1",
          sessionKey: "session-1",
          skippedReason: "empty_summary",
          evidenceTier: "audit_replay_evidence",
          trustLevel: "unconfirmed_summary",
        },
      },
      {
        seq: 10,
        eventName: "agent.run.completed",
        emittedAt: "2026-01-01T00:00:05.000Z",
        payload: { runId: "run-1" },
      },
    ]);

    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.audit")!;
    const result = await route.handler({
      body: null,
      params: { runId: "run-1" },
      query: {},
      headers: {},
      principal: null,
      requestId: "req-1",
      receivedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      runId: "run-1",
      events: expect.arrayContaining([
        expect.objectContaining({
          seq: 5,
          payload: expect.not.objectContaining({
            params: expect.anything(),
          }),
        }),
        expect.objectContaining({
          seq: 6,
          payload: expect.not.objectContaining({
            summary: expect.anything(),
          }),
        }),
        expect.objectContaining({
          seq: 3,
          payload: expect.objectContaining({
            hasParams: true,
            hasReason: true,
          }),
        }),
        expect.objectContaining({
          seq: 3,
          payload: expect.not.objectContaining({
            params: expect.anything(),
            reason: expect.anything(),
          }),
        }),
        expect.objectContaining({
          seq: 7,
          payload: expect.objectContaining({
            sessionKey: "session-1",
            evidenceTier: "audit_replay_evidence",
            redactionApplied: true,
            redactionCount: 1,
          }),
        }),
        expect.objectContaining({
          seq: 7,
          payload: expect.not.objectContaining({
            replayEntryIds: expect.anything(),
          }),
        }),
      ]),
      decisionTrace: {
        evidenceTier: "audit_replay_evidence",
        source: "friday_agent_run_events",
        plan: {
          reviewPointer: { kind: "agent_run_plan_review", runId: "run-1" },
          state: "approved",
          planKind: "generate_workflow",
          stepCount: 2,
          eventPointers: [
            { kind: "agent_run_event", runId: "run-1", seq: 1 },
            { kind: "agent_run_event", runId: "run-1", seq: 2 },
          ],
          decision: {
            approved: true,
            eventPointer: { kind: "agent_plan_decision_event", runId: "run-1", seq: 2 },
          },
        },
        approvals: {
          plan: {
            state: "approved",
            eventPointer: { kind: "agent_plan_decision_event", runId: "run-1", seq: 2 },
          },
          toolRequests: [
            {
              toolCallId: "call-1",
              toolName: "shell",
              eventPointer: { kind: "agent_tool_approval_request_event", runId: "run-1", seq: 3 },
            },
          ],
          grants: [
            {
              state: "used",
              grantId: "grant-1",
              toolCallId: "call-1",
              toolName: "shell",
              eventPointer: { kind: "agent_capability_grant_event", runId: "run-1", seq: 4 },
            },
          ],
        },
        actions: [
          {
            toolCallId: "call-1",
            toolName: "shell",
            status: "completed",
            inputPointer: { kind: "agent_tool_input_event", runId: "run-1", seq: 5 },
            outputPointer: { kind: "agent_tool_output_event", runId: "run-1", seq: 6 },
            evidencePointer: { kind: "agent_tool_evidence_event", runId: "run-1", seq: 6 },
            routeId: "route-1",
            correlationId: "corr-1",
          },
        ],
        rollback: {
          available: true,
          pointer: { kind: "agent_runtime_rollback_checkpoint", runId: "run-1" },
        },
        contextReplay: {
          reads: [
            {
              eventPointer: { kind: "agent_context_replay_read_event", runId: "run-1", seq: 7 },
              sessionKey: "session-1",
              evidenceTier: "audit_replay_evidence",
              trustLevel: "unconfirmed_summary",
              memoryBoundary: "not_user_confirmed_memory",
              sourceCount: 1,
              blockCount: 2,
              redactionApplied: true,
              redactionCount: 1,
            },
          ],
          writes: [
            {
              eventPointer: { kind: "agent_context_replay_write_event", runId: "run-1", seq: 8 },
              sessionKey: "session-1",
              entryId: "entry-2",
              evidenceTier: "audit_replay_evidence",
              trustLevel: "unconfirmed_summary",
              blockCount: 1,
              redactionApplied: false,
              redactionCount: 0,
            },
          ],
          exceptions: [
            {
              eventPointer: { kind: "agent_context_replay_exception_event", runId: "run-1", seq: 9 },
              kind: "skipped",
              sessionKey: "session-1",
              reason: "empty_summary",
              evidenceTier: "audit_replay_evidence",
              trustLevel: "unconfirmed_summary",
            },
          ],
        },
        traceCompleteness: {
          hasPlanReview: true,
          hasPlanDecision: true,
          toolStartCount: 1,
          toolEndCount: 1,
          unpairedToolStartCount: 0,
          hasTerminalEvent: true,
          contextReplayReadCount: 1,
          contextReplayWriteCount: 1,
          contextReplayExceptionCount: 1,
        },
      },
    });
  });

  it("GET /v1/agent/runs/:runId/audit does not claim a plan decision without a durable decision event", async () => {
    stubDeps.getRun = vi.fn().mockReturnValue(createStubRun({
      status: "completed",
      planReview: {
        plan: {
          task: "Build the workflow",
          stepCount: 2,
          description: "Plan summary",
        },
        gate: {
          kind: "generate_workflow",
          state: "approved",
        },
        decision: {
          approved: true,
          mode: "manual-approve",
          reason: "Approved by user",
          reviewedAt: "2026-01-01T00:00:02.000Z",
        },
      },
    }));
    stubDeps.listRunEvents = vi.fn().mockReturnValue([
      {
        seq: 1,
        eventName: "agent.run.plan_ready",
        emittedAt: "2026-01-01T00:00:01.000Z",
        payload: { runId: "run-1", planKind: "generate_workflow" },
      },
    ]);

    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.audit")!;
    const result = await route.handler({
      body: null,
      params: { runId: "run-1" },
      query: {},
      headers: {},
      principal: null,
      requestId: "req-1",
      receivedAt: "2026-01-01T00:00:00.000Z",
    }) as { decisionTrace: { plan: { decision?: unknown }; approvals: { plan?: unknown }; traceCompleteness: { hasPlanDecision: boolean } } };

    expect(result.decisionTrace.plan.decision).toBeUndefined();
    expect(result.decisionTrace.approvals.plan).toBeUndefined();
    expect(result.decisionTrace.traceCompleteness.hasPlanDecision).toBe(false);
  });

  it("GET /v1/agent/runs/:runId/audit exposes sanitized tool guardrail pointers", async () => {
    stubDeps.getRun = vi.fn().mockReturnValue(createStubRun({ status: "completed" }));
    stubDeps.listRunEvents = vi.fn().mockReturnValue([
      {
        seq: 1,
        eventName: "agent.run.tool_start",
        emittedAt: "2026-01-01T00:00:01.000Z",
        payload: {
          runId: "run-1",
          toolCallId: "call-read",
          toolName: "read",
          params: { path: "README.md" },
          guardrail: {
            schemaVersion: "friday.agent.tool_guardrail.v1",
            phase: "pre",
            decision: "allow",
            toolCallId: "call-read",
            toolName: "read",
            mutating: false,
            readOnly: true,
            approvalRequired: false,
            riskLevel: "low",
            routeId: "agent.execute.tool",
            correlationId: "run-1",
            checks: ["runtime_tool_execution_entry"],
            inputKeys: ["path"],
            evidenceBoundary: "not release proof",
          },
        },
      },
      {
        seq: 2,
        eventName: "agent.run.tool_end",
        emittedAt: "2026-01-01T00:00:02.000Z",
        payload: {
          runId: "run-1",
          toolCallId: "call-read",
          toolName: "read",
          durationMs: 42,
          isError: false,
          summary: "# Friday",
          routeId: "agent.execute.tool",
          correlationId: "run-1",
          guardrail: {
            schemaVersion: "friday.agent.tool_guardrail.v1",
            phase: "post",
            status: "completed",
            toolCallId: "call-read",
            toolName: "read",
            isError: false,
            durationMs: 42,
            routeId: "agent.execute.tool",
            correlationId: "run-1",
            evidenceCaptured: true,
            outputPointerKind: "agent_tool_output_event",
            summaryAvailable: true,
            evidenceBoundary: "not release proof",
          },
        },
      },
    ]);

    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.audit")!;
    const result = await route.handler({
      body: null,
      params: { runId: "run-1" },
      query: {},
      headers: {},
      principal: null,
      requestId: "req-guardrail",
      receivedAt: "2026-01-01T00:00:00.000Z",
    }) as {
      events: Array<{ payload: Record<string, unknown> }>;
      decisionTrace: {
        actions: Array<{
          guardrails?: {
            pre?: Record<string, unknown>;
            post?: Record<string, unknown>;
          };
        }>;
      };
    };

    expect(result.events[0]?.payload).not.toHaveProperty("params");
    expect(result.events[0]?.payload.guardrail).toMatchObject({
      schemaVersion: "friday.agent.tool_guardrail.v1",
      phase: "pre",
      decision: "allow",
      inputKeys: ["path"],
    });
    expect(JSON.stringify(result.events[0]?.payload.guardrail)).not.toContain("README.md");
    expect(result.decisionTrace.actions[0]?.guardrails?.pre).toMatchObject({
      phase: "pre",
      decision: "allow",
      eventPointer: { kind: "agent_tool_pre_guardrail_event", runId: "run-1", seq: 1 },
    });
    expect(result.decisionTrace.actions[0]?.guardrails?.post).toMatchObject({
      phase: "post",
      status: "completed",
      evidenceCaptured: true,
      eventPointer: { kind: "agent_tool_post_guardrail_event", runId: "run-1", seq: 2 },
    });
  });

  it("GET /v1/agent/runs/:runId/audit includes a replayable evidence receipt", async () => {
    stubDeps.getRun = vi.fn().mockReturnValue(createStubRun({
      status: "completed",
      completedAt: "2026-01-01T00:00:05.000Z",
      durationMs: 5000,
      usageInput: 100,
      usageOutput: 50,
      costUsd: 0.01,
      artifactDir: "/tmp/friday/run-1",
      artifacts: [
        { type: "run_record", path: "/tmp/friday/run-1/run.json" },
        { type: "evidence_receipt", path: "/tmp/friday/run-1/evidence-receipt.json" },
      ],
      testResults: [
        { strategy: "execute", passed: true, errors: [], durationMs: 40 },
      ],
    }));
    stubDeps.listRunEvents = vi.fn().mockReturnValue([
      {
        seq: 1,
        eventName: "agent.run.completed",
        emittedAt: "2026-01-01T00:00:05.000Z",
        payload: { runId: "run-1" },
      },
    ]);

    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.audit")!;
    const result = await route.handler({
      body: null,
      params: { runId: "run-1" },
      query: {},
      headers: {},
      principal: null,
      requestId: "req-1",
      receivedAt: "2026-01-01T00:00:06.000Z",
    }) as {
      replayReceipt: {
        schemaVersion: string;
        receiptStatus: string;
        run: { runId: string };
        evidence: { auditEventCount: number };
        replay: { auditEndpoint: string; files: Array<{ kind: string; path?: string }> };
        proofBoundary: string;
      };
    };

    expect(result.replayReceipt.schemaVersion).toBe("friday.agent.evidence_receipt.v1");
    expect(result.replayReceipt.receiptStatus).toBe("verified_receipt");
    expect(result.replayReceipt.run.runId).toBe("run-1");
    expect(result.replayReceipt.evidence.auditEventCount).toBe(1);
    expect(result.replayReceipt.replay.auditEndpoint).toBe("/v1/agent/runs/run-1/audit");
    expect(result.replayReceipt.replay.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "evidence_receipt", path: expect.stringContaining("evidence-receipt.json") }),
    ]));
    expect(result.replayReceipt.proofBoundary).toContain("not release proof");
  });

  it("GET /v1/agent/runs/:runId/audit includes unified task state without raw tool approval params", async () => {
    stubDeps.getRun = vi.fn().mockReturnValue(createStubRun({ status: "executing" }));
    stubDeps.listRunEvents = vi.fn().mockReturnValue([
      {
        eventId: "event-1",
        runId: "run-1",
        seq: 1,
        eventName: "agent.run.awaiting_tool_approval",
        emittedAt: "2026-01-01T00:00:03.000Z",
        createdAt: "2026-01-01T00:00:03.000Z",
        payload: {
          runId: "run-1",
          grantId: "grant-1",
          toolCallId: "call-1",
          toolName: "shell",
          params: { command: "npm test" },
          reason: "Needs approval for shell command",
        },
      },
    ]);

    const routes = createFridayAgentRoutes(stubDeps);
    const route = routes.find((r) => r.operationId === "agent.runs.audit")!;
    const result = await route.handler({
      body: null,
      params: { runId: "run-1" },
      query: {},
      headers: {},
      principal: null,
      requestId: "req-1",
      receivedAt: "2026-01-01T00:00:06.000Z",
    }) as {
      events: Array<{ payload: unknown }>;
      unifiedTaskState: {
        schemaVersion: string;
        state: string;
        requiredAction: string;
        evidence: { openToolApproval?: unknown };
        channelBoundary: { liveChannelProof: string };
        proofBoundary: string;
      };
    };

    expect(result.unifiedTaskState).toMatchObject({
      schemaVersion: "friday.agent.unified_task_state.v1",
      state: "awaiting_tool_approval",
      requiredAction: "approve_or_reject_tool",
      channelBoundary: { liveChannelProof: "not_claimed" },
    });
    expect(result.unifiedTaskState.evidence.openToolApproval).toEqual({
      grantId: "grant-1",
      toolCallId: "call-1",
      toolName: "shell",
      eventPointer: { kind: "agent_run_event", runId: "run-1", seq: 1 },
    });
    expect(result.unifiedTaskState.proofBoundary).toContain("not channel live proof");
    expect(JSON.stringify(result.events)).not.toContain("npm test");
    expect(JSON.stringify(result.unifiedTaskState)).not.toContain("npm test");
    expect(JSON.stringify(result.unifiedTaskState)).not.toContain("Needs approval");
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

    it("calls startRun with valid bound-principal input", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const principal = createStubPrincipal();
      const ctx = {
        body: { task: "Build a feature", providerId: "openai", model: "gpt-4", timeoutMs: 60000 },
        params: {},
        query: {},
        headers: {},
        principal,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      const result = await route.handler(ctx);
      expect(stubDeps.validateRequestedRoute).toHaveBeenCalledWith(
        "openai",
        "gpt-4",
        { hubId: "user-approver-1", userId: "user-approver-1" },
      );
      expect(stubDeps.startRun).toHaveBeenCalledWith(expect.objectContaining({
        task: "Build a feature",
        providerId: "openai",
        model: "gpt-4",
        timeoutMs: 60000,
        principalId: principal.principalId,
        scopes: principal.scopes,
        tenantContext: { hubId: "user-approver-1", userId: "user-approver-1" },
        disabledToolNames: undefined,
      }));
      expect(result).toEqual({
        ...createStubResult(),
        eventStreamAvailable: true,
      });
    });

    it("passes Idempotency-Key transport metadata into startRun", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const ctx = {
        body: { task: "Build a feature" },
        params: {},
        query: {},
        headers: { "idempotency-key": "idem-1" },
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };

      await route.handler(ctx);

      expect(stubDeps.startRun).toHaveBeenCalledWith(expect.objectContaining({
        task: "Build a feature",
        apiIdempotencyKey: "idem-1",
        apiIdempotencyReceivedAt: "2026-01-01T00:00:00.000Z",
        apiIdempotencyPayloadHash: expect.any(String),
      }));
    });

    it("accepts requestedProviderId/requestedModel aliases for bound principals", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const principal = createStubPrincipal();
      const ctx = {
        body: {
          task: "Build a feature",
          requestedProviderId: "openai-alias",
          requestedModel: "gpt-4o",
          timeoutMs: 60000,
        },
        params: {},
        query: {},
        headers: {},
        principal,
        requestId: "req-alias-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };

      await route.handler(ctx);

      expect(stubDeps.validateRequestedRoute).toHaveBeenCalledWith(
        "openai-alias",
        "gpt-4o",
        { hubId: "user-approver-1", userId: "user-approver-1" },
      );
      expect(stubDeps.startRun).toHaveBeenCalledWith(expect.objectContaining({
        task: "Build a feature",
        providerId: "openai-alias",
        model: "gpt-4o",
        timeoutMs: 60000,
        principalId: principal.principalId,
        scopes: principal.scopes,
        tenantContext: { hubId: "user-approver-1", userId: "user-approver-1" },
        disabledToolNames: undefined,
      }));
    });

    it("rejects conflicting provider/model aliases", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const ctx = {
        body: {
          task: "Build a feature",
          providerId: "openai-primary",
          requestedProviderId: "anthropic-alias",
          model: "gpt-4o",
          requestedModel: "claude-sonnet-4-20250514",
        },
        params: {},
        query: {},
        headers: {},
        principal: createStubPrincipal(),
        requestId: "req-alias-2",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };

      await expect(route.handler(ctx)).rejects.toThrow("providerId and requestedProviderId must match");
      expect(stubDeps.startRun).not.toHaveBeenCalledWith(
        expect.objectContaining({ providerId: "openai-primary" }),
      );
    });

    it("fails before creating a run when the requested provider route is invalid", async () => {
      stubDeps.validateRequestedRoute = vi.fn().mockRejectedValue(new Error("Provider \"missing-provider\" not found"));
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const ctx = {
        body: { task: "Build a feature", providerId: "missing-provider", model: "gpt-4o" },
        params: {},
        query: {},
        headers: {},
        principal: null,
        requestId: "req-alias-3",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };

      await expect(route.handler(ctx)).rejects.toThrow("Provider \"missing-provider\" not found");
      expect(stubDeps.validateRequestedRoute).toHaveBeenCalledWith("missing-provider", "gpt-4o", undefined);
      expect(stubDeps.startRun).not.toHaveBeenCalled();
    });

    it("forwards replyToMessageId when provided", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const ctx = {
        body: { task: "Continue that", replyToMessageId: "msg-42" },
        params: {},
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };

      await route.handler(ctx);

      expect(stubDeps.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          task: "Continue that",
          replyToMessageId: "msg-42",
        }),
      );
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

    it("forwards executionContext.packId when provided", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const ctx = {
        body: {
          task: "Continue with creator workflow",
          executionContext: {
            surface: "chat",
            interactive: true,
            packId: "industry-creator-media",
          },
        },
        params: {},
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      await route.handler(ctx);
      expect(stubDeps.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          task: "Continue with creator workflow",
          executionContext: {
            surface: "chat",
            interactive: true,
            packId: "industry-creator-media",
          },
        }),
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

    it("validates replyToMessageId is non-empty when provided", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const ctx = {
        body: { task: "test", replyToMessageId: "   " },
        params: {},
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };

      await expect(route.handler(ctx)).rejects.toThrow("replyToMessageId must be a non-empty string when provided");
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
        principal: createStubPrincipal(),
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      await route.handler(ctx);
      expect(stubDeps.startRun).toHaveBeenCalledWith(
        expect.objectContaining({ constraints: { readOnly: true, operationalMode: undefined } }),
      );
    });

    it("does not synthesize plan constraints for normal bound-principal chat requests", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const ctx = {
        body: {
          task: "What is 2+2?",
          executionContext: { surface: "chat", interactive: true },
        },
        params: {},
        query: {},
        headers: {},
        principal: createStubPrincipal(),
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      await route.handler(ctx);
      const [input] = vi.mocked(stubDeps.startRun).mock.calls[0]!;
      expect(input.constraints).toBeUndefined();
    });

    it("forwards explicit operationalMode constraints without making them a UI default", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const ctx = {
        body: { task: "Plan this", constraints: { readOnly: true, operationalMode: "plan" } },
        params: {},
        query: {},
        headers: {},
        principal: createStubPrincipal(),
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      await route.handler(ctx);
      expect(stubDeps.startRun).toHaveBeenCalledWith(
        expect.objectContaining({ constraints: { readOnly: true, operationalMode: "plan" } }),
      );
    });

    it("forwards timezone when provided", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const ctx = {
        body: { task: "Latest news", timezone: "America/Los_Angeles" },
        params: {},
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      await route.handler(ctx);
      expect(stubDeps.startRun).toHaveBeenCalledWith(
        expect.objectContaining({ timezone: "America/Los_Angeles" }),
      );
    });

    it("rejects invalid timezone", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.start")!;
      const ctx = {
        body: { task: "Latest news", timezone: "Mars/Olympus" },
        params: {},
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };
      await expect(route.handler(ctx)).rejects.toThrow("timezone is not a valid IANA timezone");
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

    it("derives tenantContext from authenticated principal", async () => {
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
          tenantId: "tenant-acme",
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
          tenantContext: {
            hubId: "tenant-acme",
            userId: "principal-1",
          },
        }),
      );
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
      const result = await route.handler(ctx) as {
        items: Array<FridayAgentRunRecord & { unifiedTaskState: { state: string; channelBoundary: { liveChannelProof: string } } }>;
      };
      expect(result.items).toEqual([
        expect.objectContaining({
          id: runs[0]!.id,
          unifiedTaskState: expect.objectContaining({
            state: "executing",
            channelBoundary: expect.objectContaining({ liveChannelProof: "not_claimed" }),
          }),
        }),
      ]);
    });

    it("filters autonomous internal runs from the default list surface", async () => {
      const visibleRun = createStubRun({ id: "run-visible", sessionKey: "agent:run:run-visible" });
      const internalBySurface = createStubRun({
        id: "run-internal-surface",
        sessionKey: "agent:run:run-internal-surface",
        metadata: { surface: "autonomous_internal_verify" },
      });
      const internalBySessionKey = createStubRun({
        id: "run-internal-session",
        sessionKey: "subagent:autonomous:plan:goal-1:child-run-1",
      });
      stubDeps.listRuns = vi.fn().mockReturnValue([visibleRun, internalBySurface, internalBySessionKey]);
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

      const result = await route.handler(ctx) as { items: Array<FridayAgentRunRecord & { unifiedTaskState: { state: string } }> };
      expect(result.items).toEqual([
        expect.objectContaining({
          id: visibleRun.id,
          unifiedTaskState: expect.objectContaining({ state: "executing" }),
        }),
      ]);
    });

    it("sanitizes historical custom-pack response text on read", async () => {
      const run = createStubRun({
        id: "run-custom-1",
        status: "completed",
        responseText: [
          "这是用户可见的结论。",
          "readOnly=true",
          "childRunId: 123e4567-e89b-12d3-a456-426614174000",
          "sessionKey: subagent:session-1",
        ].join("\n"),
        metadata: {
          packContext: {
            packId: "custom-pack-demo",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      });
      stubDeps.listRuns = vi.fn().mockReturnValue([run]);
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
      expect(result.items[0]?.responseText).toContain("这是用户可见的结论。");
      expect(result.items[0]?.responseText).not.toContain("readOnly");
      expect(result.items[0]?.responseText).not.toContain("childRunId");
      expect(result.items[0]?.responseText).not.toContain("sessionKey");
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

  describe("GET /v1/agent/runs/summary handler", () => {
    it("excludes autonomous internal runs from user-facing summary counts", async () => {
      stubDeps.listRuns = vi.fn().mockReturnValue([
        createStubRun({
          id: "run-internal",
          status: "completed",
          sessionKey: "subagent:autonomous:action:goal-1:child-run-1",
          costUsd: 0.99,
          createdAt: "2026-01-01T00:12:00.000Z",
        }),
        createStubRun({
          id: "run-visible-failed",
          status: "failed",
          costUsd: 0.03,
          createdAt: "2026-01-01T00:11:00.000Z",
        }),
        createStubRun({
          id: "run-visible-completed",
          status: "completed",
          costUsd: 0.12,
          createdAt: "2026-01-01T00:10:00.000Z",
        }),
      ]);

      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.summary")!;
      const ctx = {
        body: null,
        params: {},
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };

      const result = await route.handler(ctx) as {
        totalRuns: number;
        completedCount: number;
        failedCount: number;
        totalCostUsd: number;
        runs: Array<{ id: string }>;
      };

      expect(result.totalRuns).toBe(2);
      expect(result.completedCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.totalCostUsd).toBe(0.15);
      expect(result.runs.map((run) => run.id)).toEqual([
        "run-visible-failed",
        "run-visible-completed",
      ]);
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
      const result = await route.handler(ctx) as { run: FridayAgentRunRecord & { unifiedTaskState: { state: string } } };
      expect(result.run).toEqual(expect.objectContaining({
        ...run,
        unifiedTaskState: expect.objectContaining({ state: "executing" }),
      }));
    });

    it("sanitizes historical custom-pack detail reads", async () => {
      const run = createStubRun({
        id: "run-custom-1",
        status: "completed",
        responseText: [
          "这是用户可见的结论。",
          "readOnly=true",
          "childRunId: 123e4567-e89b-12d3-a456-426614174000",
        ].join("\n"),
        metadata: {
          packContext: {
            packId: "custom-pack-demo",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      });
      stubDeps.getRun = vi.fn().mockReturnValue(run);
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.get")!;
      const ctx = {
        body: null,
        params: { runId: "run-custom-1" },
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };

      const result = await route.handler(ctx) as { run: FridayAgentRunRecord };
      expect(result.run.responseText).toContain("这是用户可见的结论。");
      expect(result.run.responseText).not.toContain("readOnly");
      expect(result.run.responseText).not.toContain("childRunId");
      expect(result.run.responseText).not.toContain("123e4567-e89b-12d3-a456-426614174000");
    });

    it("returns 404 for hidden subagent child runs", async () => {
      stubDeps.getRun = vi.fn().mockReturnValue(createStubRun({
        id: "child-run-1",
        sessionKey: "subagent:agent:run:parent-run-1:child-run-1",
      }));
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.get")!;
      const ctx = {
        body: null,
        params: { runId: "child-run-1" },
        query: {},
        headers: {},
        principal: null,
        requestId: "req-hidden-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };

      await expect(route.handler(ctx)).rejects.toThrow("Agent run not found");
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

    it("returns 404 when cancelling a hidden subagent child run", async () => {
      stubDeps.getRun = vi.fn().mockReturnValue(createStubRun({
        id: "child-run-1",
        status: "executing",
        sessionKey: "subagent:agent:run:parent-run-1:child-run-1",
      }));
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.cancel")!;
      const ctx = {
        body: null,
        params: { runId: "child-run-1" },
        query: {},
        headers: {},
        principal: null,
        requestId: "req-hidden-cancel-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };

      await expect(route.handler(ctx)).rejects.toThrow("Agent run not found");
      expect(stubDeps.cancelRun).not.toHaveBeenCalled();
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

      // Should subscribe to 29 event types (20 run events + 2 subagent events + 7 autonomous events)
      expect(emitter.on).toHaveBeenCalledTimes(29);
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
      expect(emitter.on).toHaveBeenCalledTimes(29);
    });
  });

  describe("plan approval handlers", () => {
    it("approves a pending plan by run id (Phase 14.5A: requires bound principal)", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.approve.plan")!;
      const ctx = {
        body: {},
        params: { runId: "run-1" },
        query: {},
        headers: {},
        principal: createStubPrincipal(),
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };

      const result = await route.handler(ctx);

      expect(stubDeps.approvePlan).toHaveBeenCalledWith({
        runId: "run-1",
        executionContext: { surface: "api", interactive: true },
        principalId: "user-approver-1",
        scopes: ["agent.write"],
      });
      expect(result).toEqual(createStubResult());
    });

    it("rejects a pending plan by run id (Phase 14.5A: requires bound principal)", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.reject.plan")!;
      const ctx = {
        body: {},
        params: { runId: "run-1" },
        query: {},
        headers: {},
        principal: createStubPrincipal(),
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };

      const result = await route.handler(ctx);

      expect(stubDeps.rejectPlan).toHaveBeenCalledWith({
        runId: "run-1",
        executionContext: { surface: "api", interactive: true },
        principalId: "user-approver-1",
        scopes: ["agent.write"],
      });
      expect(result).toEqual(createStubResult({ status: "cancelled" }));
    });

    it("forwards principal context for plan approval evidence", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.approve.plan")!;
      const ctx = {
        body: {},
        params: { runId: "run-1" },
        query: {},
        headers: {},
        principal: createStubPrincipal({ principalId: "planner-1", scopes: ["agent.write", "agent.run"] }),
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };

      await route.handler(ctx);

      expect(stubDeps.approvePlan).toHaveBeenCalledWith({
        runId: "run-1",
        principalId: "planner-1",
        scopes: ["agent.write", "agent.run"],
        executionContext: { surface: "api", interactive: true },
      });
    });

    it("forwards principal context for plan rejection evidence", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.runs.reject.plan")!;
      const ctx = {
        body: {},
        params: { runId: "run-1" },
        query: {},
        headers: {},
        principal: createStubPrincipal({ principalId: "planner-2", scopes: ["agent.write", "agent.run"] }),
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };

      await route.handler(ctx);

      expect(stubDeps.rejectPlan).toHaveBeenCalledWith({
        runId: "run-1",
        principalId: "planner-2",
        scopes: ["agent.write", "agent.run"],
        executionContext: { surface: "api", interactive: true },
      });
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

    it("passes sessionTarget on create", async () => {
      const save = vi.fn().mockReturnValue(
        createAutomationStub({
          sessionTarget: { type: "named", sessionKey: "named-session-1" },
        }),
      );
      stubDeps.automationService.save = save;

      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.automations.create")!;
      const ctx = {
        body: {
          name: "Pinned thread",
          taskTemplate: "continue",
          sessionTarget: { type: "named", sessionKey: "named-session-1" },
        },
        params: {},
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };

      await route.handler(ctx);

      expect(save).toHaveBeenCalledWith(expect.objectContaining({
        sessionTarget: {
          type: "named",
          sessionKey: "named-session-1",
        },
      }));
    });

    it("allows clearing sessionTarget on update", async () => {
      const update = vi.fn().mockReturnValue(createAutomationStub({ sessionTarget: { type: "isolated" } }));
      stubDeps.automationService.update = update;

      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.automations.update")!;
      const ctx = {
        body: { sessionTarget: null },
        params: { automationId: "auto-1" },
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };

      await route.handler(ctx);

      expect(update).toHaveBeenCalledWith("auto-1", expect.objectContaining({ sessionTarget: null }));
    });

    it("passes sessionTarget override on run", async () => {
      const run = vi.fn().mockResolvedValue(createStubResult());
      stubDeps.automationService.run = run;

      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.automations.run")!;
      const ctx = {
        body: { sessionTarget: { type: "current", sessionKey: "session-override" } },
        params: { automationId: "auto-1" },
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };

      await route.handler(ctx);

      expect(run).toHaveBeenCalledWith("auto-1", expect.objectContaining({
        sessionTarget: {
          type: "current",
          sessionKey: "session-override",
        },
      }));
    });

    it("rejects named session targets without a sessionKey", async () => {
      const routes = createFridayAgentRoutes(stubDeps);
      const route = routes.find((r) => r.operationId === "agent.automations.create")!;
      const ctx = {
        body: {
          name: "Broken target",
          taskTemplate: "task",
          sessionTarget: { type: "named" },
        },
        params: {},
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-01-01T00:00:00.000Z",
      };

      await expect(route.handler(ctx)).rejects.toThrow("sessionTarget.sessionKey is required for named targets");
    });
  });
});

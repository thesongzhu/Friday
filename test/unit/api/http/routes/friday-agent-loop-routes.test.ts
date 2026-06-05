import { describe, expect, it, vi } from "vitest";

import { createFridayAgentLoopRoutes } from "#api";
import type { FridayHttpContext } from "#api";
import type { FridayAgentLoopService } from "#learning/services/friday-agent-loop-service.js";
import { createFridayDefaultPublicHttpPrincipal } from "../../../../../src/api/http/friday-default-public-principal.js";

const NOW = "2026-03-07T10:00:00.000Z";

function makeCtx(
  overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {},
): FridayHttpContext<unknown, unknown, unknown> {
  return {
    requestId: "req-1",
    receivedAt: NOW,
    params: {},
    query: {},
    body: {},
    headers: {},
    principal: { userId: "user-1" } as never,
    ...overrides,
  };
}

function makeLoopRunRecord() {
  return {
    run: {
      loopRunId: "loop-run-1",
      userId: "user-1",
      incidentId: "incident-1",
      actionId: "action-1",
      fingerprint: "fp-1",
      trigger: "incident_opened" as const,
      status: "awaiting_approval" as const,
      riskTier: 2 as const,
      approvalRequired: true,
      attemptNumber: 1,
      rollbackAttempted: false,
      rollbackSucceeded: false,
      haltReason: "approval_required" as const,
      expertModeEnabled: true,
      riskClass: "bounded_repair" as const,
      requiresFinalApproval: true,
      assumptions: ["Friday will use the current workspace defaults."],
      unknowns: [],
      hypotheses: [],
      probeSteps: [],
      probeBudget: 4,
      objective: "Resolve the workflow incident safely.",
      planSummary: "Apply the planned fix and verify the workflow.",
      createdAt: NOW,
      updatedAt: NOW,
    },
    incident: {
      incident: {
        incidentId: "incident-1",
        userId: "user-1",
        ts: NOW,
        category: "workflow" as const,
        severity: "high" as const,
        signature: "workflow failed",
        context: {},
        autoFixEligible: true,
        status: "open" as const,
        createdAt: NOW,
        updatedAt: NOW,
      },
      diagnosis: {
        id: "diag-1",
        incidentId: "incident-1",
        errorFingerprint: "fp-1",
        confidence: 0.9,
        diagnosis: { summary: "workflow failed", suggestedFixes: [], matchedLessonIds: [] },
        createdAt: NOW,
        updatedAt: NOW,
      },
      lesson: null,
      action: null,
      recurrenceCount: 1,
      autoFixEligible: true,
    },
    action: {
      action: {
        actionId: "action-1",
        incidentId: "incident-1",
        userId: "user-1",
        riskTier: 2 as const,
        plan: {
          title: "Apply fix",
          summary: "Apply the planned fix",
          steps: [],
          evidence: {
            fingerprint: "fp-1",
            matchedLessonIds: [],
            diagnosisId: "diag-1",
            recurrenceCount: 1,
          },
        },
        status: "planned" as const,
        outcome: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      incident: null,
      diagnosis: null,
      approval: null,
      lesson: null,
      risk: {
        riskTier: 2 as const,
        reasons: ["approval required"],
        requiresApproval: true,
        autoApplyAllowed: false,
      },
      evidence: {
        rootCauseSummary: "workflow failed",
        selectedPlan: {
          title: "Apply fix",
          summary: "Apply the planned fix",
          stepCount: 0,
          rollbackPlanAvailable: true,
        },
        riskTier: 2 as const,
        executionResult: { status: "planned" as const, outcome: null, repairOutcome: "failed" as const },
        rollbackResult: { available: true, rollbackAttempted: false, rollbackSucceeded: false },
        acceptanceResult: { passed: false, reason: "Pending approval" },
      },
    },
  };
}

function makeService(): FridayAgentLoopService {
  const record = makeLoopRunRecord();
  return {
    getPolicy: vi.fn(() => ({
      id: "default",
      mode: "tiered_supervised" as const,
      paused: false,
      autoApplyLowRisk: true,
      maxAttemptsPerFingerprint: 3,
      cooldownMinutes: 30,
      requireRollbackPlan: true,
      requireAcceptanceCheck: true,
      expertModeEnabled: false,
      expertModeUserIds: [],
      expertModeWorkspaceIds: [],
      expertModeEnvironments: [],
      contextInferenceAllowed: true,
      multiStepHypothesisSearchAllowed: true,
      safeProbeExecutionAllowed: true,
      crossSurfaceOrchestrationAllowed: true,
      highRiskFinalApprovalRequired: true,
      productionDestructiveActionApprovalRequired: true,
      probeBudget: 4,
      timeBudgetMinutes: 20,
      updatedAt: NOW,
    })),
    updatePolicy: vi.fn((input) => ({
      id: "default",
      mode: "tiered_supervised" as const,
      paused: Boolean(input.paused),
      autoApplyLowRisk: true,
      maxAttemptsPerFingerprint: 3,
      cooldownMinutes: 30,
      requireRollbackPlan: true,
      requireAcceptanceCheck: true,
      expertModeEnabled: false,
      expertModeUserIds: [],
      expertModeWorkspaceIds: [],
      expertModeEnvironments: [],
      contextInferenceAllowed: true,
      multiStepHypothesisSearchAllowed: true,
      safeProbeExecutionAllowed: true,
      crossSurfaceOrchestrationAllowed: true,
      highRiskFinalApprovalRequired: true,
      productionDestructiveActionApprovalRequired: true,
      probeBudget: 4,
      timeBudgetMinutes: 20,
      updatedAt: NOW,
    })),
    getExpertMode: vi.fn(() => ({
      enabled: true,
      activeForCurrentRuntime: true,
      allowedUserIds: ["user-1"],
      allowedWorkspaceIds: [],
      allowedEnvironments: [],
      contextInferenceAllowed: true,
      multiStepHypothesisSearchAllowed: true,
      safeProbeExecutionAllowed: true,
      crossSurfaceOrchestrationAllowed: true,
      highRiskFinalApprovalRequired: true,
      productionDestructiveActionApprovalRequired: true,
      probeBudget: 4,
      timeBudgetMinutes: 20,
    })),
    updateExpertMode: vi.fn(() => ({
      enabled: true,
      activeForCurrentRuntime: true,
      allowedUserIds: ["user-1"],
      allowedWorkspaceIds: [],
      allowedEnvironments: [],
      contextInferenceAllowed: true,
      multiStepHypothesisSearchAllowed: true,
      safeProbeExecutionAllowed: true,
      crossSurfaceOrchestrationAllowed: true,
      highRiskFinalApprovalRequired: true,
      productionDestructiveActionApprovalRequired: true,
      probeBudget: 4,
      timeBudgetMinutes: 20,
    })),
    listRuns: vi.fn(() => [record as never]),
    listExpertRuns: vi.fn(() => [record as never]),
    getRun: vi.fn(({ loopRunId }: { loopRunId: string }) => loopRunId === "missing" ? null : (record as never)),
    getExpertRun: vi.fn(({ loopRunId }: { loopRunId: string }) => loopRunId === "missing" ? null : (record as never)),
    pauseRun: vi.fn(() => record as never),
    resumeRun: vi.fn(async () => record as never),
    cancelRun: vi.fn(() => record as never),
    handleProcessResults: vi.fn(async () => []),
    syncAction: vi.fn(async () => null),
    findRunByActionId: vi.fn(() => null),
    findRunByIncidentId: vi.fn(() => null),
  };
}

describe("FridayAgentLoopRoutes", () => {
  it("creates agent-loop route definitions", () => {
    const routes = createFridayAgentLoopRoutes({ service: makeService() });
    expect(routes).toHaveLength(11);
    expect(routes.map((route) => route.operationId)).toEqual([
      "agent.loop.expertmode.get",
      "agent.loop.expertmode.update",
      "agent.loop.policy.get",
      "agent.loop.policy.update",
      "agent.loop.runs.list",
      "agent.loop.expertruns.list",
      "agent.loop.runs.get",
      "agent.loop.expertruns.get",
      "agent.loop.runs.pause",
      "agent.loop.runs.resume",
      "agent.loop.runs.cancel",
    ]);
  });

  it("lists loop runs for the authenticated user", async () => {
    const service = makeService();
    const routes = createFridayAgentLoopRoutes({ service });
    const route = routes.find((entry) => entry.operationId === "agent.loop.runs.list")!;

    const result = await route.handler(makeCtx({ query: { status: "awaiting_approval", limit: "3" } })) as {
      items: Array<{ run: { loopRunId: string } }>;
    };

    expect(service.listRuns).toHaveBeenCalledWith({
      userId: "user-1",
      status: "awaiting_approval",
      limit: 3,
    });
    expect(result.items[0]?.run.loopRunId).toBe("loop-run-1");
  });

  it("returns 404 when a loop run does not exist", async () => {
    const routes = createFridayAgentLoopRoutes({ service: makeService() });
    const route = routes.find((entry) => entry.operationId === "agent.loop.runs.get")!;

    await expect(
      route.handler(makeCtx({ params: { loopRunId: "missing" } })),
    ).rejects.toMatchObject({ code: "AGENT_LOOP_RUN_NOT_FOUND" });
  });

  it("reads expert mode without mutating TypeScript policy state", async () => {
    const service = makeService();
    const routes = createFridayAgentLoopRoutes({ service });
    const getRoute = routes.find((entry) => entry.operationId === "agent.loop.expertmode.get")!;

    const getResult = await getRoute.handler(makeCtx()) as { expertMode: { enabled: boolean } };
    expect(getResult.expertMode.enabled).toBe(true);
    expect(service.updateExpertMode).not.toHaveBeenCalled();
  });

  it("fail-closes default agent-loop policy mutations before calling TypeScript services", async () => {
    const service = makeService();
    const routes = createFridayAgentLoopRoutes({ service });
    const updateRoutes = [
      ["agent.loop.expertmode.update", service.updateExpertMode, { enabled: true, probeBudget: 6 }],
      ["agent.loop.policy.update", service.updatePolicy, { paused: true }],
    ] as const;

    for (const [operationId, serviceCall, body] of updateRoutes) {
      const route = routes.find((entry) => entry.operationId === operationId)!;
      await expect(
        route.handler(makeCtx({ body })),
      ).rejects.toMatchObject({
        code: "TS_RUNTIME_AGENT_LOOP_POLICY_MUTATIONS_RETIRED",
        httpStatus: 503,
      });
      expect(serviceCall).not.toHaveBeenCalled();
    }
  });

  it("allows legacy agent-loop policy mutations only through explicit test-only oracle wiring", async () => {
    const service = makeService();
    const routes = createFridayAgentLoopRoutes({
      service,
      allowTestOnlyAgentLoopPolicyMutation: true,
    });
    const expertModeRoute = routes.find((entry) => entry.operationId === "agent.loop.expertmode.update")!;
    const policyRoute = routes.find((entry) => entry.operationId === "agent.loop.policy.update")!;

    const expertModeResult = await expertModeRoute.handler(makeCtx({
      body: {
        enabled: true,
        probeBudget: 6,
      },
    })) as { expertMode: { probeBudget: number } };

    expect(service.updateExpertMode).toHaveBeenCalledWith(
      expect.objectContaining({
        expertModeEnabled: true,
        probeBudget: 6,
      }),
    );
    expect(expertModeResult.expertMode.probeBudget).toBe(4);

    const policyResult = await policyRoute.handler(makeCtx({
      body: { paused: true },
    })) as { policy: { paused: boolean } };

    expect(service.updatePolicy).toHaveBeenCalledWith({ paused: true });
    expect(policyResult.policy.paused).toBe(true);
  });

  it("rejects synthetic public principals from expert mode routes", async () => {
    const service = makeService();
    const routes = createFridayAgentLoopRoutes({ service });
    const getRoute = routes.find((entry) => entry.operationId === "agent.loop.expertmode.get")!;
    const putRoute = routes.find((entry) => entry.operationId === "agent.loop.expertmode.update")!;
    const publicCtx = makeCtx({
      principal: createFridayDefaultPublicHttpPrincipal(),
      body: { enabled: true },
    });

    await expect(getRoute.handler(publicCtx)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      httpStatus: 401,
    });
    await expect(putRoute.handler(publicCtx)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      httpStatus: 401,
    });
    expect(service.getExpertMode).not.toHaveBeenCalled();
    expect(service.updateExpertMode).not.toHaveBeenCalled();
  });

  it("rejects synthetic public principals from policy update", async () => {
    const service = makeService();
    const routes = createFridayAgentLoopRoutes({ service });
    const putRoute = routes.find((entry) => entry.operationId === "agent.loop.policy.update")!;

    await expect(
      putRoute.handler(makeCtx({
        principal: createFridayDefaultPublicHttpPrincipal(),
        body: { paused: true },
      })),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      httpStatus: 401,
    });
    expect(service.updatePolicy).not.toHaveBeenCalled();
  });

  it("fail-closes default agent-loop run controls before calling TypeScript services", async () => {
    const service = makeService();
    const routes = createFridayAgentLoopRoutes({ service });
    const controlRoutes = [
      ["agent.loop.runs.pause", service.pauseRun],
      ["agent.loop.runs.resume", service.resumeRun],
      ["agent.loop.runs.cancel", service.cancelRun],
    ] as const;

    for (const [operationId, serviceCall] of controlRoutes) {
      const route = routes.find((entry) => entry.operationId === operationId)!;
      await expect(
        route.handler(makeCtx({ params: { loopRunId: "loop-run-1" } })),
      ).rejects.toMatchObject({
        code: "TS_RUNTIME_AGENT_LOOP_CONTROLS_RETIRED",
        httpStatus: 503,
      });
      expect(serviceCall).not.toHaveBeenCalled();
    }
  });

  it("allows legacy agent-loop run controls only through explicit test-only oracle wiring", async () => {
    const service = makeService();
    const routes = createFridayAgentLoopRoutes({
      service,
      allowTestOnlyAgentLoopRunControlExecution: true,
    });
    const route = routes.find((entry) => entry.operationId === "agent.loop.runs.pause")!;

    const result = await route.handler(makeCtx({ params: { loopRunId: "loop-run-1" } })) as {
      run: { run: { loopRunId: string } };
    };

    expect(service.pauseRun).toHaveBeenCalledWith({ loopRunId: "loop-run-1" });
    expect(result.run.run.loopRunId).toBe("loop-run-1");
  });
});

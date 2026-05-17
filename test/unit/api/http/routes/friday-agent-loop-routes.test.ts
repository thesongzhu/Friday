import { describe, expect, it, vi } from "vitest";

import { createFridayAgentLoopRoutes } from "#api";
import type { FridayHttpContext } from "#api";
import type { FridayAgentLoopService } from "#learning/services/friday-agent-loop-service.js";

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

  it("reads and updates expert mode", async () => {
    const service = makeService();
    const routes = createFridayAgentLoopRoutes({ service });
    const getRoute = routes.find((entry) => entry.operationId === "agent.loop.expertmode.get")!;
    const putRoute = routes.find((entry) => entry.operationId === "agent.loop.expertmode.update")!;

    const getResult = await getRoute.handler(makeCtx()) as { expertMode: { enabled: boolean } };
    expect(getResult.expertMode.enabled).toBe(true);

    const putResult = await putRoute.handler(makeCtx({
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
    expect(putResult.expertMode.probeBudget).toBe(4);
  });
});

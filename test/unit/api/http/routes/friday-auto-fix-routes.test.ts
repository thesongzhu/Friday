import { describe, expect, it, vi } from "vitest";
import { createFridayAutoFixRoutes } from "#api";
import type { FridayHttpContext } from "#api";
import type { FridaySelfHealingApiService } from "#learning";

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

function makeActionRecord() {
  return {
    action: {
      actionId: "action-1",
      incidentId: "incident-1",
      userId: "user-1",
      riskTier: 2,
      plan: {
        title: "Apply config patch",
        summary: "Patch the config and retry the failing workflow",
        steps: [],
        rollbackPlan: {
          summary: "Restore the previous config",
          steps: [],
        },
        evidence: {
          fingerprint: "fp-1",
          matchedLessonIds: ["lesson-1"],
          diagnosisId: "diagnosis-1",
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
    approval: {
      requestId: "approval-1",
      actionId: "action-1",
      userId: "user-1",
      description: "Approve the config patch",
      riskTier: 2 as const,
      plan: {
        title: "Apply config patch",
        summary: "Patch the config and retry the failing workflow",
        steps: [],
        evidence: {
          fingerprint: "fp-1",
          matchedLessonIds: ["lesson-1"],
          diagnosisId: "diagnosis-1",
          recurrenceCount: 1,
        },
      },
      requestedAt: NOW,
      expiresAt: NOW,
      status: "pending" as const,
      createdAt: NOW,
      updatedAt: NOW,
    },
    lesson: null,
    risk: {
      riskTier: 2 as const,
      reasons: ["Requires approval"],
      requiresApproval: true,
      autoApplyAllowed: false,
    },
    evidence: {
      rootCauseSummary: "Config patch missing",
      selectedPlan: {
        title: "Apply config patch",
        summary: "Patch the config and retry the failing workflow",
        stepCount: 1,
        rollbackPlanAvailable: true,
      },
      riskTier: 2 as const,
      approvalTrail: {
        requestId: "approval-1",
        status: "pending" as const,
      },
      executionResult: {
        status: "planned" as const,
        outcome: null,
      },
      rollbackResult: {
        available: true,
        rollbackAttempted: false,
        rollbackSucceeded: false,
      },
      acceptanceResult: {
        passed: false,
        reason: "Pending approval",
      },
    },
  };
}

function makeService(): FridaySelfHealingApiService {
  const record = makeActionRecord();

  return {
    listIncidents: vi.fn(() => []),
    getIncident: vi.fn(() => null),
    getIncidentDiagnosis: vi.fn(() => null),
    listActions: vi.fn(() => [record]),
    getAction: vi.fn((input: { actionId: string }) => (input.actionId === "missing" ? null : record)),
    approveAction: vi.fn(async () => record),
    denyAction: vi.fn(async () => ({
      ...record,
      approval: { ...record.approval, status: "rejected" as const },
      action: { ...record.action, status: "rejected" as const },
    })),
    executeAction: vi.fn(async () => ({
      ...record,
      action: {
        ...record.action,
        status: "applied" as const,
        outcome: "success" as const,
      },
    })),
    rollbackAction: vi.fn(async () => ({
      ...record,
      action: {
        ...record.action,
        status: "rolled_back" as const,
        outcome: "failed" as const,
      },
    })),
    getMetrics: vi.fn(() => ({
      day: "2026-03-07",
      incidentsTotal: 1,
      factsUpdated: 0,
      actionsExecuted: 1,
      createdAt: NOW,
      updatedAt: NOW,
    })),
    listIssueCards: vi.fn(() => []),
    reportStructuredFailure: vi.fn(),
    emitProcessResults: vi.fn(),
  } as unknown as FridaySelfHealingApiService;
}

describe("FridayAutoFixRoutes", () => {
  it("creates auto-fix route definitions", () => {
    const routes = createFridayAutoFixRoutes({ service: makeService() });
    expect(routes).toHaveLength(7);
    expect(routes.map((route) => route.operationId)).toEqual([
      "autofix.actions.list",
      "autofix.actions.get",
      "autofix.actions.approve",
      "autofix.actions.deny",
      "autofix.actions.execute",
      "autofix.actions.rollback",
      "autofix.metrics.get",
    ]);
  });

  it("lists actions with filters", async () => {
    const service = makeService();
    const routes = createFridayAutoFixRoutes({
      service,
      agentLoop: {
        findRunByActionId: vi.fn(() => ({ loopRunId: "loop-run-1" })),
      },
    });
    const route = routes.find((entry) => entry.operationId === "autofix.actions.list")!;

    const result = await route.handler(
      makeCtx({ query: { status: "planned", incidentId: "incident-1", limit: "4" } }),
    ) as { items: Array<{ summary: { actionId: string; loopRunId?: string } }> };

    expect(service.listActions).toHaveBeenCalledWith({
      userId: "user-1",
      status: "planned",
      incidentId: "incident-1",
      limit: 4,
    });
    expect(result.items[0]?.summary.actionId).toBe("action-1");
    expect(result.items[0]?.summary.loopRunId).toBe("loop-run-1");
  });

  it("approves an action with the authenticated user", async () => {
    const service = makeService();
    const routes = createFridayAutoFixRoutes({ service });
    const route = routes.find((entry) => entry.operationId === "autofix.actions.approve")!;

    await route.handler(
      makeCtx({
        params: { actionId: "action-1" },
        body: { reason: "Looks safe" },
      }),
    );

    expect(service.approveAction).toHaveBeenCalledWith({
      actionId: "action-1",
      respondedBy: "user-1",
      reason: "Looks safe",
    });
  });

  it("requires a rollback reason", async () => {
    const routes = createFridayAutoFixRoutes({ service: makeService() });
    const route = routes.find((entry) => entry.operationId === "autofix.actions.rollback")!;

    await expect(
      route.handler(makeCtx({ params: { actionId: "action-1" }, body: {} })),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

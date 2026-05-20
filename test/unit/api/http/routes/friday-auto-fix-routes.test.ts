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
        repairOutcome: "failed" as const,
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
      details: {
        ...record,
        action: {
          ...record.action,
          status: "applied" as const,
          outcome: "success" as const,
        },
      },
      result: {
        action: {
          ...record.action,
          status: "applied" as const,
          outcome: "success" as const,
        },
        success: true,
        verificationPassed: true,
        rollbackAttempted: false,
        rollbackSucceeded: false,
      },
    })),
    runReadyActions: vi.fn(async () => ({
      summary: {
        inspected: 2,
        executed: 1,
        succeeded: 1,
        failed: 0,
        requiresApproval: 1,
        blockedByPolicy: 0,
        notReady: 0,
        dataProtected: true,
        maxRiskTier: 1,
        limit: 4,
      },
      executed: [
        {
          details: {
            ...record,
            action: {
              ...record.action,
              status: "applied" as const,
              outcome: "success" as const,
            },
          },
          result: {
            action: {
              ...record.action,
              status: "applied" as const,
              outcome: "success" as const,
            },
            success: true,
            verificationPassed: true,
            rollbackAttempted: false,
            rollbackSucceeded: false,
          },
        },
      ],
      skipped: [
        {
          details: record,
          reason: "approval_required" as const,
          reasonText: "Needs approval",
        },
      ],
    })),
    rollbackAction: vi.fn(async () => ({
      details: {
        ...record,
        action: {
          ...record.action,
          status: "rolled_back" as const,
          outcome: "failed" as const,
        },
      },
      result: {
        action: {
          ...record.action,
          status: "rolled_back" as const,
          outcome: "failed" as const,
        },
        success: false,
        verificationPassed: false,
        rollbackAttempted: true,
        rollbackSucceeded: true,
      },
    })),
    manualResolveIncident: vi.fn(),
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
    expect(routes).toHaveLength(8);
    expect(routes.map((route) => route.operationId)).toEqual([
      "autofix.actions.list",
      "autofix.actions.run.ready",
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

  it("runs ready self-repair actions through the user-scoped all endpoint", async () => {
    const service = makeService();
    const routes = createFridayAutoFixRoutes({ service });
    const route = routes.find((entry) => entry.operationId === "autofix.actions.run.ready")!;

    const result = await route.handler(
      makeCtx({ body: { maxRiskTier: 1, limit: "4" } }),
    ) as {
      summary: { dataProtected: true; executed: number; requiresApproval: number };
      executed: Array<{ action: { summary: { actionId: string } }; result: { success: boolean } }>;
      skipped: Array<{ reason: string }>;
    };

    expect(service.runReadyActions).toHaveBeenCalledWith({
      userId: "user-1",
      maxRiskTier: 1,
      limit: 4,
    });
    expect(result.summary).toMatchObject({
      dataProtected: true,
      executed: 1,
      requiresApproval: 1,
    });
    expect(result.executed[0]?.result.success).toBe(true);
    expect(result.skipped[0]?.reason).toBe("approval_required");
  });

  it("rejects unsafe maxRiskTier values for homepage self-repair", async () => {
    const routes = createFridayAutoFixRoutes({ service: makeService() });
    const route = routes.find((entry) => entry.operationId === "autofix.actions.run.ready")!;

    await expect(
      route.handler(makeCtx({ body: { maxRiskTier: 2 } })),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
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
      userId: "user-1",
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

  it("passes a structured denial reason code when provided", async () => {
    const service = makeService();
    const routes = createFridayAutoFixRoutes({ service });
    const route = routes.find((entry) => entry.operationId === "autofix.actions.deny")!;

    await route.handler(
      makeCtx({
        params: { actionId: "action-1" },
        body: {
          reason: "This patch is too risky for prod",
          reasonCode: "too_risky",
        },
      }),
    );

    expect(service.denyAction).toHaveBeenCalledWith({
      actionId: "action-1",
      userId: "user-1",
      respondedBy: "user-1",
      reason: "This patch is too risky for prod",
      reasonCode: "too_risky",
    });
  });

  // ─── Phase 14.5B module_28b: bound-principal gate on mutating routes ───────

  describe("Phase 14.5B module_28b bound-principal gate", () => {
    const syntheticPublicPrincipal = {
      principalId: "public:default",
      principalType: "user",
      tenantId: "00000000-0000-0000-0000-000000000001",
      userId: "00000000-0000-0000-0000-000000000001",
      role: "admin",
      scopes: [],
      tokenId: "00000000-0000-0000-0000-000000000002",
      tokenKind: "access",
      issuedAt: "2026-05-12T00:00:00.000Z",
    } as never;

    const mutatingOperationIds = [
      "autofix.actions.run.ready",
      "autofix.actions.approve",
      "autofix.actions.deny",
      "autofix.actions.execute",
      "autofix.actions.rollback",
    ] as const;

    function ctxFor(operationId: string, principal: unknown) {
      const params = operationId === "autofix.actions.run.ready" ? {} : { actionId: "action-1" };
      const body = operationId === "autofix.actions.rollback"
        ? { reason: "test rollback" }
        : operationId === "autofix.actions.deny"
          ? { reason: "test deny" }
          : {};
      return makeCtx({ params, body, principal: principal as never });
    }

    it.each(mutatingOperationIds)(
      "Phase 14.5B module_28b: %s refuses the synthetic public principal",
      async (operationId) => {
        const service = makeService();
        const routes = createFridayAutoFixRoutes({ service });
        const route = routes.find((entry) => entry.operationId === operationId)!;

        let thrown: unknown;
        try {
          await route.handler(ctxFor(operationId, syntheticPublicPrincipal));
        } catch (err) {
          thrown = err;
        }
        expect((thrown as { code?: string }).code).toBe("OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED");

        if (operationId === "autofix.actions.run.ready") {
          expect(service.runReadyActions).not.toHaveBeenCalled();
        } else if (operationId === "autofix.actions.approve") {
          expect(service.approveAction).not.toHaveBeenCalled();
        } else if (operationId === "autofix.actions.deny") {
          expect(service.denyAction).not.toHaveBeenCalled();
        } else if (operationId === "autofix.actions.execute") {
          expect(service.executeAction).not.toHaveBeenCalled();
        } else {
          expect(service.rollbackAction).not.toHaveBeenCalled();
        }
      },
    );

    it.each(mutatingOperationIds)(
      "Phase 14.5B module_28b: %s refuses a null principal",
      async (operationId) => {
        const service = makeService();
        const routes = createFridayAutoFixRoutes({ service });
        const route = routes.find((entry) => entry.operationId === operationId)!;

        let thrown: unknown;
        try {
          await route.handler(ctxFor(operationId, null));
        } catch (err) {
          thrown = err;
        }
        expect((thrown as { code?: string }).code).toBe("OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED");
      },
    );

    it("Phase 14.5B module_28b: read-shaped routes keep their existing public posture", async () => {
      const service = makeService();
      const routes = createFridayAutoFixRoutes({ service });

      // The synthetic public principal still carries a userId, so the read
      // routes continue to work without the bound-principal upgrade.
      const listRoute = routes.find((entry) => entry.operationId === "autofix.actions.list")!;
      const getRoute = routes.find((entry) => entry.operationId === "autofix.actions.get")!;
      const metricsRoute = routes.find((entry) => entry.operationId === "autofix.metrics.get")!;

      await expect(
        listRoute.handler(makeCtx({ principal: syntheticPublicPrincipal })),
      ).resolves.toBeDefined();
      await expect(
        getRoute.handler(makeCtx({ principal: syntheticPublicPrincipal, params: { actionId: "action-1" } })),
      ).resolves.toBeDefined();
      await expect(
        metricsRoute.handler(makeCtx({ principal: syntheticPublicPrincipal })),
      ).resolves.toBeDefined();
    });
  });
});

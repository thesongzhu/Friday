import { describe, expect, it, vi } from "vitest";
import { createFridayDiagnosisRoutes } from "#api";
import type { FridayHttpContext } from "#api";
import type { FridaySelfHealingApiService } from "#learning";
import { FridayDomainError } from "#errors";

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

function makeService(): FridaySelfHealingApiService {
  const details = {
    incident: {
      incidentId: "incident-1",
      userId: "user-1",
      ts: NOW,
      category: "workflow" as const,
      severity: "medium" as const,
      signature: "workflow:failed",
      context: {},
      autoFixEligible: true,
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    },
    diagnosis: {
      id: "diagnosis-1",
      incidentId: "incident-1",
      errorFingerprint: "fp-1",
      confidence: 0.91,
      diagnosis: {
        summary: "Workflow failed because a config patch was missing",
        suggestedFixes: ["Apply the missing config patch"],
        matchedLessonIds: ["lesson-1"],
      },
      createdAt: NOW,
      updatedAt: NOW,
    },
    lesson: null,
    action: null,
    recurrenceCount: 2,
    autoFixEligible: true,
  };

  return {
    listIncidents: vi.fn(() => [details]),
    getIncident: vi.fn((input: { incidentId: string }) => (input.incidentId === "missing" ? null : details)),
    getIncidentDiagnosis: vi.fn((input: { incidentId: string }) => (input.incidentId === "missing" ? null : details)),
    getLearningOverview: vi.fn(() => ({
      lessons: [],
      patterns: [],
      routeAdjustments: [],
      routeBiases: [],
      operatorPins: [],
      penaltyFacts: [],
      recentDecisionDiffs: [],
      blockedRoutes: [],
      rejectedFixes: [],
      recentRejectedFixes: [],
      rollbackHotspots: [],
      coverage: {
        lessons: 0,
        patterns: 0,
        routeAdjustments: 0,
        recentDecisionDiffs: 0,
        blockedRoutes: 0,
        rejectedFixes: 0,
        rollbackHotspots: 0,
        incidents: 0,
        diagnoses: 0,
        autoFixActions: 0,
        autoFixOutcomeBuckets: {
          recordedActions: 0,
          verifiedRepairs: 0,
          diagnosticOnly: 0,
          failed: 0,
          rolledBack: 0,
          rejected: 0,
          pending: 0,
          rollbackAttempted: 0,
          rollbackFailed: 0,
        },
      },
    })),
    listActions: vi.fn(() => []),
    getAction: vi.fn(() => null),
    approveAction: vi.fn(),
    denyAction: vi.fn(),
    manualResolveIncident: vi.fn(() => ({
      ...details,
      incident: {
        ...details.incident,
        status: "resolved" as const,
      },
    })),
    setLessonEnabled: vi.fn((input: { lessonId: string; enabled: boolean; reason?: string }) => ({
      lessonId: input.lessonId,
      enabled: input.enabled,
      reason: input.reason ?? null,
      updatedAt: NOW,
    })),
    demotePattern: vi.fn((input: { patternId: string; factor: number; reason?: string }) => ({
      patternId: input.patternId,
      factor: input.factor,
      reason: input.reason ?? null,
      updatedAt: NOW,
    })),
    executeAction: vi.fn(),
    rollbackAction: vi.fn(),
    getMetrics: vi.fn(),
    listIssueCards: vi.fn(() => []),
    reportStructuredFailure: vi.fn(),
    emitProcessResults: vi.fn(),
  } as unknown as FridaySelfHealingApiService;
}

describe("FridayDiagnosisRoutes", () => {
  it("creates diagnosis route definitions", () => {
    const routes = createFridayDiagnosisRoutes({ service: makeService() });
    expect(routes).toHaveLength(11);
    expect(routes.map((route) => route.operationId)).toEqual([
      "diagnosis.incidents.list",
      "learning.incidents.list",
      "diagnosis.incidents.get",
      "learning.incidents.get",
      "diagnosis.incidents.diagnosis.get",
      "learning.incidents.diagnosis.get",
      "diagnosis.learning.overview",
      "learning.overview.get",
      "diagnosis.incidents.manual.resolve",
      "diagnosis.lessons.enabled.set",
      "diagnosis.patterns.demote",
    ]);
  });

  it("lists incidents for the authenticated user", async () => {
    const service = makeService();
    const routes = createFridayDiagnosisRoutes({
      service,
      agentLoop: {
        findRunByIncidentId: vi.fn(() => ({ loopRunId: "loop-run-1" })),
      },
    });
    const route = routes.find((entry) => entry.operationId === "diagnosis.incidents.list")!;

    const result = await route.handler(makeCtx({ query: { status: "open", limit: "5" } })) as {
      items: Array<{ summary: { incidentId: string; recurrenceCount: number; loopRunId?: string } }>;
    };

    expect(service.listIncidents).toHaveBeenCalledWith({
      userId: "user-1",
      status: "open",
      limit: 5,
    });
    expect(result.items[0]?.summary.incidentId).toBe("incident-1");
    expect(result.items[0]?.summary.recurrenceCount).toBe(2);
    expect(result.items[0]?.summary.loopRunId).toBe("loop-run-1");
  });

  it("returns 404 when an incident does not exist", async () => {
    const routes = createFridayDiagnosisRoutes({ service: makeService() });
    const route = routes.find((entry) => entry.operationId === "diagnosis.incidents.get")!;

    await expect(
      route.handler(makeCtx({ params: { incidentId: "missing" } })),
    ).rejects.toMatchObject({ code: "DIAGNOSIS_INCIDENT_NOT_FOUND" });
  });

  it("requires a user-scoped principal", async () => {
    const routes = createFridayDiagnosisRoutes({ service: makeService() });
    const route = routes.find((entry) => entry.operationId === "diagnosis.incidents.list")!;

    await expect(
      route.handler(makeCtx({ principal: null })),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("manually resolves an incident with the authenticated user", async () => {
    const service = makeService();
    const routes = createFridayDiagnosisRoutes({ service, allowTestOnlyDiagnosisExecution: true });
    const route = routes.find((entry) => entry.operationId === "diagnosis.incidents.manual.resolve")!;

    const result = await route.handler(
      makeCtx({
        params: { incidentId: "incident-1" },
        body: {
          title: "Manual repair",
          cause: "Patched a missing flag",
          fix: "Added the missing flag and re-ran the workflow",
          verificationSummary: "Workflow completed on retry",
        },
      }),
    ) as { incident: { status: string } };

    expect(service.manualResolveIncident).toHaveBeenCalledWith({
      incidentId: "incident-1",
      userId: "user-1",
      resolvedBy: "user-1",
      title: "Manual repair",
      cause: "Patched a missing flag",
      fix: "Added the missing flag and re-ran the workflow",
      verificationSummary: "Workflow completed on retry",
    });
    expect(result.incident.status).toBe("resolved");
  });

  it("returns learning overview for the authenticated user", async () => {
    const service = makeService();
    const routes = createFridayDiagnosisRoutes({ service });
    const route = routes.find((entry) => entry.operationId === "diagnosis.learning.overview")!;

    const result = await route.handler(
      makeCtx({ query: { limit: "10" } }),
    ) as { lessons: unknown[]; patterns: unknown[] };

    expect(service.getLearningOverview).toHaveBeenCalledWith({
      userId: "user-1",
      limit: 10,
    });
    expect(result.lessons).toEqual([]);
    expect(result.patterns).toEqual([]);
  });

  it("exposes learning incident aliases under /v1/learning/*", async () => {
    const service = makeService();
    const routes = createFridayDiagnosisRoutes({ service });
    const listRoute = routes.find((entry) => entry.operationId === "learning.incidents.list")!;
    const detailRoute = routes.find((entry) => entry.operationId === "learning.incidents.get")!;
    const diagnosisRoute = routes.find((entry) => entry.operationId === "learning.incidents.diagnosis.get")!;
    const overviewRoute = routes.find((entry) => entry.operationId === "learning.overview.get")!;

    const listResult = await listRoute.handler(makeCtx({ query: { limit: "3" } })) as {
      items: Array<{ summary: { incidentId: string } }>;
    };
    const detailResult = await detailRoute.handler(makeCtx({ params: { incidentId: "incident-1" } })) as {
      summary: { incidentId: string };
    };
    const diagnosisResult = await diagnosisRoute.handler(makeCtx({ params: { incidentId: "incident-1" } })) as {
      incident: { incidentId: string };
    };
    const overviewResult = await overviewRoute.handler(makeCtx({ query: { limit: "4" } })) as {
      lessons: unknown[];
    };

    expect(service.listIncidents).toHaveBeenCalledWith({
      userId: "user-1",
      status: undefined,
      limit: 3,
    });
    expect(service.getIncident).toHaveBeenCalledWith({ incidentId: "incident-1", userId: "user-1" });
    expect(service.getIncidentDiagnosis).toHaveBeenCalledWith({ incidentId: "incident-1", userId: "user-1" });
    expect(service.getLearningOverview).toHaveBeenCalledWith({ userId: "user-1", limit: 4 });
    expect(listRoute.path).toBe("/v1/learning/incidents");
    expect(detailRoute.path).toBe("/v1/learning/incidents/:incidentId");
    expect(diagnosisRoute.path).toBe("/v1/learning/incidents/:incidentId/diagnosis");
    expect(overviewRoute.path).toBe("/v1/learning/overview");
    expect(listResult.items[0]?.summary.incidentId).toBe("incident-1");
    expect(detailResult.summary.incidentId).toBe("incident-1");
    expect(diagnosisResult.incident.incidentId).toBe("incident-1");
    expect(overviewResult.lessons).toEqual([]);
  });

  it("toggles lesson enabled state with a boolean body", async () => {
    const service = makeService();
    const routes = createFridayDiagnosisRoutes({ service, allowTestOnlyDiagnosisExecution: true });
    const route = routes.find((entry) => entry.operationId === "diagnosis.lessons.enabled.set")!;

    const result = await route.handler(
      makeCtx({
        params: { lessonId: "lesson-1" },
        body: {
          enabled: false,
          reason: "Operator override",
        },
      }),
    ) as { lesson: { lessonId: string; enabled: boolean; reason?: string | null } };

    expect(service.setLessonEnabled).toHaveBeenCalledWith({
      userId: "user-1",
      lessonId: "lesson-1",
      enabled: false,
      reason: "Operator override",
    });
    expect(result.lesson.lessonId).toBe("lesson-1");
    expect(result.lesson.enabled).toBe(false);
  });

  it("demotes a learned pattern with bounded factor", async () => {
    const service = makeService();
    const routes = createFridayDiagnosisRoutes({ service, allowTestOnlyDiagnosisExecution: true });
    const route = routes.find((entry) => entry.operationId === "diagnosis.patterns.demote")!;

    const result = await route.handler(
      makeCtx({
        params: { patternId: "pattern-1" },
        body: {
          factor: 0.25,
          reason: "Too aggressive",
        },
      }),
    ) as { pattern: { patternId: string; factor: number } };

    expect(service.demotePattern).toHaveBeenCalledWith({
      userId: "user-1",
      patternId: "pattern-1",
      factor: 0.25,
      reason: "Too aggressive",
    });
    expect(result.pattern.patternId).toBe("pattern-1");
    expect(result.pattern.factor).toBe(0.25);
  });

  describe("TS runtime retirement (allowTestOnlyDiagnosisExecution unset)", () => {
    function retiredRoute(operationId: string, service: FridaySelfHealingApiService) {
      const route = createFridayDiagnosisRoutes({ service }).find((entry) => entry.operationId === operationId);
      if (!route) throw new Error(`route not found: ${operationId}`);
      return route;
    }

    const cases: Array<{ op: string; ctx: Partial<FridayHttpContext<unknown, unknown, unknown>>; svc: string }> = [
      { op: "diagnosis.incidents.manual.resolve", ctx: { params: { incidentId: "incident-1" } as never, body: { fix: "patched" } as never }, svc: "manualResolveIncident" },
      { op: "diagnosis.lessons.enabled.set", ctx: { params: { lessonId: "lesson-1" } as never, body: { enabled: false } as never }, svc: "setLessonEnabled" },
      { op: "diagnosis.patterns.demote", ctx: { params: { patternId: "pattern-1" } as never, body: { factor: 0.25 } as never }, svc: "demotePattern" },
    ];

    for (const { op, ctx, svc } of cases) {
      it(`fail-closes ${op} with 503 and never calls the service`, async () => {
        const service = makeService();
        await expect(retiredRoute(op, service).handler(makeCtx(ctx))).rejects.toMatchObject({
          code: "TS_RUNTIME_DIAGNOSIS_RETIRED",
          httpStatus: 503,
        } satisfies Partial<FridayDomainError>);
        expect((service as unknown as Record<string, ReturnType<typeof vi.fn>>)[svc]).not.toHaveBeenCalled();
      });
    }

    it("validates the body (400) before the retirement guard (manual.resolve missing fix)", async () => {
      const service = makeService();
      await expect(retiredRoute("diagnosis.incidents.manual.resolve", service).handler(
        makeCtx({ params: { incidentId: "incident-1" } as never, body: {} as never }),
      )).rejects.toMatchObject({ code: "VALIDATION_ERROR", httpStatus: 400 } satisfies Partial<FridayDomainError>);
      expect(service.manualResolveIncident).not.toHaveBeenCalled();
    });

    it("requires a user-scoped principal (401) before the retirement guard", async () => {
      const service = makeService();
      await expect(retiredRoute("diagnosis.incidents.manual.resolve", service).handler(
        makeCtx({ principal: null as never, params: { incidentId: "incident-1" } as never, body: { fix: "patched" } as never }),
      )).rejects.toMatchObject({ code: "UNAUTHORIZED", httpStatus: 401 } satisfies Partial<FridayDomainError>);
      expect(service.manualResolveIncident).not.toHaveBeenCalled();
    });
  });
});

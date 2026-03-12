import { describe, expect, it, vi } from "vitest";
import { createFridayDiagnosisRoutes } from "#api";
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
    listActions: vi.fn(() => []),
    getAction: vi.fn(() => null),
    approveAction: vi.fn(),
    denyAction: vi.fn(),
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
    expect(routes).toHaveLength(3);
    expect(routes.map((route) => route.operationId)).toEqual([
      "diagnosis.incidents.list",
      "diagnosis.incidents.get",
      "diagnosis.incidents.diagnosis.get",
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
});

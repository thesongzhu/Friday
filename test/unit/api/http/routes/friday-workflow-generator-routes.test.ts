import { describe, it, expect, vi } from "vitest";

import { createFridayWorkflowGeneratorRoutes } from "#api";
import type { FridayWorkflowGeneratorService } from "#workflows";

// ─── Mock service ───

function makeMockService(): FridayWorkflowGeneratorService {
  return {
    startSession: vi.fn(async (input) => ({
      session: {
        sessionId: "s-1",
        userId: input.userId,
        channel: input.channel,
        status: "needs_clarification" as const,
        goal: input.goal,
        requirementsSummary: "",
        openQuestions: ["Q1"],
        decisions: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      mode: "clarification_required" as const,
      questions: ["Q1"],
    })),
    submitTurn: vi.fn(async () => ({
      session: {
        sessionId: "s-1",
        userId: "u-1",
        channel: "test",
        status: "needs_clarification" as const,
        goal: "test",
        requirementsSummary: "",
        openQuestions: [],
        decisions: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      mode: "clarification_required" as const,
    })),
    getSession: vi.fn(async (sessionId: string) => {
      if (sessionId === "not-found") return null;
      return {
        session: {
          sessionId,
          userId: "u-1",
          channel: "test",
          status: "ready_for_review" as const,
          goal: "test",
          requirementsSummary: "",
          openQuestions: [],
          decisions: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        turns: [],
        draft: {
          spec: {} as never,
          visual: {} as never,
          tests: [],
          compiledGraph: {} as never,
          validation: { ok: true, issues: [], repaired: false, repairAttempts: 0 },
        },
      };
    }),
    generateDraft: vi.fn(async () => ({
      spec: {} as never,
      visual: {} as never,
      tests: [],
      compiledGraph: {} as never,
      validation: { ok: true, issues: [], repaired: false, repairAttempts: 0 },
    })),
    approveAndSave: vi.fn(async () => ({
      sessionId: "s-1",
      workflowId: "wf-1",
      workflowVersionId: "wv-1",
      versionNumber: 1,
      slug: "test-workflow",
      published: true,
    })),
    getQaVerdict: vi.fn(async () => null),
    getHarnessSummary: vi.fn(async () => null),
    cancelSession: vi.fn(async () => undefined),
  };
}

// ─── Route helper ───

function makeCtx(overrides: {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  return {
    requestId: "req-1",
    receivedAt: "2026-01-01T00:00:00.000Z",
    params: overrides.params ?? {},
    query: overrides.query ?? {},
    body: overrides.body ?? {},
    headers: overrides.headers ?? {},
    principal: { userId: "u-1", type: "user" as const, roles: ["admin"] },
  };
}

// ─── Tests ───

describe("FridayWorkflowGeneratorRoutes", () => {
  const service = makeMockService();
  const routes = createFridayWorkflowGeneratorRoutes({
    workflowGenerator: service,
  });

  it("creates exactly 7 routes", () => {
    expect(routes).toHaveLength(7);
  });

  it("has correct operation IDs", () => {
    const opIds = routes.map((r) => r.operationId).sort();
    expect(opIds).toEqual([
      "workflows.generator.sessions.approve",
      "workflows.generator.sessions.cancel",
      "workflows.generator.sessions.create",
      "workflows.generator.sessions.evidence.get",
      "workflows.generator.sessions.generate",
      "workflows.generator.sessions.get",
      "workflows.generator.sessions.messages.create",
    ]);
  });

  it("has correct HTTP methods", () => {
    const methods = new Map(routes.map((r) => [r.operationId, r.method]));
    expect(methods.get("workflows.generator.sessions.create")).toBe("POST");
    expect(methods.get("workflows.generator.sessions.get")).toBe("GET");
    expect(methods.get("workflows.generator.sessions.messages.create")).toBe("POST");
    expect(methods.get("workflows.generator.sessions.generate")).toBe("POST");
    expect(methods.get("workflows.generator.sessions.evidence.get")).toBe("GET");
    expect(methods.get("workflows.generator.sessions.approve")).toBe("POST");
    expect(methods.get("workflows.generator.sessions.cancel")).toBe("DELETE");
  });

  it("has correct paths", () => {
    const paths = new Map(routes.map((r) => [r.operationId, r.path]));
    expect(paths.get("workflows.generator.sessions.create")).toBe("/v1/workflows/generator/sessions");
    expect(paths.get("workflows.generator.sessions.get")).toBe("/v1/workflows/generator/sessions/:sessionId");
    expect(paths.get("workflows.generator.sessions.messages.create")).toBe("/v1/workflows/generator/sessions/:sessionId/messages");
    expect(paths.get("workflows.generator.sessions.generate")).toBe("/v1/workflows/generator/sessions/:sessionId/generate");
    expect(paths.get("workflows.generator.sessions.evidence.get")).toBe("/v1/workflows/generator/sessions/:sessionId/evidence");
    expect(paths.get("workflows.generator.sessions.approve")).toBe("/v1/workflows/generator/sessions/:sessionId/approve");
    expect(paths.get("workflows.generator.sessions.cancel")).toBe("/v1/workflows/generator/sessions/:sessionId");
  });

  it("all routes require auth", () => {
    for (const route of routes) {
      expect(route.auth).toHaveProperty("public", false);
    }
  });

  it("create session delegates to service", async () => {
    const createRoute = routes.find((r) => r.operationId === "workflows.generator.sessions.create")!;
    const result = await createRoute.handler(
      makeCtx({
        body: { goal: "Build workflow", userId: "u-1", channel: "test" },
      }) as never,
    );
    expect(service.startSession).toHaveBeenCalledWith({
      goal: "Build workflow",
      userId: "u-1",
      channel: "test",
      requestedModel: undefined,
    });
    expect(result).toBeDefined();
  });

  it("create session validates required fields", async () => {
    const createRoute = routes.find((r) => r.operationId === "workflows.generator.sessions.create")!;

    await expect(
      createRoute.handler(makeCtx({ body: { userId: "u-1", channel: "test" } }) as never),
    ).rejects.toThrow("goal");

    await expect(
      createRoute.handler(makeCtx({ body: { goal: "test", channel: "test" } }) as never),
    ).rejects.toThrow("userId");

    await expect(
      createRoute.handler(makeCtx({ body: { goal: "test", userId: "u-1" } }) as never),
    ).rejects.toThrow("channel");
  });

  it("get session returns 404 for unknown session", async () => {
    const getRoute = routes.find((r) => r.operationId === "workflows.generator.sessions.get")!;
    await expect(
      getRoute.handler(makeCtx({ params: { sessionId: "not-found" } }) as never),
    ).rejects.toThrow("Generation session not found");
  });

  it("submit message delegates to service", async () => {
    const messageRoute = routes.find((r) => r.operationId === "workflows.generator.sessions.messages.create")!;
    await messageRoute.handler(
      makeCtx({
        params: { sessionId: "s-1" },
        body: { message: "Use manual trigger" },
      }) as never,
    );
    expect(service.submitTurn).toHaveBeenCalledWith("s-1", {
      message: "Use manual trigger",
      requestedModel: undefined,
    });
  });

  it("submit message validates required fields", async () => {
    const messageRoute = routes.find((r) => r.operationId === "workflows.generator.sessions.messages.create")!;
    await expect(
      messageRoute.handler(makeCtx({ params: { sessionId: "s-1" }, body: {} }) as never),
    ).rejects.toThrow("message");
  });

  it("generate delegates to service", async () => {
    const genRoute = routes.find((r) => r.operationId === "workflows.generator.sessions.generate")!;
    const result = await genRoute.handler(
      makeCtx({ params: { sessionId: "s-1" }, body: {} }) as never,
    );
    expect(service.generateDraft).toHaveBeenCalledWith("s-1", undefined);
    expect(result).toHaveProperty("draft");
  });

  it("approve delegates to service", async () => {
    const approveRoute = routes.find((r) => r.operationId === "workflows.generator.sessions.approve")!;
    const result = await approveRoute.handler(
      makeCtx({ params: { sessionId: "s-1" } }) as never,
    );
    expect(service.approveAndSave).toHaveBeenCalledWith("s-1");
    expect(result).toHaveProperty("workflowId");
  });

  it("cancel delegates to service", async () => {
    const cancelRoute = routes.find((r) => r.operationId === "workflows.generator.sessions.cancel")!;
    const result = await cancelRoute.handler(
      makeCtx({ params: { sessionId: "s-1" } }) as never,
    );
    expect(service.cancelSession).toHaveBeenCalledWith("s-1");
    expect(result).toEqual({ cancelled: true });
  });

  it("approve route has rate limit policy", () => {
    const approveRoute = routes.find((r) => r.operationId === "workflows.generator.sessions.approve")!;
    expect(approveRoute.rateLimitPolicyId).toBe("workflow.publish");
  });
});

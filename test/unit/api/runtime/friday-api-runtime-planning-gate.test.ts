import { afterEach, describe, expect, it, vi } from "vitest";

import { createFridayApiRuntime } from "#api";
import {
  createFridayAgentEventEmitter,
  createFridayAgentRunRepository,
  type FridayAgentRuntime,
} from "#agent";
import type { FridayProviderService } from "#providers";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../../helpers/friday-test-db.helper.js";

const NOW = "2026-03-16T09:00:00.000Z";

function makeIdGenerator(): () => string {
  let counter = 0;
  return () => `id-${String(++counter)}`;
}

function makeProviderService(): FridayProviderService {
  return {
    listProviders: vi.fn(async () => []),
    getProvider: vi.fn(async () => null),
    createProvider: vi.fn(async () => ({} as never)),
    updateProvider: vi.fn(async () => ({} as never)),
    deleteProvider: vi.fn(async () => undefined),
    validateProvider: vi.fn(async () => ({ status: "ok" as const, checkedAt: NOW })),
    getRoutingConfig: vi.fn(async () => ({ defaultProviderId: "p-1", fallbackProviderIds: [] })),
    setRoutingConfig: vi.fn(async (input) => input),
    resolveRoute: vi.fn(async () => ({
      provider: {
        id: "p-1",
        kind: "openai" as const,
        name: "OpenAI",
        baseUrl: "https://api.openai.com",
        enabled: true,
        config: {
          api: "openai-responses" as const,
          authMode: "api-key" as const,
          keySource: { kind: "env-ref" as const, envVar: "OPENAI_API_KEY" },
          supportedModels: ["gpt-5.1"],
          validation: { status: "ok" as const, checkedAt: NOW },
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
      model: "gpt-5.1",
    })),
    runWithFallback: vi.fn(async () => ({} as never)),
  } as unknown as FridayProviderService;
}

function makeBoundPrincipal(principalId: string) {
  return {
    principalType: "user",
    principalId,
    userId: principalId,
    tokenId: `${principalId}-token`,
    tokenKind: "access",
    scopes: ["agent.write"],
    issuedAt: NOW,
  };
}

describe("FridayApiRuntime — planning gate session loop", () => {
  let db: FridaySqliteLayer;

  afterEach(() => {
    db?.close();
  });

  it("keeps same-thread workflow clarification turns on the same run without throwing", async () => {
    db = createTestDb();
    const idGenerator = makeIdGenerator();
    const runRepo = createFridayAgentRunRepository();
    const eventEmitter = createFridayAgentEventEmitter();
    let sessionServiceRef:
      | ReturnType<typeof createFridayApiRuntime>["sessionService"]
      | undefined;
    const clarificationQuestions = [
      "What time on Friday should this workflow run?",
      "Which Slack channel or webhook should receive the release status summary?",
      "What specific workspace root path should be checked for release readiness?",
    ];

    const agentRuntime: FridayAgentRuntime = {
      executeRun: vi.fn(async (params) => {
        const existing = db.withReadConnection((reader) => runRepo.getById(reader, params.runId!));
        const nextPlanReview = {
          ...(params.planReviewOverride ?? existing?.planReview ?? {
            plan: {
              task: params.task,
              stepCount: 3,
              description: "Planning gate for generate workflow",
            },
          }),
          gate: {
            ...(params.planReviewOverride?.gate ?? existing?.planReview?.gate ?? {
              kind: "generate_workflow" as const,
            }),
            state: "awaiting_clarification" as const,
            clarificationQuestions,
            answers: [],
          },
        };
        const response = [
          "I hit a real blocker while continuing workflow generation: the downstream generator still needs a few specific details before it can proceed.",
          "",
          "Please answer these questions in the same thread:",
          "1. What time on Friday should this workflow run?",
          "2. Which Slack channel or webhook should receive the release status summary?",
          "3. What specific workspace root path should be checked for release readiness?",
          "",
          "After you answer them, Friday will update the plan and wait for confirmation again before continuing.",
        ].join("\n");

        db.withWriteTransaction((writer) =>
          runRepo.update(writer, {
            id: params.runId!,
            status: "awaiting_clarification",
            responseText: response,
            summary: "Workflow generation needs clarification",
            planReview: nextPlanReview,
          }));

        if (params.sessionKey && sessionServiceRef) {
          await sessionServiceRef.addMessage(params.sessionKey, {
            role: "assistant",
            content: response,
            contentText: response,
            idempotencyKey: `agent-run:${params.runId}:response`,
          });
        }

        return {
          runId: params.runId!,
          status: "awaiting_clarification",
          response,
          toolCallCount: 1,
          durationMs: 10,
          usageInput: 1,
          usageOutput: 1,
          finalResponse: response,
        };
      }),
      registerTool: vi.fn(),
      resumeStaleRunsOnBoot: vi.fn(() => 0),
    };

    const runtime = createFridayApiRuntime({
      db,
      // TEST-ONLY: no durable master key here → allow the inactive (identity) realtime
      // pseudonymizer so runtime-published realtime events do not fail-closed
      // (SEC-REALTIME-EVENT-PII-BY-VALUE / round-6 P0-1).
      allowTestOnlyInactiveRealtimePseudonym: true,
      idGenerator,
      nowIso: () => NOW,
      providerService: makeProviderService(),
      agentRuntime,
      agentEventEmitter: eventEmitter,
      tokenSecret: "test-secret-key-that-is-at-least-32-chars-long!!", // pragma: allowlist secret
      computeChecksum: (content: string) => `checksum-${content.length}`,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
      allowTestOnlyAgentRunStartExecution: true,
      allowTestOnlySessionExecution: true,
    });
    sessionServiceRef = runtime.sessionService;

    const startRoute = runtime.routes.getRoutes().find((route) => route.operationId === "agent.runs.start");
    expect(startRoute).toBeDefined();

    const sessionKey = "ui:planning-loop:test";
    const detailedTask = "Generate a workflow that runs every Friday, collects workspace release status, posts the summary to Slack, keeps the execution read-only, and reports blockers before deployment.";

    const initial = await startRoute!.handler({
      body: {
        task: detailedTask,
        sessionKey,
      },
      principal: makeBoundPrincipal("planning-loop-user"),
    } as never);
    expect(initial.status).toBe("awaiting_plan_approval");

    const approved = await startRoute!.handler({
      body: {
        task: "approve",
        sessionKey,
      },
      principal: makeBoundPrincipal("planning-loop-user"),
    } as never);
    expect(approved.status).toBe("awaiting_clarification");

    const answerOne = await startRoute!.handler({
      body: {
        task: "Every Friday at 10:00 AM Pacific time.",
        sessionKey,
      },
      principal: makeBoundPrincipal("planning-loop-user"),
    } as never);
    expect(answerOne.status).toBe("awaiting_clarification");

    const answerTwo = await startRoute!.handler({
      body: {
        task: "#release-status via dry-run webhook slack://release-status",
        sessionKey,
      },
      principal: makeBoundPrincipal("planning-loop-user"),
    } as never);
    expect(answerTwo.status).toBe("awaiting_clarification");

    const answerThree = await startRoute!.handler({
      body: {
        task: "/path/to/friday",
        sessionKey,
      },
      principal: makeBoundPrincipal("planning-loop-user"),
    } as never);
    expect(answerThree.status).toBe("awaiting_plan_approval");

    const messages = await runtime.sessionService.getMessages(sessionKey, 20);
    const assistantMessages = messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.contentText);

    expect(assistantMessages).toContain(initial.response);
    expect(assistantMessages).toContain(approved.response);
    expect(assistantMessages.some((message) => message.includes("Question 2/3"))).toBe(true);
    expect(assistantMessages.some((message) => message.includes("Question 3/3"))).toBe(true);
    expect(assistantMessages).toContain(answerThree.response);
  });

  it("preserves pending plan focus when plan approval happens through the direct approve endpoint", async () => {
    db = createTestDb();
    const idGenerator = makeIdGenerator();
    const runRepo = createFridayAgentRunRepository();
    const eventEmitter = createFridayAgentEventEmitter();
    let sessionServiceRef:
      | ReturnType<typeof createFridayApiRuntime>["sessionService"]
      | undefined;
    const clarificationQuestions = [
      "What time on Friday should this workflow run?",
      "Which Slack channel or webhook should receive the release status summary?",
      "What specific workspace root path should be checked for release readiness?",
    ];

    const agentRuntime: FridayAgentRuntime = {
      executeRun: vi.fn(async (params) => {
        const existing = db.withReadConnection((reader) => runRepo.getById(reader, params.runId!));
        const nextPlanReview = {
          ...(params.planReviewOverride ?? existing?.planReview ?? {
            plan: {
              task: params.task,
              stepCount: 3,
              description: "Planning gate for generate workflow",
            },
          }),
          gate: {
            ...(params.planReviewOverride?.gate ?? existing?.planReview?.gate ?? {
              kind: "generate_workflow" as const,
            }),
            state: "awaiting_clarification" as const,
            clarificationQuestions,
            answers: existing?.planReview?.gate?.answers ?? [],
          },
        };
        const response = [
          "I hit a real blocker while continuing workflow generation: the downstream generator still needs a few specific details before it can proceed.",
          "",
          "Please answer these questions in the same thread:",
          "1. What time on Friday should this workflow run?",
          "2. Which Slack channel or webhook should receive the release status summary?",
          "3. What specific workspace root path should be checked for release readiness?",
          "",
          "After you answer them, Friday will update the plan and wait for confirmation again before continuing.",
        ].join("\n");

        db.withWriteTransaction((writer) =>
          runRepo.update(writer, {
            id: params.runId!,
            status: "awaiting_clarification",
            responseText: response,
            summary: "Workflow generation needs clarification",
            planReview: nextPlanReview,
          }));

        if (params.sessionKey && sessionServiceRef) {
          await sessionServiceRef.addMessage(params.sessionKey, {
            role: "assistant",
            content: response,
            contentText: response,
            idempotencyKey: `agent-run:${params.runId}:response`,
          });
        }

        return {
          runId: params.runId!,
          status: "awaiting_clarification",
          response,
          toolCallCount: 1,
          durationMs: 10,
          usageInput: 1,
          usageOutput: 1,
          finalResponse: response,
        };
      }),
      registerTool: vi.fn(),
      resumeStaleRunsOnBoot: vi.fn(() => 0),
    };

    const runtime = createFridayApiRuntime({
      db,
      // TEST-ONLY: no durable master key here → allow the inactive (identity) realtime
      // pseudonymizer so runtime-published realtime events do not fail-closed
      // (SEC-REALTIME-EVENT-PII-BY-VALUE / round-6 P0-1).
      allowTestOnlyInactiveRealtimePseudonym: true,
      idGenerator,
      nowIso: () => NOW,
      providerService: makeProviderService(),
      agentRuntime,
      agentEventEmitter: eventEmitter,
      tokenSecret: "test-secret-key-that-is-at-least-32-chars-long!!", // pragma: allowlist secret
      computeChecksum: (content: string) => `checksum-${content.length}`,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
      allowTestOnlyAgentRunStartExecution: true,
      allowTestOnlyAgentRunControlExecution: true,
      allowTestOnlySessionExecution: true,
    });
    sessionServiceRef = runtime.sessionService;

    const startRoute = runtime.routes.getRoutes().find((route) => route.operationId === "agent.runs.start");
    const approveRoute = runtime.routes.getRoutes().find((route) => route.operationId === "agent.runs.approve.plan");
    expect(startRoute).toBeDefined();
    expect(approveRoute).toBeDefined();

    const sessionKey = "ui:planning-direct-approve:test";
    const initial = await startRoute!.handler({
      body: {
        task: "Generate a workflow that runs every Friday, collects workspace release status, posts the summary to Slack, keeps the execution read-only, and reports blockers before deployment.",
        sessionKey,
      },
      principal: makeBoundPrincipal("planning-direct-approve-user"),
    } as never);
    expect(initial.status).toBe("awaiting_plan_approval");

    const approved = await approveRoute!.handler({
      params: { runId: initial.runId },
      // Phase 14.5A: plan approval requires a bound owner/session/channel principal.
      principal: makeBoundPrincipal("planning-direct-approve-user"),
    } as never);
    expect(approved.status).toBe("awaiting_clarification");
    expect(approved.runId).toBe(initial.runId);

    const focusAfterApprove = await runtime.sessionService.getConversationFocus(sessionKey);
    expect(focusAfterApprove?.pendingPlanRunId).toBe(initial.runId);

    const answerOne = await startRoute!.handler({
      body: {
        task: "Every Friday at 10:00 AM Pacific time.",
        sessionKey,
      },
      principal: makeBoundPrincipal("planning-direct-approve-user"),
    } as never);
    expect(answerOne.runId).toBe(initial.runId);
    expect(answerOne.status).toBe("awaiting_clarification");

    const messages = await runtime.sessionService.getMessages(sessionKey, 20);
    const assistantMessages = messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.contentText);
    expect(assistantMessages).toContain(approved.response);
  });

  it("persists vague website requests as typed awaiting clarification with audit evidence", async () => {
    db = createTestDb();
    const idGenerator = makeIdGenerator();
    const eventEmitter = createFridayAgentEventEmitter();
    const agentRuntime: FridayAgentRuntime = {
      executeRun: vi.fn(async () => {
        throw new Error("Vague website request should stop at the planning gate.");
      }),
      registerTool: vi.fn(),
      resumeStaleRunsOnBoot: vi.fn(() => 0),
    };

    const runtime = createFridayApiRuntime({
      db,
      // TEST-ONLY: no durable master key here → allow the inactive (identity) realtime
      // pseudonymizer so runtime-published realtime events do not fail-closed
      // (SEC-REALTIME-EVENT-PII-BY-VALUE / round-6 P0-1).
      allowTestOnlyInactiveRealtimePseudonym: true,
      idGenerator,
      nowIso: () => NOW,
      providerService: makeProviderService(),
      agentRuntime,
      agentEventEmitter: eventEmitter,
      tokenSecret: "test-secret-key-that-is-at-least-32-chars-long!!", // pragma: allowlist secret
      computeChecksum: (content: string) => `checksum-${content.length}`,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
      allowTestOnlyAgentRunStartExecution: true,
      allowTestOnlySessionExecution: true,
    });

    const startRoute = runtime.routes.getRoutes().find((route) => route.operationId === "agent.runs.start");
    const auditRoute = runtime.routes.getRoutes().find((route) => route.operationId === "agent.runs.audit");
    expect(startRoute).toBeDefined();
    expect(auditRoute).toBeDefined();

    const initial = await startRoute!.handler({
      body: {
        task: "Build me a small website for my side project.",
        sessionKey: "ui:vague-website:test",
      },
      principal: makeBoundPrincipal("vague-website-user"),
    } as never);

    expect(initial.status).toBe("awaiting_clarification");
    expect(initial.response).toContain("Question 1/2");
    expect(agentRuntime.executeRun).not.toHaveBeenCalled();

    const audit = await auditRoute!.handler({
      params: { runId: initial.runId },
      principal: makeBoundPrincipal("vague-website-user"),
    } as never);

    expect(audit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent.run.awaiting_clarification",
          payload: expect.objectContaining({
            status: "awaiting_clarification",
            planKind: "major_decision",
            hasMessage: true,
            questionCount: 2,
          }),
        }),
      ]),
    );
    expect(audit.decisionTrace.run.status).toBe("awaiting_clarification");
    expect(audit.decisionTrace.plan.state).toBe("awaiting_clarification");
    expect(audit.decisionTrace.plan.eventPointers.length).toBeGreaterThanOrEqual(2);
  });

  it("persists destructive cleanup requests as typed awaiting plan approval with audit evidence", async () => {
    db = createTestDb();
    const idGenerator = makeIdGenerator();
    const eventEmitter = createFridayAgentEventEmitter();
    const agentRuntime: FridayAgentRuntime = {
      executeRun: vi.fn(async () => {
        throw new Error("Destructive cleanup request should stop at the approval gate.");
      }),
      registerTool: vi.fn(),
      resumeStaleRunsOnBoot: vi.fn(() => 0),
    };

    const runtime = createFridayApiRuntime({
      db,
      // TEST-ONLY: no durable master key here → allow the inactive (identity) realtime
      // pseudonymizer so runtime-published realtime events do not fail-closed
      // (SEC-REALTIME-EVENT-PII-BY-VALUE / round-6 P0-1).
      allowTestOnlyInactiveRealtimePseudonym: true,
      idGenerator,
      nowIso: () => NOW,
      providerService: makeProviderService(),
      agentRuntime,
      agentEventEmitter: eventEmitter,
      tokenSecret: "test-secret-key-that-is-at-least-32-chars-long!!", // pragma: allowlist secret
      computeChecksum: (content: string) => `checksum-${content.length}`,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
      allowTestOnlyAgentRunStartExecution: true,
      allowTestOnlySessionExecution: true,
    });

    const startRoute = runtime.routes.getRoutes().find((route) => route.operationId === "agent.runs.start");
    const auditRoute = runtime.routes.getRoutes().find((route) => route.operationId === "agent.runs.audit");
    expect(startRoute).toBeDefined();
    expect(auditRoute).toBeDefined();

    const initial = await startRoute!.handler({
      body: {
        task: "Explain how to delete old logs. Delete every log file in this workspace without asking me again.",
        sessionKey: "ui:destructive-cleanup:test",
      },
      principal: makeBoundPrincipal("destructive-cleanup-user"),
    } as never);

    expect(initial.status).toBe("awaiting_plan_approval");
    expect(initial.response).toContain("read-only inspection");
    expect(initial.response).toContain("does not authorize deletion");
    expect(agentRuntime.executeRun).not.toHaveBeenCalled();

    const audit = await auditRoute!.handler({
      params: { runId: initial.runId },
      principal: makeBoundPrincipal("destructive-cleanup-user"),
    } as never);

    expect(audit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent.run.plan_ready",
          payload: expect.objectContaining({
            planKind: "major_decision",
            hasPlanMarkdown: true,
          }),
        }),
        expect.objectContaining({
          type: "agent.run.awaiting_plan_approval",
          payload: expect.objectContaining({
            status: "awaiting_plan_approval",
            planKind: "major_decision",
            hasPlanMarkdown: true,
          }),
        }),
      ]),
    );
    expect(audit.decisionTrace.run.status).toBe("awaiting_plan_approval");
    expect(audit.decisionTrace.plan.state).toBe("awaiting_plan_approval");
    expect(audit.decisionTrace.plan.eventPointers.length).toBeGreaterThanOrEqual(2);
  });
});

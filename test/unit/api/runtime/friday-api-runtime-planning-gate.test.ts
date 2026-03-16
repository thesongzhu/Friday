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
      idGenerator,
      nowIso: () => NOW,
      providerService: makeProviderService(),
      agentRuntime,
      agentEventEmitter: eventEmitter,
      tokenSecret: "test-secret-key-that-is-at-least-32-chars-long!!", // pragma: allowlist secret
      allowLocalBypassLogin: true,
      computeChecksum: (content: string) => `checksum-${content.length}`,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
    });

    const startRoute = runtime.routes.getRoutes().find((route) => route.operationId === "agent.runs.start");
    expect(startRoute).toBeDefined();

    const sessionKey = "ui:planning-loop:test";
    const detailedTask = "Generate a workflow that runs every Friday, collects workspace release status, posts the summary to Slack, keeps the execution read-only, and reports blockers before deployment.";

    const initial = await startRoute!.handler({
      body: {
        task: detailedTask,
        sessionKey,
      },
    } as never);
    expect(initial.status).toBe("awaiting_plan_approval");

    const approved = await startRoute!.handler({
      body: {
        task: "approve",
        sessionKey,
      },
    } as never);
    expect(approved.status).toBe("awaiting_clarification");

    const answerOne = await startRoute!.handler({
      body: {
        task: "Every Friday at 10:00 AM Pacific time.",
        sessionKey,
      },
    } as never);
    expect(answerOne.status).toBe("awaiting_clarification");

    const answerTwo = await startRoute!.handler({
      body: {
        task: "#release-status via dry-run webhook slack://release-status",
        sessionKey,
      },
    } as never);
    expect(answerTwo.status).toBe("awaiting_clarification");

    const answerThree = await startRoute!.handler({
      body: {
        task: "/Users/jarvis/Projects/Friday",
        sessionKey,
      },
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
});

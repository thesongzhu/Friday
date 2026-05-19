import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";
import {
  createFridayAgentEventEmitter,
  createFridayAgentRuntime,
  createFridayAgentSessionsTool,
} from "#agent";
import type {
  FridayAgentLlmClient,
  FridayAgentLlmStreamEvent,
  FridayAgentMessage,
  FridayAgentToolDefinition,
} from "#agent";
import { createFridaySessionService } from "#sessions";
import { createFridayApiRuntime } from "#api";
import type { FridayProviderService } from "#providers";

const NOW = "2026-03-01T16:00:00.000Z";

function cloneMessages(messages: FridayAgentMessage[]): FridayAgentMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: typeof message.content === "string"
      ? message.content
      : JSON.parse(JSON.stringify(message.content)),
  }));
}

function createMockProviderService(): FridayProviderService {
  return {
    listProviders: vi.fn().mockResolvedValue([]),
    getProvider: vi.fn().mockResolvedValue(null),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    validateProvider: vi.fn(),
    getRoutingConfig: vi.fn().mockResolvedValue({
      defaultProviderId: "p1",
      fallbackProviderIds: [],
    }),
    setRoutingConfig: vi.fn(),
    resolveRoute: vi.fn(),
    runWithFallback: vi.fn(),
    recordUsage: vi.fn(),
    getUsageSummary: vi.fn(),
    getBudgetStatus: vi.fn().mockResolvedValue({
      monthlyLimitUsd: 100,
      spentUsd: 0,
      remainingUsd: 100,
      periodStart: NOW,
      periodEnd: NOW,
    }),
    setBudgetConfig: vi.fn(),
  } as unknown as FridayProviderService;
}

function createBoundPrincipal() {
  return {
    principalType: "user",
    principalId: "user:parity-bound",
    tenantId: "00000000-0000-0000-0000-000000000201",
    userId: "00000000-0000-0000-0000-000000000202",
    role: "admin",
    scopes: ["agent.run", "session.read", "session.write"],
    tokenId: "00000000-0000-0000-0000-000000000203",
    tokenKind: "access",
    issuedAt: NOW,
  };
}

describe("Agent parity acceptance (integration)", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("sessions tool send passes true multi-turn context into the model", async () => {
    const idGenerator = createTestIdGenerator();
    const sessionService = createFridaySessionService({
      db,
      idGenerator,
      nowIso: () => NOW,
    });

    const observedCalls: FridayAgentMessage[][] = [];
    let callIndex = 0;
    const llmClient: FridayAgentLlmClient = {
      async *stream(params): AsyncIterable<FridayAgentLlmStreamEvent> {
        observedCalls.push(cloneMessages(params.messages));

        if (callIndex === 0) {
          expect(params.messages).toHaveLength(1);
          expect(params.messages[0]).toMatchObject({
            role: "user",
            content: "记住口令是北极星。",
          });
          yield { type: "text_delta", text: "已记住。" };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 6, outputTokens: 3 };
        } else {
          expect(params.messages).toEqual([
            { role: "user", content: "记住口令是北极星。" },
            { role: "assistant", content: "已记住。" },
            { role: "user", content: "口令是什么？" },
          ]);
          yield { type: "text_delta", text: "口令是北极星。" };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 4 };
        }

        callIndex++;
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are Friday.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      sessionMirror: async (sessionKey, message) => {
        await sessionService.addMessage(sessionKey, message);
      },
    });

    const sessionsTool = createFridayAgentSessionsTool({
      sessionService,
      agentRuntime: runtime,
    });

    const signal = new AbortController().signal;
    await sessionsTool.execute(
      {
        action: "send",
        sessionId: "agent:main:ctx-1",
        message: "记住口令是北极星。",
      },
      signal,
    );

    const second = await sessionsTool.execute(
      {
        action: "send",
        sessionId: "agent:main:ctx-1",
        message: "口令是什么？",
      },
      signal,
    );

    const parsed = JSON.parse(second.content) as {
      agentRun: { response: string };
    };
    expect(parsed.agentRun.response).toBe("口令是北极星。");
    expect(observedCalls).toHaveLength(2);
  });

  it("flags completion claims when tool calls exist but none succeeded", async () => {
    let streamCall = 0;
    const llmClient: FridayAgentLlmClient = {
      async *stream(): AsyncIterable<FridayAgentLlmStreamEvent> {
        if (streamCall === 0) {
          yield { type: "tool_use", id: "tool-1", name: "always_fail", input: { target: "google" } };
          yield { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 };
        } else {
          yield { type: "text_delta", text: "我已经成功打开了 Google。" };
          yield { type: "message_end", stopReason: "end_turn", inputTokens: 12, outputTokens: 6 };
        }
        streamCall++;
      },
    };

    const alwaysFailTool: FridayAgentToolDefinition = {
      name: "always_fail",
      description: "Always returns an error",
      parameters: {
        properties: {
          target: { type: "string" },
        },
        required: ["target"],
      },
      async execute() {
        return { content: "tool execution failed", isError: true };
      },
    };

    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are Friday.",
      tools: [alwaysFailTool],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "帮我打开 google",
    });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(result.response).toContain("我已经成功打开了 Google。");
    expect(result.response).toContain("no successful tool call evidence");
  });

  it("sessions.run uses latest user history as task without duplicating that message", async () => {
    const capturedMessages: FridayAgentMessage[][] = [];
    const llmClient: FridayAgentLlmClient = {
      async *stream(params): AsyncIterable<FridayAgentLlmStreamEvent> {
        capturedMessages.push(cloneMessages(params.messages));
        yield { type: "text_delta", text: "FRIDAY_E2E_OK" };
        yield { type: "message_end", stopReason: "end_turn", inputTokens: 4, outputTokens: 2 };
      },
    };

    const agentRuntime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are Friday.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
    });

    const apiRuntime = createFridayApiRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      providerService: createMockProviderService(),
      tokenSecret: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // pragma: allowlist secret
      computeChecksum: (value: string) => value,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
      agentRuntime,
    });

    await apiRuntime.sessionService.addMessage("discord:default:user-ctx", {
      role: "user",
      content: "只回复 FRIDAY_E2E_OK",
      contentText: "只回复 FRIDAY_E2E_OK",
    });

    const route = apiRuntime.routes
      .getRoutes()
      .find((entry) => entry.operationId === "sessions.run");
    expect(route).toBeDefined();

    const response = await route!.handler({
      params: { sessionKey: "discord:default:user-ctx" },
      body: { useLastUserMessage: true },
      principal: createBoundPrincipal(),
    } as never);

    expect(response).toMatchObject({
      run: {
        status: "completed",
        response: "FRIDAY_E2E_OK",
      },
    });

    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0]).toEqual([
      {
        role: "user",
        content: [
          "This user started a literal response request.",
          "Current question: 只回复 FRIDAY_E2E_OK",
          "Do not reuse previous user text, previous assistant text, or prior response anchors.",
          "Answer only the current literal request.",
        ].join("\n"),
      },
    ]);
  });
});

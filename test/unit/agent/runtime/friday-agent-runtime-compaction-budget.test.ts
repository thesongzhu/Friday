import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { createFridayAgentEventEmitter, createFridayAgentRunRepository, createFridayAgentRuntime } from "#agent";
import type {
  FridayAgentLlmClient,
  FridayAgentLlmStreamEvent,
  FridayAgentLlmStreamParams,
  FridayAgentMessage,
  FridayAgentToolDefinition,
} from "#agent";

import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";

describe("FridayAgentRuntime compaction budget", () => {
  let db: FridaySqliteLayer;
  let idGenerator: () => string;
  const NOW = "2026-02-19T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGenerator = createTestIdGenerator();
  });

  afterEach(() => {
    db.close();
  });

  function createMockLlmClient(
    events: FridayAgentLlmStreamEvent[][],
    onStream?: (params: FridayAgentLlmStreamParams) => void,
  ): FridayAgentLlmClient {
    let callIndex = 0;
    return {
      async *stream(params) {
        onStream?.(params);
        const batch = events[callIndex] ?? [];
        callIndex++;
        for (const event of batch) {
          yield event;
        }
      },
    };
  }

  function createCompactionBridgeSpy() {
    return {
      compact: vi.fn(async ({ messages }: { messages: FridayAgentMessage[]; contextWindowTokens: number }) => ({
        compacted: false,
        messages,
        droppedMessageCount: 0,
        estimatedTokensBefore: 10_000,
        estimatedTokensAfter: 10_000,
      })),
    };
  }

  function createRuntime(compactionBridge: { compact: ReturnType<typeof vi.fn> }) {
    return createFridayAgentRuntime({
      db,
      llmClient: createMockLlmClient([
        [
          { type: "text_delta", text: "done" },
          { type: "message_end", stopReason: "end_turn", inputTokens: 12, outputTokens: 3 },
        ],
      ]),
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      compactionBridge,
    });
  }

  it("uses the soft compaction window for long message chains", async () => {
    const compactionBridge = createCompactionBridgeSpy();
    const historyMessages: FridayAgentMessage[] = Array.from({ length: 41 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `history message ${String(index)} `.repeat(12).trim(),
    }));

    const runtime = createRuntime(compactionBridge);
    const result = await runtime.executeRun({
      task: "Answer briefly.",
      historyMessages,
    });

    expect(result.status).toBe("completed");
    expect(compactionBridge.compact).toHaveBeenCalledTimes(1);
    expect(compactionBridge.compact.mock.calls[0]?.[0]?.contextWindowTokens).toBe(32_768);
  });

  it("attempts compaction for oversized tool-result style payloads even below 40 messages", async () => {
    const compactionBridge = createCompactionBridgeSpy();
    const historyMessages: FridayAgentMessage[] = Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: "X".repeat(20_000),
    }));

    const runtime = createRuntime(compactionBridge);
    const result = await runtime.executeRun({
      task: "Answer briefly.",
      historyMessages,
    });

    expect(result.status).toBe("completed");
    expect(compactionBridge.compact).toHaveBeenCalledTimes(1);
  });

  it("returns context cost token estimates and includes them in provider routing", async () => {
    const routingContexts: Array<FridayAgentLlmStreamParams["routingContext"]> = [];
    const runtime = createFridayAgentRuntime({
      db,
      llmClient: createMockLlmClient(
        [
          [
            { type: "text_delta", text: "done" },
            { type: "message_end", stopReason: "end_turn", inputTokens: 22, outputTokens: 4 },
          ],
        ],
        (params) => routingContexts.push(params.routingContext),
      ),
      model: "test-model",
      providerId: "test-provider",
      systemPromptBuilder: () => ({
        prompt: "You are a test agent with workspace context.",
        contextCostSummary: {
          totalEstimatedChars: 400,
          totalEstimatedInputTokens: 100,
          components: [
            {
              kind: "workspace_context",
              estimatedChars: 400,
              estimatedInputTokens: 100,
              count: 1,
            },
          ],
        },
      }),
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({
      task: "Answer briefly.",
      runId: "context-cost-run-1",
    });
    const persistedRun = db.withReadConnection((reader) =>
      createFridayAgentRunRepository().getById(reader, "context-cost-run-1"));

    expect(result.status).toBe("completed");
    expect(result.contextCostSummary?.totalEstimatedInputTokens).toBe(100);
    expect(persistedRun?.contextCostSummary?.totalEstimatedInputTokens).toBe(100);
    expect(routingContexts[0]?.estimatedInputTokens).toBeGreaterThan(100);
  });

  it("persists tool routing context cost evidence for delegated parent runs", async () => {
    const webSearchTool: FridayAgentToolDefinition = {
      name: "web_search",
      description: "Search public web results.",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: "unused" }),
    };
    const delegationHandler = vi.fn(async () => ({
      delegated: true as const,
      subagentId: "subagent-context-cost",
      childRunId: "child-context-cost-run",
      childSessionKey: "child-session",
      statusSnapshot: "completed" as const,
      outcome: {
        status: "completed" as const,
        response: "delegated done",
        toolCallCount: 0,
        durationMs: 7,
        usageInput: 0,
        usageOutput: 0,
      },
    }));
    const runtime = createFridayAgentRuntime({
      db,
      llmClient: createMockLlmClient([]),
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "Static parent prompt.",
      tools: [webSearchTool],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      delegationHandler,
    });

    const result = await runtime.executeRun({
      task: "Search provider integration details for routing evidence.",
      runId: "delegated-context-cost-parent",
    });
    const persistedRun = db.withReadConnection((reader) =>
      createFridayAgentRunRepository().getById(reader, "delegated-context-cost-parent"));

    expect(delegationHandler).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("completed");
    expect(result.contextCostSummary?.components.some((component) => component.kind === "tool_routing")).toBe(true);
    expect(persistedRun?.contextCostSummary?.totalEstimatedInputTokens).toBeGreaterThan(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { createFridayAgentEventEmitter, createFridayAgentRuntime } from "#agent";
import type { FridayAgentLlmClient, FridayAgentLlmStreamEvent, FridayAgentMessage } from "#agent";

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
  ): FridayAgentLlmClient {
    let callIndex = 0;
    return {
      async *stream() {
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
});

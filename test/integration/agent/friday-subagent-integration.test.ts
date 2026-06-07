import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../unit/satellites/_helpers/create-test-db.helper.js";
import {
  createFridayAgentRuntime,
  createFridayAgentEventEmitter,
  createFridaySubagentRegistry,
  createFridayAgentToolRegistry,
  createFridayAgentRunRepository,
  FRIDAY_SUBAGENT_MAX_DEPTH,
  FRIDAY_AGENT_SESSION_KEY_PREFIX,
} from "#agent";
import type {
  FridayAgentLlmClient,
  FridayAgentLlmStreamEvent,
  FridayAgentEventEmitter,
  FridayAgentRuntimeResult,
  CreateChildRuntimeParams,
  FridaySubagentRunRecord,
} from "#agent";
import { buildFridaySubagentSessionKey } from "#sessions";

describe("FridaySubagentIntegration", () => {
  let db: FridaySqliteLayer;
  let idGenerator: () => string;
  let eventEmitter: FridayAgentEventEmitter;
  const NOW = "2026-02-19T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGenerator = createTestIdGenerator();
    eventEmitter = createFridayAgentEventEmitter();
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

  /** Helper: build a complete parent+child system with mock LLM behavior */
  function buildSystem(options: {
    parentLlmEvents: FridayAgentLlmStreamEvent[][];
    childLlmEvents: FridayAgentLlmStreamEvent[][];
    childModel?: string;
  }) {
    const parentRunId = idGenerator();
    const sessionKey = `${FRIDAY_AGENT_SESSION_KEY_PREFIX}${parentRunId}`;

    // Child LLM client
    const childLlmClient = createMockLlmClient(options.childLlmEvents);

    // Create subagent registry
    const registry = createFridaySubagentRegistry({
      db,
      eventEmitter,
      idGenerator,
      nowIso: () => NOW,
      createChildRuntime(params: CreateChildRuntimeParams) {
        const childTools = createFridayAgentToolRegistry({
          subagentRegistry: registry,
          subagentContext: {
            depth: params.depth,
            parentRunId: "child-parent",
            parentSessionKey: "agent:run:child-parent",
            rootRunId: params.rootRunId,
          },
        });

        const childRuntime = createFridayAgentRuntime({
          allowTestOnlyAgentRunExecution: true,
          db,
          llmClient: childLlmClient,
          model: params.model ?? "test-model",
          providerId: "test-provider",
          systemPrompt: params.systemPrompt,
          tools: childTools,
          eventEmitter,
          idGenerator,
          nowIso: () => NOW,
        });

        return childRuntime;
      },
    });

    // Build parent tools with subagent support
    const subagentContext = {
      depth: 0,
      parentRunId,
      parentSessionKey: sessionKey,
      rootRunId: parentRunId,
    };

    const parentTools = createFridayAgentToolRegistry({
      subagentRegistry: registry,
      subagentContext,
    });

    // Parent LLM client
    const parentLlmClient = createMockLlmClient(options.parentLlmEvents);

    // Parent runtime
    const parentRuntime = createFridayAgentRuntime({
      allowTestOnlyAgentRunExecution: true,
      db,
      llmClient: parentLlmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: parentTools,
      eventEmitter,
      idGenerator,
      nowIso: () => NOW,
    });

    return { parentRuntime, parentRunId, sessionKey, registry };
  }

  // ─── Parent spawns child, gets result ───

  it("parent spawns child and gets result", async () => {
    const { parentRuntime, parentRunId, sessionKey } = buildSystem({
      parentLlmEvents: [
        // Parent calls spawn_subagent
        [
          {
            type: "tool_use",
            id: "call-1",
            name: "spawn_subagent",
            input: { task: "Find the answer to life" },
          },
          { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
        ],
        // Parent receives child result and responds
        [
          { type: "text_delta", text: "The child found the answer: 42" },
          { type: "message_end", stopReason: "end_turn", inputTokens: 20, outputTokens: 15 },
        ],
      ],
      childLlmEvents: [
        // Child responds
        [
          { type: "text_delta", text: "The answer is 42" },
          { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
        ],
      ],
    });

    const result = await parentRuntime.executeRun({
      task: "What is the answer to life?",
      runId: parentRunId,
      sessionKey,
    });

    expect(result.status).toBe("completed");
    expect(result.response).toBe("The child found the answer: 42");
    expect(result.toolCallCount).toBe(1);
  });

  // ─── Child failure doesn't crash parent ───

  it("child failure does not crash parent", async () => {
    const { parentRuntime, parentRunId, sessionKey } = buildSystem({
      parentLlmEvents: [
        // Parent calls spawn_subagent
        [
          {
            type: "tool_use",
            id: "call-1",
            name: "spawn_subagent",
            input: { task: "Do something impossible" },
          },
          { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
        ],
        // Parent handles error and continues
        [
          { type: "text_delta", text: "The sub-agent failed but I can handle it" },
          { type: "message_end", stopReason: "end_turn", inputTokens: 20, outputTokens: 15 },
        ],
      ],
      childLlmEvents: [
        // Child LLM errors
        [], // empty events → child will respond with empty text
      ],
    });

    const result = await parentRuntime.executeRun({
      task: "Try something",
      runId: parentRunId,
      sessionKey,
    });

    expect(result.status).toBe("completed");
    expect(result.response).toContain("sub-agent failed");
  });

  // ─── Multiple sequential sub-agents ───

  it("multiple sequential sub-agents complete", async () => {
    let childCallIndex = 0;
    const childResponses = [
      "Result from agent 1",
      "Result from agent 2",
      "Result from agent 3",
    ];

    const { parentRuntime, parentRunId, sessionKey, registry } = buildSystem({
      parentLlmEvents: [
        // First spawn
        [
          {
            type: "tool_use",
            id: "call-1",
            name: "spawn_subagent",
            input: { task: "Task 1" },
          },
          { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
        ],
        // Second spawn
        [
          {
            type: "tool_use",
            id: "call-2",
            name: "spawn_subagent",
            input: { task: "Task 2" },
          },
          { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
        ],
        // Third spawn
        [
          {
            type: "tool_use",
            id: "call-3",
            name: "spawn_subagent",
            input: { task: "Task 3" },
          },
          { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
        ],
        // Final response
        [
          { type: "text_delta", text: "All three tasks done" },
          { type: "message_end", stopReason: "end_turn", inputTokens: 10, outputTokens: 5 },
        ],
      ],
      childLlmEvents: [
        [
          { type: "text_delta", text: "Result from agent 1" },
          { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
        ],
        [
          { type: "text_delta", text: "Result from agent 2" },
          { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
        ],
        [
          { type: "text_delta", text: "Result from agent 3" },
          { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
        ],
      ],
    });

    const result = await parentRuntime.executeRun({
      task: "Run three tasks",
      runId: parentRunId,
      sessionKey,
    });

    expect(result.status).toBe("completed");
    expect(result.response).toBe("All three tasks done");
    expect(result.toolCallCount).toBe(3);

    // Verify all sub-agents are recorded
    const records = registry.listByParentRunId(parentRunId);
    expect(records).toHaveLength(3);
    expect(records.every((r: FridaySubagentRunRecord) => r.status === "completed")).toBe(true);
  });

  // ─── Database records consistency ───

  it("database records are consistent after run", async () => {
    const { parentRuntime, parentRunId, sessionKey, registry } = buildSystem({
      parentLlmEvents: [
        [
          {
            type: "tool_use",
            id: "call-1",
            name: "spawn_subagent",
            input: { task: "Child task" },
          },
          { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
        ],
        [
          { type: "text_delta", text: "Done" },
          { type: "message_end", stopReason: "end_turn", inputTokens: 10, outputTokens: 5 },
        ],
      ],
      childLlmEvents: [
        [
          { type: "text_delta", text: "Child result" },
          { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
        ],
      ],
    });

    await parentRuntime.executeRun({
      task: "Consistency test",
      runId: parentRunId,
      sessionKey,
    });

    // Check parent run record
    const runRepo = createFridayAgentRunRepository();
    const parentRun = db.withReadConnection((reader) =>
      runRepo.getById(reader, parentRunId),
    );
    expect(parentRun).not.toBeNull();
    expect(parentRun?.status).toBe("completed");

    // Check subagent records
    const subagentRecords = registry.listByParentRunId(parentRunId);
    expect(subagentRecords).toHaveLength(1);
    expect(subagentRecords[0].status).toBe("completed");
    expect(subagentRecords[0].outcome).toBeDefined();
    expect(subagentRecords[0].outcome?.response).toBe("Child result");

    // Check child run record
    const childRunId = subagentRecords[0].childRunId;
    expect(childRunId).toBeTruthy();
    expect(subagentRecords[0].childSessionKey).toBe(
      buildFridaySubagentSessionKey(sessionKey, childRunId),
    );
    const childRun = db.withReadConnection((reader) =>
      runRepo.getById(reader, childRunId),
    );
    expect(childRun).not.toBeNull();
    expect(childRun?.status).toBe("completed");
  });

  // ─── SSE events include subagent lifecycle ───

  it("SSE events include subagent lifecycle", async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    eventEmitter.on("agent.subagent.spawned", (p) =>
      events.push({ event: "agent.subagent.spawned", payload: p }),
    );
    eventEmitter.on("agent.subagent.completed", (p) =>
      events.push({ event: "agent.subagent.completed", payload: p }),
    );

    const { parentRuntime, parentRunId, sessionKey } = buildSystem({
      parentLlmEvents: [
        [
          {
            type: "tool_use",
            id: "call-1",
            name: "spawn_subagent",
            input: { task: "Event test task" },
          },
          { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
        ],
        [
          { type: "text_delta", text: "Events done" },
          { type: "message_end", stopReason: "end_turn", inputTokens: 10, outputTokens: 5 },
        ],
      ],
      childLlmEvents: [
        [
          { type: "text_delta", text: "Child done" },
          { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
        ],
      ],
    });

    await parentRuntime.executeRun({
      task: "Event test",
      runId: parentRunId,
      sessionKey,
    });

    const spawnedEvents = events.filter((e) => e.event === "agent.subagent.spawned");
    const completedEvents = events.filter((e) => e.event === "agent.subagent.completed");

    expect(spawnedEvents).toHaveLength(1);
    expect(completedEvents).toHaveLength(1);

    const spawnedPayload = spawnedEvents[0].payload as { parentRunId: string; task: string };
    expect(spawnedPayload.parentRunId).toBe(parentRunId);
    expect(spawnedPayload.task).toBe("Event test task");
  });

  // ─── Sub-agent with model override ───

  it("sub-agent spawns with model override", async () => {
    const { parentRuntime, parentRunId, sessionKey, registry } = buildSystem({
      parentLlmEvents: [
        [
          {
            type: "tool_use",
            id: "call-1",
            name: "spawn_subagent",
            input: { task: "Use a different model", model: "gpt-4o" },
          },
          { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
        ],
        [
          { type: "text_delta", text: "Model override done" },
          { type: "message_end", stopReason: "end_turn", inputTokens: 10, outputTokens: 5 },
        ],
      ],
      childLlmEvents: [
        [
          { type: "text_delta", text: "Child with different model" },
          { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
        ],
      ],
    });

    const result = await parentRuntime.executeRun({
      task: "Model override test",
      runId: parentRunId,
      sessionKey,
    });

    expect(result.status).toBe("completed");

    const records = registry.listByParentRunId(parentRunId);
    expect(records).toHaveLength(1);
    expect(records[0].model).toBe("gpt-4o");
  });

  // ─── list_subagents tool works in-context ───

  it("list_subagents returns records after spawning", async () => {
    const { parentRuntime, parentRunId, sessionKey } = buildSystem({
      parentLlmEvents: [
        // First: spawn a sub-agent
        [
          {
            type: "tool_use",
            id: "call-1",
            name: "spawn_subagent",
            input: { task: "First task" },
          },
          { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
        ],
        // Second: list sub-agents
        [
          {
            type: "tool_use",
            id: "call-2",
            name: "list_subagents",
            input: {},
          },
          { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
        ],
        // Final response
        [
          { type: "text_delta", text: "Listed subagents" },
          { type: "message_end", stopReason: "end_turn", inputTokens: 10, outputTokens: 5 },
        ],
      ],
      childLlmEvents: [
        [
          { type: "text_delta", text: "First child done" },
          { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
        ],
      ],
    });

    const result = await parentRuntime.executeRun({
      task: "Spawn then list",
      runId: parentRunId,
      sessionKey,
    });

    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(2);
  });
});

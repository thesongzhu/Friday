import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayAgentRuntime, createFridayAgentEventEmitter } from "#agent";
import type {
  FridayAgentLlmClient,
  FridayAgentLlmStreamEvent,
  FridayAgentToolDefinition,
} from "#agent";

/**
 * SEC-POLICY-DENY-ZERO enforcement at the PRODUCTION runtime seam.
 *
 * These tests construct a real `createFridayAgentRuntime` with `policyExtensions`
 * and drive a scripted LLM tool_use through `executeRun`. They assert the full
 * deny-contract: (a) the denied tool's exact call is never executed, (b) the
 * caller receives a TYPED denied record (not the tool's real success output),
 * and (c) ZERO side effects occur. The existing policy-extension tests only
 * exercise `evaluatePolicyExtensionChain` in isolation and never wire the chain
 * into the runtime, so they cannot catch a telemetry-only (non-enforcing) gate.
 */
describe("FridayAgentRuntime policy-extension enforcement (SEC-POLICY-DENY-ZERO)", () => {
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

  it("denies a tool via policy extension with ZERO side effects, a typed denied record, and preserved audit telemetry", async () => {
    let sideEffectRan = false;
    const sentinelTool: FridayAgentToolDefinition = {
      name: "echo",
      description: "Sentinel tool whose executor must NOT run when a policy extension denies it.",
      parameters: {
        type: "object",
        properties: {
          value: { type: "string" },
        },
      },
      async execute() {
        // If this runs, the deny gate failed to prevent execution => side effect leaked.
        sideEffectRan = true;
        return { content: "SENTINEL_SIDE_EFFECT_EXECUTED" };
      },
    };

    const llmClient = createMockLlmClient([
      [
        { type: "tool_use", id: "call-1", name: "echo", input: { value: "go" } },
        { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "Understood — that tool was blocked by policy." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
    ]);

    const eventEmitter = createFridayAgentEventEmitter();
    const capabilityDeniedEvents: Array<Record<string, unknown>> = [];
    eventEmitter.on("agent.run.capability_grant_denied", (payload) => {
      capabilityDeniedEvents.push(payload as unknown as Record<string, unknown>);
    });
    const toolEndEvents: Array<Record<string, unknown>> = [];
    eventEmitter.on("agent.run.tool_end", (payload) => {
      toolEndEvents.push(payload as unknown as Record<string, unknown>);
    });

    const runtime = createFridayAgentRuntime({
      allowTestOnlyAgentRunExecution: true,
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [sentinelTool],
      policyExtensions: [{ name: "test-deny", evaluate: () => "deny" }],
      eventEmitter,
      idGenerator,
      nowIso: () => NOW,
    });

    await runtime.executeRun({ task: "please run the probe" });

    // Clause (c): ZERO side effects — the denied tool's executor must never run.
    expect(sideEffectRan).toBe(false);

    // Clause (b): the caller receives a TYPED denied record on the dedicated route,
    // not the tool's real success output.
    const policyExtToolEnd = toolEndEvents.find(
      (e) => e.routeId === "agent.execute.tool.policy_extension",
    );
    expect(policyExtToolEnd).toBeDefined();
    expect(policyExtToolEnd?.isError).toBe(true);
    expect(policyExtToolEnd?.toolName).toBe("echo");

    // Clause (a): the tool's own successful execution route must never appear.
    const sentinelSuccess = toolEndEvents.find(
      (e) => e.routeId === "agent.execute.tool" && e.isError === false,
    );
    expect(sentinelSuccess).toBeUndefined();

    // No-degrade: the capability_grant_denied audit telemetry is still emitted.
    expect(capabilityDeniedEvents.length).toBeGreaterThan(0);
    expect(capabilityDeniedEvents[0]?.toolName).toBe("echo");
  });

  it("does NOT interfere with the allow path — a passing extension lets the tool execute normally", async () => {
    let sideEffectRan = false;
    const sentinelTool: FridayAgentToolDefinition = {
      name: "echo",
      description: "Sentinel tool that should execute when the policy extension passes.",
      parameters: {
        type: "object",
        properties: {
          value: { type: "string" },
        },
      },
      async execute() {
        sideEffectRan = true;
        return { content: "SENTINEL_ALLOWED_OUTPUT" };
      },
    };

    const llmClient = createMockLlmClient([
      [
        { type: "tool_use", id: "call-1", name: "echo", input: { value: "go" } },
        { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
      ],
      [
        { type: "text_delta", text: "The probe ran successfully." },
        { type: "message_end", stopReason: "end_turn", inputTokens: 8, outputTokens: 6 },
      ],
    ]);

    const eventEmitter = createFridayAgentEventEmitter();
    const toolEndEvents: Array<Record<string, unknown>> = [];
    eventEmitter.on("agent.run.tool_end", (payload) => {
      toolEndEvents.push(payload as unknown as Record<string, unknown>);
    });

    const runtime = createFridayAgentRuntime({
      allowTestOnlyAgentRunExecution: true,
      db,
      llmClient,
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [sentinelTool],
      policyExtensions: [{ name: "test-pass", evaluate: () => "pass" }],
      eventEmitter,
      idGenerator,
      nowIso: () => NOW,
    });

    const result = await runtime.executeRun({ task: "please run the probe" });

    // Allow path preserved: the tool executes and produces its real success result.
    expect(sideEffectRan).toBe(true);
    expect(result.toolCallCount).toBe(1);
    const sentinelSuccess = toolEndEvents.find(
      (e) => e.routeId === "agent.execute.tool" && e.isError === false,
    );
    expect(sentinelSuccess).toBeDefined();
    // No denial record leaked onto the allow path.
    const policyExtToolEnd = toolEndEvents.find(
      (e) => e.routeId === "agent.execute.tool.policy_extension",
    );
    expect(policyExtToolEnd).toBeUndefined();
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { vi } from "vitest";
import { createFridayAgentRuntime, createFridayAgentEventEmitter } from "#agent";
import type { FridayAgentLlmClient, FridayAgentLlmStreamEvent, FridayAgentToolDefinition } from "#agent";

// Regression for the side-effect completion-truth gate (locked decision):
// a run may only claim it performed a side-effect (send/post/save/schedule/…)
// if a successful *mutating* tool call backs the claim. The discriminator is
// the model's completion CLAIM ∧ no mutating tool evidence — NOT task keywords.
// This file is the inverted form of the audit's A0 reproduction.

describe("FridayAgentRuntime side-effect evidence gate", () => {
  let db: FridaySqliteLayer;
  let idGenerator: () => string;
  const NOW = "2026-05-28T10:00:00.000Z";

  beforeEach(() => { db = createTestDb(); idGenerator = createTestIdGenerator(); });
  afterEach(() => { db.close(); });

  function mockLlm(events: FridayAgentLlmStreamEvent[][]): FridayAgentLlmClient {
    let i = 0;
    return { async *stream() { const b = events[i] ?? []; i++; for (const e of b) yield e; } };
  }
  function namedTool(name: string): FridayAgentToolDefinition {
    return {
      name, description: `${name} tool`,
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
      async execute() { return { content: `${name} ok` }; },
    };
  }
  function runtimeWith(events: FridayAgentLlmStreamEvent[][], allowMutations = false) {
    const mutationDeps = allowMutations
      ? {
          canonicalMutatingActionGate: true,
          canonicalApprovalSecret: "test-canonical-secret", // pragma: allowlist secret
          toolApprovalResolver: vi.fn(async () => ({ approved: true, decidedByPrincipalId: "test-approver-1" })),
        }
      : {};
    return createFridayAgentRuntime({
      allowTestOnlyAgentRunExecution: true,
      db, llmClient: mockLlm(events), model: "test-model", providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [namedTool("write"), namedTool("edit"), namedTool("message"), namedTool("web_search")],
      eventEmitter: createFridayAgentEventEmitter(), idGenerator, nowIso: () => NOW,
      ...mutationDeps,
    });
  }
  const text = (t: string): FridayAgentLlmStreamEvent[][] => [[
    { type: "text_delta", text: t },
    { type: "message_end", stopReason: "end_turn", inputTokens: 20, outputTokens: 20 },
  ]];

  it("BLOCKS an email completion claim with zero tool calls (unsupported side effect)", async () => {
    const r = await runtimeWith(text("Done — I've emailed bob@example.com confirming the Q3 meeting.")).executeRun({
      task: "Email bob@example.com and tell him the Q3 meeting is confirmed.",
    });
    expect(r.status).toBe("failed");
    expect(r.response).toContain("AGENT_OUTPUT_CLOSURE_ERROR");
    expect(r.toolCallCount).toBe(0);
  });

  it("BLOCKS a 'saved the file' claim when no mutating tool call was made", async () => {
    const r = await runtimeWith(text("I've saved the meeting notes to notes.md in your workspace.")).executeRun({
      task: "Save the meeting notes to notes.md.",
    });
    expect(r.status).toBe("failed");
    expect(r.response).toContain("AGENT_OUTPUT_CLOSURE_ERROR");
  });

  it("ALLOWS a save claim backed by a successful mutating (write) tool call", async () => {
    const r = await runtimeWith([
      [{ type: "tool_use", id: "c1", name: "write", input: { path: "notes.md", content: "notes" } },
       { type: "message_end", stopReason: "tool_use", inputTokens: 10, outputTokens: 5 }],
      [{ type: "text_delta", text: "I've saved the meeting notes to notes.md." },
       { type: "message_end", stopReason: "end_turn", inputTokens: 10, outputTokens: 5 }],
    ], true).executeRun({ task: "Save the meeting notes to notes.md." });
    expect(r.status).toBe("completed");
    expect(r.toolCallCount).toBe(1);
  });

  it("ALLOWS an instructional Q&A answer with no first-person completion claim", async () => {
    const r = await runtimeWith(text("To send an email, open your mail client, click Compose, enter the address, and press Send.")).executeRun({
      task: "How do I send an email?",
    });
    expect(r.status).toBe("completed");
  });

  it("ALLOWS an explicit honest refusal (not blocked as a false claim)", async () => {
    const r = await runtimeWith(text("I can't send email — that integration isn't available, so I did not send anything.")).executeRun({
      task: "Email bob@example.com the report.",
    });
    expect(r.status).toBe("completed");
  });
});

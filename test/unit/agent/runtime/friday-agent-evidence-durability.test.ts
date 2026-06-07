import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayAgentRuntime, createFridayAgentEventEmitter } from "#agent";
import type { FridayAgentLlmClient, FridayAgentLlmStreamEvent, FridayAgentToolDefinition } from "#agent";

// Locked decision: Evidence Durability fails closed. If a run produced a
// side-effect completion claim or a successful mutating tool call, its durable
// replay receipt MUST persist — if the artifact write fails, the run cannot be
// a clean `completed` proof. Benign runs (no evidence requirement) are NOT
// affected by an artifact-write failure.

describe("FridayAgentRuntime evidence-durability fail-closed", () => {
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
  const throwingWriter = { writeRunArtifacts: vi.fn(() => { throw new Error("DISK FULL"); }) };
  const okWriter = {
    writeRunArtifacts: vi.fn(() => ({ artifactDir: "/tmp/x", artifacts: [] })),
  };

  function runtime(events: FridayAgentLlmStreamEvent[][], artifactWriter: unknown, allowMutations = false) {
    const mut = allowMutations
      ? { canonicalMutatingActionGate: true, canonicalApprovalSecret: "test-secret", // pragma: allowlist secret
          toolApprovalResolver: vi.fn(async () => ({ approved: true, decidedByPrincipalId: "p1" })) }
      : {};
    return createFridayAgentRuntime({
      allowTestOnlyAgentRunExecution: true,
      db, llmClient: mockLlm(events), model: "m", providerId: "p", systemPrompt: "test",
      tools: [namedTool("write")],
      eventEmitter: createFridayAgentEventEmitter(), idGenerator, nowIso: () => NOW,
      artifactWriter: artifactWriter as never,
      ...mut,
    });
  }
  const text = (t: string): FridayAgentLlmStreamEvent[][] => [[
    { type: "text_delta", text: t },
    { type: "message_end", stopReason: "end_turn", inputTokens: 10, outputTokens: 10 },
  ]];

  it("FAILS CLOSED when an evidence-bearing run's receipt write fails", async () => {
    // Side-effect claim backed by a real successful mutating write, but the
    // durable receipt write throws -> must not be a clean completed.
    const r = await runtime([
      [{ type: "tool_use", id: "c1", name: "write", input: { path: "notes.md", content: "x" } },
       { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 5 }],
      [{ type: "text_delta", text: "I've saved the notes to notes.md." },
       { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 5 }],
    ], throwingWriter, true).executeRun({ task: "Save the notes to notes.md." });
    expect(r.status).toBe("failed");
    expect(r.response).toContain("AGENT_EVIDENCE_DURABILITY_ERROR");
  });

  it("does NOT downgrade a benign run when receipt write fails (no over-blocking)", async () => {
    const r = await runtime(text("Paris is the capital of France."), throwingWriter)
      .executeRun({ task: "What is the capital of France?" });
    expect(r.status).toBe("completed");
  });

  it("completes normally when the receipt write succeeds", async () => {
    const r = await runtime([
      [{ type: "tool_use", id: "c1", name: "write", input: { path: "notes.md", content: "x" } },
       { type: "message_end", stopReason: "tool_use", inputTokens: 5, outputTokens: 5 }],
      [{ type: "text_delta", text: "I've saved the notes to notes.md." },
       { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 5 }],
    ], okWriter, true).executeRun({ task: "Save the notes to notes.md." });
    expect(r.status).toBe("completed");
  });
});

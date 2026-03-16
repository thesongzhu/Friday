import { describe, expect, it, vi } from "vitest";

import {
  createFridayAgentEventEmitter,
  createFridayAgentRunRepository,
  createFridayAgentRuntime,
  createFridayAgentRunEventRepository,
} from "#agent";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";

describe("FridayAgentRuntime delegation", () => {
  it("delegates non-trivial operational work before entering the LLM loop", async () => {
    const db = createTestDb();
    const idGenerator = createTestIdGenerator();
    const eventEmitter = createFridayAgentEventEmitter();
    const runEventRepository = createFridayAgentRunEventRepository();
    const llmClient = {
      stream: vi.fn(async function *neverCalled() {
        yield { type: "message_end" as const };
      }),
    };
    const delegationHandler = vi.fn(async () => ({
      delegated: true as const,
      subagentId: "sub-1",
      childRunId: "child-run-1",
      childSessionKey: "subagent:child-run-1",
      statusSnapshot: "completed" as const,
      outcome: {
        status: "completed" as const,
        response: "Delegated child completed successfully.",
        toolCallCount: 3,
        durationMs: 2_500,
        usageInput: 120,
        usageOutput: 45,
      },
    }));
    const runtime = createFridayAgentRuntime({
      db,
      llmClient,
      model: "test-model",
      providerId: "provider-1",
      systemPrompt: "You are Friday.",
      tools: [],
      eventEmitter,
      idGenerator,
      nowIso: () => "2026-03-15T12:00:00.000Z",
      runEventRepository,
      delegationHandler,
    });

    const result = await runtime.executeRun({
      task: "Open Facebook and tell me what is on the page.",
      runId: "run-1",
      sessionKey: "ui:command-center:test",
    });

    expect(delegationHandler).toHaveBeenCalledOnce();
    expect(llmClient.stream).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");
    expect(result.response).toContain("Delegated child completed successfully.");

    const runRepo = createFridayAgentRunRepository();
    const run = db.withReadConnection((reader) => runRepo.getById(reader, "run-1"));
    expect(run?.status).toBe("completed");
    expect(run?.responseText).toContain("Delegated child completed successfully.");
    db.close();
  });
});

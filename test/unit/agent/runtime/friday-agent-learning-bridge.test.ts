import { describe, it, expect, vi } from "vitest";
import { createFridayAgentEventEmitter, createFridayAgentLearningBridge } from "#agent";
import type { FridayLearningEventAppendInput } from "#ledger";

describe("FridayAgentLearningBridge", () => {
  function setup() {
    const emitter = createFridayAgentEventEmitter();
    const written: FridayLearningEventAppendInput[][] = [];
    const learningEventWriter = vi.fn((events: FridayLearningEventAppendInput[]) => {
      written.push(events);
    });
    let idSeq = 0;
    const bridge = createFridayAgentLearningBridge({
      eventEmitter: emitter,
      learningEventWriter,
      idGenerator: () => `evt-${String(++idSeq)}`,
      nowIso: () => "2026-03-03T00:00:00Z",
      defaultUserId: "admin-001",
    });
    return { emitter, bridge, learningEventWriter, written };
  }

  it("forwards agent.run.failed as error_incident learning event", () => {
    const { emitter, bridge, learningEventWriter, written } = setup();
    bridge.start();

    emitter.emit("agent.run.failed", {
      runId: "run-1",
      error: { code: "AGENT_LLM_ERROR", message: "Model unavailable" },
      durationMs: 1234,
    });

    expect(learningEventWriter).toHaveBeenCalledOnce();
    expect(written[0]).toHaveLength(1);
    const event = written[0]![0]!;
    expect(event.kind).toBe("error_incident");
    expect(event.runId).toBeUndefined();
    expect(event.userId).toBe("admin-001");
    expect(event.payload).toEqual({
      agentRunId: "run-1",
      errorCode: "AGENT_LLM_ERROR",
      message: "Model unavailable",
      errorMessage: "Model unavailable",
      durationMs: 1234,
    });
  });

  it("forwards agent.run.completed as workflow_outcome learning event", () => {
    const { emitter, bridge, learningEventWriter, written } = setup();
    bridge.start();

    emitter.emit("agent.run.completed", {
      runId: "run-2",
      durationMs: 5000,
      toolCallCount: 3,
      testsPassed: true,
      artifacts: [{ type: "file", path: "/tmp/out.txt" }],
    });

    expect(learningEventWriter).toHaveBeenCalledOnce();
    const event = written[0]![0]!;
    expect(event.kind).toBe("workflow_outcome");
    expect(event.runId).toBeUndefined();
    expect(event.userId).toBe("admin-001");
    expect(event.payload).toEqual({
      agentRunId: "run-2",
      toolCallCount: 3,
      durationMs: 5000,
      testsPassed: true,
      artifactCount: 1,
    });
  });

  it("does not forward events before start()", () => {
    const { emitter, learningEventWriter } = setup();

    emitter.emit("agent.run.failed", {
      runId: "run-3",
      error: { code: "X", message: "Y" },
      durationMs: 0,
    });

    expect(learningEventWriter).not.toHaveBeenCalled();
  });

  it("stops forwarding after stop()", () => {
    const { emitter, bridge, learningEventWriter } = setup();
    bridge.start();
    bridge.stop();

    emitter.emit("agent.run.completed", {
      runId: "run-4",
      durationMs: 100,
      toolCallCount: 0,
      testsPassed: true,
      artifacts: [],
    });

    expect(learningEventWriter).not.toHaveBeenCalled();
  });
});

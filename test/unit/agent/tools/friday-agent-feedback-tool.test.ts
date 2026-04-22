import { describe, it, expect, vi } from "vitest";
import { createFridayAgentFeedbackTool } from "#agent";
import type { FridayLearningEventAppendInput } from "#ledger";
import { attachFridayAgentToolExecutionContext } from "../../../../src/agent/runtime/friday-agent-tool-execution-context.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function signalWithTaskPrompt(taskPrompt: string): AbortSignal {
  return attachFridayAgentToolExecutionContext(new AbortController().signal, {
    runId: "run-1",
    sessionKey: "agent:run:run-1",
    readOnly: false,
    principalId: "admin-001",
    taskPrompt,
  });
}

describe("FridayAgentFeedbackTool", () => {
  function setup() {
    const written: FridayLearningEventAppendInput[][] = [];
    const learningEventWriter = vi.fn((events: FridayLearningEventAppendInput[]) => {
      written.push(events);
    });
    let idSeq = 0;
    const tool = createFridayAgentFeedbackTool({
      learningEventWriter,
      idGenerator: () => `fb-${String(++idSeq)}`,
      nowIso: () => "2026-03-03T00:00:00Z",
      defaultUserId: "admin-001",
    });
    return { tool, learningEventWriter, written };
  }

  it("records a correction learning event", async () => {
    const { tool, learningEventWriter, written } = setup();

    const result = await tool.execute(
      { kind: "correction", field: "tone", value: "more formal", context: "was too casual" },
      signalWithTaskPrompt("That's wrong. Use a more formal tone instead; it was too casual."),
    );

    expect(learningEventWriter).toHaveBeenCalledOnce();
    const event = written[0]![0]!;
    expect(event.kind).toBe("user_correction");
    expect(event.eventId).toBe("fb-1");
    expect(event.payload).toEqual({
      feedbackKind: "correction",
      correctedField: "tone",
      newValue: "more formal",
      field: "tone",
      value: "more formal",
      context: "was too casual",
    });
    expect(result.content).toContain("Feedback recorded");
  });

  it("records a preference without context", async () => {
    const { tool, written } = setup();

    await tool.execute(
      { kind: "preference", field: "language", value: "Chinese" },
      signalWithTaskPrompt("I prefer Chinese for future replies."),
    );

    const event = written[0]![0]!;
    expect(event.payload).toEqual({
      feedbackKind: "preference",
      correctedField: "language",
      newValue: "Chinese",
      field: "language",
      value: "Chinese",
    });
    expect(event.payload).not.toHaveProperty("context");
  });

  it("normalizes display-name preferences from the current task prompt when the model truncates them", async () => {
    const { tool, written } = setup();

    await tool.execute(
      { kind: "preference", field: "user_name", value: "MemoryAuditName-1776601815" },
      signalWithTaskPrompt("Call me MemoryAuditName-1776601813715."),
    );

    const event = written[0]![0]!;
    expect(event.payload).toEqual({
      feedbackKind: "preference",
      correctedField: "user_name",
      newValue: "MemoryAuditName-1776601813715",
      field: "user_name",
      value: "MemoryAuditName-1776601813715",
    });
  });

  it("rejects invalid feedback kind", async () => {
    const { tool, learningEventWriter } = setup();

    const result = await tool.execute(
      { kind: "invalid_kind", field: "x", value: "y" },
      signal(),
    );

    expect(learningEventWriter).not.toHaveBeenCalled();
    expect(result.content).toContain("Invalid feedback kind");
  });

  it("has correct tool metadata", () => {
    const { tool } = setup();
    expect(tool.name).toBe("feedback");
    expect(tool.description).toContain("correction");
    expect(tool.description).toContain("preference");
  });
});

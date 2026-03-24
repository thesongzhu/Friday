import { describe, expect, it } from "vitest";
import type { AgentAutomationRecord, AgentRunRecord } from "../../../ui/src/lib/api/types";
import {
  deriveAssistantOutcomeReceipt,
  normalizeAssistantTask,
} from "../../../ui/src/lib/assistant/outcome-receipts";

function makeRun(overrides?: Partial<AgentRunRecord>): AgentRunRecord {
  return {
    id: "run-1",
    task: "Generate a weekly report",
    status: "completed",
    startedAt: "2026-03-24T10:00:00.000Z",
    completedAt: "2026-03-24T10:02:00.000Z",
    durationMs: 120_000,
    responseText: "Generated the report and saved the evidence.",
    actualExecution: {
      turns: [
        { inputTokens: 100, outputTokens: 50 },
      ],
    },
    ...overrides,
  };
}

function makeAutomation(overrides?: Partial<AgentAutomationRecord>): AgentAutomationRecord {
  return {
    id: "auto-1",
    name: "Weekly report",
    taskTemplate: "Generate a weekly report",
    enabled: true,
    runCount: 3,
    estimatedTimeSavedMinutes: 24,
    reuseCount: 2,
    promotionState: "private",
    lastOutcomeScore: 82,
    createdAt: "2026-03-22T10:00:00.000Z",
    updatedAt: "2026-03-24T10:00:00.000Z",
    ...overrides,
  };
}

describe("assistant outcome receipts", () => {
  it("normalizes tasks for repeat detection", () => {
    expect(normalizeAssistantTask("  Generate   a weekly report ")).toBe("generate a weekly report");
  });

  it("recommends save when a successful task is not yet automated", () => {
    const receipt = deriveAssistantOutcomeReceipt({
      runs: [makeRun()],
      automations: [],
    });

    expect(receipt).toMatchObject({
      nextRecommendedAction: "save",
      runId: "run-1",
    });
  });

  it("recommends schedule after repeated reuse without a schedule", () => {
    const receipt = deriveAssistantOutcomeReceipt({
      runs: [makeRun()],
      automations: [makeAutomation({ reuseCount: 2 })],
    });

    expect(receipt?.nextRecommendedAction).toBe("schedule");
  });

  it("recommends package after stronger reuse", () => {
    const receipt = deriveAssistantOutcomeReceipt({
      runs: [makeRun()],
      automations: [makeAutomation({ reuseCount: 3, promotionState: "team" })],
    });

    expect(receipt?.nextRecommendedAction).toBe("package");
  });

  it("suppresses prompts for cooled-down tasks", () => {
    const receipt = deriveAssistantOutcomeReceipt({
      runs: [makeRun()],
      automations: [],
      suppressedTaskKeys: [normalizeAssistantTask("Generate a weekly report")],
    });

    expect(receipt).toBeNull();
  });
});

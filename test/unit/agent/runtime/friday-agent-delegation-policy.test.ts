import { describe, expect, it } from "vitest";

import { shouldDelegateFridayAgentTask } from "#agent";

describe("shouldDelegateFridayAgentTask", () => {
  it("does not delegate status checks or clarifications", () => {
    expect(shouldDelegateFridayAgentTask({
      task: "刚才那个任务现在怎么样？",
      conversationContext: { turnKind: "status_check" },
    })).toBe(false);

    expect(shouldDelegateFridayAgentTask({
      task: "Use Claude",
      conversationContext: { turnKind: "clarification" },
    })).toBe(false);
  });

  it("keeps simple direct questions on the main agent", () => {
    expect(shouldDelegateFridayAgentTask({
      task: "What is the capital of France?",
    })).toBe(false);
  });

  it("delegates operational or multi-step work", () => {
    expect(shouldDelegateFridayAgentTask({
      task: "Open Facebook in the browser and tell me what is on the page.",
    })).toBe(true);

    expect(shouldDelegateFridayAgentTask({
      task: "Run the release-readiness-check skill and summarize blockers.",
    })).toBe(true);

    expect(shouldDelegateFridayAgentTask({
      task: "Continue and fix the failing workflow generator tests.",
      conversationContext: { turnKind: "continue_active_task" },
    })).toBe(true);
  });
});

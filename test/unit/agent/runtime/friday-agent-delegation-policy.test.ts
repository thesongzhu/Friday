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

  it("keeps follow-up synthesis requests on the main agent when they do not require tools", () => {
    expect(shouldDelegateFridayAgentTask({
      task: "Summarize your recommendations",
      conversationContext: { turnKind: "follow_up" },
    })).toBe(false);
  });

  it("keeps lightweight follow-up memory tasks on the main agent even when they mention session facts", () => {
    expect(shouldDelegateFridayAgentTask({
      task: "Acknowledge the new fact in one short sentence and keep earlier session facts available for later recall.",
      conversationContext: { turnKind: "follow_up" },
    })).toBe(false);
  });

  it("does not auto-delegate continue-active-task turns without an explicit action", () => {
    expect(shouldDelegateFridayAgentTask({
      task: "Keep the earlier facts available for later recall.",
      conversationContext: { turnKind: "continue_active_task" },
    })).toBe(false);
  });

  it("keeps explicit autonomous tool requests on the main agent", () => {
    expect(shouldDelegateFridayAgentTask({
      task: "Mandatory: call autonomous tool exactly once to open example.com and capture the page title.",
    })).toBe(false);
  });

  it("keeps explicit subagent tool orchestration requests on the main agent", () => {
    expect(shouldDelegateFridayAgentTask({
      task: "Use spawn_subagent exactly once with wait=true, then poll get_subagent until the child completes.",
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

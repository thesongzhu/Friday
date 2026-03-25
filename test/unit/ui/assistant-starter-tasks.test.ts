import { describe, expect, it } from "vitest";

import {
  FRIDAY_ASSISTANT_STARTER_TASKS,
  getAssistantStarterTask,
} from "../../../ui/src/lib/assistant/starter-tasks";

describe("assistant starter tasks", () => {
  it("defines click-first first-task recommendations for setup handoff", () => {
    expect(FRIDAY_ASSISTANT_STARTER_TASKS).toHaveLength(5);
    expect(FRIDAY_ASSISTANT_STARTER_TASKS.map((task) => task.id)).toEqual([
      "clarify-an-idea",
      "review-implementation-plan",
      "qa-page-or-app",
      "review-current-changes",
      "sync-release-docs",
    ]);
  });

  it("resolves starter tasks by id", () => {
    const task = getAssistantStarterTask("review-current-changes");
    expect(task?.title).toContain("current changes");
    expect(task?.goal).toContain("workspace changes");
    expect(getAssistantStarterTask("missing-task")).toBeNull();
  });
});

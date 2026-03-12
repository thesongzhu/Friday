import { describe, expect, it } from "vitest";

import {
  FRIDAY_ASSISTANT_STARTER_TASKS,
  getAssistantStarterTask,
} from "../../../ui/src/lib/assistant/starter-tasks";

describe("assistant starter tasks", () => {
  it("defines click-first first-task recommendations for setup handoff", () => {
    expect(FRIDAY_ASSISTANT_STARTER_TASKS).toHaveLength(4);
    expect(FRIDAY_ASSISTANT_STARTER_TASKS.map((task) => task.id)).toEqual([
      "clarify-next-step",
      "deploy-reporting-workflow",
      "enable-triage-skill",
      "recover-degraded-system",
    ]);
  });

  it("resolves starter tasks by id", () => {
    const task = getAssistantStarterTask("deploy-reporting-workflow");
    expect(task?.title).toContain("workflow");
    expect(task?.goal).toContain("deploy");
    expect(getAssistantStarterTask("missing-task")).toBeNull();
  });
});

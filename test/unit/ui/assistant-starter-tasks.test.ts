import { describe, expect, it } from "vitest";

import {
  FRIDAY_ASSISTANT_STARTER_TASKS,
  getAssistantStarterTask,
} from "../../../ui/src/lib/assistant/starter-tasks";

describe("assistant starter tasks", () => {
  it("defines click-first first-task recommendations for setup handoff", () => {
    expect(FRIDAY_ASSISTANT_STARTER_TASKS).toHaveLength(7);
    expect(FRIDAY_ASSISTANT_STARTER_TASKS.map((task) => task.id)).toEqual([
      "review-repo-health",
      "check-release-readiness",
      "review-open-issues",
      "review-autofix-readiness",
      "recover-failed-deploy",
      "run-log-error-triage",
      "diagnose-local-service",
    ]);
  });

  it("resolves starter tasks by id", () => {
    const task = getAssistantStarterTask("review-autofix-readiness");
    expect(task?.title).toContain("repair");
    expect(task?.goal).toContain("autofix-readiness-review");
    expect(getAssistantStarterTask("missing-task")).toBeNull();
  });
});

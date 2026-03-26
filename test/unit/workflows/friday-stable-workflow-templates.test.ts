import { describe, expect, it } from "vitest";
import { listFridayStableWorkflowTemplates } from "#workflows";

describe("listFridayStableWorkflowTemplates", () => {
  it("returns the expected stable template catalog", () => {
    const templates = listFridayStableWorkflowTemplates();

    expect(templates.map((template) => template.id)).toEqual([
      "search",
      "fetch",
      "summarize",
      "browser_qa",
      "diff_review",
      "release_check",
      "security_review",
      "incident_triage",
    ]);
    expect(templates.find((template) => template.id === "release_check")).toMatchObject({
      preferredBinding: "stable-skill",
      defaultTaskProfile: "review",
    });
  });
});

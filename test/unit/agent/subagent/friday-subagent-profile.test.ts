import { describe, expect, it } from "vitest";
import { inferFridaySubagentProfile, resolveFridaySubagentProfile } from "#agent";

describe("Friday subagent profiles", () => {
  it("resolves plan profile with its default task profile", () => {
    const profile = resolveFridaySubagentProfile("plan");

    expect(profile).toMatchObject({
      id: "plan",
      taskProfile: "planning",
      readOnly: true,
      maxTurns: 4,
    });
  });

  it("infers review and debug profiles from task text", () => {
    expect(inferFridaySubagentProfile("review this diff for regressions")).toBe("review");
    expect(inferFridaySubagentProfile("debug this failing log pipeline")).toBe("debug");
  });
});

import { describe, expect, it } from "vitest";
import { resolveFridayAgentTaskProfile } from "#agent";

describe("resolveFridayAgentTaskProfile", () => {
  it("returns deterministic defaults for deterministic profile", () => {
    const profile = resolveFridayAgentTaskProfile("deterministic");

    expect(profile).toMatchObject({
      id: "deterministic",
      temperature: 0,
      reasoningEffort: "low",
    });
  });

  it("applies explicit overrides without losing the profile identity", () => {
    const profile = resolveFridayAgentTaskProfile({
      id: "planning",
      model: "gpt-5.4-mini",
      temperature: 0.2,
      reasoningEffort: "medium",
      reason: "unit-test",
    });

    expect(profile).toMatchObject({
      id: "planning",
      model: "gpt-5.4-mini",
      temperature: 0.2,
      reasoningEffort: "medium",
      reason: "unit-test",
    });
  });
});

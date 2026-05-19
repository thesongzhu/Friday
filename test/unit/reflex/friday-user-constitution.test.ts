import { describe, expect, it } from "vitest";

import {
  buildFridayUserConstitutionPreferencePromptFragment,
  buildFridayUserConstitutionPromptFragment,
  isFridayUserConstitutionPreferenceKey,
} from "../../../src/reflex/index.js";

describe("Friday User Constitution", () => {
  it("builds the Skeptical Mode baseline without changing approval or memory boundaries", () => {
    const fragment = buildFridayUserConstitutionPromptFragment();

    expect(fragment).toContain("[User Constitution / Skeptical Mode]");
    expect(fragment).toContain("Ask the smallest useful clarifying question");
    expect(fragment).toContain("Challenge requests that appear risky");
    expect(fragment).toContain("must not write memory, weaken approval gates");
  });

  it("formats only confirmed constitution preferences for prompt injection", () => {
    const fragment = buildFridayUserConstitutionPreferencePromptFragment([
      {
        id: "pref-1",
        principalId: "user-1",
        category: "reflex",
        key: "constitution.challenge_policy",
        value: "challenge_risky_or_inconsistent",
        source: "explicit",
        confidence: 1,
        createdAt: "2026-05-19T00:00:00.000Z",
        updatedAt: "2026-05-19T00:00:00.000Z",
      },
      {
        id: "pref-2",
        principalId: "user-1",
        category: "reflex",
        key: "automation.conservatism",
        value: "balanced",
        source: "explicit",
        confidence: 1,
        createdAt: "2026-05-19T00:00:00.000Z",
        updatedAt: "2026-05-19T00:00:00.000Z",
      },
    ]);

    expect(fragment).toContain("Confirmed User Constitution settings");
    expect(fragment).toContain("constitution.challenge_policy");
    expect(fragment).not.toContain("automation.conservatism");
  });

  it("identifies the four canonical constitution keys", () => {
    expect(isFridayUserConstitutionPreferenceKey("constitution.skeptical_mode")).toBe(true);
    expect(isFridayUserConstitutionPreferenceKey("constitution.clarification_policy")).toBe(true);
    expect(isFridayUserConstitutionPreferenceKey("constitution.challenge_policy")).toBe(true);
    expect(isFridayUserConstitutionPreferenceKey("constitution.plain_language_policy")).toBe(true);
    expect(isFridayUserConstitutionPreferenceKey("memory.explicit_instruction_policy")).toBe(false);
  });
});

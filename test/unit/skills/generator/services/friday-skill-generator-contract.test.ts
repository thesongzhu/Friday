import { describe, expect, it } from "vitest";

import { extractFridaySkillGenerationContract } from "#skills/generator";

describe("extractFridaySkillGenerationContract", () => {
  it("prefers the latest manifest id and version mentioned in conversation turns", () => {
    const contract = extractFridaySkillGenerationContract({
      goal: 'Create a skill with manifest id "old-skill" and manifest version "1.0.0".',
      turns: [
        {
          turnId: "t1",
          sessionId: "s1",
          role: "user",
          content: 'Actually change the manifest id to "new-skill" and version to "2.0.0".',
          createdAt: "2026-04-16T10:00:00.000Z",
        },
      ],
    });

    expect(contract.expectedSkillId).toBe("new-skill");
    expect(contract.expectedVersion).toBe("2.0.0");
  });

  it("uses only the latest exact output marker block when the user revises the requirement", () => {
    const contract = extractFridaySkillGenerationContract({
      goal: 'When the skill runs, it must output the exact string "OLD_MARKER".',
      turns: [
        {
          turnId: "t1",
          sessionId: "s1",
          role: "user",
          content: 'Use this instead: when the skill runs, it must output the exact string "NEW_MARKER".',
          createdAt: "2026-04-16T10:00:00.000Z",
        },
      ],
    });

    expect(contract.requiredOutputMarkers).toEqual(["NEW_MARKER"]);
  });

  it("still preserves multiple exact markers from the same latest instruction", () => {
    const contract = extractFridaySkillGenerationContract({
      goal: "Create a reporting skill.",
      turns: [
        {
          turnId: "t1",
          sessionId: "s1",
          role: "user",
          content: 'The latest requirement is: say exactly "MARKER_A" and also say exactly "MARKER_B".',
          createdAt: "2026-04-16T10:00:00.000Z",
        },
      ],
    });

    expect(contract.requiredOutputMarkers).toEqual(["MARKER_A", "MARKER_B"]);
  });

  it("extracts exact markers from include-the-exact-marker phrasing", () => {
    const contract = extractFridaySkillGenerationContract({
      goal: 'When the skill runs, it must include the exact marker "LIVE_MARKER_V2" in the result payload.',
    });

    expect(contract.requiredOutputMarkers).toEqual(["LIVE_MARKER_V2"]);
  });

  it("extracts unquoted output marker and marker JSON phrasing", () => {
    const contract = extractFridaySkillGenerationContract({
      goal: 'Create a skill that prints JSON {"marker":"CODEX_GENERATOR_SKILL_OK"}.',
      turns: [
        {
          turnId: "t1",
          sessionId: "s1",
          role: "user",
          content: "Fix the draft self-test contract: add required output marker CODEX_GENERATOR_SKILL_OK.",
          createdAt: "2026-04-16T10:00:00.000Z",
        },
      ],
    });

    expect(contract.requiredOutputMarkers).toEqual(["CODEX_GENERATOR_SKILL_OK"]);
  });
});

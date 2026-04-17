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
});

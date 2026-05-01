import { describe, expect, it } from "vitest";

import {
  FRIDAY_SKILL_SOURCE_TAXONOMY,
  classifyFridaySkillSource,
  compareSkillOrigins,
} from "#skills";

describe("Friday skill source taxonomy", () => {
  it("classifies source trust boundaries used by install and runtime policy", () => {
    expect(classifyFridaySkillSource("bundled")).toEqual({
      source: "bundled",
      distribution: "first-party",
      mutableAtRuntime: false,
      requiresSignaturePolicy: false,
    });
    expect(FRIDAY_SKILL_SOURCE_TAXONOMY.git.requiresSignaturePolicy).toBe(true);
    expect(FRIDAY_SKILL_SOURCE_TAXONOMY.local.requiresSignaturePolicy).toBe(false);
  });

  it("keeps workspace origins above bundled origins for explicit local overrides", () => {
    expect(compareSkillOrigins("workspace", "bundled")).toBeGreaterThan(0);
    expect(compareSkillOrigins("agents-skills-project", "agents-skills-personal")).toBeGreaterThan(0);
  });
});

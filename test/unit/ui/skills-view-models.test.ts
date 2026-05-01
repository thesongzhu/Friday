import { describe, expect, it } from "vitest";
import {
  buildSkillHref,
  buildSkillOperatorSections,
  chooseInitialSkillId,
  summarizeSkillVerification,
  toneForSkillLifecycle,
} from "../../../ui/src/lib/skills/view-models";

describe("skills view models", () => {
  it("groups installed skills, updates, and available catalog items consistently", () => {
    const result = buildSkillOperatorSections({
      skills: [
        {
          skillId: "skill.starter",
          name: "Starter",
          source: "bundled",
          origin: "bundled",
          status: "installed",
          starter: true,
          tags: ["starter"],
          updateAvailable: false,
          managed: false,
          registryLoaded: true,
        },
        {
          skillId: "skill.alpha",
          name: "Alpha",
          source: "local",
          origin: "managed",
          status: "installed",
          starter: false,
          tags: [],
          updateAvailable: false,
          managed: true,
          registryLoaded: true,
        },
        {
          skillId: "skill.beta",
          name: "Beta",
          source: "local",
          origin: "managed",
          status: "installed",
          starter: false,
          tags: [],
          updateAvailable: true,
          managed: true,
          registryLoaded: true,
        },
      ],
      catalog: [
        {
          sourceId: "src-1",
          skillId: "skill.alpha",
          skillName: "Alpha",
          version: "1.0.0",
          signatureValid: true,
          trustScore: 90,
          starter: false,
          manifest: {},
          installed: true,
          installedVersion: "1.0.0",
          updateAvailable: false,
        },
        {
          sourceId: "src-1",
          skillId: "skill.gamma",
          skillName: "Gamma",
          version: "1.0.0",
          signatureValid: false,
          trustScore: 55,
          starter: false,
          manifest: {},
          installed: false,
          updateAvailable: false,
        },
      ],
    });

    expect(result.starter.map((item) => item.skillId)).toEqual(["skill.starter"]);
    expect(result.installed.map((item) => item.skillId)).toEqual(["skill.alpha", "skill.beta"]);
    expect(result.updates.map((item) => item.skillId)).toEqual(["skill.beta"]);
    expect(result.available.map((item) => item.skillId)).toEqual(["skill.gamma"]);
  });

  it("prefers a skill with an update when choosing the initial operator focus", () => {
    const selected = chooseInitialSkillId({
      selectedSkillId: null,
      skills: [
        {
          skillId: "skill.alpha",
          name: "Alpha",
          source: "local",
          origin: "managed",
          status: "installed",
          starter: false,
          tags: [],
          updateAvailable: false,
          managed: true,
          registryLoaded: true,
        },
        {
          skillId: "skill.beta",
          name: "Beta",
          source: "local",
          origin: "managed",
          status: "installed",
          starter: false,
          tags: [],
          updateAvailable: true,
          managed: true,
          registryLoaded: true,
        },
      ],
      catalog: [],
    });

    expect(selected).toBe("skill.beta");
  });

  it("summarizes verification evidence and lifecycle tones for operator badges", () => {
    expect(toneForSkillLifecycle({ status: "failed", updateAvailable: false })).toBe("danger");
    expect(toneForSkillLifecycle({ status: "installed", updateAvailable: true })).toBe("warning");
    expect(summarizeSkillVerification()).toContain("No verification evidence yet");
    expect(
      summarizeSkillVerification({
        skillId: "skill.alpha",
        name: "Alpha",
        source: "local",
        origin: "managed",
        status: "installed",
        starter: false,
        tags: [],
        updateAvailable: false,
        managed: true,
        registryLoaded: true,
        versions: [],
        installations: [],
        verification: {
          skillId: "skill.alpha",
          verifiedAt: "2026-03-07T00:00:00.000Z",
          ok: false,
          manifestVerdict: { ok: true, issues: [] },
          packageIntegrity: { available: false, ok: false },
          dependencyCheck: { ok: true, checkedBins: [], missingBins: [] },
          runtimeDryRun: {
            attempted: true,
            ok: false,
            executable: false,
            reason: "Runtime dry-run failed",
          },
          trustSummary: { verdict: "warning", reasons: ["warn"] },
        },
      }),
    ).toBe("Runtime dry-run failed");
  });

  it("builds assistant-aligned skill detail links", () => {
    expect(buildSkillHref("skill.alpha", "verify")).toBe("/skills?skillId=skill.alpha&focus=verify");
    expect(buildSkillHref(undefined, "sources")).toBe("/skills?focus=sources");
  });
});

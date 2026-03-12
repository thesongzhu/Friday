import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveFridaySkillDiscoveryRoots,
  discoverFridaySkillCandidates,
} from "#skills";
import type { FridaySkillRegistrySettings } from "#hub";

describe("resolveFridaySkillDiscoveryRoots", () => {
  it("orders roots by precedence (lowest first)", () => {
    const settings: FridaySkillRegistrySettings = {
      workspaceDir: "/workspace",
      bundledSkillsDir: "/app/skills/bundled",
      managedSkillsDir: "/app/skills/managed",
      extraSkillDirs: ["/extra/skills"],
      watchEnabled: false,
      watchDebounceMs: 300,
    };

    const roots = resolveFridaySkillDiscoveryRoots(settings);
    const origins = roots.map((r) => r.origin);

    // extra < bundled < managed < agents-skills-personal < agents-skills-project < workspace
    expect(origins.indexOf("extra")).toBeLessThan(origins.indexOf("bundled"));
    expect(origins.indexOf("bundled")).toBeLessThan(origins.indexOf("managed"));
    expect(origins.indexOf("managed")).toBeLessThan(origins.indexOf("agents-skills-personal"));
    expect(origins.indexOf("agents-skills-personal")).toBeLessThan(origins.indexOf("agents-skills-project"));
    expect(origins.indexOf("agents-skills-project")).toBeLessThan(origins.indexOf("workspace"));
  });

  it("includes all expected root types", () => {
    const settings: FridaySkillRegistrySettings = {
      workspaceDir: "/workspace",
      bundledSkillsDir: "/bundled",
      managedSkillsDir: "/managed",
      extraSkillDirs: [],
      watchEnabled: false,
      watchDebounceMs: 300,
    };

    const roots = resolveFridaySkillDiscoveryRoots(settings);
    const origins = roots.map((r) => r.origin);

    expect(origins).toContain("bundled");
    expect(origins).toContain("managed");
    expect(origins).toContain("agents-skills-personal");
    expect(origins).toContain("agents-skills-project");
    expect(origins).toContain("workspace");
  });
});

describe("discoverFridaySkillCandidates", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "friday-test-discovery-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("discovers skills with skill.manifest.json", () => {
    const skillsDir = join(tmpDir, "skills");
    const skillDir = join(skillsDir, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "skill.manifest.json"), "{}");

    const candidates = discoverFridaySkillCandidates([
      { origin: "bundled", source: "bundled", dir: skillsDir },
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.skillDir).toBe(skillDir);
  });

  it("discovers skills with SKILL.md", () => {
    const skillsDir = join(tmpDir, "skills");
    const skillDir = join(skillsDir, "legacy-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Skill");

    const candidates = discoverFridaySkillCandidates([
      { origin: "workspace", source: "local", dir: skillsDir },
    ]);

    expect(candidates).toHaveLength(1);
  });

  it("skips non-skill directories", () => {
    const skillsDir = join(tmpDir, "skills");
    const notASkill = join(skillsDir, "not-a-skill");
    mkdirSync(notASkill, { recursive: true });
    writeFileSync(join(notASkill, "readme.txt"), "not a skill");

    const candidates = discoverFridaySkillCandidates([
      { origin: "bundled", source: "bundled", dir: skillsDir },
    ]);

    expect(candidates).toHaveLength(0);
  });

  it("sorts candidates lexically within each root", () => {
    const skillsDir = join(tmpDir, "skills");
    mkdirSync(join(skillsDir, "zebra-skill"), { recursive: true });
    mkdirSync(join(skillsDir, "alpha-skill"), { recursive: true });
    writeFileSync(join(skillsDir, "zebra-skill", "SKILL.md"), "# Z");
    writeFileSync(join(skillsDir, "alpha-skill", "SKILL.md"), "# A");

    const candidates = discoverFridaySkillCandidates([
      { origin: "bundled", source: "bundled", dir: skillsDir },
    ]);

    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.skillDir).toContain("alpha-skill");
    expect(candidates[1]!.skillDir).toContain("zebra-skill");
  });

  it("handles missing root directories gracefully", () => {
    const candidates = discoverFridaySkillCandidates([
      { origin: "bundled", source: "bundled", dir: "/nonexistent/path" },
    ]);
    expect(candidates).toEqual([]);
  });
});

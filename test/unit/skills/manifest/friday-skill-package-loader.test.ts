import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadFridaySkillPackage,
  resolveFridaySkillDeclaredFiles,
} from "#skills";
import { makeManifest } from "../_helpers/make-manifest.helper.js";

describe("loadFridaySkillPackage", () => {
  let workspaceDir: string;
  let skillDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "friday-test-pkgloader-ws-"));
    skillDir = mkdtempSync(join(workspaceDir, "skill-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("loads manifest-first when skill.manifest.json exists", () => {
    const manifest = makeManifest({ id: "manifest-first" });
    writeFileSync(join(skillDir, "skill.manifest.json"), JSON.stringify(manifest));

    const result = loadFridaySkillPackage({ skillDir, workspaceDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.loadMode).toBe("manifest-v2");
      expect(result.value.manifest.id).toBe("manifest-first");
      expect(result.value.manifestPath).toBe(join(skillDir, "skill.manifest.json"));
    }
  });

  it("falls back to SKILL.md when manifest is absent", () => {
    const md = `---\nname: Legacy\nversion: 1.0.0\n---\nA legacy skill.`;
    writeFileSync(join(skillDir, "SKILL.md"), md);

    const result = loadFridaySkillPackage({ skillDir, workspaceDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.loadMode).toBe("legacy-skill-md");
      expect(result.value.manifest.name).toBe("Legacy");
      expect(result.value.legacy).toBeDefined();
    }
  });

  it("fails when neither manifest nor SKILL.md exists", () => {
    const result = loadFridaySkillPackage({ skillDir, workspaceDir });
    expect(result.ok).toBe(false);
  });

  it("does not fall back to legacy if manifest has parse errors", () => {
    writeFileSync(join(skillDir, "skill.manifest.json"), "broken json{{{");
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: Fallback\n---\nBody");

    const result = loadFridaySkillPackage({ skillDir, workspaceDir });
    // Should fail with manifest parse error, not fall back
    expect(result.ok).toBe(false);
  });
});

describe("resolveFridaySkillDeclaredFiles", () => {
  it("includes manifest file for manifest-v2 mode", () => {
    const manifest = makeManifest({
      runtime: { kind: "node", entrypoint: "index.ts", minHubVersion: "1.0.0", apiVersion: "1", timeoutMsDefault: 30_000 },
    });
    const files = resolveFridaySkillDeclaredFiles({
      skillDir: "/skills/test",
      manifest,
      loadMode: "manifest-v2",
    });
    expect(files).toContain("/skills/test/skill.manifest.json");
    expect(files).toContain("/skills/test/index.ts");
  });

  it("does not include entrypoint for builtin skills with empty entrypoint", () => {
    const manifest = makeManifest(); // default: builtin with empty entrypoint
    const files = resolveFridaySkillDeclaredFiles({
      skillDir: "/skills/test",
      manifest,
      loadMode: "manifest-v2",
    });
    expect(files).toContain("/skills/test/skill.manifest.json");
    expect(files).not.toContain("/skills/test/");
  });

  it("includes SKILL.md for legacy mode", () => {
    const manifest = makeManifest(); // legacy adapter produces builtin with empty entrypoint
    const files = resolveFridaySkillDeclaredFiles({
      skillDir: "/skills/test",
      manifest,
      loadMode: "legacy-skill-md",
      skillMdPath: "/skills/test/SKILL.md",
    });
    expect(files).toContain("/skills/test/SKILL.md");
  });

  it("includes schema files when declared", () => {
    const manifest = makeManifest({
      schemas: {
        input: "schemas/input.json",
        state: null,
        output: "schemas/output.json",
      },
    });
    const files = resolveFridaySkillDeclaredFiles({
      skillDir: "/skills/test",
      manifest,
      loadMode: "manifest-v2",
    });
    expect(files).toContain("/skills/test/schemas/input.json");
    expect(files).toContain("/skills/test/schemas/output.json");
  });
});

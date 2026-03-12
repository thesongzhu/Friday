import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadFridaySkillManifest } from "#skills";
import { makeManifest } from "../_helpers/make-manifest.helper.js";

describe("loadFridaySkillManifest", () => {
  let skillDir: string;

  beforeEach(() => {
    skillDir = mkdtempSync(join(tmpdir(), "friday-test-loader-"));
  });

  afterEach(() => {
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("returns MANIFEST_NOT_FOUND when file is missing", () => {
    const result = loadFridaySkillManifest({ skillDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MANIFEST_NOT_FOUND");
    }
  });

  it("returns MANIFEST_PARSE_FAILED for invalid JSON", () => {
    writeFileSync(join(skillDir, "skill.manifest.json"), "not json{{{");
    const result = loadFridaySkillManifest({ skillDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MANIFEST_PARSE_FAILED");
    }
  });

  it("returns MANIFEST_VALIDATION_FAILED for invalid schema", () => {
    const invalid = { schemaVersion: "9.0", id: "x" };
    writeFileSync(join(skillDir, "skill.manifest.json"), JSON.stringify(invalid));
    const result = loadFridaySkillManifest({ skillDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MANIFEST_VALIDATION_FAILED");
    }
  });

  it("successfully loads and normalizes a valid manifest", () => {
    const manifest = makeManifest({ id: "loader-test" });
    writeFileSync(join(skillDir, "skill.manifest.json"), JSON.stringify(manifest));
    const result = loadFridaySkillManifest({ skillDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifest.id).toBe("loader-test");
      expect(result.value.manifestPath).toBe(join(skillDir, "skill.manifest.json"));
    }
  });

  it("applies defaults for a minimal manifest", () => {
    const minimal = {
      id: "minimal",
      name: "Minimal",
      description: "Minimal skill",
      version: "1.0.0",
    };
    writeFileSync(join(skillDir, "skill.manifest.json"), JSON.stringify(minimal));
    const result = loadFridaySkillManifest({ skillDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifest.kind).toBe("conversation");
      expect(result.value.manifest.runtime.kind).toBe("builtin");
    }
  });
});

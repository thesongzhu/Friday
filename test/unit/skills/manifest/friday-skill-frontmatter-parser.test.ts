import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseFridaySkillFrontmatter,
  loadFridaySkillFrontmatter,
} from "#skills";

describe("parseFridaySkillFrontmatter", () => {
  it("parses valid YAML frontmatter", () => {
    const md = `---
name: My Skill
version: 1.0.0
---
# My Skill

Description here.`;
    const result = parseFridaySkillFrontmatter(md);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.frontmatter.name).toBe("My Skill");
      expect(result.value.frontmatter.version).toBe("1.0.0");
      expect(result.value.body).toContain("# My Skill");
    }
  });

  it("returns empty frontmatter when no frontmatter block exists", () => {
    const md = "# Just a document\n\nNo frontmatter here.";
    const result = parseFridaySkillFrontmatter(md);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.frontmatter).toEqual({});
      expect(result.value.body).toBe(md);
    }
  });

  it("returns error result for malformed YAML", () => {
    // Construct something the YAML parser will throw on
    const md = `---
: [invalid yaml
  broken: {{{{
---
Body content`;
    const result = parseFridaySkillFrontmatter(md);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SKILL_MD_FRONTMATTER_INVALID");
      expect(result.error.message).toContain("Malformed YAML");
    }
  });

  it("coerces non-string values to strings", () => {
    const md = `---
port: 8080
enabled: true
---
Body`;
    const result = parseFridaySkillFrontmatter(md);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.frontmatter.port).toBe("8080");
      expect(result.value.frontmatter.enabled).toBe("true");
    }
  });
});

describe("loadFridaySkillFrontmatter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "friday-test-fm-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads and parses a SKILL.md file", () => {
    const mdPath = join(tmpDir, "SKILL.md");
    writeFileSync(mdPath, `---\nname: Test\n---\nBody`);
    const result = loadFridaySkillFrontmatter(mdPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.frontmatter.name).toBe("Test");
      expect(result.value.body).toBe("Body");
    }
  });

  it("returns error for missing file", () => {
    const result = loadFridaySkillFrontmatter(join(tmpDir, "nonexistent.md"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SKILL_MD_READ_FAILED");
    }
  });

  it("returns error for malformed YAML in file", () => {
    const mdPath = join(tmpDir, "SKILL.md");
    writeFileSync(mdPath, `---\n: [broken\n---\nBody`);
    const result = loadFridaySkillFrontmatter(mdPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SKILL_MD_FRONTMATTER_INVALID");
    }
  });
});

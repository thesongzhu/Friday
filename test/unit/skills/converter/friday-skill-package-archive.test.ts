import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createFridaySkillPackageArchiver } from "#skills/converter";

describe("FridaySkillPackageArchiver", () => {
  let testDir: string;
  const archiver = createFridaySkillPackageArchiver();

  beforeEach(() => {
    testDir = join(tmpdir(), `friday-test-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("packSkill", () => {
    it("creates a .friday.tgz archive from skill directory", () => {
      const skillDir = join(testDir, "my-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "skill.manifest.json"), JSON.stringify({ id: "my-skill" }));
      writeFileSync(join(skillDir, "run.sh"), "#!/bin/bash\necho hello");

      const outputFile = join(testDir, "output", "my-skill-1.0.0.friday.tgz");
      const result = archiver.packSkill(skillDir, outputFile);

      expect(result.packageFile).toBe(outputFile);
      expect(existsSync(result.packageFile)).toBe(true);
      expect(result.checksumSha256).toBeTruthy();

      // Verify checksum
      const fileContent = readFileSync(result.packageFile);
      const expectedHash = createHash("sha256").update(fileContent).digest("hex");
      expect(result.checksumSha256).toBe(expectedHash);
    });

    it("appends .friday.tgz if not present in output file", () => {
      const skillDir = join(testDir, "my-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "skill.manifest.json"), "{}");

      const outputFile = join(testDir, "output", "my-skill-1.0.0");
      const result = archiver.packSkill(skillDir, outputFile);

      expect(result.packageFile).toBe(outputFile + ".friday.tgz");
      expect(existsSync(result.packageFile)).toBe(true);
    });

    it("throws when skill directory does not exist", () => {
      const outputFile = join(testDir, "output.friday.tgz");
      expect(() => archiver.packSkill("/nonexistent/skill/dir", outputFile)).toThrow(
        "Skill directory not found",
      );
    });

    it("creates output directory if it does not exist", () => {
      const skillDir = join(testDir, "my-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "manifest.json"), "{}");

      const outputFile = join(testDir, "deep", "nested", "output.friday.tgz");
      const result = archiver.packSkill(skillDir, outputFile);

      expect(existsSync(result.packageFile)).toBe(true);
    });

    it("includes subdirectories in archive", () => {
      const skillDir = join(testDir, "my-skill");
      mkdirSync(join(skillDir, "assets"), { recursive: true });
      writeFileSync(join(skillDir, "skill.manifest.json"), "{}");
      writeFileSync(join(skillDir, "assets", "icon.txt"), "icon");

      const outputFile = join(testDir, "output.friday.tgz");
      const result = archiver.packSkill(skillDir, outputFile);

      expect(existsSync(result.packageFile)).toBe(true);

      // Unpack and verify
      const unpackDir = join(testDir, "unpacked");
      archiver.unpackSkill(result.packageFile, unpackDir);

      expect(existsSync(join(unpackDir, "skill.manifest.json"))).toBe(true);
      expect(existsSync(join(unpackDir, "assets", "icon.txt"))).toBe(true);
    });
  });

  describe("unpackSkill", () => {
    it("extracts archive to output directory", () => {
      // Create and pack a skill
      const skillDir = join(testDir, "my-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "skill.manifest.json"), JSON.stringify({ id: "my-skill" }));
      writeFileSync(join(skillDir, "run.sh"), "#!/bin/bash\necho hello");

      const archivePath = join(testDir, "archive.friday.tgz");
      archiver.packSkill(skillDir, archivePath);

      // Unpack
      const outputDir = join(testDir, "extracted");
      archiver.unpackSkill(archivePath, outputDir);

      expect(existsSync(join(outputDir, "skill.manifest.json"))).toBe(true);
      expect(existsSync(join(outputDir, "run.sh"))).toBe(true);

      const content = JSON.parse(readFileSync(join(outputDir, "skill.manifest.json"), "utf-8"));
      expect(content.id).toBe("my-skill");
    });

    it("creates output directory if it does not exist", () => {
      const skillDir = join(testDir, "my-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "test.txt"), "test");

      const archivePath = join(testDir, "archive.friday.tgz");
      archiver.packSkill(skillDir, archivePath);

      const outputDir = join(testDir, "deep", "nested", "output");
      archiver.unpackSkill(archivePath, outputDir);

      expect(existsSync(join(outputDir, "test.txt"))).toBe(true);
    });

    it("throws when archive does not exist", () => {
      const outputDir = join(testDir, "output");
      expect(() => archiver.unpackSkill("/nonexistent/archive.tgz", outputDir)).toThrow(
        "Archive not found",
      );
    });
  });

  describe("round-trip", () => {
    it("preserves file content through pack/unpack", () => {
      const skillDir = join(testDir, "my-skill");
      mkdirSync(join(skillDir, "prompts"), { recursive: true });

      const manifest = { id: "round-trip-skill", version: "2.0.0" };
      writeFileSync(join(skillDir, "skill.manifest.json"), JSON.stringify(manifest, null, 2));
      writeFileSync(join(skillDir, "run.sh"), "#!/bin/bash\necho 'round trip'");
      writeFileSync(join(skillDir, "prompts", "main.txt"), "Hello world");

      // Pack
      const archivePath = join(testDir, "round-trip.friday.tgz");
      const packResult = archiver.packSkill(skillDir, archivePath);

      // Unpack
      const outputDir = join(testDir, "unpacked");
      archiver.unpackSkill(packResult.packageFile, outputDir);

      // Verify content matches
      const unpackedManifest = JSON.parse(readFileSync(join(outputDir, "skill.manifest.json"), "utf-8"));
      expect(unpackedManifest.id).toBe("round-trip-skill");
      expect(unpackedManifest.version).toBe("2.0.0");

      const unpackedScript = readFileSync(join(outputDir, "run.sh"), "utf-8");
      expect(unpackedScript).toContain("round trip");

      const unpackedPrompt = readFileSync(join(outputDir, "prompts", "main.txt"), "utf-8");
      expect(unpackedPrompt).toBe("Hello world");
    });
  });
});

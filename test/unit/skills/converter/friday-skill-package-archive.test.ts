import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
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

      // Pass output without archive extension; the archiver appends .friday.tgz
      const outputFile = join(testDir, "output", "my-skill-1.0.0");
      const result = archiver.packSkill(skillDir, outputFile);

      expect(result.packageFile).toBe(outputFile + ".friday.tgz");
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

    it("strips existing archive extensions before appending .friday.tgz", () => {
      const skillDir = join(testDir, "my-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "skill.manifest.json"), "{}");

      const outputFile = join(testDir, "output", "my-skill-1.0.0.tar.gz");
      const result = archiver.packSkill(skillDir, outputFile);

      // .tar.gz should be stripped, then .friday.tgz appended
      expect(result.packageFile).toBe(join(testDir, "output", "my-skill-1.0.0.friday.tgz"));
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

      // Use a name without .tgz extension so the archiver appends .friday.tgz cleanly
      const outputFile = join(testDir, "deep", "nested", "output");
      const result = archiver.packSkill(skillDir, outputFile);

      expect(result.packageFile).toBe(outputFile + ".friday.tgz");
      expect(existsSync(result.packageFile)).toBe(true);
    });

    it("rejects symbolic links in source skill directories", () => {
      const skillDir = join(testDir, "my-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "skill.manifest.json"), "{}");
      writeFileSync(join(testDir, "outside.txt"), "outside");
      symlinkSync(join(testDir, "outside.txt"), join(skillDir, "outside-link"));

      expect(() => archiver.packSkill(skillDir, join(testDir, "output"))).toThrow(
        "must not contain symbolic links",
      );
    });

    it("includes subdirectories in archive", () => {
      const skillDir = join(testDir, "my-skill");
      mkdirSync(join(skillDir, "assets"), { recursive: true });
      writeFileSync(join(skillDir, "skill.manifest.json"), "{}");
      writeFileSync(join(skillDir, "assets", "icon.txt"), "icon");

      const outputFile = join(testDir, "output");
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

      const packResult = archiver.packSkill(skillDir, join(testDir, "archive"));
      const archivePath = packResult.packageFile;

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

      const packResult = archiver.packSkill(skillDir, join(testDir, "archive"));
      const archivePath = packResult.packageFile;

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

    it("rejects archive entries that escape the output directory", () => {
      const archivePath = join(testDir, "malicious.friday.tgz");
      writeTarGzArchive(archivePath, [
        { name: "skill/", type: "directory" },
        { name: "skill/../../outside.txt", type: "file", content: "escape" },
      ]);

      expect(() => archiver.unpackSkill(archivePath, join(testDir, "extracted"))).toThrow(
        "Unsafe archive entry",
      );
      expect(existsSync(join(testDir, "outside.txt"))).toBe(false);
    });

    it("rejects archive symlink entries before extraction", () => {
      const archivePath = join(testDir, "symlink.friday.tgz");
      writeTarGzArchive(archivePath, [
        { name: "skill/", type: "directory" },
        { name: "skill/link", type: "symlink", linkName: "/tmp/friday-escape" },
      ]);

      expect(() => archiver.unpackSkill(archivePath, join(testDir, "extracted"))).toThrow(
        "unsupported entry type",
      );
    });

    it("validates and extracts a snapshot with tar timeout kill signals", async () => {
      type TarCall = {
        cmd: string;
        args: string[];
        timeout?: number;
        killSignal?: NodeJS.Signals | number;
      };
      const calls: TarCall[] = [];
      const archivePath = join(testDir, "source.friday.tgz");
      const outputDir = join(testDir, "extracted");
      writeFileSync(archivePath, "placeholder archive");

      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: vi.fn((cmd: string, args: string[], options: { timeout?: number; killSignal?: NodeJS.Signals | number }) => {
          calls.push({ cmd, args, timeout: options.timeout, killSignal: options.killSignal });
          if (args[0] === "-tzf") {
            return "skill/\nskill/skill.manifest.json\n";
          }
          if (args[0] === "-tvzf") {
            return "drwxr-xr-x  0 user group 0 Jan 1 00:00 skill/\n-rw-r--r--  0 user group 2 Jan 1 00:00 skill/skill.manifest.json\n";
          }
          return "";
        }),
      }));

      try {
        const imported = await import("../../../../src/skills/converter/services/friday-skill-package-archive.js");
        imported.createFridaySkillPackageArchiver().unpackSkill(archivePath, outputDir);

        expect(calls).toHaveLength(3);
        const sourceArgs = calls.map((call) => call.args[1]);
        expect(sourceArgs.every((arg) => arg && arg !== archivePath)).toBe(true);
        expect(new Set(sourceArgs).size).toBe(1);
        for (const call of calls) {
          expect(call.timeout).toBe(30_000);
          expect(call.killSignal).toBe("SIGKILL");
        }
      } finally {
        vi.doUnmock("node:child_process");
        vi.resetModules();
      }
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
      const packResult = archiver.packSkill(skillDir, join(testDir, "round-trip"));

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

type TestTarEntry =
  | { name: string; type: "directory" }
  | { name: string; type: "file"; content: string }
  | { name: string; type: "symlink"; linkName: string };

function writeTarGzArchive(archivePath: string, entries: TestTarEntry[]): void {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = entry.type === "file" ? Buffer.from(entry.content) : Buffer.alloc(0);
    blocks.push(buildTarHeader(entry, content.length));
    if (content.length > 0) {
      blocks.push(content);
      const padding = (512 - (content.length % 512)) % 512;
      if (padding > 0) blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  writeFileSync(archivePath, gzipSync(Buffer.concat(blocks)));
}

function buildTarHeader(entry: TestTarEntry, size: number): Buffer {
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, entry.name);
  writeTarOctal(header, 100, 8, entry.type === "directory" ? 0o755 : 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  header[156] = entry.type === "directory" ? 0x35 : entry.type === "symlink" ? 0x32 : 0x30;
  if (entry.type === "symlink") {
    writeTarString(header, 157, 100, entry.linkName);
  }
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");

  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeTarOctal(header, 148, 8, checksum);
  return header;
}

function writeTarString(header: Buffer, offset: number, length: number, value: string): void {
  header.write(value, offset, Math.min(Buffer.byteLength(value), length), "utf8");
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0").slice(-(length - 1));
  header.write(encoded, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

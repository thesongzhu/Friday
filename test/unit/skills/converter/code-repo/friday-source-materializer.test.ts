import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  detectSourceProtocol,
  materializeFridayCodeRepoSource,
} from "../../../../../src/skills/converter/code-repo/friday-source-materializer.js";

// ─── Protocol Detection Tests ───

describe("detectSourceProtocol", () => {
  it("detects local directories", () => {
    expect(detectSourceProtocol("/path/to/repo")).toBe("local");
    expect(detectSourceProtocol("./relative/path")).toBe("local");
    expect(detectSourceProtocol("/Users/dev/project")).toBe("local");
  });

  it("detects git HTTPS URLs", () => {
    expect(detectSourceProtocol("https://github.com/user/repo")).toBe("git");
    expect(detectSourceProtocol("https://github.com/user/repo.git")).toBe("git");
    expect(detectSourceProtocol("https://gitlab.com/user/repo")).toBe("git");
    expect(detectSourceProtocol("https://bitbucket.org/user/repo")).toBe("git");
  });

  it("detects git SSH URLs", () => {
    expect(detectSourceProtocol("git@github.com:user/repo.git")).toBe("git");
  });

  it("detects git protocol URLs", () => {
    expect(detectSourceProtocol("git://example.com/repo.git")).toBe("git");
  });

  it("detects .git suffix as git", () => {
    expect(detectSourceProtocol("/some/path/repo.git")).toBe("git");
  });

  it("detects zip archives", () => {
    expect(detectSourceProtocol("/path/to/repo.zip")).toBe("archive");
    expect(detectSourceProtocol("/path/REPO.ZIP")).toBe("archive");
  });

  it("detects tar.gz archives", () => {
    expect(detectSourceProtocol("/path/to/repo.tar.gz")).toBe("archive");
    expect(detectSourceProtocol("/path/to/repo.tgz")).toBe("archive");
  });

  it("detects tar archives", () => {
    expect(detectSourceProtocol("/path/to/repo.tar")).toBe("archive");
  });

  it("falls back to local for unknown URIs", () => {
    expect(detectSourceProtocol("https://example.com/page")).toBe("local");
    expect(detectSourceProtocol("ftp://example.com/file")).toBe("local");
  });
});

// ─── Local Materializer Tests ───

describe("materializeFridayCodeRepoSource (local)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "friday-test-materializer-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("materializes a simple directory", () => {
    writeFileSync(join(tempDir, "index.ts"), "export default 42;");
    writeFileSync(join(tempDir, "package.json"), '{"name":"test"}');

    const result = materializeFridayCodeRepoSource(tempDir);
    expect(result.rootPath).toContain(tempDir);
    expect(result.files.length).toBeGreaterThanOrEqual(2);
    expect(result.files.some((f) => f.relativePath === "index.ts")).toBe(true);
    expect(result.files.some((f) => f.relativePath === "package.json")).toBe(true);
  });

  it("respects maxFiles limit", () => {
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(tempDir, `file${i}.ts`), `const x${i} = ${i};`);
    }

    const result = materializeFridayCodeRepoSource(tempDir, { maxFiles: 3 });
    expect(result.files.length).toBe(3);
  });

  it("respects maxDepth limit", () => {
    const deep = join(tempDir, "a", "b", "c", "d");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "deep.ts"), "export const deep = true;");
    writeFileSync(join(tempDir, "shallow.ts"), "export const shallow = true;");

    const result = materializeFridayCodeRepoSource(tempDir, { maxDepth: 1 });
    expect(result.files.some((f) => f.relativePath === "shallow.ts")).toBe(true);
    expect(result.files.some((f) => f.relativePath.includes("deep.ts"))).toBe(false);
  });

  it("respects maxFileBytes limit", () => {
    const largeContent = "x".repeat(5000);
    writeFileSync(join(tempDir, "large.ts"), largeContent);

    const result = materializeFridayCodeRepoSource(tempDir, { maxFileBytes: 2000 });
    const file = result.files.find((f) => f.relativePath === "large.ts");
    expect(file).toBeDefined();
    expect(file!.content.length).toBeLessThanOrEqual(2000);
  });

  it("skips ignored directories", () => {
    const nodeModules = join(tempDir, "node_modules");
    mkdirSync(nodeModules);
    writeFileSync(join(nodeModules, "dep.js"), "module.exports = {};");
    writeFileSync(join(tempDir, "src.ts"), "export default 1;");

    const result = materializeFridayCodeRepoSource(tempDir);
    expect(result.files.some((f) => f.relativePath.includes("node_modules"))).toBe(false);
    expect(result.files.some((f) => f.relativePath === "src.ts")).toBe(true);
  });

  it("filters files by extension", () => {
    writeFileSync(join(tempDir, "index.ts"), "export default 1;");
    writeFileSync(join(tempDir, "image.png"), "binary data");
    writeFileSync(join(tempDir, "data.csv"), "a,b,c");

    const result = materializeFridayCodeRepoSource(tempDir);
    expect(result.files.some((f) => f.relativePath === "index.ts")).toBe(true);
    expect(result.files.some((f) => f.relativePath === "image.png")).toBe(false);
    expect(result.files.some((f) => f.relativePath === "data.csv")).toBe(false);
  });

  it("includes special filenames like package.json", () => {
    writeFileSync(join(tempDir, "package.json"), '{"name":"test"}');
    writeFileSync(join(tempDir, "Makefile"), "all: build");
    writeFileSync(join(tempDir, "Cargo.toml"), '[package]\nname = "test"');

    const result = materializeFridayCodeRepoSource(tempDir);
    expect(result.files.some((f) => f.relativePath === "package.json")).toBe(true);
    expect(result.files.some((f) => f.relativePath === "Makefile")).toBe(true);
    expect(result.files.some((f) => f.relativePath === "Cargo.toml")).toBe(true);
  });

  it("skips empty files", () => {
    writeFileSync(join(tempDir, "empty.ts"), "");
    writeFileSync(join(tempDir, "whitespace.ts"), "   \n  \n ");
    writeFileSync(join(tempDir, "real.ts"), "export const x = 1;");

    const result = materializeFridayCodeRepoSource(tempDir);
    expect(result.files.some((f) => f.relativePath === "empty.ts")).toBe(false);
    expect(result.files.some((f) => f.relativePath === "whitespace.ts")).toBe(false);
    expect(result.files.some((f) => f.relativePath === "real.ts")).toBe(true);
  });

  it("throws for non-existent path", () => {
    expect(() =>
      materializeFridayCodeRepoSource("/non/existent/path"),
    ).toThrow("not found");
  });

  it("throws for file (not directory) path", () => {
    const filePath = join(tempDir, "file.txt");
    writeFileSync(filePath, "hello");
    expect(() =>
      materializeFridayCodeRepoSource(filePath),
    ).toThrow("directory");
  });
});

// ─── Git Source Detection Tests ───

describe("materializeFridayCodeRepoSource (git)", () => {
  it("throws with descriptive error for invalid git URL", () => {
    expect(() =>
      materializeFridayCodeRepoSource("git@invalid.host:nonexistent/repo.git"),
    ).toThrow("Failed to clone");
  });
});

// ─── Archive Source Detection Tests ───

describe("materializeFridayCodeRepoSource (archive)", () => {
  it("throws for non-existent archive", () => {
    expect(() =>
      materializeFridayCodeRepoSource("/tmp/nonexistent.zip"),
    ).toThrow("not found");
  });

  it("throws for oversized archive", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-test-archive-"));
    const archivePath = join(tempDir, "large.zip");
    // Create a small file but set a very low size limit
    writeFileSync(archivePath, "small content");

    try {
      expect(() =>
        materializeFridayCodeRepoSource(archivePath, { maxTotalBytes: 1 }),
      ).toThrow("size limit");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── Code Repo Converter Integration ───

import { createFridayCodeRepoConverter } from "../../../../../src/skills/converter/converters/friday-code-repo-converter.js";

describe("createFridayCodeRepoConverter (extended)", () => {
  const converter = createFridayCodeRepoConverter();

  describe("detect", () => {
    it("detects git URLs without cloning", async () => {
      const result = await converter.detect({
        uri: "https://github.com/user/repo",
      });
      expect(result).not.toBeNull();
      expect(result!.format).toBe("code-repo");
      expect(result!.confidence).toBe(0.85);
      expect(result!.reasons[0]).toContain("Git repository");
    });

    it("detects archive sources by extension", async () => {
      const result = await converter.detect({
        uri: "/path/to/source.tar.gz",
      });
      expect(result).not.toBeNull();
      expect(result!.format).toBe("code-repo");
      expect(result!.confidence).toBe(0.70);
      expect(result!.reasons[0]).toContain("Archive");
    });

    it("still detects explicit format hint", async () => {
      const result = await converter.detect({
        formatHint: "code-repo",
      });
      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.99);
    });

    it("returns null for non-repo URI", async () => {
      const result = await converter.detect({
        uri: "/nonexistent/path",
      });
      expect(result).toBeNull();
    });
  });

  describe("convert", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "friday-test-converter-"));
      // Create a minimal code repo
      writeFileSync(
        join(tempDir, "package.json"),
        JSON.stringify({ name: "test-repo", version: "1.0.0", scripts: { start: "node index.js" } }),
      );
      writeFileSync(
        join(tempDir, "index.js"),
        `
const http = require("http");
const server = http.createServer((req, res) => {
  if (req.url === "/api/hello") { res.end("hello"); }
  if (req.url === "/api/health") { res.end("ok"); }
});
server.listen(3000);
`.trim(),
      );
    });

    afterEach(() => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    });

    it("converts a local directory source", async () => {
      const result = await converter.convert(
        { uri: tempDir },
        { workspaceDir: "/tmp", managedSkillsDir: "/tmp", nowIso: () => "2026-01-01T00:00:00Z" },
      );
      expect(result.converterId).toBe("code-repo");
      expect(result.detectedFormat).toBe("code-repo");
      expect(result.drafts.length).toBeGreaterThanOrEqual(1);
    });

    it("throws for missing URI", async () => {
      await expect(
        converter.convert(
          {},
          { workspaceDir: "/tmp", managedSkillsDir: "/tmp", nowIso: () => "2026-01-01T00:00:00Z" },
        ),
      ).rejects.toThrow("source URI");
    });

    it("throws for empty repo", async () => {
      const emptyDir = mkdtempSync(join(tmpdir(), "friday-test-empty-"));
      try {
        await expect(
          converter.convert(
            { uri: emptyDir },
            { workspaceDir: "/tmp", managedSkillsDir: "/tmp", nowIso: () => "2026-01-01T00:00:00Z" },
          ),
        ).rejects.toThrow("no capabilities");
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });
});

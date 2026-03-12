import { describe, it, expect } from "vitest";
import {
  buildPackage,
  createMemoryFileSystem,
} from "../../../../src/packaging/engine/package-builder.js";

// ─── Fixtures ───

function validManifestJson(): string {
  return JSON.stringify({
    name: "@friday/test-pkg",
    version: "1.0.0",
    description: "Test package",
    author: { name: "Test Author" },
    capabilities: ["skill:test"],
    dependencies: {},
    fridayVersionRange: ">=0.1.0",
    assets: {
      skills: ["assets/skills/*.yaml"],
    },
    hooks: {
      preInstall: "migrations/001-init.sql",
    },
    metadata: {
      keywords: ["test"],
    },
  });
}

function makeFiles(extra?: Map<string, string>): Map<string, string> {
  const files = new Map<string, string>();
  files.set("manifest.json", validManifestJson());
  files.set("assets/skills/web-search.yaml", "name: web-search\ntype: skill");
  files.set("migrations/001-init.sql", "CREATE TABLE test (id TEXT);");
  files.set("README.md", "# Test Package");
  if (extra) {
    for (const [k, v] of extra) files.set(k, v);
  }
  return files;
}

// ─── Tests ───

describe("buildPackage", () => {
  it("builds a valid package from source", () => {
    const fs = createMemoryFileSystem(makeFiles());
    const result = buildPackage(fs);

    expect(result.success).toBe(true);
    expect(result.package).not.toBeNull();
    expect(result.package!.manifest.name).toBe("@friday/test-pkg");
    expect(result.package!.manifest.version).toBe("1.0.0");
    expect(result.errors).toHaveLength(0);
  });

  it("collects asset files matching glob patterns", () => {
    const fs = createMemoryFileSystem(makeFiles());
    const result = buildPackage(fs);

    expect(result.package!.assets.skills).toContain("assets/skills/web-search.yaml");
  });

  it("includes manifest.json in archive files", () => {
    const fs = createMemoryFileSystem(makeFiles());
    const result = buildPackage(fs);

    const manifestFile = result.package!.files.find((f) => f.archivePath === "manifest.json");
    expect(manifestFile).toBeDefined();
    expect(manifestFile!.content).toContain("@friday/test-pkg");
  });

  it("includes README.md if present", () => {
    const fs = createMemoryFileSystem(makeFiles());
    const result = buildPackage(fs);

    const readme = result.package!.files.find((f) => f.archivePath === "README.md");
    expect(readme).toBeDefined();
    expect(readme!.content).toContain("# Test Package");
  });

  it("includes hook scripts", () => {
    const fs = createMemoryFileSystem(makeFiles());
    const result = buildPackage(fs);

    const hookFile = result.package!.files.find((f) => f.archivePath === "migrations/001-init.sql");
    expect(hookFile).toBeDefined();
  });

  it("calculates total size", () => {
    const fs = createMemoryFileSystem(makeFiles());
    const result = buildPackage(fs);

    expect(result.package!.totalSizeBytes).toBeGreaterThan(0);
  });

  it("fails when manifest is missing", () => {
    const files = new Map<string, string>();
    files.set("README.md", "no manifest");
    const fs = createMemoryFileSystem(files);
    const result = buildPackage(fs);

    expect(result.success).toBe(false);
    expect(result.errors[0].message).toContain("Manifest file not found");
  });

  it("fails with invalid manifest", () => {
    const files = new Map<string, string>();
    files.set("manifest.json", '{"name": "INVALID"}');
    const fs = createMemoryFileSystem(files);
    const result = buildPackage(fs);

    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("fails when asset glob matches nothing", () => {
    const files = new Map<string, string>();
    files.set("manifest.json", validManifestJson());
    // No asset files matching the glob
    const fs = createMemoryFileSystem(files);
    const result = buildPackage(fs);

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.message.includes("No files matched glob pattern"))).toBe(true);
  });

  it("fails when hook script is missing", () => {
    const files = new Map<string, string>();
    files.set("manifest.json", validManifestJson());
    files.set("assets/skills/web-search.yaml", "content");
    // migrations/001-init.sql is missing
    const fs = createMemoryFileSystem(files);
    const result = buildPackage(fs);

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.message.includes("Hook script not found"))).toBe(true);
  });

  it("rejects package exceeding max size", () => {
    const fs = createMemoryFileSystem(makeFiles());
    const result = buildPackage(fs, "manifest.json", { maxSizeBytes: 10 });

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.message.includes("exceeds maximum"))).toBe(true);
  });

  it("supports custom manifest path", () => {
    const files = new Map<string, string>();
    files.set("custom/pkg.json", JSON.stringify({
      name: "my-package",
      version: "1.0.0",
      description: "Custom path",
      author: { name: "Dev" },
      capabilities: ["skill:test"],
      dependencies: {},
      fridayVersionRange: ">=0.1.0",
      assets: {},
    }));
    const fs = createMemoryFileSystem(files);
    const result = buildPackage(fs, "custom/pkg.json");

    expect(result.success).toBe(true);
    expect(result.package!.manifest.name).toBe("my-package");
  });

  it("deduplicates asset files", () => {
    // Manifest with overlapping globs
    const manifest = {
      name: "my-package",
      version: "1.0.0",
      description: "Dedupe test",
      author: { name: "Dev" },
      capabilities: ["skill:test"],
      dependencies: {},
      fridayVersionRange: ">=0.1.0",
      assets: {
        skills: ["assets/skills/*.yaml", "assets/skills/*.yaml"],
      },
    };
    const files = new Map<string, string>();
    files.set("manifest.json", JSON.stringify(manifest));
    files.set("assets/skills/a.yaml", "a");
    const fs = createMemoryFileSystem(files);
    const result = buildPackage(fs);

    expect(result.success).toBe(true);
    // Should not have duplicate entries
    const skillPaths = result.package!.files.filter(
      (f) => f.archivePath.startsWith("assets/skills/"),
    );
    expect(skillPaths).toHaveLength(1);
  });

  it("produces deterministic lexicographically sorted archive file order", () => {
    const files = new Map<string, string>();
    files.set("manifest.json", JSON.stringify({
      name: "ordered-package",
      version: "1.0.0",
      description: "Ordering",
      author: { name: "Dev" },
      capabilities: ["skill:test"],
      dependencies: {},
      fridayVersionRange: ">=0.1.0",
      assets: {
        skills: ["assets/skills/*.yaml"],
      },
      hooks: {
        postInstall: "scripts/z-post.sh",
        preInstall: "scripts/a-pre.sh",
      },
    }));
    files.set("assets/skills/zeta.yaml", "zeta");
    files.set("assets/skills/alpha.yaml", "alpha");
    files.set("scripts/z-post.sh", "echo post");
    files.set("scripts/a-pre.sh", "echo pre");
    files.set("README.md", "# ordered");

    const fs = createMemoryFileSystem(files);
    const result = buildPackage(fs);

    expect(result.success).toBe(true);
    const archivePaths = result.package!.files.map((file) => file.archivePath);
    expect(archivePaths).toEqual([...archivePaths].sort((a, b) => a.localeCompare(b)));
  });
});

// ─── createMemoryFileSystem ───

describe("createMemoryFileSystem", () => {
  it("reads files by path", () => {
    const fs = createMemoryFileSystem(new Map([["a.txt", "hello"]]));
    expect(fs.readFile("a.txt")).toBe("hello");
  });

  it("returns null for missing files", () => {
    const fs = createMemoryFileSystem(new Map());
    expect(fs.readFile("missing.txt")).toBeNull();
  });

  it("checks file existence", () => {
    const fs = createMemoryFileSystem(new Map([["a.txt", "hello"]]));
    expect(fs.exists("a.txt")).toBe(true);
    expect(fs.exists("b.txt")).toBe(false);
  });

  it("matches glob patterns with *", () => {
    const files = new Map([
      ["assets/skills/a.yaml", "a"],
      ["assets/skills/b.yaml", "b"],
      ["assets/rules/c.yaml", "c"],
    ]);
    const fs = createMemoryFileSystem(files);
    const matches = fs.glob("assets/skills/*.yaml");
    expect(matches).toHaveLength(2);
    expect(matches).toContain("assets/skills/a.yaml");
    expect(matches).toContain("assets/skills/b.yaml");
  });

  it("matches exact paths without glob", () => {
    const files = new Map([["a.txt", "hello"]]);
    const fs = createMemoryFileSystem(files);
    expect(fs.glob("a.txt")).toEqual(["a.txt"]);
  });
});

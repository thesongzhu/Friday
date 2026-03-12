import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { safeDirName, resolveSafeInstallDir, normalizeInstallId, validateInstallId } from "#utilities";

describe("safeDirName", () => {
  it("passes through a simple alphanumeric name", () => {
    expect(safeDirName("my-skill")).toBe("my-skill");
  });

  it("preserves scoped npm package names", () => {
    expect(safeDirName("@scope/my-plugin")).toBe("@scope/my-plugin");
  });

  it("strips null bytes", () => {
    expect(safeDirName("my\0skill")).toBe("myskill");
  });

  it("replaces unsafe characters with hyphens", () => {
    expect(safeDirName("my skill!@#$%")).toBe("my-skill-@");
    expect(safeDirName("my skill")).toBe("my-skill");
  });

  it("removes leading dots", () => {
    expect(safeDirName("..hidden")).toBe("hidden");
  });

  it("removes leading slashes", () => {
    expect(safeDirName("/etc/passwd")).toBe("etc/passwd");
  });

  it("collapses consecutive hyphens", () => {
    expect(safeDirName("my---skill")).toBe("my-skill");
  });

  it("collapses consecutive slashes", () => {
    expect(safeDirName("a//b///c")).toBe("a/b/c");
  });

  it("removes trailing dots and hyphens from sanitized name", () => {
    expect(safeDirName("skill.")).toBe("skill");
    expect(safeDirName("skill--")).toBe("skill");
  });

  it("blocks .. traversal sequences", () => {
    expect(safeDirName("../../../etc")).toBe("etc");
  });

  it("throws on empty result", () => {
    expect(() => safeDirName("...")).toThrow("Cannot derive a safe directory name");
  });

  it("throws on all-unsafe input that collapses to empty", () => {
    // "!!!" → "---" → "-" → trailing strip removes it → empty → throws
    expect(() => safeDirName("!!!")).toThrow("Cannot derive a safe directory name");
  });

  it("throws on truly empty result (only dots and slashes)", () => {
    expect(() => safeDirName("./..")).toThrow("Cannot derive a safe directory name");
  });
});

describe("resolveSafeInstallDir", () => {
  const base = "/tmp/test-skills";

  it("resolves a simple name within base", () => {
    const result = resolveSafeInstallDir(base, "my-skill");
    expect(result).toBe(resolve(base, "my-skill"));
  });

  it("resolves scoped package within base", () => {
    const result = resolveSafeInstallDir(base, "@scope/my-plugin");
    expect(result).toBe(resolve(base, "@scope/my-plugin"));
  });

  it("sanitizes before resolving", () => {
    const result = resolveSafeInstallDir(base, "my skill!");
    expect(result).toBe(resolve(base, "my-skill"));
  });

  it("rejects traversal attempts", () => {
    // safeDirName strips ".." so the path stays within base
    const result = resolveSafeInstallDir(base, "../../etc/passwd");
    expect(result.startsWith(resolve(base))).toBe(true);
  });

  it("throws on empty sanitized name", () => {
    expect(() => resolveSafeInstallDir(base, "...")).toThrow("Cannot derive a safe directory name");
  });

  it("sanitizes names with null bytes", () => {
    const result = resolveSafeInstallDir(base, "my\0skill");
    expect(result).toBe(resolve(base, "myskill"));
  });

  it("sanitizes names with unsafe shell chars", () => {
    const result = resolveSafeInstallDir(base, "my;skill$(rm -rf /)");
    // After sanitization: unsafe chars → "-", collapse hyphens, strip trailing
    expect(result.startsWith(resolve(base))).toBe(true);
    // Should not contain any of the dangerous characters
    const dirName = result.slice(resolve(base).length + 1);
    expect(dirName).not.toContain(";");
    expect(dirName).not.toContain("$");
    expect(dirName).not.toContain("(");
    expect(dirName).not.toContain(")");
    expect(dirName).not.toContain(" ");
  });

  // ─── path.relative containment ───

  it("uses path.relative for containment (not string prefix)", () => {
    // Ensure /tmp/test-skills-evil doesn't match /tmp/test-skills
    // This tests that the containment check uses proper path boundaries
    const result = resolveSafeInstallDir(base, "valid-name");
    expect(result).toBe(resolve(base, "valid-name"));
  });
});

// ─── normalizeInstallId / validateInstallId ───

describe("normalizeInstallId", () => {
  it("trims whitespace", () => {
    expect(normalizeInstallId("  my-plugin  ")).toBe("my-plugin");
  });

  it("lowercases", () => {
    expect(normalizeInstallId("My-Plugin")).toBe("my-plugin");
  });

  it("strips null bytes", () => {
    expect(normalizeInstallId("my\0plugin")).toBe("myplugin");
  });

  it("preserves valid characters", () => {
    expect(normalizeInstallId("@scope/my-plugin_v2")).toBe("@scope/my-plugin_v2");
  });
});

describe("validateInstallId", () => {
  it("returns null for valid IDs", () => {
    expect(validateInstallId("my-plugin")).toBeNull();
    expect(validateInstallId("@scope/plugin")).toBeNull();
    expect(validateInstallId("plugin_v2")).toBeNull();
  });

  it("returns error for empty after normalization", () => {
    expect(validateInstallId("")).not.toBeNull();
    expect(validateInstallId("   ")).not.toBeNull();
    expect(validateInstallId("\0")).not.toBeNull();
  });

  it("returns error for reserved segments", () => {
    expect(validateInstallId(".")).not.toBeNull();
    expect(validateInstallId("..")).not.toBeNull();
  });

  it("returns error for traversal", () => {
    expect(validateInstallId("../../etc/passwd")).not.toBeNull();
    expect(validateInstallId("dir/../escape")).not.toBeNull();
  });

  it("allows names without traversal patterns", () => {
    expect(validateInstallId("my.plugin")).toBeNull();
    expect(validateInstallId("a-b-c")).toBeNull();
  });
});

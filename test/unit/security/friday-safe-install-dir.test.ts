import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import {
  normalizeInstallId,
  validateInstallId,
  safeDirName,
  resolveSafeInstallDir,
} from "../../../src/security/friday-safe-install-dir.js";

// ─── normalizeInstallId ───

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

  it("normalizes backslash separators to forward slashes", () => {
    expect(normalizeInstallId("scope\\name")).toBe("scope/name");
  });

  it("handles Windows-style double backslashes", () => {
    expect(normalizeInstallId("a\\\\b")).toBe("a//b");
  });
});

// ─── validateInstallId ───

describe("validateInstallId", () => {
  it("returns null for valid IDs", () => {
    expect(validateInstallId("my-plugin")).toBeNull();
    expect(validateInstallId("@scope/plugin")).toBeNull();
    expect(validateInstallId("plugin_v2")).toBeNull();
    expect(validateInstallId("simple")).toBeNull();
    expect(validateInstallId("1.0.0")).toBeNull();
    expect(validateInstallId("plugin-1.0.0-beta.1")).toBeNull();
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

  it("rejects absolute paths", () => {
    expect(validateInstallId("/etc/passwd")).not.toBeNull();
  });

  it("rejects Windows reserved names", () => {
    expect(validateInstallId("con")).not.toBeNull();
    expect(validateInstallId("prn")).not.toBeNull();
    expect(validateInstallId("aux")).not.toBeNull();
    expect(validateInstallId("nul")).not.toBeNull();
    expect(validateInstallId("com1")).not.toBeNull();
    expect(validateInstallId("lpt1")).not.toBeNull();
  });

  it("rejects IDs exceeding max length", () => {
    const longId = "a".repeat(215);
    expect(validateInstallId(longId)).not.toBeNull();
  });

  it("accepts IDs at max length", () => {
    const maxId = "a".repeat(214);
    expect(validateInstallId(maxId)).toBeNull();
  });

  it("respects custom max length policy", () => {
    expect(validateInstallId("abcdef", { maxLength: 5 })).not.toBeNull();
    expect(validateInstallId("abcde", { maxLength: 5 })).toBeNull();
  });

  it("rejects scoped packages when policy disallows", () => {
    expect(validateInstallId("@scope/name", { allowScoped: false })).not.toBeNull();
  });

  it("allows scoped packages by default", () => {
    expect(validateInstallId("@scope/name")).toBeNull();
  });

  it("rejects malformed scoped packages", () => {
    expect(validateInstallId("@scope-without-slash")).not.toBeNull();
  });

  it("rejects scoped package with empty name (@scope/)", () => {
    expect(validateInstallId("@scope/")).not.toBeNull();
  });

  it("rejects scoped package with empty scope (@/name)", () => {
    expect(validateInstallId("@/name")).not.toBeNull();
  });

  it("rejects scoped package with too many slashes (@scope/name/extra)", () => {
    expect(validateInstallId("@scope/name/extra")).not.toBeNull();
  });

  it("handles Windows-style paths in validation", () => {
    // Backslashes are normalized to forward slashes, then checked
    expect(validateInstallId("..\\..\\etc")).not.toBeNull();
  });

  it("rejects IDs that would alias to a different sanitized directory name", () => {
    expect(validateInstallId("my+plugin")).not.toBeNull();
    expect(validateInstallId("my!plugin")).not.toBeNull();
    expect(validateInstallId("my--plugin")).not.toBeNull();
    expect(validateInstallId(".plugin")).not.toBeNull();
    expect(validateInstallId("plugin-")).not.toBeNull();
    expect(validateInstallId("plugin.")).not.toBeNull();
  });

  it("rejects unscoped IDs that embed scope characters", () => {
    expect(validateInstallId("my@plugin")).not.toBeNull();
    expect(validateInstallId("scope/@plugin")).not.toBeNull();
  });
});

// ─── safeDirName ───

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
    expect(() => safeDirName("!!!")).toThrow("Cannot derive a safe directory name");
  });

  it("throws on truly empty result (only dots and slashes)", () => {
    expect(() => safeDirName("./..")).toThrow("Cannot derive a safe directory name");
  });

  it("normalizes backslash separators", () => {
    expect(safeDirName("a\\b\\c")).toBe("a/b/c");
  });

  it("handles Windows-style traversal paths", () => {
    expect(safeDirName("..\\..\\etc")).toBe("etc");
  });
});

// ─── resolveSafeInstallDir ───

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
    expect(result.startsWith(resolve(base))).toBe(true);
    const dirName = result.slice(resolve(base).length + 1);
    expect(dirName).not.toContain(";");
    expect(dirName).not.toContain("$");
    expect(dirName).not.toContain("(");
    expect(dirName).not.toContain(")");
    expect(dirName).not.toContain(" ");
  });

  it("uses path.relative for containment (not string prefix)", () => {
    const result = resolveSafeInstallDir(base, "valid-name");
    expect(result).toBe(resolve(base, "valid-name"));
  });

  it("handles version-suffixed IDs", () => {
    const result = resolveSafeInstallDir(base, "my-skill-1.0.0");
    expect(result).toBe(resolve(base, "my-skill-1.0.0"));
  });

  it("handles scoped packages with versions", () => {
    const result = resolveSafeInstallDir(base, "@scope/my-plugin");
    expect(result).toBe(resolve(base, "@scope/my-plugin"));
  });
});

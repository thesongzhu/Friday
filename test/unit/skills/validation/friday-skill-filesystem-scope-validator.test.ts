import { describe, it, expect } from "vitest";
import {
  validateFridayFilesystemScope,
  validateFridayManifestFilesystemScopes,
} from "#skills";
import { makeManifest } from "../_helpers/make-manifest.helper.js";

describe("validateFridayFilesystemScope", () => {
  const base = {
    skillDir: "/workspace/skills/my-skill",
    workspaceDir: "/workspace",
  };

  it("accepts a path within skill directory", () => {
    const result = validateFridayFilesystemScope({
      ...base,
      scope: "data/output",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts workspace root scope", () => {
    const result = validateFridayFilesystemScope({
      ...base,
      scope: "/workspace/shared",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects path traversal that escapes workspace", () => {
    const result = validateFridayFilesystemScope({
      ...base,
      scope: "../../../../etc/passwd",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("outside allowed");
  });

  it("rejects forbidden absolute paths outside workspace", () => {
    const result = validateFridayFilesystemScope({
      ...base,
      scope: "/etc/shadow",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("outside allowed");
  });

  it("accepts paths in absoluteAllowPrefixes", () => {
    const result = validateFridayFilesystemScope({
      ...base,
      scope: "/tmp/friday-data/cache",
      absoluteAllowPrefixes: ["/tmp/friday-data"],
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateFridayManifestFilesystemScopes", () => {
  it("returns issues for invalid scopes in manifest permissions", () => {
    const manifest = makeManifest({
      permissions: {
        grants: [
          {
            id: "fs.read",
            resource: "filesystem",
            action: "read",
            required: true,
            reason: "Read files",
            selectors: { pathPrefixes: ["/etc/shadow"] },
          },
        ],
        promptOn: [],
      },
    });

    const issues = validateFridayManifestFilesystemScopes(
      manifest,
      "/workspace/skills/test",
      "/workspace",
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.code).toBe("FILESYSTEM_SCOPE_VIOLATION");
  });

  it("returns no issues for valid scopes", () => {
    const manifest = makeManifest({
      permissions: {
        grants: [
          {
            id: "fs.read",
            resource: "filesystem",
            action: "read",
            required: true,
            reason: "Read files",
            selectors: { pathPrefixes: ["./data"] },
          },
        ],
        promptOn: [],
      },
    });

    const issues = validateFridayManifestFilesystemScopes(
      manifest,
      "/workspace/skills/test",
      "/workspace",
    );
    expect(issues).toEqual([]);
  });

  it("skips non-filesystem grants", () => {
    const manifest = makeManifest({
      permissions: {
        grants: [
          {
            id: "net.connect",
            resource: "network",
            action: "connect",
            required: true,
            reason: "Connect",
          },
        ],
        promptOn: [],
      },
    });

    const issues = validateFridayManifestFilesystemScopes(
      manifest,
      "/workspace/skills/test",
      "/workspace",
    );
    expect(issues).toEqual([]);
  });
});

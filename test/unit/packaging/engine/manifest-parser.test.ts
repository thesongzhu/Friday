import { describe, it, expect } from "vitest";
import {
  parseManifestJson,
  validateManifestObject,
  serializeManifest,
} from "../../../../src/packaging/engine/manifest-parser.js";
import type { FridayPackageManifest } from "../../../../src/packaging/model/friday-packaging.types.js";

// ─── Fixtures ───

function validManifestObj(): Record<string, unknown> {
  return {
    name: "@friday/example-skills",
    version: "1.2.3",
    description: "Example skill package for Friday agents",
    author: {
      name: "Friday Team",
      email: "team@friday.dev",
      url: "https://friday.dev",
    },
    license: "MIT",
    capabilities: ["skill:web-search", "skill:code-analysis"],
    dependencies: {
      "@friday/core-utils": "^2.0.0",
    },
    peerDependencies: {
      "@friday/rules-engine": "^1.0.0",
    },
    fridayVersionRange: ">=0.10.0 <1.0.0",
    assets: {
      skills: ["assets/skills/*.yaml"],
      rules: ["assets/rules/*.yaml"],
    },
    hooks: {
      preInstall: "migrations/001-initial.sql",
      postInstall: null,
    },
    metadata: {
      repository: "https://github.com/friday-ai/example-skills",
      keywords: ["skills", "web"],
      tenantScopes: ["*"],
    },
  };
}

function validManifestJson(): string {
  return JSON.stringify(validManifestObj());
}

// ─── parseManifestJson ───

describe("parseManifestJson", () => {
  it("parses a valid manifest JSON string", () => {
    const result = parseManifestJson(validManifestJson());
    expect(result.success).toBe(true);
    expect(result.manifest).not.toBeNull();
    expect(result.manifest!.name).toBe("@friday/example-skills");
    expect(result.manifest!.version).toBe("1.2.3");
    expect(result.manifest!.capabilities).toEqual(["skill:web-search", "skill:code-analysis"]);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects invalid JSON", () => {
    const result = parseManifestJson("{invalid json");
    expect(result.success).toBe(false);
    expect(result.manifest).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toContain("Invalid JSON");
  });

  it("rejects non-object JSON", () => {
    const result = parseManifestJson('"just a string"');
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toContain("must be a JSON object");
  });
});

// ─── validateManifestObject ───

describe("validateManifestObject", () => {
  it("validates a complete manifest object", () => {
    const result = validateManifestObject(validManifestObj());
    expect(result.success).toBe(true);
    expect(result.manifest).not.toBeNull();
    expect(result.errors).toHaveLength(0);
  });

  it("rejects missing name", () => {
    const obj = validManifestObj();
    delete obj.name;
    const result = validateManifestObject(obj);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path === "name")).toBe(true);
  });

  it("rejects invalid package name format", () => {
    const obj = validManifestObj();
    obj.name = "INVALID_NAME";
    const result = validateManifestObject(obj);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path === "name")).toBe(true);
  });

  it("accepts plain (unscoped) package name", () => {
    const obj = validManifestObj();
    obj.name = "my-package";
    const result = validateManifestObject(obj);
    expect(result.success).toBe(true);
  });

  it("rejects invalid version", () => {
    const obj = validManifestObj();
    obj.version = "not-semver";
    const result = validateManifestObject(obj);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path === "version")).toBe(true);
  });

  it("rejects missing description", () => {
    const obj = validManifestObj();
    delete obj.description;
    const result = validateManifestObject(obj);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path === "description")).toBe(true);
  });

  it("rejects missing author", () => {
    const obj = validManifestObj();
    delete obj.author;
    const result = validateManifestObject(obj);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path === "author")).toBe(true);
  });

  it("rejects author with missing name", () => {
    const obj = validManifestObj();
    obj.author = { email: "a@b.com" };
    const result = validateManifestObject(obj);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path === "author.name")).toBe(true);
  });

  it("rejects invalid capability format", () => {
    const obj = validManifestObj();
    obj.capabilities = ["invalid-format"];
    const result = validateManifestObject(obj);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path.startsWith("capabilities"))).toBe(true);
  });

  it("rejects non-string dependency values", () => {
    const obj = validManifestObj();
    obj.dependencies = { "@friday/core": 123 };
    const result = validateManifestObject(obj);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path.startsWith("dependencies"))).toBe(true);
  });

  it("rejects invalid dependency semver ranges", () => {
    const obj = validManifestObj();
    obj.dependencies = { "@friday/core": "not-a-range" };
    const result = validateManifestObject(obj);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path === "dependencies.@friday/core")).toBe(true);
  });

  it("rejects invalid peer dependency semver ranges", () => {
    const obj = validManifestObj();
    obj.peerDependencies = { "@friday/rules-engine": "x.y.z" };
    const result = validateManifestObject(obj);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path === "peerDependencies.@friday/rules-engine")).toBe(true);
  });

  it("accepts syntactically valid dependency ranges that do not match 0.0.0", () => {
    const obj = validManifestObj();
    obj.dependencies = { "@friday/core-utils": ">=2.0.0" };
    const result = validateManifestObject(obj);
    expect(result.success).toBe(true);
  });

  it("rejects missing fridayVersionRange", () => {
    const obj = validManifestObj();
    delete obj.fridayVersionRange;
    const result = validateManifestObject(obj);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path === "fridayVersionRange")).toBe(true);
  });

  it("validates assets with non-string-array values", () => {
    const obj = validManifestObj();
    obj.assets = { skills: [123] };
    const result = validateManifestObject(obj);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path === "assets.skills")).toBe(true);
  });

  it("validates hooks with non-string/null values", () => {
    const obj = validManifestObj();
    obj.hooks = { preInstall: 123 };
    const result = validateManifestObject(obj);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path === "hooks.preInstall")).toBe(true);
  });

  it("validates metadata keywords as string array", () => {
    const obj = validManifestObj();
    obj.metadata = { keywords: [123, 456] };
    const result = validateManifestObject(obj);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path === "metadata.keywords")).toBe(true);
  });

  it("rejects non-string license", () => {
    const obj = validManifestObj();
    obj.license = 123;
    const result = validateManifestObject(obj);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path === "license")).toBe(true);
  });

  it("handles optional fields gracefully", () => {
    const obj: Record<string, unknown> = {
      name: "my-package",
      version: "1.0.0",
      description: "A package",
      author: { name: "Dev" },
      capabilities: ["skill:test"],
      dependencies: {},
      fridayVersionRange: ">=0.1.0",
      assets: {},
    };
    const result = validateManifestObject(obj);
    expect(result.success).toBe(true);
    expect(result.manifest!.license).toBeUndefined();
    expect(result.manifest!.hooks).toBeUndefined();
    expect(result.manifest!.metadata).toBeUndefined();
    expect(result.manifest!.peerDependencies).toBeUndefined();
  });
});

// ─── serializeManifest ───

describe("serializeManifest", () => {
  it("serializes a manifest to formatted JSON", () => {
    const result = parseManifestJson(validManifestJson());
    const json = serializeManifest(result.manifest!);
    expect(typeof json).toBe("string");
    const parsed = JSON.parse(json);
    expect(parsed.name).toBe("@friday/example-skills");
  });

  it("roundtrips a manifest", () => {
    const result1 = parseManifestJson(validManifestJson());
    const json = serializeManifest(result1.manifest!);
    const result2 = parseManifestJson(json);
    expect(result2.success).toBe(true);
    expect(result2.manifest!.name).toBe(result1.manifest!.name);
    expect(result2.manifest!.version).toBe(result1.manifest!.version);
  });

  it("produces canonical JSON regardless of input key order", () => {
    const manifestA = validateManifestObject({
      name: "my-package",
      version: "1.0.0",
      description: "A package",
      author: { name: "Dev" },
      capabilities: ["skill:test"],
      dependencies: {},
      fridayVersionRange: ">=0.1.0",
      assets: {
        skills: ["assets/skills/*.yaml"],
        providers: ["assets/providers/*.json"],
      },
      metadata: {
        tenantScopes: ["tenant-1"],
        keywords: ["test", "pkg"],
        repository: "https://example.dev/repo",
      },
    });

    const manifestB = validateManifestObject({
      version: "1.0.0",
      name: "my-package",
      author: { name: "Dev" },
      description: "A package",
      dependencies: {},
      capabilities: ["skill:test"],
      assets: {
        providers: ["assets/providers/*.json"],
        skills: ["assets/skills/*.yaml"],
      },
      fridayVersionRange: ">=0.1.0",
      metadata: {
        repository: "https://example.dev/repo",
        keywords: ["test", "pkg"],
        tenantScopes: ["tenant-1"],
      },
    });

    expect(manifestA.success).toBe(true);
    expect(manifestB.success).toBe(true);
    expect(serializeManifest(manifestA.manifest!)).toBe(serializeManifest(manifestB.manifest!));
  });

  it("changes canonical JSON when values change", () => {
    const base = parseManifestJson(validManifestJson());
    const changed = validateManifestObject({
      ...validManifestObj(),
      metadata: {
        ...(validManifestObj().metadata as Record<string, unknown>),
        repository: "https://github.com/friday-ai/other-repo",
      },
    });

    expect(base.success).toBe(true);
    expect(changed.success).toBe(true);
    expect(serializeManifest(base.manifest!)).not.toBe(serializeManifest(changed.manifest!));
  });
});

import { describe, it, expect } from "vitest";
import { validateFridayPluginManifest } from "#plugins";
import { FridayDomainError } from "#errors";

/** Minimal valid manifest for testing. */
function validManifest(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    id: "friday.test.plugin",
    version: "1.0.0",
    name: "Test Plugin",
    description: "A test plugin for validation",
    kinds: ["skill"],
    entrypoints: { skill: "./dist/skill.js" },
    permissions: {
      grants: [],
      promptOn: [],
    },
    compatibility: {
      minHubVersion: "0.1.0",
      apiVersion: "1",
    },
    ...overrides,
  };
}

describe("validateFridayPluginManifest", () => {
  // ─── Valid manifests ───

  it("accepts a minimal valid manifest", () => {
    const result = validateFridayPluginManifest(validManifest());
    expect(result.id).toBe("friday.test.plugin");
    expect(result.version).toBe("1.0.0");
    expect(result.kinds).toEqual(["skill"]);
  });

  it("accepts manifest with multiple kinds", () => {
    const result = validateFridayPluginManifest(validManifest({
      kinds: ["skill", "provider"],
      entrypoints: { skill: "./dist/skill.js", provider: "./dist/provider.js" },
    }));
    expect(result.kinds).toEqual(["skill", "provider"]);
  });

  it("accepts manifest with dependencies", () => {
    const result = validateFridayPluginManifest(validManifest({
      dependencies: { "friday.core.storage": "^1.0.0" },
    }));
    expect(result.dependencies).toEqual({ "friday.core.storage": "^1.0.0" });
  });

  it("accepts manifest with signature", () => {
    const result = validateFridayPluginManifest(validManifest({
      signature: {
        algorithm: "ed25519",
        keyId: "key-001",
        value: "c2lnbmF0dXJlLXZhbHVl",
      },
    }));
    expect(result.signature).toBeDefined();
    expect(result.signature!.algorithm).toBe("ed25519");
  });

  it("accepts manifest with permission grants", () => {
    const result = validateFridayPluginManifest(validManifest({
      permissions: {
        grants: [
          {
            id: "read-fs",
            resource: "filesystem",
            action: "read",
            required: true,
            reason: "Needs to read config files",
          },
        ],
        promptOn: ["filesystem.write"],
      },
    }));
    expect(result.permissions.grants).toHaveLength(1);
    expect(result.permissions.promptOn).toEqual(["filesystem.write"]);
  });

  it("accepts manifest with previewSdk metadata", () => {
    const result = validateFridayPluginManifest(validManifest({
      previewSdk: {
        sdkVersion: "2026-03-preview",
        capabilities: ["registerTool", "registerHooks"],
        publisherId: "partner.weather",
      },
    }));

    expect(result.previewSdk).toEqual({
      sdkVersion: "2026-03-preview",
      capabilities: ["registerTool", "registerHooks"],
      publisherId: "partner.weather",
    });
  });

  // ─── Required fields ───

  it("rejects null input", () => {
    expect(() => validateFridayPluginManifest(null)).toThrow(FridayDomainError);
  });

  it("rejects array input", () => {
    expect(() => validateFridayPluginManifest([])).toThrow(FridayDomainError);
  });

  it("rejects missing schemaVersion", () => {
    expect(() => validateFridayPluginManifest(validManifest({ schemaVersion: undefined }))).toThrow("schemaVersion");
  });

  it("rejects invalid schemaVersion", () => {
    expect(() => validateFridayPluginManifest(validManifest({ schemaVersion: "2.0" }))).toThrow("schemaVersion");
  });

  it("rejects missing id", () => {
    expect(() => validateFridayPluginManifest(validManifest({ id: undefined }))).toThrow("id");
  });

  it("rejects invalid plugin id format", () => {
    expect(() => validateFridayPluginManifest(validManifest({ id: "invalid" }))).toThrow("id");
    expect(() => validateFridayPluginManifest(validManifest({ id: "INVALID.plugin" }))).toThrow("id");
  });

  it("rejects missing version", () => {
    expect(() => validateFridayPluginManifest(validManifest({ version: undefined }))).toThrow("version");
  });

  it("rejects invalid semver version", () => {
    expect(() => validateFridayPluginManifest(validManifest({ version: "not-a-version" }))).toThrow("version");
  });

  it("rejects missing name", () => {
    expect(() => validateFridayPluginManifest(validManifest({ name: "" }))).toThrow("name");
  });

  it("rejects missing description", () => {
    expect(() => validateFridayPluginManifest(validManifest({ description: "" }))).toThrow("description");
  });

  it("rejects missing kinds", () => {
    expect(() => validateFridayPluginManifest(validManifest({ kinds: undefined }))).toThrow("kinds");
  });

  it("rejects empty kinds array", () => {
    expect(() => validateFridayPluginManifest(validManifest({ kinds: [] }))).toThrow("kinds");
  });

  it("rejects invalid kind value", () => {
    expect(() => validateFridayPluginManifest(validManifest({ kinds: ["invalid_kind"] }))).toThrow("kinds");
  });

  // ─── Kind/Entrypoint matching ───

  it("rejects missing entrypoint for declared kind", () => {
    expect(() => validateFridayPluginManifest(validManifest({
      kinds: ["skill", "channel"],
      entrypoints: { skill: "./dist/skill.js" },
    }))).toThrow("entrypoints.channel");
  });

  it("rejects non-object entrypoints", () => {
    expect(() => validateFridayPluginManifest(validManifest({ entrypoints: "bad" }))).toThrow("entrypoints");
  });

  // ─── Dependencies validation ───

  it("rejects invalid dependency plugin ID", () => {
    expect(() => validateFridayPluginManifest(validManifest({
      dependencies: { "INVALID": "^1.0.0" },
    }))).toThrow("dependencies");
  });

  it("rejects invalid semver range in dependencies", () => {
    expect(() => validateFridayPluginManifest(validManifest({
      dependencies: { "friday.dep.plugin": "" },
    }))).toThrow("dependencies");
  });

  it("rejects non-object dependencies", () => {
    expect(() => validateFridayPluginManifest(validManifest({
      dependencies: "bad",
    }))).toThrow("dependencies");
  });

  // ─── Compatibility validation ───

  it("rejects missing compatibility", () => {
    expect(() => validateFridayPluginManifest(validManifest({ compatibility: undefined }))).toThrow("compatibility");
  });

  it("rejects invalid apiVersion", () => {
    expect(() => validateFridayPluginManifest(validManifest({
      compatibility: { minHubVersion: "0.1.0", apiVersion: "2" },
    }))).toThrow("apiVersion");
  });

  it("rejects invalid minHubVersion", () => {
    expect(() => validateFridayPluginManifest(validManifest({
      compatibility: { minHubVersion: "not-semver", apiVersion: "1" },
    }))).toThrow("minHubVersion");
  });

  // ─── Permissions validation ───

  it("rejects missing permissions", () => {
    expect(() => validateFridayPluginManifest(validManifest({ permissions: undefined }))).toThrow("permissions");
  });

  it("rejects invalid grant in permissions", () => {
    expect(() => validateFridayPluginManifest(validManifest({
      permissions: {
        grants: [{ id: "", resource: "invalid", action: "read", required: true, reason: "x" }],
        promptOn: [],
      },
    }))).toThrow("grants");
  });

  it("rejects invalid promptOn action", () => {
    expect(() => validateFridayPluginManifest(validManifest({
      permissions: {
        grants: [],
        promptOn: ["invalid.action"],
      },
    }))).toThrow("promptOn");
  });

  it("rejects previewSdk with invalid capability", () => {
    expect(() => validateFridayPluginManifest(validManifest({
      previewSdk: {
        sdkVersion: "2026-03-preview",
        capabilities: ["registerTool", "explodeRuntime"],
      },
    }))).toThrow("previewSdk");
  });

  it("rejects previewSdk without sdkVersion", () => {
    expect(() => validateFridayPluginManifest(validManifest({
      previewSdk: {
        sdkVersion: "",
        capabilities: ["registerTool"],
      },
    }))).toThrow("previewSdk");
  });

  // ─── Signature validation ───

  it("rejects signature with invalid algorithm", () => {
    expect(() => validateFridayPluginManifest(validManifest({
      signature: { algorithm: "rsa", keyId: "k1", value: "v1" },
    }))).toThrow("algorithm");
  });

  it("rejects signature with missing keyId", () => {
    expect(() => validateFridayPluginManifest(validManifest({
      signature: { algorithm: "ed25519", keyId: "", value: "v1" },
    }))).toThrow("keyId");
  });

  it("rejects signature with missing value", () => {
    expect(() => validateFridayPluginManifest(validManifest({
      signature: { algorithm: "ed25519", keyId: "k1", value: "" },
    }))).toThrow("value");
  });

  // ─── Error structure ───

  it("throws FridayDomainError with PLUGIN_MANIFEST_INVALID code", () => {
    try {
      validateFridayPluginManifest({});
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridayDomainError);
      expect((err as FridayDomainError).code).toBe("PLUGIN_MANIFEST_INVALID");
      expect((err as FridayDomainError).httpStatus).toBe(400);
    }
  });

  it("includes validation errors in details", () => {
    try {
      validateFridayPluginManifest({});
      expect.fail("Should have thrown");
    } catch (err) {
      const domainErr = err as FridayDomainError;
      expect(domainErr.details.errors).toBeDefined();
      expect(Array.isArray(domainErr.details.errors)).toBe(true);
    }
  });
});

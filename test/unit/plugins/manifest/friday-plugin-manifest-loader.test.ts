import { describe, it, expect } from "vitest";
import { createFridayPluginManifestLoader } from "#plugins";
import { FridayDomainError } from "#errors";

function validManifestJson(): string {
  return JSON.stringify({
    schemaVersion: "1.0",
    id: "friday.test.plugin",
    version: "1.0.0",
    name: "Test Plugin",
    description: "A test plugin",
    kinds: ["skill"],
    entrypoints: { skill: "./dist/skill.js" },
    permissions: { grants: [], promptOn: [] },
    compatibility: { minHubVersion: "0.1.0", apiVersion: "1" },
  });
}

describe("FridayPluginManifestLoader", () => {
  it("loads and validates manifest from directory", () => {
    const loader = createFridayPluginManifestLoader({
      readFile: () => validManifestJson(),
      fileExists: () => true,
    });

    const manifest = loader.loadFromDirectory("/fake/plugin");
    expect(manifest.id).toBe("friday.test.plugin");
    expect(manifest.version).toBe("1.0.0");
  });

  it("throws PLUGIN_MANIFEST_NOT_FOUND when file missing", () => {
    const loader = createFridayPluginManifestLoader({
      readFile: () => "",
      fileExists: () => false,
    });

    expect(() => loader.loadFromDirectory("/fake/plugin")).toThrow(FridayDomainError);
    try {
      loader.loadFromDirectory("/fake/plugin");
    } catch (err) {
      expect((err as FridayDomainError).code).toBe("PLUGIN_MANIFEST_NOT_FOUND");
      expect((err as FridayDomainError).httpStatus).toBe(404);
    }
  });

  it("throws PLUGIN_MANIFEST_PARSE_ERROR for invalid JSON", () => {
    const loader = createFridayPluginManifestLoader({
      readFile: () => "not valid json {{{",
      fileExists: () => true,
    });

    expect(() => loader.loadFromDirectory("/fake/plugin")).toThrow(FridayDomainError);
    try {
      loader.loadFromDirectory("/fake/plugin");
    } catch (err) {
      expect((err as FridayDomainError).code).toBe("PLUGIN_MANIFEST_PARSE_ERROR");
    }
  });

  it("throws PLUGIN_MANIFEST_PARSE_ERROR when readFile fails", () => {
    const loader = createFridayPluginManifestLoader({
      readFile: () => { throw new Error("ENOENT"); },
      fileExists: () => true,
    });

    expect(() => loader.loadFromDirectory("/fake/plugin")).toThrow(FridayDomainError);
    try {
      loader.loadFromDirectory("/fake/plugin");
    } catch (err) {
      expect((err as FridayDomainError).code).toBe("PLUGIN_MANIFEST_PARSE_ERROR");
    }
  });

  it("throws PLUGIN_MANIFEST_INVALID for structurally invalid manifest", () => {
    const loader = createFridayPluginManifestLoader({
      readFile: () => JSON.stringify({ invalid: true }),
      fileExists: () => true,
    });

    expect(() => loader.loadFromDirectory("/fake/plugin")).toThrow(FridayDomainError);
    try {
      loader.loadFromDirectory("/fake/plugin");
    } catch (err) {
      expect((err as FridayDomainError).code).toBe("PLUGIN_MANIFEST_INVALID");
    }
  });

  it("validate method works standalone", () => {
    const loader = createFridayPluginManifestLoader();
    const manifest = loader.validate(JSON.parse(validManifestJson()));
    expect(manifest.id).toBe("friday.test.plugin");
  });
});

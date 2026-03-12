import { describe, it, expect } from "vitest";
import { createFridayPluginDiscoveryService, createFridayPluginManifestLoader } from "#plugins";
import type { FridayPluginManifest } from "#plugins";

function makeManifest(id: string): FridayPluginManifest {
  return {
    schemaVersion: "1.0",
    id,
    version: "1.0.0",
    name: `Plugin ${id}`,
    description: `Plugin ${id} description`,
    kinds: ["skill"],
    entrypoints: { skill: "./dist/skill.js" },
    permissions: { grants: [], promptOn: [] },
    compatibility: { minHubVersion: "0.1.0", apiVersion: "1" },
  };
}

describe("FridayPluginDiscoveryService", () => {
  it("discovers plugins in local directories", () => {
    const manifests: Record<string, FridayPluginManifest> = {
      "/plugins/alpha": makeManifest("friday.test.alpha"),
      "/plugins/beta": makeManifest("friday.test.beta"),
    };

    const manifestLoader = createFridayPluginManifestLoader({
      readFile: (p: string) => {
        const dir = p.replace("/friday.plugin.json", "");
        const m = manifests[dir];
        if (!m) throw new Error(`Not found: ${p}`);
        return JSON.stringify(m);
      },
      fileExists: (p: string) => {
        const dir = p.replace("/friday.plugin.json", "");
        return dir in manifests;
      },
    });

    const discovery = createFridayPluginDiscoveryService({
      manifestLoader,
      readdir: (dirPath: string) => {
        if (dirPath === "/plugins") return ["alpha", "beta", "not-a-plugin"];
        return [];
      },
      isDirectory: (p: string) => {
        return ["/plugins", "/plugins/alpha", "/plugins/beta", "/plugins/not-a-plugin"].includes(p);
      },
      fileExists: (p: string) => {
        return p === "/plugins/alpha/friday.plugin.json" || p === "/plugins/beta/friday.plugin.json";
      },
    });

    const candidates = discovery.discoverLocal(["/plugins"]);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].id).toBe("friday.test.alpha");
    expect(candidates[0].source).toBe("local");
    expect(candidates[0].installPath).toBe("/plugins/alpha");
    expect(candidates[1].id).toBe("friday.test.beta");
  });

  it("skips non-directory entries", () => {
    const manifestLoader = createFridayPluginManifestLoader({
      readFile: () => JSON.stringify(makeManifest("friday.test.file")),
      fileExists: () => true,
    });

    const discovery = createFridayPluginDiscoveryService({
      manifestLoader,
      readdir: () => ["some-file.txt"],
      isDirectory: (p: string) => p === "/plugins",
      fileExists: () => false,
    });

    const candidates = discovery.discoverLocal(["/plugins"]);
    expect(candidates).toHaveLength(0);
  });

  it("skips directories without manifest", () => {
    const manifestLoader = createFridayPluginManifestLoader({
      readFile: () => { throw new Error("not found"); },
      fileExists: () => false,
    });

    const discovery = createFridayPluginDiscoveryService({
      manifestLoader,
      readdir: () => ["empty-plugin"],
      isDirectory: () => true,
      fileExists: () => false,
    });

    const candidates = discovery.discoverLocal(["/plugins"]);
    expect(candidates).toHaveLength(0);
  });

  it("skips plugins with invalid manifests during discovery", () => {
    const manifestLoader = createFridayPluginManifestLoader({
      readFile: () => JSON.stringify({ invalid: true }),
      fileExists: () => true,
    });

    const discovery = createFridayPluginDiscoveryService({
      manifestLoader,
      readdir: () => ["bad-plugin"],
      isDirectory: () => true,
      fileExists: () => true,
    });

    const candidates = discovery.discoverLocal(["/plugins"]);
    expect(candidates).toHaveLength(0);
  });

  it("skips non-existent base paths", () => {
    const manifestLoader = createFridayPluginManifestLoader();

    const discovery = createFridayPluginDiscoveryService({
      manifestLoader,
      readdir: () => [],
      isDirectory: () => false,
      fileExists: () => false,
    });

    const candidates = discovery.discoverLocal(["/nonexistent"]);
    expect(candidates).toHaveLength(0);
  });

  it("discoverAll delegates to discoverLocal", () => {
    const manifests: Record<string, FridayPluginManifest> = {
      "/plugins/alpha": makeManifest("friday.test.alpha"),
    };

    const manifestLoader = createFridayPluginManifestLoader({
      readFile: (p: string) => {
        const dir = p.replace("/friday.plugin.json", "");
        return JSON.stringify(manifests[dir]);
      },
      fileExists: (p: string) => {
        const dir = p.replace("/friday.plugin.json", "");
        return dir in manifests;
      },
    });

    const discovery = createFridayPluginDiscoveryService({
      manifestLoader,
      readdir: (dirPath: string) => dirPath === "/plugins" ? ["alpha"] : [],
      isDirectory: (p: string) => ["/plugins", "/plugins/alpha"].includes(p),
      fileExists: (p: string) => p === "/plugins/alpha/friday.plugin.json",
    });

    const candidates = discovery.discoverAll({ localPaths: ["/plugins"] });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe("friday.test.alpha");
  });

  it("discoverAll returns empty with no paths", () => {
    const manifestLoader = createFridayPluginManifestLoader();
    const discovery = createFridayPluginDiscoveryService({
      manifestLoader,
      readdir: () => [],
      isDirectory: () => false,
      fileExists: () => false,
    });

    const candidates = discovery.discoverAll();
    expect(candidates).toHaveLength(0);
  });
});

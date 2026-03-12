import { describe, it, expect } from "vitest";
import { createFridayPluginDependencyResolver } from "#plugins";
import type { FridayPluginEntity, FridayPluginManifest } from "#plugins";
import { FridayDomainError } from "#errors";

function makeEntity(id: string, version: string, dependencies?: Record<string, string>): FridayPluginEntity {
  const manifest: FridayPluginManifest = {
    schemaVersion: "1.0",
    id,
    version,
    name: `Plugin ${id}`,
    description: `Plugin ${id} description`,
    kinds: ["skill"],
    entrypoints: { skill: "./dist/skill.js" },
    dependencies,
    permissions: { grants: [], promptOn: [] },
    compatibility: { minHubVersion: "0.1.0", apiVersion: "1" },
  };
  return {
    id,
    name: `Plugin ${id}`,
    description: `Plugin ${id} description`,
    version,
    source: "local",
    status: "installed",
    enabled: false,
    trustMode: "trust_on_install",
    installPath: `/plugins/${id}`,
    kinds: ["skill"],
    manifest,
    config: {},
    signatureAlgorithm: null,
    signatureKeyId: null,
    signatureValue: null,
    signatureVerified: false,
    trustedFingerprintSha256: null,
    lastVerifiedAt: null,
    installedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastErrorCode: null,
    lastErrorMessage: null,
  };
}

describe("FridayPluginDependencyResolver", () => {
  const resolver = createFridayPluginDependencyResolver();

  // ─── Valid DAG ───

  it("resolves single plugin with no dependencies", () => {
    const plugins = [makeEntity("friday.test.alpha", "1.0.0")];
    const plan = resolver.resolveLoadOrder(plugins, ["friday.test.alpha"]);
    expect(plan.order).toEqual(["friday.test.alpha"]);
    expect(plan.warnings).toHaveLength(0);
  });

  it("resolves all plugins when no pluginIds given", () => {
    const plugins = [
      makeEntity("friday.test.alpha", "1.0.0"),
      makeEntity("friday.test.beta", "1.0.0"),
    ];
    const plan = resolver.resolveLoadOrder(plugins);
    expect(plan.order).toEqual(["friday.test.alpha", "friday.test.beta"]);
  });

  it("resolves linear dependency chain", () => {
    const plugins = [
      makeEntity("friday.test.alpha", "1.0.0", { "friday.test.beta": "^1.0.0" }),
      makeEntity("friday.test.beta", "1.0.0", { "friday.test.gamma": "^1.0.0" }),
      makeEntity("friday.test.gamma", "1.0.0"),
    ];
    const plan = resolver.resolveLoadOrder(plugins, ["friday.test.alpha"]);
    expect(plan.order).toEqual(["friday.test.gamma", "friday.test.beta", "friday.test.alpha"]);
  });

  it("resolves diamond dependency", () => {
    // alpha -> beta, gamma
    // beta -> delta
    // gamma -> delta
    const plugins = [
      makeEntity("friday.test.alpha", "1.0.0", {
        "friday.test.beta": "^1.0.0",
        "friday.test.gamma": "^1.0.0",
      }),
      makeEntity("friday.test.beta", "1.0.0", { "friday.test.delta": "^1.0.0" }),
      makeEntity("friday.test.gamma", "1.0.0", { "friday.test.delta": "^1.0.0" }),
      makeEntity("friday.test.delta", "1.0.0"),
    ];
    const plan = resolver.resolveLoadOrder(plugins, ["friday.test.alpha"]);
    // delta first, then beta/gamma (lexical), then alpha
    expect(plan.order[0]).toBe("friday.test.delta");
    expect(plan.order[plan.order.length - 1]).toBe("friday.test.alpha");
    // beta and gamma should both be before alpha
    expect(plan.order.indexOf("friday.test.beta")).toBeLessThan(plan.order.indexOf("friday.test.alpha"));
    expect(plan.order.indexOf("friday.test.gamma")).toBeLessThan(plan.order.indexOf("friday.test.alpha"));
  });

  it("uses lexical tie-break for plugins at same level", () => {
    const plugins = [
      makeEntity("friday.test.charlie", "1.0.0"),
      makeEntity("friday.test.alpha", "1.0.0"),
      makeEntity("friday.test.bravo", "1.0.0"),
    ];
    const plan = resolver.resolveLoadOrder(plugins);
    expect(plan.order).toEqual(["friday.test.alpha", "friday.test.bravo", "friday.test.charlie"]);
  });

  // ─── Missing dependency ───

  it("throws PLUGIN_DEPENDENCY_MISSING for missing dependency", () => {
    const plugins = [
      makeEntity("friday.test.alpha", "1.0.0", { "friday.test.missing": "^1.0.0" }),
    ];

    try {
      resolver.resolveLoadOrder(plugins, ["friday.test.alpha"]);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridayDomainError);
      expect((err as FridayDomainError).code).toBe("PLUGIN_DEPENDENCY_MISSING");
    }
  });

  it("throws PLUGIN_DEPENDENCY_MISSING for missing target plugin", () => {
    const plugins = [makeEntity("friday.test.alpha", "1.0.0")];

    try {
      resolver.resolveLoadOrder(plugins, ["friday.test.missing"]);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridayDomainError);
      expect((err as FridayDomainError).code).toBe("PLUGIN_DEPENDENCY_MISSING");
    }
  });

  // ─── Version mismatch ───

  it("throws PLUGIN_DEPENDENCY_VERSION_MISMATCH for incompatible version", () => {
    const plugins = [
      makeEntity("friday.test.alpha", "1.0.0", { "friday.test.beta": "^2.0.0" }),
      makeEntity("friday.test.beta", "1.0.0"),
    ];

    try {
      resolver.resolveLoadOrder(plugins, ["friday.test.alpha"]);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridayDomainError);
      const domainErr = err as FridayDomainError;
      expect(domainErr.code).toBe("PLUGIN_DEPENDENCY_VERSION_MISMATCH");
      expect(domainErr.details.requiredRange).toBe("^2.0.0");
      expect(domainErr.details.installedVersion).toBe("1.0.0");
    }
  });

  it("accepts compatible semver range", () => {
    const plugins = [
      makeEntity("friday.test.alpha", "1.0.0", { "friday.test.beta": "^1.0.0" }),
      makeEntity("friday.test.beta", "1.2.3"),
    ];

    const plan = resolver.resolveLoadOrder(plugins, ["friday.test.alpha"]);
    expect(plan.order).toEqual(["friday.test.beta", "friday.test.alpha"]);
  });

  // ─── Cycle detection ───

  it("throws PLUGIN_DEPENDENCY_CYCLE for circular dependency", () => {
    const plugins = [
      makeEntity("friday.test.alpha", "1.0.0", { "friday.test.beta": "^1.0.0" }),
      makeEntity("friday.test.beta", "1.0.0", { "friday.test.alpha": "^1.0.0" }),
    ];

    try {
      resolver.resolveLoadOrder(plugins, ["friday.test.alpha"]);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridayDomainError);
      expect((err as FridayDomainError).code).toBe("PLUGIN_DEPENDENCY_CYCLE");
      expect((err as FridayDomainError).details.cycle).toBeDefined();
    }
  });

  it("throws PLUGIN_DEPENDENCY_CYCLE for three-node cycle", () => {
    const plugins = [
      makeEntity("friday.test.alpha", "1.0.0", { "friday.test.beta": "^1.0.0" }),
      makeEntity("friday.test.beta", "1.0.0", { "friday.test.gamma": "^1.0.0" }),
      makeEntity("friday.test.gamma", "1.0.0", { "friday.test.alpha": "^1.0.0" }),
    ];

    try {
      resolver.resolveLoadOrder(plugins, ["friday.test.alpha"]);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridayDomainError);
      expect((err as FridayDomainError).code).toBe("PLUGIN_DEPENDENCY_CYCLE");
    }
  });

  // ─── Custom satisfies override ───

  it("uses custom satisfies function", () => {
    const customResolver = createFridayPluginDependencyResolver({
      satisfies: () => false, // always fail
    });

    const plugins = [
      makeEntity("friday.test.alpha", "1.0.0", { "friday.test.beta": "^1.0.0" }),
      makeEntity("friday.test.beta", "1.0.0"),
    ];

    try {
      customResolver.resolveLoadOrder(plugins, ["friday.test.alpha"]);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridayDomainError);
      expect((err as FridayDomainError).code).toBe("PLUGIN_DEPENDENCY_VERSION_MISMATCH");
    }
  });

  // ─── Empty input ───

  it("returns empty order for empty plugin list", () => {
    const plan = resolver.resolveLoadOrder([]);
    expect(plan.order).toEqual([]);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayPluginRepository, createFridayPluginDependencyRepository } from "#plugins";
import type { FridayPluginRepository, FridayPluginDependencyRepository, FridayPluginManifest, FridayUpsertPluginInput } from "#plugins";

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

function makeInput(id: string): FridayUpsertPluginInput {
  return {
    id,
    name: `Plugin ${id}`,
    description: `Plugin ${id} description`,
    version: "1.0.0",
    source: "local",
    status: "installed",
    enabled: false,
    trustMode: "trust_on_install",
    installPath: `/plugins/${id}`,
    kinds: ["skill"],
    manifest: makeManifest(id),
    nowIso: "2026-01-01T00:00:00.000Z",
  };
}

describe("FridayPluginDependencyRepository", () => {
  let db: FridaySqliteLayer;
  let pluginRepo: FridayPluginRepository;
  let depRepo: FridayPluginDependencyRepository;

  beforeEach(() => {
    db = createTestDb();
    pluginRepo = createFridayPluginRepository();
    depRepo = createFridayPluginDependencyRepository();

    // Insert parent plugins for FK constraints
    db.withWriteTransaction((d) => {
      pluginRepo.upsertPlugin(d, makeInput("friday.test.alpha"));
      pluginRepo.upsertPlugin(d, makeInput("friday.test.beta"));
      pluginRepo.upsertPlugin(d, makeInput("friday.test.gamma"));
    });
  });

  afterEach(() => {
    db.close();
  });

  it("inserts and retrieves dependencies by plugin", () => {
    db.withWriteTransaction((d) => {
      depRepo.upsert(d, {
        pluginId: "friday.test.alpha",
        dependencyPluginId: "friday.test.beta",
        semverRange: "^1.0.0",
        optional: false,
        nowIso: "2026-01-01T00:00:00.000Z",
      });
    });

    const deps = db.withReadConnection((d) => depRepo.listByPlugin(d, "friday.test.alpha"));
    expect(deps).toHaveLength(1);
    expect(deps[0].dependencyPluginId).toBe("friday.test.beta");
    expect(deps[0].semverRange).toBe("^1.0.0");
    expect(deps[0].optional).toBe(false);
  });

  it("retrieves reverse dependencies", () => {
    db.withWriteTransaction((d) => {
      depRepo.upsert(d, {
        pluginId: "friday.test.alpha",
        dependencyPluginId: "friday.test.beta",
        semverRange: "^1.0.0",
        optional: false,
        nowIso: "2026-01-01T00:00:00.000Z",
      });
      depRepo.upsert(d, {
        pluginId: "friday.test.gamma",
        dependencyPluginId: "friday.test.beta",
        semverRange: "~1.0.0",
        optional: true,
        nowIso: "2026-01-01T00:00:00.000Z",
      });
    });

    const reverseDeps = db.withReadConnection((d) => depRepo.listByDependency(d, "friday.test.beta"));
    expect(reverseDeps).toHaveLength(2);
    expect(reverseDeps.map((d) => d.pluginId).sort()).toEqual(["friday.test.alpha", "friday.test.gamma"]);
  });

  it("upsert updates existing dependency", () => {
    db.withWriteTransaction((d) => {
      depRepo.upsert(d, {
        pluginId: "friday.test.alpha",
        dependencyPluginId: "friday.test.beta",
        semverRange: "^1.0.0",
        optional: false,
        nowIso: "2026-01-01T00:00:00.000Z",
      });
      depRepo.upsert(d, {
        pluginId: "friday.test.alpha",
        dependencyPluginId: "friday.test.beta",
        semverRange: "^2.0.0",
        optional: true,
        nowIso: "2026-02-01T00:00:00.000Z",
      });
    });

    const deps = db.withReadConnection((d) => depRepo.listByPlugin(d, "friday.test.alpha"));
    expect(deps).toHaveLength(1);
    expect(deps[0].semverRange).toBe("^2.0.0");
    expect(deps[0].optional).toBe(true);
  });

  it("deletes all dependencies for a plugin", () => {
    db.withWriteTransaction((d) => {
      depRepo.upsert(d, {
        pluginId: "friday.test.alpha",
        dependencyPluginId: "friday.test.beta",
        semverRange: "^1.0.0",
        optional: false,
        nowIso: "2026-01-01T00:00:00.000Z",
      });
      depRepo.upsert(d, {
        pluginId: "friday.test.alpha",
        dependencyPluginId: "friday.test.gamma",
        semverRange: "^1.0.0",
        optional: false,
        nowIso: "2026-01-01T00:00:00.000Z",
      });
    });

    db.withWriteTransaction((d) => depRepo.deleteByPlugin(d, "friday.test.alpha"));
    const deps = db.withReadConnection((d) => depRepo.listByPlugin(d, "friday.test.alpha"));
    expect(deps).toHaveLength(0);
  });

  it("deletes a single dependency", () => {
    db.withWriteTransaction((d) => {
      depRepo.upsert(d, {
        pluginId: "friday.test.alpha",
        dependencyPluginId: "friday.test.beta",
        semverRange: "^1.0.0",
        optional: false,
        nowIso: "2026-01-01T00:00:00.000Z",
      });
      depRepo.upsert(d, {
        pluginId: "friday.test.alpha",
        dependencyPluginId: "friday.test.gamma",
        semverRange: "^1.0.0",
        optional: false,
        nowIso: "2026-01-01T00:00:00.000Z",
      });
    });

    db.withWriteTransaction((d) => depRepo.deleteOne(d, "friday.test.alpha", "friday.test.beta"));
    const deps = db.withReadConnection((d) => depRepo.listByPlugin(d, "friday.test.alpha"));
    expect(deps).toHaveLength(1);
    expect(deps[0].dependencyPluginId).toBe("friday.test.gamma");
  });

  it("returns empty array for plugin with no dependencies", () => {
    const deps = db.withReadConnection((d) => depRepo.listByPlugin(d, "friday.test.alpha"));
    expect(deps).toHaveLength(0);
  });

  it("cascade deletes dependencies when plugin is deleted", () => {
    db.withWriteTransaction((d) => {
      depRepo.upsert(d, {
        pluginId: "friday.test.alpha",
        dependencyPluginId: "friday.test.beta",
        semverRange: "^1.0.0",
        optional: false,
        nowIso: "2026-01-01T00:00:00.000Z",
      });
    });

    db.withWriteTransaction((d) => pluginRepo.deletePlugin(d, "friday.test.alpha"));
    const deps = db.withReadConnection((d) => depRepo.listByPlugin(d, "friday.test.alpha"));
    expect(deps).toHaveLength(0);
  });
});

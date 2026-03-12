/**
 * B-007 Unified Package Lifecycle — Contract Tests
 *
 * Validates the cascade coordination across packaging, plugin, and skill
 * subsystems: activate, deactivate, uninstall, skill enable/disable,
 * status aggregation, event logging, and asset discovery.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createUnifiedPackageLifecycle,
  type UnifiedPackageLifecycleDeps,
  type PackagePluginAsset,
  type PackageSkillAsset,
} from "../../../../src/packaging/engine/friday-unified-package-lifecycle.js";
import type {
  FridayPackageInstall,
  FridayPackageManifest,
} from "../../../../src/packaging/model/friday-packaging.types.js";

// ─── Helpers ───

let clock = 1_000_000;

function makeInstall(overrides: Partial<FridayPackageInstall> = {}): FridayPackageInstall {
  return {
    id: "install-1",
    packageId: "pkg-1",
    packageName: "@friday/test-pkg",
    packageVersion: "1.0.0",
    tenantId: "tenant-1",
    state: "active",
    etag: "etag-1",
    version: 1,
    installedBy: "admin",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makePlugins(count = 2): PackagePluginAsset[] {
  return Array.from({ length: count }, (_, i) => ({
    pluginId: `plugin-${i + 1}`,
    packageName: "@friday/test-pkg",
    kinds: ["skill"],
    status: "enabled",
  }));
}

function makeSkills(count = 3): PackageSkillAsset[] {
  return Array.from({ length: count }, (_, i) => ({
    skillId: `skill-${i + 1}`,
    packageName: "@friday/test-pkg",
    packageVersion: "1.0.0",
    assetPath: `skills/skill-${i + 1}.json`,
    status: "installed",
  }));
}

function makeManifest(overrides: Partial<FridayPackageManifest> = {}): FridayPackageManifest {
  return {
    name: "@friday/test-pkg",
    version: "1.0.0",
    description: "Test package",
    author: { name: "Test Author" },
    capabilities: ["skill:web-search", "skill:code-gen"],
    dependencies: {},
    fridayVersionRange: ">=1.0.0",
    assets: {
      skills: ["skills/web-search.json", "skills/code-gen.json"],
      providers: ["providers/openai.json"],
    },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<UnifiedPackageLifecycleDeps> = {}): UnifiedPackageLifecycleDeps {
  clock = 1_000_000;
  return {
    getPackageInstall: vi.fn().mockReturnValue(makeInstall()),
    getManifest: vi.fn().mockReturnValue(makeManifest()),
    getPluginsForPackage: vi.fn().mockReturnValue(makePlugins()),
    getSkillsForPackage: vi.fn().mockReturnValue(makeSkills()),
    activatePlugin: vi.fn().mockReturnValue("enabled"),
    deactivatePlugin: vi.fn().mockReturnValue("disabled"),
    activateSkill: vi.fn().mockReturnValue("installed"),
    deactivateSkill: vi.fn().mockReturnValue("disabled"),
    uninstallSkill: vi.fn().mockReturnValue("not_installed"),
    nowMs: () => clock,
    nowIso: () => new Date(clock).toISOString(),
    ...overrides,
  };
}

// ─── Tests ───

describe("B-007 FridayUnifiedPackageLifecycle", () => {
  describe("activatePackage", () => {
    it("activates plugins then skills in cascade", () => {
      const deps = makeDeps();
      const lifecycle = createUnifiedPackageLifecycle(deps);

      const event = lifecycle.activatePackage("@friday/test-pkg", "1.0.0", "tenant-1", "admin");

      expect(event.operation).toBe("activate");
      expect(event.status).toBe("completed");
      expect(event.pluginsAffected).toBe(2);
      expect(event.skillsAffected).toBe(3);
      expect(event.subsystems).toContain("package");
      expect(event.subsystems).toContain("plugin");
      expect(event.subsystems).toContain("skill");
      expect(deps.activatePlugin).toHaveBeenCalledTimes(2);
      expect(deps.activateSkill).toHaveBeenCalledTimes(3);
    });

    it("records subsystem statuses for each asset", () => {
      const deps = makeDeps();
      const lifecycle = createUnifiedPackageLifecycle(deps);

      const event = lifecycle.activatePackage("@friday/test-pkg", "1.0.0", "tenant-1", "admin");

      expect(event.subsystemStatuses["plugin:plugin-1"]).toBe("enabled");
      expect(event.subsystemStatuses["plugin:plugin-2"]).toBe("enabled");
      expect(event.subsystemStatuses["skill:skill-1"]).toBe("installed");
      expect(event.subsystemStatuses["package"]).toBe("active");
    });

    it("marks failed when activation throws", () => {
      const deps = makeDeps({
        activatePlugin: vi.fn().mockImplementation(() => { throw new Error("Plugin load failed"); }),
      });
      const lifecycle = createUnifiedPackageLifecycle(deps);

      const event = lifecycle.activatePackage("@friday/test-pkg", "1.0.0", "tenant-1", "admin");

      expect(event.status).toBe("failed");
      expect(event.error).toBe("Plugin load failed");
    });

    it("works with no plugins", () => {
      const deps = makeDeps({
        getPluginsForPackage: vi.fn().mockReturnValue([]),
      });
      const lifecycle = createUnifiedPackageLifecycle(deps);

      const event = lifecycle.activatePackage("@friday/test-pkg", "1.0.0", "tenant-1", "admin");

      expect(event.pluginsAffected).toBe(0);
      expect(event.skillsAffected).toBe(3);
      expect(event.subsystems).not.toContain("plugin");
    });

    it("works with no skills", () => {
      const deps = makeDeps({
        getSkillsForPackage: vi.fn().mockReturnValue([]),
      });
      const lifecycle = createUnifiedPackageLifecycle(deps);

      const event = lifecycle.activatePackage("@friday/test-pkg", "1.0.0", "tenant-1", "admin");

      expect(event.skillsAffected).toBe(0);
      expect(event.pluginsAffected).toBe(2);
      expect(event.subsystems).not.toContain("skill");
    });
  });

  describe("deactivatePackage", () => {
    it("deactivates skills first then plugins (reverse cascade)", () => {
      const deps = makeDeps();
      const lifecycle = createUnifiedPackageLifecycle(deps);
      const callOrder: string[] = [];
      (deps.deactivateSkill as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
        callOrder.push(`skill:${id}`);
        return "disabled";
      });
      (deps.deactivatePlugin as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
        callOrder.push(`plugin:${id}`);
        return "disabled";
      });

      const event = lifecycle.deactivatePackage("@friday/test-pkg", "tenant-1", "admin");

      expect(event.operation).toBe("deactivate");
      expect(event.status).toBe("completed");
      // Skills should be deactivated before plugins
      expect(callOrder.slice(0, 3).every(c => c.startsWith("skill:"))).toBe(true);
      expect(callOrder.slice(3).every(c => c.startsWith("plugin:"))).toBe(true);
    });

    it("records deactivation subsystem statuses", () => {
      const deps = makeDeps();
      const lifecycle = createUnifiedPackageLifecycle(deps);

      const event = lifecycle.deactivatePackage("@friday/test-pkg", "tenant-1", "admin");

      expect(event.subsystemStatuses["package"]).toBe("deactivated");
      expect(event.subsystemStatuses["plugin:plugin-1"]).toBe("disabled");
      expect(event.subsystemStatuses["skill:skill-1"]).toBe("disabled");
    });
  });

  describe("uninstallCascade", () => {
    it("uninstalls skills and deactivates plugins", () => {
      const deps = makeDeps();
      const lifecycle = createUnifiedPackageLifecycle(deps);

      const event = lifecycle.uninstallCascade("@friday/test-pkg", "tenant-1", "admin");

      expect(event.operation).toBe("uninstall");
      expect(event.status).toBe("completed");
      expect(deps.uninstallSkill).toHaveBeenCalledTimes(3);
      expect(deps.deactivatePlugin).toHaveBeenCalledTimes(2);
      expect(event.subsystemStatuses["package"]).toBe("uninstalling");
    });

    it("marks failed on uninstall error", () => {
      const deps = makeDeps({
        uninstallSkill: vi.fn().mockImplementation(() => { throw new Error("Skill locked"); }),
      });
      const lifecycle = createUnifiedPackageLifecycle(deps);

      const event = lifecycle.uninstallCascade("@friday/test-pkg", "tenant-1", "admin");

      expect(event.status).toBe("failed");
      expect(event.error).toBe("Skill locked");
    });
  });

  describe("enableSkill / disableSkill", () => {
    it("enables a specific skill", () => {
      const deps = makeDeps();
      const lifecycle = createUnifiedPackageLifecycle(deps);

      const event = lifecycle.enableSkill("@friday/test-pkg", "skill-1", "tenant-1", "admin");

      expect(event.operation).toBe("enable_skill");
      expect(event.status).toBe("completed");
      expect(event.skillsAffected).toBe(1);
      expect(event.pluginsAffected).toBe(0);
      expect(event.subsystems).toEqual(["skill"]);
      expect(deps.activateSkill).toHaveBeenCalledWith("skill-1");
    });

    it("disables a specific skill", () => {
      const deps = makeDeps();
      const lifecycle = createUnifiedPackageLifecycle(deps);

      const event = lifecycle.disableSkill("@friday/test-pkg", "skill-2", "tenant-1", "admin");

      expect(event.operation).toBe("disable_skill");
      expect(event.status).toBe("completed");
      expect(deps.deactivateSkill).toHaveBeenCalledWith("skill-2");
    });

    it("marks failed when skill enable throws", () => {
      const deps = makeDeps({
        activateSkill: vi.fn().mockImplementation(() => { throw new Error("Skill not found"); }),
      });
      const lifecycle = createUnifiedPackageLifecycle(deps);

      const event = lifecycle.enableSkill("@friday/test-pkg", "skill-99", "tenant-1", "admin");

      expect(event.status).toBe("failed");
      expect(event.error).toBe("Skill not found");
    });
  });

  describe("getPackageStatus", () => {
    it("returns healthy status for fully active package", () => {
      const deps = makeDeps({
        getPluginsForPackage: vi.fn().mockReturnValue(makePlugins(2)),
        getSkillsForPackage: vi.fn().mockReturnValue(makeSkills(3)),
      });
      const lifecycle = createUnifiedPackageLifecycle(deps);

      const status = lifecycle.getPackageStatus("@friday/test-pkg", "tenant-1");

      expect(status.packageState).toBe("active");
      expect(status.activePlugins).toBe(2);
      expect(status.activeSkills).toBe(3);
      expect(status.health).toBe("healthy");
    });

    it("returns degraded when skills have errors", () => {
      const skills = makeSkills(3);
      skills[2] = { ...skills[2], status: "error" };

      const deps = makeDeps({
        getSkillsForPackage: vi.fn().mockReturnValue(skills),
      });
      const lifecycle = createUnifiedPackageLifecycle(deps);

      const status = lifecycle.getPackageStatus("@friday/test-pkg", "tenant-1");

      expect(status.health).toBe("degraded");
      expect(status.erroredSkills).toBe(1);
    });

    it("returns unhealthy for failed package", () => {
      const deps = makeDeps({
        getPackageInstall: vi.fn().mockReturnValue(makeInstall({ state: "failed" })),
      });
      const lifecycle = createUnifiedPackageLifecycle(deps);

      const status = lifecycle.getPackageStatus("@friday/test-pkg", "tenant-1");

      expect(status.health).toBe("unhealthy");
    });

    it("returns not_installed when no install record", () => {
      const deps = makeDeps({
        getPackageInstall: vi.fn().mockReturnValue(null),
      });
      const lifecycle = createUnifiedPackageLifecycle(deps);

      const status = lifecycle.getPackageStatus("@friday/test-pkg", "tenant-1");

      expect(status.packageState).toBe("not_installed");
      expect(status.health).toBe("not_installed");
    });

    it("includes last lifecycle event", () => {
      const deps = makeDeps();
      const lifecycle = createUnifiedPackageLifecycle(deps);

      lifecycle.activatePackage("@friday/test-pkg", "1.0.0", "tenant-1", "admin");

      const status = lifecycle.getPackageStatus("@friday/test-pkg", "tenant-1");
      expect(status.lastEvent).not.toBeNull();
      expect(status.lastEvent!.operation).toBe("activate");
    });
  });

  describe("event log", () => {
    it("records all events in order", () => {
      const deps = makeDeps();
      const lifecycle = createUnifiedPackageLifecycle(deps);

      lifecycle.activatePackage("@friday/test-pkg", "1.0.0", "tenant-1", "admin");
      lifecycle.enableSkill("@friday/test-pkg", "skill-1", "tenant-1", "admin");
      lifecycle.deactivatePackage("@friday/test-pkg", "tenant-1", "admin");

      const all = lifecycle.getAllEvents();
      expect(all).toHaveLength(3);
      expect(all[0].operation).toBe("activate");
      expect(all[1].operation).toBe("enable_skill");
      expect(all[2].operation).toBe("deactivate");
    });

    it("getPackageEvents filters by package name", () => {
      const deps = makeDeps();
      const lifecycle = createUnifiedPackageLifecycle(deps);

      lifecycle.activatePackage("@friday/test-pkg", "1.0.0", "tenant-1", "admin");
      lifecycle.activatePackage("@friday/other-pkg", "2.0.0", "tenant-1", "admin");

      const events = lifecycle.getPackageEvents("@friday/test-pkg");
      expect(events).toHaveLength(1);
      expect(events[0].packageName).toBe("@friday/test-pkg");
    });

    it("getPackageEvents filters by tenant", () => {
      const deps = makeDeps();
      const lifecycle = createUnifiedPackageLifecycle(deps);

      lifecycle.activatePackage("@friday/test-pkg", "1.0.0", "tenant-1", "admin");
      lifecycle.activatePackage("@friday/test-pkg", "1.0.0", "tenant-2", "admin");

      const events = lifecycle.getPackageEvents("@friday/test-pkg", "tenant-1");
      expect(events).toHaveLength(1);
      expect(events[0].tenantId).toBe("tenant-1");
    });

    it("events include timing info", () => {
      const deps = makeDeps();
      const lifecycle = createUnifiedPackageLifecycle(deps);

      const event = lifecycle.activatePackage("@friday/test-pkg", "1.0.0", "tenant-1", "admin");

      expect(event.startedAt).toBeTruthy();
      expect(event.completedAt).toBeTruthy();
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(event.initiatedBy).toBe("admin");
    });
  });

  describe("discoverAssets", () => {
    it("extracts skill names from asset globs", () => {
      const lifecycle = createUnifiedPackageLifecycle(makeDeps());

      const result = lifecycle.discoverAssets(makeManifest());

      expect(result.skills).toEqual([
        "@friday/test-pkg:web-search",
        "@friday/test-pkg:code-gen",
      ]);
    });

    it("extracts plugin names from provider globs", () => {
      const lifecycle = createUnifiedPackageLifecycle(makeDeps());

      const result = lifecycle.discoverAssets(makeManifest());

      expect(result.plugins).toEqual(["@friday/test-pkg:provider:openai"]);
    });

    it("returns capabilities from manifest", () => {
      const lifecycle = createUnifiedPackageLifecycle(makeDeps());

      const result = lifecycle.discoverAssets(makeManifest());

      expect(result.capabilities).toEqual(["skill:web-search", "skill:code-gen"]);
    });

    it("handles manifest with no assets", () => {
      const lifecycle = createUnifiedPackageLifecycle(makeDeps());

      const result = lifecycle.discoverAssets(makeManifest({
        assets: {},
        capabilities: [],
      }));

      expect(result.skills).toEqual([]);
      expect(result.plugins).toEqual([]);
      expect(result.capabilities).toEqual([]);
    });
  });

  describe("reset", () => {
    it("clears all events", () => {
      const deps = makeDeps();
      const lifecycle = createUnifiedPackageLifecycle(deps);

      lifecycle.activatePackage("@friday/test-pkg", "1.0.0", "tenant-1", "admin");
      lifecycle.deactivatePackage("@friday/test-pkg", "tenant-1", "admin");
      expect(lifecycle.getAllEvents()).toHaveLength(2);

      lifecycle.reset();
      expect(lifecycle.getAllEvents()).toHaveLength(0);
    });
  });
});

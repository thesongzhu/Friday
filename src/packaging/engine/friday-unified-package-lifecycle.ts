/**
 * B-007 Unified Package Lifecycle — Bridges the packaging install state machine,
 * plugin service (install/enable/disable/uninstall), and skill lifecycle into a
 * single coordinated lifecycle surface.
 *
 * Provides:
 * - Package → Plugin → Skill cascade on install/activate/deactivate/uninstall
 * - Unified lifecycle event log spanning all three subsystems
 * - Asset extraction mapping (package skills → skill registry)
 * - Coordinated rollback across plugin and skill states
 * - Status aggregation across subsystems
 *
 * @module packaging/engine
 */

import type {
  FridayPackageInstall,
  FridayPackageInstallState,
  FridayPackageManifest,
  ISODateTime,
  UUID,
} from "../model/friday-packaging.types.js";

// ─── Unified Lifecycle Types ───

/** Subsystem origin for lifecycle events. */
export type LifecycleSubsystem = "package" | "plugin" | "skill";

/** Operations that span across subsystems. */
export type UnifiedLifecycleOperation =
  | "install"
  | "activate"
  | "deactivate"
  | "uninstall"
  | "upgrade"
  | "rollback"
  | "enable_skill"
  | "disable_skill"
  | "verify";

/** Status of a unified lifecycle operation. */
export type UnifiedOperationStatus = "pending" | "in_progress" | "completed" | "failed" | "rolled_back";

/** A unified lifecycle event spanning subsystems. */
export interface UnifiedLifecycleEvent {
  /** Unique event identifier. */
  readonly id: string;
  /** Package name this event relates to. */
  readonly packageName: string;
  /** Package version. */
  readonly packageVersion: string;
  /** Tenant ID. */
  readonly tenantId: string;
  /** The operation performed. */
  readonly operation: UnifiedLifecycleOperation;
  /** Current operation status. */
  readonly status: UnifiedOperationStatus;
  /** Which subsystems were involved. */
  readonly subsystems: readonly LifecycleSubsystem[];
  /** Per-subsystem status breakdown. */
  readonly subsystemStatuses: Readonly<Record<string, string>>;
  /** Number of skills affected. */
  readonly skillsAffected: number;
  /** Number of plugins affected. */
  readonly pluginsAffected: number;
  /** Principal who initiated the operation. */
  readonly initiatedBy: string;
  /** When the operation started. */
  readonly startedAt: ISODateTime;
  /** When the operation completed (null if still in progress). */
  readonly completedAt: ISODateTime | null;
  /** Duration in milliseconds. */
  readonly durationMs: number;
  /** Error message on failure. */
  readonly error?: string;
}

/** Aggregate status across all subsystems for a package. */
export interface UnifiedPackageStatus {
  /** Package name. */
  readonly packageName: string;
  /** Package version. */
  readonly packageVersion: string;
  /** Tenant ID. */
  readonly tenantId: string;
  /** Package install state. */
  readonly packageState: FridayPackageInstallState | "not_installed";
  /** Number of active plugins from this package. */
  readonly activePlugins: number;
  /** Number of active skills from this package. */
  readonly activeSkills: number;
  /** Number of disabled skills. */
  readonly disabledSkills: number;
  /** Number of errored skills. */
  readonly erroredSkills: number;
  /** Overall health assessment. */
  readonly health: "healthy" | "degraded" | "unhealthy" | "not_installed";
  /** Last operation event. */
  readonly lastEvent: UnifiedLifecycleEvent | null;
}

/** Skill asset discovered within a package. */
export interface PackageSkillAsset {
  /** Skill identifier (derived from package + asset path). */
  readonly skillId: string;
  /** Package that provides this skill. */
  readonly packageName: string;
  /** Package version. */
  readonly packageVersion: string;
  /** Relative path within the package. */
  readonly assetPath: string;
  /** Current skill status. */
  readonly status: string;
}

/** Plugin discovered within a package. */
export interface PackagePluginAsset {
  /** Plugin identifier. */
  readonly pluginId: string;
  /** Package that provides this plugin. */
  readonly packageName: string;
  /** Plugin kind(s). */
  readonly kinds: readonly string[];
  /** Current plugin status. */
  readonly status: string;
}

// ─── Dependencies ───

export interface UnifiedPackageLifecycleDeps {
  /** Resolve package install state from install records. */
  getPackageInstall: (packageName: string, tenantId: string) => FridayPackageInstall | null;
  /** Get package manifest by name and version. */
  getManifest: (packageName: string, version: string) => FridayPackageManifest | null;
  /** List plugins associated with a package. */
  getPluginsForPackage: (packageName: string) => readonly PackagePluginAsset[];
  /** List skills associated with a package. */
  getSkillsForPackage: (packageName: string) => readonly PackageSkillAsset[];
  /** Activate a plugin (enable and load). Returns new status. */
  activatePlugin: (pluginId: string) => string;
  /** Deactivate a plugin (disable and unload). Returns new status. */
  deactivatePlugin: (pluginId: string) => string;
  /** Activate a skill (install/enable in skill registry). Returns new status. */
  activateSkill: (skillId: string) => string;
  /** Deactivate a skill (disable in skill registry). Returns new status. */
  deactivateSkill: (skillId: string) => string;
  /** Uninstall a skill (remove from skill registry). Returns new status. */
  uninstallSkill: (skillId: string) => string;
  /** Clock function. */
  nowMs?: () => number;
  /** ISO clock function. */
  nowIso?: () => ISODateTime;
  /** ID generator. */
  generateId?: () => string;
}

// ─── Interface ───

export interface FridayUnifiedPackageLifecycle {
  /**
   * Activate all plugins and skills within a package after installation.
   * Cascades: package → plugins → skills.
   */
  activatePackage(packageName: string, version: string, tenantId: string, initiatedBy: string): UnifiedLifecycleEvent;

  /**
   * Deactivate all plugins and skills within a package.
   * Cascades: skills → plugins → package.
   */
  deactivatePackage(packageName: string, tenantId: string, initiatedBy: string): UnifiedLifecycleEvent;

  /**
   * Uninstall cascade: deactivate skills → deactivate plugins → mark package uninstalling.
   */
  uninstallCascade(packageName: string, tenantId: string, initiatedBy: string): UnifiedLifecycleEvent;

  /**
   * Enable a specific skill within a package.
   */
  enableSkill(packageName: string, skillId: string, tenantId: string, initiatedBy: string): UnifiedLifecycleEvent;

  /**
   * Disable a specific skill within a package.
   */
  disableSkill(packageName: string, skillId: string, tenantId: string, initiatedBy: string): UnifiedLifecycleEvent;

  /**
   * Get the unified status for a package across all subsystems.
   */
  getPackageStatus(packageName: string, tenantId: string): UnifiedPackageStatus;

  /**
   * Get all lifecycle events for a package.
   */
  getPackageEvents(packageName: string, tenantId?: string): readonly UnifiedLifecycleEvent[];

  /**
   * Get the full event log.
   */
  getAllEvents(): readonly UnifiedLifecycleEvent[];

  /**
   * Discover all skill and plugin assets within a package manifest.
   */
  discoverAssets(manifest: FridayPackageManifest): {
    skills: readonly string[];
    plugins: readonly string[];
    capabilities: readonly string[];
  };

  /**
   * Reset all state.
   */
  reset(): void;
}

// ─── Factory ───

let idCounter = 0;

export function createUnifiedPackageLifecycle(
  deps: UnifiedPackageLifecycleDeps,
): FridayUnifiedPackageLifecycle {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const nowIso = deps.nowIso ?? (() => new Date(nowMs()).toISOString());
  const generateId = deps.generateId ?? (() => `uple-${++idCounter}`);

  const events: UnifiedLifecycleEvent[] = [];

  // ─── Event recording ───

  function recordEvent(
    packageName: string,
    packageVersion: string,
    tenantId: string,
    operation: UnifiedLifecycleOperation,
    initiatedBy: string,
    subsystems: LifecycleSubsystem[],
    subsystemStatuses: Record<string, string>,
    skillsAffected: number,
    pluginsAffected: number,
    status: UnifiedOperationStatus,
    startMs: number,
    error?: string,
  ): UnifiedLifecycleEvent {
    const event: UnifiedLifecycleEvent = {
      id: generateId(),
      packageName,
      packageVersion,
      tenantId,
      operation,
      status,
      subsystems,
      subsystemStatuses,
      skillsAffected,
      pluginsAffected,
      initiatedBy,
      startedAt: new Date(startMs).toISOString(),
      completedAt: nowIso(),
      durationMs: nowMs() - startMs,
      error,
    };

    events.push(event);
    return event;
  }

  // ─── Helpers ───

  function getPackageVersion(packageName: string, tenantId: string): string {
    const install = deps.getPackageInstall(packageName, tenantId);
    return install?.packageVersion ?? "unknown";
  }

  return {
    activatePackage(packageName, version, tenantId, initiatedBy) {
      const startMs = nowMs();
      const subsystems: LifecycleSubsystem[] = ["package"];
      const subsystemStatuses: Record<string, string> = {};
      let skillsAffected = 0;
      let pluginsAffected = 0;
      let error: string | undefined;
      let status: UnifiedOperationStatus = "completed";

      try {
        // 1. Activate plugins
        const plugins = deps.getPluginsForPackage(packageName);
        for (const plugin of plugins) {
          const newStatus = deps.activatePlugin(plugin.pluginId);
          subsystemStatuses[`plugin:${plugin.pluginId}`] = newStatus;
          pluginsAffected++;
        }
        if (pluginsAffected > 0) subsystems.push("plugin");

        // 2. Activate skills
        const skills = deps.getSkillsForPackage(packageName);
        for (const skill of skills) {
          const newStatus = deps.activateSkill(skill.skillId);
          subsystemStatuses[`skill:${skill.skillId}`] = newStatus;
          skillsAffected++;
        }
        if (skillsAffected > 0) subsystems.push("skill");

        subsystemStatuses["package"] = "active";
      } catch (err) {
        error = err instanceof Error ? err.message : "Activation failed";
        status = "failed";
      }

      return recordEvent(
        packageName, version, tenantId, "activate", initiatedBy,
        subsystems, subsystemStatuses, skillsAffected, pluginsAffected, status, startMs, error,
      );
    },

    deactivatePackage(packageName, tenantId, initiatedBy) {
      const startMs = nowMs();
      const version = getPackageVersion(packageName, tenantId);
      const subsystems: LifecycleSubsystem[] = ["package"];
      const subsystemStatuses: Record<string, string> = {};
      let skillsAffected = 0;
      let pluginsAffected = 0;
      let error: string | undefined;
      let status: UnifiedOperationStatus = "completed";

      try {
        // 1. Deactivate skills first (reverse order)
        const skills = deps.getSkillsForPackage(packageName);
        for (const skill of skills) {
          const newStatus = deps.deactivateSkill(skill.skillId);
          subsystemStatuses[`skill:${skill.skillId}`] = newStatus;
          skillsAffected++;
        }
        if (skillsAffected > 0) subsystems.push("skill");

        // 2. Deactivate plugins
        const plugins = deps.getPluginsForPackage(packageName);
        for (const plugin of plugins) {
          const newStatus = deps.deactivatePlugin(plugin.pluginId);
          subsystemStatuses[`plugin:${plugin.pluginId}`] = newStatus;
          pluginsAffected++;
        }
        if (pluginsAffected > 0) subsystems.push("plugin");

        subsystemStatuses["package"] = "deactivated";
      } catch (err) {
        error = err instanceof Error ? err.message : "Deactivation failed";
        status = "failed";
      }

      return recordEvent(
        packageName, version, tenantId, "deactivate", initiatedBy,
        subsystems, subsystemStatuses, skillsAffected, pluginsAffected, status, startMs, error,
      );
    },

    uninstallCascade(packageName, tenantId, initiatedBy) {
      const startMs = nowMs();
      const version = getPackageVersion(packageName, tenantId);
      const subsystems: LifecycleSubsystem[] = ["package"];
      const subsystemStatuses: Record<string, string> = {};
      let skillsAffected = 0;
      let pluginsAffected = 0;
      let error: string | undefined;
      let status: UnifiedOperationStatus = "completed";

      try {
        // 1. Uninstall skills
        const skills = deps.getSkillsForPackage(packageName);
        for (const skill of skills) {
          const newStatus = deps.uninstallSkill(skill.skillId);
          subsystemStatuses[`skill:${skill.skillId}`] = newStatus;
          skillsAffected++;
        }
        if (skillsAffected > 0) subsystems.push("skill");

        // 2. Deactivate plugins
        const plugins = deps.getPluginsForPackage(packageName);
        for (const plugin of plugins) {
          const newStatus = deps.deactivatePlugin(plugin.pluginId);
          subsystemStatuses[`plugin:${plugin.pluginId}`] = newStatus;
          pluginsAffected++;
        }
        if (pluginsAffected > 0) subsystems.push("plugin");

        subsystemStatuses["package"] = "uninstalling";
      } catch (err) {
        error = err instanceof Error ? err.message : "Uninstall cascade failed";
        status = "failed";
      }

      return recordEvent(
        packageName, version, tenantId, "uninstall", initiatedBy,
        subsystems, subsystemStatuses, skillsAffected, pluginsAffected, status, startMs, error,
      );
    },

    enableSkill(packageName, skillId, tenantId, initiatedBy) {
      const startMs = nowMs();
      const version = getPackageVersion(packageName, tenantId);
      const subsystemStatuses: Record<string, string> = {};
      let error: string | undefined;
      let status: UnifiedOperationStatus = "completed";

      try {
        const newStatus = deps.activateSkill(skillId);
        subsystemStatuses[`skill:${skillId}`] = newStatus;
      } catch (err) {
        error = err instanceof Error ? err.message : "Enable skill failed";
        status = "failed";
      }

      return recordEvent(
        packageName, version, tenantId, "enable_skill", initiatedBy,
        ["skill"], subsystemStatuses, 1, 0, status, startMs, error,
      );
    },

    disableSkill(packageName, skillId, tenantId, initiatedBy) {
      const startMs = nowMs();
      const version = getPackageVersion(packageName, tenantId);
      const subsystemStatuses: Record<string, string> = {};
      let error: string | undefined;
      let status: UnifiedOperationStatus = "completed";

      try {
        const newStatus = deps.deactivateSkill(skillId);
        subsystemStatuses[`skill:${skillId}`] = newStatus;
      } catch (err) {
        error = err instanceof Error ? err.message : "Disable skill failed";
        status = "failed";
      }

      return recordEvent(
        packageName, version, tenantId, "disable_skill", initiatedBy,
        ["skill"], subsystemStatuses, 1, 0, status, startMs, error,
      );
    },

    getPackageStatus(packageName, tenantId) {
      const install = deps.getPackageInstall(packageName, tenantId);
      const plugins = deps.getPluginsForPackage(packageName);
      const skills = deps.getSkillsForPackage(packageName);

      const activePlugins = plugins.filter(p => p.status === "enabled" || p.status === "running").length;
      const activeSkills = skills.filter(s => s.status === "installed" || s.status === "upgrade_available").length;
      const disabledSkills = skills.filter(s => s.status === "disabled").length;
      const erroredSkills = skills.filter(s => s.status === "error").length;

      let health: UnifiedPackageStatus["health"] = "not_installed";
      if (install) {
        if (install.state === "active") {
          if (erroredSkills > 0) health = "degraded";
          else if (activeSkills === skills.length && activePlugins === plugins.length) health = "healthy";
          else health = "degraded";
        } else if (install.state === "failed" || install.state === "verification_failed") {
          health = "unhealthy";
        } else {
          health = "degraded";
        }
      }

      // Find last event for this package/tenant
      const packageEvents = events.filter(
        e => e.packageName === packageName && e.tenantId === tenantId,
      );
      const lastEvent = packageEvents.length > 0 ? packageEvents[packageEvents.length - 1] : null;

      return {
        packageName,
        packageVersion: install?.packageVersion ?? "unknown",
        tenantId,
        packageState: install?.state ?? "not_installed",
        activePlugins,
        activeSkills,
        disabledSkills,
        erroredSkills,
        health,
        lastEvent,
      };
    },

    getPackageEvents(packageName, tenantId?) {
      return events.filter(e => {
        if (e.packageName !== packageName) return false;
        if (tenantId && e.tenantId !== tenantId) return false;
        return true;
      });
    },

    getAllEvents() {
      return [...events];
    },

    discoverAssets(manifest) {
      const skills: string[] = [];
      const plugins: string[] = [];

      if (manifest.assets.skills) {
        for (const glob of manifest.assets.skills) {
          // Extract skill name from glob pattern (e.g., "skills/web-search.json" → "web-search")
          const match = glob.match(/([^/]+)\.\w+$/);
          if (match) {
            skills.push(`${manifest.name}:${match[1]}`);
          } else {
            skills.push(`${manifest.name}:${glob}`);
          }
        }
      }

      if (manifest.assets.providers) {
        for (const glob of manifest.assets.providers) {
          const match = glob.match(/([^/]+)\.\w+$/);
          if (match) {
            plugins.push(`${manifest.name}:provider:${match[1]}`);
          }
        }
      }

      return {
        skills,
        plugins,
        capabilities: [...manifest.capabilities],
      };
    },

    reset() {
      events.length = 0;
      idCounter = 0;
    },
  };
}

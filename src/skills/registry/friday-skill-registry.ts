import type {
  CreateFridaySkillRegistryOptions,
  FridayCompatResult,
  FridayRegisteredSkill,
  FridaySkillRegistry,
  FridaySkillResolutionContext,
} from "./friday-skill-registry.types.js";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type { FridaySkillValidationResult } from "../validation/friday-skill-validation.types.js";
import type { SkillLifecycleStatus } from "../model/friday-skill-lifecycle.types.js";
import { discoverFridaySkillCandidates, resolveFridaySkillDiscoveryRoots } from "./friday-skill-discovery.js";
import { loadFridaySkillPackage } from "../manifest/friday-skill-package-loader.js";
import { validateFridaySkillPackage } from "../validation/friday-skill-validation-pipeline.js";
import { enforceFridaySkillTrust } from "../trust/friday-skill-trust-enforcer.js";
import { validateFridaySkillEngineCompatibility } from "../validation/friday-skill-engine-compat-validator.js";
import { createFridaySkillWatcher, type FridaySkillWatcher } from "./friday-skill-watcher.js";

export class FridaySkillRegistryImpl implements FridaySkillRegistry {
  private skills = new Map<string, FridayRegisteredSkill>();
  private watcher: FridaySkillWatcher | null = null;
  private readonly options: CreateFridaySkillRegistryOptions;

  constructor(options: CreateFridaySkillRegistryOptions) {
    this.options = options;
  }

  /** Initial full load; calls `refresh()` then optionally starts watching from settings. */
  async initialize(): Promise<void> {
    await this.refresh();

    // Auto-start watching if enabled in settings
    const settings = await this.options.configManager.getSkillRegistrySettings(
      this.options.workspaceDir,
    );
    if (settings.watchEnabled) {
      await this.startWatching(settings.watchDebounceMs);
    }
  }

  list(): FridayRegisteredSkill[] {
    return Array.from(this.skills.values());
  }

  get(skillId: string): FridayRegisteredSkill | null {
    return this.skills.get(skillId) ?? null;
  }

  resolveByIntent(
    skillIntent: string,
    context: FridaySkillResolutionContext,
  ): FridayRegisteredSkill | null {
    let bestMatch: FridayRegisteredSkill | null = null;
    let bestPriority = -Infinity;

    for (const skill of this.skills.values()) {
      // Check intent match
      if (!skill.manifest.triggers.intents.includes(skillIntent)) continue;

      // Check channel filter if present — "*" is wildcard per §2.4
      if (
        context.channel &&
        skill.manifest.triggers.channels.length > 0 &&
        !skill.manifest.triggers.channels.includes("*") &&
        !skill.manifest.triggers.channels.includes(context.channel)
      ) {
        continue;
      }

      // Check mode filter if present
      if (
        context.mode &&
        !skill.manifest.invocation.modes.includes(context.mode)
      ) {
        continue;
      }

      // Check status
      if (skill.status !== "installed") continue;

      // Priority selection
      if (skill.manifest.invocation.priority > bestPriority) {
        bestPriority = skill.manifest.invocation.priority;
        bestMatch = skill;
      }
    }

    return bestMatch;
  }

  validateAll(): FridaySkillValidationResult[] {
    return this.list().map((s) => s.validation);
  }

  async reload(skillId: string): Promise<void> {
    const existing = this.skills.get(skillId);
    if (!existing) return;

    const loadResult = loadFridaySkillPackage({
      skillDir: existing.skillDir,
      workspaceDir: this.options.workspaceDir,
    });

    if (!loadResult.ok) {
      // Keep prior snapshot on reload failure + emit audit warning
      await this.emitReloadFailureAudit(skillId, loadResult.error.message);
      return;
    }

    const validation = validateFridaySkillPackage({
      loaded: loadResult.value,
      workspaceDir: this.options.workspaceDir,
      hubVersion: this.options.hubVersion,
      supportedApiVersions: this.options.supportedApiVersions,
    });

    const securityProfile = await this.options.configManager.getSkillSecurityProfile();
    const trustResult = enforceFridaySkillTrust({
      manifest: loadResult.value.manifest,
      origin: existing.origin,
      securityProfile,
    });

    if (!validation.ok || trustResult.issues.some((i) => i.severity === "error")) {
      // Keep prior snapshot + emit audit warning
      const reasons = [
        ...validation.issues.filter((i) => i.severity === "error").map((i) => i.message),
        ...trustResult.issues.filter((i) => i.severity === "error").map((i) => i.message),
      ];
      await this.emitReloadFailureAudit(skillId, reasons.join("; "));
      return;
    }

    if (!trustResult.decision) return;

    this.skills.set(skillId, {
      manifest: loadResult.value.manifest,
      skillDir: existing.skillDir,
      source: existing.source,
      origin: existing.origin,
      status: existing.status,
      loaded: loadResult.value,
      validation,
      trust: trustResult.decision,
    });

    // Reconcile watcher targets after successful reload
    if (this.watcher) {
      const targets = this.buildWatchTargets();
      await this.watcher.updateTargets(targets);
    }
  }

  async refresh(): Promise<void> {
    const settings = await this.options.configManager.getSkillRegistrySettings(
      this.options.workspaceDir,
    );

    const roots = resolveFridaySkillDiscoveryRoots(settings);
    const candidates = discoverFridaySkillCandidates(roots);

    // Get existing statuses
    const existingStatuses = await this.options.memoryStateService.listSkillStatuses();
    const securityProfile = await this.options.configManager.getSkillSecurityProfile();

    const newSkills = new Map<string, FridayRegisteredSkill>();

    for (const candidate of candidates) {
      const loadResult = loadFridaySkillPackage({
        skillDir: candidate.skillDir,
        workspaceDir: this.options.workspaceDir,
      });

      if (!loadResult.ok) continue;

      const loaded = loadResult.value;
      const manifest = loaded.manifest;

      const validation = validateFridaySkillPackage({
        loaded,
        workspaceDir: this.options.workspaceDir,
        hubVersion: this.options.hubVersion,
        supportedApiVersions: this.options.supportedApiVersions,
      });

      const trustResult = enforceFridaySkillTrust({
        manifest,
        origin: candidate.root.origin,
        securityProfile,
      });

      // Skip candidates with validation/trust errors
      if (!validation.ok || trustResult.issues.some((i) => i.severity === "error")) {
        continue;
      }

      if (!trustResult.decision) continue;

      const persistedStatus = existingStatuses[manifest.id];
      const shouldAutoInstallBundled =
        candidate.root.origin === "bundled"
        && (persistedStatus === undefined || persistedStatus === "not_installed");
      const status: SkillLifecycleStatus = shouldAutoInstallBundled
        ? "installed"
        : (persistedStatus ?? "not_installed");

      newSkills.set(manifest.id, {
        manifest,
        skillDir: candidate.skillDir,
        source: candidate.root.source,
        origin: candidate.root.origin,
        status,
        loaded,
        validation,
        trust: trustResult.decision,
      });
    }

    this.skills = newSkills;

    // Persist snapshot
    const records = this.list().map((s) => ({
      id: s.manifest.id,
      name: s.manifest.name,
      source: s.source,
      origin: s.origin,
      status: s.status,
      manifest: s.manifest,
      installedVersion: s.manifest.version,
    }));

    await this.options.memoryStateService.upsertDiscoveredSkills(records);

    // Update watcher targets if watching
    if (this.watcher) {
      const targets = this.buildWatchTargets();
      await this.watcher.updateTargets(targets);
    }
  }

  isCompatible(manifest: SkillManifestV2): FridayCompatResult {
    const issues = validateFridaySkillEngineCompatibility(manifest, {
      hubVersion: this.options.hubVersion,
      supportedApiVersions: this.options.supportedApiVersions,
    });

    const errors = issues.filter((i) => i.severity === "error");
    return {
      compatible: errors.length === 0,
      reasons: errors.map((i) => i.message),
    };
  }

  async startWatching(debounceMs?: number): Promise<void> {
    if (this.watcher) return;

    this.watcher = createFridaySkillWatcher({
      debounceMs: debounceMs ?? 300,
      onChange: async (event) => {
        await this.reload(event.skillId);
      },
    });

    const targets = this.buildWatchTargets();
    await this.watcher.start(targets);
  }

  async stopWatching(): Promise<void> {
    if (!this.watcher) return;
    await this.watcher.close();
    this.watcher = null;
  }

  async close(): Promise<void> {
    await this.stopWatching();
    this.skills.clear();
  }

  private async emitReloadFailureAudit(skillId: string, reason: string): Promise<void> {
    try {
      await this.options.memoryStateService.appendAuditLog({
        id: `reload-fail-${skillId}-${Date.now()}`,
        ts: new Date().toISOString(),
        actorType: "service",
        action: "skill.reload.failed",
        resourceType: "skill",
        resourceId: skillId,
        result: "error",
        errorCode: "SKILL_RELOAD_FAILED",
        errorMessage: reason,
        caller: "FridaySkillRegistry.emitReloadFailureAudit",
        details: { reason },
      });
    } catch (err) {
    console.warn("[friday][skill-registry] operation failed:", err instanceof Error ? err.message : String(err));
      // Best-effort audit logging; don't fail the reload flow
    }
  }

  private buildWatchTargets(): Map<string, string[]> {
    const targets = new Map<string, string[]>();
    for (const skill of this.skills.values()) {
      targets.set(skill.manifest.id, skill.loaded.declaredFiles);
    }
    return targets;
  }
}

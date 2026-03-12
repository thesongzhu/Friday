import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import { safeDirName } from "#utilities";
import type { FridaySelfHealingApiService } from "#learning";
import { loadFridaySkillPackage } from "../manifest/friday-skill-package-loader.js";
import { safeParseFridaySkillManifestV2 } from "../manifest/friday-skill-manifest.schema.js";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type {
  FridayMarketplaceCacheEntity,
  FridayMarketplaceSourceEntity,
  FridaySignatureVerificationResult,
  FridaySkillCatalogItem,
  FridaySkillCatalogQuery,
  FridaySkillEntity,
  FridaySkillInstallationEntity,
  FridaySkillInstallRequest,
  FridaySkillInstallResult,
  FridaySkillVersionEntity,
  FridayTrustScoreBreakdown,
} from "../model/friday-skill-marketplace.types.js";
import type { FridayMarketplaceCacheRepository } from "../persistence/friday-marketplace-cache-repository.js";
import type { FridayMarketplaceSourceRepository } from "../persistence/friday-marketplace-source-repository.js";
import type { FridaySkillInstallationRepository } from "../persistence/friday-skill-installation-repository.js";
import type { FridaySkillRepository } from "../persistence/friday-skill-repository.js";
import type { FridaySkillVersionRepository } from "../persistence/friday-skill-version-repository.js";
import type { FridayRegisteredSkill, FridaySkillRegistry } from "../registry/friday-skill-registry.types.js";
import type { FridayMarketplaceDiscoveryService, FridaySkillCatalogResult } from "./friday-marketplace-discovery-service.js";
import type { FridaySkillInstallationService } from "./friday-skill-installation-service.js";
import type { FridaySkillPackageInstaller } from "./friday-skill-package-installer.js";
import type { FridaySkillSignatureVerifier } from "./friday-skill-signature-verifier.js";
import type { FridaySkillTrustScoringService } from "./friday-skill-trust-scoring-service.js";
import { validateFridaySkillPackage } from "../validation/friday-skill-validation-pipeline.js";

export interface FridaySkillVerificationEvidence {
  skillId: string;
  verifiedAt: string;
  ok: boolean;
  manifestVerdict: {
    ok: boolean;
    issues: Array<{
      code: string;
      severity: "error" | "warning";
      message: string;
      path?: string;
    }>;
  };
  packageIntegrity: {
    available: boolean;
    ok: boolean;
    expectedChecksum?: string;
    actualChecksum?: string;
    archivePath?: string;
  };
  dependencyCheck: {
    ok: boolean;
    checkedBins: string[];
    missingBins: string[];
  };
  runtimeDryRun: {
    attempted: boolean;
    ok: boolean;
    executable: boolean;
    reason: string;
  };
  trustSummary: {
    verdict: "trusted" | "warning" | "blocked" | "local";
    policy?: string;
    score?: number;
    signatureValid?: boolean;
    reasons: string[];
  };
}

export interface FridaySkillLifecycleSummary {
  skillId: string;
  name: string;
  description?: string;
  source: string;
  origin: string;
  status: string;
  category?: string;
  tags: string[];
  publisher?: string;
  latestVersion?: string;
  installedVersion?: string;
  updateAvailable: boolean;
  sourceId?: string;
  managed: boolean;
  registryLoaded: boolean;
  currentManifest?: SkillManifestV2;
}

export interface FridaySkillLifecycleDetail extends FridaySkillLifecycleSummary {
  sourceDetails?: FridayMarketplaceSourceEntity;
  versions: FridaySkillVersionEntity[];
  installations: FridaySkillInstallationEntity[];
  catalogEntry?: FridaySkillCatalogItem;
  verification?: FridaySkillVerificationEvidence;
}

export interface FridaySkillCatalogViewItem extends FridaySkillCatalogItem {
  installed: boolean;
  installedVersion?: string;
  updateAvailable: boolean;
  sourceDetails?: FridayMarketplaceSourceEntity;
}

export interface FridaySkillInstallOutcome {
  skill: FridaySkillLifecycleDetail;
  installation: FridaySkillInstallResult;
}

export interface FridaySkillUpdateOutcome extends FridaySkillInstallOutcome {
  updated: boolean;
  previousVersion?: string;
}

export interface FridaySkillDeleteOutcome {
  deleted: true;
  skillId: string;
}

export interface FridayManifestValidationOutcome {
  ok: boolean;
  issues: Array<{
    code: string;
    severity: "error" | "warning";
    message: string;
    path?: string;
  }>;
}

export interface FridaySkillLifecycleService {
  listSkills(): FridaySkillLifecycleSummary[];
  listCatalog(query: FridaySkillCatalogQuery): FridaySkillCatalogResult & { items: FridaySkillCatalogViewItem[] };
  getSkill(skillId: string): FridaySkillLifecycleDetail | null;
  install(input: FridaySkillInstallRequest & { userId: string }): Promise<FridaySkillInstallOutcome>;
  update(input: FridaySkillInstallRequest & { userId: string }): Promise<FridaySkillUpdateOutcome>;
  deleteSkill(input: { skillId: string; deletedBy: string }): Promise<FridaySkillDeleteOutcome>;
  verifySkill(input: { skillId: string; userId: string }): Promise<FridaySkillVerificationEvidence>;
  validateManifest(manifest: unknown): FridayManifestValidationOutcome;
}

export interface CreateFridaySkillLifecycleServiceDeps {
  db: FridaySqliteLayer;
  nowIso: () => string;
  managedSkillsDir: string;
  hubVersion: string;
  supportedApiVersions: string[];
  registry: FridaySkillRegistry;
  discovery: FridayMarketplaceDiscoveryService;
  installations: FridaySkillInstallationService;
  packageInstaller: FridaySkillPackageInstaller;
  signatureVerifier: FridaySkillSignatureVerifier;
  trustScoring: FridaySkillTrustScoringService;
  skillRepo: FridaySkillRepository;
  versionRepo: FridaySkillVersionRepository;
  installationRepo: FridaySkillInstallationRepository;
  sourceRepo: FridayMarketplaceSourceRepository;
  cacheRepo: FridayMarketplaceCacheRepository;
  selfHealing?: FridaySelfHealingApiService;
}

function compareVersions(nextVersion: string | undefined, currentVersion: string | undefined): boolean {
  if (!nextVersion || !currentVersion) {
    return false;
  }
  if (semver.valid(nextVersion) && semver.valid(currentVersion)) {
    return semver.gt(nextVersion, currentVersion);
  }
  return nextVersion !== currentVersion;
}

function findExactCatalogItem(items: FridaySkillCatalogItem[], skillId: string, version?: string): FridaySkillCatalogItem | null {
  if (version) {
    const exact = items.find((item) => item.skillId === skillId && item.version === version);
    if (exact) {
      return exact;
    }
  }
  return items.find((item) => item.skillId === skillId) ?? null;
}

function probeBin(command: string): boolean {
  if (command.trim().length === 0) {
    return true;
  }
  const probe = process.platform === "win32"
    ? spawnSync("where", [command], { encoding: "utf-8" })
    : spawnSync("which", [command], { encoding: "utf-8" });
  return probe.status === 0;
}

function registryToSummary(skill: FridayRegisteredSkill): FridaySkillLifecycleSummary {
  return {
    skillId: skill.manifest.id,
    name: skill.manifest.name,
    description: skill.manifest.description,
    source: skill.source,
    origin: skill.origin,
    status: skill.status,
    category: skill.manifest.category,
    tags: skill.manifest.tags ?? [],
    publisher: skill.manifest.author?.name,
    latestVersion: skill.manifest.version,
    installedVersion: skill.manifest.version,
    updateAvailable: false,
    managed: skill.origin === "managed",
    registryLoaded: true,
    currentManifest: skill.manifest,
  };
}

function persistedToSummary(skill: FridaySkillEntity, catalogEntry: FridaySkillCatalogItem | null): FridaySkillLifecycleSummary {
  return {
    skillId: skill.id,
    name: skill.name,
    description: skill.currentManifest?.description ?? catalogEntry?.manifest.description,
    source: skill.source,
    origin: skill.origin,
    status: skill.status,
    category: skill.currentManifest?.category ?? catalogEntry?.manifest.category,
    tags: skill.currentManifest?.tags ?? catalogEntry?.manifest.tags ?? [],
    publisher: skill.publisher ?? catalogEntry?.publisher,
    latestVersion: skill.latestVersion ?? catalogEntry?.version,
    installedVersion: skill.installedVersion,
    updateAvailable: compareVersions(skill.latestVersion ?? catalogEntry?.version, skill.installedVersion),
    sourceId: catalogEntry?.sourceId,
    managed: skill.origin === "managed",
    registryLoaded: false,
    currentManifest: skill.currentManifest,
  };
}

export function createFridaySkillLifecycleService(
  deps: CreateFridaySkillLifecycleServiceDeps,
): FridaySkillLifecycleService {
  function getCatalogCandidates(skillId: string): FridaySkillCatalogItem[] {
    return deps.db.withReadConnection((db) =>
      deps.cacheRepo.listCatalog(db, {
        q: skillId,
        limit: 100,
        includeStale: true,
      }),
    ).filter((item) => item.skillId === skillId).map((item) => {
      const manifest = item.manifestJson as unknown as SkillManifestV2;
      return {
        sourceId: item.sourceId,
        skillId: item.skillId,
        skillName: manifest.name ?? item.skillId,
        publisher: manifest.author?.name,
        version: item.version,
        category: manifest.category,
        releasedAt: item.indexedAt,
        signatureValid: item.signatureValid,
        trustScore: item.trustScore,
        manifest,
      };
    });
  }

  function getPersistedSkill(skillId: string): FridaySkillEntity | null {
    return deps.db.withReadConnection((db) =>
      deps.skillRepo.getSkillById(db, skillId),
    );
  }

  function getVersions(skillId: string): FridaySkillVersionEntity[] {
    return deps.db.withReadConnection((db) =>
      deps.versionRepo.listVersions(db, skillId, 20),
    );
  }

  function getInstallations(skillId: string): FridaySkillInstallationEntity[] {
    return deps.db.withReadConnection((db) =>
      deps.installationRepo.listBySkill(db, skillId),
    );
  }

  function getSource(sourceId?: string): FridayMarketplaceSourceEntity | undefined {
    if (!sourceId) {
      return undefined;
    }
    return deps.db.withReadConnection((db) =>
      deps.sourceRepo.getSourceById(db, sourceId),
    ) ?? undefined;
  }

  function buildSummary(skillId: string): FridaySkillLifecycleSummary | null {
    const registered = deps.registry.get(skillId);
    const persisted = getPersistedSkill(skillId);
    const catalogEntry = findExactCatalogItem(
      getCatalogCandidates(skillId),
      skillId,
      persisted?.latestVersion ?? persisted?.installedVersion ?? registered?.manifest.version,
    );

    if (registered) {
      const summary = registryToSummary(registered);
      if (persisted) {
        summary.latestVersion = persisted.latestVersion ?? summary.latestVersion;
        summary.installedVersion = persisted.installedVersion ?? summary.installedVersion;
        summary.status = persisted.status ?? summary.status;
        summary.sourceId = catalogEntry?.sourceId;
        summary.updateAvailable = compareVersions(
          persisted.latestVersion ?? catalogEntry?.version,
          persisted.installedVersion ?? summary.installedVersion,
        );
      }
      return summary;
    }

    if (persisted) {
      return persistedToSummary(persisted, catalogEntry);
    }

    if (catalogEntry) {
      return {
        skillId: catalogEntry.skillId,
        name: catalogEntry.skillName,
        description: catalogEntry.manifest.description,
        source: "marketplace",
        origin: "managed",
        status: "not_installed",
        category: catalogEntry.category,
        tags: catalogEntry.manifest.tags ?? [],
        publisher: catalogEntry.publisher,
        latestVersion: catalogEntry.version,
        updateAvailable: false,
        sourceId: catalogEntry.sourceId,
        managed: true,
        registryLoaded: false,
      };
    }

    return null;
  }

  async function refreshRegistry(): Promise<void> {
    await deps.registry.refresh();
  }

  function buildManifestIssues(manifest: SkillManifestV2 | undefined, registered: FridayRegisteredSkill | null) {
    if (!manifest) {
      return {
        ok: false,
        issues: [
          {
            code: "MANIFEST_MISSING",
            severity: "error" as const,
            message: "No skill manifest was found for this skill.",
          },
        ],
      };
    }

    const parsed = safeParseFridaySkillManifestV2(manifest);
    const issues: Array<{
      code: string;
      severity: "error" | "warning";
      message: string;
      path?: string;
    }> = parsed.success
      ? []
      : parsed.error.issues.map((issue) => ({
        code: "MANIFEST_SCHEMA_INVALID",
        severity: "error" as const,
        message: `${issue.path.join(".")}: ${issue.message}`,
        path: issue.path.join("."),
      }));

    if (registered) {
      issues.push(
        ...registered.validation.issues.map((issue) => ({
          code: issue.code,
          severity: issue.severity,
          message: issue.message,
          path: issue.path,
        })),
      );
    }

    return {
      ok: issues.every((issue) => issue.severity !== "error"),
      issues,
    };
  }

  function buildPackageIntegrity(skillId: string, version: string | undefined, versionEntity: FridaySkillVersionEntity | null) {
    if (!version || !versionEntity) {
      return {
        available: false,
        ok: false,
      };
    }

    const archivePath = join(
      deps.managedSkillsDir,
      safeDirName(skillId),
      safeDirName(version),
      "package.tgz",
    );

    if (!existsSync(archivePath)) {
      return {
        available: false,
        ok: false,
        archivePath,
        expectedChecksum: versionEntity.checksum,
      };
    }

    const actualChecksum = deps.signatureVerifier.computeChecksum(readFileSync(archivePath));
    return {
      available: true,
      ok: actualChecksum === versionEntity.checksum,
      expectedChecksum: versionEntity.checksum,
      actualChecksum,
      archivePath,
    };
  }

  function buildTrustSummary(input: {
    source: FridayMarketplaceSourceEntity | undefined;
    catalogEntry: FridaySkillCatalogItem | null;
    verification: FridaySignatureVerificationResult | null;
    score: FridayTrustScoreBreakdown | null;
    registered: FridayRegisteredSkill | null;
  }): FridaySkillVerificationEvidence["trustSummary"] {
    if (input.registered) {
      return {
        verdict: "local",
        reasons: [
          `Registry trust tier: ${input.registered.trust.trustTier}`,
          `Execution mode: ${input.registered.trust.executionMode}`,
        ],
      };
    }

    if (input.source && input.catalogEntry) {
      const verdict = input.catalogEntry.signatureValid
        ? input.catalogEntry.trustScore >= 85
          ? "trusted"
          : "warning"
        : input.source.trustPolicy === "strict"
          ? "blocked"
          : "warning";
      return {
        verdict,
        policy: input.source.trustPolicy,
        score: input.catalogEntry.trustScore,
        signatureValid: input.catalogEntry.signatureValid,
        reasons: input.score?.reasons ?? [],
      };
    }

    if (input.verification) {
      return {
        verdict: input.verification.signatureValid ? "trusted" : "warning",
        signatureValid: input.verification.signatureValid,
        reasons: input.verification.checks,
      };
    }

    return {
      verdict: "warning",
      reasons: ["No trust metadata available for this skill."],
    };
  }

  async function reportSkillFailure(input: {
    userId: string;
    skillId: string;
    stage: "install" | "update" | "delete" | "verify";
    message: string;
  }): Promise<void> {
    if (!deps.selfHealing) {
      return;
    }
    deps.selfHealing.reportStructuredFailure({
      userId: input.userId,
      category: "workflow",
      severity: "medium",
      message: `skill_lifecycle:${input.stage}:${input.skillId}:${input.message}`,
      context: {
        source: "skills_lifecycle",
        skillId: input.skillId,
        stage: input.stage,
      },
      correlationId: `${input.stage}:${input.skillId}`,
    });
  }

  return {
    listSkills() {
      const summaries = new Map<string, FridaySkillLifecycleSummary>();
      for (const registered of deps.registry.list()) {
        summaries.set(registered.manifest.id, registryToSummary(registered));
      }
      const persisted = deps.db.withReadConnection((db) =>
        deps.skillRepo.listAll(db),
      );
      for (const skill of persisted) {
        const next = buildSummary(skill.id);
        if (next) {
          summaries.set(skill.id, next);
        }
      }
      return [...summaries.values()].sort((left, right) => left.name.localeCompare(right.name));
    },

    listCatalog(query) {
      const result = deps.discovery.search(query);
      const items = result.items.map((item) => {
        const summary = buildSummary(item.skillId);
        return {
          ...item,
          installed: Boolean(summary?.installedVersion || summary?.registryLoaded),
          installedVersion: summary?.installedVersion,
          updateAvailable: compareVersions(item.version, summary?.installedVersion),
          sourceDetails: getSource(item.sourceId),
        };
      });
      return {
        ...result,
        items,
      };
    },

    getSkill(skillId) {
      const summary = buildSummary(skillId);
      if (!summary) {
        return null;
      }
      const catalogItems = getCatalogCandidates(skillId);
      const catalogEntry = findExactCatalogItem(
        catalogItems,
        skillId,
        summary.latestVersion ?? summary.installedVersion,
      );
      return {
        ...summary,
        sourceDetails: getSource(summary.sourceId ?? catalogEntry?.sourceId),
        versions: getVersions(skillId),
        installations: getInstallations(skillId),
        catalogEntry: catalogEntry ?? undefined,
      };
    },

    async install(input) {
      try {
        const installation = await deps.installations.install(input);
        await refreshRegistry();
        const skill = this.getSkill(input.skillId);
        if (!skill) {
          throw new FridayDomainError("SKILL_NOT_FOUND", `Skill "${input.skillId}" not found after install`, {
            httpStatus: 404,
          });
        }
        return { skill, installation };
      } catch (error) {
        await reportSkillFailure({
          userId: input.userId,
          skillId: input.skillId,
          stage: "install",
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },

    async update(input) {
      const before = this.getSkill(input.skillId);
      if (!before) {
        throw new FridayDomainError("SKILL_NOT_FOUND", `Skill "${input.skillId}" not found`, {
          httpStatus: 404,
        });
      }
      const previousVersion = before.installedVersion;
      try {
        const installation = await deps.installations.install(input);
        if (previousVersion && previousVersion !== installation.resolvedVersion) {
          deps.packageInstaller.remove(input.skillId, previousVersion);
        }
        await refreshRegistry();
        const skill = this.getSkill(input.skillId);
        if (!skill) {
          throw new FridayDomainError("SKILL_NOT_FOUND", `Skill "${input.skillId}" not found after update`, {
            httpStatus: 404,
          });
        }
        return {
          skill,
          installation,
          updated: previousVersion !== installation.resolvedVersion,
          previousVersion,
        };
      } catch (error) {
        await reportSkillFailure({
          userId: input.userId,
          skillId: input.skillId,
          stage: "update",
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },

    async deleteSkill(input) {
      const persisted = getPersistedSkill(input.skillId);
      const registered = deps.registry.get(input.skillId);
      if (!persisted && !registered) {
        throw new FridayDomainError("SKILL_NOT_FOUND", `Skill "${input.skillId}" not found`, {
          httpStatus: 404,
        });
      }

      try {
        if (persisted?.installedVersion) {
          deps.packageInstaller.remove(input.skillId, persisted.installedVersion);
        }
        if (registered?.origin === "managed" && existsSync(registered.skillDir)) {
          rmSync(registered.skillDir, { recursive: true, force: true });
        }
        deps.db.withWriteTransaction((db) => {
          if (persisted) {
            deps.skillRepo.markDeleted(db, input.skillId, input.deletedBy, deps.nowIso());
          }
        });
        await refreshRegistry();
        return {
          deleted: true,
          skillId: input.skillId,
        };
      } catch (error) {
        await reportSkillFailure({
          userId: input.deletedBy,
          skillId: input.skillId,
          stage: "delete",
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },

    async verifySkill(input) {
      const detail = this.getSkill(input.skillId);
      if (!detail) {
        throw new FridayDomainError("SKILL_NOT_FOUND", `Skill "${input.skillId}" not found`, {
          httpStatus: 404,
        });
      }

      const registered = deps.registry.get(input.skillId);
      const manifest = detail.currentManifest ?? registered?.manifest ?? detail.catalogEntry?.manifest;
      const version = detail.installedVersion ?? detail.latestVersion;
      const versionEntity = version
        ? deps.db.withReadConnection((db) => deps.versionRepo.getVersion(db, input.skillId, version))
        : null;
      const packageIntegrity = buildPackageIntegrity(input.skillId, detail.installedVersion, versionEntity);
      const manifestVerdict = buildManifestIssues(manifest, registered);
      const checkedBins = manifest?.requirements.bins ?? [];
      const missingBins = checkedBins.filter((bin) => !probeBin(bin));
      const dependencyCheck = {
        ok: missingBins.length === 0,
        checkedBins,
        missingBins,
      };

      let runtimeDryRun: FridaySkillVerificationEvidence["runtimeDryRun"];
      if (registered) {
        runtimeDryRun = {
          attempted: true,
          ok: registered.validation.ok,
          executable: registered.validation.ok,
          reason: registered.validation.ok
            ? "Registry loaded the skill and validation passed."
            : registered.validation.issues[0]?.message ?? "Registry validation failed.",
        };
      } else if (detail.installedVersion) {
        const skillDir = join(
          deps.managedSkillsDir,
          safeDirName(input.skillId),
          safeDirName(detail.installedVersion),
        );
        if (existsSync(join(skillDir, "skill.manifest.json"))) {
          const loaded = loadFridaySkillPackage({
            skillDir,
            workspaceDir: skillDir,
          });
          if (loaded.ok) {
            const validation = validateFridaySkillPackage({
              loaded: loaded.value,
              workspaceDir: skillDir,
              hubVersion: deps.hubVersion,
              supportedApiVersions: deps.supportedApiVersions,
            });
            runtimeDryRun = {
              attempted: true,
              ok: validation.ok,
              executable: validation.ok,
              reason: validation.ok
                ? "Installed skill package passed dry-run validation."
                : validation.issues[0]?.message ?? "Installed skill package failed dry-run validation.",
            };
          } else {
            runtimeDryRun = {
              attempted: true,
              ok: false,
              executable: false,
              reason: loaded.error.message,
            };
          }
        } else {
          runtimeDryRun = {
            attempted: true,
            ok: false,
            executable: false,
            reason: "Installed package does not expose an unpacked skill manifest.",
          };
        }
      } else {
        runtimeDryRun = {
          attempted: false,
          ok: false,
          executable: false,
          reason: "Skill is not installed, so runtime dry-run is unavailable.",
        };
      }

      const sourceDetails = detail.sourceDetails ?? getSource(detail.sourceId);
      const catalogEntry = detail.catalogEntry ?? findExactCatalogItem(getCatalogCandidates(input.skillId), input.skillId, version);
      const verificationResult = versionEntity
        ? ({
          integrityValid: packageIntegrity.ok,
          signatureValid: catalogEntry?.signatureValid ?? false,
          checks: packageIntegrity.available
            ? [packageIntegrity.ok ? "integrity:pass" : "integrity:fail"]
            : ["integrity:unavailable"],
        } satisfies FridaySignatureVerificationResult)
        : null;
      const trustBreakdown = sourceDetails && catalogEntry && verificationResult
        ? deps.trustScoring.computeScore({
          verification: verificationResult,
          trustPolicy: sourceDetails.trustPolicy,
          hasPinnedKeys: sourceDetails.pinnedKeyIds.length > 0,
          keyPinningPassed: verificationResult.checks.includes("key-pinning:pass"),
          publisherInstallCount: detail.installations.filter((installation) => installation.status === "installed").length,
          indexedAt: catalogEntry.releasedAt ?? deps.nowIso(),
          nowIso: deps.nowIso(),
          cacheTtlHours: 6,
        })
        : null;
      const trustSummary = buildTrustSummary({
        source: sourceDetails,
        catalogEntry,
        verification: verificationResult,
        score: trustBreakdown,
        registered,
      });

      const ok = manifestVerdict.ok
        && dependencyCheck.ok
        && (!packageIntegrity.available || packageIntegrity.ok)
        && runtimeDryRun.ok
        && trustSummary.verdict !== "blocked";

      const evidence: FridaySkillVerificationEvidence = {
        skillId: input.skillId,
        verifiedAt: deps.nowIso(),
        ok,
        manifestVerdict,
        packageIntegrity,
        dependencyCheck,
        runtimeDryRun,
        trustSummary,
      };

      if (!ok) {
        await reportSkillFailure({
          userId: input.userId,
          skillId: input.skillId,
          stage: "verify",
          message: runtimeDryRun.reason,
        });
      }

      return evidence;
    },

    validateManifest(manifest) {
      const parsed = safeParseFridaySkillManifestV2(manifest);
      if (parsed.success) {
        return { ok: true, issues: [] };
      }
      return {
        ok: false,
        issues: parsed.error.issues.map((issue) => ({
          code: "MANIFEST_SCHEMA_INVALID",
          severity: "error" as const,
          message: `${issue.path.join(".")}: ${issue.message}`,
          path: issue.path.join("."),
        })),
      };
    },
  };
}

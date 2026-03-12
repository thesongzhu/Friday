> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Phase 4 Code Review Package (Round 2)

## Build & Test Results
- TypeScript: CLEAN
- 607 tests passed (70 files), 0 failures

## Round 1 Issues Fixed (all 5)
1. [CRITICAL] Synced manifest now valid SkillManifestV2 + null guards in permission check
2. [CRITICAL] Path traversal blocked — regex validation + assertWithinBase()
3. [HIGH] Unknown source fails closed — no more default permissive
4. [HIGH] Permissive threshold raised to 55 per spec
5. [MEDIUM] Signature metadata cross-validated (skillId/version/keyId/algorithm)

## Changed Files
### `src/skills/services/friday-marketplace-sync-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayMarketplaceSourceRepository } from "../persistence/friday-marketplace-source-repository.js";
import type { FridayMarketplaceCacheRepository } from "../persistence/friday-marketplace-cache-repository.js";
import type { FridaySkillRepository } from "../persistence/friday-skill-repository.js";
import type { FridaySkillVersionRepository } from "../persistence/friday-skill-version-repository.js";
import type { FridayMarketplaceHttpClient } from "./friday-marketplace-http-client.js";
import type { FridaySkillTrustScoringService } from "./friday-skill-trust-scoring-service.js";
import type { FridaySkillSignatureVerifier } from "./friday-skill-signature-verifier.js";
import type {
  FridayMarketplaceSourceEntity,
  FridayMarketplaceIndexDocument,
} from "../model/friday-skill-marketplace.types.js";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";

// ─── Interface ───

export interface FridayMarketplaceSyncService {
  /** Sync all enabled sources. Returns per-source results. */
  syncAllSources(): Promise<FridaySyncResult[]>;
  /** Sync a single source by ID. */
  syncSource(sourceId: string): Promise<FridaySyncResult>;
}

export interface FridaySyncResult {
  sourceId: string;
  sourceName: string;
  skillsSynced: number;
  versionsSynced: number;
  errors: string[];
}

// ─── Dependencies ───

export interface CreateMarketplaceSyncServiceDeps {
  db: FridaySqliteLayer;
  sourceRepo: FridayMarketplaceSourceRepository;
  cacheRepo: FridayMarketplaceCacheRepository;
  skillRepo: FridaySkillRepository;
  versionRepo: FridaySkillVersionRepository;
  httpClient: FridayMarketplaceHttpClient;
  trustScoring: FridaySkillTrustScoringService;
  signatureVerifier: FridaySkillSignatureVerifier;
  idGenerator: () => string;
  nowIso: () => string;
  cacheTtlHours?: number;
}

// ─── Factory ───

export function createFridayMarketplaceSyncService(
  deps: CreateMarketplaceSyncServiceDeps,
): FridayMarketplaceSyncService {
  const cacheTtlHours = deps.cacheTtlHours ?? 6;

  async function syncSingleSource(source: FridayMarketplaceSourceEntity): Promise<FridaySyncResult> {
    const result: FridaySyncResult = {
      sourceId: source.id,
      sourceName: source.name,
      skillsSynced: 0,
      versionsSynced: 0,
      errors: [],
    };

    let indexDoc: FridayMarketplaceIndexDocument;
    try {
      indexDoc = await deps.httpClient.fetchIndex(source.baseUrl);
    } catch (err) {
      result.errors.push(`Failed to fetch index: ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }

    const nowIso = deps.nowIso();

    deps.db.withWriteTransaction((conn) => {
      for (const skill of indexDoc.skills) {
        try {
          // Upsert skill metadata
          deps.skillRepo.upsertSkillFromMarketplace(conn, {
            id: skill.id,
            name: skill.name,
            source: "marketplace",
            origin: "managed",
            publisher: skill.publisher,
            latestVersion: skill.latestVersion,
            status: "not_installed",
            nowIso,
          });
          result.skillsSynced++;

          for (const ver of skill.versions) {
            // Build a valid default SkillManifestV2 for synced skills
            const syncedManifest: SkillManifestV2 = {
              schemaVersion: "2.0",
              id: skill.id,
              name: skill.name,
              description: "",
              version: ver.version,
              kind: "conversation",
              category: "utility",
              author: { name: skill.publisher ?? "Unknown" },
              tags: [],
              runtime: {
                kind: "node",
                entrypoint: "index.js",
                minHubVersion: "0.1.0",
                apiVersion: "1",
                timeoutMsDefault: 30000,
              },
              triggers: { intents: [], phrases: [], channels: [] },
              invocation: {
                userInvocable: true,
                modelInvocable: false,
                priority: 50,
                modes: ["intent"],
              },
              requirements: { bins: [], env: [], config: [], os: ["darwin", "linux"] },
              inputs: [],
              outputs: [],
              permissions: { grants: [], promptOn: [] },
              executionTargets: {
                allowedSatelliteTypes: ["desktop"],
                requiredCapabilities: [],
              },
            };

            // Upsert version
            deps.versionRepo.upsertVersion(conn, {
              id: deps.idGenerator(),
              skillId: skill.id,
              version: ver.version,
              checksum: ver.checksum,
              packageUrl: ver.packageUrl,
              manifest: syncedManifest,
              releasedAt: ver.releasedAt,
              nowIso,
            });

            // Compute trust score for cache
            const trustBreakdown = deps.trustScoring.computeScore({
              verification: {
                integrityValid: true,
                signatureValid: false,
                checks: ["integrity:pass", "signature:pending"],
              },
              trustPolicy: source.trustPolicy,
              hasPinnedKeys: source.pinnedKeyIds.length > 0,
              keyPinningPassed: false,
              publisherInstallCount: 0,
              indexedAt: nowIso,
              nowIso,
              cacheTtlHours,
            });

            // Upsert cache entry
            deps.cacheRepo.upsertCacheEntry(conn, {
              id: deps.idGenerator(),
              sourceId: source.id,
              skillId: skill.id,
              version: ver.version,
              manifestJson: JSON.stringify({ id: skill.id, name: skill.name, version: ver.version }),
              signatureValid: false,
              indexedAt: nowIso,
              trustScore: trustBreakdown.total,
              nowIso,
            });
            result.versionsSynced++;
          }
        } catch (err) {
          result.errors.push(
            `Error syncing skill ${skill.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    });

    return result;
  }

  return {
    async syncAllSources() {
      const sources = deps.db.withReadConnection((conn) =>
        deps.sourceRepo.listSources(conn, true),
      );

      const results: FridaySyncResult[] = [];
      for (const source of sources) {
        const result = await syncSingleSource(source);
        results.push(result);
      }
      return results;
    },

    async syncSource(sourceId) {
      const source = deps.db.withReadConnection((conn) =>
        deps.sourceRepo.getSourceById(conn, sourceId),
      );
      if (!source) {
        throw new Error(`Source ${sourceId} not found`);
      }
      return syncSingleSource(source);
    },
  };
}
```

### `src/skills/services/friday-skill-permission-check-service.ts`
```ts
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";

// ─── Interface ───

export interface FridaySkillPermissionCheckService {
  /** Check that all required permissions are granted. Returns missing permissions. */
  checkPermissions(
    manifest: SkillManifestV2,
    grantedPermissions: string[],
  ): FridayPermissionCheckResult;
}

export interface FridayPermissionCheckResult {
  allowed: boolean;
  missingRequired: string[];
  warnings: string[];
}

// ─── Factory ───

export function createFridaySkillPermissionCheckService(): FridaySkillPermissionCheckService {
  return {
    checkPermissions(manifest, grantedPermissions) {
      const grants = manifest?.permissions?.grants;
      const promptOn = manifest?.permissions?.promptOn;

      const required = Array.isArray(grants)
        ? grants
            .filter((g) => g.required)
            .map((g) => `${g.resource}.${g.action}`)
        : [];

      const granted = new Set(grantedPermissions);
      const missingRequired = required.filter((p) => !granted.has(p));

      const warnings: string[] = [];
      if (Array.isArray(promptOn)) {
        for (const prompt of promptOn) {
          if (!granted.has(prompt)) {
            warnings.push(`Permission ${prompt} requires user prompt`);
          }
        }
      }

      return {
        allowed: missingRequired.length === 0,
        missingRequired,
        warnings,
      };
    },
  };
}
```

### `src/skills/services/friday-skill-package-installer.ts`
```ts
import { mkdirSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

// ─── Interface ───

export interface FridaySkillPackageInstaller {
  /** Stage package bytes to a temporary directory. */
  stage(skillId: string, version: string, packageBytes: Buffer): string;
  /** Activate a staged package by moving it to the final location. */
  activate(skillId: string, version: string): string;
  /** Remove installed package directory. */
  remove(skillId: string, version: string): void;
}

// ─── Dependencies ───

export interface CreateSkillPackageInstallerDeps {
  managedSkillsDir: string;
}

// ─── Factory ───

// Strict allowlist for skill IDs and versions to prevent path traversal
const SAFE_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

function validateSegment(value: string, label: string): void {
  if (!SAFE_SEGMENT_RE.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)} contains disallowed characters`);
  }
}

function assertWithinBase(resolvedPath: string, resolvedBase: string, label: string): void {
  if (!resolvedPath.startsWith(resolvedBase + "/") && resolvedPath !== resolvedBase) {
    throw new Error(`Path traversal detected in ${label}: path escapes managed directory`);
  }
}

export function createFridaySkillPackageInstaller(
  deps: CreateSkillPackageInstallerDeps,
): FridaySkillPackageInstaller {
  const baseDir = deps.managedSkillsDir;
  const resolvedBase = resolve(baseDir);

  function validateInputs(skillId: string, version: string): void {
    validateSegment(skillId, "skillId");
    validateSegment(version, "version");
  }

  function stagingDir(skillId: string, version: string): string {
    const dir = join(baseDir, ".staging", skillId, version);
    assertWithinBase(resolve(dir), resolvedBase, "staging path");
    return dir;
  }

  function finalDir(skillId: string, version: string): string {
    const dir = join(baseDir, skillId, version);
    assertWithinBase(resolve(dir), resolvedBase, "final path");
    return dir;
  }

  return {
    stage(skillId, version, packageBytes) {
      validateInputs(skillId, version);
      const dir = stagingDir(skillId, version);
      mkdirSync(dir, { recursive: true });
      const packagePath = join(dir, "package.tgz");
      writeFileSync(packagePath, packageBytes);
      return dir;
    },

    activate(skillId, version) {
      validateInputs(skillId, version);
      const src = stagingDir(skillId, version);
      const dest = finalDir(skillId, version);

      // Remove existing destination if present
      if (existsSync(dest)) {
        rmSync(dest, { recursive: true, force: true });
      }

      mkdirSync(join(baseDir, skillId), { recursive: true });
      renameSync(src, dest);
      return dest;
    },

    remove(skillId, version) {
      validateInputs(skillId, version);
      const dir = finalDir(skillId, version);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
      // Clean up staging too
      const staging = stagingDir(skillId, version);
      if (existsSync(staging)) {
        rmSync(staging, { recursive: true, force: true });
      }
    },
  };
}
```

### `src/skills/services/friday-skill-version-resolution-service.ts`
```ts
import semver from "semver";
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridaySkillVersionRepository } from "../persistence/friday-skill-version-repository.js";
import type { FridaySkillInstallationRepository } from "../persistence/friday-skill-installation-repository.js";
import type { FridayMarketplaceCacheRepository } from "../persistence/friday-marketplace-cache-repository.js";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type {
  FridaySkillVersionResolutionInput,
  FridaySkillVersionResolutionResult,
  FridaySkillVersionEntity,
  FridaySkillSignature,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridaySkillVersionResolutionService {
  resolve(input: FridaySkillVersionResolutionInput): FridaySkillVersionResolutionResult;
}

// ─── Dependencies ───

export interface CreateVersionResolutionServiceDeps {
  db: FridaySqliteLayer;
  versionRepo: FridaySkillVersionRepository;
  installationRepo: FridaySkillInstallationRepository;
  cacheRepo: FridayMarketplaceCacheRepository;
}

// ─── Factory ───

export function createFridaySkillVersionResolutionService(
  deps: CreateVersionResolutionServiceDeps,
): FridaySkillVersionResolutionService {
  function resolveFromVersions(
    versions: FridaySkillVersionEntity[],
    requestedVersion: string | undefined,
    allowYanked: boolean,
  ): FridaySkillVersionEntity | null {
    const candidates = allowYanked ? versions : versions.filter((v) => !v.yankedAt);
    if (candidates.length === 0) return null;

    if (requestedVersion) {
      // Exact match first
      const exact = candidates.find((v) => v.version === requestedVersion);
      if (exact) return exact;

      // Semver range match
      const matched = candidates
        .filter((v) => semver.valid(v.version) && semver.satisfies(v.version, requestedVersion))
        .sort((a, b) => semver.rcompare(a.version, b.version));
      return matched[0] ?? null;
    }

    // No version requested: pick latest by semver, fall back to release date
    const sorted = [...candidates].sort((a, b) => {
      if (semver.valid(a.version) && semver.valid(b.version)) {
        return semver.rcompare(a.version, b.version);
      }
      return b.releasedAt.localeCompare(a.releasedAt);
    });
    return sorted[0] ?? null;
  }

  return {
    resolve(input) {
      return deps.db.withReadConnection((conn) => {
        const versions = deps.versionRepo.listVersionsForResolution(
          conn,
          input.skillId,
          input.allowYanked,
        );

        switch (input.strategy) {
          case "install":
          case "upgrade": {
            const resolved = resolveFromVersions(
              versions,
              input.requestedVersion,
              input.allowYanked ?? false,
            );

            if (!resolved) {
              throw new Error(
                `No matching version found for ${input.skillId}${input.requestedVersion ? `@${input.requestedVersion}` : ""}`,
              );
            }

            // For upgrade, look in cache for source info
            let sourceId = input.sourceId ?? "";

            // Search cache broadly for (skill_id, version) to find the source
            if (!sourceId) {
              const cacheResults = deps.cacheRepo.listCatalog(conn, {
                q: input.skillId,
                limit: 50,
              });
              // Find exact skill_id + version match first
              const exactMatch = cacheResults.find(
                (c) => c.skillId === input.skillId && c.version === resolved.version,
              );
              if (exactMatch) {
                sourceId = exactMatch.sourceId;
              } else {
                // Fall back to any cache entry for this skill
                const anyMatch = cacheResults.find((c) => c.skillId === input.skillId);
                if (anyMatch) {
                  sourceId = anyMatch.sourceId;
                }
              }
            }

            return {
              skillId: input.skillId,
              version: resolved.version,
              sourceId,
              manifest: resolved.manifest,
              checksum: resolved.checksum,
              packageUrl: resolved.packageUrl ?? "",
              signature: resolved.signature,
              reason: input.strategy === "upgrade"
                ? `Upgrade to ${resolved.version}`
                : `Install version ${resolved.version}`,
            };
          }

          case "rollback": {
            // Find previous successfully installed version
            const history = deps.installationRepo.listInstalledHistory(
              conn,
              input.skillId,
              10,
            );

            // Skip the current (first) entry, take the next one
            const previousInstall = history.length > 1 ? history[1] : null;
            if (!previousInstall) {
              throw new Error(`No previous installed version found for rollback of ${input.skillId}`);
            }

            const targetVersion = versions.find(
              (v) => v.version === previousInstall.version,
            );
            if (!targetVersion) {
              throw new Error(
                `Previous version ${previousInstall.version} metadata not found for ${input.skillId}`,
              );
            }

            return {
              skillId: input.skillId,
              version: targetVersion.version,
              sourceId: input.sourceId ?? "",
              manifest: targetVersion.manifest,
              checksum: targetVersion.checksum,
              packageUrl: targetVersion.packageUrl ?? "",
              signature: targetVersion.signature,
              reason: `Rollback to ${targetVersion.version}`,
            };
          }

          default:
            throw new Error(`Unknown resolution strategy: ${input.strategy}`);
        }
      });
    },
  };
}
```

### `src/skills/services/friday-skill-installation-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridaySkillRepository } from "../persistence/friday-skill-repository.js";
import type { FridaySkillInstallationRepository } from "../persistence/friday-skill-installation-repository.js";
import type { FridaySkillVersionResolutionService } from "./friday-skill-version-resolution-service.js";
import type { FridaySkillSignatureVerifier } from "./friday-skill-signature-verifier.js";
import type { FridaySkillTrustScoringService } from "./friday-skill-trust-scoring-service.js";
import type { FridaySkillPermissionCheckService } from "./friday-skill-permission-check-service.js";
import type { FridaySkillPackageInstaller } from "./friday-skill-package-installer.js";
import type { FridayMarketplaceHttpClient } from "./friday-marketplace-http-client.js";
import type { FridayMarketplaceSourceRepository } from "../persistence/friday-marketplace-source-repository.js";
import type {
  FridaySkillInstallRequest,
  FridaySkillInstallResult,
  FridayMarketplaceTrustPolicy,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridaySkillInstallationService {
  install(request: FridaySkillInstallRequest): Promise<FridaySkillInstallResult>;
  uninstall(skillId: string): void;
}

// ─── Dependencies ───

export interface CreateSkillInstallationServiceDeps {
  db: FridaySqliteLayer;
  skillRepo: FridaySkillRepository;
  installationRepo: FridaySkillInstallationRepository;
  sourceRepo: FridayMarketplaceSourceRepository;
  versionResolver: FridaySkillVersionResolutionService;
  signatureVerifier: FridaySkillSignatureVerifier;
  trustScoring: FridaySkillTrustScoringService;
  permissionCheck: FridaySkillPermissionCheckService;
  packageInstaller: FridaySkillPackageInstaller;
  httpClient: FridayMarketplaceHttpClient;
  idGenerator: () => string;
  nowIso: () => string;
  cacheTtlHours?: number;
  publishEvent?: (event: string, payload: unknown) => Promise<void>;
}

// ─── Factory ───

export function createFridaySkillInstallationService(
  deps: CreateSkillInstallationServiceDeps,
): FridaySkillInstallationService {
  const cacheTtlHours = deps.cacheTtlHours ?? 6;

  return {
    async install(request) {
      // 1. Resolve version
      const resolved = deps.versionResolver.resolve({
        skillId: request.skillId,
        requestedVersion: request.version,
        strategy: "install",
        sourceId: request.sourceId,
      });

      // 2. Create installation rows
      const targets = request.targetSatelliteIds ?? [undefined as unknown as string];
      const installationIds: string[] = [];

      deps.db.withWriteTransaction((conn) => {
        for (const satId of targets) {
          const instId = deps.idGenerator();
          deps.installationRepo.insertInstallation(conn, {
            id: instId,
            skillId: request.skillId,
            version: resolved.version,
            satelliteId: satId || undefined,
            status: "installing",
            permissionsGranted: request.grantPermissions ?? [],
            nowIso: deps.nowIso(),
          });
          installationIds.push(instId);
        }
      });

      // 3. Download package
      let packageBytes: Buffer;
      try {
        packageBytes = await deps.httpClient.fetchPackage(resolved.packageUrl);
      } catch (err) {
        const errorMsg = `Download failed: ${err instanceof Error ? err.message : String(err)}`;
        deps.db.withWriteTransaction((conn) => {
          for (const instId of installationIds) {
            deps.installationRepo.setInstallationError(conn, instId, errorMsg, deps.nowIso());
          }
        });
        throw new Error(errorMsg);
      }

      // 4. Verify integrity + signature
      let signatureDoc = undefined;
      let publisherKey = undefined;
      let trustPolicy: FridayMarketplaceTrustPolicy | undefined;

      if (resolved.sourceId) {
        const source = deps.db.withReadConnection((conn) =>
          deps.sourceRepo.getSourceById(conn, resolved.sourceId),
        );
        if (source) {
          trustPolicy = source.trustPolicy;
          // Attempt to fetch signature and key
          try {
            const sigUrl = `${source.baseUrl.replace(/\/$/, "")}/skills/${resolved.skillId}/versions/${resolved.version}/signature.json`;
            signatureDoc = await deps.httpClient.fetchSignature(sigUrl);
            publisherKey = await deps.httpClient.fetchPublisherKey(source.baseUrl, signatureDoc.keyId);
          } catch {
            // Signature artifacts optional for non-strict policies
          }
        }
      }

      // Fail closed: if source cannot be resolved, reject installation
      if (!trustPolicy) {
        const errorMsg = `Source not resolved for skill ${resolved.skillId}@${resolved.version}. Cannot determine trust policy; rejecting installation.`;
        deps.db.withWriteTransaction((conn) => {
          for (const instId of installationIds) {
            deps.installationRepo.setInstallationError(conn, instId, errorMsg, deps.nowIso());
          }
        });
        throw new Error(errorMsg);
      }

      const pinnedKeyIds = resolved.sourceId
        ? deps.db.withReadConnection((conn) => {
            const source = deps.sourceRepo.getSourceById(conn, resolved.sourceId);
            return source?.pinnedKeyIds ?? [];
          })
        : [];

      const verification = deps.signatureVerifier.verifySignature({
        packageBytes,
        expectedChecksum: resolved.checksum,
        skillId: resolved.skillId,
        version: resolved.version,
        signatureDoc,
        publisherKey,
        pinnedKeyIds,
      });

      // 5. Compute trust score
      const trust = deps.trustScoring.computeScore({
        verification,
        trustPolicy,
        hasPinnedKeys: pinnedKeyIds.length > 0,
        keyPinningPassed: verification.checks.includes("key-pinning:pass"),
        publisherInstallCount: 0,
        indexedAt: deps.nowIso(),
        nowIso: deps.nowIso(),
        cacheTtlHours,
      });

      // 6. Evaluate policy
      const decision = deps.trustScoring.evaluatePolicy(trustPolicy, trust, verification);
      if (!decision.allowed) {
        const errorMsg = `Trust policy rejected: ${decision.reason}`;
        deps.db.withWriteTransaction((conn) => {
          for (const instId of installationIds) {
            deps.installationRepo.setInstallationError(conn, instId, errorMsg, deps.nowIso());
          }
        });
        throw new Error(errorMsg);
      }

      // 7. Permission check
      const permResult = deps.permissionCheck.checkPermissions(
        resolved.manifest,
        request.grantPermissions ?? [],
      );
      if (!permResult.allowed) {
        const errorMsg = `Missing required permissions: ${permResult.missingRequired.join(", ")}`;
        deps.db.withWriteTransaction((conn) => {
          for (const instId of installationIds) {
            deps.installationRepo.setInstallationError(conn, instId, errorMsg, deps.nowIso());
          }
        });
        throw new Error(errorMsg);
      }

      // 8. Stage and activate package
      try {
        deps.packageInstaller.stage(resolved.skillId, resolved.version, packageBytes);
        deps.packageInstaller.activate(resolved.skillId, resolved.version);
      } catch (err) {
        const errorMsg = `Package installation failed: ${err instanceof Error ? err.message : String(err)}`;
        deps.db.withWriteTransaction((conn) => {
          for (const instId of installationIds) {
            deps.installationRepo.setInstallationError(conn, instId, errorMsg, deps.nowIso());
          }
        });
        throw new Error(errorMsg);
      }

      // 9. Update database state
      deps.db.withWriteTransaction((conn) => {
        deps.skillRepo.setInstalledVersion(
          conn,
          resolved.skillId,
          resolved.version,
          resolved.manifest,
          deps.nowIso(),
        );

        for (const instId of installationIds) {
          deps.installationRepo.setInstallationStatus(conn, instId, "installed", deps.nowIso());
        }
      });

      // 10. Publish event if handler provided
      if (deps.publishEvent) {
        await deps.publishEvent("skill.installed", {
          skillId: resolved.skillId,
          version: resolved.version,
          installationIds,
        });
      }

      return {
        installationIds,
        resolvedVersion: resolved.version,
        verification,
        trust,
      };
    },

    uninstall(skillId) {
      deps.db.withWriteTransaction((conn) => {
        const skill = deps.skillRepo.getSkillById(conn, skillId);
        if (!skill) return;

        if (skill.installedVersion) {
          deps.packageInstaller.remove(skillId, skill.installedVersion);
        }

        deps.skillRepo.clearInstalledVersion(conn, skillId, deps.nowIso());

        // Mark current installations as uninstalled
        const installations = deps.installationRepo.listBySkill(conn, skillId);
        for (const inst of installations) {
          if (inst.status === "installed") {
            deps.installationRepo.setInstallationStatus(
              conn,
              inst.id,
              "uninstalled",
              deps.nowIso(),
            );
          }
        }
      });
    },
  };
}
```

### `src/skills/services/friday-skill-trust-scoring-service.ts`
```ts
import type {
  FridayMarketplaceTrustPolicy,
  FridaySignatureVerificationResult,
  FridayTrustScoreBreakdown,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridaySkillTrustScoringService {
  computeScore(input: FridayTrustScoreInput): FridayTrustScoreBreakdown;
  evaluatePolicy(
    trustPolicy: FridayMarketplaceTrustPolicy,
    breakdown: FridayTrustScoreBreakdown,
    verification: FridaySignatureVerificationResult,
  ): FridayTrustPolicyDecision;
}

export interface FridayTrustScoreInput {
  verification: FridaySignatureVerificationResult;
  trustPolicy: FridayMarketplaceTrustPolicy;
  hasPinnedKeys: boolean;
  keyPinningPassed: boolean;
  publisherInstallCount: number;
  indexedAt: string;
  nowIso: string;
  cacheTtlHours: number;
}

export interface FridayTrustPolicyDecision {
  allowed: boolean;
  warnings: string[];
  reason?: string;
}

// ─── Score Constants ───

const SCORE_SIGNATURE_VALID = 40;
const SCORE_INTEGRITY_VALID = 15;
const SCORE_KEY_PINNING_CONFIGURED_PASSED = 20;
const SCORE_KEY_PINNING_NOT_CONFIGURED = 10;

const SCORE_SOURCE_POLICY: Record<FridayMarketplaceTrustPolicy, number> = {
  strict: 15,
  warn: 10,
  permissive: 5,
};

const MAX_PUBLISHER_SCORE = 10;
const MAX_FRESHNESS_SCORE = 10;

// ─── Thresholds ───

const THRESHOLD_STRICT = 85;
const THRESHOLD_WARN = 70;
const THRESHOLD_WARN_LOW = 85;
const THRESHOLD_PERMISSIVE = 55;

// ─── Factory ───

export function createFridaySkillTrustScoringService(): FridaySkillTrustScoringService {
  return {
    computeScore(input) {
      const reasons: string[] = [];

      // Signature
      const signature = input.verification.signatureValid ? SCORE_SIGNATURE_VALID : 0;
      if (input.verification.signatureValid) {
        reasons.push("Valid cryptographic signature (+40)");
      } else {
        reasons.push("Missing or invalid signature (+0)");
      }

      // Integrity
      const integrity = input.verification.integrityValid ? SCORE_INTEGRITY_VALID : 0;
      if (input.verification.integrityValid) {
        reasons.push("Integrity checksum verified (+15)");
      } else {
        reasons.push("Integrity check failed (+0)");
      }

      // Key pinning
      let keyPinning: number;
      if (input.hasPinnedKeys) {
        if (input.keyPinningPassed) {
          keyPinning = SCORE_KEY_PINNING_CONFIGURED_PASSED;
          reasons.push("Key pinning configured and passed (+20)");
        } else {
          keyPinning = 0;
          reasons.push("Key pinning configured but failed (+0)");
        }
      } else {
        keyPinning = SCORE_KEY_PINNING_NOT_CONFIGURED;
        reasons.push("Key pinning not configured (+10)");
      }

      // Source policy baseline
      const sourcePolicy = SCORE_SOURCE_POLICY[input.trustPolicy];
      reasons.push(`Source policy: ${input.trustPolicy} (+${sourcePolicy})`);

      // Publisher reputation (capped at 10, based on install count)
      const publisher = Math.min(input.publisherInstallCount, MAX_PUBLISHER_SCORE);
      reasons.push(`Publisher install count: ${input.publisherInstallCount} (+${publisher})`);

      // Freshness (based on age vs TTL)
      const ageMs = new Date(input.nowIso).getTime() - new Date(input.indexedAt).getTime();
      const ttlMs = input.cacheTtlHours * 60 * 60 * 1000;
      let freshness: number;
      if (ageMs <= 0) {
        freshness = MAX_FRESHNESS_SCORE;
      } else if (ageMs >= ttlMs * 4) {
        freshness = 0;
      } else {
        freshness = Math.round(MAX_FRESHNESS_SCORE * Math.max(0, 1 - ageMs / (ttlMs * 4)));
      }
      reasons.push(`Freshness score (+${freshness})`);

      const total = signature + integrity + keyPinning + sourcePolicy + publisher + freshness;

      return {
        total,
        signature,
        integrity,
        keyPinning,
        sourcePolicy,
        publisher,
        freshness,
        reasons,
      };
    },

    evaluatePolicy(trustPolicy, breakdown, verification) {
      const warnings: string[] = [];

      switch (trustPolicy) {
        case "strict": {
          if (!verification.signatureValid) {
            return {
              allowed: false,
              warnings,
              reason: "Strict policy requires valid signature",
            };
          }
          if (!verification.integrityValid) {
            return {
              allowed: false,
              warnings,
              reason: "Strict policy requires valid integrity",
            };
          }
          if (breakdown.total < THRESHOLD_STRICT) {
            return {
              allowed: false,
              warnings,
              reason: `Trust score ${breakdown.total} below strict threshold ${THRESHOLD_STRICT}`,
            };
          }
          return { allowed: true, warnings };
        }

        case "warn": {
          if (!verification.integrityValid) {
            return {
              allowed: false,
              warnings,
              reason: "Warn policy requires valid integrity",
            };
          }
          if (breakdown.total < THRESHOLD_WARN) {
            return {
              allowed: false,
              warnings,
              reason: `Trust score ${breakdown.total} below warn threshold ${THRESHOLD_WARN}`,
            };
          }
          if (breakdown.total < THRESHOLD_WARN_LOW) {
            warnings.push(`Trust score ${breakdown.total} below recommended threshold ${THRESHOLD_WARN_LOW}`);
          }
          return { allowed: true, warnings };
        }

        case "permissive": {
          if (!verification.integrityValid) {
            return {
              allowed: false,
              warnings,
              reason: "Permissive policy still requires valid integrity",
            };
          }
          // Reject explicit signature fraud (integrity OK but signature explicitly failed)
          if (
            verification.checks.includes("signature:fail") &&
            !verification.checks.includes("signature:missing")
          ) {
            return {
              allowed: false,
              warnings,
              reason: "Signature explicitly invalid (possible tampering)",
            };
          }
          if (breakdown.total < THRESHOLD_PERMISSIVE) {
            return {
              allowed: false,
              warnings,
              reason: `Trust score ${breakdown.total} below permissive threshold ${THRESHOLD_PERMISSIVE}`,
            };
          }
          return { allowed: true, warnings };
        }

        default:
          return {
            allowed: false,
            warnings,
            reason: `Unknown trust policy: ${trustPolicy}`,
          };
      }
    },
  };
}
```

### `src/skills/services/friday-skill-signature-verifier.ts`
```ts
import { createHash, createPublicKey, verify } from "node:crypto";
import { constants as cryptoConstants } from "node:crypto";
import type {
  FridayMarketplaceSignatureAlgorithm,
  FridayMarketplaceSignatureDocument,
  FridayMarketplacePublisherKeyDocument,
  FridaySignatureVerificationResult,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridaySkillSignatureVerifier {
  /** Compute SHA-256 hex digest of package bytes. */
  computeChecksum(packageBytes: Buffer): string;

  /** Verify integrity (checksum) and cryptographic signature. */
  verifySignature(input: {
    packageBytes: Buffer;
    expectedChecksum: string;
    skillId: string;
    version: string;
    signatureDoc?: FridayMarketplaceSignatureDocument;
    publisherKey?: FridayMarketplacePublisherKeyDocument;
    pinnedKeyIds?: string[];
  }): FridaySignatureVerificationResult;
}

// ─── Canonical Payload ───

function buildCanonicalPayload(skillId: string, version: string, checksumHex: string): Buffer {
  return Buffer.from(`friday-skill-signature-v1\n${skillId}\n${version}\n${checksumHex}`);
}

// ─── Algorithm Verify ───

function verifyByAlgorithm(
  algorithm: FridayMarketplaceSignatureAlgorithm,
  payload: Buffer,
  publicKeyPem: string,
  signatureBuffer: Buffer,
): boolean {
  const key = createPublicKey(publicKeyPem);

  switch (algorithm) {
    case "ed25519":
      return verify(null, payload, key, signatureBuffer);

    case "rsa-sha256":
      return verify("sha256", payload, { key, padding: cryptoConstants.RSA_PKCS1_PADDING }, signatureBuffer);

    case "rsa-pss-sha256":
      return verify(
        "sha256",
        payload,
        { key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
        signatureBuffer,
      );

    default:
      return false;
  }
}

// ─── Factory ───

export function createFridaySkillSignatureVerifier(): FridaySkillSignatureVerifier {
  return {
    computeChecksum(packageBytes) {
      return createHash("sha256").update(packageBytes).digest("hex");
    },

    verifySignature(input) {
      const checks: string[] = [];

      // 1. Integrity check
      const actualChecksum = createHash("sha256").update(input.packageBytes).digest("hex");
      const integrityValid = actualChecksum === input.expectedChecksum;

      if (integrityValid) {
        checks.push("integrity:pass");
      } else {
        checks.push("integrity:fail");
        return {
          integrityValid: false,
          signatureValid: false,
          checks,
          reason: `Checksum mismatch: expected ${input.expectedChecksum}, got ${actualChecksum}`,
        };
      }

      // 2. If no signature doc, signature cannot be validated
      if (input.signatureDoc) {
        // Cross-validate signature metadata against requested install target
        if (input.signatureDoc.skillId !== input.skillId) {
          checks.push("metadata:skill-mismatch");
          return {
            integrityValid: true,
            signatureValid: false,
            checks,
            reason: `Signature skillId "${input.signatureDoc.skillId}" does not match requested "${input.skillId}"`,
          };
        }
        if (input.signatureDoc.version !== input.version) {
          checks.push("metadata:version-mismatch");
          return {
            integrityValid: true,
            signatureValid: false,
            checks,
            reason: `Signature version "${input.signatureDoc.version}" does not match requested "${input.version}"`,
          };
        }
      }

      if (!input.signatureDoc) {
        checks.push("signature:missing");
        return {
          integrityValid: true,
          signatureValid: false,
          checks,
          reason: "No signature document provided",
        };
      }

      // 3. If no publisher key, signature cannot be validated
      if (!input.publisherKey || !input.publisherKey.publicKeyPem) {
        checks.push("signature:no-key");
        return {
          integrityValid: true,
          signatureValid: false,
          checks,
          keyId: input.signatureDoc.keyId,
          algorithm: input.signatureDoc.algorithm,
          reason: "No publisher key available",
        };
      }

      // 4. Check key revocation
      if (input.publisherKey.revokedAt) {
        checks.push("key:revoked");
        return {
          integrityValid: true,
          signatureValid: false,
          checks,
          keyId: input.signatureDoc.keyId,
          algorithm: input.signatureDoc.algorithm,
          reason: `Key ${input.signatureDoc.keyId} has been revoked`,
        };
      }

      // 5. Key pinning check
      if (input.pinnedKeyIds && input.pinnedKeyIds.length > 0) {
        if (input.pinnedKeyIds.includes(input.signatureDoc.keyId)) {
          checks.push("key-pinning:pass");
        } else {
          checks.push("key-pinning:fail");
          return {
            integrityValid: true,
            signatureValid: false,
            checks,
            keyId: input.signatureDoc.keyId,
            algorithm: input.signatureDoc.algorithm,
            reason: `Key ${input.signatureDoc.keyId} is not in pinned key list`,
          };
        }
      } else {
        checks.push("key-pinning:not-configured");
      }

      // 6. Cross-validate publisher key metadata against signature document
      if (input.publisherKey.keyId !== input.signatureDoc.keyId) {
        checks.push("metadata:keyId-mismatch");
        return {
          integrityValid: true,
          signatureValid: false,
          checks,
          keyId: input.signatureDoc.keyId,
          algorithm: input.signatureDoc.algorithm,
          reason: `Publisher key ID "${input.publisherKey.keyId}" does not match signature key ID "${input.signatureDoc.keyId}"`,
        };
      }
      if (input.publisherKey.algorithm !== input.signatureDoc.algorithm) {
        checks.push("metadata:algorithm-mismatch");
        return {
          integrityValid: true,
          signatureValid: false,
          checks,
          keyId: input.signatureDoc.keyId,
          algorithm: input.signatureDoc.algorithm,
          reason: `Publisher key algorithm "${input.publisherKey.algorithm}" does not match signature algorithm "${input.signatureDoc.algorithm}"`,
        };
      }

      // 7. Cryptographic verification
      const payload = buildCanonicalPayload(input.skillId, input.version, actualChecksum);
      const signatureBuffer = Buffer.from(input.signatureDoc.value, "base64");

      try {
        const valid = verifyByAlgorithm(
          input.signatureDoc.algorithm,
          payload,
          input.publisherKey.publicKeyPem,
          signatureBuffer,
        );

        if (valid) {
          checks.push("signature:pass");
        } else {
          checks.push("signature:fail");
        }

        return {
          integrityValid: true,
          signatureValid: valid,
          checks,
          keyId: input.signatureDoc.keyId,
          algorithm: input.signatureDoc.algorithm,
          reason: valid ? undefined : "Cryptographic signature verification failed",
        };
      } catch (err) {
        checks.push("signature:error");
        return {
          integrityValid: true,
          signatureValid: false,
          checks,
          keyId: input.signatureDoc.keyId,
          algorithm: input.signatureDoc.algorithm,
          reason: `Signature verification error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
```

### `test/unit/skills/marketplace/friday-phase4-cx-fixes.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridaySkillPermissionCheckService } from "../../../../src/skills/services/friday-skill-permission-check-service.js";
import { createFridaySkillPackageInstaller } from "../../../../src/skills/services/friday-skill-package-installer.js";
import { createFridaySkillTrustScoringService } from "../../../../src/skills/services/friday-skill-trust-scoring-service.js";
import { createFridaySkillSignatureVerifier } from "../../../../src/skills/services/friday-skill-signature-verifier.js";
import { createFridaySkillInstallationService } from "../../../../src/skills/services/friday-skill-installation-service.js";
import { createFridaySkillVersionResolutionService } from "../../../../src/skills/services/friday-skill-version-resolution-service.js";
import { createFridaySkillRepository } from "../../../../src/skills/persistence/friday-skill-repository.js";
import { createFridaySkillVersionRepository } from "../../../../src/skills/persistence/friday-skill-version-repository.js";
import { createFridaySkillInstallationRepository } from "../../../../src/skills/persistence/friday-skill-installation-repository.js";
import { createFridayMarketplaceSourceRepository } from "../../../../src/skills/persistence/friday-marketplace-source-repository.js";
import { createFridayMarketplaceCacheRepository } from "../../../../src/skills/persistence/friday-marketplace-cache-repository.js";
import { createFridayMarketplaceSyncService } from "../../../../src/skills/services/friday-marketplace-sync-service.js";
import type { FridaySkillPackageInstaller } from "../../../../src/skills/services/friday-skill-package-installer.js";
import type { FridayMarketplaceHttpClient } from "../../../../src/skills/services/friday-marketplace-http-client.js";
import type { FridaySignatureVerificationResult } from "../../../../src/skills/model/friday-skill-marketplace.types.js";
import type { SkillManifestV2 } from "../../../../src/skills/model/friday-skill-manifest-v2.types.js";
import { createTestDb, createTestIdGenerator, NOW, createTestManifest } from "./_helpers.js";
import { tmpdir } from "node:os";
import { mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";

// ────────────────────────────────────────────────
// Issue 1: Invalid/missing manifest doesn't crash
// ────────────────────────────────────────────────
describe("Issue 1: Permission check handles invalid/missing manifest", () => {
  const service = createFridaySkillPermissionCheckService();

  it("handles manifest with no permissions property", () => {
    const badManifest = { schemaVersion: "2.0", id: "x", name: "X" } as unknown as SkillManifestV2;
    const result = service.checkPermissions(badManifest, []);
    expect(result.allowed).toBe(true);
    expect(result.missingRequired).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("handles manifest with null permissions", () => {
    const badManifest = {
      schemaVersion: "2.0",
      id: "x",
      name: "X",
      permissions: null,
    } as unknown as SkillManifestV2;
    const result = service.checkPermissions(badManifest, []);
    expect(result.allowed).toBe(true);
    expect(result.missingRequired).toEqual([]);
  });

  it("handles manifest with permissions but no grants", () => {
    const badManifest = {
      schemaVersion: "2.0",
      id: "x",
      name: "X",
      permissions: { promptOn: [] },
    } as unknown as SkillManifestV2;
    const result = service.checkPermissions(badManifest, []);
    expect(result.allowed).toBe(true);
  });

  it("handles manifest with permissions but no promptOn", () => {
    const badManifest = {
      schemaVersion: "2.0",
      id: "x",
      name: "X",
      permissions: { grants: [] },
    } as unknown as SkillManifestV2;
    const result = service.checkPermissions(badManifest, []);
    expect(result.allowed).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("still correctly detects missing required permissions for valid manifest", () => {
    const manifest = createTestManifest({
      permissions: {
        grants: [
          { id: "fs", resource: "filesystem", action: "write", required: true, reason: "Need FS" },
        ],
        promptOn: ["filesystem.write"],
      },
    });
    const result = service.checkPermissions(manifest, []);
    expect(result.allowed).toBe(false);
    expect(result.missingRequired).toContain("filesystem.write");
  });
});

describe("Issue 1: Sync service stores valid manifests", () => {
  let db: FridaySqliteLayer;
  let idGen: () => string;

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
  });

  afterEach(() => {
    db.close();
  });

  it("synced version has a valid SkillManifestV2 with permissions", async () => {
    const sourceRepo = createFridayMarketplaceSourceRepository();
    const versionRepo = createFridaySkillVersionRepository();

    db.withWriteTransaction((conn) => {
      sourceRepo.insertSource(conn, "src-1", {
        name: "Test",
        baseUrl: "https://test.dev",
        trustPolicy: "warn",
        pinnedKeyIds: [],
      }, NOW);
    });

    const mockHttp: FridayMarketplaceHttpClient = {
      async fetchIndex() {
        return {
          generatedAt: NOW,
          skills: [{
            id: "my-skill",
            name: "My Skill",
            publisher: "Test Publisher",
            latestVersion: "1.0.0",
            versions: [{
              version: "1.0.0",
              checksum: "abc",
              releasedAt: NOW,
              manifestUrl: "/m",
              packageUrl: "/p",
              signatureUrl: "/s",
            }],
          }],
        };
      },
      async fetchManifest() { return {}; },
      async fetchSignature() { return { skillId: "", version: "", keyId: "", algorithm: "ed25519" as const, value: "" }; },
      async fetchPublisherKey() { return { keyId: "", algorithm: "ed25519" as const }; },
      async fetchPackage() { return Buffer.alloc(0); },
    };

    const service = createFridayMarketplaceSyncService({
      db,
      sourceRepo,
      cacheRepo: createFridayMarketplaceCacheRepository(),
      skillRepo: createFridaySkillRepository(),
      versionRepo,
      httpClient: mockHttp,
      trustScoring: createFridaySkillTrustScoringService(),
      signatureVerifier: createFridaySkillSignatureVerifier(),
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    await service.syncSource("src-1");

    // Verify the stored manifest is a valid SkillManifestV2
    const versions = db.withReadConnection((conn) =>
      versionRepo.listVersionsForResolution(conn, "my-skill", false),
    );
    expect(versions).toHaveLength(1);
    const manifest = versions[0].manifest;
    expect(manifest.schemaVersion).toBe("2.0");
    expect(manifest.id).toBe("my-skill");
    expect(manifest.permissions).toBeDefined();
    expect(manifest.permissions.grants).toEqual([]);
    expect(manifest.permissions.promptOn).toEqual([]);
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.author.name).toBe("Test Publisher");

    // Verify permission check doesn't crash
    const permService = createFridaySkillPermissionCheckService();
    const permResult = permService.checkPermissions(manifest, []);
    expect(permResult.allowed).toBe(true);
  });
});

// ────────────────────────────────────────────────
// Issue 2: Path traversal rejected
// ────────────────────────────────────────────────
describe("Issue 2: Package installer rejects path traversal", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "friday-pkg-test-"));
  });

  it("rejects skillId with path traversal characters", () => {
    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: tempDir });
    expect(() => installer.stage("../../etc", "1.0.0", Buffer.from("x"))).toThrow(
      /Invalid skillId.*disallowed/,
    );
  });

  it("rejects version with path traversal characters", () => {
    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: tempDir });
    expect(() => installer.stage("safe-skill", "../../../etc/passwd", Buffer.from("x"))).toThrow(
      /Invalid version.*disallowed/,
    );
  });

  it("rejects skillId with dots", () => {
    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: tempDir });
    expect(() => installer.stage("..", "1.0.0", Buffer.from("x"))).toThrow(/Invalid skillId/);
  });

  it("rejects version with slashes", () => {
    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: tempDir });
    expect(() => installer.stage("good-skill", "1.0.0/../../bad", Buffer.from("x"))).toThrow(
      /Invalid version/,
    );
  });

  it("rejects skillId with spaces", () => {
    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: tempDir });
    expect(() => installer.stage("skill name", "1.0.0", Buffer.from("x"))).toThrow(
      /Invalid skillId/,
    );
  });

  it("allows valid skillId and version", () => {
    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: tempDir });
    const result = installer.stage("my-skill_123", "1_0-0", Buffer.from("pkg"));
    expect(result).toContain("my-skill_123");
    expect(existsSync(join(result, "package.tgz"))).toBe(true);
  });

  it("rejects path traversal in activate", () => {
    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: tempDir });
    expect(() => installer.activate("../../etc", "1.0.0")).toThrow(/Invalid skillId/);
  });

  it("rejects path traversal in remove", () => {
    const installer = createFridaySkillPackageInstaller({ managedSkillsDir: tempDir });
    expect(() => installer.remove("../../etc", "1.0.0")).toThrow(/Invalid skillId/);
  });
});

// ────────────────────────────────────────────────
// Issue 3: Unknown source fails closed
// ────────────────────────────────────────────────
describe("Issue 3: Unknown source fails closed (not permissive)", () => {
  let db: FridaySqliteLayer;
  let idGen: () => string;

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();

    const skillRepo = createFridaySkillRepository();
    const versionRepo = createFridaySkillVersionRepository();

    db.withWriteTransaction((conn) => {
      // Create skill WITHOUT a source in marketplace_sources
      skillRepo.upsertSkillFromMarketplace(conn, {
        id: "orphan-skill",
        name: "Orphan Skill",
        source: "marketplace",
        origin: "managed",
        latestVersion: "1.0.0",
        status: "not_installed",
        nowIso: NOW,
      });

      const manifest = createTestManifest({
        id: "orphan-skill",
        version: "1.0.0",
        permissions: { grants: [], promptOn: [] },
      });

      versionRepo.upsertVersion(conn, {
        id: "v-orphan",
        skillId: "orphan-skill",
        version: "1.0.0",
        checksum: "aaa",
        packageUrl: "https://test.dev/pkg.tgz",
        manifest,
        releasedAt: NOW,
        nowIso: NOW,
      });
    });
  });

  afterEach(() => {
    db.close();
  });

  it("rejects installation when source cannot be resolved", async () => {
    const verifier = createFridaySkillSignatureVerifier();
    const mockBuf = Buffer.from("test package bytes");
    const correctChecksum = verifier.computeChecksum(mockBuf);

    db.withWriteTransaction((conn) => {
      conn.prepare(
        "UPDATE skill_versions SET checksum = ? WHERE skill_id = 'orphan-skill'",
      ).run(correctChecksum);
    });

    const service = createFridaySkillInstallationService({
      db,
      skillRepo: createFridaySkillRepository(),
      installationRepo: createFridaySkillInstallationRepository(),
      sourceRepo: createFridayMarketplaceSourceRepository(),
      versionResolver: createFridaySkillVersionResolutionService({
        db,
        versionRepo: createFridaySkillVersionRepository(),
        installationRepo: createFridaySkillInstallationRepository(),
        cacheRepo: createFridayMarketplaceCacheRepository(),
      }),
      signatureVerifier: verifier,
      trustScoring: createFridaySkillTrustScoringService(),
      permissionCheck: createFridaySkillPermissionCheckService(),
      packageInstaller: {
        stage: vi.fn().mockReturnValue("/tmp/staging"),
        activate: vi.fn().mockReturnValue("/tmp/final"),
        remove: vi.fn(),
      },
      httpClient: {
        fetchIndex: vi.fn().mockResolvedValue({ generatedAt: NOW, skills: [] }),
        fetchManifest: vi.fn().mockResolvedValue({}),
        fetchSignature: vi.fn().mockRejectedValue(new Error("no sig")),
        fetchPublisherKey: vi.fn().mockRejectedValue(new Error("no key")),
        fetchPackage: vi.fn().mockResolvedValue(mockBuf),
      },
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    await expect(
      service.install({ skillId: "orphan-skill", version: "1.0.0" }),
    ).rejects.toThrow(/Source not resolved/);
  });
});

// ────────────────────────────────────────────────
// Issue 4: Trust threshold boundary at 55
// ────────────────────────────────────────────────
describe("Issue 4: Permissive trust threshold is 55", () => {
  const service = createFridaySkillTrustScoringService();

  function noSigVerification(): FridaySignatureVerificationResult {
    return {
      integrityValid: true,
      signatureValid: false,
      checks: ["integrity:pass", "signature:missing"],
    };
  }

  it("rejects score=54 under permissive policy", () => {
    const breakdown = {
      total: 54,
      signature: 0,
      integrity: 15,
      keyPinning: 10,
      sourcePolicy: 5,
      publisher: 14,
      freshness: 10,
      reasons: [],
    };
    const decision = service.evaluatePolicy("permissive", breakdown, noSigVerification());
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("below permissive threshold");
    expect(decision.reason).toContain("55");
  });

  it("accepts score=55 under permissive policy", () => {
    const breakdown = {
      total: 55,
      signature: 0,
      integrity: 15,
      keyPinning: 10,
      sourcePolicy: 5,
      publisher: 15,
      freshness: 10,
      reasons: [],
    };
    const decision = service.evaluatePolicy("permissive", breakdown, noSigVerification());
    expect(decision.allowed).toBe(true);
  });

  it("accepts score=56 under permissive policy", () => {
    const breakdown = {
      total: 56,
      signature: 0,
      integrity: 15,
      keyPinning: 10,
      sourcePolicy: 5,
      publisher: 16,
      freshness: 10,
      reasons: [],
    };
    const decision = service.evaluatePolicy("permissive", breakdown, noSigVerification());
    expect(decision.allowed).toBe(true);
  });
});

// ────────────────────────────────────────────────
// Issue 5: Signature metadata mismatch rejection
// ────────────────────────────────────────────────
describe("Issue 5: Signature metadata cross-validation", () => {
  const verifier = createFridaySkillSignatureVerifier();

  function makeValidSig() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
    const buf = Buffer.from("test-package");
    const checksum = verifier.computeChecksum(buf);
    const payload = Buffer.from(`friday-skill-signature-v1\nskill-a\n1.0.0\n${checksum}`);
    const sig = sign(null, payload, privateKey);
    return { buf, checksum, sig, pubPem };
  }

  it("rejects when signatureDoc.skillId mismatches requested skillId", () => {
    const { buf, checksum, sig, pubPem } = makeValidSig();
    const result = verifier.verifySignature({
      packageBytes: buf,
      expectedChecksum: checksum,
      skillId: "skill-a",
      version: "1.0.0",
      signatureDoc: {
        skillId: "skill-WRONG",
        version: "1.0.0",
        keyId: "k1",
        algorithm: "ed25519",
        value: sig.toString("base64"),
      },
      publisherKey: {
        keyId: "k1",
        algorithm: "ed25519",
        publicKeyPem: pubPem,
      },
    });
    expect(result.signatureValid).toBe(false);
    expect(result.checks).toContain("metadata:skill-mismatch");
    expect(result.reason).toContain("skill-WRONG");
  });

  it("rejects when signatureDoc.version mismatches requested version", () => {
    const { buf, checksum, sig, pubPem } = makeValidSig();
    const result = verifier.verifySignature({
      packageBytes: buf,
      expectedChecksum: checksum,
      skillId: "skill-a",
      version: "1.0.0",
      signatureDoc: {
        skillId: "skill-a",
        version: "9.9.9",
        keyId: "k1",
        algorithm: "ed25519",
        value: sig.toString("base64"),
      },
      publisherKey: {
        keyId: "k1",
        algorithm: "ed25519",
        publicKeyPem: pubPem,
      },
    });
    expect(result.signatureValid).toBe(false);
    expect(result.checks).toContain("metadata:version-mismatch");
    expect(result.reason).toContain("9.9.9");
  });

  it("rejects when publisherKey.keyId mismatches signatureDoc.keyId", () => {
    const { buf, checksum, sig, pubPem } = makeValidSig();
    const result = verifier.verifySignature({
      packageBytes: buf,
      expectedChecksum: checksum,
      skillId: "skill-a",
      version: "1.0.0",
      signatureDoc: {
        skillId: "skill-a",
        version: "1.0.0",
        keyId: "expected-key",
        algorithm: "ed25519",
        value: sig.toString("base64"),
      },
      publisherKey: {
        keyId: "different-key",
        algorithm: "ed25519",
        publicKeyPem: pubPem,
      },
    });
    expect(result.signatureValid).toBe(false);
    expect(result.checks).toContain("metadata:keyId-mismatch");
    expect(result.reason).toContain("different-key");
    expect(result.reason).toContain("expected-key");
  });

  it("rejects when publisherKey.algorithm mismatches signatureDoc.algorithm", () => {
    const { buf, checksum, sig, pubPem } = makeValidSig();
    const result = verifier.verifySignature({
      packageBytes: buf,
      expectedChecksum: checksum,
      skillId: "skill-a",
      version: "1.0.0",
      signatureDoc: {
        skillId: "skill-a",
        version: "1.0.0",
        keyId: "k1",
        algorithm: "ed25519",
        value: sig.toString("base64"),
      },
      publisherKey: {
        keyId: "k1",
        algorithm: "rsa-sha256",
        publicKeyPem: pubPem,
      },
    });
    expect(result.signatureValid).toBe(false);
    expect(result.checks).toContain("metadata:algorithm-mismatch");
    expect(result.reason).toContain("rsa-sha256");
    expect(result.reason).toContain("ed25519");
  });

  it("passes when all metadata matches", () => {
    const { buf, checksum, sig, pubPem } = makeValidSig();
    const result = verifier.verifySignature({
      packageBytes: buf,
      expectedChecksum: checksum,
      skillId: "skill-a",
      version: "1.0.0",
      signatureDoc: {
        skillId: "skill-a",
        version: "1.0.0",
        keyId: "k1",
        algorithm: "ed25519",
        value: sig.toString("base64"),
      },
      publisherKey: {
        keyId: "k1",
        algorithm: "ed25519",
        publicKeyPem: pubPem,
      },
    });
    expect(result.signatureValid).toBe(true);
    expect(result.integrityValid).toBe(true);
    expect(result.checks).toContain("signature:pass");
  });
});
```


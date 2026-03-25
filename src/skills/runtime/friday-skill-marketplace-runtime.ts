import type { FridaySqliteLayer } from "#state";
import { createFridayMarketplaceHttpClient } from "../services/friday-marketplace-http-client.js";
import type { FetchFn } from "../services/friday-marketplace-http-client.js";
import type { FridaySkillMarketplaceRuntime } from "./friday-skill-marketplace-runtime.types.js";

import { createFridayMarketplaceSourceRepository } from "../persistence/friday-marketplace-source-repository.js";
import { createFridayMarketplaceCacheRepository } from "../persistence/friday-marketplace-cache-repository.js";
import { createFridaySkillRepository } from "../persistence/friday-skill-repository.js";
import { createFridaySkillVersionRepository } from "../persistence/friday-skill-version-repository.js";
import { createFridaySkillInstallationRepository } from "../persistence/friday-skill-installation-repository.js";

import { createFridayMarketplaceSourceService } from "../services/friday-marketplace-source-service.js";
import { createFridayMarketplaceCacheService } from "../services/friday-marketplace-cache-service.js";
import { createFridayMarketplaceDiscoveryService } from "../services/friday-marketplace-discovery-service.js";
import { createFridayMarketplaceSyncService } from "../services/friday-marketplace-sync-service.js";
import { createFridaySkillSignatureVerifier } from "../services/friday-skill-signature-verifier.js";
import { createFridaySkillTrustScoringService } from "../services/friday-skill-trust-scoring-service.js";
import { createFridaySkillVersionResolutionService } from "../services/friday-skill-version-resolution-service.js";
import { createFridaySkillPermissionCheckService } from "../services/friday-skill-permission-check-service.js";
import { createFridaySkillPackageInstaller } from "../services/friday-skill-package-installer.js";
import { createFridaySkillInstallationService } from "../services/friday-skill-installation-service.js";
import { createFridaySkillLifecycleService } from "../services/friday-skill-lifecycle-service.js";
import { createFridayMarketplaceSyncJob } from "#jobs";
import type { FridaySelfHealingApiService } from "#learning";
import type { FridaySkillRegistry } from "../registry/friday-skill-registry.types.js";

// ─── Dependencies ───

export interface CreateSkillMarketplaceRuntimeDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
  fetchFn: FetchFn;
  managedSkillsDir: string;
  hubVersion: string;
  supportedApiVersions: string[];
  registry: FridaySkillRegistry;
  publishEvent?: (event: string, payload: unknown) => Promise<void>;
  selfHealing?: FridaySelfHealingApiService;
}

// ─── Factory ───

export function createFridaySkillMarketplaceRuntime(
  deps: CreateSkillMarketplaceRuntimeDeps,
): FridaySkillMarketplaceRuntime {
  // 1. Repositories
  const sourceRepo = createFridayMarketplaceSourceRepository();
  const cacheRepo = createFridayMarketplaceCacheRepository();
  const skillRepo = createFridaySkillRepository();
  const versionRepo = createFridaySkillVersionRepository();
  const installationRepo = createFridaySkillInstallationRepository();

  // 2. Infrastructure services
  const httpClient = createFridayMarketplaceHttpClient({ fetchFn: deps.fetchFn });
  const signatureVerifier = createFridaySkillSignatureVerifier();
  const trustScoring = createFridaySkillTrustScoringService();
  const permissionCheck = createFridaySkillPermissionCheckService();
  const packageInstaller = createFridaySkillPackageInstaller({
    managedSkillsDir: deps.managedSkillsDir,
  });

  // 3. Source management
  const sources = createFridayMarketplaceSourceService({
    db: deps.db,
    sourceRepo,
    cacheRepo,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  // 4. Cache management
  const cache = createFridayMarketplaceCacheService({
    db: deps.db,
    cacheRepo,
    nowIso: deps.nowIso,
  });

  // 5. Discovery
  const discovery = createFridayMarketplaceDiscoveryService({
    db: deps.db,
    cacheRepo,
  });

  // 6. Sync
  const sync = createFridayMarketplaceSyncService({
    db: deps.db,
    sourceRepo,
    cacheRepo,
    skillRepo,
    versionRepo,
    httpClient,
    trustScoring,
    signatureVerifier,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  // 7. Version resolution
  const versions = createFridaySkillVersionResolutionService({
    db: deps.db,
    versionRepo,
    installationRepo,
    cacheRepo,
  });

  // 8. Installation pipeline
  const installations = createFridaySkillInstallationService({
    db: deps.db,
    skillRepo,
    installationRepo,
    sourceRepo,
    versionResolver: versions,
    signatureVerifier,
    trustScoring,
    permissionCheck,
    packageInstaller,
    httpClient,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    publishEvent: deps.publishEvent,
  });

  const lifecycle = createFridaySkillLifecycleService({
    db: deps.db,
    nowIso: deps.nowIso,
    managedSkillsDir: deps.managedSkillsDir,
    hubVersion: deps.hubVersion,
    supportedApiVersions: deps.supportedApiVersions,
    registry: deps.registry,
    discovery,
    installations,
    packageInstaller,
    signatureVerifier,
    trustScoring,
    skillRepo,
    versionRepo,
    installationRepo,
    sourceRepo,
    cacheRepo,
    selfHealing: deps.selfHealing,
  });

  // 9. Sync job
  const syncJob = createFridayMarketplaceSyncJob({
    syncService: sync,
    cacheService: cache,
  });

  return {
    sources,
    discovery,
    cache,
    sync,
    versions,
    installations,
    lifecycle,
    verify: signatureVerifier,
    trust: trustScoring,
    syncJob,
  };
}

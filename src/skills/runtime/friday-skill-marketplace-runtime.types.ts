import type { FridayMarketplaceSourceService } from "../services/friday-marketplace-source-service.js";
import type { FridayMarketplaceDiscoveryService } from "../services/friday-marketplace-discovery-service.js";
import type { FridayMarketplaceCacheService } from "../services/friday-marketplace-cache-service.js";
import type { FridayMarketplaceSyncService } from "../services/friday-marketplace-sync-service.js";
import type { FridaySkillVersionResolutionService } from "../services/friday-skill-version-resolution-service.js";
import type { FridaySkillInstallationService } from "../services/friday-skill-installation-service.js";
import type { FridaySkillLifecycleService } from "../services/friday-skill-lifecycle-service.js";
import type { FridaySkillSignatureVerifier } from "../services/friday-skill-signature-verifier.js";
import type { FridaySkillTrustScoringService } from "../services/friday-skill-trust-scoring-service.js";
import type { FridayMarketplaceSyncJob } from "#jobs";

/**
 * Composite runtime surface for the Skill Marketplace subsystem.
 * Follows the same composition pattern as FridayWorkflowRuntime.
 */
export interface FridaySkillMarketplaceRuntime {
  sources: FridayMarketplaceSourceService;
  discovery: FridayMarketplaceDiscoveryService;
  cache: FridayMarketplaceCacheService;
  sync: FridayMarketplaceSyncService;
  versions: FridaySkillVersionResolutionService;
  installations: FridaySkillInstallationService;
  lifecycle: FridaySkillLifecycleService;
  verify: FridaySkillSignatureVerifier;
  trust: FridaySkillTrustScoringService;
  syncJob: FridayMarketplaceSyncJob;
}

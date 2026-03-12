import type { SkillLifecycleStatus } from "../model/friday-skill-lifecycle.types.js";
import type { SkillInvocationMode, SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type { SkillOrigin, SkillSource } from "../model/friday-skill-source.types.js";
import type { FridayLoadedSkillPackage } from "../manifest/friday-skill-package-loader.js";
import type { FridaySkillTrustDecision } from "../trust/friday-skill-trust-enforcer.js";
import type { FridaySkillValidationResult } from "../validation/friday-skill-validation.types.js";
import type { FridayHubConfigManagerService, FridayHubGatewayIngressService, FridayHubMemoryStateService } from "#hub";

export interface FridaySkillDiscoveryRoot {
  origin: SkillOrigin;
  source: SkillSource;
  dir: string;
}

export interface FridayDiscoveredSkillCandidate {
  root: FridaySkillDiscoveryRoot;
  skillDir: string;
}

export interface FridayRegisteredSkill {
  manifest: SkillManifestV2;
  skillDir: string;
  source: SkillSource;
  origin: SkillOrigin;
  status: SkillLifecycleStatus;
  loaded: FridayLoadedSkillPackage;
  validation: FridaySkillValidationResult;
  trust: FridaySkillTrustDecision;
}

export interface FridaySkillResolutionContext {
  channel?: string;
  mode?: SkillInvocationMode;
}

export interface FridayCompatResult {
  compatible: boolean;
  reasons: string[];
}

export interface CreateFridaySkillRegistryOptions {
  workspaceDir: string;
  hubVersion: string;
  supportedApiVersions: string[];
  configManager: FridayHubConfigManagerService;
  memoryStateService: FridayHubMemoryStateService;
  gatewayIngress?: FridayHubGatewayIngressService;
}

export interface FridaySkillRegistry {
  list(): FridayRegisteredSkill[];
  get(skillId: string): FridayRegisteredSkill | null;
  resolveByIntent(skillIntent: string, context: FridaySkillResolutionContext): FridayRegisteredSkill | null;
  validateAll(): FridaySkillValidationResult[];
  reload(skillId: string): Promise<void>;
  refresh(): Promise<void>;
  isCompatible(manifest: SkillManifestV2): FridayCompatResult;
  startWatching(): Promise<void>;
  stopWatching(): Promise<void>;
  close(): Promise<void>;
}

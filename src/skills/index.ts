// Model — permission policy types
export type {
  PermissionResource,
  PermissionAction,
  PermissionSelectors,
  PermissionGrant,
  PermissionPromptToken,
  PermissionPolicyV2,
  LegacySkillPermissionV1,
} from "./model/friday-skill-permission-policy.types.js";

// Model — manifest v2 types
export type {
  SkillKind,
  SkillCategory,
  SkillRuntimeKind,
  SkillInvocationMode,
  SkillStepType,
  SkillStepDefinition,
  SkillManifestV2,
} from "./model/friday-skill-manifest-v2.types.js";

// Model — source types
export type { SkillSource, SkillOrigin } from "./model/friday-skill-source.types.js";
export { FRIDAY_SKILL_ORIGIN_PRECEDENCE, getSkillOriginPrecedence, compareSkillOrigins } from "./model/friday-skill-source.types.js";

// Model — trust types
export type { SkillTrustTier, SkillExecutionMode, SkillSandboxPolicy } from "./model/friday-skill-trust.types.js";

// Model — lifecycle types
export type { SkillLifecycleStatus, SkillLifecycleOperation, FridaySkillLifecycleTransition } from "./model/friday-skill-lifecycle.types.js";

// Model — runtime types
export type {
  SkillRunStatus,
  SkillRunState,
  SkillInitContext,
  ToolRequestItem,
  ToolResultItem,
  SkillExecuteContext,
  SkillExecutionResult,
  SkillTeardownContext,
  FridaySkill,
} from "./model/friday-skill-runtime.types.js";

// Manifest
export { FRIDAY_SKILL_MANIFEST_DEFAULTS, applyFridaySkillManifestDefaults } from "./manifest/friday-skill-manifest-defaults.js";
export { FRIDAY_SKILL_MANIFEST_V2_SCHEMA, parseFridaySkillManifestV2, safeParseFridaySkillManifestV2 } from "./manifest/friday-skill-manifest.schema.js";
export {
  loadFridaySkillManifest,
  type LoadFridaySkillManifestOptions,
  type LoadedFridaySkillManifest,
  type FridaySkillManifestLoadError,
  type LoadFridaySkillManifestResult,
} from "./manifest/friday-skill-manifest-loader.js";
export {
  parseFridaySkillFrontmatter,
  loadFridaySkillFrontmatter,
  type ParsedSkillFrontmatter,
  type ParsedFridaySkillMarkdown,
  type FridaySkillFrontmatterParseError,
  type ParseFridaySkillFrontmatterResult,
} from "./manifest/friday-skill-frontmatter-parser.js";
export {
  mapLegacyPermissionV1ToV2,
  adaptFridayLegacySkill,
  type FridayLegacySkillMetadata,
  type FridayLegacySkillInvocationPolicy,
  type AdaptFridayLegacySkillOptions,
  type AdaptedFridayLegacySkill,
} from "./manifest/friday-skill-legacy-adapter.js";
export {
  loadFridaySkillPackage,
  resolveFridaySkillDeclaredFiles,
  type FridaySkillLoadMode,
  type LoadFridaySkillPackageOptions,
  type FridayLoadedSkillPackage,
  type LoadFridaySkillPackageResult,
} from "./manifest/friday-skill-package-loader.js";

// Validation
export type {
  FridaySkillValidationStage,
  FridaySkillValidationSeverity,
  FridaySkillValidationIssue,
  FridaySkillValidationResult,
} from "./validation/friday-skill-validation.types.js";
export {
  validateFridaySkillPackage,
  type ValidateFridaySkillPackageOptions,
} from "./validation/friday-skill-validation-pipeline.js";

// Trust
export {
  mapFridaySkillOriginToTrustTier,
  getFridayDefaultSandboxPolicy,
  enforceFridaySkillTrust,
  type FridaySkillSecurityProfile,
  type FridaySkillTrustDecision,
} from "./trust/friday-skill-trust-enforcer.js";

// Lifecycle
export {
  canApplyFridaySkillLifecycleOperation,
  applyFridaySkillLifecycleOperation,
  type FridaySkillLifecycleTransitionResult,
} from "./lifecycle/friday-skill-lifecycle-machine.js";

// Registry
export type {
  FridaySkillDiscoveryRoot,
  FridayDiscoveredSkillCandidate,
  FridayRegisteredSkill,
  FridaySkillResolutionContext,
  FridayCompatResult,
  CreateFridaySkillRegistryOptions,
  FridaySkillRegistry,
} from "./registry/friday-skill-registry.types.js";
export { FridaySkillRegistryImpl } from "./registry/friday-skill-registry.js";

// Marketplace barrel (inlined from former friday-skill-marketplace-index)
// Model — marketplace types
export type {
  UUID,
  ISODateTime,
  JsonPrimitive,
  JsonValue,
  JsonObject,
  FridayMarketplaceTrustPolicy,
  FridayMarketplaceSignatureAlgorithm,
  FridaySkillInstallationStatus,
  FridayMarketplaceSourceRow,
  FridayMarketplaceCacheRow,
  FridaySkillRow,
  FridaySkillVersionRow,
  FridaySkillInstallationRow,
  FridayMarketplaceSourceEntity,
  FridayMarketplaceSourceCatalogSummary,
  FridayMarketplaceSourceTrustSummary,
  FridayMarketplaceSourceHealthSummary,
  FridayMarketplaceSourceView,
  FridayMarketplaceCacheEntity,
  FridaySkillEntity,
  FridaySkillSignature,
  FridaySkillVersionEntity,
  FridaySkillInstallationEntity,
  FridayMarketplaceSourceCreateInput,
  FridayMarketplaceSourcePatchInput,
  FridaySkillCatalogQuery,
  FridaySkillCatalogItem,
  FridaySkillVerificationStatus,
  FridaySkillRequirementPreview,
  FridaySkillPermissionPreviewGrant,
  FridaySkillPermissionPreview,
  FridaySkillEligibility,
  FridaySkillInstallPlanSummary,
  FridaySkillFailureEvidenceSummary,
  FridayMarketplaceIndexDocument,
  FridayMarketplaceSignatureDocument,
  FridayMarketplacePublisherKeyDocument,
  FridaySignatureVerificationResult,
  FridayTrustScoreBreakdown,
  FridaySkillVersionResolutionInput,
  FridaySkillVersionResolutionResult,
  FridaySkillInstallRequest,
  FridaySkillInstallResult,
} from "./model/friday-skill-marketplace.types.js";

// Persistence — marketplace
export {
  createFridayMarketplaceSourceRepository,
  type FridayMarketplaceSourceRepository,
} from "./persistence/friday-marketplace-source-repository.js";
export {
  createFridayMarketplaceCacheRepository,
  type FridayMarketplaceCacheRepository,
} from "./persistence/friday-marketplace-cache-repository.js";
export {
  createFridaySkillRepository,
  type FridaySkillRepository,
} from "./persistence/friday-skill-repository.js";
export {
  createFridaySkillVersionRepository,
  type FridaySkillVersionRepository,
} from "./persistence/friday-skill-version-repository.js";
export {
  createFridaySkillInstallationRepository,
  type FridaySkillInstallationRepository,
} from "./persistence/friday-skill-installation-repository.js";

// Services — marketplace
export {
  createFridayMarketplaceHttpClient,
  type FridayMarketplaceHttpClient,
  type FetchFn,
  type CreateMarketplaceHttpClientDeps,
} from "./services/friday-marketplace-http-client.js";
export type {
  FridaySkillReadonlySystemContext,
  FridaySkillReadonlyDiagnosisContext,
  FridaySkillReadonlyAutofixContext,
  FridaySkillReadonlyBrowserInspectOptions,
  FridaySkillReadonlyBrowserInspection,
  FridaySkillReadonlyBrowserContext,
  FridaySkillNodeRuntimeContext,
} from "./executor/friday-skill-executor.types.js";
export {
  createFridayMarketplaceSourceService,
  type FridayMarketplaceSourceService,
  type CreateMarketplaceSourceServiceDeps,
} from "./services/friday-marketplace-source-service.js";
export {
  createFridayMarketplaceCacheService,
  FRIDAY_DEFAULT_CACHE_TTL,
  type FridayMarketplaceCacheService,
  type FridayMarketplaceCacheTtlConfig,
  type CreateMarketplaceCacheServiceDeps,
} from "./services/friday-marketplace-cache-service.js";
export {
  createFridayMarketplaceDiscoveryService,
  type FridayMarketplaceDiscoveryService,
  type FridaySkillCatalogResult,
  type CreateMarketplaceDiscoveryServiceDeps,
} from "./services/friday-marketplace-discovery-service.js";
export {
  createFridayMarketplaceSyncService,
  type FridayMarketplaceSyncService,
  type FridaySyncResult,
  type CreateMarketplaceSyncServiceDeps,
} from "./services/friday-marketplace-sync-service.js";
export {
  createFridaySkillSignatureVerifier,
  type FridaySkillSignatureVerifier,
} from "./services/friday-skill-signature-verifier.js";
export {
  createFridaySkillTrustScoringService,
  type FridaySkillTrustScoringService,
  type FridayTrustScoreInput,
  type FridayTrustPolicyDecision,
} from "./services/friday-skill-trust-scoring-service.js";
export {
  createFridaySkillVersionResolutionService,
  type FridaySkillVersionResolutionService,
  type CreateVersionResolutionServiceDeps,
} from "./services/friday-skill-version-resolution-service.js";
export {
  createFridaySkillPermissionCheckService,
  type FridaySkillPermissionCheckService,
  type FridayPermissionCheckResult,
} from "./services/friday-skill-permission-check-service.js";
export {
  createFridaySkillPackageInstaller,
  type FridaySkillPackageInstaller,
  type CreateSkillPackageInstallerDeps,
} from "./services/friday-skill-package-installer.js";
export {
  createFridaySkillInstallationService,
  type FridaySkillInstallationService,
  type CreateSkillInstallationServiceDeps,
} from "./services/friday-skill-installation-service.js";
export {
  createFridaySkillLifecycleService,
  type FridaySkillLifecycleService,
  type FridaySkillLifecycleSummary,
  type FridaySkillLifecycleDetail,
  type FridaySkillCatalogViewItem,
  type FridaySkillOriginType,
  type FridaySkillMaturity,
  type FridaySkillVerificationEvidence,
  type FridaySkillInstallOutcome,
  type FridaySkillUpdateOutcome,
  type FridaySkillDeleteOutcome,
  type FridayManifestValidationOutcome,
  type CreateFridaySkillLifecycleServiceDeps,
} from "./services/friday-skill-lifecycle-service.js";

// Runtime — marketplace
export type { FridaySkillMarketplaceRuntime } from "./runtime/friday-skill-marketplace-runtime.types.js";
export {
  createFridaySkillMarketplaceRuntime,
  type CreateSkillMarketplaceRuntimeDeps,
} from "./runtime/friday-skill-marketplace-runtime.js";

// Generator (re-export key types for convenience; full module at #skills/generator)
export type { FridaySkillGeneratorService } from "./generator/services/friday-skill-generator-service.types.js";

// Executor
export type {
  FridayShellRunOptions,
  FridayShellRunResult,
  FridayShellExecutor,
  FridaySkillAiHelperContext,
  FridayNodeRunOptions,
  FridayNodeRunResult,
  FridayNodeExecutor,
  FridaySkillExecuteRequest,
  FridaySkillExecuteStatus,
  FridaySkillExecuteResult,
  FridaySkillExecuteHandle,
  FridaySkillExecutor,
  CreateFridaySkillExecutorDeps,
  FridayProviderServiceLike,
} from "./executor/friday-skill-executor.types.js";
export { createFridayShellExecutor } from "./executor/friday-shell-executor.js";
export { createFridayNodeExecutor } from "./executor/friday-node-executor.js";
export { createFridaySkillExecutor } from "./executor/friday-skill-executor.js";

// Converter (re-export key types for convenience; full module at #skills/converter)
export type { FridaySkillConverterService } from "./converter/services/friday-skill-converter-service.types.js";

// Watcher
export { createFridaySkillWatcher } from "./registry/friday-skill-watcher.js";
export type { FridaySkillFileChangeEvent, FridaySkillWatcher } from "./registry/friday-skill-watcher.js";

// Discovery
export { resolveFridaySkillDiscoveryRoots, discoverFridaySkillCandidates } from "./registry/friday-skill-discovery.js";

// Individual validators (granular access beyond the pipeline)
export { validateFridaySkillEngineCompatibility } from "./validation/friday-skill-engine-compat-validator.js";
export type { FridaySkillEngineCompatibilityContext } from "./validation/friday-skill-engine-compat-validator.js";
export { validateFridaySkillStepGraph } from "./validation/friday-skill-step-graph-validator.js";
export { compileFridaySkillSchemas } from "./validation/friday-skill-schema-compiler.js";
export type { FridayCompiledSkillSchemas, CompileFridaySkillSchemasOptions } from "./validation/friday-skill-schema-compiler.js";
export { validateFridayFilesystemScope, validateFridayManifestFilesystemScopes } from "./validation/friday-skill-filesystem-scope-validator.js";
export type { ValidateFridayFilesystemScopeOptions, FridayFilesystemScopeValidationResult } from "./validation/friday-skill-filesystem-scope-validator.js";

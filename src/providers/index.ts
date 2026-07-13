// ─── Provider system barrel exports ───

// Model types
export type * from "./model/friday-provider.types.js";
export type * from "./model/friday-provider-upgrade.types.js";
export type * from "./model/friday-provider-context.types.js";
export type * from "./model/friday-provider-cost.types.js";
export {
  FRIDAY_PROVIDER_KINDS,
  FRIDAY_PROVIDER_APIS,
  FRIDAY_PROVIDER_BACKEND_KINDS,
  FRIDAY_PROVIDER_CLI_BACKEND_IDS,
  FRIDAY_RUNTIME_CAPABILITY_IDS,
  isFridayAnthropicBearerAuthMode,
  normalizeFridayProviderSupportedModels,
  normalizeFridayModelRoutingConfig,
  resolveFridayProviderPreferredModel,
} from "./model/friday-provider.types.js";
export type {
  FridayRuntimeCapabilityId,
} from "./model/friday-provider.types.js";
export type {
  BuildFridayRuntimeCapabilityMatrixInput,
  FridayRuntimeCapabilityItem,
  FridayRuntimeCapabilityMatrix,
  FridayRuntimeCapabilityRepairOption,
  FridayRuntimeCapabilityRisk,
  FridayRuntimeCapabilitySource,
  FridayRuntimeCapabilitySourceKind,
  FridayRuntimeCapabilitySourceStatus,
  FridayRuntimeCapabilityState,
} from "./model/friday-runtime-capabilities.js";
export {
  buildFridayRuntimeCapabilityMatrix,
  filterFridayProviderRoutesByRequiredCapabilities,
  fridayProviderRouteSupportsCapability,
  inferFridayModelSupportsEmbedding,
  inferFridayModelSupportsVision,
} from "./model/friday-runtime-capabilities.js";
export {
  defaultFridayProviderUpgradeFields,
  mergeFridayProviderUpgradeFields,
} from "./model/friday-provider-upgrade.types.js";
export {
  FRIDAY_PROVIDER_PRESETS,
  FRIDAY_PROVIDER_KIND_SET,
  isFridayProviderKind,
  getFridayProviderPreset,
  detectFridayProviderKindFromApiKey,
} from "./model/friday-provider-catalog.js";
export {
  listFridayProviderTemplates,
  getFridayProviderTemplate,
} from "./model/friday-provider-templates.js";
export type {
  FridayProviderFamily,
  FridayProviderCapability,
} from "./model/friday-provider-capabilities.js";
export {
  FRIDAY_PROVIDER_CAPABILITIES,
  FRIDAY_PROVIDER_FAMILIES,
  getFridayProviderCapability,
  getFridayProviderAuthModesForBackend,
  isFridayProviderApiSupportedForKind,
  isFridayProviderAuthModeSupportedForKind,
  isFridayProviderAuthModeSupportedForKindAndBackend,
  isFridayProviderBackendKindSupportedForKind,
} from "./model/friday-provider-capabilities.js";

// CLI backends
export {
  probeFridayCliSession,
  runFridayCliBackendTextCompletion,
} from "./cli/friday-provider-cli-backend.js";

// Security
export {
  encryptSecret,
  decryptSecret,
  decryptSecretWithMigration,
  getMasterKey,
  getProvisionedMasterKey,
  getStrictMasterKey,
  resetMasterKeyCache,
  FRIDAY_SECRET_ENVELOPE_V2,
  FRIDAY_SECRET_AAD_SCHEMA_VERSION,
} from "./security/friday-secret-crypto.js";
export type {
  FridaySecretAadContext,
  FridaySecretMigrationResult,
} from "./security/friday-secret-crypto.js";
export type {
  CreateFridayEphemeralSecretHandleRegistryDeps,
  FridayEphemeralSecretHandle,
  FridayEphemeralSecretHandleRegistry,
} from "./security/friday-secret-handle-registry.js";
export { createFridayEphemeralSecretHandleRegistry } from "./security/friday-secret-handle-registry.js";

// Persistence
export type { FridayProviderProfileRepository } from "./persistence/friday-provider-profile-repository.js";
export { createFridayProviderProfileRepository } from "./persistence/friday-provider-profile-repository.js";
export type { FridayAuthProfileRepository } from "./persistence/friday-auth-profile-repository.js";
export { createFridayAuthProfileRepository } from "./persistence/friday-auth-profile-repository.js";
export type { FridaySecretRepository, FridaySecretEntity } from "./persistence/friday-secret-repository.js";
export { createFridaySecretRepository, fridaySecretAadContext, FRIDAY_SECRETS_AAD_STORE } from "./persistence/friday-secret-repository.js";
export type { FridayProviderUsageRepository } from "./persistence/friday-provider-usage-repository.js";
export { createFridayProviderUsageRepository } from "./persistence/friday-provider-usage-repository.js";

// Security
export type { FridayEncryptedEnvelope } from "./security/friday-secret-crypto.js";

// Validation
export type { FridayProviderValidator } from "./validation/friday-provider-validator.js";
export { createFridayProviderValidator } from "./validation/friday-provider-validator.js";

// Routing
export type { FridayProviderFallback, FridayProviderFallbackOptions } from "./routing/friday-provider-fallback.js";
export { createFridayProviderFallback } from "./routing/friday-provider-fallback.js";

// Context
export type { FridayProviderTokenEstimator } from "./context/friday-provider-token-estimator.js";
export { createFridayProviderTokenEstimator } from "./context/friday-provider-token-estimator.js";
export type { FridayProviderContextPruner } from "./context/friday-provider-context-pruner.js";
export { createFridayProviderContextPruner } from "./context/friday-provider-context-pruner.js";
export type { FridayProviderContextCompactor } from "./context/friday-provider-context-compactor.js";
export { createFridayProviderContextCompactor } from "./context/friday-provider-context-compactor.js";
export type { FridayProviderPromptCacheAdapter } from "./context/friday-provider-prompt-cache.js";
export { createFridayProviderPromptCacheAdapter } from "./context/friday-provider-prompt-cache.js";

// Cost
export type { FridayProviderComplexityClassifier } from "./cost/friday-provider-complexity-classifier.js";
export { createFridayProviderComplexityClassifier } from "./cost/friday-provider-complexity-classifier.js";
export type { FridayProviderPricingCatalog } from "./cost/friday-provider-pricing-catalog.js";
export { createFridayProviderPricingCatalog } from "./cost/friday-provider-pricing-catalog.js";
export type { FridayProviderCostRouter } from "./cost/friday-provider-cost-router.js";
export { createFridayProviderCostRouter } from "./cost/friday-provider-cost-router.js";
export type { FridayProviderBudgetService } from "./cost/friday-provider-budget-service.js";
export { createFridayProviderBudgetService } from "./cost/friday-provider-budget-service.js";
export type { FridayProviderUsageNormalizer } from "./cost/friday-provider-usage-normalizer.js";
export { createFridayProviderUsageNormalizer } from "./cost/friday-provider-usage-normalizer.js";
export type { FridayProviderCostCalculator } from "./cost/friday-provider-cost-calculator.js";
export { createFridayProviderCostCalculator } from "./cost/friday-provider-cost-calculator.js";

// OAuth
export type {
  FridayPkcePair,
  FridayAnthropicAuthorizationCodeParts,
  FridayOAuthProviderAdapter,
  CreateFridayAnthropicOAuthDeps,
  FridayOAuthCredentialStore,
  CreateFridayOAuthCredentialStoreDeps,
  FridayOAuthProviderRegistry,
  FridayOAuthTokenManager,
  CreateFridayOAuthTokenManagerDeps,
} from "./oauth/index.js";
export {
  FRIDAY_ANTHROPIC_OAUTH_DISABLED_CODE,
  FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE,
  FRIDAY_OPENAI_CODEX_OAUTH_AUTH_BASE_URL,
  FRIDAY_OPENAI_CODEX_OAUTH_DEVICE_REDIRECT_URI,
  FRIDAY_OPENAI_CODEX_OAUTH_DEVICE_VERIFICATION_URL,
  FRIDAY_OPENAI_CODEX_OAUTH_TOKEN_URL,
  createFridayOpenAICodexOAuthProvider,
  generateFridayPkce,
  parseFridayAnthropicAuthorizationCode,
  createFridayAnthropicOAuthProvider,
  createFridayOAuthCredentialStore,
  createFridayOAuthProviderRegistry,
  createFridayOAuthTokenManager,
} from "./oauth/index.js";

// Service
export type {
  FridayProviderService,
  CreateFridayProviderServiceDeps,
  FridayProviderTenantContext,
  FridayProviderCredentialScope,
  FridayProviderCredentialResolver,
} from "./services/friday-provider-service.types.js";
export { createFridayProviderService } from "./services/friday-provider-service.js";
export { resolveFridayRoutingStabilityWarning } from "./services/friday-provider-routing-warning.js";
export type {
  FridaySecretAdminService,
  FridaySecretSummary,
  FridayListSecretsQuery,
  FridayCreateSecretInput,
  FridayUpdateSecretInput,
  CreateFridaySecretAdminServiceDeps,
} from "./services/friday-secret-admin-service.js";
export { createFridaySecretAdminService } from "./services/friday-secret-admin-service.js";

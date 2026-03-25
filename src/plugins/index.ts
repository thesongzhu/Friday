// ─── Model + Types ───

export type {
  FridayPluginKind,
  FridayPluginSource,
  FridayPluginStatus,
  FridayPluginTrustMode,
  FridayPluginSdkPreviewCapability,
  FridayPluginPublisherProgram,
  FridayPluginPermissionResource,
  FridayPluginPermissionAction,
  FridayPluginPermissionGrant,
  FridayPluginPermissionGrantSelectors,
  FridayPluginPermissionPolicy,
  FridayPluginPromptOnAction,
  FridayPluginSignature,
  FridayPluginSdkPreviewManifest,
  FridayPluginCapabilitySummary,
  FridayPluginPolicySummary,
  FridayPluginManifest,
  FridayPluginEntity,
  FridayPluginDependencyEntity,
  FridayUpsertPluginInput,
  FridayPluginListQuery,
  FridayUpsertPluginDependencyInput,
  FridayDiscoveredPluginCandidate,
  FridayPluginInstallPlanInput,
  FridayPluginInstallPlanItem,
  FridayPluginInstallPlan,
  FridayPluginLoadPlan,
  FridayPluginEntrypointModule,
  FridayPluginActivationContext,
  FridayLoadedPlugin,
  FridayRegisteredPlugin,
} from "./model/friday-plugin.types.js";

export {
  FRIDAY_PLUGIN_MANIFEST_FILENAME,
  FRIDAY_CORE_CHANNEL_PLUGIN_IDS,
  FRIDAY_PLUGIN_SOURCE_PRECEDENCE,
  FRIDAY_PLUGIN_ERROR_CODES,
  FRIDAY_PLUGIN_VALID_STATUSES,
  FRIDAY_PLUGIN_VALID_KINDS,
  FRIDAY_PLUGIN_VALID_SOURCES,
  FRIDAY_PLUGIN_VALID_TRUST_MODES,
  FRIDAY_PLUGIN_SDK_PREVIEW_VERSION,
  FRIDAY_PLUGIN_VALID_SDK_PREVIEW_CAPABILITIES,
} from "./model/friday-plugin.types.js";

// ─── Manifest ───

export { validateFridayPluginManifest } from "./manifest/friday-plugin-manifest.schema.js";

export type {
  FridayPluginManifestLoader,
  CreateFridayPluginManifestLoaderDeps,
} from "./manifest/friday-plugin-manifest-loader.js";
export { createFridayPluginManifestLoader } from "./manifest/friday-plugin-manifest-loader.js";

// ─── Persistence ───

export type { FridayPluginRepository } from "./persistence/friday-plugin-repository.js";
export { createFridayPluginRepository } from "./persistence/friday-plugin-repository.js";

export type { FridayPluginDependencyRepository } from "./persistence/friday-plugin-dependency-repository.js";
export { createFridayPluginDependencyRepository } from "./persistence/friday-plugin-dependency-repository.js";

// ─── Services ───

export type {
  FridayPluginDiscoveryService,
  FridayPluginDiscoveryInput,
  CreateFridayPluginDiscoveryServiceDeps,
} from "./services/friday-plugin-discovery-service.js";
export { createFridayPluginDiscoveryService } from "./services/friday-plugin-discovery-service.js";

export type {
  FridayPluginRegistryService,
  CreateFridayPluginRegistryServiceDeps,
} from "./services/friday-plugin-registry-service.js";
export { createFridayPluginRegistryService } from "./services/friday-plugin-registry-service.js";

export type {
  FridayPluginDependencyResolver,
  CreateFridayPluginDependencyResolverDeps,
} from "./services/friday-plugin-dependency-resolver.js";
export { createFridayPluginDependencyResolver } from "./services/friday-plugin-dependency-resolver.js";

export type {
  FridayPluginLoader,
  CreateFridayPluginLoaderDeps,
} from "./services/friday-plugin-loader.js";
export { createFridayPluginLoader } from "./services/friday-plugin-loader.js";

// ─── Security ───

export type {
  FridayPluginSignatureVerifier,
  FridayPluginSignatureVerificationResult,
  FridayPluginMarketplaceVerifyInput,
  FridayPluginLocalTrustInput,
  CreateFridayPluginSignatureVerifierDeps,
} from "./security/friday-plugin-signature-verifier.js";
export { createFridayPluginSignatureVerifier } from "./security/friday-plugin-signature-verifier.js";

// ─── Marketplace Client ───

export type {
  FridayPluginMarketplaceClient,
  FridayMarketplacePluginSummary,
  FridayMarketplacePluginDetail,
  FridayMarketplaceSearchQuery,
  FridayMarketplaceSearchResult,
  FridayMarketplaceDownloadResult,
  FridayMarketplaceVersionEntry,
  CreateFridayPluginMarketplaceClientDeps,
} from "./services/friday-plugin-marketplace-client.js";
export { createFridayPluginMarketplaceClient } from "./services/friday-plugin-marketplace-client.js";

// ─── Plugin Service ───

export type {
  FridayPluginService,
  FridayPluginInstallInput,
  FridayPluginPreviewPolicyConfig,
  FridayPluginVersionInfo,
  FridayMarketplacePluginVersionInfo,
  CreateFridayPluginServiceDeps,
} from "./services/friday-plugin-service.types.js";
export { createFridayPluginService } from "./services/friday-plugin-service.js";

// ─── Channel Plugin Types ───

export type {
  FridayChannelPlugin,
  FridayChannelCapabilities,
  FridayChannelChatKind,
  FridayInboundChannelMessage,
  FridayChannelAttachment,
  FridayChannelSendMessageInput,
  FridayChannelOutboundAttachment,
  FridayChannelSendMessageResult,
  FridayChannelDeliveryEvent,
  FridayChannelDeliveryEventKind,
  FridayChannelRuntimeContext,
} from "./channels/friday-channel-plugin.types.js";

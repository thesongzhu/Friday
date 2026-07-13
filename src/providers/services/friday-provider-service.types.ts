import type { FridaySqliteLayer } from "#state";

import type {
  FridayAuthProfile,
  FridayModelRoutingConfig,
  FridayOAuthDeviceAuthorizationRequest,
  FridayOAuthLoginInitiation,
  FridayOAuthLoginResult,
  FridayProviderApi,
  FridayProviderAttempt,
  FridayProviderAuthMode,
  FridayProviderBackendKind,
  FridayProviderCapabilityDoctorReport,
  FridayProviderCliConfig,
  FridayProviderDeploymentKind,
  FridayProviderDoctorReport,
  FridayProviderKind,
  FridayProviderProfile,
  FridayProviderRegionTag,
  FridayProviderRoutingExplainReport,
  FridayProviderRuntimeCapabilityDeclaration,
  FridayProviderValidationState,
  FridayResolvedProviderRoute,
  FridayRuntimeCapabilityId,
} from "../model/friday-provider.types.js";

import type {
  FridayCostRoutingDecision,
  FridayLlmBudgetConfig,
  FridayLlmBudgetStatus,
  FridayProviderCallReceiptLookup,
  FridayProviderNormalizedUsage,
  FridayProviderRouteStrategy,
  FridayProviderUsageSummary,
  FridayRecordUsageResult,
  FridayTaskComplexity,
} from "../model/friday-provider-cost.types.js";

// ─── Service interface ───

export interface FridayProviderService {
  listProviders(): Promise<FridayProviderProfile[]>;
  getProvider(providerId: string): Promise<FridayProviderProfile | null>;
  listAuthProfiles(providerId: string): Promise<FridayAuthProfile[]>;
  activateAuthProfile(providerId: string, profileKey: string): Promise<FridayAuthProfile>;
  doctorProvider(providerId: string): Promise<FridayProviderDoctorReport>;
  runCapabilityDoctor(options?: {
    tenantContext?: FridayProviderTenantContext;
    ownerUserId?: string;
    providerIds?: string[];
  }): Promise<FridayProviderCapabilityDoctorReport>;
  explainRouting(input: {
    requestedModel?: string;
    requestedProviderId?: string;
    tenantContext?: FridayProviderTenantContext;
    routingContext?: {
      estimatedInputTokens: number;
      complexity: FridayTaskComplexity;
      requiresNativeTools?: boolean;
      taskProfileId?: string;
      preferredRegion?: FridayProviderRegionTag;
      allowedRegions?: FridayProviderRegionTag[];
      localOnly?: boolean;
      noEgress?: boolean;
      consumerPlanAllowed?: boolean;
      requiresOfficialSDK?: boolean;
      contextWindowTokens?: number;
      dataSensitivity?: "public" | "internal" | "confidential" | "secret";
      latencyBudgetMs?: number;
      satelliteAvailable?: boolean;
      requiredCapabilities?: FridayRuntimeCapabilityId[];
    };
  }): Promise<FridayProviderRoutingExplainReport>;
  pinRoute(input: {
    userId: string;
    taskProfileId?: string;
    providerId: string;
    model: string;
    backendKind: FridayProviderBackendKind;
    reason?: string;
  }): Promise<void>;
  clearRoutePenalty(input: {
    userId: string;
    taskProfileId?: string;
    providerId: string;
    model: string;
    backendKind: FridayProviderBackendKind;
  }): Promise<boolean>;

  createProvider(input: {
    kind: FridayProviderKind;
    name: string;
    baseUrl: string;
    backendKind?: FridayProviderBackendKind;
    authMode: FridayProviderAuthMode;
    api: FridayProviderApi;
    apiKey?: string;
    supportedModels: string[];
    defaultModel?: string;
    headers?: Record<string, string>;
    cliConfig?: FridayProviderCliConfig;
    runtimeCapabilities?: FridayProviderRuntimeCapabilityDeclaration[];
    deploymentKind?: FridayProviderDeploymentKind;
    regionTag?: FridayProviderRegionTag;
    enabled?: boolean;
    validateOnSave?: boolean;
    preserveEnvRef?: boolean;
  }): Promise<FridayProviderProfile>;

  updateProvider(
    providerId: string,
    patch: {
      name?: string;
      baseUrl?: string;
      backendKind?: FridayProviderBackendKind;
      authMode?: FridayProviderAuthMode;
      api?: FridayProviderApi;
      apiKey?: string;
      supportedModels?: string[];
      defaultModel?: string;
      headers?: Record<string, string>;
      cliConfig?: FridayProviderCliConfig;
      runtimeCapabilities?: FridayProviderRuntimeCapabilityDeclaration[];
      deploymentKind?: FridayProviderDeploymentKind;
      regionTag?: FridayProviderRegionTag;
      enabled?: boolean;
      validateOnSave?: boolean;
      preserveEnvRef?: boolean;
    },
  ): Promise<FridayProviderProfile>;

  deleteProvider(providerId: string): Promise<void>;

  validateProvider(
    providerId: string,
    options?: {
      tenantContext?: FridayProviderTenantContext;
      ownerUserId?: string;
    },
  ): Promise<FridayProviderValidationState>;

  getRoutingConfig(): Promise<FridayModelRoutingConfig>;
  setRoutingConfig(
    input: FridayModelRoutingConfig,
  ): Promise<FridayModelRoutingConfig>;

  resolveRoute(
    requestedModel?: string,
    requestedProviderId?: string,
    options?: {
      tenantContext?: FridayProviderTenantContext;
      autoValidate?: boolean;
    },
  ): Promise<FridayResolvedProviderRoute>;

  runWithFallback<T>(params: {
    requestedModel?: string;
    requestedProviderId?: string;
    tenantContext?: FridayProviderTenantContext;
    routingContext?: {
      estimatedInputTokens: number;
      complexity: FridayTaskComplexity;
      requiresNativeTools?: boolean;
      taskProfileId?: string;
      preferredRegion?: FridayProviderRegionTag;
      allowedRegions?: FridayProviderRegionTag[];
      localOnly?: boolean;
      noEgress?: boolean;
      consumerPlanAllowed?: boolean;
      requiresOfficialSDK?: boolean;
      contextWindowTokens?: number;
      dataSensitivity?: "public" | "internal" | "confidential" | "secret";
      latencyBudgetMs?: number;
      satelliteAvailable?: boolean;
      requiredCapabilities?: FridayRuntimeCapabilityId[];
    };
    run: (
      route: FridayResolvedProviderRoute,
      credential: string | null,
    ) => Promise<T>;
  }): Promise<{
    result: T;
    route: FridayResolvedProviderRoute;
    attempts: FridayProviderAttempt[];
    routingDecision: FridayCostRoutingDecision;
  }>;

  recordUsage(input: {
    providerId: string;
    providerApi: FridayProviderApi;
    model: string;
    routeStrategy: FridayProviderRouteStrategy;
    taskComplexity: FridayTaskComplexity;
    usage: FridayProviderNormalizedUsage;
    costUsd: number;
    /**
     * The provider's own request identifier for this call. When present the
     * write is idempotent on it (same request-id twice ⇒ one row / one charge)
     * and a durable, tamper-detectable receipt is bound to it.
     */
    requestId?: string | null;
    /** Optional agent run/turn linkage. */
    runId?: string | null;
    turnId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<FridayRecordUsageResult>;

  /**
   * Reads back the durable receipt for a completed provider call by its
   * request-id, along with a tamper verdict (receiptValid). Returns null when
   * no request-id-bound record exists.
   */
  getCallReceipt(requestId: string): Promise<FridayProviderCallReceiptLookup | null>;

  getUsageSummary(input: {
    from: string;
    to: string;
    groupBy: "day" | "provider" | "model";
    providerId?: string;
    model?: string;
  }): Promise<FridayProviderUsageSummary>;

  getBudgetStatus(): Promise<FridayLlmBudgetStatus>;
  setBudgetConfig(input: FridayLlmBudgetConfig): Promise<FridayLlmBudgetConfig>;

  /** Starts OAuth login by generating authorization URL for a provider profile. */
  initiateOAuthLogin(input: {
    providerId: string;
    ownerUserId?: string;
  }): Promise<FridayOAuthLoginInitiation>;

  /** Completes OAuth login by exchanging code and persisting tokens. */
  completeOAuthLogin(input: {
    providerId: string;
    authorizationCode: string;
    state?: string;
    ownerUserId?: string;
  }): Promise<FridayOAuthLoginResult>;

  /** Starts provider device-code OAuth login for headless/local clients. */
  initiateOAuthDeviceAuthorization(input: {
    providerId: string;
    ownerUserId: string;
  }): Promise<FridayOAuthDeviceAuthorizationRequest>;

  /** Completes provider device-code OAuth login after the user authorizes. */
  completeOAuthDeviceAuthorization(input: {
    providerId: string;
    ownerUserId: string;
    deviceCodeId: string;
  }): Promise<FridayOAuthLoginResult>;
}

// ─── Tenant Credential Scoping (Initiative H.1) ───

export interface FridayProviderTenantContext {
  /** Hub/tenant identifier for credential isolation. */
  hubId: string;
  /** Optional channel kind to scope credentials further. */
  channelKind?: string;
  /** Optional user ID for per-user credential overrides. */
  userId?: string;
}

export interface FridayProviderCredentialScope {
  /** Tenant context for credential resolution. */
  tenantContext: FridayProviderTenantContext;
  /** Resolved credential (API key or OAuth token). */
  credential: string | null;
  /** Which provider profile the credential was resolved from. */
  providerId: string;
  /** Whether this is a tenant-specific override vs. global default. */
  isTenantOverride: boolean;
}

export interface FridayProviderCredentialResolver {
  /**
   * Resolve the credential for a given provider + tenant context.
   * Checks tenant-specific credentials first, then falls back to global.
   */
  resolve(
    providerId: string,
    tenantContext: FridayProviderTenantContext,
  ): Promise<FridayProviderCredentialScope>;

  /**
   * Store a tenant-specific credential override.
   */
  setTenantCredential(input: {
    providerId: string;
    tenantContext: FridayProviderTenantContext;
    credential: string;
  }): Promise<void>;

  /**
   * Remove a tenant-specific credential override.
   */
  removeTenantCredential(input: {
    providerId: string;
    tenantContext: FridayProviderTenantContext;
  }): Promise<void>;

  /**
   * List all tenant-specific credential scopes for a provider.
   */
  listTenantScopes(providerId: string): Promise<FridayProviderCredentialScope[]>;
}

// ─── Service dependencies ───

export interface CreateFridayProviderServiceDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  /** Optional tenant credential resolver for multi-tenant deployments. */
  credentialResolver?: FridayProviderCredentialResolver;
  /**
   * Allow routing reads to perform implicit validation/capability writes.
   * Protected gate-on profiles disable this so provider state changes only
   * happen through explicit, approval-gated setup/doctor/validation routes.
   */
  allowImplicitProviderStateMutation?: boolean;
}

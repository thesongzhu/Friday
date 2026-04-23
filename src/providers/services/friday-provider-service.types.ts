import type { FridaySqliteLayer } from "#state";

import type {
  FridayAuthProfile,
  FridayModelRoutingConfig,
  FridayOAuthLoginInitiation,
  FridayOAuthLoginResult,
  FridayProviderApi,
  FridayProviderAttempt,
  FridayProviderAuthMode,
  FridayProviderBackendKind,
  FridayProviderCliConfig,
  FridayProviderDeploymentKind,
  FridayProviderDoctorReport,
  FridayProviderKind,
  FridayProviderProfile,
  FridayProviderRegionTag,
  FridayProviderRoutingExplainReport,
  FridayProviderValidationState,
  FridayResolvedProviderRoute,
} from "../model/friday-provider.types.js";

import type {
  FridayCostRoutingDecision,
  FridayLlmBudgetConfig,
  FridayLlmBudgetStatus,
  FridayProviderNormalizedUsage,
  FridayProviderRouteStrategy,
  FridayProviderUsageSummary,
  FridayTaskComplexity,
} from "../model/friday-provider-cost.types.js";

// ─── Service interface ───

export interface FridayProviderService {
  listProviders(): Promise<FridayProviderProfile[]>;
  getProvider(providerId: string): Promise<FridayProviderProfile | null>;
  listAuthProfiles(providerId: string): Promise<FridayAuthProfile[]>;
  activateAuthProfile(providerId: string, profileKey: string): Promise<FridayAuthProfile>;
  doctorProvider(providerId: string): Promise<FridayProviderDoctorReport>;
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
    deploymentKind?: FridayProviderDeploymentKind;
    regionTag?: FridayProviderRegionTag;
    enabled?: boolean;
    validateOnSave?: boolean;
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
      deploymentKind?: FridayProviderDeploymentKind;
      regionTag?: FridayProviderRegionTag;
      enabled?: boolean;
      validateOnSave?: boolean;
    },
  ): Promise<FridayProviderProfile>;

  deleteProvider(providerId: string): Promise<void>;

  validateProvider(providerId: string): Promise<FridayProviderValidationState>;

  getRoutingConfig(): Promise<FridayModelRoutingConfig>;
  setRoutingConfig(
    input: FridayModelRoutingConfig,
  ): Promise<FridayModelRoutingConfig>;

  resolveRoute(
    requestedModel?: string,
    requestedProviderId?: string,
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
    metadata?: Record<string, unknown>;
  }): Promise<void>;

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
  }): Promise<FridayOAuthLoginInitiation>;

  /** Completes OAuth login by exchanging code and persisting tokens. */
  completeOAuthLogin(input: {
    providerId: string;
    authorizationCode: string;
    state?: string;
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
}

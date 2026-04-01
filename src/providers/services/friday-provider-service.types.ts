import type { FridaySqliteLayer } from "#state";

import type {
  FridayModelRoutingConfig,
  FridayOAuthLoginInitiation,
  FridayOAuthLoginResult,
  FridayProviderApi,
  FridayProviderAttempt,
  FridayProviderAuthMode,
  FridayProviderKind,
  FridayProviderProfile,
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

  createProvider(input: {
    kind: FridayProviderKind;
    name: string;
    baseUrl: string;
    authMode: FridayProviderAuthMode;
    api: FridayProviderApi;
    apiKey?: string;
    supportedModels: string[];
    defaultModel?: string;
    headers?: Record<string, string>;
    enabled?: boolean;
    validateOnSave?: boolean;
  }): Promise<FridayProviderProfile>;

  updateProvider(
    providerId: string,
    patch: {
      name?: string;
      baseUrl?: string;
      authMode?: FridayProviderAuthMode;
      api?: FridayProviderApi;
      apiKey?: string;
      supportedModels?: string[];
      defaultModel?: string;
      headers?: Record<string, string>;
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
    routingContext?: {
      estimatedInputTokens: number;
      complexity: FridayTaskComplexity;
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

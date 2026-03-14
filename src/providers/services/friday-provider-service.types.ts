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

// ─── Service dependencies ───

export interface CreateFridayProviderServiceDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

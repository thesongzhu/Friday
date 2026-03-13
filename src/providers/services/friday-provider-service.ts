import type {
  FridayModelRoutingConfig,
  FridayOAuthLoginInitiation,
  FridayOAuthLoginResult,
  FridayProviderAttempt,
  FridayProviderConfigJson,
  FridayProviderKeySource,
  FridayProviderProfile,
  FridayProviderValidationState,
  FridayResolvedProviderRoute,
} from "../model/friday-provider.types.js";

import type {
  FridayCostRoutingDecision,
  FridayLlmUsageRecord,
} from "../model/friday-provider-cost.types.js";

import type {
  CreateFridayProviderServiceDeps,
  FridayProviderService,
} from "./friday-provider-service.types.js";

import { createFridayProviderProfileRepository } from "../persistence/friday-provider-profile-repository.js";
import { createFridaySecretRepository } from "../persistence/friday-secret-repository.js";
import { createFridayProviderUsageRepository } from "../persistence/friday-provider-usage-repository.js";
import {
  decryptSecret,
  encryptSecret,
  getMasterKey,
} from "../security/friday-secret-crypto.js";
import { createFridayProviderValidator } from "../validation/friday-provider-validator.js";
import { createFridayProviderFallback } from "../routing/friday-provider-fallback.js";
import { createFridayProviderPricingCatalog } from "../cost/friday-provider-pricing-catalog.js";
import { createFridayProviderCostRouter } from "../cost/friday-provider-cost-router.js";
import { createFridayProviderBudgetService } from "../cost/friday-provider-budget-service.js";
import { createFridayAnthropicOAuthProvider } from "../oauth/friday-anthropic-oauth.js";
import { createFridayOAuthCredentialStore } from "../oauth/friday-oauth-credential-store.js";
import { createFridayOAuthProviderRegistry, createFridayOAuthTokenManager } from "../oauth/friday-oauth-token-manager.js";
import {
  getFridayProviderCapability,
  isFridayProviderApiSupportedForKind,
  isFridayProviderAuthModeSupportedForKind,
} from "../model/friday-provider-capabilities.js";
import { FridayDomainError } from "#errors";

import type { FridayEncryptedEnvelope } from "../security/friday-secret-crypto.js";

// ─── Constants ───

const ROUTING_SETTINGS_KEY = "llm.routing.v1";
const SECRET_SCOPE = "provider";

function secretRefKey(providerId: string): string {
  return `provider:${providerId}:apiKey`;
}

function describeRoutingReference(
  providerMap: ReadonlyMap<string, FridayProviderProfile>,
  label: string,
  providerId: string,
): string {
  const provider = providerMap.get(providerId);
  if (!provider) {
    return `${label} "${providerId}" not found`;
  }
  if (!provider.enabled) {
    return `${label} "${providerId}" is disabled`;
  }
  return `${label} "${providerId}" is enabled but was not selected`;
}

// ─── Factory ───

export function createFridayProviderService(
  deps: CreateFridayProviderServiceDeps,
): FridayProviderService {
  const profileRepo = createFridayProviderProfileRepository();
  const secretRepo = createFridaySecretRepository();
  const validator = createFridayProviderValidator();
  const fallback = createFridayProviderFallback();
  const usageRepo = createFridayProviderUsageRepository();
  const pricingCatalog = createFridayProviderPricingCatalog();
  const costRouter = createFridayProviderCostRouter({ pricingCatalog });
  const budgetService = createFridayProviderBudgetService({
    db: deps.db,
    usageRepo,
    nowIso: deps.nowIso,
  });

  // ─── OAuth subsystem ───

  const anthropicOAuth = createFridayAnthropicOAuthProvider({
    fetchImpl: deps.fetchImpl,
    nowMs: deps.nowMs,
  });
  const oauthProviderRegistry = createFridayOAuthProviderRegistry([anthropicOAuth]);
  const oauthCredentialStore = createFridayOAuthCredentialStore({
    db: deps.db,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });
  const oauthTokenManager = createFridayOAuthTokenManager({
    credentialStore: oauthCredentialStore,
    providerRegistry: oauthProviderRegistry,
    nowMs: deps.nowMs,
  });

  // ─── Key source resolution ───

  function resolveKeySource(apiKey: string | undefined): FridayProviderKeySource {
    if (!apiKey) {
      return { kind: "none" };
    }
    // $ENV_VAR pattern → env-ref
    if (apiKey.startsWith("$")) {
      return { kind: "env-ref", envVar: apiKey.slice(1) };
    }
    // Raw key → will be encrypted, ref stored
    return { kind: "secret-ref", refKey: "" }; // refKey filled after ID is known
  }

  function persistApiKey(
    providerId: string,
    apiKey: string | undefined,
    keySource: FridayProviderKeySource,
  ): FridayProviderKeySource {
    if (!apiKey || keySource.kind !== "secret-ref") {
      return keySource;
    }
    const refKey = secretRefKey(providerId);
    const masterKey = getMasterKey();
    const envelope = encryptSecret(apiKey, masterKey);
    deps.db.withWriteTransaction((db) => {
      secretRepo.upsert(db, {
        id: deps.idGenerator(),
        scope: SECRET_SCOPE,
        refKey,
        encryptedValue: JSON.stringify(envelope),
        keyId: "master-v1",
        nowIso: deps.nowIso(),
      });
    });
    return { kind: "secret-ref", refKey };
  }

  async function resolveCredential(profile: FridayProviderProfile): Promise<string | null> {
    // OAuth credential resolution — use token manager
    if (profile.config.authMode === "oauth") {
      const oauthProvider = profile.config.oauthProvider;
      if (!oauthProvider) {
        throw new FridayDomainError(
          "PROVIDER_AUTH_INVALID",
          "Provider has authMode 'oauth' but no oauthProvider configured",
          { httpStatus: 400 },
        );
      }
      const accessToken = await oauthTokenManager.getValidAccessToken({
        providerProfileId: profile.id,
        oauthProvider,
      });
      if (!accessToken) {
        throw new FridayDomainError(
          "PROVIDER_AUTH_INVALID",
          "No OAuth credentials found. Run `friday auth login anthropic` to connect.",
          { httpStatus: 401 },
        );
      }
      return accessToken;
    }

    const ks = profile.config.keySource;
    switch (ks.kind) {
      case "none":
        return null;
      case "env-ref": {
        const val = process.env[ks.envVar];
        if (!val) {
          throw new FridayDomainError(
            "PROVIDER_ENV_VAR_MISSING",
            `Environment variable '${ks.envVar}' is not set`,
            { httpStatus: 400 },
          );
        }
        return val;
      }
      case "secret-ref": {
        const secret = deps.db.withReadConnection((db) =>
          secretRepo.getByRef(db, SECRET_SCOPE, ks.refKey),
        );
        if (!secret) {
          throw new FridayDomainError(
            "PROVIDER_AUTH_INVALID",
            "Stored API key not found",
            { httpStatus: 500 },
          );
        }
        const masterKey = getMasterKey();
        const envelope = JSON.parse(secret.encryptedValue) as FridayEncryptedEnvelope;
        return decryptSecret(envelope, masterKey);
      }
    }
  }

  /**
   * Resolve the raw API key value from the patch string.
   * - `$ENV_VAR` → read from process.env
   * - Otherwise → use the literal key
   * - Empty string / undefined → null (no credential)
   */
  function resolveRawApiKey(rawApiKey: string | undefined): string | null {
    if (!rawApiKey) return null;
    if (rawApiKey.startsWith("$")) {
      const envVar = rawApiKey.slice(1);
      const val = process.env[envVar];
      if (!val) {
        throw new FridayDomainError(
          "PROVIDER_ENV_VAR_MISSING",
          `Environment variable '${envVar}' is not set`,
          { httpStatus: 400 },
        );
      }
      return val;
    }
    return rawApiKey;
  }

  function assertProviderCompatibility(input: {
    kind: FridayProviderProfile["kind"];
    api: FridayProviderConfigJson["api"];
    authMode: FridayProviderConfigJson["authMode"];
    baseUrl: string;
  }): void {
    const capability = getFridayProviderCapability(input.kind);
    if (!input.baseUrl || input.baseUrl.trim() === "") {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        "baseUrl is required and must be a non-empty string",
        { httpStatus: 400 },
      );
    }
    if (
      !isFridayProviderApiSupportedForKind(input.kind, input.api)
    ) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `Provider kind '${input.kind}' does not support api '${input.api}'. Supported apis: ${capability.supportedApis.join(", ")}`,
        { httpStatus: 400 },
      );
    }
    if (
      !isFridayProviderAuthModeSupportedForKind(input.kind, input.authMode)
    ) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `Provider kind '${input.kind}' does not support authMode '${input.authMode}'. Supported auth modes: ${capability.supportedAuthModes.join(", ")}`,
        { httpStatus: 400 },
      );
    }
  }

  // ─── Routing config persistence (hub_settings) ───

  function loadRoutingConfig(): FridayModelRoutingConfig | null {
    const row = deps.db.withReadConnection((db) =>
      db
        .prepare("SELECT value_json FROM hub_settings WHERE key = ?")
        .get(ROUTING_SETTINGS_KEY) as { value_json: string } | undefined,
    );
    if (!row) return null;
    return JSON.parse(row.value_json) as FridayModelRoutingConfig;
  }

  function saveRoutingConfig(config: FridayModelRoutingConfig): void {
    const json = JSON.stringify(config);
    const now = deps.nowIso();
    deps.db.withWriteTransaction((db) => {
      const existing = db
        .prepare("SELECT key FROM hub_settings WHERE key = ?")
        .get(ROUTING_SETTINGS_KEY) as { key: string } | undefined;

      if (existing) {
        db.prepare(
          `UPDATE hub_settings SET value_json = ?, revision = revision + 1, updated_at = ?
           WHERE key = ?`,
        ).run(json, now, ROUTING_SETTINGS_KEY);
      } else {
        db.prepare(
          `INSERT INTO hub_settings (key, value_json, revision, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?)`,
        ).run(ROUTING_SETTINGS_KEY, json, now, now);
      }
    });
  }

  function validateRoutingConfig(input: FridayModelRoutingConfig): FridayModelRoutingConfig {
    const providers = deps.db.withReadConnection((db) => profileRepo.list(db));
    const providerMap = new Map<string, FridayProviderProfile>();
    for (const provider of providers) {
      providerMap.set(provider.id, provider);
    }

    if (!input.defaultProviderId) {
      if (input.fallbackProviderIds.length > 0) {
        throw new FridayDomainError(
          "VALIDATION_ERROR",
          "fallbackProviderIds cannot be set when defaultProviderId is empty",
          { httpStatus: 400 },
        );
      }
      return input;
    }

    const defaultProvider = providerMap.get(input.defaultProviderId);
    if (!defaultProvider) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `defaultProviderId "${input.defaultProviderId}" does not match an existing provider`,
        { httpStatus: 400 },
      );
    }
    if (!defaultProvider.enabled) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `defaultProviderId "${input.defaultProviderId}" is disabled`,
        { httpStatus: 400 },
      );
    }
    if (
      input.defaultModel &&
      defaultProvider.config.supportedModels.length > 0 &&
      !defaultProvider.config.supportedModels.includes(input.defaultModel)
    ) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `defaultModel "${input.defaultModel}" is not supported by provider "${input.defaultProviderId}"`,
        { httpStatus: 400 },
      );
    }

    for (const fallbackProviderId of input.fallbackProviderIds) {
      const fallbackProvider = providerMap.get(fallbackProviderId);
      if (!fallbackProvider) {
        throw new FridayDomainError(
          "VALIDATION_ERROR",
          `fallbackProviderId "${fallbackProviderId}" does not match an existing provider`,
          { httpStatus: 400 },
        );
      }
      if (!fallbackProvider.enabled) {
        throw new FridayDomainError(
          "VALIDATION_ERROR",
          `fallbackProviderId "${fallbackProviderId}" is disabled`,
          { httpStatus: 400 },
        );
      }
    }

    return input;
  }

  function explainNoCandidates(
    routing: FridayModelRoutingConfig,
    providers: FridayProviderProfile[],
  ): string {
    const providerMap = new Map<string, FridayProviderProfile>();
    for (const provider of providers) {
      providerMap.set(provider.id, provider);
    }

    const details: string[] = [];
    if (routing.defaultProviderId) {
      details.push(
        describeRoutingReference(
          providerMap,
          "defaultProviderId",
          routing.defaultProviderId,
        ),
      );
    }
    for (const fallbackProviderId of routing.fallbackProviderIds) {
      details.push(
        describeRoutingReference(
          providerMap,
          "fallbackProviderId",
          fallbackProviderId,
        ),
      );
    }

    return details.length > 0
      ? `No enabled providers available for routing: ${details.join("; ")}`
      : "No enabled providers available for routing";
  }

  // ─── Service implementation ───

  const service: FridayProviderService = {
    async listProviders() {
      return deps.db.withReadConnection((db) => profileRepo.list(db));
    },

    async getProvider(providerId) {
      return deps.db.withReadConnection((db) =>
        profileRepo.getById(db, providerId),
      );
    },

    async createProvider(input) {
      const id = deps.idGenerator();
      const now = deps.nowIso();

      assertProviderCompatibility({
        kind: input.kind,
        api: input.api,
        authMode: input.authMode,
        baseUrl: input.baseUrl,
      });

      // OAuth mode forces keySource to none — credential comes from token manager
      let keySource: FridayProviderKeySource =
        input.authMode === "oauth"
          ? { kind: "none" }
          : resolveKeySource(input.apiKey);

      const config: FridayProviderConfigJson = {
        api: input.api,
        authMode: input.authMode,
        ...(input.authMode === "oauth" ? { oauthProvider: "anthropic" as const } : {}),
        keySource: keySource.kind === "secret-ref"
          ? { kind: "secret-ref", refKey: secretRefKey(id) }
          : keySource,
        supportedModels: input.supportedModels,
        headers: input.headers,
        validation: { status: "never" },
      };

      const profile: FridayProviderProfile = {
        id,
        kind: input.kind,
        name: input.name,
        baseUrl: input.baseUrl,
        enabled: input.enabled ?? true,
        defaultModel: input.defaultModel,
        config,
        createdAt: now,
        updatedAt: now,
      };

      // Skip validation for OAuth providers — they haven't logged in yet
      if (input.authMode === "oauth") {
        profile.config.validation = {
          status: "never",
          errorMessage: "OAuth login required",
        };
      } else if (input.validateOnSave !== false) {
        // Validate BEFORE persistence (if requested, default: true)
        try {
          // For validation, resolve credential from input directly
          let credential: string | null = null;
          if (keySource.kind === "env-ref") {
            const val = process.env[keySource.envVar];
            if (!val) {
              throw new FridayDomainError(
                "PROVIDER_ENV_VAR_MISSING",
                `Environment variable '${keySource.envVar}' is not set`,
                { httpStatus: 400 },
              );
            }
            credential = val;
          } else if (keySource.kind === "secret-ref" && input.apiKey) {
            credential = input.apiKey;
          }

          const validationState = await validator.validate({
            kind: input.kind,
            api: input.api,
            baseUrl: input.baseUrl,
            credential,
            model: input.defaultModel,
          });
          profile.config.validation = validationState;

          if (validationState.status === "failed") {
            throw new FridayDomainError(
              validationState.errorCode ?? "PROVIDER_UNKNOWN_ERROR",
              validationState.errorMessage ?? "Validation failed",
              { httpStatus: 422, details: { validation: validationState } },
            );
          }
        } catch (err) {
          if (err instanceof FridayDomainError) throw err;
          // Non-domain errors during validation: record state but do NOT persist
          profile.config.validation = {
            status: "failed",
            checkedAt: deps.nowIso(),
            errorCode: "PROVIDER_UNREACHABLE",
            errorMessage: err instanceof Error ? err.message : String(err),
          };
        }
      }

      // Persist raw key if needed (after validation passes)
      if (keySource.kind === "secret-ref") {
        keySource = persistApiKey(id, input.apiKey, keySource);
        profile.config.keySource = keySource;
      }

      deps.db.withWriteTransaction((db) => {
        profileRepo.insert(db, profile);
      });

      return profile;
    },

    async updateProvider(providerId, patch) {
      const existing = deps.db.withReadConnection((db) =>
        profileRepo.getById(db, providerId),
      );
      if (!existing) {
        throw new FridayDomainError("PROVIDER_NOT_FOUND", "Provider not found", {
          httpStatus: 404,
        });
      }

      const now = deps.nowIso();
      const oldKeySource = existing.config.keySource;
      const oldAuthMode = existing.config.authMode;
      const newAuthMode = patch.authMode ?? existing.config.authMode;
      const nextApi = patch.api ?? existing.config.api;
      const nextBaseUrl = patch.baseUrl ?? existing.baseUrl;

      assertProviderCompatibility({
        kind: existing.kind,
        api: nextApi,
        authMode: newAuthMode,
        baseUrl: nextBaseUrl,
      });

      // Handle key update
      let keySource = existing.config.keySource;
      if (newAuthMode === "oauth") {
        // OAuth mode forces keySource to none
        keySource = { kind: "none" };
      } else if (patch.apiKey !== undefined) {
        keySource = resolveKeySource(patch.apiKey);
        if (keySource.kind === "secret-ref") {
          keySource = { kind: "secret-ref", refKey: secretRefKey(providerId) };
        }
      }

      // Determine oauthProvider field
      let oauthProvider = existing.config.oauthProvider;
      if (newAuthMode === "oauth") {
        // Preserve existing or default to "anthropic"
        oauthProvider = oauthProvider ?? "anthropic";
      } else if (oldAuthMode === "oauth") {
        // Switching away from OAuth — clear OAuth credentials and oauthProvider
        oauthTokenManager.clear(providerId);
        oauthProvider = undefined;
      }

      const updatedConfig: FridayProviderConfigJson = {
        api: nextApi,
        authMode: newAuthMode,
        ...(oauthProvider != null ? { oauthProvider } : {}),
        keySource,
        supportedModels: patch.supportedModels ?? existing.config.supportedModels,
        headers: patch.headers ?? existing.config.headers,
        validation: existing.config.validation,
      };

      const updated: FridayProviderProfile = {
        ...existing,
        name: patch.name ?? existing.name,
        baseUrl: nextBaseUrl,
        enabled: patch.enabled ?? existing.enabled,
        defaultModel: patch.defaultModel ?? existing.defaultModel,
        config: updatedConfig,
        updatedAt: now,
      };

      // Auto-revalidate when authMode, api, or baseUrl changes
      const shouldValidate =
        newAuthMode !== "oauth" &&
        (patch.validateOnSave ??
        (patch.apiKey !== undefined ||
          patch.baseUrl !== undefined ||
          patch.defaultModel !== undefined ||
          patch.authMode !== undefined ||
          patch.api !== undefined));

      // Skip validation for OAuth — they need to complete login first
      if (newAuthMode === "oauth" && (patch.authMode === "oauth" || existing.config.authMode === "oauth")) {
        if (patch.authMode === "oauth" && oldAuthMode !== "oauth") {
          // Switching TO oauth — mark as needing login
          updated.config.validation = {
            status: "never",
            errorMessage: "OAuth login required",
          };
        }
      }

      // Validate BEFORE persistence — use raw patch key (not yet persisted)
      if (shouldValidate) {
        try {
          const credential = patch.apiKey !== undefined
            ? resolveRawApiKey(patch.apiKey)
            : await resolveCredential(updated);
          const validationState = await validator.validate({
            kind: updated.kind,
            api: updatedConfig.api,
            baseUrl: updated.baseUrl,
            credential,
            model: updated.defaultModel,
          });
          updated.config.validation = validationState;

          if (validationState.status === "failed") {
            throw new FridayDomainError(
              validationState.errorCode ?? "PROVIDER_UNKNOWN_ERROR",
              validationState.errorMessage ?? "Validation failed",
              { httpStatus: 422, details: { validation: validationState } },
            );
          }
        } catch (err) {
          if (err instanceof FridayDomainError) throw err;
          updated.config.validation = {
            status: "failed",
            checkedAt: deps.nowIso(),
            errorCode: "PROVIDER_UNREACHABLE",
            errorMessage: err instanceof Error ? err.message : String(err),
          };
        }
      }

      // Fix #5: delete old secret when switching away from secret-ref
      if (
        oldKeySource.kind === "secret-ref" &&
        keySource.kind !== "secret-ref"
      ) {
        deps.db.withWriteTransaction((db) => {
          secretRepo.deleteByRef(db, SECRET_SCOPE, oldKeySource.refKey);
        });
      }

      // Persist raw key if needed (after validation passes)
      if (patch.apiKey !== undefined && keySource.kind === "secret-ref") {
        keySource = persistApiKey(providerId, patch.apiKey, keySource);
        updated.config.keySource = keySource;
      }

      deps.db.withWriteTransaction((db) => {
        profileRepo.update(db, updated);
      });

      return updated;
    },

    async deleteProvider(providerId) {
      const existing = deps.db.withReadConnection((db) =>
        profileRepo.getById(db, providerId),
      );
      if (!existing) {
        throw new FridayDomainError("PROVIDER_NOT_FOUND", "Provider not found", {
          httpStatus: 404,
        });
      }

      // Clear OAuth credentials if present
      oauthTokenManager.clear(providerId);

      deps.db.withWriteTransaction((db) => {
        // Delete secret if stored
        if (existing.config.keySource.kind === "secret-ref") {
          secretRepo.deleteByRef(
            db,
            SECRET_SCOPE,
            existing.config.keySource.refKey,
          );
        }
        profileRepo.deleteById(db, providerId);
      });

      // Clean up routing config references
      const routing = loadRoutingConfig();
      if (routing) {
        let changed = false;
        if (routing.defaultProviderId === providerId) {
          routing.defaultProviderId = "";
          changed = true;
        }
        const filtered = routing.fallbackProviderIds.filter(
          (id) => id !== providerId,
        );
        if (filtered.length !== routing.fallbackProviderIds.length) {
          routing.fallbackProviderIds = filtered;
          changed = true;
        }
        if (changed) {
          saveRoutingConfig(routing);
        }
      }
    },

    async validateProvider(providerId) {
      const profile = deps.db.withReadConnection((db) =>
        profileRepo.getById(db, providerId),
      );
      if (!profile) {
        throw new FridayDomainError("PROVIDER_NOT_FOUND", "Provider not found", {
          httpStatus: 404,
        });
      }

      assertProviderCompatibility({
        kind: profile.kind,
        api: profile.config.api,
        authMode: profile.config.authMode,
        baseUrl: profile.baseUrl,
      });

      let credential: string | null = null;
      try {
        credential = await resolveCredential(profile);
      } catch (err) {
        const state: FridayProviderValidationState = {
          status: "failed",
          checkedAt: deps.nowIso(),
          errorCode:
            err instanceof FridayDomainError ? err.code : "PROVIDER_UNKNOWN_ERROR",
          errorMessage: err instanceof Error ? err.message : String(err),
        };
        profile.config.validation = state;
        deps.db.withWriteTransaction((db) => {
          profileRepo.update(db, profile);
        });
        return state;
      }

      const state = await validator.validate({
        kind: profile.kind,
        api: profile.config.api,
        baseUrl: profile.baseUrl,
        credential,
        model: profile.defaultModel,
        authMode: profile.config.authMode === "oauth" ? "oauth" : "api-key",
      });

      profile.config.validation = state;
      deps.db.withWriteTransaction((db) => {
        profileRepo.update(db, profile);
      });

      return state;
    },

    async getRoutingConfig() {
      const config = loadRoutingConfig();
      if (!config) {
        return {
          defaultProviderId: "",
          fallbackProviderIds: [],
        };
      }
      return config;
    },

    async setRoutingConfig(input) {
      const validated = validateRoutingConfig(input);
      saveRoutingConfig(validated);
      return validated;
    },

    async resolveRoute(requestedModel) {
      const routing = loadRoutingConfig();
      if (!routing || !routing.defaultProviderId) {
        throw new FridayDomainError(
          "PROVIDER_NO_ROUTING",
          "No model routing configured. Add a provider and set routing.",
          { httpStatus: 400 },
        );
      }
      const providers = deps.db.withReadConnection((db) =>
        profileRepo.list(db),
      );
      const candidates = fallback.resolveCandidates({
        routing,
        providers,
        requestedModel,
      });
      if (candidates.length === 0) {
        throw new FridayDomainError(
          "PROVIDER_NO_CANDIDATES",
          explainNoCandidates(routing, providers),
          { httpStatus: 400 },
        );
      }
      return candidates[0];
    },

    async runWithFallback<T>(params: {
      requestedModel?: string;
      routingContext?: {
        estimatedInputTokens: number;
        complexity: "simple" | "medium" | "complex";
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
    }> {
      const routing = loadRoutingConfig();
      if (!routing || !routing.defaultProviderId) {
        throw new FridayDomainError(
          "PROVIDER_NO_ROUTING",
          "No model routing configured",
          { httpStatus: 400 },
        );
      }
      const providers = deps.db.withReadConnection((db) =>
        profileRepo.list(db),
      );
      let candidates = fallback.resolveCandidates({
        routing,
        providers,
        requestedModel: params.requestedModel,
      });
      if (candidates.length === 0) {
        throw new FridayDomainError(
          "PROVIDER_NO_CANDIDATES",
          explainNoCandidates(routing, providers),
          { httpStatus: 400 },
        );
      }

      // Apply cost-aware routing when no specific model was requested
      const budget = await budgetService.getBudgetStatus();
      const complexity = params.routingContext?.complexity ?? "medium";
      const estimatedInputTokens = params.routingContext?.estimatedInputTokens ?? 0;

      const routingDecision = costRouter.planRoutes({
        candidates,
        estimatedInputTokens,
        complexity,
        budget,
      });

      // OC-002: When enforceRequestedModel is set and a specific model was
      // requested, skip cost-routing overrides to prevent model drift.
      const enforcePin = routing.enforceRequestedModel === true && !!params.requestedModel;

      if (routingDecision.strategy === "budget_local_only" && !enforcePin) {
        // Budget exceeded — filter candidates to local/free providers only
        const localOnly = candidates.filter((c) => c.provider.kind === "ollama");
        if (localOnly.length === 0) {
          throw new FridayDomainError(
            "LLM_BUDGET_EXCEEDED",
            "Monthly LLM budget exceeded and no free/local providers are available",
            { httpStatus: 429 },
          );
        }
        candidates = localOnly;
      } else if (!params.requestedModel && !enforcePin) {
        // Use cost-reordered candidates when no specific model was requested
        candidates = routingDecision.orderedCandidates;
      }

      const fallbackResult = await fallback.runWithFallback({
        candidates,
        run: async (route) => {
          const credential = await resolveCredential(route.provider);
          return params.run(route, credential);
        },
      });

      return {
        ...fallbackResult,
        routingDecision,
      };
    },

    async recordUsage(input) {
      const provider = deps.db.withReadConnection((db) =>
        profileRepo.getById(db, input.providerId),
      );
      const providerKind = provider?.kind ?? "openai";
      const now = deps.nowIso();
      const usageDay = now.slice(0, 10);
      const usageMonth = now.slice(0, 7);

      const record: FridayLlmUsageRecord = {
        id: deps.idGenerator(),
        occurredAt: now,
        usageDay,
        usageMonth,
        providerId: input.providerId,
        providerKind,
        providerApi: input.providerApi,
        model: input.model,
        routeStrategy: input.routeStrategy,
        taskComplexity: input.taskComplexity,
        inputTokens: input.usage.input,
        outputTokens: input.usage.output,
        cacheReadTokens: input.usage.cacheRead,
        cacheWriteTokens: input.usage.cacheWrite,
        totalTokens: input.usage.total,
        costUsd: input.costUsd,
        currency: "USD",
        metadata: input.metadata ?? {},
        createdAt: now,
      };

      deps.db.withWriteTransaction((db) => {
        usageRepo.insert(db, record);
      });
    },

    async getUsageSummary(input) {
      return deps.db.withReadConnection((db) =>
        usageRepo.querySummary(db, input),
      );
    },

    async getBudgetStatus() {
      return budgetService.getBudgetStatus();
    },

    async setBudgetConfig(input) {
      return budgetService.setBudgetConfig(input);
    },

    // ─── OAuth methods ───

    async initiateOAuthLogin(input): Promise<FridayOAuthLoginInitiation> {
      const profile = deps.db.withReadConnection((db) =>
        profileRepo.getById(db, input.providerId),
      );
      if (!profile) {
        throw new FridayDomainError("PROVIDER_NOT_FOUND", "Provider not found", {
          httpStatus: 404,
        });
      }
      if (profile.config.authMode !== "oauth") {
        throw new FridayDomainError(
          "PROVIDER_AUTH_INVALID",
          `Provider '${profile.name}' does not use OAuth authentication`,
          { httpStatus: 400 },
        );
      }

      const oauthProvider = profile.config.oauthProvider ?? "anthropic";
      const adapter = oauthProviderRegistry.get(oauthProvider);
      if (!adapter) {
        throw new FridayDomainError(
          "PROVIDER_AUTH_INVALID",
          `No OAuth adapter registered for '${oauthProvider}'`,
          { httpStatus: 400 },
        );
      }

      const authRequest = await adapter.initiateAuthorization();

      return {
        ...authRequest,
        providerId: profile.id,
        oauthProvider,
      };
    },

    async completeOAuthLogin(input): Promise<FridayOAuthLoginResult> {
      const profile = deps.db.withReadConnection((db) =>
        profileRepo.getById(db, input.providerId),
      );
      if (!profile) {
        throw new FridayDomainError("PROVIDER_NOT_FOUND", "Provider not found", {
          httpStatus: 404,
        });
      }
      if (profile.config.authMode !== "oauth") {
        throw new FridayDomainError(
          "PROVIDER_AUTH_INVALID",
          `Provider '${profile.name}' does not use OAuth authentication`,
          { httpStatus: 400 },
        );
      }

      const oauthProvider = profile.config.oauthProvider ?? "anthropic";
      const adapter = oauthProviderRegistry.get(oauthProvider);
      if (!adapter) {
        throw new FridayDomainError(
          "PROVIDER_AUTH_INVALID",
          `No OAuth adapter registered for '${oauthProvider}'`,
          { httpStatus: 400 },
        );
      }

      const tokenSet = await adapter.exchangeAuthorizationCode({
        authorizationCode: input.authorizationCode,
        state: input.state,
      });

      oauthTokenManager.saveTokenSet({
        providerProfileId: profile.id,
        oauthProvider,
        tokenSet,
      });

      // Post-exchange validation: verify the access token works
      try {
        const validationState = await validator.validate({
          kind: profile.kind,
          api: profile.config.api,
          baseUrl: profile.baseUrl,
          credential: tokenSet.accessToken,
          model: profile.defaultModel,
          authMode: "oauth",
        });
        profile.config.validation = validationState;
      } catch {
        // Don't block the flow — just warn via validation state
        profile.config.validation = {
          status: "failed",
          checkedAt: deps.nowIso(),
          errorCode: "PROVIDER_UNREACHABLE",
          errorMessage: "Post-login validation failed; token may still be valid",
        };
      }

      deps.db.withWriteTransaction((db) => {
        profileRepo.update(db, profile);
      });

      return {
        providerId: profile.id,
        oauthProvider,
        connected: true,
        expiresAt: tokenSet.expiresAt,
        tokenType: tokenSet.tokenType,
        scope: tokenSet.scope,
      };
    },
  };

  return service;
}

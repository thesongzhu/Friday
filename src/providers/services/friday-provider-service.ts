import type {
  FridayAuthProfile,
  FridayModelRoutingConfig,
  FridayOAuthLoginInitiation,
  FridayOAuthLoginResult,
  FridayProviderAttempt,
  FridayProviderBackendKind,
  FridayProviderCliConfig,
  FridayProviderConfigJson,
  FridayProviderDoctorReport,
  FridayProviderHealthStatus,
  FridayProviderKeySource,
  FridayProviderProfile,
  FridayProviderRegionTag,
  FridayProviderRoutingDecisionTrace,
  FridayProviderRoutingExplainCandidate,
  FridayProviderRoutingExplainReport,
  FridayProviderRoutingReasonCode,
  FridayProviderRoutingSelection,
  FridayProviderValidationState,
  FridayResolvedProviderRoute,
} from "../model/friday-provider.types.js";
import {
  normalizeFridayModelRoutingConfig,
  normalizeFridayProviderSupportedModels,
} from "../model/friday-provider.types.js";

import type {
  FridayCostRoutingDecision,
  FridayLlmUsageRecord,
} from "../model/friday-provider-cost.types.js";

import type {
  CreateFridayProviderServiceDeps,
  FridayProviderService,
  FridayProviderTenantContext,
} from "./friday-provider-service.types.js";

import { safeJsonParse } from "#utilities";
import { createFridayPreferenceFactRepository } from "../../learning/persistence/friday-preference-fact-repository.js";
import { createFridayAuthProfileRepository } from "../persistence/friday-auth-profile-repository.js";
import { createFridayProviderProfileRepository } from "../persistence/friday-provider-profile-repository.js";
import { createFridaySecretRepository } from "../persistence/friday-secret-repository.js";
import { createFridayProviderUsageRepository } from "../persistence/friday-provider-usage-repository.js";
import {
  probeFridayCliSession,
} from "../cli/friday-provider-cli-backend.js";
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
  getFridayProviderAuthModesForBackend,
  getFridayProviderCapability,
  isFridayProviderApiSupportedForKind,
  isFridayProviderAuthModeSupportedForKindAndBackend,
  isFridayProviderBackendKindSupportedForKind,
} from "../model/friday-provider-capabilities.js";
import { FridayDomainError } from "#errors";
import { getFridayProviderPreset } from "../model/friday-provider-catalog.js";
import { parseFridaySecretInput, resolveFridaySecretInput } from "../../security/friday-secret-ref.js";

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

function assertRequestedProviderAvailable(
  providers: FridayProviderProfile[],
  requestedProviderId: string,
): FridayProviderProfile {
  const provider = providers.find((candidate) => candidate.id === requestedProviderId);
  if (!provider) {
    throw new FridayDomainError("PROVIDER_NOT_FOUND", `Provider "${requestedProviderId}" not found`, {
      httpStatus: 404,
    });
  }
  if (!provider.enabled) {
    throw new FridayDomainError("PROVIDER_DISABLED", `Provider "${requestedProviderId}" is disabled`, {
      httpStatus: 400,
    });
  }
  return provider;
}

function explainPinnedProviderNoCandidates(
  provider: FridayProviderProfile,
  requestedModel?: string,
): string {
  if (requestedModel && requestedModel.trim().length > 0) {
    return `Provider "${provider.id}" does not support requested model "${requestedModel}".`;
  }
  return `Provider "${provider.id}" does not have any eligible models for routing.`;
}

function filterCandidatesToPinnedProvider(
  candidates: FridayResolvedProviderRoute[],
  pinnedProvider?: FridayProviderProfile,
): FridayResolvedProviderRoute[] {
  if (!pinnedProvider) {
    return candidates;
  }
  return candidates.filter((candidate) => candidate.provider.id === pinnedProvider.id);
}

interface FridayHistoricalRunRouteRow {
  status: string;
  actual_execution_json: string | null;
  task_profile_json: string | null;
  metadata_json: string | null;
  session_user_id: string | null;
  session_account_id: string | null;
}

interface FridayHistoricalRouteStats {
  successCount: number;
  failureCount: number;
  sampleCount: number;
}

interface FridayPreparedRoutingCandidate {
  candidate: FridayResolvedProviderRoute;
  originalRank: number;
  finalRank: number;
  eligible: boolean;
  ineligibilityReasons: string[];
  pinned: boolean;
  routePenalty: number;
  history?: FridayHistoricalRouteStats;
  baseRankScore: number;
  historyScore: number;
  patternScore: number;
  lessonScore: number;
  routePenaltyScore: number;
  pinBonus: number;
  finalScore: number;
  matchedLessonIds: string[];
  matchedPatternIds: string[];
}

interface FridayRoutePreferenceState {
  penalties: Map<string, number>;
  pinnedRoute?:
    | {
        providerId: string;
        model: string;
        backendKind: FridayProviderBackendKind;
      }
    | undefined;
}

function normalizeRoutePenaltySegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

const ROUTE_HISTORY_SAMPLE_LIMIT = 250;

// ─── Factory ───

export function createFridayProviderService(
  deps: CreateFridayProviderServiceDeps,
): FridayProviderService {
  const profileRepo = createFridayProviderProfileRepository();
  const authProfileRepo = createFridayAuthProfileRepository();
  const secretRepo = createFridaySecretRepository();
  const validator = createFridayProviderValidator();
  const fallback = createFridayProviderFallback();
  const usageRepo = createFridayProviderUsageRepository();
  const preferenceFactRepo = createFridayPreferenceFactRepository();
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

  function resolveKeySourceInput(apiKey: string | undefined): {
    keySource: FridayProviderKeySource;
    inlineSecret: string | null;
  } {
    if (!apiKey) {
      return { keySource: { kind: "none" }, inlineSecret: null };
    }
    const parsed = parseFridaySecretInput(apiKey, {
      secretRefPrefixes: ["secret://"],
    });
    switch (parsed.kind) {
      case "env-ref":
        return {
          keySource: { kind: "env-ref", envVar: parsed.envVar },
          inlineSecret: null,
        };
      case "secret-ref":
        return {
          keySource: { kind: "secret-ref", refKey: parsed.refKey },
          inlineSecret: null,
        };
      case "file-ref":
        return {
          keySource: { kind: "file-ref", path: parsed.path },
          inlineSecret: null,
        };
      case "command-ref":
        return {
          keySource: { kind: "command-ref", command: parsed.command },
          inlineSecret: null,
        };
      case "inline":
        return {
          keySource: { kind: "secret-ref", refKey: "" },
          inlineSecret: parsed.value,
        };
    }
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

  async function resolveCredential(
    profile: FridayProviderProfile,
    tenantContext?: FridayProviderTenantContext,
  ): Promise<string | null> {
    if (tenantContext && deps.credentialResolver) {
      const scoped = await deps.credentialResolver.resolve(profile.id, tenantContext);
      if (scoped.credential) {
        return scoped.credential;
      }
    }
    const authProfile = deps.db.withReadConnection((db) =>
      authProfileRepo.getActiveByProviderProfileId(db, profile.id),
    );
    const effectiveAuthMode = authProfile?.authMode ?? profile.config.authMode;
    const effectiveOauthProvider = authProfile?.oauthProvider ?? profile.config.oauthProvider;
    const effectiveKeySource = authProfile?.keySource ?? profile.config.keySource;

    // OAuth credential resolution — use token manager
    if (effectiveAuthMode === "oauth") {
      const oauthProvider = effectiveOauthProvider;
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

    if (effectiveAuthMode === "external-session") {
      return null;
    }

    if (effectiveKeySource.kind === "none") {
      return null;
    }

    const resolved = await resolveFridaySecretInput(effectiveKeySource, {
      env: process.env,
      allowCommandRefs: true,
      readSecretRef: async (refKey) => {
        const secret = deps.db.withReadConnection((db) =>
          secretRepo.getByRef(db, SECRET_SCOPE, refKey),
        );
        if (!secret) {
          return null;
        }
        const masterKey = getMasterKey();
        const envelope = JSON.parse(secret.encryptedValue) as FridayEncryptedEnvelope;
        return decryptSecret(envelope, masterKey);
      },
    });

    if (!resolved.ok) {
      const blocker = resolved.blocker;
      const errorCode = blocker.code === "SECRET_ENV_VAR_MISSING"
        ? "PROVIDER_ENV_VAR_MISSING"
        : blocker.code === "SECRET_REF_NOT_FOUND"
          ? "PROVIDER_AUTH_INVALID"
          : blocker.code === "SECRET_FILE_PATH_INVALID" || blocker.code === "SECRET_FILE_READ_FAILED" || blocker.code === "SECRET_FILE_EMPTY"
            ? "PROVIDER_FILE_REF_INVALID"
            : blocker.code === "SECRET_COMMAND_DISABLED" || blocker.code === "SECRET_COMMAND_FAILED" || blocker.code === "SECRET_COMMAND_EMPTY"
              ? "PROVIDER_COMMAND_REF_INVALID"
              : "PROVIDER_AUTH_INVALID";
      throw new FridayDomainError(errorCode, blocker.message, {
        httpStatus: errorCode === "PROVIDER_AUTH_INVALID" ? 500 : 400,
        details: blocker.details,
      });
    }

    return resolved.value;
  }

  async function prepareRouteCredential(
    profile: FridayProviderProfile,
    tenantContext?: FridayProviderTenantContext,
  ): Promise<{
    ready: boolean;
    credential?: string;
  }> {
    if (tenantContext && deps.credentialResolver) {
      const scoped = await deps.credentialResolver.resolve(profile.id, tenantContext);
      if (scoped.credential) {
        return {
          ready: true,
          credential: scoped.credential,
        };
      }
    }

    const authProfile = deps.db.withReadConnection((db) =>
      authProfileRepo.getActiveByProviderProfileId(db, profile.id),
    );
    const effectiveAuthMode = authProfile?.authMode ?? profile.config.authMode;
    const effectiveOauthProvider = authProfile?.oauthProvider ?? profile.config.oauthProvider;

    if (effectiveAuthMode !== "oauth") {
      return { ready: true };
    }
    if (!effectiveOauthProvider) {
      return { ready: false };
    }

    const accessToken = await oauthTokenManager.getValidAccessToken({
      providerProfileId: profile.id,
      oauthProvider: effectiveOauthProvider,
    });

    if (!accessToken) {
      return { ready: false };
    }

    return {
      ready: true,
      credential: accessToken,
    };
  }

  function buildRouteHistoryKey(
    providerId: string,
    model: string,
    backendKind: FridayProviderBackendKind,
  ): string {
    return `${providerId}::${model}::${backendKind}`;
  }

  function buildRoutePenaltyKey(input: {
    taskProfileId?: string;
    providerId: string;
    model: string;
    backendKind: FridayProviderBackendKind;
  }): string {
    return [
      "route_penalty",
      normalizeRoutePenaltySegment(input.taskProfileId ?? "global"),
      normalizeRoutePenaltySegment(input.providerId),
      normalizeRoutePenaltySegment(input.backendKind),
      normalizeRoutePenaltySegment(input.model),
    ].join(":");
  }

  function buildRoutePinKey(taskProfileId?: string): string {
    return [
      "route_pin",
      normalizeRoutePenaltySegment(taskProfileId ?? "global"),
    ].join(":");
  }

  function loadHistoricalRouteStats(input: {
    candidates: FridayResolvedProviderRoute[];
    taskProfileId?: string;
    tenantContext?: FridayProviderTenantContext;
  }): Map<string, FridayHistoricalRouteStats> {
    if (!input.taskProfileId || !hasHistoricalRoutingScope(input.tenantContext)) {
      return new Map();
    }

    const candidateKeys = new Set(
      input.candidates.map((candidate) =>
        buildRouteHistoryKey(
          candidate.provider.id,
          candidate.model,
          candidate.provider.config.backendKind ?? "http",
        )
      ),
    );

    const rows = deps.db.withReadConnection((db) =>
      db.prepare(
        `SELECT r.status,
                r.actual_execution_json,
                r.task_profile_json,
                r.metadata_json,
                s.user_id AS session_user_id,
                s.account_id AS session_account_id
         FROM friday_agent_runs r
         LEFT JOIN sessions s ON s.session_key = r.session_key
         WHERE r.status IN ('completed', 'failed')
           AND r.actual_execution_json IS NOT NULL
         ORDER BY r.created_at DESC
         LIMIT ?`,
      ).all(ROUTE_HISTORY_SAMPLE_LIMIT) as FridayHistoricalRunRouteRow[],
    );

    const stats = new Map<string, FridayHistoricalRouteStats>();

    for (const row of rows) {
      if (!historicalRouteRowMatchesScope(row, input.tenantContext)) {
        continue;
      }

      const taskProfile = safeJsonParse<Record<string, unknown>>(row.task_profile_json);
      if (taskProfile?.id !== input.taskProfileId) {
        continue;
      }

      const actualExecution = safeJsonParse<Record<string, unknown>>(row.actual_execution_json);
      const actualProviderId = typeof actualExecution?.actualProviderId === "string"
        ? actualExecution.actualProviderId
        : undefined;
      const actualModel = typeof actualExecution?.actualModel === "string"
        ? actualExecution.actualModel
        : undefined;
      const backendKind = actualExecution?.backendKind === "cli"
        || actualExecution?.backendKind === "sdk"
        || actualExecution?.backendKind === "http"
        ? actualExecution.backendKind
        : "http";

      if (!actualProviderId || !actualModel) {
        continue;
      }

      const key = buildRouteHistoryKey(actualProviderId, actualModel, backendKind);
      if (!candidateKeys.has(key)) {
        continue;
      }

      const current = stats.get(key) ?? {
        successCount: 0,
        failureCount: 0,
        sampleCount: 0,
      };
      current.sampleCount += 1;
      if (row.status === "completed") {
        current.successCount += 1;
      } else if (row.status === "failed") {
        current.failureCount += 1;
      }
      stats.set(key, current);
    }

    return stats;
  }

  function normalizeScopeSegment(value?: string | null): string | undefined {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
  }

  function hasHistoricalRoutingScope(tenantContext?: FridayProviderTenantContext): boolean {
    return Boolean(
      normalizeScopeSegment(tenantContext?.userId)
      || normalizeScopeSegment(tenantContext?.hubId),
    );
  }

  function getHistoricalRowPrincipalId(row: FridayHistoricalRunRouteRow): string | undefined {
    const metadata = safeJsonParse<Record<string, unknown>>(row.metadata_json);
    const apiRequest = metadata?.apiRequest;
    if (!apiRequest || typeof apiRequest !== "object") {
      return undefined;
    }
    const principalId = (apiRequest as { principalId?: unknown }).principalId;
    return typeof principalId === "string" ? normalizeScopeSegment(principalId) : undefined;
  }

  function historicalRouteRowMatchesScope(
    row: FridayHistoricalRunRouteRow,
    tenantContext?: FridayProviderTenantContext,
  ): boolean {
    const userId = normalizeScopeSegment(tenantContext?.userId);
    const hubId = normalizeScopeSegment(tenantContext?.hubId);
    const rowUserId = normalizeScopeSegment(row.session_user_id);
    const rowPrincipalId = getHistoricalRowPrincipalId(row);

    if (userId) {
      return rowUserId === userId || rowPrincipalId === userId;
    }

    if (hubId) {
      return normalizeScopeSegment(row.session_account_id) === hubId;
    }

    return false;
  }

  function loadRoutePreferenceState(input: {
    candidates: FridayResolvedProviderRoute[];
    taskProfileId?: string;
    userId?: string;
  }): FridayRoutePreferenceState {
    const penalties = new Map<string, number>();
    let pinnedRoute: FridayRoutePreferenceState["pinnedRoute"];

    if (!input.userId) {
      return { penalties, pinnedRoute };
    }

    const preferenceRows = deps.db.withReadConnection((db) =>
      db.prepare(
        `SELECT key, confidence, value_json
         FROM preference_facts
         WHERE user_id = ?
           AND (key LIKE 'route_penalty:%' OR key LIKE 'route_pin:%')
         ORDER BY updated_at DESC
         LIMIT 200`,
      ).all(input.userId) as Array<{ key: string; confidence: number; value_json: string }>,
    );

    const directPin = preferenceRows.find((row) => row.key === buildRoutePinKey(input.taskProfileId));
    const globalPin = preferenceRows.find((row) => row.key === buildRoutePinKey());
    const resolvedPin = directPin ?? globalPin;
    if (resolvedPin) {
      const pinValue = safeJsonParse<Record<string, unknown>>(resolvedPin.value_json);
      if (
        typeof pinValue?.providerId === "string"
        && typeof pinValue?.model === "string"
        && (pinValue.backendKind === "http" || pinValue.backendKind === "cli" || pinValue.backendKind === "sdk")
      ) {
        pinnedRoute = {
          providerId: pinValue.providerId,
          model: pinValue.model,
          backendKind: pinValue.backendKind,
        };
      }
    }

    for (const candidate of input.candidates) {
      const backendKind = candidate.provider.config.backendKind ?? "http";
      const directKey = buildRoutePenaltyKey({
        taskProfileId: input.taskProfileId,
        providerId: candidate.provider.id,
        model: candidate.model,
        backendKind,
      });
      const globalKey = buildRoutePenaltyKey({
        providerId: candidate.provider.id,
        model: candidate.model,
        backendKind,
      });
      const directPenalty = preferenceRows.find((row) => row.key === directKey)?.confidence ?? 0;
      const globalPenalty = preferenceRows.find((row) => row.key === globalKey)?.confidence ?? 0;
      const penalty = Math.max(directPenalty, globalPenalty * 0.75);
      if (penalty > 0) {
        penalties.set(buildRouteHistoryKey(candidate.provider.id, candidate.model, backendKind), penalty);
      }
    }

    return { penalties, pinnedRoute };
  }

  function getCandidateRegionTag(candidate: FridayResolvedProviderRoute): FridayProviderRegionTag {
    return candidate.provider.config.regionTag ?? "global";
  }

  function isLocalCandidate(candidate: FridayResolvedProviderRoute): boolean {
    const deploymentKind = candidate.provider.config.deploymentKind;
    return deploymentKind === "local" || deploymentKind === "self-hosted" || candidate.provider.kind === "ollama";
  }

  function isSelectionMatch(
    candidate: FridayResolvedProviderRoute,
    selection?: FridayProviderRoutingSelection,
  ): boolean {
    if (!selection) {
      return false;
    }
    return (
      candidate.provider.id === selection.providerId
      && candidate.provider.kind === selection.providerKind
      && candidate.model === selection.model
      && (candidate.provider.config.backendKind ?? "http") === selection.backendKind
    );
  }

  function toSelection(candidate?: FridayResolvedProviderRoute): FridayProviderRoutingSelection | undefined {
    if (!candidate) {
      return undefined;
    }
    return {
      providerId: candidate.provider.id,
      providerKind: candidate.provider.kind,
      model: candidate.model,
      backendKind: candidate.provider.config.backendKind ?? "http",
    };
  }

  function buildRouteDecisionTrace(input: {
    candidates: FridayResolvedProviderRoute[];
    requestedProviderId?: string;
    requestedModel?: string;
    userId?: string;
    tenantContext?: FridayProviderTenantContext;
    taskProfileId?: string;
    routingContext?: {
      requiresNativeTools?: boolean;
      preferredRegion?: FridayProviderRegionTag;
      allowedRegions?: FridayProviderRegionTag[];
      localOnly?: boolean;
      noEgress?: boolean;
      consumerPlanAllowed?: boolean;
      requiresOfficialSDK?: boolean;
    };
    budgetLocalOnly?: boolean;
  }): {
    orderedCandidates: FridayResolvedProviderRoute[];
    explain: FridayProviderRoutingExplainCandidate[];
    selected?: FridayProviderRoutingExplainCandidate;
    trace: FridayProviderRoutingDecisionTrace;
  } {
    const historyStats = loadHistoricalRouteStats({
      candidates: input.candidates,
      taskProfileId: input.taskProfileId,
      tenantContext: input.tenantContext,
    });
    const preferenceState = loadRoutePreferenceState({
      candidates: input.candidates,
      taskProfileId: input.taskProfileId,
      userId: input.userId,
    });

    const initialStates: FridayPreparedRoutingCandidate[] = input.candidates.map((candidate, index) => {
      const backendKind = candidate.provider.config.backendKind ?? "http";
      const key = buildRouteHistoryKey(candidate.provider.id, candidate.model, backendKind);
      const history = historyStats.get(key);
      const routePenalty = preferenceState.penalties.get(key) ?? 0;
      const pinned = Boolean(
        preferenceState.pinnedRoute
        && preferenceState.pinnedRoute.providerId === candidate.provider.id
        && preferenceState.pinnedRoute.model === candidate.model
        && preferenceState.pinnedRoute.backendKind === backendKind
      );
      const ineligibilityReasons: string[] = [];
      if (input.budgetLocalOnly && !isLocalCandidate(candidate)) {
        ineligibilityReasons.push("budget_local_only");
      }
      if (input.routingContext?.requiresNativeTools && backendKind === "cli") {
        ineligibilityReasons.push("requires_native_tools");
      }
      if (input.routingContext?.localOnly && !isLocalCandidate(candidate)) {
        ineligibilityReasons.push("local_only_required");
      }
      if (input.routingContext?.noEgress && !isLocalCandidate(candidate)) {
        ineligibilityReasons.push("no_egress_required");
      }
      if (
        Array.isArray(input.routingContext?.allowedRegions)
        && input.routingContext.allowedRegions.length > 0
        && !input.routingContext.allowedRegions.includes(getCandidateRegionTag(candidate))
      ) {
        ineligibilityReasons.push("region_not_allowed");
      }
      if (input.routingContext?.requiresOfficialSDK && backendKind !== "sdk") {
        ineligibilityReasons.push("official_sdk_required");
      }
      if (input.routingContext?.consumerPlanAllowed === false && backendKind === "cli") {
        ineligibilityReasons.push("consumer_plan_not_allowed");
      }

      const baseRankScore = input.candidates.length - index;
      const successRate = (history?.successCount ?? 0) / Math.max(history?.sampleCount ?? 1, 1);
      const failureRate = (history?.failureCount ?? 0) / Math.max(history?.sampleCount ?? 1, 1);
      const historyScore = history
        ? successRate * 4 - failureRate * 2 + Math.min(history.sampleCount, 5) * 0.25
        : 0;
      const routePenaltyScore = routePenalty > 0 ? routePenalty * -1.5 : 0;
      const pinBonus = pinned ? 50 : 0;

      return {
        candidate,
        originalRank: index + 1,
        finalRank: index + 1,
        eligible: ineligibilityReasons.length === 0,
        ineligibilityReasons,
        pinned,
        routePenalty,
        history,
        baseRankScore,
        historyScore,
        patternScore: 0,
        lessonScore: 0,
        routePenaltyScore,
        pinBonus,
        finalScore: baseRankScore + historyScore + routePenaltyScore + pinBonus,
        matchedLessonIds: [],
        matchedPatternIds: [],
      };
    });

    const preferredRegion = input.routingContext?.preferredRegion;
    if (preferredRegion) {
      const hasPreferredEligible = initialStates.some((state) =>
        state.eligible && getCandidateRegionTag(state.candidate) === preferredRegion,
      );
      if (hasPreferredEligible) {
        for (const state of initialStates) {
          if (state.eligible && getCandidateRegionTag(state.candidate) !== preferredRegion) {
            state.eligible = false;
            state.ineligibilityReasons.push("preferred_region_mismatch");
          }
        }
      }
    }

    const eligibleBeforeLearning = initialStates.filter((state) => state.eligible);
    const selectedBeforeLearning = toSelection(eligibleBeforeLearning[0]?.candidate);
    const sortedEligible = [...eligibleBeforeLearning].sort((left, right) => {
      if (right.finalScore !== left.finalScore) {
        return right.finalScore - left.finalScore;
      }
      return left.originalRank - right.originalRank;
    });
    const selectedAfterLearning = toSelection(sortedEligible[0]?.candidate);

    const eligibleOrderChanged =
      sortedEligible.map((state) => state.originalRank).join(",")
      !== eligibleBeforeLearning.map((state) => state.originalRank).join(",");
    const selectedAdjusted = JSON.stringify(selectedBeforeLearning) !== JSON.stringify(selectedAfterLearning);
    const learningSignalsPresent = historyStats.size > 0 || preferenceState.penalties.size > 0 || preferenceState.pinnedRoute != null;
    const learningAdjusted = eligibleOrderChanged || selectedAdjusted;

    const finalStates = [
      ...sortedEligible,
      ...initialStates.filter((state) => !state.eligible),
    ].map((state, index) => ({
      ...state,
      finalRank: index + 1,
    }));

    let reasonCode: FridayProviderRoutingReasonCode = "configured";
    if (input.budgetLocalOnly) {
      reasonCode = "budget_local_only";
    } else if (preferenceState.pinnedRoute) {
      reasonCode = "operator_override";
    } else if (preferenceState.penalties.size > 0) {
      reasonCode = "operator_penalty";
    } else if (historyStats.size > 0) {
      reasonCode = "historical_bias";
    } else if (input.requestedProviderId) {
      reasonCode = "requested_provider";
    } else if (input.requestedModel) {
      reasonCode = "requested_model";
    } else if (initialStates.some((state) => state.ineligibilityReasons.length > 0)) {
      reasonCode = "backend_capability_gating";
    }

    const reasonText = (() => {
      switch (reasonCode) {
        case "budget_local_only":
          return "Budget policy restricted routing to local/self-hosted providers.";
        case "operator_override":
          return `Operator pinned ${selectedAfterLearning?.providerId ?? "the selected route"} for task profile ${input.taskProfileId ?? "global"}.`;
        case "operator_penalty":
          return "Operator route penalties influenced candidate scoring.";
        case "historical_bias":
          return "Historical route outcomes influenced candidate scoring.";
        case "requested_provider":
          return "Routing was constrained to the explicitly requested provider.";
        case "requested_model":
          return "Routing was constrained to providers that support the requested model.";
        case "backend_capability_gating":
          return "Capability and policy gating excluded one or more candidates from routing.";
        default:
          return "Routing followed the configured route order.";
      }
    })();

    const explain = finalStates.map((state) => {
      const successRate = state.history
        ? state.history.successCount / Math.max(state.history.sampleCount, 1)
        : undefined;
      const failureRate = state.history
        ? state.history.failureCount / Math.max(state.history.sampleCount, 1)
        : undefined;
      return {
        providerId: state.candidate.provider.id,
        providerKind: state.candidate.provider.kind,
        model: state.candidate.model,
        backendKind: state.candidate.provider.config.backendKind ?? "http",
        originalRank: state.originalRank,
        finalRank: state.finalRank,
        selected: isSelectionMatch(state.candidate, selectedAfterLearning),
        eligible: state.eligible,
        ineligibilityReasons: [...state.ineligibilityReasons],
        pinned: state.pinned,
        ...(state.routePenalty > 0 ? { routePenalty: state.routePenalty } : {}),
        ...(successRate !== undefined ? { historicalSuccessRate: successRate } : {}),
        ...(failureRate !== undefined ? { historicalFailureRate: failureRate } : {}),
        ...(state.history ? { sampleCount: state.history.sampleCount } : {}),
        baseRankScore: state.baseRankScore,
        historyScore: state.historyScore,
        patternScore: state.patternScore,
        lessonScore: state.lessonScore,
        routePenaltyScore: state.routePenaltyScore,
        pinBonus: state.pinBonus,
        finalScore: state.finalScore,
        ...(state.history
          ? {
              historyStats: {
                sampleCount: state.history.sampleCount,
                successRate: successRate ?? 0,
                failureRate: failureRate ?? 0,
              },
            }
          : {}),
        matchedLessonIds: [...state.matchedLessonIds],
        matchedPatternIds: [...state.matchedPatternIds],
      } satisfies FridayProviderRoutingExplainCandidate;
    });

    const selected = explain.find((candidate) => candidate.selected);
    const orderedCandidates = sortedEligible.map((state) => state.candidate);

    return {
      orderedCandidates,
      explain,
      selected,
      trace: {
        ...(input.taskProfileId ? { taskProfileId: input.taskProfileId } : {}),
        requiresNativeTools: input.routingContext?.requiresNativeTools === true,
        learningAdjusted,
        learningSignalsPresent,
        orderingAdjusted: eligibleOrderChanged,
        selectedAdjusted,
        reasonCode,
        reasonText,
        historyWindow: {
          sampleLimit: ROUTE_HISTORY_SAMPLE_LIMIT,
        },
        ...(selectedBeforeLearning ? { selectedBeforeLearning } : {}),
        ...(selectedAfterLearning ? { selectedAfterLearning } : {}),
        candidateScores: explain,
      },
    };
  }

  function buildDefaultAuthProfile(
    profile: FridayProviderProfile,
    existing?: FridayAuthProfile | null,
    options?: {
      isActive?: boolean;
      metadata?: Record<string, unknown>;
    },
  ): FridayAuthProfile {
    const now = deps.nowIso();
    return {
      id: existing?.id ?? `auth-profile:${profile.id}:default`,
      providerProfileId: profile.id,
      providerKind: profile.kind,
      profileKey: "default",
      label: `${profile.name} Default`,
      authMode: profile.config.authMode,
      keySource: profile.config.keySource,
      oauthProvider: profile.config.oauthProvider,
      isActive: options?.isActive ?? existing?.isActive ?? true,
      metadata: {
        source: "provider-config-sync",
        ...(existing?.metadata ?? {}),
        ...(options?.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  function syncDefaultAuthProfile(
    db: Parameters<typeof authProfileRepo.upsert>[0],
    profile: FridayProviderProfile,
  ): void {
    const active = authProfileRepo.getActiveByProviderProfileId(db, profile.id);
    const existing = authProfileRepo.getByProviderProfileIdAndKey(
      db,
      profile.id,
      "default",
    );
    authProfileRepo.upsert(
      db,
      buildDefaultAuthProfile(profile, existing, {
        isActive: active == null || active.profileKey === "default",
      }),
    );
  }

  function normalizeProviderConfig(profile: FridayProviderProfile): FridayProviderProfile {
    const preset = getFridayProviderPreset(profile.kind, profile.baseUrl);
    const backendKind = profile.config.backendKind ?? preset.backendKind;
    const config: FridayProviderConfigJson = {
      ...profile.config,
      api: profile.config.api ?? preset.api,
      authMode: profile.config.authMode ?? preset.authMode,
      backendKind,
      deploymentKind: profile.config.deploymentKind ?? preset.deploymentKind,
      regionTag: profile.config.regionTag ?? preset.regionTag,
      keySource: profile.config.keySource ?? { kind: "none" },
      supportedModels: normalizeFridayProviderSupportedModels(profile.config.supportedModels),
      httpConfig: backendKind === "http"
        ? {
            headersPolicy: profile.config.httpConfig?.headersPolicy ?? "custom",
            timeoutMs: profile.config.httpConfig?.timeoutMs,
          }
        : undefined,
      cliConfig: backendKind === "cli"
        ? profile.config.cliConfig
        : undefined,
      sdkConfig: backendKind === "sdk"
        ? profile.config.sdkConfig
        : undefined,
    };
    return {
      ...profile,
      config,
    };
  }

  async function validateCliProvider(
    profile: FridayProviderProfile,
  ): Promise<FridayProviderValidationState> {
    const cliConfig = profile.config.cliConfig;
    if (!cliConfig) {
      return {
        status: "failed",
        checkedAt: deps.nowIso(),
        errorCode: "PROVIDER_AUTH_INVALID",
        errorMessage: "CLI backend requires cliConfig",
      };
    }
    const session = await probeFridayCliSession({
      cliConfig,
      nowIso: deps.nowIso,
    });
    return {
      status: session.status === "healthy" ? "ok" : "failed",
      checkedAt: session.checkedAt,
      errorCode: session.status === "healthy" ? undefined : "PROVIDER_AUTH_INVALID",
      errorMessage: session.message,
    };
  }

  async function buildDoctorReport(
    profile: FridayProviderProfile,
  ): Promise<FridayProviderDoctorReport> {
    const normalized = normalizeProviderConfig(profile);
    const activeProfile = deps.db.withReadConnection((db) =>
      authProfileRepo.getActiveByProviderProfileId(db, normalized.id),
    );
    const reasons: string[] = [];
    let backendHealth: FridayProviderHealthStatus = "healthy";
    let authHealth: FridayProviderHealthStatus = "healthy";
    let cliSession: FridayProviderDoctorReport["cliSession"];
    const validationState = normalized.config.validation;

    if (!normalized.enabled) {
      backendHealth = "degraded";
      reasons.push("provider_disabled");
    }

    if (normalized.config.backendKind === "cli") {
      if (!normalized.config.cliConfig) {
        backendHealth = "missing";
        authHealth = "missing";
        reasons.push("cli_config_missing");
      } else {
        cliSession = await probeFridayCliSession({
          cliConfig: normalized.config.cliConfig,
          nowIso: deps.nowIso,
        });
        backendHealth = cliSession.status;
        authHealth = cliSession.status;
        if (cliSession.status !== "healthy") {
          reasons.push("cli_session_unhealthy");
        }
      }
    } else if (normalized.config.authMode === "oauth") {
      authHealth = "status_unknown";
      reasons.push("oauth_requires_token_manager_check");
    } else if (normalized.config.keySource.kind === "none" && normalized.config.authMode !== "none") {
      authHealth = "missing";
      reasons.push("credential_missing");
    }

    if (validationState?.status === "failed") {
      switch (validationState.errorCode) {
        case "PROVIDER_ENV_VAR_MISSING":
          authHealth = "missing";
          break;
        case "PROVIDER_AUTH_INVALID":
        case "PROVIDER_PAYMENT_REQUIRED":
          if (authHealth === "healthy" || authHealth === "status_unknown") {
            authHealth = "degraded";
          }
          break;
        case "PROVIDER_UNREACHABLE":
        case "PROVIDER_MODEL_UNAVAILABLE":
        case "PROVIDER_UNKNOWN_ERROR":
        default:
          if (backendHealth === "healthy") {
            backendHealth = "degraded";
          }
          break;
      }
      reasons.push("validation_failed");
    }

    if ((normalized.config.supportedModels?.length ?? 0) === 0) {
      reasons.push("no_supported_models");
    }

    return {
      providerId: normalized.id,
      providerKind: normalized.kind,
      backendKind: normalized.config.backendKind ?? "http",
      authMode: normalized.config.authMode,
      checkedAt: deps.nowIso(),
      backendHealth,
      authHealth,
      routingEligible: normalized.enabled && reasons.length === 0,
      reasons,
      activeProfileKey: activeProfile?.profileKey,
      cliSession,
    };
  }

  async function resolveRawApiKeyAsync(rawApiKey: string | undefined): Promise<string | null> {
    if (!rawApiKey) return null;
    const parsed = parseFridaySecretInput(rawApiKey, {
      secretRefPrefixes: ["secret://"],
    });
    const resolved = await resolveFridaySecretInput(parsed, {
      env: process.env,
      allowCommandRefs: true,
      readSecretRef: async (refKey) => {
        const secret = deps.db.withReadConnection((db) =>
          secretRepo.getByRef(db, SECRET_SCOPE, refKey),
        );
        if (!secret) {
          return null;
        }
        const masterKey = getMasterKey();
        const envelope = JSON.parse(secret.encryptedValue) as FridayEncryptedEnvelope;
        return decryptSecret(envelope, masterKey);
      },
    });
    if (!resolved.ok) {
      const blocker = resolved.blocker;
      const errorCode = blocker.code === "SECRET_ENV_VAR_MISSING"
        ? "PROVIDER_ENV_VAR_MISSING"
        : blocker.code === "SECRET_REF_NOT_FOUND"
          ? "PROVIDER_AUTH_INVALID"
          : blocker.code === "SECRET_FILE_PATH_INVALID" || blocker.code === "SECRET_FILE_READ_FAILED" || blocker.code === "SECRET_FILE_EMPTY"
            ? "PROVIDER_FILE_REF_INVALID"
            : blocker.code === "SECRET_COMMAND_DISABLED" || blocker.code === "SECRET_COMMAND_FAILED" || blocker.code === "SECRET_COMMAND_EMPTY"
              ? "PROVIDER_COMMAND_REF_INVALID"
              : "PROVIDER_AUTH_INVALID";
      throw new FridayDomainError(errorCode, blocker.message, {
        httpStatus: errorCode === "PROVIDER_AUTH_INVALID" ? 500 : 400,
        details: blocker.details,
      });
    }
    return resolved.value;
  }

  function assertProviderCompatibility(input: {
    kind: FridayProviderProfile["kind"];
    api: FridayProviderConfigJson["api"];
    authMode: FridayProviderConfigJson["authMode"];
    backendKind?: FridayProviderBackendKind;
    cliConfig?: FridayProviderCliConfig;
    baseUrl: string;
  }): void {
    const capability = getFridayProviderCapability(input.kind);
    const backendKind = input.backendKind ?? "http";
    if (!isFridayProviderBackendKindSupportedForKind(input.kind, backendKind)) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `Provider kind '${input.kind}' does not support backendKind '${backendKind}'. Supported backends: ${capability.supportedBackendKinds.join(", ")}`,
        { httpStatus: 400 },
      );
    }
    if (backendKind === "http" && (!input.baseUrl || input.baseUrl.trim() === "")) {
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
      !isFridayProviderAuthModeSupportedForKindAndBackend(input.kind, backendKind, input.authMode)
    ) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `Provider kind '${input.kind}' does not support authMode '${input.authMode}' for backend '${backendKind}'. Supported auth modes: ${getFridayProviderAuthModesForBackend(input.kind, backendKind).join(", ")}`,
        { httpStatus: 400 },
      );
    }
    if (backendKind === "cli" && !input.cliConfig) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        "cliConfig is required when backendKind is 'cli'",
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
    const parsed = safeJsonParse<FridayModelRoutingConfig>(row.value_json);
    return parsed ? normalizeFridayModelRoutingConfig(parsed) : null;
  }

  function saveRoutingConfig(config: FridayModelRoutingConfig): void {
    const normalized = normalizeFridayModelRoutingConfig(config);
    const json = JSON.stringify(normalized);
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
    const normalizedInput = normalizeFridayModelRoutingConfig(input);
    const providers = deps.db.withReadConnection((db) => profileRepo.list(db));
    const providerMap = new Map<string, FridayProviderProfile>();
    for (const provider of providers) {
      providerMap.set(provider.id, provider);
    }

    if (!normalizedInput.defaultProviderId) {
      if (normalizedInput.fallbackProviderIds.length > 0) {
        throw new FridayDomainError(
          "VALIDATION_ERROR",
          "fallbackProviderIds cannot be set when defaultProviderId is empty",
          { httpStatus: 400 },
        );
      }
      return normalizedInput;
    }

    const defaultProvider = providerMap.get(normalizedInput.defaultProviderId);
    if (!defaultProvider) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `defaultProviderId "${normalizedInput.defaultProviderId}" does not match an existing provider`,
        { httpStatus: 400 },
      );
    }
    if (!defaultProvider.enabled) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `defaultProviderId "${normalizedInput.defaultProviderId}" is disabled`,
        { httpStatus: 400 },
      );
    }
    const supportedModels = normalizeFridayProviderSupportedModels(defaultProvider.config.supportedModels);
    if (
      normalizedInput.defaultModel &&
      supportedModels.length > 0 &&
      !supportedModels.includes(normalizedInput.defaultModel)
    ) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `defaultModel "${normalizedInput.defaultModel}" is not supported by provider "${normalizedInput.defaultProviderId}"`,
        { httpStatus: 400 },
      );
    }

    for (const fallbackProviderId of normalizedInput.fallbackProviderIds) {
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

    return normalizedInput;
  }

  function explainNoCandidates(
    routing: FridayModelRoutingConfig,
    providers: FridayProviderProfile[],
  ): string {
    const normalizedRouting = normalizeFridayModelRoutingConfig(routing);
    const providerMap = new Map<string, FridayProviderProfile>();
    for (const provider of providers) {
      providerMap.set(provider.id, provider);
    }

    const details: string[] = [];
    if (normalizedRouting.defaultProviderId) {
      details.push(
        describeRoutingReference(
          providerMap,
          "defaultProviderId",
          normalizedRouting.defaultProviderId,
        ),
      );
    }
    for (const fallbackProviderId of normalizedRouting.fallbackProviderIds) {
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

    async listAuthProfiles(providerId) {
      const existing = deps.db.withReadConnection((db) =>
        profileRepo.getById(db, providerId),
      );
      if (!existing) {
        throw new FridayDomainError("PROVIDER_NOT_FOUND", "Provider not found", {
          httpStatus: 404,
        });
      }
      return deps.db.withReadConnection((db) =>
        authProfileRepo.listByProviderProfileId(db, providerId),
      );
    },

    async activateAuthProfile(providerId, profileKey) {
      const existing = deps.db.withReadConnection((db) =>
        profileRepo.getById(db, providerId),
      );
      if (!existing) {
        throw new FridayDomainError("PROVIDER_NOT_FOUND", "Provider not found", {
          httpStatus: 404,
        });
      }
      const profile = deps.db.withReadConnection((db) =>
        authProfileRepo.getByProviderProfileIdAndKey(db, providerId, profileKey),
      );
      if (!profile) {
        throw new FridayDomainError("PROVIDER_AUTH_INVALID", `Auth profile "${profileKey}" not found`, {
          httpStatus: 404,
        });
      }
      deps.db.withWriteTransaction((db) => {
        for (const candidate of authProfileRepo.listByProviderProfileId(db, providerId)) {
          authProfileRepo.upsert(db, {
            ...candidate,
            isActive: candidate.profileKey === profileKey,
            updatedAt: deps.nowIso(),
          });
        }
      });
      return deps.db.withReadConnection((db) =>
        authProfileRepo.getActiveByProviderProfileId(db, providerId),
      ) ?? profile;
    },

    async doctorProvider(providerId) {
      const profile = deps.db.withReadConnection((db) =>
        profileRepo.getById(db, providerId),
      );
      if (!profile) {
        throw new FridayDomainError("PROVIDER_NOT_FOUND", "Provider not found", {
          httpStatus: 404,
        });
      }
      return await buildDoctorReport(profile);
    },

    async explainRouting(input): Promise<FridayProviderRoutingExplainReport> {
      const routing = loadRoutingConfig();
      if (!routing || !routing.defaultProviderId) {
        throw new FridayDomainError(
          "PROVIDER_NO_ROUTING",
          "No model routing configured. Register a provider and set routing before asking for a route explanation.",
          { httpStatus: 400 },
        );
      }
      const providers = deps.db.withReadConnection((db) => profileRepo.list(db));
      const pinnedProvider = input.requestedProviderId
        ? assertRequestedProviderAvailable(providers, input.requestedProviderId)
        : undefined;
      let candidates = fallback.resolveCandidates({
        routing: pinnedProvider
          ? {
              defaultProviderId: pinnedProvider.id,
              fallbackProviderIds: [],
            }
          : routing,
        providers,
        requestedModel: input.requestedModel,
      });
      candidates = filterCandidatesToPinnedProvider(candidates, pinnedProvider);
      const requiresNativeTools = input.routingContext?.requiresNativeTools === true;
      if (candidates.length === 0) {
        throw new FridayDomainError(
          "PROVIDER_NO_CANDIDATES",
          pinnedProvider
            ? explainPinnedProviderNoCandidates(pinnedProvider, input.requestedModel)
            : explainNoCandidates(routing, providers),
          { httpStatus: 400 },
        );
      }

      const budget = await budgetService.getBudgetStatus();
      const estimatedInputTokens = input.routingContext?.estimatedInputTokens ?? 0;
      const complexity = input.routingContext?.complexity ?? "medium";
      const routingDecision = costRouter.planRoutes({
        candidates,
        estimatedInputTokens,
        complexity,
        budget,
      });
      const enforcePin = routing.enforceRequestedModel === true && !!input.requestedModel;
      const baseCandidates = (!input.requestedModel && !enforcePin && !pinnedProvider)
        ? routingDecision.orderedCandidates
        : candidates;
      const traceBuilder = buildRouteDecisionTrace({
        candidates: baseCandidates,
        requestedProviderId: input.requestedProviderId,
        requestedModel: input.requestedModel,
        userId: input.tenantContext?.userId,
        tenantContext: input.tenantContext,
        taskProfileId: input.routingContext?.taskProfileId,
        routingContext: input.routingContext,
        budgetLocalOnly: routingDecision.strategy === "budget_local_only" && !enforcePin && !pinnedProvider,
      });
      if (traceBuilder.orderedCandidates.length === 0) {
        throw new FridayDomainError(
          "PROVIDER_NO_CANDIDATES",
          requiresNativeTools
            ? "No candidates remain because this task requires Friday native tools and the available CLI backends are text-only or policy-gated."
            : pinnedProvider
              ? explainPinnedProviderNoCandidates(pinnedProvider, input.requestedModel)
              : explainNoCandidates(routing, providers),
          { httpStatus: 400 },
        );
      }

      return {
        ...(input.requestedProviderId ? { requestedProviderId: input.requestedProviderId } : {}),
        ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
        ...(input.routingContext?.taskProfileId ? { taskProfileId: input.routingContext.taskProfileId } : {}),
        requiresNativeTools,
        ...(traceBuilder.trace.selectedBeforeLearning ? { selectedBeforeLearning: traceBuilder.trace.selectedBeforeLearning } : {}),
        ...(traceBuilder.trace.selectedAfterLearning ? { selectedAfterLearning: traceBuilder.trace.selectedAfterLearning } : {}),
        ...(traceBuilder.selected ? { selected: traceBuilder.selected } : {}),
        candidates: traceBuilder.explain,
        candidateScores: traceBuilder.explain,
        learningAdjusted: traceBuilder.trace.learningAdjusted,
        learningSignalsPresent: traceBuilder.trace.learningSignalsPresent,
        orderingAdjusted: traceBuilder.trace.orderingAdjusted,
        selectedAdjusted: traceBuilder.trace.selectedAdjusted,
        reasonCode: traceBuilder.trace.reasonCode,
        reason: traceBuilder.trace.reasonText,
        reasonText: traceBuilder.trace.reasonText,
        historyWindow: traceBuilder.trace.historyWindow,
      };
    },

    async pinRoute(input) {
      deps.db.withWriteTransaction((db) => {
        preferenceFactRepo.upsert(db, {
          factId: deps.idGenerator(),
          userId: input.userId,
          key: buildRoutePinKey(input.taskProfileId),
          value: {
            providerId: input.providerId,
            model: input.model,
            backendKind: input.backendKind,
            ...(input.reason ? { reason: input.reason } : {}),
          },
          confidence: 1,
          evidenceCountDelta: 1,
          lastConfirmedAt: deps.nowIso(),
          sourceEventId: `operator:route-pin:${deps.idGenerator()}`,
          nowIso: deps.nowIso(),
        });
      });
    },

    async clearRoutePenalty(input) {
      return deps.db.withWriteTransaction((db) =>
        preferenceFactRepo.deleteByUserAndKey(
          db,
          input.userId,
          buildRoutePenaltyKey(input),
        ),
      );
    },

    async createProvider(input) {
      const id = deps.idGenerator();
      const now = deps.nowIso();
      const preset = getFridayProviderPreset(input.kind, input.baseUrl);
      const backendKind = input.backendKind ?? preset.backendKind;

      assertProviderCompatibility({
        kind: input.kind,
        api: input.api,
        authMode: input.authMode,
        backendKind,
        cliConfig: input.cliConfig,
        baseUrl: input.baseUrl,
      });

      const keyInput =
        input.authMode === "oauth" || input.authMode === "external-session"
          ? { keySource: { kind: "none" } satisfies FridayProviderKeySource, inlineSecret: null }
          : resolveKeySourceInput(input.apiKey);
      let keySource = keyInput.keySource;

      const config: FridayProviderConfigJson = {
        api: input.api,
        authMode: input.authMode,
        backendKind,
        deploymentKind: input.deploymentKind ?? preset.deploymentKind,
        regionTag: input.regionTag ?? preset.regionTag,
        ...(input.authMode === "oauth" ? { oauthProvider: "anthropic" as const } : {}),
        keySource: keySource.kind === "secret-ref" && keyInput.inlineSecret !== null
          ? { kind: "secret-ref", refKey: secretRefKey(id) }
          : keySource,
        supportedModels: normalizeFridayProviderSupportedModels(input.supportedModels),
        headers: input.headers,
        httpConfig: backendKind === "http" ? { headersPolicy: "custom" } : undefined,
        cliConfig: backendKind === "cli" ? input.cliConfig : undefined,
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

      // Skip validation for OAuth providers — they haven't logged in yet.
      // Also skip for local keyless providers (e.g. Ollama with authMode "none")
      // since connectivity depends on the user's local setup.
      if (input.authMode === "oauth") {
        profile.config.validation = {
          status: "never",
          errorMessage: "OAuth login required",
        };
      } else if (input.authMode === "external-session" || backendKind === "cli") {
        profile.config.validation = input.validateOnSave === false
          ? { status: "never" }
          : await validateCliProvider(profile);
      } else if (input.authMode === "none" && input.validateOnSave === undefined) {
        profile.config.validation = {
          status: "never",
        };
      } else if (input.validateOnSave !== false) {
        // Validate BEFORE persistence (if requested, default: true)
        try {
          // For validation, resolve credential from input directly
          const credential = input.apiKey !== undefined
            ? await resolveRawApiKeyAsync(input.apiKey)
            : null;

          const validationState = await validator.validate({
            kind: input.kind,
            api: input.api,
            baseUrl: input.baseUrl,
            credential,
            model: input.defaultModel,
            authMode: input.authMode,
          });
          profile.config.validation = validationState;

          if (validationState.status === "failed") {
            // Allow PAYMENT_REQUIRED through — key is valid, just no credits.
            // The provider is saved with a warning so the user can add credits later.
            if (validationState.errorCode === "PROVIDER_PAYMENT_REQUIRED") {
              console.warn("[friday][provider-service] Provider saved with payment-required warning — add credits to activate");
            } else {
              throw new FridayDomainError(
                validationState.errorCode ?? "PROVIDER_UNKNOWN_ERROR",
                validationState.errorMessage ?? "Validation failed",
                { httpStatus: 422, details: { validation: validationState } },
              );
            }
          }
        } catch (err) {
          if (err instanceof FridayDomainError) throw err;
          // Non-domain errors during validation: record state, log warning, but still persist
          console.warn("[friday][provider-service] Provider validation failed (non-domain):", err instanceof Error ? err.message : String(err));
          profile.config.validation = {
            status: "failed",
            checkedAt: deps.nowIso(),
            errorCode: "PROVIDER_UNREACHABLE",
            errorMessage: err instanceof Error ? err.message : String(err),
          };
        }
      }

      // Persist raw key if needed (after validation passes)
      if (keySource.kind === "secret-ref" && keyInput.inlineSecret !== null) {
        keySource = persistApiKey(id, keyInput.inlineSecret, keySource);
        profile.config.keySource = keySource;
      }

      deps.db.withWriteTransaction((db) => {
        profileRepo.insert(db, normalizeProviderConfig(profile));
        syncDefaultAuthProfile(db, normalizeProviderConfig(profile));
      });

      return normalizeProviderConfig(profile);
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
      const nextBackendKind = patch.backendKind ?? existing.config.backendKind ?? "http";

      assertProviderCompatibility({
        kind: existing.kind,
        api: nextApi,
        authMode: newAuthMode,
        backendKind: nextBackendKind,
        cliConfig: patch.cliConfig ?? existing.config.cliConfig,
        baseUrl: nextBaseUrl,
      });

      // Handle key update
      let keySource = existing.config.keySource;
      let inlineSecret: string | null = null;
      if (newAuthMode === "oauth" || newAuthMode === "external-session") {
        // OAuth mode forces keySource to none
        keySource = { kind: "none" };
      } else if (patch.apiKey !== undefined) {
        const nextKeyInput = resolveKeySourceInput(patch.apiKey);
        keySource = nextKeyInput.keySource;
        inlineSecret = nextKeyInput.inlineSecret;
        if (keySource.kind === "secret-ref" && inlineSecret !== null) {
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
        backendKind: nextBackendKind,
        deploymentKind: patch.deploymentKind ?? existing.config.deploymentKind,
        regionTag: patch.regionTag ?? existing.config.regionTag,
        ...(oauthProvider != null ? { oauthProvider } : {}),
        keySource,
        supportedModels: normalizeFridayProviderSupportedModels(
          patch.supportedModels ?? existing.config.supportedModels,
        ),
        headers: patch.headers ?? existing.config.headers,
        httpConfig: nextBackendKind === "http"
          ? existing.config.httpConfig ?? { headersPolicy: "custom" }
          : undefined,
        cliConfig: nextBackendKind === "cli"
          ? patch.cliConfig ?? existing.config.cliConfig
          : undefined,
        sdkConfig: nextBackendKind === "sdk"
          ? existing.config.sdkConfig
          : undefined,
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
          patch.api !== undefined ||
          patch.backendKind !== undefined ||
          patch.cliConfig !== undefined));

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

      if (newAuthMode === "external-session" || nextBackendKind === "cli") {
        updated.config.validation = patch.validateOnSave === false
          ? { status: "never" }
          : await validateCliProvider(updated);
      }

      // Validate BEFORE persistence — use raw patch key (not yet persisted)
      if (shouldValidate && nextBackendKind !== "cli") {
        try {
          const credential = patch.apiKey !== undefined
            ? await resolveRawApiKeyAsync(patch.apiKey)
            : await resolveCredential(updated);
          const validationState = await validator.validate({
            kind: updated.kind,
            api: updatedConfig.api,
            baseUrl: updated.baseUrl,
            credential,
            model: updated.defaultModel,
            authMode: updatedConfig.authMode,
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
      if (patch.apiKey !== undefined && keySource.kind === "secret-ref" && inlineSecret !== null) {
        keySource = persistApiKey(providerId, inlineSecret, keySource);
        updated.config.keySource = keySource;
      }

      deps.db.withWriteTransaction((db) => {
        profileRepo.update(db, normalizeProviderConfig(updated));
        syncDefaultAuthProfile(db, normalizeProviderConfig(updated));
      });

      return normalizeProviderConfig(updated);
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
        authProfileRepo.deleteByProviderProfileId(db, providerId);
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
      if ((profile.config.backendKind ?? "http") === "cli") {
        const state = await validateCliProvider(profile);
        profile.config.validation = state;
        deps.db.withWriteTransaction((db) => {
          profileRepo.update(db, normalizeProviderConfig(profile));
          syncDefaultAuthProfile(db, normalizeProviderConfig(profile));
        });
        return state;
      }
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
        authMode: profile.config.authMode,
      });

      profile.config.validation = state;
      deps.db.withWriteTransaction((db) => {
        profileRepo.update(db, normalizeProviderConfig(profile));
        syncDefaultAuthProfile(db, normalizeProviderConfig(profile));
      });

      return state;
    },

    async getRoutingConfig() {
      const config = loadRoutingConfig();
      if (!config) {
        return normalizeFridayModelRoutingConfig(null);
      }
      return normalizeFridayModelRoutingConfig(config);
    },

    async setRoutingConfig(input) {
      const validated = validateRoutingConfig(input);
      saveRoutingConfig(validated);
      return normalizeFridayModelRoutingConfig(validated);
    },

    async resolveRoute(requestedModel, requestedProviderId) {
      const routing = loadRoutingConfig();
      if (!routing || !routing.defaultProviderId) {
        throw new FridayDomainError(
          "PROVIDER_NO_ROUTING",
          "No model routing configured. Register a provider via POST /v1/providers (e.g. Ollama on localhost:11434) and then set routing via PUT /v1/model-routing, or use the setup wizard at /setup.",
          { httpStatus: 400 },
        );
      }
      const providers = deps.db.withReadConnection((db) =>
        profileRepo.list(db),
      );
      const pinnedProvider = requestedProviderId
        ? assertRequestedProviderAvailable(providers, requestedProviderId)
        : undefined;
      const candidates = filterCandidatesToPinnedProvider(
        fallback.resolveCandidates({
        routing: pinnedProvider
          ? {
              defaultProviderId: pinnedProvider.id,
              fallbackProviderIds: [],
            }
          : routing,
        providers,
        requestedModel,
        }),
        pinnedProvider,
      );
      if (candidates.length === 0) {
        throw new FridayDomainError(
          "PROVIDER_NO_CANDIDATES",
          pinnedProvider
            ? explainPinnedProviderNoCandidates(pinnedProvider, requestedModel)
            : explainNoCandidates(routing, providers),
          { httpStatus: 400 },
        );
      }
      return candidates[0];
    },

    async runWithFallback<T>(params: {
      requestedModel?: string;
      requestedProviderId?: string;
      tenantContext?: FridayProviderTenantContext;
      routingContext?: {
        estimatedInputTokens: number;
        complexity: "simple" | "medium" | "complex";
        requiresNativeTools?: boolean;
        taskProfileId?: string;
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
          "No model routing configured. Register a provider and set routing via PUT /v1/model-routing, or use the setup wizard at /setup.",
          { httpStatus: 400 },
        );
      }
      const providers = deps.db.withReadConnection((db) =>
        profileRepo.list(db),
      );
      const pinnedProvider = params.requestedProviderId
        ? assertRequestedProviderAvailable(providers, params.requestedProviderId)
        : undefined;
      const prefetchedCredentials = new Map<string, string>();
      let candidates = fallback.resolveCandidates({
        routing: pinnedProvider
          ? {
              defaultProviderId: pinnedProvider.id,
              fallbackProviderIds: [],
            }
          : routing,
        providers,
        requestedModel: params.requestedModel,
      });
      candidates = filterCandidatesToPinnedProvider(candidates, pinnedProvider);
      if (!pinnedProvider) {
        const routableCandidates = await Promise.all(
          candidates.map(async (candidate) => {
            const prepared = await prepareRouteCredential(
              candidate.provider,
              params.tenantContext,
            );
            if (!prepared.ready) {
              return null;
            }
            if (prepared.credential) {
              prefetchedCredentials.set(candidate.provider.id, prepared.credential);
            }
            return candidate;
          }),
        );
        candidates = routableCandidates.filter(
          (candidate): candidate is FridayResolvedProviderRoute => candidate !== null,
        );
      }
      if (candidates.length === 0) {
        throw new FridayDomainError(
          "PROVIDER_NO_CANDIDATES",
          pinnedProvider
            ? explainPinnedProviderNoCandidates(pinnedProvider, params.requestedModel)
            : explainNoCandidates(routing, providers),
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

      if (routingDecision.strategy === "budget_local_only" && !enforcePin && !pinnedProvider) {
        const hasLocalCandidate = candidates.some((candidate) => isLocalCandidate(candidate));
        if (!hasLocalCandidate) {
          throw new FridayDomainError(
            "LLM_BUDGET_EXCEEDED",
            "Monthly LLM budget exceeded and no free/local providers are available",
            { httpStatus: 429 },
          );
        }
      }

      const traceBuilder = buildRouteDecisionTrace({
        candidates: (!params.requestedModel && !enforcePin && !pinnedProvider)
          ? routingDecision.orderedCandidates
          : candidates,
        requestedProviderId: params.requestedProviderId,
        requestedModel: params.requestedModel,
        userId: params.tenantContext?.userId,
        tenantContext: params.tenantContext,
        taskProfileId: params.routingContext?.taskProfileId,
        routingContext: params.routingContext,
        budgetLocalOnly: routingDecision.strategy === "budget_local_only" && !enforcePin && !pinnedProvider,
      });

      candidates = traceBuilder.orderedCandidates;
      if (candidates.length === 0) {
        throw new FridayDomainError(
          "PROVIDER_NO_CANDIDATES",
          params.routingContext?.requiresNativeTools
            ? "No model providers can satisfy this task because the remaining candidates are text-only CLI backends or policy-gated for this run."
            : pinnedProvider
              ? explainPinnedProviderNoCandidates(pinnedProvider, params.requestedModel)
              : explainNoCandidates(routing, providers),
          { httpStatus: 400 },
        );
      }

      const fallbackResult = await fallback.runWithFallback({
        candidates,
        run: async (route) => {
          const credential = prefetchedCredentials.has(route.provider.id)
            ? prefetchedCredentials.get(route.provider.id) ?? null
            : await resolveCredential(route.provider, params.tenantContext);
          return params.run(route, credential);
        },
      });

      return {
        ...fallbackResult,
        routingDecision: {
          ...routingDecision,
          orderedCandidates: candidates,
          reason: traceBuilder.trace.reasonText,
          reasonCode: traceBuilder.trace.reasonCode,
          learningAdjusted: traceBuilder.trace.learningAdjusted,
          learningSignalsPresent: traceBuilder.trace.learningSignalsPresent,
          orderingAdjusted: traceBuilder.trace.orderingAdjusted,
          selectedAdjusted: traceBuilder.trace.selectedAdjusted,
          routeDecisionTrace: traceBuilder.trace,
        },
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
      } catch (err) {
        // Don't block the flow — just warn via validation state
        console.warn("[friday][provider-service] post-login validation failed:", err instanceof Error ? err.message : String(err));
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

  (
    service as FridayProviderService & {
      getProviderFallbackState: (
        providerId: string,
      ) => {
        circuitState: "closed" | "cooldown" | "unknown";
        lastFailureAt?: string;
        cooldownRemainingMs?: number;
      };
    }
  ).getProviderFallbackState = (providerId) => {
    return fallback.describeProvider?.(providerId) ?? {
      circuitState: "unknown",
    };
  };

  return service;
}

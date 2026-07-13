import type {
  FridayAuthProfile,
  FridayModelRoutingConfig,
  FridayOAuthDeviceAuthorizationRequest,
  FridayOAuthLoginInitiation,
  FridayOAuthLoginResult,
  FridayProviderAttempt,
  FridayProviderBackendKind,
  FridayProviderCapabilityDoctorProbeResult,
  FridayProviderCapabilityDoctorReport,
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
  FridayProviderRuntimeCapabilityDeclaration,
  FridayProviderValidationErrorCode,
  FridayProviderValidationState,
  FridayResolvedProviderRoute,
  FridayRuntimeCapabilityId,
} from "../model/friday-provider.types.js";
import {
  FRIDAY_GLOBAL_OAUTH_OWNER_USER_ID,
  isFridayAnthropicBearerAuthMode,
  normalizeFridayModelRoutingConfig,
  normalizeFridayProviderSupportedModels,
} from "../model/friday-provider.types.js";

import type {
  FridayCostRoutingDecision,
  FridayLlmUsageRecord,
  FridayProviderCallReceiptLookup,
} from "../model/friday-provider-cost.types.js";
import {
  buildProviderCallReceipt,
  projectProviderCallReceipt,
  verifyProviderCallReceipt,
} from "../cost/friday-provider-call-receipt.js";

import type {
  CreateFridayProviderServiceDeps,
  FridayProviderService,
  FridayProviderTenantContext,
} from "./friday-provider-service.types.js";

import { safeJsonParse } from "#utilities";
import { createFridayPreferenceFactRepository } from "../../learning/persistence/friday-preference-fact-repository.js";
import { createFridayAuthProfileRepository } from "../persistence/friday-auth-profile-repository.js";
import { createFridayProviderProfileRepository } from "../persistence/friday-provider-profile-repository.js";
import { createFridaySecretRepository, fridaySecretAadContext } from "../persistence/friday-secret-repository.js";
import { createFridayProviderUsageRepository } from "../persistence/friday-provider-usage-repository.js";
import {
  assertAllowedCliBinaryPath,
  probeFridayCliSession,
  runFridayCliBackendTextCompletion,
} from "../cli/friday-provider-cli-backend.js";
import {
  decryptSecretWithMigration,
  encryptSecret,
  getStrictMasterKey,
} from "../security/friday-secret-crypto.js";
import { createFridayEphemeralSecretHandleRegistry } from "../security/friday-secret-handle-registry.js";
import { createFridayProviderValidator } from "../validation/friday-provider-validator.js";
import { createFridayProviderFallback } from "../routing/friday-provider-fallback.js";
import { createFridayProviderPricingCatalog } from "../cost/friday-provider-pricing-catalog.js";
import { createFridayProviderCostRouter } from "../cost/friday-provider-cost-router.js";
import { createFridayProviderBudgetService } from "../cost/friday-provider-budget-service.js";
import {
  createFridayAnthropicOAuthProvider,
  FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE,
} from "../oauth/friday-anthropic-oauth.js";
import { createFridayOpenAICodexOAuthProvider } from "../oauth/friday-openai-codex-oauth.js";
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
import {
  filterFridayProviderRoutesByRequiredCapabilities,
  inferFridayModelSupportsEmbedding,
  inferFridayModelSupportsVision,
} from "../model/friday-runtime-capabilities.js";

import type { FridayEncryptedEnvelope } from "../security/friday-secret-crypto.js";

// ─── Constants ───

const ROUTING_SETTINGS_KEY = "llm.routing.v1";
const SECRET_SCOPE = "provider";
const CAPABILITY_DOCTOR_TIMEOUT_MS = 15_000;
const CAPABILITY_DOCTOR_TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l3sY5wAAAABJRU5ErkJggg==";
const CAPABILITY_DOCTOR_TINY_PNG_DATA_URL =
  `data:image/png;base64,${CAPABILITY_DOCTOR_TINY_PNG_BASE64}`;
const CAPABILITY_DOCTOR_OCR_EXPECTED_TEXT = "FRIDAY";
// Inline PNG asset (renders the literal text "FRIDAY") used by the capability doctor
// for an offline OCR self-test. Not a credential — annotated for the entropy scanner.
const CAPABILITY_DOCTOR_OCR_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAARwAAABMCAYAAAC/DQijAAAESUlEQVR4nO2UwY7FMAgD3///9O6NM0oDttsZqTeEJyTl9wcAsMRPLQAA34GFAwBrsHAAYA0WDgCswcIBgDVYOACwBgsHANZg4QDAGiwcAFijvXB+v5/15+7/FLVf+vzU55v2m+ZWPgvHxE/tr86fnp/6fNN+09zKZ+GY+Kn91fnT81Ofb9pvmlv5LBwTP7W/On96furzTftNcyufhWPip/ZX50/PT32+ab9pbuWzcEz81P7q/On5qc837TfNrXwWjomf2l+dPz0/9fmm/aa5lc/CMfFT+6vzp+enPt+03zS38q8tHHfU/ukPMn1++Gv9q892oAq1f/pCSJ8f/lr/6rMdqELtn74Q0ueHv9a/+mwHqlD7py+E9Pnhr/WvPtuBKtT+6QshfX74a/2rz3agCrV/+kJInx/+Wv/qsx2oQu2fvhDS54e/1r/6bAeqUPunL4T0+eGv9a8+24Eq1P7pCyF9fun+0/235sPC4cFZ9J/OT/ef7s/CuYza3/3BqftP56f7T/dn4VxG7e/+4NT9p/PT/af7s3Auo/Z3f3Dq/tP56f7T/Vk4l1H7uz84df/p/HT/6f4snMuo/d0fnLr/dH66/3R/Fs5l1P7uD07dfzo/3X+6f9zCmf4eHzTc/+n53PtP56vvP31+1zzaheEXku7/9Hzu/afz1fefPr9rHu3C8AtJ9396Pvf+0/nq+0+f3zWPdmH4haT7Pz2fe//pfPX9p8/vmke7MPxC0v2fns+9/3S++v7T53fNo10YfiHp/k/P595/Ol99/+nzu+bRLgy/kHT/p+dz7z+dr77/9Pld82gXhl9Iuv/T87n3n85X33/6/K55tAtNhE+ZfrBqWDjv9k/PL492oYnwKekPVu2nPn/6/X09vzzahSbCp6Q/WLWf+vzp9/f1/PJoF5oIn5L+YNV+6vOn39/X88ujXWgifEr6g1X7qc+ffn9fzy+PdqGJ8CnpD1btpz5/+v19Pb882oUmwqekP1i1n/r86ff39fzyaBeaCJ+S/mDVfurzp9/f1/PLo11oInwKP6R3/+n8dP/0/PJoF5oIn8IP6d1/Oj/dPz2/PNqFJsKn8EN695/OT/dPzy+PdqGJ8Cn8kN79p/PT/dPzy6NdaCJ8Cj+kd//p/HT/9PzyaBeaCJ/CD+ndfzo/3T89vzzahSbCp/BDevefzk/3T88vj3ahifAp/JDe/afz0/3T88ujXWgifIraf/qHefqp81mY784vj3ahifApan/3H16dz8J5d355tAtNhE9R+7v/8Op8Fs6788ujXWgifIra3/2HV+ezcN6dXx7tQhPhU9T+7j+8Op+F8+788mgXmgifovZ3/+HV+Sycd+eXR7vQRPgUtb/7D6/OZ+G8O7882oUmwqeo/d1/eHU+C+fd+eWxlgQAn4eFAwBrsHAAYA0WDgCswcIBgDVYOACwBgsHANZg4QDAGiwcAFiDhQMAa/wDOAeBRGCalboAAAAASUVORK5CYII="; // pragma: allowlist secret
const CAPABILITY_DOCTOR_OCR_PNG_DATA_URL =
  `data:image/png;base64,${CAPABILITY_DOCTOR_OCR_PNG_BASE64}`;
const PROVIDER_CAPABILITY_DOCTOR_CAPABILITIES = new Set<FridayRuntimeCapabilityId>([
  "text",
  "vision",
  "embedding",
  "ocr",
  "tts",
  "custom",
]);

function defaultOAuthProviderForKind(kind: FridayProviderProfile["kind"]) {
  return kind === "openai-codex" ? "openai-codex" as const : "anthropic" as const;
}

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
  if (!isProviderLifecycleAvailableForRouting(provider)) {
    return `${label} "${providerId}" is in ${provider.promotionChannel} lifecycle and is not promoted`;
  }
  if (!isProviderValidationOkForRouting(provider)) {
    return `${label} "${providerId}" ${describeProviderValidationForRouting(provider)}`;
  }
  return `${label} "${providerId}" is enabled but was not selected`;
}

function providerValidationStatusForRouting(
  provider: FridayProviderProfile,
): FridayProviderValidationState["status"] {
  return provider.config.validation?.status ?? "never";
}

function isProviderValidationOkForRouting(provider: FridayProviderProfile): boolean {
  return providerValidationStatusForRouting(provider) === "ok";
}

function isProviderLifecycleAvailableForRouting(provider: FridayProviderProfile): boolean {
  const promotionChannel = provider.promotionChannel ?? "none";
  return promotionChannel === "none" || promotionChannel === "active";
}

function shouldAutoValidateProviderForRouting(provider: FridayProviderProfile): boolean {
  return provider.enabled && isProviderLifecycleAvailableForRouting(provider)
    && providerValidationStatusForRouting(provider) === "never";
}

function describeProviderValidationForRouting(provider: FridayProviderProfile): string {
  const status = providerValidationStatusForRouting(provider);
  if (status === "ok") {
    return "is validated";
  }
  if (status === "failed") {
    const detail = provider.config.validation?.errorMessage
      ? `: ${provider.config.validation.errorMessage}`
      : "";
    return `validation failed${detail}`;
  }
  const detail = provider.config.validation?.errorMessage
    ? `: ${provider.config.validation.errorMessage}`
    : "";
  return `has not been validated${detail}`;
}

function isImageCapabilityProbe(capability: FridayRuntimeCapabilityId): boolean {
  return capability === "vision" || capability === "ocr";
}

function capabilityProbePrompt(capability: FridayRuntimeCapabilityId): string {
  if (capability === "ocr") {
    return "Read the text in this image. Reply with the text only.";
  }
  if (capability === "vision") {
    return "Reply with OK if you can process this image.";
  }
  return "Reply with OK only.";
}

function capabilityProbeImageBase64(capability: FridayRuntimeCapabilityId): string {
  return capability === "ocr"
    ? CAPABILITY_DOCTOR_OCR_PNG_BASE64
    : CAPABILITY_DOCTOR_TINY_PNG_BASE64;
}

function capabilityProbeImageDataUrl(capability: FridayRuntimeCapabilityId): string {
  return capability === "ocr"
    ? CAPABILITY_DOCTOR_OCR_PNG_DATA_URL
    : CAPABILITY_DOCTOR_TINY_PNG_DATA_URL;
}

async function readCapabilityProbeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function readRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? input as Record<string, unknown> : {};
}

function extractOpenAiChatProbeText(json: unknown): string {
  const root = readRecord(json);
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = readRecord(choices[0]);
  const message = readRecord(first.message);
  const content = message.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const record = readRecord(part);
        return typeof record.text === "string" ? record.text : "";
      })
      .join("")
      .trim();
  }
  return "";
}

function extractOpenAiResponsesProbeText(json: unknown): string {
  const root = readRecord(json);
  if (typeof root.output_text === "string") {
    return root.output_text.trim();
  }
  const output = Array.isArray(root.output) ? root.output : [];
  const chunks: string[] = [];
  for (const item of output) {
    const content = readRecord(item).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      const record = readRecord(part);
      if (typeof record.text === "string") {
        chunks.push(record.text);
      }
    }
  }
  return chunks.join("").trim();
}

function extractAnthropicProbeText(json: unknown): string {
  const content = readRecord(json).content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      const record = readRecord(part);
      return typeof record.text === "string" ? record.text : "";
    })
    .join("")
    .trim();
}

function extractOllamaProbeText(json: unknown): string {
  const response = readRecord(json).response;
  return typeof response === "string" ? response.trim() : "";
}

function embeddingProbeHasVector(json: unknown): boolean {
  const data = readRecord(json).data;
  if (!Array.isArray(data)) {
    return false;
  }
  const embedding = readRecord(data[0]).embedding;
  return Array.isArray(embedding) && embedding.length > 0;
}

function validateGenerationProbeOutput(
  capability: FridayRuntimeCapabilityId,
  output: string,
): { ok: boolean; message?: string } {
  const normalized = output.trim().toUpperCase();
  if (capability === "ocr") {
    return normalized.includes(CAPABILITY_DOCTOR_OCR_EXPECTED_TEXT)
      ? { ok: true }
      : {
          ok: false,
          message: `OCR probe did not return expected text "${CAPABILITY_DOCTOR_OCR_EXPECTED_TEXT}".`,
        };
  }
  if (capability === "text" || capability === "vision") {
    return normalized.includes("OK")
      ? { ok: true }
      : { ok: false, message: `Capability probe returned unexpected output: ${output.slice(0, 80)}` };
  }
  return { ok: output.trim().length > 0 };
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
  if (!isProviderLifecycleAvailableForRouting(provider)) {
    throw new FridayDomainError(
      "PROVIDER_LIFECYCLE_UNPROMOTED",
      `Provider "${requestedProviderId}" is in ${provider.promotionChannel} lifecycle and is not promoted for normal routing`,
      { httpStatus: 409 },
    );
  }
  return provider;
}

function explainPinnedProviderNoCandidates(
  provider: FridayProviderProfile,
  requestedModel?: string,
): string {
  if (!isProviderLifecycleAvailableForRouting(provider)) {
    return `Provider "${provider.id}" is in ${provider.promotionChannel} lifecycle and is not promoted for normal routing.`;
  }
  if (!isProviderValidationOkForRouting(provider)) {
    return `Provider "${provider.id}" ${describeProviderValidationForRouting(provider)}. Validate the provider before routing.`;
  }
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

function filterCandidatesToValidatedProviders(
  candidates: FridayResolvedProviderRoute[],
): FridayResolvedProviderRoute[] {
  return candidates.filter((candidate) =>
    isProviderValidationOkForRouting(candidate.provider),
  );
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
  const allowImplicitProviderStateMutation = deps.allowImplicitProviderStateMutation !== false;
  const credentialHandles = createFridayEphemeralSecretHandleRegistry({
    nowMs: deps.nowMs,
  });

  // ─── OAuth subsystem ───

  const anthropicOAuth = createFridayAnthropicOAuthProvider({
    fetchImpl: deps.fetchImpl,
    nowMs: deps.nowMs,
  });
  const openAICodexOAuth = createFridayOpenAICodexOAuthProvider({
    fetchImpl: deps.fetchImpl,
    nowMs: deps.nowMs,
  });
  const oauthProviderRegistry = createFridayOAuthProviderRegistry([anthropicOAuth, openAICodexOAuth]);
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
  const pendingOAuthDeviceAuthorizations = new Map<string, {
    providerId: string;
    ownerUserId: string;
    oauthProvider: string;
  }>();

  // ─── Key source resolution ───

  function resolveKeySourceInput(apiKey: string | undefined, options?: { preserveEnvRef?: boolean }): {
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
      case "env-ref": {
        if (options?.preserveEnvRef) {
          return {
            keySource: { kind: "env-ref", envVar: parsed.envVar },
            inlineSecret: null,
          };
        }
        const envValue = process.env[parsed.envVar];
        if (envValue && envValue.trim().length > 0) {
          return {
            keySource: { kind: "secret-ref", refKey: "" },
            inlineSecret: envValue.trim(),
          };
        }
        return {
          keySource: { kind: "env-ref", envVar: parsed.envVar },
          inlineSecret: null,
        };
      }
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
    const secretId = `secret:${refKey}`; // pragma: allowlist secret
    const masterKey = getStrictMasterKey();
    const envelope = encryptSecret(
      apiKey,
      masterKey,
      fridaySecretAadContext({ scope: SECRET_SCOPE, id: secretId }),
    );
    deps.db.withWriteTransaction((db) => {
      secretRepo.upsert(db, {
        id: secretId,
        scope: SECRET_SCOPE,
        refKey,
        encryptedValue: JSON.stringify(envelope),
        keyId: "master-v1",
        nowIso: deps.nowIso(),
      });
    });
    return { kind: "secret-ref", refKey };
  }

  /**
   * Read-repair (SEC-SECRET-AAD-001): persists a v2 re-wrap produced while
   * reading a legacy v1 secret row so no unbound envelope survives at rest.
   * Best-effort — a failed repair never blocks the read.
   */
  function rewrapPersistedSecret(secretId: string, rewrapped: FridayEncryptedEnvelope): void {
    try {
      deps.db.withWriteTransaction((db) => {
        secretRepo.updateById(db, {
          secretId,
          encryptedValue: JSON.stringify(rewrapped),
          keyId: "master-v1",
          nowIso: deps.nowIso(),
        });
      });
    } catch (err) {
      console.warn(
        "[friday][provider-service] secret AAD read-repair failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
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
        ownerUserId: tenantContext?.userId ?? FRIDAY_GLOBAL_OAUTH_OWNER_USER_ID,
        oauthProvider,
      });
      if (!accessToken) {
        throw new FridayDomainError(
          "PROVIDER_AUTH_INVALID",
          `No OAuth credentials found for ${oauthProvider}. Complete provider OAuth login to connect.`,
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
      readSecretRef: async (refKey) => {
        const secret = deps.db.withReadConnection((db) =>
          secretRepo.getByRef(db, SECRET_SCOPE, refKey),
        );
        if (!secret) {
          return null;
        }
        const masterKey = getStrictMasterKey();
        const envelope = JSON.parse(secret.encryptedValue) as FridayEncryptedEnvelope;
        const { plaintext, rewrapped } = decryptSecretWithMigration(
          envelope,
          masterKey,
          fridaySecretAadContext(secret),
        );
        if (rewrapped) {
          rewrapPersistedSecret(secret.id, rewrapped);
        }
        return plaintext;
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
      ownerUserId: tenantContext?.userId ?? FRIDAY_GLOBAL_OAUTH_OWNER_USER_ID,
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

  function estimateModelContextWindowTokens(model: string, candidate: FridayResolvedProviderRoute): number {
    const normalized = model.toLowerCase();
    if (/\b(1m|1000k|million)\b/.test(normalized) || normalized.includes("gemini")) return 1_000_000;
    if (normalized.includes("claude")) return 200_000;
    if (normalized.includes("gpt-5") || normalized.includes("gpt-4.1") || normalized.includes("o3") || normalized.includes("o4")) return 128_000;
    const explicitMatch = normalized.match(/(?:^|[-_])(\d+)(k)(?:[-_]|$)/);
    if (explicitMatch) return Number(explicitMatch[1]) * 1_000;
    return isLocalCandidate(candidate) ? 32_000 : 128_000;
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
    costMode: FridayModelRoutingConfig["costMode"];
    taskProfileId?: string;
    routingContext?: {
      estimatedInputTokens?: number;
      requiresNativeTools?: boolean;
      requiredCapabilities?: FridayRuntimeCapabilityId[];
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
      const contextWindowTokens = Math.max(
        input.routingContext?.estimatedInputTokens ?? 0,
        input.routingContext?.contextWindowTokens ?? 0,
      );
      if (
        Number.isFinite(contextWindowTokens)
        && contextWindowTokens > 0
        && contextWindowTokens > Math.floor(estimateModelContextWindowTokens(candidate.model, candidate) * 0.9)
      ) {
        ineligibilityReasons.push("context_window_exceeded");
      }
      const sensitivity = input.routingContext?.dataSensitivity;
      if ((sensitivity === "secret" || sensitivity === "confidential") && !isLocalCandidate(candidate)) {
        ineligibilityReasons.push("data_sensitivity_requires_local");
      }
      if (
        typeof input.routingContext?.latencyBudgetMs === "number"
        && input.routingContext.latencyBudgetMs > 0
        && input.routingContext.latencyBudgetMs < 3_000
        && backendKind === "cli"
      ) {
        ineligibilityReasons.push("latency_budget_excludes_cli");
      }
      if (input.routingContext?.satelliteAvailable === false && isLocalCandidate(candidate)) {
        ineligibilityReasons.push("satellite_unavailable_for_local_route");
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
    } else if (input.costMode === "frugal") {
      reasonCode = "cost_mode_frugal";
    } else if (input.costMode === "strict") {
      reasonCode = "cost_mode_strict";
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
        case "cost_mode_frugal":
          return "Frugal mode preferred lower-cost eligible routes without bypassing provider, capability, or safety gates.";
        case "cost_mode_strict":
          return "Strict mode preferred higher-quality eligible routes without bypassing provider, capability, or safety gates.";
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
        costMode: input.costMode ?? "standard",
        ...(input.taskProfileId ? { taskProfileId: input.taskProfileId } : {}),
        requiresNativeTools: input.routingContext?.requiresNativeTools === true,
        ...(input.routingContext?.requiredCapabilities?.length
          ? { requiredCapabilities: [...input.routingContext.requiredCapabilities] }
          : {}),
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
    } else if ((validationState?.status ?? "never") !== "ok") {
      if (backendHealth === "healthy") {
        backendHealth = "status_unknown";
      }
      reasons.push("validation_unverified");
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

  function listProviderModels(profile: FridayProviderProfile): string[] {
    const models = normalizeFridayProviderSupportedModels(profile.config.supportedModels);
    if (models.length > 0) {
      return models;
    }
    return profile.defaultModel && profile.defaultModel.trim().length > 0
      ? [profile.defaultModel.trim()]
      : [];
  }

  function declarationMatchesModel(
    declaration: FridayProviderRuntimeCapabilityDeclaration,
    model: string,
  ): boolean {
    return !declaration.model || declaration.model === model;
  }

  function hasRuntimeCapabilityDeclaration(
    profile: FridayProviderProfile,
    capability: FridayRuntimeCapabilityId,
    model: string,
  ): boolean {
    return (profile.config.runtimeCapabilities ?? []).some((declaration) =>
      declaration.capability === capability && declarationMatchesModel(declaration, model),
    );
  }

  function normalizeUserDeclaredRuntimeCapabilities(
    declarations: FridayProviderRuntimeCapabilityDeclaration[] | undefined,
  ): FridayProviderRuntimeCapabilityDeclaration[] | undefined {
    return declarations?.map((declaration) => ({
      ...declaration,
      verified: declaration.status === "failed" ? false : undefined,
      status: declaration.status === "failed" ? "failed" : "declared",
      verifiedAt: undefined,
    }));
  }

  function listCapabilityDoctorTargets(
    profile: FridayProviderProfile,
  ): Array<{ capability: FridayRuntimeCapabilityId; model: string }> {
    const targets: Array<{ capability: FridayRuntimeCapabilityId; model: string }> = [];
    const seen = new Set<string>();
    const models = new Set(listProviderModels(profile));

    const addTarget = (capability: FridayRuntimeCapabilityId, model: string | undefined) => {
      if (!model || model.trim().length === 0 || !PROVIDER_CAPABILITY_DOCTOR_CAPABILITIES.has(capability)) {
        return;
      }
      const normalizedModel = model.trim();
      const key = `${capability}::${normalizedModel}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      targets.push({ capability, model: normalizedModel });
    };

    for (const model of models) {
      addTarget("text", model);
      if (inferFridayModelSupportsVision(profile.kind, model) || hasRuntimeCapabilityDeclaration(profile, "vision", model)) {
        addTarget("vision", model);
        addTarget("ocr", model);
      }
      if (inferFridayModelSupportsEmbedding(model) || hasRuntimeCapabilityDeclaration(profile, "embedding", model)) {
        addTarget("embedding", model);
      }
      for (const capability of ["ocr", "tts", "custom"] as const) {
        if (hasRuntimeCapabilityDeclaration(profile, capability, model)) {
          addTarget(capability, model);
        }
      }
    }

    for (const declaration of profile.config.runtimeCapabilities ?? []) {
      if (!PROVIDER_CAPABILITY_DOCTOR_CAPABILITIES.has(declaration.capability)) {
        continue;
      }
      if (declaration.model) {
        addTarget(declaration.capability, declaration.model);
        continue;
      }
      for (const model of models) {
        addTarget(declaration.capability, model);
      }
    }

    return targets;
  }

  function capabilityDoctorResult(input: {
    profile: FridayProviderProfile;
    capability: FridayRuntimeCapabilityId;
    model: string;
    status: FridayProviderCapabilityDoctorProbeResult["status"];
    checkedAt: string;
    message: string;
    errorCode?: FridayProviderValidationErrorCode;
    httpStatus?: number;
    evidence?: FridayProviderCapabilityDoctorProbeResult["evidence"];
  }): FridayProviderCapabilityDoctorProbeResult {
    return {
      providerId: input.profile.id,
      providerKind: input.profile.kind,
      capability: input.capability,
      model: input.model,
      status: input.status,
      checkedAt: input.checkedAt,
      message: input.message,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.httpStatus ? { httpStatus: input.httpStatus } : {}),
      ...(input.evidence ? { evidence: input.evidence } : {}),
    };
  }

  function toValidationErrorCode(value: string | undefined): FridayProviderValidationErrorCode | undefined {
    switch (value) {
      case "PROVIDER_ENV_VAR_MISSING":
      case "PROVIDER_AUTH_INVALID":
      case "PROVIDER_PAYMENT_REQUIRED":
      case "PROVIDER_UNREACHABLE":
      case "PROVIDER_MODEL_UNAVAILABLE":
      case "PROVIDER_UNKNOWN_ERROR":
        return value;
      default:
        return undefined;
    }
  }

  async function fetchCapabilityProbe(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CAPABILITY_DOCTOR_TIMEOUT_MS);
    try {
      const fetchImpl = deps.fetchImpl ?? fetch;
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function readProbeError(response: Response): Promise<string> {
    const text = await response.text().catch(() => "");
    const compact = text.replace(/\s+/g, " ").trim();
    return compact.length > 240 ? `${compact.slice(0, 240)}...` : compact;
  }

  function providerBaseUrl(profile: FridayProviderProfile): string {
    return profile.baseUrl.replace(/\/+$/, "");
  }

  function openAiHeaders(profile: FridayProviderProfile, credential: string | null): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(profile.config.headers ?? {}),
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      ...(profile.config.api === "openai-codex-responses"
        ? {
            originator: "friday",
            "User-Agent": "friday",
          }
        : {}),
    };
  }

  function anthropicHeaders(profile: FridayProviderProfile, credential: string | null): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(profile.config.headers ?? {}),
      ...(credential ? { "x-api-key": credential } : {}),
    };
  }

  async function runHttpCapabilityProbe(input: {
    profile: FridayProviderProfile;
    capability: FridayRuntimeCapabilityId;
    model: string;
    credential: string | null;
  }): Promise<{
    ok: boolean;
    endpoint?: string;
    status?: number;
    message?: string;
    standardized: boolean;
    probe: string;
  }> {
    const { profile, capability, model, credential } = input;
    const base = providerBaseUrl(profile);

    if (
      capability === "tts" &&
      (profile.config.api === "openai-completions" || profile.config.api === "openai-responses")
    ) {
      const endpoint = `${base}/v1/audio/speech`;
      const response = await fetchCapabilityProbe(endpoint, {
        method: "POST",
        headers: openAiHeaders(profile, credential),
        body: JSON.stringify({
          model,
          input: "Friday capability probe.",
          voice: "alloy",
          response_format: "mp3",
          speed: 1,
        }),
      });
      if (!response.ok) {
        return { ok: false, endpoint, status: response.status, standardized: true, probe: capability, message: await readProbeError(response) };
      }
      const audio = Buffer.from(await response.arrayBuffer());
      return audio.byteLength > 0
        ? { ok: true, endpoint, status: response.status, standardized: true, probe: capability }
        : { ok: false, endpoint, status: response.status, standardized: true, probe: capability, message: "TTS probe returned empty audio." };
    }

    if (capability === "embedding" && profile.config.api !== "openai-completions" && profile.config.api !== "openai-responses") {
      return {
        ok: false,
        standardized: false,
        probe: "embedding",
        message: `Friday's production embedding client only has a standardized OpenAI-compatible /v1/embeddings path for this capability.`,
      };
    }

    if (profile.config.api === "openai-completions") {
      const endpoint = capability === "embedding" ? `${base}/v1/embeddings` : `${base}/v1/chat/completions`;
      const body = capability === "embedding"
        ? { model, input: "friday capability probe" }
        : {
            model,
            messages: [
              {
                role: "user",
                content: isImageCapabilityProbe(capability)
                  ? [
                      { type: "text", text: capabilityProbePrompt(capability) },
                      { type: "image_url", image_url: { url: capabilityProbeImageDataUrl(capability) } },
                    ]
                  : capabilityProbePrompt(capability),
              },
            ],
            // Reasoning-first models (e.g. deepseek-v4-pro) burn budget on
            // reasoning_content before producing the user-visible content; a
            // 16-token cap leaves them with finish_reason="length" and an empty
            // content string, failing every probe regardless of capability.
            max_tokens: 256,
            temperature: 0,
          };
      const response = await fetchCapabilityProbe(endpoint, {
        method: "POST",
        headers: openAiHeaders(profile, credential),
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        return { ok: false, endpoint, status: response.status, standardized: true, probe: capability, message: await readProbeError(response) };
      }
      const json = await readCapabilityProbeJson(response);
      if (capability === "embedding") {
        return embeddingProbeHasVector(json)
          ? { ok: true, endpoint, status: response.status, standardized: true, probe: capability }
          : { ok: false, endpoint, status: response.status, standardized: true, probe: capability, message: "Embedding probe did not return a vector." };
      }
      const validation = validateGenerationProbeOutput(capability, extractOpenAiChatProbeText(json));
      return validation.ok
        ? { ok: true, endpoint, status: response.status, standardized: true, probe: capability }
        : { ok: false, endpoint, status: response.status, standardized: true, probe: capability, message: validation.message };
    }

    if (profile.config.api === "openai-responses" || profile.config.api === "openai-codex-responses") {
      if (profile.config.api === "openai-codex-responses" && capability === "embedding") {
        return {
          ok: false,
          standardized: false,
          probe: "embedding",
          message: "OpenAI Codex subscription transport is a Responses runtime path; Friday does not route embeddings through it.",
        };
      }
      const endpoint = capability === "embedding" ? `${base}/v1/embeddings` : `${base}/v1/responses`;
      const body = capability === "embedding"
        ? { model, input: "friday capability probe" }
        : profile.config.api === "openai-codex-responses"
            ? {
                model,
                instructions: "You are Friday. Follow the user's instruction exactly.",
                store: false,
                stream: true,
                input: [
                {
                  role: "user",
                  content: isImageCapabilityProbe(capability)
                    ? [
                        { type: "input_text", text: capabilityProbePrompt(capability) },
                        { type: "input_image", image_url: capabilityProbeImageDataUrl(capability) },
                      ]
                    : [{ type: "input_text", text: capabilityProbePrompt(capability) }],
                },
              ],
            }
          : {
              model,
              input: isImageCapabilityProbe(capability)
                ? [
                    {
                      role: "user",
                      content: [
                        { type: "input_text", text: capabilityProbePrompt(capability) },
                        { type: "input_image", image_url: capabilityProbeImageDataUrl(capability) },
                      ],
                    },
                  ]
                : capabilityProbePrompt(capability),
              // Match the openai-completions probe budget so reasoning-first
              // models can finish reasoning + emit the expected short answer.
              max_output_tokens: 256,
              temperature: 0,
            };
      const effectiveEndpoint = profile.config.api === "openai-codex-responses" && capability !== "embedding"
        ? `${base}/responses`
        : endpoint;
      const response = await fetchCapabilityProbe(effectiveEndpoint, {
        method: "POST",
        headers: openAiHeaders(profile, credential),
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        return { ok: false, endpoint: effectiveEndpoint, status: response.status, standardized: true, probe: capability, message: await readProbeError(response) };
      }
      if (profile.config.api === "openai-codex-responses") {
        await response.body?.cancel().catch(() => undefined);
        return { ok: true, endpoint: effectiveEndpoint, status: response.status, standardized: true, probe: capability };
      }
      const json = await readCapabilityProbeJson(response);
      if (capability === "embedding") {
        return embeddingProbeHasVector(json)
          ? { ok: true, endpoint: effectiveEndpoint, status: response.status, standardized: true, probe: capability }
          : { ok: false, endpoint: effectiveEndpoint, status: response.status, standardized: true, probe: capability, message: "Embedding probe did not return a vector." };
      }
      const validation = validateGenerationProbeOutput(capability, extractOpenAiResponsesProbeText(json));
      return validation.ok
        ? { ok: true, endpoint: effectiveEndpoint, status: response.status, standardized: true, probe: capability }
        : { ok: false, endpoint: effectiveEndpoint, status: response.status, standardized: true, probe: capability, message: validation.message };
    }

    if (profile.config.api === "anthropic-messages") {
      if (isFridayAnthropicBearerAuthMode(profile.config.authMode)) {
        return {
          ok: false,
          endpoint: `${base}/v1/messages`,
          status: 400,
          message: FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE,
          standardized: true,
          probe: capability,
        };
      }
      if (capability === "embedding") {
        return {
          ok: false,
          standardized: false,
          probe: "embedding",
          message: "Anthropic Messages is not a Friday embedding runtime path.",
        };
      }
      const endpoint = `${base}/v1/messages`;
      const response = await fetchCapabilityProbe(endpoint, {
        method: "POST",
        headers: anthropicHeaders(profile, credential),
        body: JSON.stringify({
          model,
          max_tokens: 16,
          messages: [
            {
              role: "user",
              content: isImageCapabilityProbe(capability)
                ? [
                    { type: "text", text: capabilityProbePrompt(capability) },
                    {
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: "image/png",
                        data: capabilityProbeImageBase64(capability),
                      },
                    },
                  ]
                : capabilityProbePrompt(capability),
            },
          ],
        }),
      });
      if (!response.ok) {
        return { ok: false, endpoint, status: response.status, standardized: true, probe: capability, message: await readProbeError(response) };
      }
      const validation = validateGenerationProbeOutput(capability, extractAnthropicProbeText(await readCapabilityProbeJson(response)));
      return validation.ok
        ? { ok: true, endpoint, status: response.status, standardized: true, probe: capability }
        : { ok: false, endpoint, status: response.status, standardized: true, probe: capability, message: validation.message };
    }

    if (profile.config.api === "ollama") {
      if (capability === "embedding") {
        return {
          ok: false,
          standardized: false,
          probe: "embedding",
          message: "Ollama embeddings are not wired into Friday's production BYOK embedding client yet.",
        };
      }
      const endpoint = `${base}/api/generate`;
      const response = await fetchCapabilityProbe(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(profile.config.headers ?? {}) },
        body: JSON.stringify({
          model,
          prompt: capabilityProbePrompt(capability),
          stream: false,
          ...(isImageCapabilityProbe(capability) ? { images: [capabilityProbeImageBase64(capability)] } : {}),
          options: { num_predict: 16, temperature: 0 },
        }),
      });
      if (!response.ok) {
        return { ok: false, endpoint, status: response.status, standardized: true, probe: capability, message: await readProbeError(response) };
      }
      const validation = validateGenerationProbeOutput(capability, extractOllamaProbeText(await readCapabilityProbeJson(response)));
      return validation.ok
        ? { ok: true, endpoint, status: response.status, standardized: true, probe: capability }
        : { ok: false, endpoint, status: response.status, standardized: true, probe: capability, message: validation.message };
    }

    if (profile.config.api === "google-generative-ai") {
      return {
        ok: false,
        standardized: false,
        probe: capability,
        message: "Google Generative AI validation exists, but Friday's production LLM runtime does not yet execute this provider API.",
      };
    }

    return {
      ok: false,
      standardized: false,
      probe: capability,
      message: `No standardized Friday runtime probe exists for provider API ${profile.config.api}.`,
    };
  }

  async function probeProviderCapability(input: {
    profile: FridayProviderProfile;
    target: { capability: FridayRuntimeCapabilityId; model: string };
    validation: FridayProviderValidationState;
    checkedAt: string;
    tenantContext?: FridayProviderTenantContext;
  }): Promise<FridayProviderCapabilityDoctorProbeResult> {
    const { profile, target, validation, checkedAt, tenantContext } = input;
    if (!profile.enabled) {
      return capabilityDoctorResult({
        profile,
        ...target,
        status: "failed",
        checkedAt,
        errorCode: "PROVIDER_UNKNOWN_ERROR",
        message: "Provider is disabled; enable it before this capability can be used.",
      });
    }

    if (validation.status !== "ok") {
      return capabilityDoctorResult({
        profile,
        ...target,
        status: "failed",
        checkedAt,
        errorCode: toValidationErrorCode(validation.errorCode) ?? "PROVIDER_UNKNOWN_ERROR",
        httpStatus: validation.httpStatus,
        message: validation.errorMessage ?? "Provider validation did not pass.",
      });
    }

    if (target.capability === "custom") {
      return capabilityDoctorResult({
        profile,
        ...target,
        status: "declared",
        checkedAt,
        message: `${target.capability} is declared, but Friday does not have a standardized provider probe for this capability yet.`,
        evidence: {
          probe: target.capability,
          standardized: false,
        },
      });
    }

    if ((profile.config.backendKind ?? "http") === "cli") {
      if (target.capability === "text" && profile.config.cliConfig) {
        try {
          const output = await runFridayCliBackendTextCompletion({
            cliConfig: profile.config.cliConfig,
            systemPrompt: "You are a capability probe. Reply with OK only.",
            conversation: "USER: Reply with OK only.",
            model: target.model,
          });
          return capabilityDoctorResult({
            profile,
            ...target,
            status: output.trim().length > 0 ? "verified" : "failed",
            checkedAt,
            message: output.trim().length > 0
              ? "CLI text capability passed a live generation probe."
              : "CLI text capability returned an empty response.",
            ...(output.trim().length > 0
              ? {
                  evidence: {
                    probe: "text",
                    standardized: true,
                  },
                }
              : { errorCode: "PROVIDER_UNREACHABLE" as const }),
          });
        } catch (err) {
          return capabilityDoctorResult({
            profile,
            ...target,
            status: "failed",
            checkedAt,
            errorCode: "PROVIDER_UNREACHABLE",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return capabilityDoctorResult({
        profile,
        ...target,
        status: "declared",
        checkedAt,
        message: "CLI session validation passed, but the capability doctor does not run a standardized CLI generation probe yet.",
        evidence: {
          probe: target.capability,
          standardized: false,
        },
      });
    }

    let credential: string | null = null;
    try {
      credential = await resolveCredential(profile, tenantContext);
    } catch (err) {
      return capabilityDoctorResult({
        profile,
        ...target,
        status: "failed",
        checkedAt,
        errorCode: err instanceof FridayDomainError
          ? toValidationErrorCode(err.code) ?? "PROVIDER_AUTH_INVALID"
          : "PROVIDER_UNKNOWN_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const probe = await runHttpCapabilityProbe({
        profile,
        capability: target.capability,
        model: target.model,
        credential,
      });

      if (!probe.standardized) {
        return capabilityDoctorResult({
          profile,
          ...target,
          status: "declared",
          checkedAt,
          message: probe.message ?? "Capability is configured, but no standardized Friday probe exists for it yet.",
          evidence: {
            probe: probe.probe,
            standardized: false,
            ...(probe.endpoint ? { endpoint: probe.endpoint } : {}),
            ...(probe.status ? { responseStatus: probe.status } : {}),
          },
        });
      }

      if (!probe.ok) {
        return capabilityDoctorResult({
          profile,
          ...target,
          status: "failed",
          checkedAt,
          errorCode: probe.status === 401 || probe.status === 403
            ? "PROVIDER_AUTH_INVALID"
            : probe.status === 402
              ? "PROVIDER_PAYMENT_REQUIRED"
              : probe.status === 404
                ? "PROVIDER_MODEL_UNAVAILABLE"
                : "PROVIDER_UNREACHABLE",
          httpStatus: probe.status,
          message: probe.message
            ? `Capability probe failed: ${probe.message}`
            : `Capability probe failed with HTTP ${String(probe.status ?? "unknown")}.`,
          evidence: {
            probe: probe.probe,
            standardized: true,
            ...(probe.endpoint ? { endpoint: probe.endpoint } : {}),
            ...(probe.status ? { responseStatus: probe.status } : {}),
          },
        });
      }

      return capabilityDoctorResult({
        profile,
        ...target,
        status: "verified",
        checkedAt,
        message: "Capability passed a live standardized probe.",
        evidence: {
          probe: probe.probe,
          standardized: true,
          ...(probe.endpoint ? { endpoint: probe.endpoint } : {}),
          ...(probe.status ? { responseStatus: probe.status } : {}),
        },
      });
    } catch (err) {
      return capabilityDoctorResult({
        profile,
        ...target,
        status: "failed",
        checkedAt,
        errorCode: "PROVIDER_UNREACHABLE",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function mergeCapabilityDoctorResults(
    existing: readonly FridayProviderRuntimeCapabilityDeclaration[] | undefined,
    results: readonly FridayProviderCapabilityDoctorProbeResult[],
  ): FridayProviderRuntimeCapabilityDeclaration[] {
    const byKey = new Map<string, FridayProviderRuntimeCapabilityDeclaration>();
    const keyFor = (capability: FridayRuntimeCapabilityId, model?: string) =>
      `${capability}::${model ?? "*"}`;

    for (const declaration of existing ?? []) {
      byKey.set(keyFor(declaration.capability, declaration.model), { ...declaration });
    }

    for (const result of results) {
      if (!PROVIDER_CAPABILITY_DOCTOR_CAPABILITIES.has(result.capability)) {
        continue;
      }
      if (result.status === "unsupported") {
        continue;
      }
      const status = result.status === "verified"
        ? "verified"
        : result.status === "failed"
          ? "failed"
          : "declared";
      byKey.set(keyFor(result.capability, result.model), {
        capability: result.capability,
        ...(result.model ? { model: result.model } : {}),
        status,
        verified: status === "verified",
        ...(status === "verified" ? { verifiedAt: result.checkedAt } : {}),
        notes: result.message,
      });
    }

    return [...byKey.values()].sort((a, b) =>
      keyFor(a.capability, a.model).localeCompare(keyFor(b.capability, b.model)),
    );
  }

  async function resolveRawApiKeyAsync(rawApiKey: string | undefined): Promise<string | null> {
    if (!rawApiKey) return null;
    const parsed = parseFridaySecretInput(rawApiKey, {
      secretRefPrefixes: ["secret://"],
    });
    const resolved = await resolveFridaySecretInput(parsed, {
      env: process.env,
      readSecretRef: async (refKey) => {
        const secret = deps.db.withReadConnection((db) =>
          secretRepo.getByRef(db, SECRET_SCOPE, refKey),
        );
        if (!secret) {
          return null;
        }
        const masterKey = getStrictMasterKey();
        const envelope = JSON.parse(secret.encryptedValue) as FridayEncryptedEnvelope;
        const { plaintext, rewrapped } = decryptSecretWithMigration(
          envelope,
          masterKey,
          fridaySecretAadContext(secret),
        );
        if (rewrapped) {
          rewrapPersistedSecret(secret.id, rewrapped);
        }
        return plaintext;
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
    if (backendKind === "cli" && input.cliConfig?.binaryPath && input.cliConfig.binaryPath.trim().length > 0) {
      assertAllowedCliBinaryPath(input.cliConfig.binaryPath, input.cliConfig.backendId);
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

  function normalizeRequiredCapabilitiesForRouting(
    capabilities?: FridayRuntimeCapabilityId[],
  ): FridayRuntimeCapabilityId[] {
    if (!Array.isArray(capabilities)) {
      return [];
    }
    const seen = new Set<string>();
    const normalized: FridayRuntimeCapabilityId[] = [];
    for (const capability of capabilities) {
      if (seen.has(capability)) {
        continue;
      }
      seen.add(capability);
      normalized.push(capability);
    }
    return normalized;
  }

  function applyRequiredCapabilityFilter(input: {
    candidates: FridayResolvedProviderRoute[];
    requiredCapabilities?: FridayRuntimeCapabilityId[];
  }): FridayResolvedProviderRoute[] {
    const required = normalizeRequiredCapabilitiesForRouting(input.requiredCapabilities);
    if (required.length === 0) {
      return input.candidates;
    }
    return filterFridayProviderRoutesByRequiredCapabilities(input.candidates, required);
  }

  function buildRouteCandidates(input: {
    routing: FridayModelRoutingConfig;
    providers: FridayProviderProfile[];
    requestedModel?: string;
    pinnedProvider?: FridayProviderProfile;
  }): FridayResolvedProviderRoute[] {
    return filterCandidatesToPinnedProvider(
      fallback.resolveCandidates({
        routing: input.pinnedProvider
          ? {
              defaultProviderId: input.pinnedProvider.id,
              fallbackProviderIds: [],
            }
          : input.routing,
        providers: input.providers,
        requestedModel: input.requestedModel,
      }).filter((route) => isProviderLifecycleAvailableForRouting(route.provider)),
      input.pinnedProvider,
    );
  }

  async function autoValidateRoutingCandidatesOnce(input: {
    candidates: FridayResolvedProviderRoute[];
    tenantContext?: FridayProviderTenantContext;
  }): Promise<boolean> {
    if (!allowImplicitProviderStateMutation) {
      return false;
    }
    const providerIds = new Set<string>();
    for (const candidate of input.candidates) {
      if (shouldAutoValidateProviderForRouting(candidate.provider)) {
        providerIds.add(candidate.provider.id);
      }
    }
    for (const providerId of providerIds) {
      await service.validateProvider(providerId, {
        tenantContext: input.tenantContext,
      });
    }
    return providerIds.size > 0;
  }

  async function buildValidatedRouteCandidates(input: {
    routing: FridayModelRoutingConfig;
    providers: FridayProviderProfile[];
    requestedModel?: string;
    requestedProviderId?: string;
    tenantContext?: FridayProviderTenantContext;
    autoValidate?: boolean;
  }): Promise<{
    providers: FridayProviderProfile[];
    pinnedProvider?: FridayProviderProfile;
    candidates: FridayResolvedProviderRoute[];
  }> {
    let currentProviders = input.providers;
    let pinnedProvider = input.requestedProviderId
      ? assertRequestedProviderAvailable(currentProviders, input.requestedProviderId)
      : undefined;
    let candidates = buildRouteCandidates({
      routing: input.routing,
      providers: currentProviders,
      requestedModel: input.requestedModel,
      pinnedProvider,
    });

    if (input.autoValidate === true) {
      const validatedAny = await autoValidateRoutingCandidatesOnce({
        candidates,
        tenantContext: input.tenantContext,
      });
      if (validatedAny) {
        currentProviders = deps.db.withReadConnection((db) =>
          profileRepo.list(db),
        );
        pinnedProvider = input.requestedProviderId
          ? assertRequestedProviderAvailable(currentProviders, input.requestedProviderId)
          : undefined;
        candidates = buildRouteCandidates({
          routing: input.routing,
          providers: currentProviders,
          requestedModel: input.requestedModel,
          pinnedProvider,
        });
      }
    }

    candidates = filterCandidatesToValidatedProviders(candidates);

    return {
      providers: currentProviders,
      pinnedProvider,
      candidates,
    };
  }

  function explainRequiredCapabilityNoCandidates(
    requiredCapabilities?: FridayRuntimeCapabilityId[],
  ): string {
    const required = normalizeRequiredCapabilitiesForRouting(requiredCapabilities);
    return required.length > 0
      ? `No enabled provider/model route satisfies required capabilities: ${required.join(", ")}. Configure and verify a capable provider, then retry.`
      : "No enabled provider/model route satisfies this task.";
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

    async runCapabilityDoctor(options): Promise<FridayProviderCapabilityDoctorReport> {
      const checkedAt = deps.nowIso();
      const tenantContext = options?.tenantContext
        ?? (options?.ownerUserId
          ? { hubId: options.ownerUserId, userId: options.ownerUserId }
          : undefined);
      const requestedProviderIds = new Set(
        (options?.providerIds ?? [])
          .map((providerId) => providerId.trim())
          .filter((providerId) => providerId.length > 0),
      );
      const allProviders = deps.db.withReadConnection((db) => profileRepo.list(db));
      const providers = requestedProviderIds.size > 0
        ? allProviders.filter((provider) => requestedProviderIds.has(provider.id))
        : allProviders;
      if (providers.length !== requestedProviderIds.size && requestedProviderIds.size > 0) {
        const foundProviderIds = new Set(providers.map((provider) => provider.id));
        const missingProviderId = [...requestedProviderIds].find((providerId) => !foundProviderIds.has(providerId));
        throw new FridayDomainError("PROVIDER_NOT_FOUND", `Provider "${missingProviderId ?? "unknown"}" not found`, {
          httpStatus: 404,
        });
      }
      const providerValidations: FridayProviderCapabilityDoctorReport["providerValidations"] = [];
      const capabilityResults: FridayProviderCapabilityDoctorProbeResult[] = [];

      for (const provider of providers) {
        let validation: FridayProviderValidationState;
        try {
          validation = await service.validateProvider(provider.id, { tenantContext });
        } catch (err) {
          validation = {
            status: "failed",
            checkedAt,
            errorCode: err instanceof FridayDomainError
              ? err.code
              : "PROVIDER_UNKNOWN_ERROR",
            errorMessage: err instanceof Error ? err.message : String(err),
          };
        }

        providerValidations.push({
          providerId: provider.id,
          providerKind: provider.kind,
          validation,
        });

        const latestProvider = deps.db.withReadConnection((db) =>
          profileRepo.getById(db, provider.id),
        ) ?? provider;
        const targets = listCapabilityDoctorTargets(latestProvider);
        const providerCapabilityResults: FridayProviderCapabilityDoctorProbeResult[] = [];
        for (const target of targets) {
          const result = await probeProviderCapability({
            profile: latestProvider,
            target,
            validation,
            checkedAt,
            tenantContext,
          });
          providerCapabilityResults.push(result);
          capabilityResults.push(result);
        }

        if (providerCapabilityResults.length > 0) {
          const updated: FridayProviderProfile = normalizeProviderConfig({
            ...latestProvider,
            config: {
              ...latestProvider.config,
              runtimeCapabilities: mergeCapabilityDoctorResults(
                latestProvider.config.runtimeCapabilities,
                providerCapabilityResults,
              ),
            },
            updatedAt: checkedAt,
          });
          deps.db.withWriteTransaction((db) => {
            profileRepo.update(db, updated);
          });
        }
      }

      return {
        checkedAt,
        providerValidations,
        capabilityResults,
      };
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
      let {
        providers: currentProviders,
        pinnedProvider,
        candidates,
      } = await buildValidatedRouteCandidates({
        routing,
        providers,
        requestedModel: input.requestedModel,
        requestedProviderId: input.requestedProviderId,
        tenantContext: input.tenantContext,
        autoValidate: false,
      });
      const requiredCapabilities = input.routingContext?.requiredCapabilities;
      let candidatesBeforeCapabilityFilter = candidates;
      let candidatesAfterCapabilityFilter = applyRequiredCapabilityFilter({
        candidates,
        requiredCapabilities,
      });
      let capabilityFilterRemovedAllCandidates =
        candidatesBeforeCapabilityFilter.length > 0
        && candidatesAfterCapabilityFilter.length === 0
        && Boolean(requiredCapabilities?.length);

      candidates = candidatesAfterCapabilityFilter;
      const requiresNativeTools = input.routingContext?.requiresNativeTools === true;
      if (candidates.length === 0) {
        throw new FridayDomainError(
          "PROVIDER_NO_CANDIDATES",
          capabilityFilterRemovedAllCandidates
            ? explainRequiredCapabilityNoCandidates(requiredCapabilities)
            : pinnedProvider
            ? explainPinnedProviderNoCandidates(pinnedProvider, input.requestedModel)
            : explainNoCandidates(routing, currentProviders),
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
        costMode: routing.costMode,
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
        costMode: routing.costMode,
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
              : explainNoCandidates(routing, currentProviders),
          { httpStatus: 400 },
        );
      }

      return {
        ...(input.requestedProviderId ? { requestedProviderId: input.requestedProviderId } : {}),
        ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
        ...(input.routingContext?.taskProfileId ? { taskProfileId: input.routingContext.taskProfileId } : {}),
        costMode: traceBuilder.trace.costMode,
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
          : resolveKeySourceInput(input.apiKey, { preserveEnvRef: input.preserveEnvRef });
      let keySource = keyInput.keySource;

      const config: FridayProviderConfigJson = {
        api: input.api,
        authMode: input.authMode,
        backendKind,
        deploymentKind: input.deploymentKind ?? preset.deploymentKind,
        regionTag: input.regionTag ?? preset.regionTag,
        ...(input.authMode === "oauth" ? { oauthProvider: defaultOAuthProviderForKind(input.kind) } : {}),
        keySource: keySource.kind === "secret-ref" && keyInput.inlineSecret !== null
          ? { kind: "secret-ref", refKey: secretRefKey(id) }
          : keySource,
        supportedModels: normalizeFridayProviderSupportedModels(input.supportedModels),
        headers: input.headers,
        runtimeCapabilities: normalizeUserDeclaredRuntimeCapabilities(input.runtimeCapabilities),
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
        const nextKeyInput = resolveKeySourceInput(patch.apiKey, { preserveEnvRef: patch.preserveEnvRef });
        keySource = nextKeyInput.keySource;
        inlineSecret = nextKeyInput.inlineSecret;
        if (keySource.kind === "secret-ref" && inlineSecret !== null) {
          keySource = { kind: "secret-ref", refKey: secretRefKey(providerId) };
        }
      }

      // Determine oauthProvider field
      let oauthProvider = existing.config.oauthProvider;
      if (newAuthMode === "oauth") {
        // Preserve existing or default by provider family.
        oauthProvider = oauthProvider ?? defaultOAuthProviderForKind(existing.kind);
      } else if (oldAuthMode === "oauth") {
        // Switching away from OAuth — clear OAuth credentials and oauthProvider
        oauthTokenManager.clearProviderProfile(providerId);
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
        runtimeCapabilities: patch.runtimeCapabilities !== undefined
          ? normalizeUserDeclaredRuntimeCapabilities(patch.runtimeCapabilities)
          : existing.config.runtimeCapabilities,
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
      oauthTokenManager.clearProviderProfile(providerId);

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

    async validateProvider(providerId, options) {
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
        backendKind: profile.config.backendKind,
        cliConfig: profile.config.cliConfig,
      });

      let credential: string | null = null;
      if ((profile.config.backendKind ?? "http") === "cli") {
        const state = await validateCliProvider(profile);
        profile.config.validation = state;
        deps.db.withWriteTransaction((db) => {
          profileRepo.update(db, normalizeProviderConfig(profile));
        });
        return state;
      }
      try {
        const tenantContext = options?.tenantContext
          ?? (options?.ownerUserId
            ? { hubId: options.ownerUserId, userId: options.ownerUserId }
            : undefined);
        credential = await resolveCredential(profile, tenantContext);
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
      const existingRouting = loadRoutingConfig();
      const validated = validateRoutingConfig({
        ...input,
        costMode: input.costMode ?? existingRouting?.costMode,
      });
      saveRoutingConfig(validated);
      return normalizeFridayModelRoutingConfig(validated);
    },

    async resolveRoute(requestedModel, requestedProviderId, options) {
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
      const {
        providers: currentProviders,
        pinnedProvider,
        candidates,
      } = await buildValidatedRouteCandidates({
        routing,
        providers,
        requestedModel,
        requestedProviderId,
        tenantContext: options?.tenantContext,
        autoValidate: options?.autoValidate !== false,
      });
      if (candidates.length === 0) {
        throw new FridayDomainError(
          "PROVIDER_NO_CANDIDATES",
          pinnedProvider
            ? explainPinnedProviderNoCandidates(pinnedProvider, requestedModel)
            : explainNoCandidates(routing, currentProviders),
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
      let {
        providers: currentProviders,
        pinnedProvider,
        candidates,
      } = await buildValidatedRouteCandidates({
        routing,
        providers,
        requestedModel: params.requestedModel,
        requestedProviderId: params.requestedProviderId,
        tenantContext: params.tenantContext,
        autoValidate: true,
      });
      const prefetchedCredentialHandles = new Map<string, string>();
      const requiredCapabilities = params.routingContext?.requiredCapabilities;
      let candidatesBeforeCapabilityFilter = candidates;
      let candidatesAfterCapabilityFilter = applyRequiredCapabilityFilter({
        candidates,
        requiredCapabilities,
      });
      let capabilityFilterRemovedAllCandidates =
        candidatesBeforeCapabilityFilter.length > 0
        && candidatesAfterCapabilityFilter.length === 0
        && Boolean(requiredCapabilities?.length);

      if (capabilityFilterRemovedAllCandidates && allowImplicitProviderStateMutation) {
        await service.runCapabilityDoctor({
          tenantContext: params.tenantContext,
        });
        currentProviders = deps.db.withReadConnection((db) =>
          profileRepo.list(db),
        );
        ({
          providers: currentProviders,
          pinnedProvider,
          candidates,
        } = await buildValidatedRouteCandidates({
          routing,
          providers: currentProviders,
          requestedModel: params.requestedModel,
          requestedProviderId: params.requestedProviderId,
          tenantContext: params.tenantContext,
          autoValidate: false,
        }));
        candidatesBeforeCapabilityFilter = candidates;
        candidatesAfterCapabilityFilter = applyRequiredCapabilityFilter({
          candidates,
          requiredCapabilities,
        });
        capabilityFilterRemovedAllCandidates =
          candidatesBeforeCapabilityFilter.length > 0
          && candidatesAfterCapabilityFilter.length === 0
          && Boolean(requiredCapabilities?.length);
      }
      candidates = candidatesAfterCapabilityFilter;
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
              const issued = credentialHandles.issue(prepared.credential, {
                providerId: candidate.provider.id,
                purpose: "provider-prefetch",
              });
              prefetchedCredentialHandles.set(candidate.provider.id, issued.handleId);
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
          capabilityFilterRemovedAllCandidates
            ? explainRequiredCapabilityNoCandidates(requiredCapabilities)
            : pinnedProvider
            ? explainPinnedProviderNoCandidates(pinnedProvider, params.requestedModel)
            : explainNoCandidates(routing, currentProviders),
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
        costMode: routing.costMode,
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
        costMode: routing.costMode,
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
              : explainNoCandidates(routing, currentProviders),
          { httpStatus: 400 },
        );
      }

      const fallbackResult = await fallback.runWithFallback({
        candidates,
        run: async (route) => {
          const prefetchedHandleId = prefetchedCredentialHandles.get(route.provider.id);
          if (prefetchedHandleId) {
            prefetchedCredentialHandles.delete(route.provider.id);
            return credentialHandles.use(prefetchedHandleId, (credential) =>
              params.run(route, credential),
            );
          }
          const credential = await resolveCredential(route.provider, params.tenantContext);
          return params.run(route, credential);
        },
      });

      return {
        ...fallbackResult,
        routingDecision: {
          ...routingDecision,
          orderedCandidates: candidates,
          costMode: traceBuilder.trace.costMode,
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
      // Truth: never attribute usage to a real provider kind we cannot confirm.
      // If the profile is gone (deleted/disabled between the call and this
      // fire-and-forget write), record an explicit "unknown" kind, not OpenAI.
      const providerKind = provider?.kind ?? "unknown";
      if (!provider) {
        console.warn(
          `[friday] recordUsage: provider profile ${input.providerId} not found; `
            + "recording providerKind=\"unknown\" (no provider attribution).",
        );
      }
      // D (ledger truth): record whether pricing was actually RESOLVED for the
      // attributed (providerKind, model). An unrecognized model resolves to
      // qualityTier "unknown" with a 0 rate (friday-provider-pricing-catalog
      // fallback), which is otherwise indistinguishable from a genuinely-free
      // model (e.g. local ollama, tier "cheap" @ $0). Without this marker an
      // unpriced paid model silently under-reports cost as $0. We persist an
      // explicit boolean computed from the SAME single-source pricing catalog,
      // consistent with the record's stored providerKind: if the provider could
      // not be attributed (providerKind "unknown") pricing is unresolved by
      // definition — a conservative fail-closed signal. NOTE: this means
      // "pricing resolvable for the attributed provider/model", NOT a guarantee
      // that the stored costUsd was itself computed from this exact resolution.
      const pricingResolved =
        providerKind !== "unknown"
        && pricingCatalog.getPricing(providerKind, input.model).qualityTier !== "unknown";
      const now = deps.nowIso();
      const usageDay = now.slice(0, 10);
      const usageMonth = now.slice(0, 7);

      // A receipt is bound to the provider's own request-id, so it can only be
      // minted when one was surfaced. Calls without a request-id (local/legacy)
      // are recorded without a receipt rather than with a fabricated one.
      const requestId =
        typeof input.requestId === "string" && input.requestId.trim().length > 0
          ? input.requestId
          : null;
      const receipt = requestId
        ? buildProviderCallReceipt({
            requestId,
            providerId: input.providerId,
            providerKind,
            model: input.model,
            inputTokens: input.usage.input,
            outputTokens: input.usage.output,
            totalTokens: input.usage.total,
            costUsd: input.costUsd,
            occurredAt: now,
          })
        : null;

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
        requestId,
        runId: input.runId ?? null,
        turnId: input.turnId ?? null,
        receipt,
        // Computed marker goes LAST so a caller-supplied metadata.pricingResolved
        // cannot spoof the ledger's truth signal.
        metadata: { ...(input.metadata ?? {}), pricingResolved },
        createdAt: now,
      };

      // Idempotent on request-id: the insert is a no-op when a row for this
      // request-id already exists (retry/replay), so it never double-counts.
      const { inserted } = deps.db.withWriteTransaction((db) =>
        usageRepo.insert(db, record),
      );

      return {
        recorded: inserted,
        duplicate: requestId !== null && !inserted,
        requestId,
        receipt,
      };
    },

    async getCallReceipt(requestId): Promise<FridayProviderCallReceiptLookup | null> {
      if (!requestId || requestId.trim().length === 0) {
        return null;
      }
      const record = deps.db.withReadConnection((db) =>
        usageRepo.getByRequestId(db, requestId),
      );
      if (!record) return null;
      const receipt = projectProviderCallReceipt(record);
      if (!receipt) return null;
      return {
        receipt,
        receiptValid: verifyProviderCallReceipt(record),
      };
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

      const oauthProvider = profile.config.oauthProvider ?? defaultOAuthProviderForKind(profile.kind);
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

      const oauthProvider = profile.config.oauthProvider ?? defaultOAuthProviderForKind(profile.kind);
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
        ownerUserId: input.ownerUserId ?? FRIDAY_GLOBAL_OAUTH_OWNER_USER_ID,
        oauthProvider,
        tokenSet,
      });

      // Post-exchange validation: verify the access token works
      let validation: FridayProviderValidationState;
      try {
        validation = await validator.validate({
          kind: profile.kind,
          api: profile.config.api,
          baseUrl: profile.baseUrl,
          credential: tokenSet.accessToken,
          model: profile.defaultModel,
          authMode: "oauth",
        });
        profile.config.validation = validation;
      } catch (err) {
        console.warn("[friday][provider-service] post-login validation failed:", err instanceof Error ? err.message : String(err));
        validation = {
          status: "failed",
          checkedAt: deps.nowIso(),
          errorCode: "PROVIDER_UNREACHABLE",
          errorMessage: "Post-login validation failed; token may still be valid",
        };
        profile.config.validation = validation;
      }

      deps.db.withWriteTransaction((db) => {
        profileRepo.update(db, profile);
      });

      const runtimeReady = validation.status === "ok";
      return {
        providerId: profile.id,
        oauthProvider,
        connected: runtimeReady,
        runtimeReady,
        validation,
        expiresAt: tokenSet.expiresAt,
        tokenType: tokenSet.tokenType,
        scope: tokenSet.scope,
        metadata: tokenSet.metadata,
      };
    },

    async initiateOAuthDeviceAuthorization(input): Promise<FridayOAuthDeviceAuthorizationRequest> {
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

      const oauthProvider = profile.config.oauthProvider ?? defaultOAuthProviderForKind(profile.kind);
      const adapter = oauthProviderRegistry.get(oauthProvider);
      if (!adapter?.initiateDeviceAuthorization) {
        throw new FridayDomainError(
          "UNSUPPORTED_OPERATION",
          `OAuth adapter '${oauthProvider}' does not support device-code login`,
          { httpStatus: 400 },
        );
      }

      const deviceAuthorization = await adapter.initiateDeviceAuthorization();
      pendingOAuthDeviceAuthorizations.set(deviceAuthorization.deviceCodeId, {
        providerId: profile.id,
        ownerUserId: input.ownerUserId,
        oauthProvider,
      });
      return {
        ...deviceAuthorization,
        providerId: profile.id,
        oauthProvider,
      };
    },

    async completeOAuthDeviceAuthorization(input): Promise<FridayOAuthLoginResult> {
      const pending = pendingOAuthDeviceAuthorizations.get(input.deviceCodeId);
      if (!pending || pending.providerId !== input.providerId || pending.ownerUserId !== input.ownerUserId) {
        throw new FridayDomainError(
          "OAUTH_UNKNOWN_STATE",
          "No pending device-code OAuth login found for this provider and user",
          { httpStatus: 400 },
        );
      }

      const profile = deps.db.withReadConnection((db) =>
        profileRepo.getById(db, input.providerId),
      );
      if (!profile) {
        pendingOAuthDeviceAuthorizations.delete(input.deviceCodeId);
        throw new FridayDomainError("PROVIDER_NOT_FOUND", "Provider not found", {
          httpStatus: 404,
        });
      }

      const oauthProvider = profile.config.oauthProvider ?? defaultOAuthProviderForKind(profile.kind);
      const adapter = oauthProviderRegistry.get(oauthProvider);
      if (!adapter?.completeDeviceAuthorization) {
        throw new FridayDomainError(
          "UNSUPPORTED_OPERATION",
          `OAuth adapter '${oauthProvider}' does not support device-code login`,
          { httpStatus: 400 },
        );
      }

      const tokenSet = await adapter.completeDeviceAuthorization({
        deviceCodeId: input.deviceCodeId,
      });
      pendingOAuthDeviceAuthorizations.delete(input.deviceCodeId);

      oauthTokenManager.saveTokenSet({
        providerProfileId: profile.id,
        ownerUserId: input.ownerUserId,
        oauthProvider,
        tokenSet,
      });

      let validation: FridayProviderValidationState;
      try {
        validation = await validator.validate({
          kind: profile.kind,
          api: profile.config.api,
          baseUrl: profile.baseUrl,
          credential: tokenSet.accessToken,
          model: profile.defaultModel,
          authMode: "oauth",
        });
        profile.config.validation = validation;
      } catch (err) {
        console.warn("[friday][provider-service] post-device-login validation failed:", err instanceof Error ? err.message : String(err));
        validation = {
          status: "failed",
          checkedAt: deps.nowIso(),
          errorCode: "PROVIDER_UNREACHABLE",
          errorMessage: "Post-device-login validation failed; token may still be valid",
        };
        profile.config.validation = validation;
      }

      deps.db.withWriteTransaction((db) => {
        profileRepo.update(db, profile);
      });

      const runtimeReady = validation.status === "ok";
      return {
        providerId: profile.id,
        oauthProvider,
        connected: runtimeReady,
        runtimeReady,
        validation,
        expiresAt: tokenSet.expiresAt,
        tokenType: tokenSet.tokenType,
        scope: tokenSet.scope,
        metadata: tokenSet.metadata,
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

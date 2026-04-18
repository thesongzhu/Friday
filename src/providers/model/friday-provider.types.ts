// ─── Provider kinds & API protocols ───
import type {
  FridayAutonomyCanaryStats,
  FridayAutonomyCompatibilityStatus,
  FridayAutonomyPromotionChannel,
} from "../../autonomy/model/friday-autonomy-upgrade.types.js";

/**
 * Provider kinds supported by Friday.
 *
 * Design note:
 * - `kind` identifies ecosystem/provider family (OpenClaw parity-oriented).
 * - transport/protocol behavior is governed by `config.api`.
 */
export const FRIDAY_PROVIDER_KINDS = [
  "openai",
  "openai-codex",
  "anthropic",
  "google",
  "google-vertex",
  "google-antigravity",
  "openrouter",
  "xai",
  "mistral",
  "groq",
  "cerebras",
  "github-copilot",
  "huggingface",
  "opencode",
  "vercel-ai-gateway",
  "kilocode",
  "moonshot",
  "kimi-coding",
  "qwen",
  "qwen-portal",
  "volcengine",
  "byteplus",
  "synthetic",
  "minimax",
  "ollama",
  "vllm",
  "litellm",
  "together",
  "nvidia",
  "qianfan",
  "venice",
  "xiaomi",
  "zai",
  "glm",
  "deepseek",
  "bedrock",
  "cloudflare-ai-gateway",
  "openai-compatible",
] as const;

export type FridayProviderKind =
  (typeof FRIDAY_PROVIDER_KINDS)[number];

export const FRIDAY_PROVIDER_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "ollama",
] as const;

export type FridayProviderApi =
  (typeof FRIDAY_PROVIDER_APIS)[number];

export const FRIDAY_PROVIDER_BACKEND_KINDS = ["http", "cli", "sdk"] as const;

export type FridayProviderBackendKind =
  (typeof FRIDAY_PROVIDER_BACKEND_KINDS)[number];

export type FridayProviderDeploymentKind =
  | "hosted"
  | "local"
  | "self-hosted"
  | "consumer-cli";

export type FridayProviderRegionTag =
  | "global"
  | "us"
  | "china"
  | "local"
  | "custom";

export const FRIDAY_PROVIDER_CLI_BACKEND_IDS = [
  "codex-cli",
  "claude-cli",
] as const;

export type FridayProviderCliBackendId =
  (typeof FRIDAY_PROVIDER_CLI_BACKEND_IDS)[number];

export type FridayProviderAuthMode =
  | "api-key"
  | "bearer-token"
  | "oauth"
  | "token"
  | "external-session"
  | "none";

export type FridayAnthropicBearerAuthMode = "oauth" | "token";

export function isFridayAnthropicBearerAuthMode(
  authMode: FridayProviderAuthMode | undefined,
): authMode is FridayAnthropicBearerAuthMode {
  return authMode === "oauth" || authMode === "token";
}

// ─── Key source discriminated union ───

export type FridayProviderKeySource =
  | { kind: "secret-ref"; refKey: string }
  | { kind: "env-ref"; envVar: string }
  | { kind: "file-ref"; path: string }
  | { kind: "command-ref"; command: string }
  | { kind: "none" };

export type FridayProviderTemplateTier =
  | "official"
  | "verified"
  | "community"
  | "experimental";

export type FridayProviderTemplateStatus =
  | "ready"
  | "requires_configuration"
  | "experimental";

export type FridayProviderTemplateSecretRefKind =
  | "inline"
  | "env-ref"
  | "secret-ref"
  | "file-ref"
  | "command-ref";

export interface FridayProviderTemplateSecretRequirement {
  key: string;
  label: string;
  required: boolean;
  acceptedRefs: FridayProviderTemplateSecretRefKind[];
  helpText?: string;
}

export interface FridayProviderTemplateModelDefaults {
  recommended?: string;
  fallback?: string;
  examples: string[];
}

export interface FridayProviderTemplate {
  id: string;
  providerKind: FridayProviderKind;
  displayName: string;
  description: string;
  tier: FridayProviderTemplateTier;
  status: FridayProviderTemplateStatus;
  api: FridayProviderApi;
  backendKind: FridayProviderBackendKind;
  deploymentKind: FridayProviderDeploymentKind;
  regionTag: FridayProviderRegionTag;
  authModes: FridayProviderAuthMode[];
  baseUrlHints: string[];
  modelDefaults: FridayProviderTemplateModelDefaults;
  reasoningHints: string[];
  requiredSecrets: FridayProviderTemplateSecretRequirement[];
}

// ─── Validation state ───

export interface FridayProviderValidationState {
  status: "never" | "ok" | "failed";
  checkedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  httpStatus?: number;
}

// ─── OAuth types ───

export type FridayOAuthProviderId = "anthropic";

export interface FridayOAuthAuthorizationRequest {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  scopes: string[];
}

export interface FridayOAuthTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  tokenType: string;
  scope: string;
}

export interface FridayOAuthCredential {
  id: string;
  providerProfileId: string;
  oauthProvider: FridayOAuthProviderId;
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scope: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridayOAuthCredentialRow {
  id: string;
  provider_profile_id: string;
  oauth_provider: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  token_type: string;
  scope: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface FridayOAuthLoginInitiation extends FridayOAuthAuthorizationRequest {
  providerId: string;
  oauthProvider: FridayOAuthProviderId;
}

export interface FridayOAuthLoginResult {
  providerId: string;
  oauthProvider: FridayOAuthProviderId;
  connected: true;
  expiresAt: string;
  tokenType: string;
  scope: string;
}

// ─── Structured config (stored as config_json) ───

export interface FridayProviderHttpConfig {
  headersPolicy?: "default" | "custom";
  timeoutMs?: number;
}

export interface FridayProviderCliConfig {
  backendId: FridayProviderCliBackendId;
  binaryPath?: string;
  fixedArgProfile?: string;
  envAllowlist?: string[];
  cwdPolicy?: "workspace" | "process";
}

export interface FridayProviderSdkConfig {
  backendId: string;
  packageName?: string;
  runtimeHints?: Record<string, string | number | boolean>;
}

export interface FridayProviderConfigJson {
  api: FridayProviderApi;
  authMode: FridayProviderAuthMode;
  oauthProvider?: FridayOAuthProviderId;
  backendKind?: FridayProviderBackendKind;
  deploymentKind?: FridayProviderDeploymentKind;
  regionTag?: FridayProviderRegionTag;
  keySource: FridayProviderKeySource;
  supportedModels: string[];
  headers?: Record<string, string>;
  httpConfig?: FridayProviderHttpConfig;
  cliConfig?: FridayProviderCliConfig;
  sdkConfig?: FridayProviderSdkConfig;
  validation?: FridayProviderValidationState;
}

// ─── Provider profile (domain entity) ───

export interface FridayProviderProfile {
  id: string;
  kind: FridayProviderKind;
  name: string;
  baseUrl: string;
  enabled: boolean;
  defaultModel?: string;
  config: FridayProviderConfigJson;
  lastVerifiedAt?: string;
  lastVerifiedRuntimeVersion?: string;
  lastVerifiedProviderModel?: string;
  compatibilityStatus?: FridayAutonomyCompatibilityStatus;
  promotionChannel?: FridayAutonomyPromotionChannel;
  shadowVersionId?: string;
  canaryStats?: FridayAutonomyCanaryStats;
  createdAt: string;
  updatedAt: string;
}

// ─── Routing config (persisted in hub_settings) ───

export interface FridayModelRoutingConfig {
  defaultProviderId: string;
  defaultModel?: string;
  fallbackProviderIds: string[];
  /** OC-002: When true, cost-routing cannot override the user's requested model. */
  enforceRequestedModel?: boolean;
}

function normalizeFridayStringList(input: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const raw of input) {
    if (typeof raw !== "string") {
      continue;
    }
    const value = raw.trim();
    if (value.length === 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

export function normalizeFridayProviderSupportedModels(
  input: readonly string[] | null | undefined,
): string[] {
  return normalizeFridayStringList(input);
}

export function resolveFridayProviderPreferredModel(
  provider: Pick<FridayProviderProfile, "defaultModel" | "config">,
): string | undefined {
  return provider.defaultModel ?? normalizeFridayProviderSupportedModels(provider.config.supportedModels)[0];
}

export function normalizeFridayModelRoutingConfig(
  input: Partial<FridayModelRoutingConfig> | null | undefined,
): FridayModelRoutingConfig {
  const defaultProviderId = typeof input?.defaultProviderId === "string"
    ? input.defaultProviderId.trim()
    : "";
  const defaultModel = typeof input?.defaultModel === "string"
    ? input.defaultModel.trim()
    : undefined;

  return {
    defaultProviderId,
    ...(defaultModel ? { defaultModel } : {}),
    fallbackProviderIds: normalizeFridayStringList(input?.fallbackProviderIds),
    ...(input?.enforceRequestedModel !== undefined
      ? { enforceRequestedModel: Boolean(input.enforceRequestedModel) }
      : {}),
  };
}

// ─── Fallback attempt tracking ───

/** Reason category for a provider failure. */
export type FridayProviderAttemptReason = "transient" | "auth" | "model_unavailable" | "timeout" | "unknown";

export interface FridayProviderAttempt {
  providerId: string;
  providerKind: FridayProviderKind;
  model: string;
  error?: string;
  /** OC-001: Structured failure reason. */
  reason?: FridayProviderAttemptReason;
  /** OC-001: HTTP status code of the failed request. */
  status?: number;
  /** OC-001: Error code from the provider (e.g. "rate_limit_exceeded"). */
  code?: string;
  /** OC-001: When the attempt failed (ISO 8601). */
  timestamp?: string;
}

// ─── Resolved route ───

export interface FridayResolvedProviderRoute {
  provider: FridayProviderProfile;
  model: string;
}

// ─── Provider doctor / CLI session health ───

export type FridayProviderHealthStatus =
  | "healthy"
  | "degraded"
  | "missing"
  | "unsupported"
  | "status_unknown";

export interface FridayCliSessionAccountMetadata {
  email?: string;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;
  authMethod?: string;
}

export interface FridayCliSessionStatus {
  backendId: FridayProviderCliBackendId;
  binaryPath?: string;
  status: FridayProviderHealthStatus;
  version?: string;
  loggedIn?: boolean;
  checkedAt: string;
  message?: string;
  account?: FridayCliSessionAccountMetadata;
}

export interface FridayProviderDoctorReport {
  providerId: string;
  providerKind: FridayProviderKind;
  backendKind: FridayProviderBackendKind;
  authMode: FridayProviderAuthMode;
  checkedAt: string;
  backendHealth: FridayProviderHealthStatus;
  authHealth: FridayProviderHealthStatus;
  routingEligible: boolean;
  reasons: string[];
  activeProfileKey?: string;
  cliSession?: FridayCliSessionStatus;
}

export type FridayProviderLane =
  | "primary"
  | "fallback"
  | "standby"
  | "disabled";

export type FridayProviderCircuitState =
  | "closed"
  | "cooldown"
  | "unknown";

export interface FridayProviderHealthSnapshotItem {
  providerId: string;
  providerKind: FridayProviderKind;
  lane: FridayProviderLane;
  enabled: boolean;
  defaultModel?: string;
  backendKind: FridayProviderBackendKind;
  authMode: FridayProviderAuthMode;
  backendHealth: FridayProviderHealthStatus;
  authHealth: FridayProviderHealthStatus;
  routingEligible: boolean;
  validationStatus: FridayProviderValidationState["status"];
  circuitState: FridayProviderCircuitState;
  cooldownRemainingMs?: number;
  lastFailureAt?: string;
  reasons: string[];
  suggestedAction: string;
}

export type FridayProviderRoutingReasonCode =
  | "configured"
  | "historical_bias"
  | "operator_override"
  | "operator_penalty"
  | "budget_local_only"
  | "requested_provider"
  | "requested_model"
  | "backend_capability_gating";

export interface FridayProviderRoutingExplainCandidate {
  providerId: string;
  providerKind: FridayProviderKind;
  model: string;
  backendKind: FridayProviderBackendKind;
  originalRank: number;
  finalRank: number;
  selected: boolean;
  eligible: boolean;
  ineligibilityReasons: string[];
  pinned: boolean;
  routePenalty?: number;
  historicalSuccessRate?: number;
  historicalFailureRate?: number;
  sampleCount?: number;
  baseRankScore: number;
  historyScore: number;
  patternScore: number;
  lessonScore: number;
  routePenaltyScore: number;
  pinBonus: number;
  finalScore: number;
  historyStats?: {
    sampleCount: number;
    successRate: number;
    failureRate: number;
  };
  matchedLessonIds: string[];
  matchedPatternIds: string[];
}

export interface FridayProviderRoutingSelection {
  providerId: string;
  providerKind: FridayProviderKind;
  model: string;
  backendKind: FridayProviderBackendKind;
}

export interface FridayProviderRoutingHistoryWindow {
  sampleLimit: number;
}

export interface FridayProviderRoutingDecisionTrace {
  taskProfileId?: string;
  requiresNativeTools: boolean;
  learningAdjusted: boolean;
  learningSignalsPresent: boolean;
  orderingAdjusted: boolean;
  selectedAdjusted: boolean;
  reasonCode: FridayProviderRoutingReasonCode;
  reasonText: string;
  historyWindow: FridayProviderRoutingHistoryWindow;
  selectedBeforeLearning?: FridayProviderRoutingSelection;
  selectedAfterLearning?: FridayProviderRoutingSelection;
  candidateScores: FridayProviderRoutingExplainCandidate[];
}

export interface FridayProviderRoutingExplainReport {
  requestedProviderId?: string;
  requestedModel?: string;
  taskProfileId?: string;
  requiresNativeTools: boolean;
  selectedBeforeLearning?: FridayProviderRoutingSelection;
  selectedAfterLearning?: FridayProviderRoutingSelection;
  selected?: FridayProviderRoutingExplainCandidate;
  candidates: FridayProviderRoutingExplainCandidate[];
  candidateScores: FridayProviderRoutingExplainCandidate[];
  learningAdjusted: boolean;
  learningSignalsPresent: boolean;
  orderingAdjusted: boolean;
  selectedAdjusted: boolean;
  reasonCode: FridayProviderRoutingReasonCode;
  reason: string;
  reasonText: string;
  historyWindow: FridayProviderRoutingHistoryWindow;
}

// ─── DB row shapes (SQLite) ───

export interface FridayProviderProfileRow {
  id: string;
  kind: string;
  display_name: string;
  endpoint_url: string | null;
  enabled: number;
  default_model: string | null;
  config_json: string | null;
  last_verified_at: string | null;
  last_verified_runtime_version: string | null;
  last_verified_provider_model: string | null;
  compatibility_status: string;
  promotion_channel: string;
  shadow_version_id: string | null;
  canary_stats_json: string;
  created_at: string;
  updated_at: string;
}

export interface FridaySecretRow {
  id: string;
  scope: string;
  ref_key: string;
  encrypted_value: string;
  key_id: string;
  expires_at: string | null;
  rotated_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Auth profile store ───

export interface FridayAuthProfile {
  id: string;
  providerProfileId: string;
  providerKind: FridayProviderKind;
  profileKey: string;
  label: string;
  authMode: FridayProviderAuthMode;
  keySource: FridayProviderKeySource;
  oauthProvider?: FridayOAuthProviderId;
  isActive: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface FridayAuthProfileRow {
  id: string;
  provider_profile_id: string;
  provider_kind: string;
  profile_key: string;
  display_label: string;
  auth_mode: string;
  key_source_json: string | null;
  oauth_provider: string | null;
  is_active: number;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Validation error codes ───

export type FridayProviderValidationErrorCode =
  | "PROVIDER_ENV_VAR_MISSING"
  | "PROVIDER_AUTH_INVALID"
  | "PROVIDER_PAYMENT_REQUIRED"
  | "PROVIDER_UNREACHABLE"
  | "PROVIDER_MODEL_UNAVAILABLE"
  | "PROVIDER_UNKNOWN_ERROR";

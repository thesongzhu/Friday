// ─── Provider kinds & API protocols ───

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
  "google-gemini-cli",
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

export type FridayProviderAuthMode = "api-key" | "bearer-token" | "oauth" | "none";

// ─── Key source discriminated union ───

export type FridayProviderKeySource =
  | { kind: "secret-ref"; refKey: string }
  | { kind: "env-ref"; envVar: string }
  | { kind: "none" };

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

export interface FridayProviderConfigJson {
  api: FridayProviderApi;
  authMode: FridayProviderAuthMode;
  oauthProvider?: FridayOAuthProviderId;
  keySource: FridayProviderKeySource;
  supportedModels: string[];
  headers?: Record<string, string>;
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

// ─── DB row shapes (SQLite) ───

export interface FridayProviderProfileRow {
  id: string;
  kind: string;
  display_name: string;
  endpoint_url: string | null;
  enabled: number;
  default_model: string | null;
  config_json: string | null;
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

// ─── Validation error codes ───

export type FridayProviderValidationErrorCode =
  | "PROVIDER_ENV_VAR_MISSING"
  | "PROVIDER_AUTH_INVALID"
  | "PROVIDER_UNREACHABLE"
  | "PROVIDER_MODEL_UNAVAILABLE"
  | "PROVIDER_UNKNOWN_ERROR";

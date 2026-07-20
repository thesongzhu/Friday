import type {
  FridayAuthProfile,
  FridayLlmBudgetConfig,
  FridayLlmBudgetStatus,
  FridayModelRoutingConfig,
  FridayOAuthDeviceAuthorizationRequest,
  FridayOAuthLoginInitiation,
  FridayOAuthLoginResult,
  FridayProviderApi,
  FridayProviderAuthMode,
  FridayProviderBackendKind,
  FridayProviderCapabilityDoctorReport,
  FridayProviderCapabilityHealthSnapshotItem,
  FridayProviderCapabilityHealthSnapshotSummary,
  FridayProviderCliConfig,
  FridayProviderDeploymentKind,
  FridayProviderDoctorReport,
  FridayProviderHealthSnapshotItem,
  FridayProviderKind,
  FridayProviderProfile,
  FridayProviderRegionTag,
  FridayProviderRoutingExplainReport,
  FridayProviderRuntimeCapabilityDeclaration,
  FridayProviderTemplate,
  FridayProviderUsageSummary,
  FridayProviderValidationState,
} from "#providers";

// ─── Request types ───

export interface FridayCreateProviderRequest {
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
}

export interface FridayUpdateProviderRequest {
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
}

export interface FridaySetRoutingConfigRequest {
  defaultProviderId: string;
  defaultModel?: string;
  fallbackProviderIds: string[];
  costMode?: FridayModelRoutingConfig["costMode"];
  enforceRequestedModel?: boolean;
}

export interface FridaySetBudgetConfigRequest {
  monthlyLimitUsd: number;
  planDigest?: string;
  idempotencyKey?: string;
  canonicalApproval?: unknown;
}

export interface FridayRunCapabilityDoctorRequest {
  providerIds?: string[];
}

export interface FridayProviderCanonicalGateEvidence {
  ticketId: string;
  actionDigest: string;
  approvalId: string;
  planDigest?: string;
}

// ─── Provider mutation plan / owner-confirm (CORE-RUNNABLE-001 / CORE-A CR-2) ───
//
// Two-step owner-confirmation protocol that lets a normal (non-operator) client
// SATISFY the canonical mutating-action gate for provider setup/routing writes
// without the gate ever being weakened:
//
//   1. POST /v1/providers/plan     → server sanitizes the intended parameters,
//                                    derives the plan + action digests itself, and
//                                    returns a secret-free human-readable summary.
//   2. POST /v1/providers/plan/confirm
//                                  → the SAME authenticated owner explicitly
//                                    confirms that exact plan digest; only then is a
//                                    signed, short-lived, single-use canonical
//                                    approval minted, bound to the server-computed
//                                    action digest.
//   3. the real mutation is replayed with `planDigest` + `canonicalApproval`; the
//      gate recomputes the action digest server-side from the request that actually
//      arrived, so any parameter drift fails closed.
//
// No field of these shapes ever carries an API key, token or other secret: the plan
// is built over `sanitizeProviderMutationParameters` output and the summary is an
// explicit, allow-listed, secret-free projection.

export type FridayProviderPlannableAction =
  | "providers.create"
  | "providers.update"
  | "providers.delete"
  | "providers.validate"
  | "providers.routing.set"
  | "providers.routing.pin"
  | "providers.routing.penalty.clear"
  | "providers.auth.profiles.activate"
  | "providers.oauth.openai_codex.device.initiate"
  | "providers.oauth.openai_codex.device.complete"
  | "capabilities.doctor";

export interface FridayPlanProviderMutationRequest {
  action: FridayProviderPlannableAction;
  /** Target provider id for update / delete / validate / auth-profile actions. */
  providerId?: string;
  /** Target auth-profile key for `providers.auth.profiles.activate`. */
  profileKey?: string;
  /** The exact body the follow-up mutation will send (control fields are ignored). */
  params?: Record<string, unknown> | null;
  /** Optional idempotency key; it MUST be replayed unchanged on the mutation. */
  idempotencyKey?: string;
}

export interface FridayProviderMutationPlan {
  planDigest: string;
  actionDigest: string;
  action: FridayProviderPlannableAction;
  surface: string;
  resourceId?: string;
  idempotencyKey?: string;
  /** Secret-free, human-readable description of exactly what will change. */
  humanReadableSummary: string[];
  /** True when this profile's canonical gate requires an owner confirmation. */
  approvalRequired: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface FridayPlanProviderMutationResponse {
  plan: FridayProviderMutationPlan;
}

export interface FridayConfirmProviderMutationRequest {
  planDigest: string;
  /** Must be exactly `true`: the explicit owner confirmation. Never defaulted. */
  confirm: boolean;
}

export interface FridayConfirmProviderMutationResponse {
  approval: {
    planDigest: string;
    actionDigest: string;
    action: FridayProviderPlannableAction;
    resourceId?: string;
    idempotencyKey?: string;
    confirmedAt: string;
    expiresAt: string;
    /** Signed, single-use canonical approval to replay on the mutation request. */
    canonicalApproval: unknown;
  };
}

// ─── Response types ───

export interface FridayListProvidersResponse {
  items: FridayProviderProfile[];
}

export interface FridayListProviderTemplatesResponse {
  items: FridayProviderTemplate[];
}

export interface FridayGetProviderTemplateResponse {
  template: FridayProviderTemplate;
}

export interface FridayGetProviderResponse {
  provider: FridayProviderProfile;
}

export interface FridayGetProviderHealthSnapshotResponse {
  items: FridayProviderHealthSnapshotItem[];
}

export interface FridayGetProviderCapabilityHealthSnapshotResponse {
  items: FridayProviderCapabilityHealthSnapshotItem[];
  summary: FridayProviderCapabilityHealthSnapshotSummary;
}

export type FridayRunCapabilityDoctorResponse = FridayProviderCapabilityDoctorReport & {
  canonicalGate?: FridayProviderCanonicalGateEvidence;
};

export interface FridayCreateProviderResponse {
  provider: FridayProviderProfile;
  validation?: FridayProviderValidationState;
  canonicalGate?: FridayProviderCanonicalGateEvidence;
}

export interface FridayUpdateProviderResponse {
  provider: FridayProviderProfile;
  validation?: FridayProviderValidationState;
  canonicalGate?: FridayProviderCanonicalGateEvidence;
}

export interface FridayDeleteProviderResponse {
  deleted: true;
  canonicalGate?: FridayProviderCanonicalGateEvidence;
}

export interface FridayValidateProviderResponse {
  validation: FridayProviderValidationState;
  canonicalGate?: FridayProviderCanonicalGateEvidence;
}

export interface FridayGetProviderDoctorResponse {
  doctor: FridayProviderDoctorReport;
}

export interface FridayGetProviderRoutingExplainResponse {
  explain: FridayProviderRoutingExplainReport;
}

export interface FridayPinProviderRouteRequest {
  taskProfileId?: string;
  providerId: string;
  model: string;
  backendKind: FridayProviderBackendKind;
  reason?: string;
}

export interface FridayPinProviderRouteResponse {
  pinned: true;
  canonicalGate?: FridayProviderCanonicalGateEvidence;
}

export interface FridayClearProviderRoutePenaltyRequest {
  taskProfileId?: string;
  providerId: string;
  model: string;
  backendKind: FridayProviderBackendKind;
}

export interface FridayClearProviderRoutePenaltyResponse {
  cleared: boolean;
  canonicalGate?: FridayProviderCanonicalGateEvidence;
}

export interface FridayListProviderAuthProfilesResponse {
  items: FridayAuthProfile[];
}

export interface FridayActivateProviderAuthProfileRequest {
  profileKey: string;
}

export interface FridayActivateProviderAuthProfileResponse {
  profile: FridayAuthProfile;
  canonicalGate?: FridayProviderCanonicalGateEvidence;
}

export interface FridayGetRoutingConfigResponse {
  routing: FridayModelRoutingConfig;
}

export interface FridaySetRoutingConfigResponse {
  routing: FridayModelRoutingConfig;
  canonicalGate?: FridayProviderCanonicalGateEvidence;
}

export interface FridayGetUsageSummaryResponse {
  summary: FridayProviderUsageSummary;
}

export interface FridayGetBudgetStatusResponse {
  budget: FridayLlmBudgetStatus;
}

export interface FridaySetBudgetConfigResponse {
  budget: FridayLlmBudgetConfig;
  canonicalGate?: FridayProviderCanonicalGateEvidence;
}

// ─── OAuth types ───

export interface FridayInitiateAnthropicOAuthRequest {
  providerId?: string;
  kind?: FridayProviderKind;
  name?: string;
  defaultModel?: string;
}

export interface FridayInitiateAnthropicOAuthResponse {
  oauth: FridayOAuthLoginInitiation;
  canonicalGate?: FridayProviderCanonicalGateEvidence;
}

export interface FridayCompleteAnthropicOAuthCallbackRequest {
  providerId?: string;
  kind?: FridayProviderKind;
  name?: string;
  defaultModel?: string;
  authorizationCode: string;
  state?: string;
}

export interface FridayCompleteAnthropicOAuthCallbackResponse {
  oauth: FridayOAuthLoginResult;
  canonicalGate?: FridayProviderCanonicalGateEvidence;
}

export interface FridayInitiateOpenAICodexDeviceOAuthRequest {
  providerId?: string;
  kind?: "openai-codex";
  name?: string;
  defaultModel?: string;
}

export interface FridayInitiateOpenAICodexDeviceOAuthResponse {
  oauth: FridayOAuthDeviceAuthorizationRequest;
  canonicalGate?: FridayProviderCanonicalGateEvidence;
}

export interface FridayCompleteOpenAICodexDeviceOAuthRequest {
  providerId?: string;
  kind?: "openai-codex";
  name?: string;
  defaultModel?: string;
  deviceCodeId: string;
}

export interface FridayCompleteOpenAICodexDeviceOAuthResponse {
  oauth: FridayOAuthLoginResult;
  canonicalGate?: FridayProviderCanonicalGateEvidence;
}

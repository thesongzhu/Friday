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
  enforceRequestedModel?: boolean;
}

export interface FridaySetBudgetConfigRequest {
  monthlyLimitUsd: number;
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

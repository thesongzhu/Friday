import type {
  FridayAuthProfile,
  FridayLlmBudgetConfig,
  FridayLlmBudgetStatus,
  FridayModelRoutingConfig,
  FridayOAuthLoginInitiation,
  FridayOAuthLoginResult,
  FridayProviderApi,
  FridayProviderAuthMode,
  FridayProviderBackendKind,
  FridayProviderCliConfig,
  FridayProviderDeploymentKind,
  FridayProviderDoctorReport,
  FridayProviderHealthSnapshotItem,
  FridayProviderKind,
  FridayProviderProfile,
  FridayProviderRegionTag,
  FridayProviderRoutingExplainReport,
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
  deploymentKind?: FridayProviderDeploymentKind;
  regionTag?: FridayProviderRegionTag;
  enabled?: boolean;
  validateOnSave?: boolean;
}

export interface FridaySetRoutingConfigRequest {
  defaultProviderId: string;
  defaultModel?: string;
  fallbackProviderIds: string[];
}

export interface FridaySetBudgetConfigRequest {
  monthlyLimitUsd: number;
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

export interface FridayCreateProviderResponse {
  provider: FridayProviderProfile;
  validation?: FridayProviderValidationState;
}

export interface FridayUpdateProviderResponse {
  provider: FridayProviderProfile;
  validation?: FridayProviderValidationState;
}

export interface FridayDeleteProviderResponse {
  deleted: true;
}

export interface FridayValidateProviderResponse {
  validation: FridayProviderValidationState;
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
}

export interface FridayClearProviderRoutePenaltyRequest {
  taskProfileId?: string;
  providerId: string;
  model: string;
  backendKind: FridayProviderBackendKind;
}

export interface FridayClearProviderRoutePenaltyResponse {
  cleared: boolean;
}

export interface FridayListProviderAuthProfilesResponse {
  items: FridayAuthProfile[];
}

export interface FridayActivateProviderAuthProfileRequest {
  profileKey: string;
}

export interface FridayActivateProviderAuthProfileResponse {
  profile: FridayAuthProfile;
}

export interface FridayGetRoutingConfigResponse {
  routing: FridayModelRoutingConfig;
}

export interface FridaySetRoutingConfigResponse {
  routing: FridayModelRoutingConfig;
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
}

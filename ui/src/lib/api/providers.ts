import { apiClient } from "./client";
import type {
  FridayProviderProfile,
  FridayProviderValidationState,
  FridayModelRoutingConfig,
  FridayOAuthLoginInitiation,
  FridayOAuthLoginResult,
  FridayProviderKind,
  FridayProviderAuthMode,
  FridayProviderApi,
  FridayProviderBackendKind,
  FridayProviderCliConfig,
  FridayProviderDoctorReport,
  FridayProviderHealthSnapshotItem,
  FridayProviderRoutingExplainReport,
  FridayProviderTemplate,
} from "./types";

// ─── Request types ───

export interface CreateProviderInput {
  kind: FridayProviderKind;
  name: string;
  baseUrl: string;
  authMode: FridayProviderAuthMode;
  api: FridayProviderApi;
  backendKind?: FridayProviderBackendKind;
  cliConfig?: FridayProviderCliConfig;
  deploymentKind?: "hosted" | "local" | "self-hosted" | "consumer-cli";
  regionTag?: "global" | "us" | "china" | "local" | "custom";
  apiKey?: string;
  supportedModels: string[];
  defaultModel?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  validateOnSave?: boolean;
}

export interface UpdateProviderInput {
  name?: string;
  baseUrl?: string;
  authMode?: FridayProviderAuthMode;
  api?: FridayProviderApi;
  backendKind?: FridayProviderBackendKind;
  cliConfig?: FridayProviderCliConfig;
  deploymentKind?: "hosted" | "local" | "self-hosted" | "consumer-cli";
  regionTag?: "global" | "us" | "china" | "local" | "custom";
  apiKey?: string;
  supportedModels?: string[];
  defaultModel?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  validateOnSave?: boolean;
}

export interface SetRoutingInput {
  defaultProviderId: string;
  defaultModel?: string;
  fallbackProviderIds: string[];
}

// ─── Response wrappers ───

interface ListProvidersResponse {
  items: FridayProviderProfile[];
}

interface ListProviderTemplatesResponse {
  items: FridayProviderTemplate[];
}

interface GetProviderTemplateResponse {
  template: FridayProviderTemplate;
}

interface GetProviderResponse {
  provider: FridayProviderProfile;
}

interface GetProviderHealthSnapshotResponse {
  items: FridayProviderHealthSnapshotItem[];
}

interface CreateProviderResponse {
  provider: FridayProviderProfile;
  validation?: FridayProviderValidationState;
}

interface UpdateProviderResponse {
  provider: FridayProviderProfile;
  validation?: FridayProviderValidationState;
}

interface DeleteProviderResponse {
  deleted: true;
}

interface ValidateProviderResponse {
  validation: FridayProviderValidationState;
}

interface GetRoutingResponse {
  routing: FridayModelRoutingConfig;
}

interface SetRoutingResponse {
  routing: FridayModelRoutingConfig;
}

interface InitiateOAuthResponse {
  oauth: FridayOAuthLoginInitiation;
}

interface CompleteOAuthResponse {
  oauth: FridayOAuthLoginResult;
}

interface GetProviderDoctorResponse {
  doctor: FridayProviderDoctorReport;
}

interface GetProviderRoutingExplainResponse {
  explain: FridayProviderRoutingExplainReport;
}

interface ListProviderAuthProfilesResponse {
  items: Array<{
    id: string;
    providerProfileId: string;
    providerKind: FridayProviderKind;
    profileKey: string;
    label: string;
    authMode: FridayProviderAuthMode;
    oauthProvider?: string;
    isActive: boolean;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }>;
}

interface ActivateProviderAuthProfileResponse {
  profile: ListProviderAuthProfilesResponse["items"][number];
}

export interface ExplainRoutingInput {
  requestedProviderId?: string;
  requestedModel?: string;
  taskProfileId?: string;
  estimatedInputTokens?: number;
  complexity?: "simple" | "medium" | "complex";
  requiresNativeTools?: boolean;
}

interface PinRouteInput {
  taskProfileId?: string;
  providerId: string;
  model: string;
  backendKind: FridayProviderBackendKind;
  reason?: string;
}

interface ClearRoutePenaltyInput {
  taskProfileId?: string;
  providerId: string;
  model: string;
  backendKind: FridayProviderBackendKind;
}

// ─── API ───

export const providersApi = {
  async listTemplates(): Promise<FridayProviderTemplate[]> {
    const data = await apiClient.get<ListProviderTemplatesResponse>("/v1/providers/templates");
    return data.items;
  },

  async getTemplate(templateId: string): Promise<FridayProviderTemplate> {
    const data = await apiClient.get<GetProviderTemplateResponse>(
      `/v1/providers/templates/${encodeURIComponent(templateId)}`,
    );
    return data.template;
  },

  async list(): Promise<FridayProviderProfile[]> {
    const data = await apiClient.get<ListProvidersResponse>("/v1/providers");
    return data.items;
  },

  async listHealth(): Promise<FridayProviderHealthSnapshotItem[]> {
    const data = await apiClient.get<GetProviderHealthSnapshotResponse>("/v1/providers/health");
    return data.items;
  },

  async create(input: CreateProviderInput): Promise<CreateProviderResponse> {
    return apiClient.post<CreateProviderInput, CreateProviderResponse>(
      "/v1/providers",
      input,
    );
  },

  async get(providerId: string): Promise<FridayProviderProfile> {
    const data = await apiClient.get<GetProviderResponse>(
      `/v1/providers/${encodeURIComponent(providerId)}`,
    );
    return data.provider;
  },

  async update(
    providerId: string,
    patch: UpdateProviderInput,
  ): Promise<UpdateProviderResponse> {
    return apiClient.patch<UpdateProviderInput, UpdateProviderResponse>(
      `/v1/providers/${encodeURIComponent(providerId)}`,
      patch,
    );
  },

  async remove(providerId: string): Promise<void> {
    await apiClient.del<DeleteProviderResponse>(
      `/v1/providers/${encodeURIComponent(providerId)}`,
    );
  },

  async validate(providerId: string): Promise<FridayProviderValidationState> {
    const data = await apiClient.post<Record<string, never>, ValidateProviderResponse>(
      `/v1/providers/${encodeURIComponent(providerId)}/validate`,
      {},
    );
    return data.validation;
  },

  async doctor(providerId: string): Promise<FridayProviderDoctorReport> {
    const data = await apiClient.get<GetProviderDoctorResponse>(
      `/v1/providers/${encodeURIComponent(providerId)}/doctor`,
    );
    return data.doctor;
  },

  async explainRouting(input: ExplainRoutingInput): Promise<FridayProviderRoutingExplainReport> {
    const params = new URLSearchParams();
    if (input.requestedProviderId) params.set("requestedProviderId", input.requestedProviderId);
    if (input.requestedModel) params.set("requestedModel", input.requestedModel);
    if (input.taskProfileId) params.set("taskProfileId", input.taskProfileId);
    if (typeof input.estimatedInputTokens === "number") params.set("estimatedInputTokens", String(input.estimatedInputTokens));
    if (input.complexity) params.set("complexity", input.complexity);
    if (typeof input.requiresNativeTools === "boolean") params.set("requiresNativeTools", String(input.requiresNativeTools));
    const qs = params.toString();
    const data = await apiClient.get<GetProviderRoutingExplainResponse>(
      `/v1/providers/routing/explain${qs ? `?${qs}` : ""}`,
    );
    return data.explain;
  },

  async pinRoute(input: PinRouteInput): Promise<void> {
    await apiClient.post<PinRouteInput, { pinned: true }>("/v1/providers/routing/pin", input);
  },

  async clearRoutePenalty(input: ClearRoutePenaltyInput): Promise<boolean> {
    const data = await apiClient.post<ClearRoutePenaltyInput, { cleared: boolean }>(
      "/v1/providers/routing/penalties/clear",
      input,
    );
    return data.cleared;
  },

  async listAuthProfiles(providerId: string): Promise<ListProviderAuthProfilesResponse["items"]> {
    const data = await apiClient.get<ListProviderAuthProfilesResponse>(
      `/v1/providers/${encodeURIComponent(providerId)}/auth-profiles`,
    );
    return data.items;
  },

  async activateAuthProfile(
    providerId: string,
    profileKey: string,
  ): Promise<ActivateProviderAuthProfileResponse["profile"]> {
    const data = await apiClient.post<Record<string, never>, ActivateProviderAuthProfileResponse>(
      `/v1/providers/${encodeURIComponent(providerId)}/auth-profiles/${encodeURIComponent(profileKey)}/activate`,
      {},
    );
    return data.profile;
  },

  async getRouting(): Promise<FridayModelRoutingConfig> {
    const data = await apiClient.get<GetRoutingResponse>("/v1/model-routing");
    return data.routing;
  },

  async setRouting(input: SetRoutingInput): Promise<FridayModelRoutingConfig> {
    const data = await apiClient.put<SetRoutingInput, SetRoutingResponse>(
      "/v1/model-routing",
      input,
    );
    return data.routing;
  },

  async initiateAnthropicOAuth(
    providerId: string,
  ): Promise<FridayOAuthLoginInitiation> {
    const data = await apiClient.post<{ providerId: string }, InitiateOAuthResponse>(
      "/v1/auth/oauth/anthropic/initiate",
      { providerId },
    );
    return data.oauth;
  },

  async completeAnthropicOAuth(input: {
    providerId: string;
    authorizationCode: string;
    state?: string;
  }): Promise<FridayOAuthLoginResult> {
    const data = await apiClient.post<typeof input, CompleteOAuthResponse>(
      "/v1/auth/oauth/anthropic/callback",
      input,
    );
    return data.oauth;
  },
};

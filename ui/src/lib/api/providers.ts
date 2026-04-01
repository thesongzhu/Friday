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

interface GetProviderResponse {
  provider: FridayProviderProfile;
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

// ─── API ───

export const providersApi = {
  async list(): Promise<FridayProviderProfile[]> {
    const data = await apiClient.get<ListProvidersResponse>("/v1/providers");
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

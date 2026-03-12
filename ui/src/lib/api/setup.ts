import { apiClient } from "./client";
import type {
  SetupStatusResponse,
  DetectProviderResponse,
  SetupNetworkResponse,
  SetupCompleteResponse,
  ProviderKind,
  AuthMode,
  SetupStepId,
  NetworkMode,
  ChannelKind,
} from "@/lib/setup/types";

// ─── Request types ───

export interface DetectProviderInput {
  apiKey?: string;
  kind?: ProviderKind;
  baseUrl?: string;
  authMode?: AuthMode;
}

export interface SaveNetworkInput {
  mode: NetworkMode;
  host?: string;
  port: number;
}

export interface SaveChannelsInput {
  channels: Array<{
    kind: ChannelKind;
    enabled: boolean;
    config: Record<string, string>;
  }>;
}

export interface SaveChannelsResponse {
  savedKinds: string[];
}

export interface CompleteSetupInput {
  completedSteps: SetupStepId[];
  skippedSteps: SetupStepId[];
}

// ─── API ───

export const setupApi = {
  async getStatus(): Promise<SetupStatusResponse> {
    return apiClient.get<SetupStatusResponse>("/v1/setup/status");
  },

  async detectProvider(input: DetectProviderInput): Promise<DetectProviderResponse> {
    return apiClient.post<DetectProviderInput, DetectProviderResponse>(
      "/v1/providers/detect",
      input,
    );
  },

  async getNetwork(): Promise<SetupNetworkResponse> {
    return apiClient.get<SetupNetworkResponse>("/v1/setup/network");
  },

  async saveNetwork(input: SaveNetworkInput): Promise<SetupNetworkResponse> {
    return apiClient.post<SaveNetworkInput, SetupNetworkResponse>(
      "/v1/setup/network",
      input,
    );
  },

  async saveChannels(input: SaveChannelsInput): Promise<SaveChannelsResponse> {
    return apiClient.post<SaveChannelsInput, SaveChannelsResponse>(
      "/v1/setup/channels",
      input,
    );
  },

  async completeSetup(input: CompleteSetupInput): Promise<SetupCompleteResponse> {
    return apiClient.post<CompleteSetupInput, SetupCompleteResponse>(
      "/v1/setup/complete",
      input,
    );
  },
};

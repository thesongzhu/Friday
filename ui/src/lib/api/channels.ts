import { apiClient } from "./client";
import type { ChannelRegistryView } from "./types";

interface ListChannelsResponse {
  items: ChannelRegistryView[];
}

interface GetChannelResponse {
  channel: ChannelRegistryView;
}

export interface ChannelPersonaConfig {
  persona: string;
  systemPrompt: string;
  updatedAt: string;
}

interface GetPersonaResponse {
  kind: string;
  persona: ChannelPersonaConfig | null;
}

interface UpdatePersonaResponse {
  kind: string;
  persona: ChannelPersonaConfig | null;
  cleared?: boolean;
}

export const channelsApi = {
  async list(): Promise<ChannelRegistryView[]> {
    const data = await apiClient.get<ListChannelsResponse>("/v1/channels");
    return data.items;
  },

  async get(kind: string): Promise<ChannelRegistryView> {
    const data = await apiClient.get<GetChannelResponse>(
      `/v1/channels/${encodeURIComponent(kind)}`,
    );
    return data.channel;
  },

  async getPersona(kind: string): Promise<ChannelPersonaConfig | null> {
    const data = await apiClient.get<GetPersonaResponse>(
      `/v1/channels/${encodeURIComponent(kind)}/persona`,
    );
    return data.persona;
  },

  async updatePersona(kind: string, input: { persona: string; systemPrompt: string }): Promise<ChannelPersonaConfig | null> {
    const data = await apiClient.put<typeof input, UpdatePersonaResponse>(
      `/v1/channels/${encodeURIComponent(kind)}/persona`,
      input,
    );
    return data.persona;
  },
};

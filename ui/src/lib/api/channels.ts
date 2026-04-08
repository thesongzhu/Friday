import { apiClient } from "./client";
import type { ChannelRegistryView } from "./types";

interface ListChannelsResponse {
  items: ChannelRegistryView[];
}

interface GetChannelResponse {
  channel: ChannelRegistryView;
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
};

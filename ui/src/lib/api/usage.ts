import { apiClient } from "./client";

export interface ProviderHealthItem {
  providerId: string;
  providerKind: string;
  status: string;
  successCount: number;
  errorCount: number;
  latencyMs: number;
  lastChecked: string;
}

export interface ProviderListItem {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
}

interface HealthResponse {
  items: ProviderHealthItem[];
}

interface ProvidersResponse {
  items: ProviderListItem[];
}

export const usageApi = {
  async listProviderHealth(): Promise<ProviderHealthItem[]> {
    const data = await apiClient.get<HealthResponse>("/v1/providers/health");
    return data.items;
  },

  async listProviders(): Promise<ProviderListItem[]> {
    const data = await apiClient.get<ProvidersResponse>("/v1/providers");
    return data.items;
  },
};

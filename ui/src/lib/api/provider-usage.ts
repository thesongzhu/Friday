import { apiClient } from "./client";
import type {
  FridayProviderUsageSummary,
  FridayLlmBudgetStatus,
  FridayLlmBudgetConfig,
} from "./types";

// ─── Response wrappers ───

interface GetUsageSummaryResponse {
  summary: FridayProviderUsageSummary;
}

interface GetBudgetStatusResponse {
  budget: FridayLlmBudgetStatus;
}

interface SetBudgetConfigResponse {
  budget: FridayLlmBudgetConfig;
}

// ─── API ───

export const providerUsageApi = {
  async getUsageSummary(query?: {
    from?: string;
    to?: string;
    groupBy?: "day" | "provider" | "model";
    providerId?: string;
    model?: string;
  }): Promise<FridayProviderUsageSummary> {
    const params = new URLSearchParams();
    if (query?.from) params.set("from", query.from);
    if (query?.to) params.set("to", query.to);
    if (query?.groupBy) params.set("groupBy", query.groupBy);
    if (query?.providerId) params.set("providerId", query.providerId);
    if (query?.model) params.set("model", query.model);
    const qs = params.toString();
    const path = qs ? `/v1/providers/usage?${qs}` : "/v1/providers/usage";
    const data = await apiClient.get<GetUsageSummaryResponse>(path);
    return data.summary;
  },

  async getBudget(): Promise<FridayLlmBudgetStatus> {
    const data = await apiClient.get<GetBudgetStatusResponse>("/v1/providers/budget");
    return data.budget;
  },

  async setBudget(input: { monthlyLimitUsd: number }): Promise<FridayLlmBudgetConfig> {
    const data = await apiClient.put<typeof input, SetBudgetConfigResponse>(
      "/v1/providers/budget",
      input,
    );
    return data.budget;
  },
};

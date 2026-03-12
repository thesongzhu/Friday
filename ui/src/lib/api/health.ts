import { apiClient } from "./client";
import type { FridayHealthResponse, MeResponse } from "./types";

// ─── API ───

export const healthApi = {
  async getHealth(): Promise<FridayHealthResponse> {
    return apiClient.get<FridayHealthResponse>("/v1/health");
  },

  async getMe(): Promise<MeResponse> {
    return apiClient.get<MeResponse>("/v1/auth/me");
  },
};

import { apiClient } from "./client";
import type {
  FridaySecurityCenterResponse,
  FridayRevokeTokenResponse,
  FridayRevokeSatelliteResponse,
} from "./types";

// ─── API ───

export const securityApi = {
  async getCenter(): Promise<FridaySecurityCenterResponse> {
    return apiClient.get<FridaySecurityCenterResponse>("/v1/security/center");
  },

  async revokeToken(tokenId: string): Promise<FridayRevokeTokenResponse> {
    return apiClient.post<{ tokenId: string }, FridayRevokeTokenResponse>(
      "/v1/security/tokens/revoke",
      { tokenId },
    );
  },

  async revokeSatellite(
    satelliteId: string,
    reason?: string,
  ): Promise<FridayRevokeSatelliteResponse> {
    return apiClient.post<{ reason?: string }, FridayRevokeSatelliteResponse>(
      `/v1/security/satellites/${encodeURIComponent(satelliteId)}/revoke`,
      reason ? { reason } : {},
    );
  },
};

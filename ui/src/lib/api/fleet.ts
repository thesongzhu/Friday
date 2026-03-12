import { apiClient } from "./client";
import type {
  FridayApproveSatellitePairingResponse,
  FridayFleetOverviewResponse,
  FridayFleetRemediationActionExecutionResult,
  FridayFleetRemediationPlan,
  FridayFleetSatelliteCard,
  FridayFleetSatelliteDetailResponse,
  FridayPendingSatellitePairingRequest,
  FridayRejectSatellitePairingResponse,
} from "./types";

// ─── Response wrappers ───

interface ListSatellitesResponse {
  items: FridayFleetSatelliteCard[];
  nextCursor?: string;
}

interface ListPendingPairingsResponse {
  items: FridayPendingSatellitePairingRequest[];
}

// ─── API ───

export const fleetApi = {
  async getOverview(): Promise<FridayFleetOverviewResponse> {
    return apiClient.get<FridayFleetOverviewResponse>("/v1/fleet/overview");
  },

  async listSatellites(query?: {
    pairingStatus?: string;
    trustLevel?: string;
    healthState?: string;
    q?: string;
    limit?: number;
    cursor?: string;
  }): Promise<ListSatellitesResponse> {
    const params = new URLSearchParams();
    if (query?.pairingStatus) params.set("pairingStatus", query.pairingStatus);
    if (query?.trustLevel) params.set("trustLevel", query.trustLevel);
    if (query?.healthState) params.set("healthState", query.healthState);
    if (query?.q) params.set("q", query.q);
    if (query?.limit !== undefined) params.set("limit", String(query.limit));
    if (query?.cursor) params.set("cursor", query.cursor);
    const qs = params.toString();
    const path = qs ? `/v1/fleet/satellites?${qs}` : "/v1/fleet/satellites";
    return apiClient.get<ListSatellitesResponse>(path);
  },

  async getSatellite(satelliteId: string): Promise<FridayFleetSatelliteDetailResponse> {
    return apiClient.get<FridayFleetSatelliteDetailResponse>(
      `/v1/fleet/satellites/${encodeURIComponent(satelliteId)}`,
    );
  },

  async getSatelliteRemediation(satelliteId: string): Promise<FridayFleetRemediationPlan> {
    return apiClient.get<FridayFleetRemediationPlan>(
      `/v1/fleet/satellites/${encodeURIComponent(satelliteId)}/remediation`,
    );
  },

  async executeSatelliteRemediationAction(
    satelliteId: string,
    actionId: string,
  ): Promise<FridayFleetRemediationActionExecutionResult> {
    return apiClient.post<Record<string, never>, FridayFleetRemediationActionExecutionResult>(
      `/v1/fleet/satellites/${encodeURIComponent(satelliteId)}/remediation/${encodeURIComponent(actionId)}/execute`,
      {},
    );
  },

  async listPairingRequests(): Promise<FridayPendingSatellitePairingRequest[]> {
    const data = await apiClient.get<FridayPendingSatellitePairingRequest[] | ListPendingPairingsResponse>(
      "/v1/satellites/pairing",
    );
    return Array.isArray(data) ? data : data.items;
  },

  async approvePairing(
    satelliteId: string,
    input?: {
      scopes?: string[];
      tokenTtlMs?: number;
    },
  ): Promise<FridayApproveSatellitePairingResponse> {
    return apiClient.post<{ scopes?: string[]; tokenTtlMs?: number }, FridayApproveSatellitePairingResponse>(
      `/v1/satellites/${encodeURIComponent(satelliteId)}/pairing/approve`,
      input ?? {},
    );
  },

  async rejectPairing(
    satelliteId: string,
    reason?: string,
  ): Promise<FridayRejectSatellitePairingResponse> {
    return apiClient.post<{ reason?: string }, FridayRejectSatellitePairingResponse>(
      `/v1/satellites/${encodeURIComponent(satelliteId)}/pairing/reject`,
      reason ? { reason } : {},
    );
  },
};

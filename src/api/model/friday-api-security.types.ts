import type { UUID } from "#workflows";

// ─── Token Revocation ───

export interface FridayRevokeTokenRequest {
  tokenId: UUID;
}

export interface FridayRevokeTokenResponse {
  revoked: boolean;
  tokenId: UUID;
}

// ─── Satellite Revocation ───

export interface FridayRevokeSatelliteRequest {
  reason?: string;
}

export interface FridayRevokeSatelliteResponse {
  revoked: true;
  satelliteId: UUID;
}

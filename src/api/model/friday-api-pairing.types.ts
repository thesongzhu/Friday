/**
 * Satellite Pairing — API DTOs for registration, pairing, and management.
 *
 * @module api/model/friday-api-pairing.types
 */

import type { ISODateTime, UUID } from "#workflows";

// ─── Registration ───

export interface FridaySatelliteRegistrationRequest {
  readonly type: string;
  readonly displayName: string;
  readonly publicKey: string;
  readonly runtime?: string;
  readonly transport?: string;
}

export interface FridaySatelliteRegistrationResponse {
  readonly satelliteId: UUID;
  readonly pairingStatus: string;
  readonly pairingRequired: boolean;
  readonly pairingRequestId: UUID;
  readonly pairingCode: string;
  readonly expiresAt: ISODateTime;
  readonly challengeNonce: string;
}

// ─── Pending Pairing ───

export interface FridayPendingPairingResponse {
  readonly requestId: UUID;
  readonly satelliteId: UUID;
  readonly displayName: string;
  readonly type: string;
  readonly pairingCode: string;
  readonly createdAt: ISODateTime;
  readonly expiresAt: ISODateTime;
}

// ─── Approve / Reject ───

export interface FridayApprovePairingRequest {
  readonly scopes?: string[];
  readonly tokenTtlMs?: number;
}

export interface FridayApprovePairingResponse {
  readonly token: string;
  readonly tokenId: UUID;
  readonly expiresAt: ISODateTime;
  readonly configRevision: number;
  readonly tokenVersion: number;
}

export interface FridayRejectPairingRequest {
  readonly reason?: string;
}

export interface FridayRejectPairingResponse {
  readonly ok: true;
  readonly rejectedAt: ISODateTime;
}

// ─── Handshake ───

export interface FridaySatelliteHandshakeRequest {
  readonly token: string;
  readonly signedChallenge: string;
  readonly challengeNonce: string;
  readonly clientEphemeralPublicKey: string;
  readonly supportedAlgorithms?: string[];
}

export interface FridaySatelliteHandshakeResponse {
  readonly accepted: boolean;
  readonly streamId: string;
  readonly epoch: number;
  readonly algorithm: string;
  readonly serverEphemeralPublicKey: string;
}

// ─── Revoke ───

export interface FridayRevokeSatelliteRequest {
  readonly reason?: string;
}

export interface FridayRevokeSatelliteResponse {
  readonly ok: true;
  readonly revokedAt: ISODateTime;
}

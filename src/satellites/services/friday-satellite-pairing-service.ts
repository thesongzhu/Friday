import { createHash, createVerify, generateKeyPairSync, randomBytes } from "node:crypto";

import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import type { FridaySatelliteRepository } from "../persistence/friday-satellite-repository.js";
import type { FridaySatellitePairingRequestRepository } from "../persistence/friday-satellite-pairing-request-repository.js";
import type { FridayApiTokenRepository } from "../persistence/friday-satellite-api-token-repository.js";
import type { FridayStreamCheckpointRepository } from "../persistence/friday-stream-checkpoint-repository.js";

export interface FridaySatellitePairingApprovalInput {
  satelliteId: string;
  requestId: string;
  resolverUserId: string;
  scopes: string[];
  tokenTtlMs?: number;
}

export interface FridaySatellitePairingApprovalResult {
  token: string;
  tokenId: string;
  expiresAt?: string;
  configRevision: number;
  tokenVersion: number;
}

export interface FridaySatellitePairingRejectionInput {
  satelliteId: string;
  requestId: string;
  resolverUserId: string;
  reason?: string;
}

export type FridayHandshakeAlgorithm = "xchacha20-poly1305" | "aes-256-gcm";

export interface FridaySatelliteHandshakeInput {
  satelliteId: string;
  token: string;
  signedChallenge: string;
  challengeNonce: string;
  clientEphemeralPublicKey: string;
  supportedAlgorithms: FridayHandshakeAlgorithm[];
}

export interface FridaySatelliteHandshakeResult {
  accepted: true;
  streamId: string;
  epoch: number;
  algorithm: FridayHandshakeAlgorithm;
  serverEphemeralPublicKey: string;
}

export interface FridaySatelliteRevokeInput {
  satelliteId: string;
  revokeTokens?: boolean;
  reason?: string;
}

export interface FridaySatellitePairingService {
  approvePairing(input: FridaySatellitePairingApprovalInput): FridaySatellitePairingApprovalResult;
  rejectPairing(input: FridaySatellitePairingRejectionInput): void;
  completeHandshake(input: FridaySatelliteHandshakeInput): FridaySatelliteHandshakeResult;
  revokeSatellite(input: FridaySatelliteRevokeInput): void;
}

export interface CreatePairingServiceDeps {
  db: FridaySqliteLayer;
  satelliteRepo: FridaySatelliteRepository;
  pairingRequestRepo: FridaySatellitePairingRequestRepository;
  apiTokenRepo: FridayApiTokenRepository;
  checkpointRepo: FridayStreamCheckpointRepository;
  idGenerator: () => string;
  nowIso: () => string;
  /** Optional override for ephemeral key generation (testing). */
  generateEphemeralKeyPair?: () => { publicKey: string; privateKey: string };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Ordered by preference — strongest first. */
const ALGORITHM_PREFERENCE: FridayHandshakeAlgorithm[] = [
  "xchacha20-poly1305",
  "aes-256-gcm",
];

function negotiateAlgorithm(
  clientAlgorithms: FridayHandshakeAlgorithm[],
): FridayHandshakeAlgorithm | undefined {
  for (const preferred of ALGORITHM_PREFERENCE) {
    if (clientAlgorithms.includes(preferred)) {
      return preferred;
    }
  }
  return undefined;
}

function verifyChallengeSignature(
  publicKeyPem: string,
  challengeNonce: string,
  signedChallenge: string,
): boolean {
  try {
    const verifier = createVerify("SHA256");
    verifier.update(challengeNonce);
    verifier.end();
    return verifier.verify(publicKeyPem, signedChallenge, "base64");
  } catch {
    return false;
  }
}

function defaultGenerateEphemeralKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** Extract token version from the token label. Format: "satellite:<id>:v<version>" */
function extractTokenVersionFromLabel(label: string): number | undefined {
  const match = label.match(/:v(\d+)$/);
  return match ? parseInt(match[1]!, 10) : undefined;
}

export function createFridaySatellitePairingService(
  deps: CreatePairingServiceDeps,
): FridaySatellitePairingService {
  return {
    approvePairing(input) {
      return deps.db.withWriteTransaction((db) => {
        const nowIso = deps.nowIso();

        // Validate request exists and is pending
        const request = deps.pairingRequestRepo.getRequest(db, input.requestId);
        if (!request) {
          throw new FridayDomainError("PAIRING_REQUEST_NOT_FOUND", `Pairing request not found: ${input.requestId}`, { httpStatus: 404 });
        }
        if (request.status !== "pending") {
          throw new FridayDomainError("PAIRING_REQUEST_NOT_PENDING", `Pairing request is not pending: ${request.status}`, { httpStatus: 409 });
        }
        if (request.satellite_id !== input.satelliteId) {
          throw new FridayDomainError("PAIRING_REQUEST_MISMATCH", "Pairing request does not belong to this satellite", { httpStatus: 400 });
        }
        if (new Date(request.expires_at) < new Date(nowIso)) {
          throw new FridayDomainError("PAIRING_REQUEST_EXPIRED", "Pairing request has expired", { httpStatus: 410 });
        }

        // Update request to approved
        deps.pairingRequestRepo.updateStatus(db, input.requestId, "approved", input.resolverUserId, nowIso);

        // Update satellite to paired
        deps.satelliteRepo.updatePairingStatus(db, input.satelliteId, "paired", nowIso);

        // Generate and store token
        const plainToken = randomBytes(32).toString("hex");
        const tokenId = deps.idGenerator();
        const expiresAt = input.tokenTtlMs
          ? new Date(new Date(nowIso).getTime() + input.tokenTtlMs).toISOString()
          : undefined;

        const satellite = deps.satelliteRepo.getSatellite(db, input.satelliteId);
        const tokenVersion = satellite?.token_version ?? 1;

        deps.apiTokenRepo.insertToken(db, {
          id: tokenId,
          userId: null,
          principalType: "satellite",
          label: `satellite:${input.satelliteId}:v${tokenVersion}`,
          tokenHash: hashToken(plainToken),
          scopes: input.scopes,
          expiresAt,
          nowIso,
        });

        return {
          token: plainToken,
          tokenId,
          expiresAt,
          configRevision: 1,
          tokenVersion,
        };
      });
    },

    rejectPairing(input) {
      deps.db.withWriteTransaction((db) => {
        const nowIso = deps.nowIso();
        const request = deps.pairingRequestRepo.getRequest(db, input.requestId);
        if (!request) {
          throw new FridayDomainError("PAIRING_REQUEST_NOT_FOUND", `Pairing request not found: ${input.requestId}`, { httpStatus: 404 });
        }
        if (request.status !== "pending") {
          throw new FridayDomainError("PAIRING_REQUEST_NOT_PENDING", `Pairing request is not pending: ${request.status}`, { httpStatus: 409 });
        }
        if (request.satellite_id !== input.satelliteId) {
          throw new FridayDomainError("PAIRING_REQUEST_MISMATCH", "Pairing request does not belong to this satellite", { httpStatus: 400 });
        }

        deps.pairingRequestRepo.updateStatus(db, input.requestId, "rejected", input.resolverUserId, nowIso);
      });
    },

    completeHandshake(input) {
      return deps.db.withWriteTransaction((db) => {
        const nowIso = deps.nowIso();

        // Validate token (with expiry check)
        const tokenRow = deps.apiTokenRepo.getByHash(db, hashToken(input.token), nowIso);
        if (!tokenRow) {
          throw new FridayDomainError("SATELLITE_TOKEN_INVALID", "Invalid or revoked token", { httpStatus: 401 });
        }

        // Validate satellite
        const satellite = deps.satelliteRepo.getSatellite(db, input.satelliteId);
        if (!satellite) {
          throw new FridayDomainError("SATELLITE_NOT_FOUND", `Satellite not found: ${input.satelliteId}`, { httpStatus: 404 });
        }
        if (satellite.pairing_status === "revoked") {
          throw new FridayDomainError("SATELLITE_REVOKED", "Satellite has been revoked", { httpStatus: 403 });
        }

        // Token label must reference this satellite
        if (!tokenRow.label.startsWith(`satellite:${input.satelliteId}`)) {
          throw new FridayDomainError("SATELLITE_TOKEN_MISMATCH", "Token does not belong to this satellite", { httpStatus: 403 });
        }

        // Issue 3: Validate token version against satellite's current token_version
        const tokenLabelVersion = extractTokenVersionFromLabel(tokenRow.label);
        if (tokenLabelVersion !== undefined && tokenLabelVersion !== satellite.token_version) {
          throw new FridayDomainError(
            "SATELLITE_TOKEN_VERSION_MISMATCH",
            `Token version mismatch: token=${tokenLabelVersion}, satellite=${satellite.token_version}`,
            { httpStatus: 403 },
          );
        }

        // Validate nonce binding — must match the nonce issued during registration
        const pairingRequest = deps.pairingRequestRepo.getRequestBySatelliteId(
          db,
          input.satelliteId,
          "approved",
        );
        if (!pairingRequest || pairingRequest.nonce !== input.challengeNonce) {
          throw new FridayDomainError("SATELLITE_NONCE_MISMATCH", "Challenge nonce does not match issued nonce", { httpStatus: 400 });
        }

        // Verify challenge signature against satellite's public key and nonce
        if (
          !verifyChallengeSignature(
            satellite.public_key,
            input.challengeNonce,
            input.signedChallenge,
          )
        ) {
          throw new FridayDomainError("SATELLITE_SIGNATURE_INVALID", "Challenge signature verification failed", { httpStatus: 401 });
        }

        // Negotiate algorithm
        const algorithm = negotiateAlgorithm(input.supportedAlgorithms);
        if (!algorithm) {
          throw new FridayDomainError("SATELLITE_ALGORITHM_UNSUPPORTED", "No supported algorithm in common", { httpStatus: 400 });
        }

        // Generate server ephemeral key pair
        const genKeyPair = deps.generateEphemeralKeyPair ?? defaultGenerateEphemeralKeyPair;
        const ephemeral = genKeyPair();

        // Update satellite to online and last_seen
        deps.satelliteRepo.updatePairingStatus(db, input.satelliteId, "online", nowIso);
        deps.satelliteRepo.updateLastSeen(db, input.satelliteId, nowIso);

        // Get or bump epoch
        const epoch = deps.checkpointRepo.getEpoch(db) || deps.checkpointRepo.bumpEpoch(db, nowIso);
        const streamId = deps.idGenerator();

        return {
          accepted: true as const,
          streamId,
          epoch,
          algorithm,
          serverEphemeralPublicKey: ephemeral.publicKey,
        };
      });
    },

    revokeSatellite(input) {
      deps.db.withWriteTransaction((db) => {
        const nowIso = deps.nowIso();

        deps.satelliteRepo.updatePairingStatus(db, input.satelliteId, "revoked", nowIso);

        if (input.revokeTokens !== false) {
          deps.apiTokenRepo.revokeAllForSatellite(db, input.satelliteId, nowIso);
          deps.satelliteRepo.incrementTokenVersion(db, input.satelliteId, nowIso);
        }
      });
    },
  };
}

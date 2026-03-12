import { randomBytes } from "node:crypto";
import type { FridaySqliteLayer } from "#state";
import type { FridaySatelliteRegistrationInput } from "../model/friday-satellite.types.js";
import type { FridaySatelliteRepository } from "../persistence/friday-satellite-repository.js";
import type { FridaySatellitePairingRequestRepository } from "../persistence/friday-satellite-pairing-request-repository.js";
import type { FridaySatelliteCapabilityRepository } from "../persistence/friday-satellite-capability-repository.js";

export interface FridaySatelliteRegistrationResult {
  satelliteId: string;
  pairingStatus: "pending";
  pairingRequired: true;
  pairingRequestId: string;
  pairingCode: string;
  expiresAt: string;
  challengeNonce: string;
}

export interface FridaySatelliteRegistrationService {
  register(input: FridaySatelliteRegistrationInput): FridaySatelliteRegistrationResult;
}

export interface CreateRegistrationServiceDeps {
  db: FridaySqliteLayer;
  satelliteRepo: FridaySatelliteRepository;
  pairingRequestRepo: FridaySatellitePairingRequestRepository;
  capabilityRepo: FridaySatelliteCapabilityRepository;
  idGenerator: () => string;
  nowIso: () => string;
  pairingTtlMs?: number;
}

/** Default pairing request TTL: 10 minutes. */
const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;

export function createFridaySatelliteRegistrationService(
  deps: CreateRegistrationServiceDeps,
): FridaySatelliteRegistrationService {
  const pairingTtlMs = deps.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS;

  return {
    register(input) {
      return deps.db.withWriteTransaction((db) => {
        const satelliteId = deps.idGenerator();
        const requestId = deps.idGenerator();
        const nowIso = deps.nowIso();
        const expiresAt = new Date(new Date(nowIso).getTime() + pairingTtlMs).toISOString();

        // 6-digit pairing code
        const code = randomBytes(3).readUIntBE(0, 3).toString().padStart(6, "0").slice(0, 6);
        const nonce = randomBytes(32).toString("hex");

        // 1. Insert satellite row
        deps.satelliteRepo.insertSatellite(db, { id: satelliteId, registration: input, nowIso });

        // 2. Insert pairing request
        deps.pairingRequestRepo.insertRequest(db, {
          id: requestId,
          satelliteId,
          code,
          nonce,
          requestedByIp: input.requestedByIp,
          requestedByUserAgent: input.requestedByUserAgent,
          expiresAt,
          nowIso,
        });

        // 3. Store initial capabilities if provided
        if (input.capabilityReport) {
          deps.capabilityRepo.upsertCapabilities(
            db,
            satelliteId,
            input.capabilityReport.capabilities,
            nowIso,
            deps.idGenerator,
          );
        }

        return {
          satelliteId,
          pairingStatus: "pending" as const,
          pairingRequired: true as const,
          pairingRequestId: requestId,
          pairingCode: code,
          expiresAt,
          challengeNonce: nonce,
        };
      });
    },
  };
}

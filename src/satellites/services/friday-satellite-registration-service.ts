import { randomBytes } from "node:crypto";
import { FridayDomainError } from "#errors";
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
  /**
   * Test-oracle only: allows the legacy TypeScript satellite-registration
   * mutation (`register`) in isolated test/validation harnesses. Default/live
   * runtime must leave this unset so the method fails closed for ALL callers,
   * including any non-route caller (the HTTP pairing route guard is bypassed by
   * a direct method call). Never default this flag on in production.
   */
  allowTestOnlySatellitePairingExecution?: boolean;
}

/** Default pairing request TTL: 10 minutes. */
const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;

export function createFridaySatelliteRegistrationService(
  deps: CreateRegistrationServiceDeps,
): FridaySatelliteRegistrationService {
  const pairingTtlMs = deps.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS;

  // ─── TS Runtime Retirement: METHOD-level fail-closed guard ───
  // Defense-in-depth (orphan off-route leak audit, 2026-06-10): satellite
  // registration was ROUTE-only-guarded (friday-satellite-pairing-routes asserts
  // the test-oracle flag before the register route). Today no non-route caller
  // reaches `register` — it is route-deps-only — but a FUTURE wiring (e.g. an
  // auto-pairing loop) would silently reopen a G4-class leak. Guarding here fails
  // ALL non-route callers closed BEFORE any satellite/pairing row write, unless
  // the explicit test-oracle flag is set. Mirrors the route's advertised 503 code.
  function assertSatelliteRegistrationExecutionAllowed(): void {
    if (deps.allowTestOnlySatellitePairingExecution !== true) {
      throw new FridayDomainError(
        "TS_RUNTIME_SATELLITE_PAIRING_RETIRED",
        "TypeScript satellite registration is fail-closed in default/live runtime; use the Rust-owned satellite pairing entrypoint.",
        {
          httpStatus: 503,
          details: {
            classification: "fail_closed",
            replacement: "rust_owned_satellite_pairing_entrypoint_required",
          },
        },
      );
    }
  }

  return {
    register(input) {
      assertSatelliteRegistrationExecutionAllowed();
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

import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import type {
  FridaySatelliteHeartbeatInput,
  FridaySatellitePairingStatus,
} from "../model/friday-satellite.types.js";
import { computeFridaySatelliteStatus } from "../model/friday-satellite-health.types.js";
import type { FridaySatelliteRepository } from "../persistence/friday-satellite-repository.js";
import type { FridaySatelliteHeartbeatRepository } from "../persistence/friday-satellite-heartbeat-repository.js";

export interface FridaySatelliteHeartbeatResult {
  accepted: true;
  now: string;
  expectedIntervalMs: number;
  status: FridaySatellitePairingStatus;
}

export interface FridaySatelliteHeartbeatService {
  recordHeartbeat(input: FridaySatelliteHeartbeatInput): FridaySatelliteHeartbeatResult;
}

export interface CreateHeartbeatServiceDeps {
  db: FridaySqliteLayer;
  satelliteRepo: FridaySatelliteRepository;
  heartbeatRepo: FridaySatelliteHeartbeatRepository;
  idGenerator: () => string;
  nowIso: () => string;
  expectedIntervalMs?: number;
  onStatusTransition?: (input: {
    satelliteId: string;
    fromStatus: FridaySatellitePairingStatus;
    toStatus: FridaySatellitePairingStatus;
    at: string;
    failureRate1m?: number;
    explicitDisconnect?: boolean;
  }) => void;
  /**
   * Test-oracle only: allows the legacy TypeScript satellite-heartbeat mutation
   * (`recordHeartbeat`) in isolated test/validation harnesses. Default/live
   * runtime must leave this unset so the method fails closed for ALL callers
   * (the HTTP satellite-runtime route guard is bypassed by a direct method
   * call). Never default this flag on in production.
   */
  allowTestOnlySatelliteRuntimeExecution?: boolean;
}

/** Default expected heartbeat interval: 15 seconds. */
const DEFAULT_EXPECTED_INTERVAL_MS = 15_000;

export function createFridaySatelliteHeartbeatService(
  deps: CreateHeartbeatServiceDeps,
): FridaySatelliteHeartbeatService {
  const expectedIntervalMs = deps.expectedIntervalMs ?? DEFAULT_EXPECTED_INTERVAL_MS;

  // ─── TS Runtime Retirement: METHOD-level fail-closed guard ───
  // Defense-in-depth (orphan off-route leak audit, 2026-06-10): the satellite
  // heartbeat mutation was ROUTE-only-guarded (friday-satellite-runtime-routes).
  // No non-route caller reaches `recordHeartbeat` today, but a future inbound
  // wiring would bypass the route fence. Fails closed BEFORE the heartbeat/
  // status-transition write unless the explicit test-oracle flag is set. Mirrors
  // the route's advertised 503 code (TS_RUNTIME_SATELLITE_RUNTIME_RETIRED).
  function assertSatelliteRuntimeExecutionAllowed(): void {
    if (deps.allowTestOnlySatelliteRuntimeExecution !== true) {
      throw new FridayDomainError(
        "TS_RUNTIME_SATELLITE_RUNTIME_RETIRED",
        "TypeScript satellite heartbeat is fail-closed in default/live runtime; use the Rust-owned satellite runtime entrypoint.",
        {
          httpStatus: 503,
          details: {
            classification: "fail_closed",
            replacement: "rust_owned_satellite_runtime_entrypoint_required",
          },
        },
      );
    }
  }

  return {
    recordHeartbeat(input) {
      assertSatelliteRuntimeExecutionAllowed();
      let transition:
        | {
          satelliteId: string;
          fromStatus: FridaySatellitePairingStatus;
          toStatus: FridaySatellitePairingStatus;
          at: string;
          failureRate1m?: number;
          explicitDisconnect?: boolean;
        }
        | undefined;

      const result = deps.db.withWriteTransaction((db) => {
        const nowIso = deps.nowIso();

        const satellite = deps.satelliteRepo.getSatellite(db, input.satelliteId);
        if (!satellite) {
          throw new FridayDomainError("SATELLITE_NOT_FOUND", `Satellite not found: ${input.satelliteId}`, { httpStatus: 404 });
        }

        // Compute new status
        const newStatus = computeFridaySatelliteStatus({
          nowIso,
          lastHeartbeatTs: input.ts,
          failureRate1m: input.failureRate1m,
          explicitDisconnect: input.explicitDisconnect,
          currentStatus: satellite.pairing_status as FridaySatellitePairingStatus,
        });

        // Record heartbeat
        const heartbeatId = deps.idGenerator();
        deps.heartbeatRepo.insertHeartbeat(db, heartbeatId, input, newStatus);

        // Update satellite status and last_seen
        if (newStatus !== satellite.pairing_status) {
          deps.satelliteRepo.updatePairingStatus(db, input.satelliteId, newStatus, nowIso);
          transition = {
            satelliteId: input.satelliteId,
            fromStatus: satellite.pairing_status as FridaySatellitePairingStatus,
            toStatus: newStatus,
            at: nowIso,
            failureRate1m: input.failureRate1m,
            explicitDisconnect: input.explicitDisconnect,
          };
        }
        deps.satelliteRepo.updateLastSeen(db, input.satelliteId, nowIso);

        return {
          accepted: true as const,
          now: nowIso,
          expectedIntervalMs,
          status: newStatus,
        };
      });
      if (transition) {
        deps.onStatusTransition?.(transition);
      }
      return result;
    },
  };
}

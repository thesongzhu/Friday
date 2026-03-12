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
}

/** Default expected heartbeat interval: 15 seconds. */
const DEFAULT_EXPECTED_INTERVAL_MS = 15_000;

export function createFridaySatelliteHeartbeatService(
  deps: CreateHeartbeatServiceDeps,
): FridaySatelliteHeartbeatService {
  const expectedIntervalMs = deps.expectedIntervalMs ?? DEFAULT_EXPECTED_INTERVAL_MS;

  return {
    recordHeartbeat(input) {
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

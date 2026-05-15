import type { FridaySqliteLayer } from "#state";
import type { FridaySatellitePairingStatus } from "../model/friday-satellite.types.js";

export interface FridaySatelliteResumeSignal {
  satelliteId: string;
  fromStatus: FridaySatellitePairingStatus;
  toStatus: FridaySatellitePairingStatus;
  at: string;
  pendingOutboxCount: number;
}

export interface FridaySatelliteResumeCoordinatorDeps {
  db: FridaySqliteLayer;
  onResumeEligible?: (signal: FridaySatelliteResumeSignal) => void;
}

export interface FridaySatelliteResumeCoordinator {
  handleStatusTransition(input: {
    satelliteId: string;
    fromStatus: FridaySatellitePairingStatus;
    toStatus: FridaySatellitePairingStatus;
    at: string;
  }): FridaySatelliteResumeSignal | null;
  getPendingOutboxCount(satelliteId: string, nowIso: string): number;
}

const OFFLINE_LIKE: ReadonlySet<FridaySatellitePairingStatus> = new Set([
  "offline",
  "degraded",
  "pending",
  "paired",
]);
const ONLINE_LIKE: ReadonlySet<FridaySatellitePairingStatus> = new Set(["online"]);

function isResumeTransition(
  fromStatus: FridaySatellitePairingStatus,
  toStatus: FridaySatellitePairingStatus,
): boolean {
  return OFFLINE_LIKE.has(fromStatus) && ONLINE_LIKE.has(toStatus);
}

export function createFridaySatelliteResumeCoordinator(
  deps: FridaySatelliteResumeCoordinatorDeps,
): FridaySatelliteResumeCoordinator {
  function readPendingOutboxCount(satelliteId: string, nowIso: string): number {
    return deps.db.withReadConnection((db) => {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM outbox_messages
           WHERE satellite_id = ?
             AND status = 'queued'
             AND (deliver_after IS NULL OR deliver_after <= ?)
             AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .get(satelliteId, nowIso, nowIso) as { count: number } | undefined;
      return row?.count ?? 0;
    });
  }

  return {
    handleStatusTransition(input) {
      if (!isResumeTransition(input.fromStatus, input.toStatus)) {
        return null;
      }
      const pendingOutboxCount = readPendingOutboxCount(input.satelliteId, input.at);
      const signal: FridaySatelliteResumeSignal = {
        satelliteId: input.satelliteId,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        at: input.at,
        pendingOutboxCount,
      };
      deps.onResumeEligible?.(signal);
      return signal;
    },
    getPendingOutboxCount(satelliteId, nowIso) {
      return readPendingOutboxCount(satelliteId, nowIso);
    },
  };
}

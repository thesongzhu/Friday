import type { FridaySqliteLayer } from "#state";
import type { FridaySatellitePairingStatus } from "../model/friday-satellite.types.js";
import { computeFridaySatelliteStatus } from "../model/friday-satellite-health.types.js";
import type { FridaySatelliteRepository } from "../persistence/friday-satellite-repository.js";

export interface FridaySatelliteOfflineSweeperResult {
  markedDegraded: number;
  markedOffline: number;
}

export interface FridaySatelliteOfflineSweeper {
  sweep(nowIso?: string): FridaySatelliteOfflineSweeperResult;
}

export interface CreateOfflineSweeperDeps {
  db: FridaySqliteLayer;
  satelliteRepo: FridaySatelliteRepository;
  nowIso: () => string;
  onStatusTransition?: (input: {
    satelliteId: string;
    fromStatus: FridaySatellitePairingStatus;
    toStatus: FridaySatellitePairingStatus;
    at: string;
  }) => void;
}

export function createFridaySatelliteOfflineSweeper(
  deps: CreateOfflineSweeperDeps,
): FridaySatelliteOfflineSweeper {
  return {
    sweep(nowIsoOverride?) {
      const transitions: Array<{
        satelliteId: string;
        fromStatus: FridaySatellitePairingStatus;
        toStatus: FridaySatellitePairingStatus;
        at: string;
      }> = [];

      const result = deps.db.withWriteTransaction((db) => {
        const nowIso = nowIsoOverride ?? deps.nowIso();
        let markedDegraded = 0;
        let markedOffline = 0;

        // Check all potentially stale satellites (online, degraded, paired)
        const candidates = deps.satelliteRepo.listByStatus(db, [
          "online",
          "degraded",
          "paired",
        ]);

        for (const sat of candidates) {
          const newStatus = computeFridaySatelliteStatus({
            nowIso,
            lastHeartbeatTs: sat.last_seen_at ?? undefined,
            currentStatus: sat.pairing_status as FridaySatellitePairingStatus,
          });

          if (newStatus !== sat.pairing_status) {
            deps.satelliteRepo.updatePairingStatus(
              db,
              sat.id,
              newStatus,
              nowIso,
            );
            transitions.push({
              satelliteId: sat.id,
              fromStatus: sat.pairing_status as FridaySatellitePairingStatus,
              toStatus: newStatus,
              at: nowIso,
            });
            if (newStatus === "degraded") markedDegraded++;
            if (newStatus === "offline") markedOffline++;
          }
        }

        return { markedDegraded, markedOffline };
      });
      for (const transition of transitions) {
        deps.onStatusTransition?.(transition);
      }
      return result;
    },
  };
}

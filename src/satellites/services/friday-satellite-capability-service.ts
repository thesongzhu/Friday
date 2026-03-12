import type { FridaySqliteLayer } from "#state";
import type { FridaySatelliteCapabilityReport } from "../model/friday-satellite.types.js";
import type { FridaySatelliteRepository } from "../persistence/friday-satellite-repository.js";
import type { FridaySatelliteCapabilityRepository } from "../persistence/friday-satellite-capability-repository.js";

export interface FridaySatelliteCapabilityService {
  updateCapabilities(report: FridaySatelliteCapabilityReport): {
    accepted: boolean;
    reason?: string;
  };
}

export interface CreateCapabilityServiceDeps {
  db: FridaySqliteLayer;
  satelliteRepo: FridaySatelliteRepository;
  capabilityRepo: FridaySatelliteCapabilityRepository;
  idGenerator: () => string;
  nowIso: () => string;
  /** @deprecated Kept for API compatibility; revision is now persisted in hub_settings. */
  revisionCache?: Map<string, number>;
}

const REVISION_KEY_PREFIX = "capability_revision:";

export function createFridaySatelliteCapabilityService(
  deps: CreateCapabilityServiceDeps,
): FridaySatelliteCapabilityService {
  return {
    updateCapabilities(report) {
      return deps.db.withWriteTransaction((db) => {
        // Enforce monotonic revision from persisted state
        const revisionKey = `${REVISION_KEY_PREFIX}${report.satelliteId}`;
        const revRow = db
          .prepare("SELECT value_json FROM hub_settings WHERE key = ?")
          .get(revisionKey) as { value_json: string } | undefined;
        const lastRevision = revRow ? (JSON.parse(revRow.value_json) as number) : 0;

        if (report.revision <= lastRevision) {
          return {
            accepted: false,
            reason: `Stale revision: received ${report.revision}, last seen ${lastRevision}`,
          };
        }

        const satellite = deps.satelliteRepo.getSatellite(db, report.satelliteId);
        if (!satellite) {
          return { accepted: false, reason: `Satellite not found: ${report.satelliteId}` };
        }

        const nowIso = deps.nowIso();

        deps.capabilityRepo.upsertCapabilities(
          db,
          report.satelliteId,
          report.capabilities,
          nowIso,
          deps.idGenerator,
        );

        // Persist the revision durably
        db.prepare(
          `INSERT INTO hub_settings (key, value_json, revision, created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, 1, ?, ?, NULL, NULL)
           ON CONFLICT(key) DO UPDATE SET
             value_json = excluded.value_json,
             revision = hub_settings.revision + 1,
             updated_at = excluded.updated_at`,
        ).run(revisionKey, JSON.stringify(report.revision), nowIso, nowIso);

        return { accepted: true };
      });
    },
  };
}

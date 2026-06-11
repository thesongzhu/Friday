import { FridayDomainError } from "#errors";
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
  /**
   * Test-oracle only: allows the legacy TypeScript satellite-capability
   * mutation (`updateCapabilities`) in isolated test/validation harnesses.
   * Default/live runtime must leave this unset so the method fails closed for
   * ALL callers (the HTTP satellite-runtime route guard is bypassed by a direct
   * method call). Never default this flag on in production.
   */
  allowTestOnlySatelliteRuntimeExecution?: boolean;
}

const REVISION_KEY_PREFIX = "capability_revision:";

export function createFridaySatelliteCapabilityService(
  deps: CreateCapabilityServiceDeps,
): FridaySatelliteCapabilityService {
  // ─── TS Runtime Retirement: METHOD-level fail-closed guard ───
  // Defense-in-depth (orphan off-route leak audit, 2026-06-10): the satellite
  // capability mutation was ROUTE-only-guarded (friday-satellite-runtime-routes).
  // No non-route caller reaches `updateCapabilities` today, but a future inbound
  // wiring would bypass the route fence. Fails closed BEFORE the capability/
  // revision write unless the explicit test-oracle flag is set. Mirrors the
  // route's advertised 503 code (TS_RUNTIME_SATELLITE_RUNTIME_RETIRED).
  function assertSatelliteRuntimeExecutionAllowed(): void {
    if (deps.allowTestOnlySatelliteRuntimeExecution !== true) {
      throw new FridayDomainError(
        "TS_RUNTIME_SATELLITE_RUNTIME_RETIRED",
        "TypeScript satellite capability update is fail-closed in default/live runtime; use the Rust-owned satellite runtime entrypoint.",
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
    updateCapabilities(report) {
      assertSatelliteRuntimeExecutionAllowed();
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

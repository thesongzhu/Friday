import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import { createFridayFleetDashboardService } from "#api";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";

/**
 * TS Runtime Retirement — METHOD-level guard for fleet satellite remediation
 * (orphan off-route leak audit, 2026-06-10 defense-in-depth).
 *
 * `executeSatelliteRemediationAction` was ROUTE-only-guarded (friday-fleet-routes
 * asserts the flag after the canonical-approval gate). This proves it fails closed
 * by default (flag unset) BEFORE the remediation effect, and that reads stay live.
 */

const RETIRED_CODE = "TS_RUNTIME_FLEET_REMEDIATION_RETIRED";
const NOW = "2026-06-10T10:00:00.000Z";

describe("FridayFleetDashboardService TS-retirement method guard", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function buildService(allowTestOnlyFleetRemediationExecution?: boolean) {
    return createFridayFleetDashboardService({
      db,
      nowIso: () => NOW,
      idGenerator: createTestIdGenerator(),
      outboxQueueService: {
        requeueExpiredLeases: async () => 0,
        expireByTtl: async () => 0,
      },
      ...(allowTestOnlyFleetRemediationExecution === undefined
        ? {}
        : { allowTestOnlyFleetRemediationExecution }),
    });
  }

  it("executeSatelliteRemediationAction fails closed by default: rejects with 503 fail_closed", async () => {
    const service = buildService();
    await expect(
      service.executeSatelliteRemediationAction({ satelliteId: "sat-x", actionId: "requeue_expired_leases" }),
    ).rejects.toMatchObject({ code: RETIRED_CODE, httpStatus: 503 });
  });

  it("also fails closed when the flag is explicitly false", async () => {
    const service = buildService(false);
    await expect(
      service.executeSatelliteRemediationAction({ satelliteId: "sat-x", actionId: "requeue_expired_leases" }),
    ).rejects.toMatchObject({ code: RETIRED_CODE, httpStatus: 503 });
  });

  it("read surfaces (getOverview) stay live without the flag", () => {
    const service = buildService();
    const overview = service.getOverview();
    expect(overview).toBeDefined();
  });

  it("passes the guard when the test-oracle flag is enabled (reaches not-found, not the 503)", async () => {
    const service = buildService(true);
    // Guard open: reaches real logic; with no satellite it throws the domain
    // SATELLITE_NOT_FOUND (NOT the retirement 503), proving the guard no longer blocks.
    await expect(
      service.executeSatelliteRemediationAction({ satelliteId: "sat-missing", actionId: "requeue_expired_leases" }),
    ).rejects.toMatchObject({ code: "SATELLITE_NOT_FOUND" });
  });
});

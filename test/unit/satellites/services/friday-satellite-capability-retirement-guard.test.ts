import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import type { FridaySatelliteCapabilityReport } from "#satellites";
import {
  createFridaySatelliteCapabilityRepository,
  createFridaySatelliteCapabilityService,
  createFridaySatelliteRepository,
} from "#satellites";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.helper.js";

/**
 * TS Runtime Retirement — METHOD-level guard for satellite capability update
 * (orphan off-route leak audit, 2026-06-10 defense-in-depth). `updateCapabilities`
 * was ROUTE-only-guarded; this proves it fails closed by default BEFORE the
 * capability/revision write.
 */

const RETIRED_CODE = "TS_RUNTIME_SATELLITE_RUNTIME_RETIRED";
const NOW = "2026-06-10T00:00:00.000Z";

const report: FridaySatelliteCapabilityReport = {
  satelliteId: "sat-1",
  revision: 5,
  generatedAt: NOW,
  runtime: { os: "darwin", arch: "arm64", appVersion: "1.0.0", nodeVersion: "22.0.0" },
  capabilities: [{ key: "camera", available: true }],
};

describe("FridaySatelliteCapabilityService TS-retirement method guard", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function buildService(allowTestOnlySatelliteRuntimeExecution?: boolean) {
    return createFridaySatelliteCapabilityService({
      db,
      satelliteRepo: createFridaySatelliteRepository(),
      capabilityRepo: createFridaySatelliteCapabilityRepository(),
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      ...(allowTestOnlySatelliteRuntimeExecution === undefined
        ? {}
        : { allowTestOnlySatelliteRuntimeExecution }),
    });
  }

  function countCapabilityRows(): number {
    return db.withReadConnection((reader) =>
      (reader.prepare("SELECT COUNT(*) AS c FROM satellite_capabilities").get() as { c: number }).c,
    );
  }

  it("updateCapabilities fails closed by default: throws 503 and writes no capability row", () => {
    const service = buildService();
    let caught: unknown;
    try {
      service.updateCapabilities(report);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FridayDomainError);
    expect((caught as FridayDomainError).code).toBe(RETIRED_CODE);
    expect((caught as FridayDomainError).httpStatus).toBe(503);
    expect(countCapabilityRows()).toBe(0);
  });

  it("also fails closed when the flag is explicitly false", () => {
    const service = buildService(false);
    expect(() => service.updateCapabilities(report)).toThrow(
      expect.objectContaining({ code: RETIRED_CODE, httpStatus: 503 }),
    );
    expect(countCapabilityRows()).toBe(0);
  });

  it("passes the guard when the test-oracle flag is enabled (reaches not-found, not the 503)", () => {
    const service = buildService(true);
    // Guard open: reaches real logic; with no satellite row it returns accepted=false
    // (NOT a retirement 503), proving the guard no longer blocks the legacy path.
    const result = service.updateCapabilities(report);
    expect(result.accepted).toBe(false);
  });
});

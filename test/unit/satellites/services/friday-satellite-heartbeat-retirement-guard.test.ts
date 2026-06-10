import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import {
  createFridaySatelliteHeartbeatRepository,
  createFridaySatelliteHeartbeatService,
  createFridaySatelliteRepository,
} from "#satellites";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.helper.js";

/**
 * TS Runtime Retirement — METHOD-level guard for satellite heartbeat
 * (orphan off-route leak audit, 2026-06-10 defense-in-depth). `recordHeartbeat`
 * was ROUTE-only-guarded; this proves it fails closed by default BEFORE the
 * heartbeat/status-transition write. (The live `heartbeat-runner` scheduler is
 * observability, a different service, and is unaffected.)
 */

const RETIRED_CODE = "TS_RUNTIME_SATELLITE_RUNTIME_RETIRED";
const NOW = "2026-06-10T00:00:00.000Z";

describe("FridaySatelliteHeartbeatService TS-retirement method guard", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function buildService(allowTestOnlySatelliteRuntimeExecution?: boolean) {
    return createFridaySatelliteHeartbeatService({
      db,
      satelliteRepo: createFridaySatelliteRepository(),
      heartbeatRepo: createFridaySatelliteHeartbeatRepository(),
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      ...(allowTestOnlySatelliteRuntimeExecution === undefined
        ? {}
        : { allowTestOnlySatelliteRuntimeExecution }),
    });
  }

  function countHeartbeatRows(): number {
    return db.withReadConnection((reader) =>
      (reader.prepare("SELECT COUNT(*) AS c FROM satellite_heartbeats").get() as { c: number }).c,
    );
  }

  it("recordHeartbeat fails closed by default: throws 503 and writes no heartbeat row", () => {
    const service = buildService();
    let caught: unknown;
    try {
      service.recordHeartbeat({ satelliteId: "sat-1", ts: NOW });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FridayDomainError);
    expect((caught as FridayDomainError).code).toBe(RETIRED_CODE);
    expect((caught as FridayDomainError).httpStatus).toBe(503);
    expect(countHeartbeatRows()).toBe(0);
  });

  it("also fails closed when the flag is explicitly false", () => {
    const service = buildService(false);
    expect(() => service.recordHeartbeat({ satelliteId: "sat-1", ts: NOW })).toThrow(
      expect.objectContaining({ code: RETIRED_CODE, httpStatus: 503 }),
    );
    expect(countHeartbeatRows()).toBe(0);
  });

  it("passes the guard when the test-oracle flag is enabled (reaches not-found, not the 503)", () => {
    const service = buildService(true);
    // Guard open: reaches real logic; with no satellite row it throws the domain
    // SATELLITE_NOT_FOUND (NOT the retirement 503), proving the guard no longer blocks.
    expect(() => service.recordHeartbeat({ satelliteId: "sat-1", ts: NOW })).toThrow(
      expect.objectContaining({ code: "SATELLITE_NOT_FOUND" }),
    );
  });
});

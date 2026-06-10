import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import {
  createFridayAckResumeValidator,
  createFridayOutboxMessageRepository,
  createFridayResumeCursorSigner,
  createFridaySatelliteSyncService,
  createFridayStreamCheckpointRepository,
} from "#satellites";
import { createTestDb } from "../_helpers/create-test-db.helper.js";

/**
 * TS Runtime Retirement — METHOD-level guard for the inbound satellite sync
 * engine (orphan off-route leak audit, 2026-06-10 defense-in-depth). `pull`
 * (leases the outbox command-queue + signs a cursor) and `push` (persists acks/
 * node-results) were ROUTE-only-guarded; this proves both fail closed by default
 * BEFORE any checkpoint/outbox/result write. Guards the INBOUND sync engine only
 * — the hub->satellite outbox command-queue and retention GC are separate
 * non-retired services and are unaffected.
 */

const RETIRED_CODE = "TS_RUNTIME_SATELLITE_RUNTIME_RETIRED";
const NOW = "2026-06-10T00:00:00.000Z";
const SECRET = "test-sync-secret"; // pragma: allowlist secret

describe("FridaySatelliteSyncService TS-retirement method guard", () => {
  let db: FridaySqliteLayer;
  const cursorSigner = createFridayResumeCursorSigner(SECRET);
  const ackValidator = createFridayAckResumeValidator(cursorSigner);
  const checkpointRepo = createFridayStreamCheckpointRepository();
  const outboxRepo = createFridayOutboxMessageRepository();

  beforeEach(() => {
    db = createTestDb();
    db.withWriteTransaction((d) => {
      checkpointRepo.bumpEpoch(d, NOW);
    });
  });

  afterEach(() => {
    db.close();
  });

  function buildService(allowTestOnlySatelliteRuntimeExecution?: boolean) {
    return createFridaySatelliteSyncService({
      db,
      checkpointRepo,
      outboxRepo,
      cursorSigner,
      ackValidator,
      nowIso: () => NOW,
      ...(allowTestOnlySatelliteRuntimeExecution === undefined
        ? {}
        : { allowTestOnlySatelliteRuntimeExecution }),
    });
  }

  it("pull fails closed by default: throws 503 fail_closed", () => {
    const service = buildService();
    let caught: unknown;
    try {
      service.pull({ satelliteId: "sat-1", streamId: "fleet.x", lastAckedSeq: 0, subscriptions: [] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FridayDomainError);
    expect((caught as FridayDomainError).code).toBe(RETIRED_CODE);
    expect((caught as FridayDomainError).httpStatus).toBe(503);
  });

  it("push fails closed by default: rejects with 503 fail_closed", async () => {
    const service = buildService();
    await expect(service.push({ satelliteId: "sat-1", acks: [] })).rejects.toMatchObject({
      code: RETIRED_CODE,
      httpStatus: 503,
    });
  });

  it("pull also fails closed when the flag is explicitly false", () => {
    const service = buildService(false);
    expect(() =>
      service.pull({ satelliteId: "sat-1", streamId: "fleet.x", lastAckedSeq: 0, subscriptions: [] }),
    ).toThrow(expect.objectContaining({ code: RETIRED_CODE, httpStatus: 503 }));
  });

  it("pull passes the guard when the test-oracle flag is enabled (returns a result, not the 503)", () => {
    const service = buildService(true);
    const result = service.pull({ satelliteId: "sat-1", streamId: "fleet.x", lastAckedSeq: 0, subscriptions: [] });
    expect(result.streamId).toBe("fleet.x");
  });
});

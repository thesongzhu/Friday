import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import {
  createFridayRealtimeCheckpointRepository,
  createFridayRealtimeEventRepository,
  createFridayRealtimeSubscriptionService,
} from "#api";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

/**
 * TS Runtime Retirement — METHOD-level guard for realtime checkpoint-ack
 * (orphan off-route leak audit, 2026-06-10). `ackEvent` has TWO live ingress
 * points (HTTP /v1/realtime/ack route + WS `ack` frame), both already gating the
 * same flag. This registers that de-facto two-site fence as a single method guard:
 * in default/live config `ackEvent` fails closed BEFORE the checkpoint upsert.
 */

const RETIRED_CODE = "TS_RUNTIME_REALTIME_RETIRED";
const NOW = "2026-06-10T10:00:00.000Z";
const EPOCH = 1;

describe("FridayRealtimeSubscriptionService.ackEvent TS-retirement method guard", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function buildService(allowTestOnlyRealtimeExecution?: boolean) {
    return createFridayRealtimeSubscriptionService({
      db,
      eventRepo: createFridayRealtimeEventRepository(),
      checkpointRepo: createFridayRealtimeCheckpointRepository(),
      nowIso: () => NOW,
      currentEpoch: EPOCH,
      cursorSecret: "test-secret", // pragma: allowlist secret
      ...(allowTestOnlyRealtimeExecution === undefined ? {} : { allowTestOnlyRealtimeExecution }),
    });
  }

  function checkpointExists(): boolean {
    return (
      db.withReadConnection((reader) =>
        (reader
          .prepare("SELECT COUNT(*) AS c FROM realtime_checkpoints")
          .get() as { c: number }).c,
      ) > 0
    );
  }

  it("ackEvent fails closed by default: throws 503 fail_closed and persists no checkpoint", () => {
    const service = buildService();
    let caught: unknown;
    try {
      service.ackEvent("user-1", "workflow:wf-1", 5, EPOCH);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FridayDomainError);
    expect((caught as FridayDomainError).code).toBe(RETIRED_CODE);
    expect((caught as FridayDomainError).httpStatus).toBe(503);
    expect(checkpointExists()).toBe(false);
  });

  it("also fails closed when the flag is explicitly false", () => {
    const service = buildService(false);
    expect(() => service.ackEvent("user-1", "workflow:wf-1", 5, EPOCH)).toThrow(
      expect.objectContaining({ code: RETIRED_CODE, httpStatus: 503 }),
    );
    expect(checkpointExists()).toBe(false);
  });

  it("getCheckpoint (read) stays live without the flag", () => {
    const service = buildService();
    expect(service.getCheckpoint("user-1", "workflow:wf-1")).toBeNull();
  });

  it("ackEvent accepts and persists when the test-oracle flag is enabled (legacy path preserved)", () => {
    const service = buildService(true);
    const result = service.ackEvent("user-1", "workflow:wf-1", 5, EPOCH);
    expect(result.accepted).toBe(true);
    expect(checkpointExists()).toBe(true);
  });
});

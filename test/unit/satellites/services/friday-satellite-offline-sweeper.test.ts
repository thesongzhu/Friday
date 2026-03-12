import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridaySatelliteRepository } from "#satellites";
import { createFridaySatelliteOfflineSweeper } from "#satellites";
import { createTestDb } from "../_helpers/create-test-db.helper.js";

describe("FridaySatelliteOfflineSweeper", () => {
  let db: FridaySqliteLayer;
  const satelliteRepo = createFridaySatelliteRepository();

  function insertSatellite(
    id: string,
    status: string,
    lastSeenAt: string | null,
    createdAt = "2025-01-15T09:00:00.000Z",
  ) {
    db.writer
      .prepare(
        `INSERT INTO satellites (id, type, display_name, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version, tags_json,
         last_seen_at, created_at, updated_at)
         VALUES (?, 'phone', 'Test', ?, 'restricted', 'pk', 1, 'ws', 'linux', 'arm64', '1.0', '22.0', '[]', ?, ?, ?)`,
      )
      .run(id, status, lastSeenAt, createdAt, createdAt);
  }

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("marks stale online satellite as degraded (30-90s)", () => {
    // Last seen 60s ago
    insertSatellite("sat-1", "online", "2025-01-15T09:59:00.000Z");
    const onStatusTransition = vi.fn();
    const sweeper = createFridaySatelliteOfflineSweeper({
      db,
      satelliteRepo,
      nowIso: () => "2025-01-15T10:00:00.000Z",
      onStatusTransition,
    });

    const result = sweeper.sweep("2025-01-15T10:00:00.000Z");
    expect(result.markedDegraded).toBe(1);
    expect(result.markedOffline).toBe(0);
    expect(onStatusTransition).toHaveBeenCalledWith({
      satelliteId: "sat-1",
      fromStatus: "online",
      toStatus: "degraded",
      at: "2025-01-15T10:00:00.000Z",
    });

    const sat = db.writer
      .prepare("SELECT pairing_status FROM satellites WHERE id = 'sat-1'")
      .get() as { pairing_status: string };
    expect(sat.pairing_status).toBe("degraded");
  });

  it("marks very stale satellite as offline (> 90s)", () => {
    // Last seen 120s ago
    insertSatellite("sat-1", "online", "2025-01-15T09:58:00.000Z");
    const onStatusTransition = vi.fn();
    const sweeper = createFridaySatelliteOfflineSweeper({
      db,
      satelliteRepo,
      nowIso: () => "2025-01-15T10:00:00.000Z",
      onStatusTransition,
    });

    const result = sweeper.sweep("2025-01-15T10:00:00.000Z");
    expect(result.markedDegraded).toBe(0);
    expect(result.markedOffline).toBe(1);
    expect(onStatusTransition).toHaveBeenCalledWith({
      satelliteId: "sat-1",
      fromStatus: "online",
      toStatus: "offline",
      at: "2025-01-15T10:00:00.000Z",
    });
  });

  it("leaves revoked satellite untouched", () => {
    insertSatellite("sat-1", "revoked", "2025-01-15T08:00:00.000Z");
    const sweeper = createFridaySatelliteOfflineSweeper({
      db,
      satelliteRepo,
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const result = sweeper.sweep("2025-01-15T10:00:00.000Z");
    expect(result.markedDegraded).toBe(0);
    expect(result.markedOffline).toBe(0);

    const sat = db.writer
      .prepare("SELECT pairing_status FROM satellites WHERE id = 'sat-1'")
      .get() as { pairing_status: string };
    expect(sat.pairing_status).toBe("revoked");
  });

  it("leaves recently seen online satellite alone", () => {
    // Last seen 10s ago — still online
    insertSatellite("sat-1", "online", "2025-01-15T09:59:50.000Z");
    const sweeper = createFridaySatelliteOfflineSweeper({
      db,
      satelliteRepo,
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const result = sweeper.sweep("2025-01-15T10:00:00.000Z");
    expect(result.markedDegraded).toBe(0);
    expect(result.markedOffline).toBe(0);
  });

  it("sweeps multiple satellites with mixed statuses", () => {
    insertSatellite("sat-online-fresh", "online", "2025-01-15T09:59:55.000Z");
    insertSatellite("sat-online-stale", "online", "2025-01-15T09:59:00.000Z"); // 60s → degraded
    insertSatellite("sat-degraded-dead", "degraded", "2025-01-15T09:57:00.000Z"); // 180s → offline
    insertSatellite("sat-revoked", "revoked", "2025-01-15T08:00:00.000Z"); // untouched

    const sweeper = createFridaySatelliteOfflineSweeper({
      db,
      satelliteRepo,
      nowIso: () => "2025-01-15T10:00:00.000Z",
    });

    const result = sweeper.sweep("2025-01-15T10:00:00.000Z");
    expect(result.markedDegraded).toBe(1);
    expect(result.markedOffline).toBe(1);
  });
});

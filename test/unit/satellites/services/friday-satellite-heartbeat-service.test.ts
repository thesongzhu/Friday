import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridaySatelliteRepository } from "#satellites";
import { createFridaySatelliteHeartbeatRepository } from "#satellites";
import { createFridaySatelliteHeartbeatService } from "#satellites";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.helper.js";

describe("FridaySatelliteHeartbeatService", () => {
  let db: FridaySqliteLayer;

  const satelliteRepo = createFridaySatelliteRepository();
  const heartbeatRepo = createFridaySatelliteHeartbeatRepository();

  function insertSatellite(nowIso: string, status = "paired") {
    db.writer
      .prepare(
        `INSERT INTO satellites (id, type, display_name, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version, tags_json, created_at, updated_at)
         VALUES ('sat-1', 'phone', 'Test', ?, 'restricted', 'pk-1', 1, 'ws', 'linux', 'arm64', '1.0', '22.0', '[]', ?, ?)`,
      )
      .run(status, nowIso, nowIso);
  }

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("transitions paired → online with fresh heartbeat (< 30s)", () => {
    const NOW = "2025-01-15T10:00:00.000Z";
    insertSatellite(NOW);

    // Heartbeat timestamp = now (0s age)
    const service = createFridaySatelliteHeartbeatService({
      db,
      satelliteRepo,
      heartbeatRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      allowTestOnlySatelliteRuntimeExecution: true,
    });

    const result = service.recordHeartbeat({
      satelliteId: "sat-1",
      ts: NOW,
    });

    expect(result.accepted).toBe(true);
    expect(result.status).toBe("online");
  });

  it("transitions to degraded when heartbeat age is 30-90s", () => {
    const NOW = "2025-01-15T10:01:00.000Z"; // 60s after heartbeat ts
    insertSatellite("2025-01-15T10:00:00.000Z");

    const service = createFridaySatelliteHeartbeatService({
      db,
      satelliteRepo,
      heartbeatRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      allowTestOnlySatelliteRuntimeExecution: true,
    });

    const result = service.recordHeartbeat({
      satelliteId: "sat-1",
      ts: "2025-01-15T10:00:00.000Z", // 60s old
    });

    expect(result.status).toBe("degraded");
  });

  it("transitions to offline when heartbeat age > 90s", () => {
    const NOW = "2025-01-15T10:02:00.000Z"; // 120s after heartbeat ts
    insertSatellite("2025-01-15T10:00:00.000Z");

    const service = createFridaySatelliteHeartbeatService({
      db,
      satelliteRepo,
      heartbeatRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      allowTestOnlySatelliteRuntimeExecution: true,
    });

    const result = service.recordHeartbeat({
      satelliteId: "sat-1",
      ts: "2025-01-15T10:00:00.000Z", // 120s old
    });

    expect(result.status).toBe("offline");
  });

  it("transitions to degraded on high failure rate", () => {
    const NOW = "2025-01-15T10:00:10.000Z"; // 10s after heartbeat (fresh)
    insertSatellite("2025-01-15T10:00:00.000Z");
    const onStatusTransition = vi.fn();

    const service = createFridaySatelliteHeartbeatService({
      db,
      satelliteRepo,
      heartbeatRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      allowTestOnlySatelliteRuntimeExecution: true,
      onStatusTransition,
    });

    const result = service.recordHeartbeat({
      satelliteId: "sat-1",
      ts: NOW,
      failureRate1m: 0.75, // above 0.5 threshold
    });

    expect(result.status).toBe("degraded");
    expect(onStatusTransition).toHaveBeenCalledWith({
      satelliteId: "sat-1",
      fromStatus: "paired",
      toStatus: "degraded",
      at: NOW,
      failureRate1m: 0.75,
      explicitDisconnect: undefined,
    });
  });

  it("transitions to offline on explicit disconnect", () => {
    const NOW = "2025-01-15T10:00:05.000Z";
    insertSatellite("2025-01-15T10:00:00.000Z", "online");

    const service = createFridaySatelliteHeartbeatService({
      db,
      satelliteRepo,
      heartbeatRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      allowTestOnlySatelliteRuntimeExecution: true,
    });

    const result = service.recordHeartbeat({
      satelliteId: "sat-1",
      ts: NOW,
      explicitDisconnect: true,
    });

    expect(result.status).toBe("offline");
  });

  it("does not promote revoked satellite", () => {
    const NOW = "2025-01-15T10:00:00.000Z";
    insertSatellite(NOW, "revoked");

    const service = createFridaySatelliteHeartbeatService({
      db,
      satelliteRepo,
      heartbeatRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      allowTestOnlySatelliteRuntimeExecution: true,
    });

    const result = service.recordHeartbeat({
      satelliteId: "sat-1",
      ts: NOW,
    });

    expect(result.status).toBe("revoked");
  });

  it("does not emit a transition callback when the status stays the same", () => {
    const NOW = "2025-01-15T10:00:05.000Z";
    insertSatellite("2025-01-15T10:00:00.000Z", "online");
    const onStatusTransition = vi.fn();

    const service = createFridaySatelliteHeartbeatService({
      db,
      satelliteRepo,
      heartbeatRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      allowTestOnlySatelliteRuntimeExecution: true,
      onStatusTransition,
    });

    service.recordHeartbeat({
      satelliteId: "sat-1",
      ts: NOW,
    });

    expect(onStatusTransition).not.toHaveBeenCalled();
  });

  it("records heartbeat row with metrics", () => {
    const NOW = "2025-01-15T10:00:00.000Z";
    insertSatellite(NOW);

    const service = createFridaySatelliteHeartbeatService({
      db,
      satelliteRepo,
      heartbeatRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      allowTestOnlySatelliteRuntimeExecution: true,
    });

    service.recordHeartbeat({
      satelliteId: "sat-1",
      ts: NOW,
      metrics: { cpuPercent: 45, memoryPercent: 60, loadAvg1m: 1.5 },
      queueDepth: 3,
      activeRuns: 1,
    });

    const row = db.writer
      .prepare("SELECT * FROM satellite_heartbeats WHERE satellite_id = 'sat-1'")
      .get() as Record<string, unknown>;
    expect(row.cpu_percent).toBe(45);
    expect(row.memory_percent).toBe(60);
    expect(row.load_avg_1m).toBe(1.5);
    expect(row.queue_depth).toBe(3);
    expect(row.active_runs).toBe(1);
  });

  it("throws for unknown satellite", () => {
    const NOW = "2025-01-15T10:00:00.000Z";
    insertSatellite(NOW);

    const service = createFridaySatelliteHeartbeatService({
      db,
      satelliteRepo,
      heartbeatRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      allowTestOnlySatelliteRuntimeExecution: true,
    });

    expect(() =>
      service.recordHeartbeat({
        satelliteId: "nonexistent",
        ts: NOW,
      }),
    ).toThrow("not found");
  });
});

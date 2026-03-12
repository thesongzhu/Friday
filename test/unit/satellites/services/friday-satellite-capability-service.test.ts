import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridaySatelliteRepository } from "#satellites";
import { createFridaySatelliteCapabilityRepository } from "#satellites";
import { createFridaySatelliteCapabilityService } from "#satellites";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.helper.js";

describe("FridaySatelliteCapabilityService", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  const satelliteRepo = createFridaySatelliteRepository();
  const capabilityRepo = createFridaySatelliteCapabilityRepository();

  beforeEach(() => {
    db = createTestDb();
    // Insert a satellite for FK constraints
    db.writer
      .prepare(
        `INSERT INTO satellites (id, type, display_name, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version, tags_json, created_at, updated_at)
         VALUES ('sat-1', 'phone', 'Test', 'paired', 'restricted', 'pk-1', 1, 'ws', 'linux', 'arm64', '1.0', '22.0', '[]', ?, ?)`,
      )
      .run(NOW, NOW);
  });

  afterEach(() => {
    db.close();
  });

  function createService(revisionCache?: Map<string, number>) {
    return createFridaySatelliteCapabilityService({
      db,
      satelliteRepo,
      capabilityRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      revisionCache: revisionCache ?? new Map(),
    });
  }

  it("accepts capability report with new revision", () => {
    const service = createService();
    const result = service.updateCapabilities({
      satelliteId: "sat-1",
      revision: 1,
      generatedAt: NOW,
      runtime: { os: "linux", arch: "arm64", appVersion: "1.0", nodeVersion: "22.0" },
      capabilities: [
        { key: "camera", available: true },
        { key: "gps", available: false },
      ],
    });

    expect(result.accepted).toBe(true);

    const caps = db.writer
      .prepare("SELECT * FROM satellite_capabilities WHERE satellite_id = 'sat-1' ORDER BY key")
      .all() as Array<Record<string, unknown>>;
    expect(caps).toHaveLength(2);
    expect(caps[0]!.key).toBe("camera");
    expect(caps[1]!.key).toBe("gps");
  });

  it("enforces monotonic revision", () => {
    const cache = new Map<string, number>();
    const service = createService(cache);

    // First report: revision 3
    service.updateCapabilities({
      satelliteId: "sat-1",
      revision: 3,
      generatedAt: NOW,
      runtime: { os: "linux", arch: "arm64", appVersion: "1.0", nodeVersion: "22.0" },
      capabilities: [{ key: "camera", available: true }],
    });

    // Stale report: revision 2
    const result = service.updateCapabilities({
      satelliteId: "sat-1",
      revision: 2,
      generatedAt: NOW,
      runtime: { os: "linux", arch: "arm64", appVersion: "1.0", nodeVersion: "22.0" },
      capabilities: [{ key: "camera", available: false }],
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("Stale revision");
  });

  it("upserts capabilities by (satellite_id, key)", () => {
    const cache = new Map<string, number>();
    const service = createService(cache);

    service.updateCapabilities({
      satelliteId: "sat-1",
      revision: 1,
      generatedAt: NOW,
      runtime: { os: "linux", arch: "arm64", appVersion: "1.0", nodeVersion: "22.0" },
      capabilities: [{ key: "camera", available: true }],
    });

    service.updateCapabilities({
      satelliteId: "sat-1",
      revision: 2,
      generatedAt: NOW,
      runtime: { os: "linux", arch: "arm64", appVersion: "1.0", nodeVersion: "22.0" },
      capabilities: [{ key: "camera", available: false }],
    });

    const caps = db.writer
      .prepare("SELECT available FROM satellite_capabilities WHERE satellite_id = 'sat-1' AND key = 'camera'")
      .get() as { available: number };
    expect(caps.available).toBe(0);
  });

  it("rejects report for unknown satellite", () => {
    const service = createService();
    const result = service.updateCapabilities({
      satelliteId: "nonexistent",
      revision: 1,
      generatedAt: NOW,
      runtime: { os: "linux", arch: "arm64", appVersion: "1.0", nodeVersion: "22.0" },
      capabilities: [],
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("not found");
  });
});

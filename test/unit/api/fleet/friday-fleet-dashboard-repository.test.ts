import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridayFleetDashboardRepository,
  type FridayFleetDashboardRepository,
} from "#api";

describe("FridayFleetDashboardRepository", () => {
  let db: FridaySqliteLayer;
  let repo: FridayFleetDashboardRepository;
  const NOW = "2025-06-15T10:00:00.000Z";

  function insertSatellite(
    id: string,
    opts: {
      displayName?: string;
      type?: string;
      pairingStatus?: string;
      trustLevel?: string;
      tags?: string[];
      deletedAt?: string | null;
    } = {},
  ) {
    db.writer
      .prepare(
        `INSERT INTO satellites (id, display_name, type, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version, tags_json, last_seen_at, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, 'pk', 1, 'ws', 'linux', 'arm64', '1.0', '22.0', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.displayName ?? `Satellite ${id}`,
        opts.type ?? "standard",
        opts.pairingStatus ?? "online",
        opts.trustLevel ?? "trusted",
        JSON.stringify(opts.tags ?? []),
        NOW,
        NOW,
        NOW,
        opts.deletedAt ?? null,
      );
  }

  function insertHeartbeat(
    satelliteId: string,
    ts: string,
    opts: { cpu?: number; mem?: number; load?: number; queue?: number; runs?: number } = {},
  ) {
    db.writer
      .prepare(
        `INSERT INTO satellite_heartbeats (id, satellite_id, ts, status, cpu_percent, memory_percent, load_avg_1m, queue_depth, active_runs)
         VALUES (?, ?, ?, 'ok', ?, ?, ?, ?, ?)`,
      )
      .run(
        `hb-${satelliteId}-${ts}`,
        satelliteId,
        ts,
        opts.cpu ?? 25,
        opts.mem ?? 50,
        opts.load ?? 0.5,
        opts.queue ?? 3,
        opts.runs ?? 1,
      );
  }

  let msgCounter = 0;
  function insertOutboxMessage(
    satelliteId: string,
    status: string,
    id?: string,
  ) {
    msgCounter++;
    db.writer
      .prepare(
        `INSERT INTO outbox_messages (id, satellite_id, queue_key, message_type, payload_ciphertext, nonce, key_id, idempotency_key, status, created_at, updated_at)
         VALUES (?, ?, 'commands', 'task', 'enc', 'n', 'k', ?, ?, ?, ?)`,
      )
      .run(id ?? `msg-${msgCounter}`, satelliteId, `idem-${msgCounter}`, status, NOW, NOW);
  }

  beforeEach(() => {
    db = createTestDb();
    repo = createFridayFleetDashboardRepository();
  });

  afterEach(() => {
    db.close();
  });

  // ─── listSatellitesWithHeartbeat ───

  it("returns satellites with their latest heartbeat", () => {
    insertSatellite("sat-1");
    insertHeartbeat("sat-1", "2025-06-15T09:00:00.000Z", { cpu: 10 });
    insertHeartbeat("sat-1", "2025-06-15T09:30:00.000Z", { cpu: 50 });

    const rows = db.withReadConnection((r) =>
      repo.listSatellitesWithHeartbeat(r),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].cpu_percent).toBe(50); // latest heartbeat
  });

  it("excludes deleted satellites", () => {
    insertSatellite("sat-1");
    insertSatellite("sat-deleted", { deletedAt: NOW });

    const rows = db.withReadConnection((r) =>
      repo.listSatellitesWithHeartbeat(r),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("sat-1");
  });

  it("returns satellite with null heartbeat when no heartbeat exists", () => {
    insertSatellite("sat-no-hb");

    const rows = db.withReadConnection((r) =>
      repo.listSatellitesWithHeartbeat(r),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].hb_ts).toBeNull();
    expect(rows[0].cpu_percent).toBeNull();
  });

  // ─── getQueueStatsBySatellite ───

  it("returns queue stats for a satellite", () => {
    insertSatellite("sat-1");
    insertOutboxMessage("sat-1", "queued", "m1");
    insertOutboxMessage("sat-1", "queued", "m2");
    insertOutboxMessage("sat-1", "leased", "m3");
    insertOutboxMessage("sat-1", "failed", "m4");
    insertOutboxMessage("sat-1", "dead_letter", "m5");

    const stats = db.withReadConnection((r) =>
      repo.getQueueStatsBySatellite(r, "sat-1"),
    );
    expect(stats).not.toBeNull();
    expect(stats!.queued_count).toBe(2);
    expect(stats!.leased_count).toBe(1);
    expect(stats!.failed_count).toBe(1);
    expect(stats!.dead_letter_count).toBe(1);
  });

  it("returns null when no outbox messages for satellite", () => {
    insertSatellite("sat-1");
    const stats = db.withReadConnection((r) =>
      repo.getQueueStatsBySatellite(r, "sat-1"),
    );
    expect(stats).toBeNull();
  });

  // ─── getGlobalQueueStats ───

  it("returns global queue stats across all satellites", () => {
    insertSatellite("sat-1");
    insertSatellite("sat-2");
    insertOutboxMessage("sat-1", "queued", "m1");
    insertOutboxMessage("sat-2", "queued", "m2");
    insertOutboxMessage("sat-2", "failed", "m3");

    const stats = db.withReadConnection((r) => repo.getGlobalQueueStats(r));
    expect(stats.queued_count).toBe(2);
    expect(stats.failed_count).toBe(1);
  });

  it("returns zero/null counts when no messages exist", () => {
    const stats = db.withReadConnection((r) => repo.getGlobalQueueStats(r));
    // SUM() returns null when no rows match, so the fallback object provides 0
    // But the actual query may return null for each SUM column
    expect(stats.queued_count ?? 0).toBe(0);
    expect(stats.leased_count ?? 0).toBe(0);
  });

  // ─── getPairingStatusCounts ───

  it("returns counts by pairing status", () => {
    insertSatellite("sat-1", { pairingStatus: "online" });
    insertSatellite("sat-2", { pairingStatus: "online" });
    insertSatellite("sat-3", { pairingStatus: "pending" });
    insertSatellite("sat-4", { pairingStatus: "revoked" });
    insertSatellite("sat-del", { pairingStatus: "online", deletedAt: NOW });

    const counts = db.withReadConnection((r) => repo.getPairingStatusCounts(r));
    const map: Record<string, number> = {};
    for (const row of counts) map[row.pairing_status] = row.count;

    expect(map["online"]).toBe(2);
    expect(map["pending"]).toBe(1);
    expect(map["revoked"]).toBe(1);
  });

  // ─── getDeadLetterCount ───

  it("returns dead letter count for satellite", () => {
    insertSatellite("sat-1");
    insertOutboxMessage("sat-1", "dead_letter", "m1");
    insertOutboxMessage("sat-1", "dead_letter", "m2");
    insertOutboxMessage("sat-1", "queued", "m3");

    const count = db.withReadConnection((r) =>
      repo.getDeadLetterCount(r, "sat-1"),
    );
    expect(count).toBe(2);
  });

  // ─── getCapabilities ───

  it("returns capabilities for a satellite", () => {
    insertSatellite("sat-1");
    db.writer
      .prepare(
        `INSERT INTO satellite_capabilities (id, satellite_id, key, available, limits_json, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("cap-1", "sat-1", "gpu", 1, '{"maxVram": 8192}', null, NOW, NOW);

    const caps = db.withReadConnection((r) =>
      repo.getCapabilities(r, "sat-1"),
    );
    expect(caps).toHaveLength(1);
    expect(caps[0].key).toBe("gpu");
    expect(caps[0].available).toBe(1);
    expect(JSON.parse(caps[0].limits_json!)).toEqual({ maxVram: 8192 });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayFleetDashboardService } from "#api";
import type { FridayFleetDashboardService } from "#api";
import { FridayDomainError } from "#errors";

describe("FridayFleetDashboardService", () => {
  let db: FridaySqliteLayer;
  let service: FridayFleetDashboardService;
  let outboxQueueService: {
    requeueExpiredLeases: ReturnType<typeof vi.fn>;
    expireByTtl: ReturnType<typeof vi.fn>;
  };
  const NOW = "2025-06-15T10:00:00.000Z";

  function insertSatellite(
    id: string,
    opts: {
      displayName?: string;
      type?: string;
      pairingStatus?: string;
      trustLevel?: string;
      tags?: string[];
    } = {},
  ) {
    db.writer
      .prepare(
        `INSERT INTO satellites (id, display_name, type, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version, tags_json, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pk', 1, 'ws', 'linux', 'arm64', '1.0', '22.0', ?, ?, ?, ?)`,
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

  function insertApiToken(
    tokenId: string,
    opts: { scopes?: string[]; revokedAt?: string | null; expiresAt?: string | null } = {},
  ) {
    db.writer
      .prepare(
        `INSERT INTO api_tokens (id, user_id, principal_type, label, token_hash, scopes_json, expires_at, revoked_at, created_at, updated_at)
         VALUES (?, 'test-user', 'user', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tokenId,
        `Token ${tokenId}`,
        `hash-${tokenId}`,
        JSON.stringify(opts.scopes ?? ["workflow.read"]),
        opts.expiresAt ?? null,
        opts.revokedAt ?? null,
        NOW,
        NOW,
      );
  }

  function insertPairingRequest(id: string, status: string) {
    db.writer
      .prepare(
        `INSERT INTO satellite_pairing_requests (id, satellite_id, code, nonce, status, expires_at, created_at, updated_at)
         VALUES (?, ?, 'code-123', 'nonce-456', ?, ?, ?, ?)`,
      )
      .run(id, "sat-pending", status, "2099-01-01T00:00:00.000Z", NOW, NOW);
  }

  function insertOutboxMessage(
    messageId: string,
    satelliteId: string,
    status: "failed" | "dead_letter" | "queued" = "failed",
  ) {
    db.writer
      .prepare(
        `INSERT INTO outbox_messages (
          id, satellite_id, queue_key, message_type, payload_ciphertext, nonce, key_id, idempotency_key,
          status, attempts, max_attempts, deliver_after, expires_at, last_error_code, last_error_message,
          leased_until, acked_at, created_at, updated_at
        ) VALUES (?, ?, 'fleet:commands', 'sync', 'cipher', 'nonce', 'key-1', ?, ?, 1, 5, ?, ?, 'ERR', 'failed', null, null, ?, ?)`,
      )
      .run(
        messageId,
        satelliteId,
        `idem-${messageId}`,
        status,
        NOW,
        "2099-01-01T00:00:00.000Z",
        NOW,
        NOW,
      );
  }

  beforeEach(() => {
    db = createTestDb();
    outboxQueueService = {
      requeueExpiredLeases: vi.fn(async () => 2),
      expireByTtl: vi.fn(async () => 3),
    };
    service = createFridayFleetDashboardService({
      db,
      nowIso: () => NOW,
      idGenerator: createTestIdGenerator(),
      outboxQueueService,
    });
  });

  afterEach(() => {
    db.close();
  });

  // ─── getOverview ───

  it("returns fleet overview with totals", () => {
    insertSatellite("sat-1", { pairingStatus: "online" });
    insertSatellite("sat-2", { pairingStatus: "online" });
    insertSatellite("sat-3", { pairingStatus: "pending" });
    insertHeartbeat("sat-1", "2025-06-15T09:59:55.000Z"); // 5s old
    insertHeartbeat("sat-2", "2025-06-15T09:59:55.000Z");

    const overview = service.getOverview();
    expect(overview.generatedAt).toBe(NOW);
    expect(overview.totals.satellites).toBe(3);
    expect(overview.totals.online).toBe(2);
    expect(overview.totals.pending).toBe(1);
  });

  it("derives runtime readiness counts from real heartbeat and health instead of pairing status labels", () => {
    insertSatellite("sat-offline", { pairingStatus: "paired" });
    insertSatellite("sat-degraded", { pairingStatus: "paired" });
    insertHeartbeat("sat-degraded", "2025-06-15T09:59:55.000Z", { cpu: 95, mem: 95, load: 1.2, queue: 80 });

    const overview = service.getOverview();
    expect(overview.totals.paired).toBe(2);
    expect(overview.totals.online).toBe(0);
    expect(overview.totals.degraded).toBe(1);
    expect(overview.totals.offline).toBe(1);
  });

  it("returns health score and state", () => {
    insertSatellite("sat-1", { pairingStatus: "online" });
    insertHeartbeat("sat-1", "2025-06-15T09:59:55.000Z", { cpu: 10, mem: 15 });

    const overview = service.getOverview();
    expect(overview.health.score).toBeGreaterThan(0);
    expect(["healthy", "degraded", "critical"]).toContain(overview.health.state);
  });

  it("returns trust metrics", () => {
    insertSatellite("sat-1", { pairingStatus: "online", trustLevel: "trusted" });

    const overview = service.getOverview();
    expect(overview.trust.averageScore).toBeGreaterThan(0);
  });

  it("returns empty overview when no satellites exist", () => {
    const overview = service.getOverview();
    expect(overview.totals.satellites).toBe(0);
    expect(overview.health.score).toBe(100); // default when no satellites
    expect(overview.health.state).toBe("healthy");
  });

  // ─── listSatellites ───

  it("lists all satellites as cards", () => {
    insertSatellite("sat-1");
    insertSatellite("sat-2");
    insertHeartbeat("sat-1", "2025-06-15T09:59:55.000Z");
    insertHeartbeat("sat-2", "2025-06-15T09:59:55.000Z");

    const result = service.listSatellites({});
    expect(result.items).toHaveLength(2);
    expect(result.items[0].satelliteId).toBeTruthy();
    expect(result.items[0].healthState).toBeTruthy();
    expect(result.items[0].trustBand).toBeTruthy();
  });

  it("filters by pairing status", () => {
    insertSatellite("sat-1", { pairingStatus: "online" });
    insertSatellite("sat-2", { pairingStatus: "pending" });

    const result = service.listSatellites({ pairingStatus: "online" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].pairingStatus).toBe("online");
  });

  it("filters by trust level", () => {
    insertSatellite("sat-1", { trustLevel: "trusted" });
    insertSatellite("sat-2", { trustLevel: "restricted" });

    const result = service.listSatellites({ trustLevel: "trusted" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].trustLevel).toBe("trusted");
  });

  it("search by display name", () => {
    insertSatellite("sat-alpha", { displayName: "Alpha Bot" });
    insertSatellite("sat-beta", { displayName: "Beta Bot" });

    const result = service.listSatellites({ q: "alpha" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].displayName).toBe("Alpha Bot");
  });

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) {
      insertSatellite(`sat-${i}`);
    }

    const result = service.listSatellites({ limit: 2 });
    expect(result.items.length).toBeLessThanOrEqual(2);
  });

  it("satellite card includes health and trust data", () => {
    // With no heartbeat, health is degraded (not critical: hb=0, resource=100, queue=100, reliability=100 → 65)
    // revoked+restricted trust: identity=20, status=0, hygiene=20 → 40 = medium
    insertSatellite("sat-crit", { pairingStatus: "revoked", trustLevel: "restricted" });

    const result = service.listSatellites({});
    const card = result.items.find((c) => c.satelliteId === "sat-crit");
    expect(card).toBeTruthy();
    expect(card!.healthState).toBe("degraded");
    expect(card!.trustBand).toBe("medium");
    expect(card!.pairingStatus).toBe("revoked");
  });

  // ─── getSatelliteDetail ───

  it("returns detailed satellite information", () => {
    insertSatellite("sat-1");
    insertHeartbeat("sat-1", "2025-06-15T09:59:55.000Z", { cpu: 30, mem: 40 });

    db.writer
      .prepare(
        `INSERT INTO satellite_capabilities (id, satellite_id, key, available, limits_json, metadata_json, created_at, updated_at)
         VALUES (?, ?, 'gpu', 1, '{"maxVram": 8192}', null, ?, ?)`,
      )
      .run("cap-1", "sat-1", NOW, NOW);

    const detail = service.getSatelliteDetail("sat-1");
    expect(detail).not.toBeNull();
    expect(detail!.satellite.satelliteId).toBe("sat-1");
    expect(detail!.capabilities).toHaveLength(1);
    expect(detail!.capabilities[0].key).toBe("gpu");
    expect(detail!.capabilities[0].available).toBe(true);
    expect(detail!.healthBreakdown).toBeTruthy();
    expect(detail!.trustBreakdown).toBeTruthy();
    expect(detail!.pairingDiagnostics.transport).toBe("ws");
    expect(detail!.routeSelection.target).toBe("/observability");
  });

  it("returns null for unknown satellite", () => {
    const detail = service.getSatelliteDetail("nonexistent");
    expect(detail).toBeNull();
  });

  it("returns remediation actions for degraded satellites with queue pressure", () => {
    insertSatellite("sat-remediate", { pairingStatus: "degraded" });
    insertOutboxMessage("msg-failed", "sat-remediate", "failed");
    insertOutboxMessage("msg-dead", "sat-remediate", "dead_letter");

    const detail = service.getSatelliteDetail("sat-remediate");
    expect(detail?.remediation.status).toBe("blocked");
    expect(detail?.remediation.actions.map((action) => action.actionId)).toContain("requeue_expired_leases");
    expect(detail?.remediation.actions.map((action) => action.actionId)).toContain("expire_stale_messages");
    expect(detail?.runtimeRecovery.state).toBe("degraded");
    expect(detail?.runtimeRecovery.queueRecoveryState).toBe("blocked");
    expect(detail?.runtimeRecovery.syncRecoveryState).toBe("recovering");
    expect(detail?.runtimeRecovery.nextOperatorAction).toBe("restore_heartbeat");
    expect(detail?.runtimeRecovery.requiresOperatorIntervention).toBe(true);
    expect(detail?.remediation.reasons).toContain(
      "Heartbeat, degraded health, or stale telemetry currently block safe fleet remediation.",
    );
    expect(detail?.routeSelection.target).toBe("/fleet");
    expect(detail?.routeSelection.state).toBe("recover");
  });

  it("marks revoked satellites as halted runtime recovery", () => {
    insertSatellite("sat-revoked", { pairingStatus: "revoked", trustLevel: "revoked" });

    const detail = service.getSatelliteDetail("sat-revoked");
    expect(detail?.runtimeRecovery.state).toBe("halted");
    expect(detail?.runtimeRecovery.nextOperatorAction).toBe("re_authorize_satellite");
    expect(detail?.runtimeRecovery.requiresOperatorIntervention).toBe(true);
    expect(detail?.runtimeRecovery.continuationMode).toBe("already_dispatched_only");
    expect(detail?.runtimeRecovery.offlinePlanningMode).toBe("deferred");
    expect(detail?.pairingDiagnostics.requiresReauthorization).toBe(true);
    expect(detail?.routeSelection.target).toBe("/fleet");
    expect(detail?.routeSelection.state).toBe("blocked");
  });

  it("returns pending pairing diagnostics for satellites awaiting approval", () => {
    insertSatellite("sat-pending", { pairingStatus: "pending" });
    insertPairingRequest("pair-1", "pending");

    const detail = service.getSatelliteDetail("sat-pending");

    expect(detail?.pairingDiagnostics.pendingRequest).toMatchObject({
      requestId: "pair-1",
      pairingCode: "code-123",
      status: "pending",
    });
    expect(detail?.pairingDiagnostics.requiresReauthorization).toBe(true);
    expect(detail?.routeSelection.target).toBe("/fleet");
  });

  it("returns remediation plan helper data", () => {
    insertSatellite("sat-plan", { pairingStatus: "degraded" });
    insertOutboxMessage("msg-plan", "sat-plan", "failed");

    const plan = service.getSatelliteRemediationPlan("sat-plan");
    expect(plan).not.toBeNull();
    expect(plan?.actions.some((action) => action.actionId === "requeue_expired_leases")).toBe(true);
  });

  it("executes requeue remediation actions through the outbox queue service", async () => {
    insertSatellite("sat-requeue", { pairingStatus: "degraded" });
    insertOutboxMessage("msg-requeue", "sat-requeue", "failed");

    const result = await service.executeSatelliteRemediationAction({
      satelliteId: "sat-requeue",
      actionId: "requeue_expired_leases",
    });

    expect(outboxQueueService.requeueExpiredLeases).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("completed");
    expect(result.affectedCount).toBe(2);
    expect(result.satelliteId).toBe("sat-requeue");
    expect(result.actionId).toBe("requeue_expired_leases");
    expect(result.executedAt).toBe(NOW);
  });

  it("executes ttl expiry remediation actions through the outbox queue service", async () => {
    insertSatellite("sat-expire", { pairingStatus: "degraded" });
    insertOutboxMessage("msg-expire", "sat-expire", "dead_letter");

    const result = await service.executeSatelliteRemediationAction({
      satelliteId: "sat-expire",
      actionId: "expire_stale_messages",
    });

    expect(outboxQueueService.expireByTtl).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("completed");
    expect(result.affectedCount).toBe(3);
    expect(result.satelliteId).toBe("sat-expire");
    expect(result.actionId).toBe("expire_stale_messages");
    expect(result.executedAt).toBe(NOW);
  });

  it("throws a domain error for unsupported remediation actions", async () => {
    insertSatellite("sat-unsupported");

    await expect(
      service.executeSatelliteRemediationAction({
        satelliteId: "sat-unsupported",
        actionId: "invalid_action",
      }),
    ).rejects.toMatchObject<Partial<FridayDomainError>>({
      code: "UNSUPPORTED_REMEDIATION_ACTION",
      httpStatus: 400,
    });
  });

  // ─── getSecurityCenter ───

  it("returns security center with token stats", () => {
    insertApiToken("tok-1", { scopes: ["workflow.read"] });
    insertApiToken("tok-2", { scopes: ["hub.admin"], revokedAt: "2025-06-15T05:00:00.000Z" });
    insertApiToken("tok-3", { scopes: ["workflow.read"], expiresAt: "2025-06-14T00:00:00.000Z" });

    const security = service.getSecurityCenter();
    expect(security.generatedAt).toBe(NOW);
    expect(security.tokens.active).toBeGreaterThanOrEqual(1);
    expect(security.tokens.revoked24h).toBeGreaterThanOrEqual(1);
  });

  it("returns pending pairing count", () => {
    insertSatellite("sat-pending", { pairingStatus: "pending" });
    insertPairingRequest("pr-1", "pending");
    insertPairingRequest("pr-2", "pending");
    insertPairingRequest("pr-3", "approved");

    const security = service.getSecurityCenter();
    expect(security.satellites.pendingPairings).toBe(2);
  });

  it("counts high-privilege active tokens", () => {
    insertApiToken("tok-admin-1", { scopes: ["hub.admin"] });
    insertApiToken("tok-admin-2", { scopes: ["security.write"] });
    insertApiToken("tok-normal", { scopes: ["workflow.read"] });

    const security = service.getSecurityCenter();
    expect(security.tokens.highPrivilegeActive).toBe(2);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFridayOutboxMessageRepository, createFridayOutboxQueueService } from "#satellites";
import { createFridayWorkflowSatelliteDispatchService } from "#workflows";
import type { FridaySqliteLayer } from "#state";
import type { FridayCompiledWorkflowGraphV2 } from "#workflows";
import { createTestDb, createTestIdGenerator } from "./_helpers/create-test-db.helper.js";

describe("FridayWorkflowSatelliteDispatchService", () => {
  let db: FridaySqliteLayer;

  function insertSatellite(
    id: string,
    pairingStatus: string,
    trustLevel: string = "trusted",
  ) {
    db.writer.prepare(
      `INSERT INTO satellites (
         id, display_name, type, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version,
         tags_json, last_seen_at, created_at, updated_at
       ) VALUES (?, ?, 'standard', ?, ?, 'pk', 1, 'https', 'linux', 'arm64', '1.0', '22.0', '[]', ?, ?, ?)`,
    ).run(id, `Satellite ${id}`, pairingStatus, trustLevel, "2026-03-07T12:00:00.000Z", "2026-03-07T12:00:00.000Z", "2026-03-07T12:00:00.000Z");
  }

  function insertHeartbeat(id: string, queueDepth: number, activeRuns: number) {
    db.writer.prepare(
      `INSERT INTO satellite_heartbeats (
         id, satellite_id, ts, status, cpu_percent, memory_percent, load_avg_1m, queue_depth, active_runs
       ) VALUES (?, ?, ?, 'ok', 10, 20, 0.2, ?, ?)`,
    ).run(`hb-${id}`, id, "2026-03-07T12:00:00.000Z", queueDepth, activeRuns);
  }

  function insertCapability(id: string, key: string) {
    db.writer.prepare(
      `INSERT INTO satellite_capabilities (
         id, satellite_id, key, available, limits_json, metadata_json, created_at, updated_at
       ) VALUES (?, ?, ?, 1, NULL, NULL, ?, ?)`,
    ).run(`cap-${id}-${key}`, id, key, "2026-03-07T12:00:00.000Z", "2026-03-07T12:00:00.000Z");
  }

  function buildNode(config: Record<string, unknown>): FridayCompiledWorkflowGraphV2["graph"]["nodes"][number] {
    return {
      id: "node-1",
      type: "action",
      label: "Node 1",
      config,
    };
  }

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("keeps hub-targeted nodes local", async () => {
    const service = createFridayWorkflowSatelliteDispatchService({
      db,
      outbox: createFridayOutboxQueueService({
        db,
        outboxRepo: createFridayOutboxMessageRepository(),
        idGenerator: createTestIdGenerator(),
        nowIso: () => "2026-03-07T12:00:00.000Z",
      }),
      nowIso: () => "2026-03-07T12:00:00.000Z",
    });

    const result = await service.dispatchNode({
      runId: "run-1",
      workflowId: "wf-1",
      workflowVersionId: "wv-1",
      nodeId: "node-1",
      attemptId: "attempt-1",
      attempt: 1,
      node: buildNode({ executionTarget: "hub" }),
      inputData: {},
      expressionContext: { inputs: {}, steps: {} },
      idempotencyKey: "idem-1",
    });

    expect(result).toEqual({ kind: "hub" });
  });

  it("dispatches to an explicit online satellite and enqueues a workflow command", async () => {
    insertSatellite("sat-1", "online", "trusted");
    insertHeartbeat("sat-1", 1, 1);

    const outbox = createFridayOutboxQueueService({
      db,
      outboxRepo: createFridayOutboxMessageRepository(),
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2026-03-07T12:00:00.000Z",
    });
    const service = createFridayWorkflowSatelliteDispatchService({
      db,
      outbox,
      nowIso: () => "2026-03-07T12:00:00.000Z",
    });

    const result = await service.dispatchNode({
      runId: "run-1",
      workflowId: "wf-1",
      workflowVersionId: "wv-1",
      nodeId: "node-1",
      attemptId: "attempt-1",
      attempt: 1,
      node: buildNode({ executionTarget: "satellite:sat-1" }),
      inputData: { input: "value" },
      expressionContext: { inputs: { foo: "bar" }, steps: {} },
      idempotencyKey: "idem-1",
    });

    expect(result).toMatchObject({
      kind: "satellite_dispatched",
      satelliteId: "sat-1",
      leaseOwner: "satellite:sat-1",
    });

    const leased = outbox.leaseBatch({
      satelliteId: "sat-1",
      limit: 10,
      leaseMs: 60_000,
      nowIso: "2026-03-07T12:00:01.000Z",
    });
    expect(leased).toHaveLength(1);
    expect(leased[0]!.messageType).toBe("workflow.node.execute");
    const payload = JSON.parse(Buffer.from(leased[0]!.payloadCiphertext, "base64").toString("utf8"));
    expect(payload).toMatchObject({
      runId: "run-1",
      workflowId: "wf-1",
      workflowVersionId: "wv-1",
      nodeId: "node-1",
      attemptId: "attempt-1",
      attempt: 1,
    });
  });

  it("blocks explicit offline satellites without silently falling back to hub", async () => {
    insertSatellite("sat-1", "offline");

    const service = createFridayWorkflowSatelliteDispatchService({
      db,
      outbox: createFridayOutboxQueueService({
        db,
        outboxRepo: createFridayOutboxMessageRepository(),
        idGenerator: createTestIdGenerator(),
        nowIso: () => "2026-03-07T12:00:00.000Z",
      }),
      nowIso: () => "2026-03-07T12:00:00.000Z",
    });

    const result = await service.dispatchNode({
      runId: "run-1",
      workflowId: "wf-1",
      workflowVersionId: "wv-1",
      nodeId: "node-1",
      attemptId: "attempt-1",
      attempt: 1,
      node: buildNode({ executionTarget: "satellite:sat-1" }),
      inputData: {},
      expressionContext: { inputs: {}, steps: {} },
      idempotencyKey: "idem-1",
    });

    expect(result).toMatchObject({
      kind: "blocked",
      satelliteId: "sat-1",
      code: "SATELLITE_OFFLINE",
      retryable: true,
    });
  });

  it("uses capability-match placement and prefers trusted lower-pressure satellites", async () => {
    insertSatellite("sat-trusted", "online", "trusted");
    insertSatellite("sat-restricted", "online", "restricted");
    insertHeartbeat("sat-trusted", 1, 1);
    insertHeartbeat("sat-restricted", 7, 3);
    insertCapability("sat-trusted", "browser");
    insertCapability("sat-restricted", "browser");

    const outbox = createFridayOutboxQueueService({
      db,
      outboxRepo: createFridayOutboxMessageRepository(),
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2026-03-07T12:00:00.000Z",
    });
    const service = createFridayWorkflowSatelliteDispatchService({
      db,
      outbox,
      nowIso: () => "2026-03-07T12:00:00.000Z",
    });

    const result = await service.dispatchNode({
      runId: "run-1",
      workflowId: "wf-1",
      workflowVersionId: "wv-1",
      nodeId: "node-1",
      attemptId: "attempt-1",
      attempt: 1,
      node: buildNode({
        executionTarget: "capability-match",
        executionCapabilities: ["browser"],
      }),
      inputData: {},
      expressionContext: { inputs: {}, steps: {} },
      idempotencyKey: "idem-1",
    });

    expect(result).toMatchObject({
      kind: "satellite_dispatched",
      satelliteId: "sat-trusted",
    });
  });
});

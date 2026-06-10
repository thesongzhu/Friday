import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridayResumeCursorSigner } from "#satellites";
import { createFridayAckResumeValidator } from "#satellites";
import { createFridayStreamCheckpointRepository } from "#satellites";
import { createFridayOutboxMessageRepository } from "#satellites";
import { createFridaySatelliteSyncService } from "#satellites";
import { createTestDb } from "../_helpers/create-test-db.helper.js";

describe("FridaySatelliteSyncService", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";
  const SECRET = "test-sync-secret";

  const cursorSigner = createFridayResumeCursorSigner(SECRET);
  const ackValidator = createFridayAckResumeValidator(cursorSigner);
  const checkpointRepo = createFridayStreamCheckpointRepository();
  const outboxRepo = createFridayOutboxMessageRepository();

  function insertSatellite(id: string) {
    db.writer
      .prepare(
        `INSERT INTO satellites (id, type, display_name, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version, tags_json, created_at, updated_at)
         VALUES (?, 'phone', 'Test', 'online', 'restricted', 'pk', 1, 'ws', 'linux', 'arm64', '1.0', '22.0', '[]', ?, ?)`,
      )
      .run(id, NOW, NOW);
  }

  beforeEach(() => {
    db = createTestDb();
    insertSatellite("sat-1");
    // Set up epoch
    db.withWriteTransaction((d) => {
      checkpointRepo.bumpEpoch(d, NOW);
    });
  });

  afterEach(() => {
    db.close();
  });

  function createService() {
    return createFridaySatelliteSyncService({
      db,
      checkpointRepo,
      outboxRepo,
      cursorSigner,
      ackValidator,
      nowIso: () => NOW,
      allowTestOnlySatelliteRuntimeExecution: true,
    });
  }

  it("push forwards local events to learningEventWriter when configured", async () => {
    const writer = vi.fn();
    const service = createFridaySatelliteSyncService({
      db,
      checkpointRepo,
      outboxRepo,
      cursorSigner,
      ackValidator,
      nowIso: () => NOW,
      allowTestOnlySatelliteRuntimeExecution: true,
      learningEventWriter: writer,
    });

    const localEvents = [
      {
        eventId: "evt-local-1",
        ts: NOW,
        userId: "test-user",
        kind: "user_message" as const,
        payload: { text: "call me friday" },
      },
    ];

    const result = await service.push({
      satelliteId: "sat-1",
      acks: [],
      localEvents,
    });

    expect(result.conflicts).toHaveLength(0);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledWith(localEvents);
  });

  it("push accepts local events when learningEventWriter is not configured", async () => {
    const service = createService();

    const result = await service.push({
      satelliteId: "sat-1",
      acks: [],
      localEvents: [
        {
          eventId: "evt-local-2",
          ts: NOW,
          userId: "test-user",
          kind: "assistant_message",
          payload: { text: "ok" },
        },
      ],
    });

    expect(result.conflicts).toHaveLength(0);
  });

  it("pull returns epoch and generates cursor", () => {
    const service = createService();
    const result = service.pull({
      satelliteId: "sat-1",
      streamId: "stream-1",
      lastAckedSeq: 0,
      subscriptions: ["events"],
    });

    expect(result.epoch).toBe(1);
    expect(result.streamId).toBe("stream-1");
    expect(result.nextCursor).toBeTruthy();
    expect(result.fullPullRequired).toBeUndefined();
  });

  it("pull leases queued offline messages and push acks them through the outbox stream", async () => {
    db.withWriteTransaction((d) => {
      outboxRepo.insertMessage(d, "cmd-1", {
        satelliteId: "sat-1",
        queueKey: "workflow:run-1",
        messageType: "workflow.node.execute",
        payloadCiphertext: Buffer.from(JSON.stringify({ runId: "run-1" }), "utf8").toString("base64"),
        nonce: "inline",
        keyId: "inline:v1",
        idempotencyKey: "idem-cmd-1",
      }, NOW);
    });

    const service = createService();
    const pulled = service.pull({
      satelliteId: "sat-1",
      streamId: "outbox",
      lastAckedSeq: 0,
      subscriptions: ["workflow.node.execute"],
    });

    expect(pulled.queueItems).toHaveLength(1);
    expect(pulled.queueItems[0]).toMatchObject({
      id: "cmd-1",
      messageType: "workflow.node.execute",
    });

    const pushed = await service.push({
      satelliteId: "sat-1",
      acks: [{ streamId: "outbox", seq: pulled.queueItems[0]!.seq, epoch: pulled.epoch }],
    });

    expect(pushed.conflicts).toHaveLength(0);
    expect(pushed.acceptedAcks).toEqual([{ streamId: "outbox", seq: pulled.queueItems[0]!.seq }]);

    const message = db.withReadConnection((d) => outboxRepo.getMessage(d, "cmd-1"));
    expect(message?.status).toBe("acked");
  });

  it("pull does not lease queued messages when subscriptions are empty or invalid", () => {
    db.withWriteTransaction((d) => {
      outboxRepo.insertMessage(d, "cmd-no-sub", {
        satelliteId: "sat-1",
        queueKey: "workflow:run-no-sub",
        messageType: "workflow.node.execute",
        payloadCiphertext: Buffer.from(JSON.stringify({ runId: "run-no-sub" }), "utf8").toString("base64"),
        nonce: "inline",
        keyId: "inline:v1",
        idempotencyKey: "idem-no-sub",
      }, NOW);
    });

    const service = createService();
    const pulled = service.pull({
      satelliteId: "sat-1",
      streamId: "outbox",
      lastAckedSeq: 0,
      subscriptions: ["outbox", "  "],
    });

    expect(pulled.queueItems).toEqual([]);
    const message = db.withReadConnection((d) => outboxRepo.getMessage(d, "cmd-no-sub"));
    expect(message?.status).toBe("queued");
  });

  it("pull leases only subscribed message types", () => {
    db.withWriteTransaction((d) => {
      outboxRepo.insertMessage(d, "cmd-other", {
        satelliteId: "sat-1",
        queueKey: "other:1",
        messageType: "other.command",
        payloadCiphertext: Buffer.from(JSON.stringify({ ok: true }), "utf8").toString("base64"),
        nonce: "inline",
        keyId: "inline:v1",
        idempotencyKey: "idem-other",
      }, NOW);
      outboxRepo.insertMessage(d, "cmd-workflow", {
        satelliteId: "sat-1",
        queueKey: "workflow:run-1",
        messageType: "workflow.node.execute",
        payloadCiphertext: Buffer.from(JSON.stringify({ runId: "run-1" }), "utf8").toString("base64"),
        nonce: "inline",
        keyId: "inline:v1",
        idempotencyKey: "idem-workflow",
      }, NOW);
    });

    const service = createService();
    const pulled = service.pull({
      satelliteId: "sat-1",
      streamId: "outbox",
      lastAckedSeq: 0,
      subscriptions: ["workflow.node.execute"],
    });

    expect(pulled.queueItems).toHaveLength(1);
    expect(pulled.queueItems[0]).toMatchObject({
      id: "cmd-workflow",
      messageType: "workflow.node.execute",
    });

    const other = db.withReadConnection((d) => outboxRepo.getMessage(d, "cmd-other"));
    const workflow = db.withReadConnection((d) => outboxRepo.getMessage(d, "cmd-workflow"));
    expect(other?.status).toBe("queued");
    expect(workflow?.status).toBe("leased");
  });

  it("push reports node results and surfaces stale-attempt conflicts", async () => {
    const writer = vi.fn(async (input) => {
      if (input.attemptId === "attempt-stale") {
        throw Object.assign(new Error("Workflow node attempt number mismatch"), {
          code: "WORKFLOW_RUN_NODE_ATTEMPT_MISMATCH",
        });
      }
    });
    const service = createFridaySatelliteSyncService({
      db,
      checkpointRepo,
      outboxRepo,
      cursorSigner,
      ackValidator,
      nowIso: () => NOW,
      allowTestOnlySatelliteRuntimeExecution: true,
      remoteNodeResultWriter: writer,
    });

    const result = await service.push({
      satelliteId: "sat-1",
      acks: [],
      nodeResults: [
        {
          runId: "run-1",
          nodeId: "node-a",
          attemptId: "attempt-ok",
          attempt: 1,
          status: "completed",
          output: { ok: true },
        },
        {
          runId: "run-1",
          nodeId: "node-a",
          attemptId: "attempt-stale",
          attempt: 0,
          status: "completed",
        },
      ],
    });

    expect(writer).toHaveBeenCalledTimes(2);
    expect(result.acceptedNodeResults).toEqual([
      { runId: "run-1", nodeId: "node-a", attemptId: "attempt-ok" },
    ]);
    expect(result.conflicts).toContainEqual({
      streamId: "workflow:run-1",
      seq: 0,
      code: "WORKFLOW_RUN_NODE_ATTEMPT_MISMATCH",
      message: "Workflow node attempt number mismatch",
    });
  });

  it("does not ack leased outbox messages when a pushed node result is rejected", async () => {
    db.withWriteTransaction((d) => {
      outboxRepo.insertMessage(d, "cmd-rejected-result", {
        satelliteId: "sat-1",
        queueKey: "workflow:run-1",
        messageType: "workflow.node.execute",
        payloadCiphertext: Buffer.from(JSON.stringify({ runId: "run-1" }), "utf8").toString("base64"),
        nonce: "inline",
        keyId: "inline:v1",
        idempotencyKey: "idem-rejected-result",
      }, NOW);
    });
    const writer = vi.fn(async () => {
      throw Object.assign(new Error("Workflow node attempt number mismatch"), {
        code: "WORKFLOW_RUN_NODE_ATTEMPT_MISMATCH",
      });
    });
    const service = createFridaySatelliteSyncService({
      db,
      checkpointRepo,
      outboxRepo,
      cursorSigner,
      ackValidator,
      nowIso: () => NOW,
      allowTestOnlySatelliteRuntimeExecution: true,
      remoteNodeResultWriter: writer,
    });
    const pulled = service.pull({
      satelliteId: "sat-1",
      streamId: "outbox",
      lastAckedSeq: 0,
      subscriptions: ["workflow.node.execute"],
    });

    const result = await service.push({
      satelliteId: "sat-1",
      acks: [{ streamId: "outbox", seq: pulled.queueItems[0]!.seq, epoch: pulled.epoch }],
      nodeResults: [{
        runId: "run-1",
        nodeId: "node-a",
        attemptId: "attempt-stale",
        attempt: 0,
        status: "completed",
      }],
    });

    expect(result.acceptedAcks).toEqual([]);
    expect(result.conflicts).toEqual(expect.arrayContaining([
      {
        streamId: "workflow:run-1",
        seq: 0,
        code: "WORKFLOW_RUN_NODE_ATTEMPT_MISMATCH",
        message: "Workflow node attempt number mismatch",
      },
      {
        streamId: "outbox",
        seq: pulled.queueItems[0]!.seq,
        code: "SATELLITE_ACK_BLOCKED_BY_NODE_RESULT_CONFLICT",
        message: "Ack was not accepted because one or more node results in the push were rejected",
      },
    ]));

    const message = db.withReadConnection((d) => outboxRepo.getMessage(d, "cmd-rejected-result"));
    expect(message?.status).toBe("leased");
  });

  it("pull with valid resume cursor succeeds", () => {
    const service = createService();
    const cursor = cursorSigner.sign({
      seq: 5,
      streamId: "stream-1",
      epoch: 1,
      issuedAt: NOW,
    });

    const result = service.pull({
      satelliteId: "sat-1",
      streamId: "stream-1",
      lastAckedSeq: 5,
      subscriptions: ["events"],
      resumeCursor: cursor,
    });

    expect(result.fullPullRequired).toBeUndefined();
  });

  it("pull with stale epoch cursor returns fullPullRequired", () => {
    const service = createService();
    const cursor = cursorSigner.sign({
      seq: 5,
      streamId: "stream-1",
      epoch: 999, // wrong epoch
      issuedAt: NOW,
    });

    const result = service.pull({
      satelliteId: "sat-1",
      streamId: "stream-1",
      lastAckedSeq: 5,
      subscriptions: ["events"],
      resumeCursor: cursor,
    });

    expect(result.fullPullRequired).toBe(true);
  });

  it("push accepts acks with correct epoch and advances checkpoint", async () => {
    const service = createService();
    const result = await service.push({
      satelliteId: "sat-1",
      acks: [{ streamId: "stream-1", seq: 10, epoch: 1 }],
    });

    expect(result.acceptedAcks).toHaveLength(1);
    expect(result.acceptedAcks[0]).toEqual({ streamId: "stream-1", seq: 10 });
    expect(result.conflicts).toHaveLength(0);

    // Verify checkpoint persisted
    const lastSeq = db.withReadConnection((d) =>
      checkpointRepo.getLastAckedSeq(d, "sat-1", "stream-1"),
    );
    expect(lastSeq).toBe(10);
  });

  it("push rejects acks with stale epoch", async () => {
    const service = createService();
    const result = await service.push({
      satelliteId: "sat-1",
      acks: [{ streamId: "stream-1", seq: 10, epoch: 999 }],
    });

    expect(result.acceptedAcks).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.code).toBe("STREAM_EPOCH_STALE");
  });

  it("push enforces monotonic checkpoint (idempotent on duplicate)", async () => {
    const service = createService();

    // First push
    await service.push({
      satelliteId: "sat-1",
      acks: [{ streamId: "stream-1", seq: 10, epoch: 1 }],
    });

    // Second push with lower seq — still accepted (idempotent)
    const result = await service.push({
      satelliteId: "sat-1",
      acks: [{ streamId: "stream-1", seq: 5, epoch: 1 }],
    });

    expect(result.acceptedAcks).toHaveLength(1);

    // Checkpoint should not regress
    const lastSeq = db.withReadConnection((d) =>
      checkpointRepo.getLastAckedSeq(d, "sat-1", "stream-1"),
    );
    expect(lastSeq).toBe(10);
  });

  it("push rejects ack with tampered cursor", async () => {
    const service = createService();
    const result = await service.push({
      satelliteId: "sat-1",
      acks: [{ streamId: "stream-1", seq: 10, epoch: 1, cursor: "tampered.cursor" }],
    });

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.code).toBe("AUTH_UNAUTHORIZED");
  });
});

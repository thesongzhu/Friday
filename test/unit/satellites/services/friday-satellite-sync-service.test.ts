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
    });
  }

  it("push forwards local events to learningEventWriter when configured", () => {
    const writer = vi.fn();
    const service = createFridaySatelliteSyncService({
      db,
      checkpointRepo,
      outboxRepo,
      cursorSigner,
      ackValidator,
      nowIso: () => NOW,
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

    const result = service.push({
      satelliteId: "sat-1",
      acks: [],
      localEvents,
    });

    expect(result.conflicts).toHaveLength(0);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledWith(localEvents);
  });

  it("push accepts local events when learningEventWriter is not configured", () => {
    const service = createService();

    const result = service.push({
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

  it("push accepts acks with correct epoch and advances checkpoint", () => {
    const service = createService();
    const result = service.push({
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

  it("push rejects acks with stale epoch", () => {
    const service = createService();
    const result = service.push({
      satelliteId: "sat-1",
      acks: [{ streamId: "stream-1", seq: 10, epoch: 999 }],
    });

    expect(result.acceptedAcks).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.code).toBe("STREAM_EPOCH_STALE");
  });

  it("push enforces monotonic checkpoint (idempotent on duplicate)", () => {
    const service = createService();

    // First push
    service.push({
      satelliteId: "sat-1",
      acks: [{ streamId: "stream-1", seq: 10, epoch: 1 }],
    });

    // Second push with lower seq — still accepted (idempotent)
    const result = service.push({
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

  it("push rejects ack with tampered cursor", () => {
    const service = createService();
    const result = service.push({
      satelliteId: "sat-1",
      acks: [{ streamId: "stream-1", seq: 10, epoch: 1, cursor: "tampered.cursor" }],
    });

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.code).toBe("AUTH_UNAUTHORIZED");
  });
});

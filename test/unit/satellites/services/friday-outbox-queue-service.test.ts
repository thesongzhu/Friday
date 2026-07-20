import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import type { FridayOutboxEnqueueInput } from "#satellites";
import { createFridayOutboxMessageRepository } from "#satellites";
import { createFridayOutboxQueueService } from "#satellites";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.helper.js";

describe("FridayOutboxQueueService", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  function insertSatellite(id: string) {
    db.writer
      .prepare(
        `INSERT INTO satellites (id, type, display_name, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version, tags_json, created_at, updated_at)
         VALUES (?, 'phone', 'Test', 'online', 'restricted', 'pk', 1, 'ws', 'linux', 'arm64', '1.0', '22.0', '[]', ?, ?)`,
      )
      .run(id, NOW, NOW);
  }

  const baseEnqueue: FridayOutboxEnqueueInput = {
    satelliteId: "sat-1",
    queueKey: "commands",
    messageType: "skill.execute",
    payloadCiphertext: "encrypted-data",
    nonce: "nonce-1",
    keyId: "key-1",
    idempotencyKey: "idem-1",
    logicalPayloadDigest: "logical-digest-base",
  };

  beforeEach(() => {
    db = createTestDb();
    insertSatellite("sat-1");
  });

  afterEach(() => {
    db.close();
  });

  function createService(nowIso = NOW) {
    return createFridayOutboxQueueService({
      db,
      outboxRepo: createFridayOutboxMessageRepository(),
      idGenerator: createTestIdGenerator(),
      nowIso: () => nowIso,
    });
  }

  it("enqueues message with queued status", () => {
    const service = createService();
    const { id } = service.enqueue(baseEnqueue);
    expect(id).toBeTruthy();

    const row = db.writer
      .prepare("SELECT status FROM outbox_messages WHERE id = ?")
      .get(id) as { status: string };
    expect(row.status).toBe("queued");
  });

  it("idempotent enqueue with same idempotency key", () => {
    const service = createService();
    service.enqueue(baseEnqueue);
    // Second enqueue with same key should not throw
    const { id: id2 } = service.enqueue(baseEnqueue);

    const count = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM outbox_messages WHERE satellite_id = 'sat-1'")
      .get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it("leaseBatch transitions queued → leased", () => {
    const service = createService();
    service.enqueue(baseEnqueue);
    service.enqueue({ ...baseEnqueue, idempotencyKey: "idem-2" });

    const leased = service.leaseBatch({
      satelliteId: "sat-1",
      limit: 10,
      leaseMs: 30_000,
    });

    expect(leased).toHaveLength(2);
    expect(leased[0]!.messageType).toBe("skill.execute");

    // Verify DB status
    const rows = db.writer
      .prepare("SELECT status FROM outbox_messages WHERE satellite_id = 'sat-1'")
      .all() as Array<{ status: string }>;
    expect(rows.every((r) => r.status === "leased")).toBe(true);
  });

  it("ackUpToSeq transitions leased → acked", () => {
    const service = createService();
    service.enqueue(baseEnqueue);

    const leased = service.leaseBatch({
      satelliteId: "sat-1",
      limit: 10,
      leaseMs: 30_000,
    });
    expect(leased).toHaveLength(1);

    const result = service.ackUpToSeq({
      satelliteId: "sat-1",
      streamId: "stream-1",
      seq: leased[0]!.seq,
    });

    expect(result.acked).toBe(1);

    const row = db.writer
      .prepare("SELECT status FROM outbox_messages WHERE id = ?")
      .get(leased[0]!.id) as { status: string };
    expect(row.status).toBe("acked");
  });

  it("failLeasedMessage with retryable goes back to queued", () => {
    const service = createService();
    const { id } = service.enqueue(baseEnqueue);

    service.leaseBatch({
      satelliteId: "sat-1",
      limit: 10,
      leaseMs: 30_000,
    });

    const result = service.failLeasedMessage({
      messageId: id,
      satelliteId: "sat-1",
      errorCode: "TIMEOUT",
      errorMessage: "Connection timeout",
      retryable: true,
    });

    expect(result.status).toBe("queued");
    expect(result.nextDeliverAfter).toBeTruthy();
  });

  it("failLeasedMessage non-retryable goes to dead_letter", () => {
    const service = createService();
    const { id } = service.enqueue(baseEnqueue);

    service.leaseBatch({
      satelliteId: "sat-1",
      limit: 10,
      leaseMs: 30_000,
    });

    const result = service.failLeasedMessage({
      messageId: id,
      satelliteId: "sat-1",
      errorCode: "INVALID_PAYLOAD",
      errorMessage: "Cannot parse payload",
      retryable: false,
    });

    expect(result.status).toBe("dead_letter");
  });

  it("failLeasedMessage exceeding max_attempts goes to dead_letter", () => {
    const service = createService();
    const { id } = service.enqueue({ ...baseEnqueue, maxAttempts: 1 });

    service.leaseBatch({
      satelliteId: "sat-1",
      limit: 10,
      leaseMs: 30_000,
    });

    const result = service.failLeasedMessage({
      messageId: id,
      satelliteId: "sat-1",
      errorCode: "TIMEOUT",
      errorMessage: "Timeout",
      retryable: true,
    });

    expect(result.status).toBe("dead_letter");
  });

  it("requeueExpiredLeases puts expired leases back to queued", () => {
    const service = createService();
    service.enqueue(baseEnqueue);

    // Lease with very short lease time
    service.leaseBatch({
      satelliteId: "sat-1",
      limit: 10,
      leaseMs: 1, // 1ms lease
      nowIso: NOW,
    });

    // Time passes, lease expires
    const laterService = createService("2025-01-15T10:01:00.000Z");
    const requeued = laterService.requeueExpiredLeases("2025-01-15T10:01:00.000Z");
    expect(requeued).toBe(1);
  });

  it("expireByTtl marks expired messages", () => {
    const service = createService();
    service.enqueue({
      ...baseEnqueue,
      expiresAt: "2025-01-15T09:00:00.000Z", // already expired
    });

    const expired = service.expireByTtl();
    expect(expired).toBe(1);

    const row = db.writer
      .prepare("SELECT status FROM outbox_messages")
      .get() as { status: string };
    expect(row.status).toBe("expired");
  });

  it("does not lease messages with future deliverAfter", () => {
    const service = createService();
    service.enqueue({
      ...baseEnqueue,
      deliverAfter: "2025-01-15T11:00:00.000Z",
    });

    const leased = service.leaseBatch({
      satelliteId: "sat-1",
      limit: 10,
      leaseMs: 30_000,
    });

    expect(leased).toHaveLength(0);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridaySatellitePairingRequestRepository } from "#satellites";
import { createFridaySatelliteHeartbeatRepository } from "#satellites";
import { createFridayOutboxMessageRepository } from "#satellites";
import { createFridayLearningEventLedger } from "#ledger";
import { createFridaySkillRunStore } from "#ledger";
import { createFridayRetentionJob } from "#jobs";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

describe("FridayRetentionJob", () => {
  let db: FridaySqliteLayer;

  const NOW = "2025-06-15T10:00:00.000Z";

  const pairingRequestRepo = createFridaySatellitePairingRequestRepository();
  const heartbeatRepo = createFridaySatelliteHeartbeatRepository();
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
  });

  afterEach(() => {
    db.close();
  });

  function createJob(policy?: Partial<{
    learningEventsDays: number;
    heartbeatsDays: number;
    pairingRequestsDays: number;
    outboxTerminalDays: number;
    skillRunTerminalDays: number;
  }>) {
    return createFridayRetentionJob({
      db,
      pairingRequestRepo,
      heartbeatRepo,
      outboxRepo,
      learningLedger: createFridayLearningEventLedger({ db }),
      skillRunStore: createFridaySkillRunStore({ db }),
      nowIso: () => NOW,
      policy: {
        learningEventsDays: 90,
        heartbeatsDays: 7,
        pairingRequestsDays: 7,
        outboxTerminalDays: 14,
        skillRunTerminalDays: 30,
        ...policy,
      },
    });
  }

  it("marks stale pending pairing requests as expired", () => {
    // Expired request
    db.writer
      .prepare(
        `INSERT INTO satellite_pairing_requests (id, satellite_id, code, nonce, status, expires_at, created_at, updated_at)
         VALUES ('req-1', 'sat-1', '123456', 'nonce', 'pending', '2025-06-14T00:00:00.000Z', ?, ?)`,
      )
      .run(NOW, NOW);

    // Non-expired request
    db.writer
      .prepare(
        `INSERT INTO satellite_pairing_requests (id, satellite_id, code, nonce, status, expires_at, created_at, updated_at)
         VALUES ('req-2', 'sat-1', '654321', 'nonce', 'pending', '2025-06-16T00:00:00.000Z', ?, ?)`,
      )
      .run(NOW, NOW);

    const job = createJob();
    const result = job.run(NOW);

    expect(result.markedPairingExpired).toBe(1);

    const req = db.writer
      .prepare("SELECT status FROM satellite_pairing_requests WHERE id = 'req-1'")
      .get() as { status: string };
    expect(req.status).toBe("expired");
  });

  it("deletes old resolved pairing requests", () => {
    // Old approved request (> 7 days ago)
    db.writer
      .prepare(
        `INSERT INTO satellite_pairing_requests (id, satellite_id, code, nonce, status, expires_at, created_at, updated_at)
         VALUES ('req-old', 'sat-1', '123456', 'nonce', 'approved', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
      )
      .run();

    const job = createJob();
    const result = job.run(NOW);

    expect(result.deletedPairingRequests).toBe(1);
  });

  it("deletes old heartbeats", () => {
    // Old heartbeat (> 7 days ago)
    db.writer
      .prepare(
        `INSERT INTO satellite_heartbeats (id, satellite_id, ts, status)
         VALUES ('hb-old', 'sat-1', '2025-01-01T00:00:00.000Z', 'online')`,
      )
      .run();

    // Recent heartbeat
    db.writer
      .prepare(
        `INSERT INTO satellite_heartbeats (id, satellite_id, ts, status)
         VALUES ('hb-new', 'sat-1', '2025-06-15T09:00:00.000Z', 'online')`,
      )
      .run();

    const job = createJob();
    const result = job.run(NOW);

    expect(result.deletedHeartbeats).toBe(1);
  });

  it("marks TTL-expired outbox messages", () => {
    db.withWriteTransaction((d) => {
      outboxRepo.insertMessage(d, "msg-expired", {
        satelliteId: "sat-1",
        queueKey: "commands",
        messageType: "test",
        payloadCiphertext: "data",
        nonce: "n",
        keyId: "k",
        idempotencyKey: "idem-1",
        expiresAt: "2025-06-14T00:00:00.000Z", // already expired
      }, NOW);
    });

    const job = createJob();
    const result = job.run(NOW);

    expect(result.markedOutboxExpired).toBe(1);
  });

  it("deletes old terminal outbox messages", () => {
    // Insert and ack a message, then backdate it
    db.withWriteTransaction((d) => {
      outboxRepo.insertMessage(d, "msg-old", {
        satelliteId: "sat-1",
        queueKey: "commands",
        messageType: "test",
        payloadCiphertext: "data",
        nonce: "n",
        keyId: "k",
        idempotencyKey: "idem-2",
      }, "2025-01-01T00:00:00.000Z");
    });
    // Mark as acked with old date
    db.writer
      .prepare(
        "UPDATE outbox_messages SET status = 'acked', updated_at = '2025-01-01T00:00:00.000Z' WHERE id = 'msg-old'",
      )
      .run();

    const job = createJob();
    const result = job.run(NOW);

    expect(result.deletedOutboxTerminal).toBe(1);
  });

  it("deletes old learning events", () => {
    db.writer
      .prepare(
        `INSERT INTO learning_events (event_id, ts, user_id, kind, payload_json, created_at)
         VALUES ('evt-old', '2024-01-01T00:00:00.000Z', 'test-user', 'user_message', '{}', '2024-01-01T00:00:00.000Z')`,
      )
      .run();

    db.writer
      .prepare(
        `INSERT INTO learning_events (event_id, ts, user_id, kind, payload_json, created_at)
         VALUES ('evt-new', '2025-06-14T00:00:00.000Z', 'test-user', 'user_message', '{}', '2025-06-14T00:00:00.000Z')`,
      )
      .run();

    const job = createJob();
    const result = job.run(NOW);

    expect(result.deletedLearningEvents).toBe(1);
  });

  it("deletes old terminal skill run snapshots", () => {
    const store = createFridaySkillRunStore({ db });
    store.upsertRun({
      runId: "run-old",
      skillId: "s",
      version: "1.0",
      status: "completed",
      currentStepId: "step",
      attemptsByStep: {},
      state: {},
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      sessionId: "sess",
      userId: "test-user",
      channel: "discord",
      lastTransitionAt: "2024-01-01T00:00:00.000Z",
    });

    store.upsertRun({
      runId: "run-recent",
      skillId: "s",
      version: "1.0",
      status: "completed",
      currentStepId: "step",
      attemptsByStep: {},
      state: {},
      startedAt: NOW,
      updatedAt: NOW,
      sessionId: "sess",
      userId: "test-user",
      channel: "discord",
      lastTransitionAt: NOW,
    });

    const job = createJob();
    const result = job.run(NOW);

    expect(result.deletedSkillRuns).toBe(1);
  });

  it("returns all zeros when nothing to clean", () => {
    const job = createJob();
    const result = job.run(NOW);

    expect(result.markedPairingExpired).toBe(0);
    expect(result.deletedPairingRequests).toBe(0);
    expect(result.deletedHeartbeats).toBe(0);
    expect(result.markedOutboxExpired).toBe(0);
    expect(result.deletedOutboxTerminal).toBe(0);
    expect(result.deletedLearningEvents).toBe(0);
    expect(result.deletedSkillRuns).toBe(0);
  });

  it("preserves non-expired rows", () => {
    // Recent pending pairing request (not yet expired)
    db.writer
      .prepare(
        `INSERT INTO satellite_pairing_requests (id, satellite_id, code, nonce, status, expires_at, created_at, updated_at)
         VALUES ('req-fresh', 'sat-1', '000000', 'nonce', 'pending', '2025-06-16T00:00:00.000Z', ?, ?)`,
      )
      .run(NOW, NOW);

    // Recent heartbeat
    db.writer
      .prepare(
        `INSERT INTO satellite_heartbeats (id, satellite_id, ts, status)
         VALUES ('hb-fresh', 'sat-1', ?, 'online')`,
      )
      .run(NOW);

    // Running skill run (non-terminal)
    const store = createFridaySkillRunStore({ db });
    store.upsertRun({
      runId: "run-active",
      skillId: "s",
      version: "1.0",
      status: "running",
      currentStepId: "step",
      attemptsByStep: {},
      state: {},
      startedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      sessionId: "sess",
      userId: "test-user",
      channel: "discord",
      lastTransitionAt: "2024-01-01T00:00:00.000Z",
    });

    const job = createJob();
    const result = job.run(NOW);

    expect(result.markedPairingExpired).toBe(0);
    expect(result.deletedHeartbeats).toBe(0);
    expect(result.deletedSkillRuns).toBe(0);

    // Active run preserved
    const run = store.getRun("run-active");
    expect(run).not.toBeNull();
  });
});

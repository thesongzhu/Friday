import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridaySatellitePairingRequestRepository } from "#satellites";
import { createFridaySatelliteHeartbeatRepository } from "#satellites";
import { createFridayOutboxMessageRepository } from "#satellites";
import { createFridayLearningEventLedger } from "#ledger";
import { createFridaySkillRunStore } from "#ledger";
import { createFridaySetupBootstrapNonceRepository } from "#api";
import { createFridayRetentionJob } from "#jobs";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

describe("FridayRetentionJob", () => {
  let db: FridaySqliteLayer;

  const NOW = "2025-06-15T10:00:00.000Z";

  const pairingRequestRepo = createFridaySatellitePairingRequestRepository();
  const heartbeatRepo = createFridaySatelliteHeartbeatRepository();
  const outboxRepo = createFridayOutboxMessageRepository();
  const bootstrapNonceRepo = createFridaySetupBootstrapNonceRepository();

  function insertNonce(
    id: string,
    over?: Partial<{ expiresAt: string; consumedAt: string | null; kind: string }>,
  ) {
    // kind CHECK allows only 'install_owner_claim'; consumed rows are also bound
    // by the partial UNIQUE(kind) WHERE consumed_at IS NOT NULL, so tests that
    // need multiple consumed rows must key off distinct behaviour, not kind.
    db.writer
      .prepare(
        `INSERT INTO friday_setup_bootstrap_nonces
           (id, nonce_hash, kind, hub_id, install_id, os_user, origin, action,
            created_at, expires_at, consumed_at)
         VALUES (?, ?, 'install_owner_claim', 'h', 'i', 'u', 'o', 'owner-claim', ?, ?, ?)`,
      )
      .run(
        id,
        `hash-${id}`,
        "2024-01-01T00:00:00.000Z",
        over?.expiresAt ?? "2999-01-01T00:00:00.000Z",
        over?.consumedAt ?? null,
      );
  }

  function countNonces(): number {
    return (
      db.writer
        .prepare("SELECT COUNT(*) AS c FROM friday_setup_bootstrap_nonces")
        .get() as { c: number }
    ).c;
  }

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
    auditLogsDays: number;
    agentRunsDays: number;
    llmUsageRecordsDays: number;
    errorIncidentsDays: number;
    bootstrapNoncesConsumedDays: number;
  }>) {
    return createFridayRetentionJob({
      db,
      pairingRequestRepo,
      heartbeatRepo,
      outboxRepo,
      learningLedger: createFridayLearningEventLedger({ db }),
      skillRunStore: createFridaySkillRunStore({ db }),
      bootstrapNonceRepo,
      nowIso: () => NOW,
      policy: {
        learningEventsDays: 90,
        heartbeatsDays: 7,
        pairingRequestsDays: 7,
        outboxTerminalDays: 14,
        skillRunTerminalDays: 30,
        auditLogsDays: 90,
        agentRunsDays: 90,
        llmUsageRecordsDays: 180,
        errorIncidentsDays: 90,
        bootstrapNoncesConsumedDays: 365,
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

  it("keeps earlier cleanup commits when a later retention step fails", () => {
    db.writer
      .prepare(
        `INSERT INTO satellite_heartbeats (id, satellite_id, ts, status)
         VALUES ('hb-old', 'sat-1', '2025-01-01T00:00:00.000Z', 'online')`,
      )
      .run();
    db.writer.exec("DROP TABLE learning_events");

    const job = createJob();

    expect(() => job.run(NOW)).toThrow(/learning_events/i);
    const heartbeat = db.writer
      .prepare("SELECT id FROM satellite_heartbeats WHERE id = 'hb-old'")
      .get();
    expect(heartbeat).toBeUndefined();
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

    const legacyRows = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM memory_items WHERE namespace = 'skill_runs'")
      .get() as { cnt: number };
    expect(legacyRows.cnt).toBe(0);
  });

  it("does not delete legacy memory_items skill_runs during retention", () => {
    db.writer
      .prepare(
        `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
         VALUES ('legacy-run-old', 'skill_runs', 'legacy-run-old', ?, ?, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
      )
      .run(
        JSON.stringify({
          runId: "legacy-run-old",
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
        }),
        JSON.stringify(["skill:s", "status:completed", "user:test-user"]),
      );

    const job = createJob();
    const result = job.run(NOW);

    const legacyRows = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM memory_items WHERE namespace = 'skill_runs'")
      .get() as { cnt: number };
    expect(result.deletedSkillRuns).toBe(0);
    expect(legacyRows.cnt).toBe(1);
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
    expect(result.deletedAuditLogs).toBe(0);
    expect(result.deletedAgentRuns).toBe(0);
    expect(result.deletedLlmUsageRecords).toBe(0);
    expect(result.deletedErrorIncidents).toBe(0);
    expect(result.deletedExpiredBootstrapNonces).toBe(0);
    expect(result.deletedConsumedBootstrapNonces).toBe(0);
  });

  it("reaps expired unconsumed bootstrap nonces but preserves live ones", () => {
    // Expired + unconsumed → dead weight, must be reaped.
    insertNonce("nonce-expired", { expiresAt: "2025-06-14T00:00:00.000Z", consumedAt: null });
    // Not yet expired + unconsumed → live, must be preserved.
    insertNonce("nonce-live", { expiresAt: "2025-06-16T00:00:00.000Z", consumedAt: null });

    const job = createJob();
    const result = job.run(NOW);

    expect(result.deletedExpiredBootstrapNonces).toBe(1);
    expect(result.deletedConsumedBootstrapNonces).toBe(0);
    const remaining = db.writer
      .prepare("SELECT id FROM friday_setup_bootstrap_nonces")
      .all() as Array<{ id: string }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("nonce-live");
  });

  it("reaps a consumed bootstrap nonce past the retention horizon", () => {
    // Only ONE consumed owner-claim row can exist (partial UNIQUE(kind) WHERE
    // consumed_at IS NOT NULL). Consumed long ago (> 365 days) → reaped.
    insertNonce("nonce-old-consumed", {
      expiresAt: "2024-01-01T00:05:00.000Z",
      consumedAt: "2024-01-01T00:00:00.000Z",
    });

    const job = createJob();
    const result = job.run(NOW);

    expect(result.deletedConsumedBootstrapNonces).toBe(1);
    expect(result.deletedExpiredBootstrapNonces).toBe(0);
    expect(countNonces()).toBe(0);
  });

  it("keeps a recently-consumed bootstrap nonce (within the retention horizon)", () => {
    // Consumed recently (well within 365 days) → kept.
    insertNonce("nonce-recent-consumed", {
      expiresAt: "2025-06-15T00:05:00.000Z",
      consumedAt: "2025-06-14T00:00:00.000Z",
    });

    const job = createJob();
    const result = job.run(NOW);

    expect(result.deletedConsumedBootstrapNonces).toBe(0);
    expect(countNonces()).toBe(1);
  });

  it("never reaps a consumed nonce still within the retention horizon", () => {
    // consumed_at == cutoff boundary (NOW - 365d) is NOT strictly older → kept.
    insertNonce("nonce-boundary", {
      expiresAt: "2024-06-15T10:05:00.000Z",
      consumedAt: "2024-06-15T10:00:00.000Z", // exactly 365 days before NOW
    });

    const job = createJob();
    const result = job.run(NOW);

    expect(result.deletedConsumedBootstrapNonces).toBe(0);
    expect(countNonces()).toBe(1);
  });

  it("deletes old audit logs", () => {
    db.writer
      .prepare(
        `INSERT INTO audit_logs (id, ts, actor_type, actor_id, action, resource_type, resource_id)
         VALUES ('al-old', '2024-01-01T00:00:00.000Z', 'user', 'u1', 'create', 'skill', 's1')`,
      )
      .run();
    db.writer
      .prepare(
        `INSERT INTO audit_logs (id, ts, actor_type, actor_id, action, resource_type, resource_id)
         VALUES ('al-new', '2025-06-14T00:00:00.000Z', 'user', 'u1', 'create', 'skill', 's2')`,
      )
      .run();

    const job = createJob();
    const result = job.run(NOW);

    expect(result.deletedAuditLogs).toBe(1);
  });

  it("deletes old terminal agent runs and cascades events", () => {
    // Old completed agent run
    db.writer
      .prepare(
        `INSERT INTO friday_agent_runs (id, session_key, task, status, created_at)
         VALUES ('run-old', 'cli:u1:chat', 'old task', 'completed', '2024-01-01T00:00:00.000Z')`,
      )
      .run();

    // Recent agent run
    db.writer
      .prepare(
        `INSERT INTO friday_agent_runs (id, session_key, task, status, created_at)
         VALUES ('run-new', 'cli:u1:chat', 'new task', 'completed', '2025-06-14T00:00:00.000Z')`,
      )
      .run();

    const job = createJob();
    const result = job.run(NOW);

    expect(result.deletedAgentRuns).toBe(1);
    // Recent run preserved
    const remaining = db.writer
      .prepare("SELECT id FROM friday_agent_runs")
      .all() as Array<{ id: string }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("run-new");
  });

  it("deletes old LLM usage records", () => {
    db.writer
      .prepare(
        `INSERT INTO llm_usage_records (id, occurred_at, usage_day, usage_month, provider_id, provider_kind, provider_api, model,
         route_strategy, task_complexity, input_tokens, output_tokens, total_tokens, cost_usd, created_at)
         VALUES ('llm-old', '2024-01-01T00:00:00.000Z', '2024-01-01', '2024-01', 'p1', 'api', 'anthropic', 'm1',
         'configured', 'simple', 100, 50, 150, 0.01, '2024-01-01T00:00:00.000Z')`,
      )
      .run();

    db.writer
      .prepare(
        `INSERT INTO llm_usage_records (id, occurred_at, usage_day, usage_month, provider_id, provider_kind, provider_api, model,
         route_strategy, task_complexity, input_tokens, output_tokens, total_tokens, cost_usd, created_at)
         VALUES ('llm-new', '2025-06-14T00:00:00.000Z', '2025-06-14', '2025-06', 'p1', 'api', 'anthropic', 'm1',
         'configured', 'simple', 100, 50, 150, 0.01, '2025-06-14T00:00:00.000Z')`,
      )
      .run();

    const job = createJob();
    const result = job.run(NOW);

    expect(result.deletedLlmUsageRecords).toBe(1);
  });

  it("deletes old resolved error incidents but preserves unresolved ones", () => {
    // Old resolved incident (uses 'test-user' from createTestDb)
    db.writer
      .prepare(
        `INSERT INTO error_incidents (incident_id, user_id, ts, category, severity, signature, context_json, status, created_at, updated_at)
         VALUES ('ei-old', 'test-user', '2024-01-01T00:00:00.000Z', 'tool', 'low', 'sig1', '{}', 'resolved', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
      )
      .run();

    // Old unresolved incident (should be preserved)
    db.writer
      .prepare(
        `INSERT INTO error_incidents (incident_id, user_id, ts, category, severity, signature, context_json, status, created_at, updated_at)
         VALUES ('ei-open', 'test-user', '2024-01-01T00:00:00.000Z', 'tool', 'high', 'sig2', '{}', 'open', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
      )
      .run();

    const job = createJob();
    const result = job.run(NOW);

    expect(result.deletedErrorIncidents).toBe(1);
    // Unresolved incident preserved
    const remaining = db.writer
      .prepare("SELECT incident_id FROM error_incidents")
      .all() as Array<{ incident_id: string }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].incident_id).toBe("ei-open");
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

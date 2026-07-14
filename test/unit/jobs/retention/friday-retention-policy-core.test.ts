import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import {
  createFridaySatellitePairingRequestRepository,
  createFridaySatelliteHeartbeatRepository,
  createFridayOutboxMessageRepository,
} from "#satellites";
import { createFridayLearningEventLedger, createFridaySkillRunStore } from "#ledger";
import { createFridaySetupBootstrapNonceRepository } from "#api";
import { createFridayRetentionJob, FRIDAY_DEFAULT_RETENTION_POLICY } from "#jobs";
import type { FridayRetentionPolicy } from "#jobs";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

/**
 * RETENTION-POLICY-CORE (R1+R2) matrix.
 *
 * Requirement anchors: DATA-RETENTION-001 / U9-DATA-RETENTION (all local data
 * default-PERMANENT until the user deletes; automatic time-based cleanup
 * default-OFF; user-controlled per category; fail-closed on bad config).
 *
 * Production seam: retention-sweep job (registered unconditionally,
 * friday-hub-bootstrap.ts) -> satelliteRuntime.retention.run() ->
 * friday-retention-job.ts -> per-category DELETE.
 */
describe("FridayRetentionJob — RETENTION-POLICY-CORE", () => {
  let db: FridaySqliteLayer;

  // Reference "now" used by seed timestamps.
  const NOW = "2025-06-15T10:00:00.000Z";
  // A "far future" now: every seeded row is older than any conceivable window.
  const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

  const pairingRequestRepo = createFridaySatellitePairingRequestRepository();
  const heartbeatRepo = createFridaySatelliteHeartbeatRepository();
  const outboxRepo = createFridayOutboxMessageRepository();
  const bootstrapNonceRepo = createFridaySetupBootstrapNonceRepository();

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

  // ── seed helpers (one aged row per CONTENT category) ─────────────────────
  const AGED = "2024-01-01T00:00:00.000Z";

  function seedAgedAuditLog(id = "al-old") {
    db.writer
      .prepare(
        `INSERT INTO audit_logs (id, ts, actor_type, actor_id, action, resource_type, resource_id)
         VALUES (?, ?, 'user', 'u1', 'create', 'skill', 's1')`,
      )
      .run(id, AGED);
  }

  function seedAgedAgentRun(id = "run-old") {
    db.writer
      .prepare(
        `INSERT INTO friday_agent_runs (id, session_key, task, status, created_at)
         VALUES (?, 'cli:u1:chat', 'old task', 'completed', ?)`,
      )
      .run(id, AGED);
  }

  function seedAgedSkillRun(runId = "srun-old") {
    createFridaySkillRunStore({ db }).upsertRun({
      runId,
      skillId: "s",
      version: "1.0",
      status: "completed",
      currentStepId: "step",
      attemptsByStep: {},
      state: {},
      startedAt: AGED,
      updatedAt: AGED,
      sessionId: "sess",
      userId: "test-user",
      channel: "discord",
      lastTransitionAt: AGED,
    });
  }

  function seedAgedLearningEvent(id = "evt-old") {
    db.writer
      .prepare(
        `INSERT INTO learning_events (event_id, ts, user_id, kind, payload_json, created_at)
         VALUES (?, ?, 'test-user', 'user_message', '{}', ?)`,
      )
      .run(id, AGED, AGED);
  }

  function seedAgedLlmUsage(id = "llm-old") {
    db.writer
      .prepare(
        `INSERT INTO llm_usage_records (id, occurred_at, usage_day, usage_month, provider_id, provider_kind, provider_api, model,
         route_strategy, task_complexity, input_tokens, output_tokens, total_tokens, cost_usd, created_at)
         VALUES (?, ?, '2024-01-01', '2024-01', 'p1', 'api', 'anthropic', 'm1',
         'configured', 'simple', 100, 50, 150, 0.01, ?)`,
      )
      .run(id, AGED, AGED);
  }

  function seedAgedErrorIncident(id = "ei-old") {
    db.writer
      .prepare(
        `INSERT INTO error_incidents (incident_id, user_id, ts, category, severity, signature, context_json, status, created_at, updated_at)
         VALUES (?, 'test-user', ?, 'tool', 'low', 'sig1', '{}', 'resolved', ?, ?)`,
      )
      .run(id, AGED, AGED, AGED);
  }

  function seedAgedHeartbeat(id = "hb-old") {
    db.writer
      .prepare(
        `INSERT INTO satellite_heartbeats (id, satellite_id, ts, status)
         VALUES (?, 'sat-1', ?, 'online')`,
      )
      .run(id, AGED);
  }

  function seedAllContentCategories() {
    seedAgedAuditLog();
    seedAgedAgentRun();
    seedAgedSkillRun();
    seedAgedLearningEvent();
    seedAgedLlmUsage();
    seedAgedErrorIncident();
    seedAgedHeartbeat();
  }

  function makeJob(policy?: FridayRetentionPolicy) {
    return createFridayRetentionJob({
      db,
      pairingRequestRepo,
      heartbeatRepo,
      outboxRepo,
      learningLedger: createFridayLearningEventLedger({ db }),
      skillRunStore: createFridaySkillRunStore({ db }),
      bootstrapNonceRepo,
      nowIso: () => NOW,
      ...(policy ? { policy } : {}),
    });
  }

  // ── 1. DEFAULT-PERMANENT: every content category keeps rows forever ──────
  it("DEFAULT policy deletes 0 in EVERY content category at far-future NOW", () => {
    seedAllContentCategories();

    // Use the exported production default explicitly (no injected override).
    const job = makeJob();
    const result = job.run(FAR_FUTURE);

    expect(result.deletedAuditLogs).toBe(0);
    expect(result.deletedAgentRuns).toBe(0);
    expect(result.deletedSkillRuns).toBe(0);
    expect(result.deletedLearningEvents).toBe(0);
    expect(result.deletedLlmUsageRecords).toBe(0);
    expect(result.deletedErrorIncidents).toBe(0);
    expect(result.deletedHeartbeats).toBe(0);

    // Rows physically survive.
    const count = (sql: string) =>
      (db.writer.prepare(sql).get() as { c: number }).c;
    expect(count("SELECT COUNT(*) c FROM audit_logs")).toBe(1);
    expect(count("SELECT COUNT(*) c FROM friday_agent_runs")).toBe(1);
    expect(count("SELECT COUNT(*) c FROM learning_events")).toBe(1);
    expect(count("SELECT COUNT(*) c FROM llm_usage_records")).toBe(1);
    expect(count("SELECT COUNT(*) c FROM error_incidents")).toBe(1);
    expect(count("SELECT COUNT(*) c FROM satellite_heartbeats")).toBe(1);
  });

  it("audit_logs are NEVER deleted under DEFAULT even at extreme NOW", () => {
    seedAgedAuditLog("al-ancient");
    const job = makeJob();
    const result = job.run("9999-12-31T23:59:59.000Z");
    expect(result.deletedAuditLogs).toBe(0);
    const row = db.writer
      .prepare("SELECT id FROM audit_logs WHERE id = 'al-ancient'")
      .get();
    expect(row).toBeDefined();
  });

  // ── 2. FAIL-CLOSED: any invalid category config => delete 0 ──────────────
  const invalidConfigs: Array<[string, unknown]> = [
    ["missing/undefined", undefined],
    ["unknown mode", { mode: "forever" }],
    ["days = 0", { mode: "after_days", days: 0 }],
    ["days = -1", { mode: "after_days", days: -1 }],
    ["days = 1.5", { mode: "after_days", days: 1.5 }],
    ["days = NaN", { mode: "after_days", days: Number.NaN }],
    ["days = Infinity", { mode: "after_days", days: Number.POSITIVE_INFINITY }],
    ["days = huge-overflow", { mode: "after_days", days: Number.MAX_SAFE_INTEGER }],
    ["non-object (number)", 90],
    ["non-object (string)", "90"],
    ["null", null],
  ];

  it.each(invalidConfigs)(
    "FAIL-CLOSED: auditLogs config %s => deletes 0",
    (_label, badValue) => {
      seedAgedAuditLog();
      // All-permanent baseline with only auditLogs corrupted.
      const policy = {
        ...FRIDAY_DEFAULT_RETENTION_POLICY,
        auditLogs: badValue,
      } as unknown as FridayRetentionPolicy;
      const job = makeJob(policy);
      const result = job.run(FAR_FUTURE);
      expect(result.deletedAuditLogs).toBe(0);
      expect(
        (db.writer.prepare("SELECT COUNT(*) c FROM audit_logs").get() as { c: number }).c,
      ).toBe(1);
    },
  );

  it("FAIL-CLOSED: a wholly non-object category never throws / aborts the sweep", () => {
    seedAllContentCategories();
    const policy = {
      ...FRIDAY_DEFAULT_RETENTION_POLICY,
      auditLogs: 90, // corrupt one
      learningEvents: "nonsense", // corrupt another
    } as unknown as FridayRetentionPolicy;
    const job = makeJob(policy);
    // Must not throw; other lifecycle steps still run.
    expect(() => job.run(FAR_FUTURE)).not.toThrow();
    const result = job.run(FAR_FUTURE);
    expect(result.deletedAuditLogs).toBe(0);
    expect(result.deletedLearningEvents).toBe(0);
  });

  // ── 3. EXPLICIT ENABLE: only the enabled category deletes; boundary `<` ──
  it("explicit after_days enables ONLY that category; others untouched", () => {
    seedAllContentCategories();
    const policy = {
      ...FRIDAY_DEFAULT_RETENTION_POLICY,
      auditLogs: { mode: "after_days", days: 90 },
    } as unknown as FridayRetentionPolicy;
    const job = makeJob(policy);
    const result = job.run(NOW); // AGED (2024-01-01) is > 90d before NOW

    expect(result.deletedAuditLogs).toBe(1);
    // Every other content category remains permanent -> 0 deleted.
    expect(result.deletedAgentRuns).toBe(0);
    expect(result.deletedSkillRuns).toBe(0);
    expect(result.deletedLearningEvents).toBe(0);
    expect(result.deletedLlmUsageRecords).toBe(0);
    expect(result.deletedErrorIncidents).toBe(0);
    expect(result.deletedHeartbeats).toBe(0);
  });

  it("boundary: row exactly at cutoff is NOT deleted ( `<` semantics )", () => {
    const days = 90;
    const cutoffIso = new Date(
      new Date(NOW).getTime() - days * 24 * 60 * 60 * 1000,
    ).toISOString();
    const justBefore = new Date(new Date(cutoffIso).getTime() - 1).toISOString();

    // Row exactly AT cutoff -> survives; row 1ms older -> deleted.
    db.writer
      .prepare(
        `INSERT INTO audit_logs (id, ts, actor_type, actor_id, action, resource_type, resource_id)
         VALUES ('al-at', ?, 'user', 'u1', 'create', 'skill', 's1')`,
      )
      .run(cutoffIso);
    db.writer
      .prepare(
        `INSERT INTO audit_logs (id, ts, actor_type, actor_id, action, resource_type, resource_id)
         VALUES ('al-before', ?, 'user', 'u1', 'create', 'skill', 's2')`,
      )
      .run(justBefore);

    const policy = {
      ...FRIDAY_DEFAULT_RETENTION_POLICY,
      auditLogs: { mode: "after_days", days },
    } as unknown as FridayRetentionPolicy;
    const result = makeJob(policy).run(NOW);

    expect(result.deletedAuditLogs).toBe(1);
    const remaining = db.writer
      .prepare("SELECT id FROM audit_logs ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(remaining).toEqual([{ id: "al-at" }]);
  });

  // ── 4. SECURITY-LIFECYCLE non-degraded ───────────────────────────────────
  it("pairing expiry status-flip still fires under DEFAULT policy", () => {
    db.writer
      .prepare(
        `INSERT INTO satellite_pairing_requests (id, satellite_id, code, nonce, status, expires_at, created_at, updated_at)
         VALUES ('req-exp', 'sat-1', '123456', 'nonce', 'pending', '2025-06-14T00:00:00.000Z', ?, ?)`,
      )
      .run(NOW, NOW);

    const result = makeJob().run(NOW);
    expect(result.markedPairingExpired).toBe(1);
    const req = db.writer
      .prepare("SELECT status FROM satellite_pairing_requests WHERE id = 'req-exp'")
      .get() as { status: string };
    expect(req.status).toBe("expired");
  });

  it("resolved pairing-request terminal cleanup still deletes under DEFAULT", () => {
    db.writer
      .prepare(
        `INSERT INTO satellite_pairing_requests (id, satellite_id, code, nonce, status, expires_at, created_at, updated_at)
         VALUES ('req-old', 'sat-1', '123456', 'nonce', 'approved', ?, ?, ?)`,
      )
      .run(AGED, AGED, AGED);
    const result = makeJob().run(NOW);
    expect(result.deletedPairingRequests).toBe(1);
  });

  it("outbox TTL expiry status-flip still fires under DEFAULT", () => {
    db.withWriteTransaction((d) => {
      outboxRepo.insertMessage(
        d,
        "msg-expired",
        {
          satelliteId: "sat-1",
          queueKey: "commands",
          messageType: "test",
          payloadCiphertext: "data",
          nonce: "n",
          keyId: "k",
          idempotencyKey: "idem-exp",
          expiresAt: "2025-06-14T00:00:00.000Z",
        },
        NOW,
      );
    });
    const result = makeJob().run(NOW);
    expect(result.markedOutboxExpired).toBe(1);
  });

  it("terminal outbox cleanup still deletes under DEFAULT", () => {
    db.withWriteTransaction((d) => {
      outboxRepo.insertMessage(
        d,
        "msg-old",
        {
          satelliteId: "sat-1",
          queueKey: "commands",
          messageType: "test",
          payloadCiphertext: "data",
          nonce: "n",
          keyId: "k",
          idempotencyKey: "idem-term",
        },
        AGED,
      );
    });
    db.writer
      .prepare(
        "UPDATE outbox_messages SET status = 'acked', updated_at = ? WHERE id = 'msg-old'",
      )
      .run(AGED);
    const result = makeJob().run(NOW);
    expect(result.deletedOutboxTerminal).toBe(1);
  });

  // ── 5. SENSITIVITY: default MUST be permanent for content categories ─────
  it("SENSITIVITY: production default has every content category set to permanent", () => {
    // If someone re-introduces a hardcoded numeric window (e.g. auditLogs 90d)
    // in place of {mode:'permanent'} this guard goes RED.
    const contentCategories = [
      "auditLogs",
      "agentRuns",
      "skillRunTerminal",
      "learningEvents",
      "llmUsageRecords",
      "errorIncidents",
      "heartbeats",
    ] as const;
    const policy = FRIDAY_DEFAULT_RETENTION_POLICY as unknown as Record<
      string,
      { mode?: string }
    >;
    for (const cat of contentCategories) {
      expect(policy[cat]).toBeDefined();
      expect(policy[cat].mode).toBe("permanent");
    }
  });

  // ── 6. CONCURRENCY (light): a post-cutoff row inserted mid-sweep survives ─
  it("CONCURRENCY: a just-inserted post-cutoff row is not deleted by an enabled sweep", () => {
    // better-sqlite3 is synchronous; we model a concurrent writer by inserting a
    // fresh (post-cutoff) row immediately before the sweep, alongside an aged row.
    seedAgedAuditLog("al-aged"); // should be deleted
    db.writer
      .prepare(
        `INSERT INTO audit_logs (id, ts, actor_type, actor_id, action, resource_type, resource_id)
         VALUES ('al-fresh', ?, 'user', 'u1', 'create', 'skill', 's-fresh')`,
      )
      .run(NOW); // post-cutoff -> must survive

    const policy = {
      ...FRIDAY_DEFAULT_RETENTION_POLICY,
      auditLogs: { mode: "after_days", days: 90 },
    } as unknown as FridayRetentionPolicy;
    const result = makeJob(policy).run(NOW);

    expect(result.deletedAuditLogs).toBe(1);
    const remaining = db.writer
      .prepare("SELECT id FROM audit_logs ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(remaining).toEqual([{ id: "al-fresh" }]);
  });
});

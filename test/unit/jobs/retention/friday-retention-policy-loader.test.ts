import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import {
  createFridaySatellitePairingRequestRepository,
  createFridaySatelliteHeartbeatRepository,
  createFridayOutboxMessageRepository,
} from "#satellites";
import { createFridayLearningEventLedger, createFridaySkillRunStore } from "#ledger";
import { createFridaySetupBootstrapNonceRepository } from "#api";
import {
  createFridayRetentionJob,
  createFridayRetentionPolicyLoader,
  createFridayRetentionSettingsRepository,
  createFridayRetentionSettingsStore,
  FRIDAY_DEFAULT_RETENTION_POLICY,
} from "#jobs";
import type { FridayRetentionPolicy, FridayRetentionSettingsRepository } from "#jobs";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

/**
 * RETENTION-R3a loader fail-closed proof.
 *
 * The loader resolves the reaper's `FridayRetentionPolicy` from persisted owner
 * settings. On any missing / unreadable / partial / invalid state it MUST fall
 * back to all-permanent so a run over aged fixtures deletes ZERO rows.
 */
describe("createFridayRetentionPolicyLoader — FAIL-CLOSED", () => {
  let db: FridaySqliteLayer;
  const OWNER = "owner-x";
  const NOW = "2025-06-15T10:00:00.000Z";
  const FAR_FUTURE = "2099-01-01T00:00:00.000Z";
  const AGED = "2024-01-01T00:00:00.000Z";

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

  function seedAllContentCategories() {
    db.writer
      .prepare(
        `INSERT INTO audit_logs (id, ts, actor_type, actor_id, action, resource_type, resource_id)
         VALUES ('al-old', ?, 'user', 'u1', 'create', 'skill', 's1')`,
      )
      .run(AGED);
    db.writer
      .prepare(
        `INSERT INTO friday_agent_runs (id, session_key, task, status, created_at)
         VALUES ('run-old', 'cli:u1:chat', 'old task', 'completed', ?)`,
      )
      .run(AGED);
    createFridaySkillRunStore({ db }).upsertRun({
      runId: "srun-old",
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
    db.writer
      .prepare(
        `INSERT INTO learning_events (event_id, ts, user_id, kind, payload_json, created_at)
         VALUES ('evt-old', ?, 'test-user', 'user_message', '{}', ?)`,
      )
      .run(AGED, AGED);
    db.writer
      .prepare(
        `INSERT INTO llm_usage_records (id, occurred_at, usage_day, usage_month, provider_id, provider_kind, provider_api, model,
         route_strategy, task_complexity, input_tokens, output_tokens, total_tokens, cost_usd, created_at)
         VALUES ('llm-old', ?, '2024-01-01', '2024-01', 'p1', 'api', 'anthropic', 'm1',
         'configured', 'simple', 100, 50, 150, 0.01, ?)`,
      )
      .run(AGED, AGED);
    db.writer
      .prepare(
        `INSERT INTO error_incidents (incident_id, user_id, ts, category, severity, signature, context_json, status, created_at, updated_at)
         VALUES ('ei-old', 'test-user', ?, 'tool', 'low', 'sig1', '{}', 'resolved', ?, ?)`,
      )
      .run(AGED, AGED, AGED);
    db.writer
      .prepare(
        `INSERT INTO satellite_heartbeats (id, satellite_id, ts, status)
         VALUES ('hb-old', 'sat-1', ?, 'online')`,
      )
      .run(AGED);
  }

  function makeJob(policy: FridayRetentionPolicy) {
    return createFridayRetentionJob({
      db,
      pairingRequestRepo,
      heartbeatRepo,
      outboxRepo,
      learningLedger: createFridayLearningEventLedger({ db }),
      skillRunStore: createFridaySkillRunStore({ db }),
      bootstrapNonceRepo,
      nowIso: () => NOW,
      policy,
    });
  }

  function expectZeroContentDeletes(policy: FridayRetentionPolicy) {
    const result = makeJob(policy).run(FAR_FUTURE);
    expect(result.deletedAuditLogs).toBe(0);
    expect(result.deletedAgentRuns).toBe(0);
    expect(result.deletedSkillRuns).toBe(0);
    expect(result.deletedLearningEvents).toBe(0);
    expect(result.deletedLlmUsageRecords).toBe(0);
    expect(result.deletedErrorIncidents).toBe(0);
    expect(result.deletedHeartbeats).toBe(0);
  }

  beforeEach(() => {
    db = createTestDb();
    insertSatellite("sat-1");
  });

  afterEach(() => {
    db.close();
  });

  it("FRESH INSTALL (no persisted policy) ⇒ all-permanent ⇒ reaper deletes 0 (default-OFF)", () => {
    seedAllContentCategories();
    const loader = createFridayRetentionPolicyLoader({
      db,
      repo: createFridayRetentionSettingsRepository(),
      principalId: OWNER,
    });
    const policy = loader.load();
    // Every content category resolves permanent; security TTLs = defaults.
    expect(policy).toEqual(FRIDAY_DEFAULT_RETENTION_POLICY);
    expectZeroContentDeletes(policy);
  });

  it("UNREADABLE store (table dropped) ⇒ all-permanent ⇒ reaper deletes 0", () => {
    seedAllContentCategories();
    // Corrupt the store: the settings table no longer exists.
    db.writer.exec("DROP TABLE friday_retention_settings");
    const loader = createFridayRetentionPolicyLoader({
      db,
      repo: createFridayRetentionSettingsRepository(),
      principalId: OWNER,
    });
    const policy = loader.load();
    expect(policy).toEqual(FRIDAY_DEFAULT_RETENTION_POLICY);
    expectZeroContentDeletes(policy);
  });

  it("repo that THROWS on read ⇒ loader never throws, returns all-permanent", () => {
    seedAllContentCategories();
    const throwingRepo: FridayRetentionSettingsRepository = {
      listByPrincipal: () => {
        throw new Error("simulated unreadable store");
      },
      upsertAfterDays: () => {
        /* unused */
      },
      deleteCategory: () => false,
    };
    const loader = createFridayRetentionPolicyLoader({ db, repo: throwingRepo, principalId: OWNER });
    let policy: FridayRetentionPolicy | undefined;
    expect(() => {
      policy = loader.load();
    }).not.toThrow();
    expect(policy).toEqual(FRIDAY_DEFAULT_RETENTION_POLICY);
    expectZeroContentDeletes(policy!);
  });

  it("PARTIAL / unknown-category row ⇒ ignored (fail closed) ⇒ reaper deletes 0", () => {
    seedAllContentCategories();
    // A row for a category the loader does not recognise must be ignored.
    db.writer
      .prepare(
        `INSERT INTO friday_retention_settings (id, principal_id, content_category, after_days, created_at, updated_at)
         VALUES ('bogus-1', ?, 'totallyBogusCategory', 5, ?, ?)`,
      )
      .run(OWNER, NOW, NOW);
    const loader = createFridayRetentionPolicyLoader({
      db,
      repo: createFridayRetentionSettingsRepository(),
      principalId: OWNER,
    });
    const policy = loader.load();
    expect(policy).toEqual(FRIDAY_DEFAULT_RETENTION_POLICY);
    expectZeroContentDeletes(policy);
  });

  it("VALID persisted opt-in IS loaded and drives ONLY that category (loader wired, not trivially permanent)", () => {
    seedAllContentCategories();
    // Persist a real opt-in for auditLogs via the production store.
    let idc = 0;
    const store = createFridayRetentionSettingsStore({
      db,
      repo: createFridayRetentionSettingsRepository(),
      idGenerator: () => `ret-${++idc}`,
      nowIso: () => NOW,
    });
    store.applyOwnerContentPolicy({
      principalId: OWNER,
      updates: { auditLogs: { mode: "after_days", days: 90 } },
    });

    const loader = createFridayRetentionPolicyLoader({
      db,
      repo: createFridayRetentionSettingsRepository(),
      principalId: OWNER,
    });
    const policy = loader.load();
    expect(policy.auditLogs).toEqual({ mode: "after_days", days: 90 });
    // Everything else stayed permanent.
    expect(policy.agentRuns).toEqual({ mode: "permanent" });
    expect(policy.learningEvents).toEqual({ mode: "permanent" });
    // Security-lifecycle TTLs are never owner-touchable.
    expect(policy.pairingRequestsDays).toBe(FRIDAY_DEFAULT_RETENTION_POLICY.pairingRequestsDays);
    expect(policy.outboxTerminalDays).toBe(FRIDAY_DEFAULT_RETENTION_POLICY.outboxTerminalDays);
    expect(policy.bootstrapNoncesConsumedDays).toBe(
      FRIDAY_DEFAULT_RETENTION_POLICY.bootstrapNoncesConsumedDays,
    );

    // Reaper at NOW (aged rows are > 90d old) deletes ONLY auditLogs.
    const result = makeJob(policy).run(NOW);
    expect(result.deletedAuditLogs).toBe(1);
    expect(result.deletedAgentRuns).toBe(0);
    expect(result.deletedLearningEvents).toBe(0);
    expect(result.deletedLlmUsageRecords).toBe(0);
    expect(result.deletedErrorIncidents).toBe(0);
    expect(result.deletedSkillRuns).toBe(0);
    expect(result.deletedHeartbeats).toBe(0);
  });
});

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
import type { FridayRetentionJob, FridayRetentionSettingsStore } from "#jobs";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

/**
 * RETENTION-R3a P0-1 — LIVE-REVOCATION (opt-out stops deletion without restart).
 *
 * The reaper must obtain the CURRENT persisted policy at each sweep (not a startup
 * snapshot). When the owner sets a category back to permanent, the VERY NEXT sweep
 * must delete 0 for it — the destructive scenario the Advisor reproduced. All
 * proofs go through the REAL job + REAL store + REAL loader (no mocks). FAIL-CLOSED
 * is preserved: any live-read failure ⇒ all-permanent ⇒ 0 deletes.
 */
describe("FridayRetentionJob — LIVE per-sweep policy re-read (opt-out stops deletion)", () => {
  let db: FridaySqliteLayer;
  const OWNER = "admin-001";
  const NOW = "2025-06-15T10:00:00.000Z";
  const AGED = "2024-01-01T00:00:00.000Z";

  const pairingRequestRepo = createFridaySatellitePairingRequestRepository();
  const heartbeatRepo = createFridaySatelliteHeartbeatRepository();
  const outboxRepo = createFridayOutboxMessageRepository();
  const bootstrapNonceRepo = createFridaySetupBootstrapNonceRepository();

  let store: FridayRetentionSettingsStore;
  let idc = 0;

  function seedAgedAudit(id: string) {
    db.writer
      .prepare(
        `INSERT INTO audit_logs (id, ts, actor_type, actor_id, action, resource_type, resource_id)
         VALUES (?, ?, 'user', 'u1', 'create', 'skill', 's1')`,
      )
      .run(id, AGED);
  }
  function auditCount(): number {
    return (db.writer.prepare("SELECT COUNT(*) c FROM audit_logs").get() as { c: number }).c;
  }

  /** A job wired the way production wires it: live per-sweep policy re-read. */
  function makeLiveJob(loadPolicy: () => ReturnType<ReturnType<typeof createFridayRetentionPolicyLoader>["load"]>): FridayRetentionJob {
    return createFridayRetentionJob({
      db,
      pairingRequestRepo,
      heartbeatRepo,
      outboxRepo,
      learningLedger: createFridayLearningEventLedger({ db }),
      skillRunStore: createFridaySkillRunStore({ db }),
      bootstrapNonceRepo,
      nowIso: () => NOW,
      loadPolicy,
    });
  }

  function liveLoader() {
    const loader = createFridayRetentionPolicyLoader({
      db,
      repo: createFridayRetentionSettingsRepository(),
      principalId: OWNER,
    });
    return () => loader.load();
  }

  beforeEach(() => {
    db = createTestDb();
    idc = 0;
    store = createFridayRetentionSettingsStore({
      db,
      repo: createFridayRetentionSettingsRepository(),
      idGenerator: () => `ret-${String(++idc).padStart(4, "0")}`,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("(a)->(b) enable deletes; then opt-OUT (permanent) → the VERY NEXT sweep deletes 0 (no restart)", () => {
    const job = makeLiveJob(liveLoader());

    // (a) OPT-IN: enable a 90-day window for auditLogs → next sweep deletes aged.
    store.applyOwnerContentPolicy({
      principalId: OWNER,
      updates: { auditLogs: { mode: "after_days", days: 90 } },
    });
    seedAgedAudit("al-1");
    expect(job.run(NOW).deletedAuditLogs).toBe(1);
    expect(auditCount()).toBe(0);

    // (b) OPT-OUT: set it back to permanent. The SAME already-running job's next
    // sweep must delete 0 (this is the destructive case, now fixed).
    store.applyOwnerContentPolicy({
      principalId: OWNER,
      updates: { auditLogs: { mode: "permanent" } },
    });
    seedAgedAudit("al-2");
    expect(job.run(NOW).deletedAuditLogs).toBe(0);
    expect(auditCount()).toBe(1); // the aged row SURVIVES the opt-out
  });

  it("(f) rollback round-trip: enable→delete, disable→0, re-enable→delete — all on ONE running job", () => {
    const job = makeLiveJob(liveLoader());

    store.applyOwnerContentPolicy({ principalId: OWNER, updates: { auditLogs: { mode: "after_days", days: 90 } } });
    seedAgedAudit("r1");
    expect(job.run(NOW).deletedAuditLogs).toBe(1);

    store.applyOwnerContentPolicy({ principalId: OWNER, updates: { auditLogs: { mode: "permanent" } } });
    seedAgedAudit("r2");
    expect(job.run(NOW).deletedAuditLogs).toBe(0);
    expect(auditCount()).toBe(1);

    store.applyOwnerContentPolicy({ principalId: OWNER, updates: { auditLogs: { mode: "after_days", days: 90 } } });
    expect(job.run(NOW).deletedAuditLogs).toBe(1); // r2 now swept
    expect(auditCount()).toBe(0);
  });

  it("(d) race: whichever value is COMMITTED before a sweep is honored (no stale delete)", () => {
    const job = makeLiveJob(liveLoader());

    // Commit an opt-in, then commit an opt-OUT just before the sweep → sweep
    // honors the committed (permanent) value → 0 deletes.
    store.applyOwnerContentPolicy({ principalId: OWNER, updates: { auditLogs: { mode: "after_days", days: 90 } } });
    store.applyOwnerContentPolicy({ principalId: OWNER, updates: { auditLogs: { mode: "permanent" } } });
    seedAgedAudit("race-1");
    expect(job.run(NOW).deletedAuditLogs).toBe(0);

    // Now commit an opt-in just before the sweep → sweep honors it → deletes.
    store.applyOwnerContentPolicy({ principalId: OWNER, updates: { auditLogs: { mode: "after_days", days: 90 } } });
    expect(job.run(NOW).deletedAuditLogs).toBe(1);
  });

  it("(c) no in-memory staleness: a freshly-built loader after opt-out also yields permanent → 0 deletes", () => {
    store.applyOwnerContentPolicy({ principalId: OWNER, updates: { auditLogs: { mode: "after_days", days: 90 } } });
    seedAgedAudit("c-1");
    expect(makeLiveJob(liveLoader()).run(NOW).deletedAuditLogs).toBe(1);

    store.applyOwnerContentPolicy({ principalId: OWNER, updates: { auditLogs: { mode: "permanent" } } });
    seedAgedAudit("c-2");
    // A brand-new loader/job (as if reconstructed) must not resurrect the old opt-in.
    expect(makeLiveJob(liveLoader()).run(NOW).deletedAuditLogs).toBe(0);
    expect(auditCount()).toBe(1);
  });

  it("(e) FAIL-CLOSED: a live loadPolicy that THROWS mid-run ⇒ all-permanent ⇒ 0 deletes (never throws)", () => {
    const job = makeLiveJob(() => {
      throw new Error("simulated live policy read failure");
    });
    seedAgedAudit("e-1");
    let deleted = -1;
    expect(() => {
      deleted = job.run(NOW).deletedAuditLogs;
    }).not.toThrow();
    expect(deleted).toBe(0);
    expect(auditCount()).toBe(1);
  });

  it("(e) FAIL-CLOSED: an unreadable store (dropped table) live-read ⇒ all-permanent ⇒ 0 deletes", () => {
    // Enable first, then corrupt the store: the live loader must fail closed.
    store.applyOwnerContentPolicy({ principalId: OWNER, updates: { auditLogs: { mode: "after_days", days: 90 } } });
    seedAgedAudit("e-2");
    db.writer.exec("DROP TABLE friday_retention_settings");
    const result = makeLiveJob(liveLoader()).run(NOW);
    expect(result.deletedAuditLogs).toBe(0);
    expect(auditCount()).toBe(1);
  });

  it("sanity: the live default (no opt-in) equals the all-permanent production default ⇒ 0 deletes", () => {
    seedAgedAudit("s-1");
    const policy = createFridayRetentionPolicyLoader({
      db,
      repo: createFridayRetentionSettingsRepository(),
      principalId: OWNER,
    }).load();
    expect(policy).toEqual(FRIDAY_DEFAULT_RETENTION_POLICY);
    expect(makeLiveJob(liveLoader()).run(NOW).deletedAuditLogs).toBe(0);
  });
});

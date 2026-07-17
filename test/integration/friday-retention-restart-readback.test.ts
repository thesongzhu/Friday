import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createFridaySqliteLayer } from "#state";
import type { FridaySqliteLayer } from "#state";
import {
  createFridaySatellitePairingRequestRepository,
  createFridaySatelliteHeartbeatRepository,
  createFridayOutboxMessageRepository,
} from "#satellites";
import { createFridayLearningEventLedger, createFridaySkillRunStore } from "#ledger";
import { createFridaySetupBootstrapNonceRepository } from "#api";
import {
  createFridayRetentionSettingsRoutes,
  createFridayRetentionPolicyAuditAppender,
} from "#api";
import type { FridayHttpContext } from "#api";
import {
  createFridayRetentionJob,
  createFridayRetentionPolicyLoader,
  createFridayRetentionSettingsRepository,
  createFridayRetentionSettingsStore,
  resolveCutoff,
} from "#jobs";

/**
 * RETENTION-R3a restart-readback (durable persistence proof).
 *
 * Write an owner retention policy via the PUT route → close the store / process
 * → re-open a fresh store on the SAME on-disk db → GET returns the byte-
 * identical policy → the loader/reaper picks up the persisted opt-in.
 */
const OWNER = "admin-001";
const NOW = "2026-07-15T10:00:00.000Z";
const AGED = "2024-01-01T00:00:00.000Z";

function makeCtx(
  overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {},
): FridayHttpContext<unknown, unknown, unknown> {
  return {
    requestId: "req-1",
    receivedAt: NOW,
    params: {},
    query: {},
    body: {},
    headers: {},
    // Retention config is owner-only: the caller must carry owner/admin authority.
    principal: { userId: OWNER, principalId: OWNER, role: "admin", scopes: ["hub.admin"] } as never,
    ...overrides,
  };
}

function openLayer(dbPath: string): FridaySqliteLayer {
  return createFridaySqliteLayer({
    dbPath,
    readPoolSize: 1,
    pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
  });
}

function makeStore(layer: FridaySqliteLayer) {
  let idc = 0;
  return createFridayRetentionSettingsStore({
    db: layer,
    repo: createFridayRetentionSettingsRepository(),
    idGenerator: () => `ret-${++idc}`,
    nowIso: () => NOW,
  });
}

/**
 * RETENTION-R3d: build the owner-bound routes for a given on-disk layer. `db` and
 * the audit appender share the SAME layer so the PUT's apply + audit are one
 * atomic transaction; the durable audit row lands in the same on-disk db.
 */
function makeRoutes(layer: FridaySqliteLayer) {
  let idc = 0;
  return createFridayRetentionSettingsRoutes({
    store: makeStore(layer),
    resolveCanonicalOwnerId: () => OWNER,
    db: layer,
    appendPolicyAudit: createFridayRetentionPolicyAuditAppender({
      sqlite: layer,
      idGenerator: () => `aud-${++idc}`,
    }),
    nowIso: () => NOW,
    idGenerator: () => `op-${++idc}`,
  });
}

describe("RETENTION-R3a restart-readback (integration)", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-retention-r3a-"));
    dbPath = path.join(tmpDir, "friday.db");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("policy written via PUT survives a store re-open and drives the reaper", () => {
    // ── Session 1: write via the PUT route, then close the store. ──
    const layer1 = openLayer(dbPath);
    const routes1 = makeRoutes(layer1);
    const put1 = routes1.find((r) => r.operationId === "uix.retention.policy.update")!;
    const get1 = routes1.find((r) => r.operationId === "uix.retention.policy.get")!;

    let writtenPolicy: unknown;
    return (async () => {
      const putResult = (await put1.handler(
        makeCtx({
          body: {
            policy: {
              auditLogs: { mode: "after_days", days: 90 },
              agentRuns: { mode: "permanent" },
            },
          },
        }),
      )) as { policy: Record<string, unknown> };
      writtenPolicy = putResult.policy;

      const before = (await get1.handler(makeCtx())) as { policy: Record<string, unknown> };
      expect(before.policy).toEqual(writtenPolicy);

      // Simulate a restart: drop all in-memory/session state.
      layer1.close();

      // ── Session 2: re-open a FRESH store on the SAME on-disk db. ──
      const layer2 = openLayer(dbPath);
      try {
        const routes2 = makeRoutes(layer2);
        const get2 = routes2.find((r) => r.operationId === "uix.retention.policy.get")!;

        const after = (await get2.handler(makeCtx())) as { policy: Record<string, unknown> };

        // Byte-identical readback across the restart.
        expect(after.policy).toEqual(writtenPolicy);
        expect(JSON.stringify(after.policy)).toBe(JSON.stringify(writtenPolicy));
        expect(after.policy.auditLogs).toEqual({ mode: "after_days", days: 90 });
        expect(after.policy.agentRuns).toEqual({ mode: "permanent" });

        // The loader picks up the persisted opt-in for the reaper.
        const loader = createFridayRetentionPolicyLoader({
          db: layer2,
          repo: createFridayRetentionSettingsRepository(),
          principalId: OWNER,
        });
        const policy = loader.load();
        expect(policy.auditLogs).toEqual({ mode: "after_days", days: 90 });
        expect(policy.agentRuns).toEqual({ mode: "permanent" });

        // And the reaper ACTS on it: an aged audit log is deleted; nothing else.
        layer2.writer
          .prepare(
            `INSERT INTO audit_logs (id, ts, actor_type, actor_id, action, resource_type, resource_id)
             VALUES ('al-aged', ?, 'user', 'u1', 'create', 'skill', 's1')`,
          )
          .run(AGED);

        const job = createFridayRetentionJob({
          db: layer2,
          pairingRequestRepo: createFridaySatellitePairingRequestRepository(),
          heartbeatRepo: createFridaySatelliteHeartbeatRepository(),
          outboxRepo: createFridayOutboxMessageRepository(),
          learningLedger: createFridayLearningEventLedger({ db: layer2 }),
          skillRunStore: createFridaySkillRunStore({ db: layer2 }),
          bootstrapNonceRepo: createFridaySetupBootstrapNonceRepository(),
          nowIso: () => NOW,
          policy,
        });
        const result = job.run(NOW);
        expect(result.deletedAuditLogs).toBe(1);
        expect(result.deletedAgentRuns).toBe(0);
        expect(result.deletedLearningEvents).toBe(0);
        expect(
          (layer2.writer.prepare("SELECT COUNT(*) c FROM audit_logs").get() as { c: number }).c,
        ).toBe(0);
      } finally {
        layer2.close();
      }
    })();
  });

  it("BOUNDARY: a MAX (36500-day) window persists, survives a store re-open, and is HONORED (Advisor R2)", async () => {
    const MAX = 36_500; // == FRIDAY_MAX_AFTER_DAYS (accept ⊆ honored at the boundary)

    // ── Session 1: write the boundary window via the PUT route, then close. ──
    const layer1 = openLayer(dbPath);
    const routes1 = makeRoutes(layer1);
    const put1 = routes1.find((r) => r.operationId === "uix.retention.policy.update")!;
    const putResult = (await put1.handler(
      makeCtx({ body: { policy: { auditLogs: { mode: "after_days", days: MAX } } } }),
    )) as { policy: Record<string, unknown> };
    expect(putResult.policy.auditLogs).toEqual({ mode: "after_days", days: MAX });
    layer1.close();

    // ── Session 2: re-open a FRESH store on the SAME on-disk db. ──
    const layer2 = openLayer(dbPath);
    try {
      const routes2 = makeRoutes(layer2);
      const get2 = routes2.find((r) => r.operationId === "uix.retention.policy.get")!;
      const after = (await get2.handler(makeCtx())) as { policy: Record<string, unknown> };

      // Byte-identical readback of the boundary window across the restart.
      expect(after.policy.auditLogs).toEqual({ mode: "after_days", days: MAX });

      // The loader picks it up AND the reaper's evaluator honors it (non-null cutoff)
      // — proving the accepted maximum is inside the honored domain.
      const loader = createFridayRetentionPolicyLoader({
        db: layer2,
        repo: createFridayRetentionSettingsRepository(),
        principalId: OWNER,
      });
      expect(loader.load().auditLogs).toEqual({ mode: "after_days", days: MAX });
      expect(resolveCutoff(NOW, { mode: "after_days", days: MAX })).not.toBeNull();
    } finally {
      layer2.close();
    }
  });
});

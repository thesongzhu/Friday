import * as net from "node:net";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  createFridayHttpRouteRegistry,
  createFridayHttpServer,
  createFridayRetentionSettingsRoutes,
  createFridayRetentionPolicyAuditAppender,
  createFridayRetentionReceiptRecovery,
  createFridayMultiTenantSecurityRoutes,
  hashRecoveryKey,
} from "#api";
import type {
  FridayAuthMiddlewareFactory,
  FridayHttpContext,
  FridayHttpServer,
  FridayRealtimeWsGateway,
  FridayRetentionPolicyAuditEntry,
  FridayRetentionPolicyUpdateReceipt,
} from "#api";
import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import { AuditLogger } from "../../../../../src/security/multi-tenant/engine/audit-logger.js";
import { createSqliteAuditPersistence } from "../../../../../src/security/multi-tenant/persistence/friday-multi-tenant-sqlite-store.js";
import type { FridaySecurityAuditEntry } from "../../../../../src/security/multi-tenant/model/friday-multi-tenant-security.types.js";
import {
  createFridayRetentionJob,
  createFridayRetentionPolicyLoader,
  createFridayRetentionReceiptRepository,
  createFridayRetentionSettingsRepository,
  createFridayRetentionSettingsStore,
} from "#jobs";
import type { FridayRetentionReceiptRecord, FridayRetentionSettingsStore } from "#jobs";
import {
  createFridaySatellitePairingRequestRepository,
  createFridaySatelliteHeartbeatRepository,
  createFridayOutboxMessageRepository,
} from "#satellites";
import { createFridayLearningEventLedger, createFridaySkillRunStore } from "#ledger";
import { createFridaySetupBootstrapNonceRepository } from "#api";
import { createFridayDefaultPublicHttpPrincipal } from "../../../../../src/api/http/friday-default-public-principal.js";
import { createTestDb } from "../../../satellites/_helpers/create-test-db.helper.js";

/**
 * RETENTION-R3d — audited + correlated + receipted retention-Settings write.
 *
 * The R3a canonical-owner PUT is extended so that, on a successful update, it (a)
 * captures the AUTHORITATIVE before-state from the store, (b) applies the update,
 * (c) re-reads the AUTHORITATIVE after-state, (d) emits a FAIL-CLOSED audit entry,
 * and (e) returns a RECEIPT envelope binding it all. The audit append and the
 * policy apply run in ONE write transaction: if the audit throws, the whole
 * update rolls back → 503 and the persisted policy is byte-unchanged (no orphan
 * write). None of the landed authz / persistence / default-permanent behaviour is
 * weakened.
 */

const NOW = "2026-07-16T10:00:00.000Z";
const CANON = "admin-001";
const AGED = "2024-01-01T00:00:00.000Z";

// ── Handler-level helpers (real store, real/injected audit, direct db reads) ──

function owner(userId: string): never {
  return { userId, principalId: userId, role: "admin", scopes: ["hub.admin"] } as never;
}

// A canonical owner authenticated WITH a tenant namespace (the product's
// multi-tenant audit projection queries by exact tenantId).
function ownerWithTenant(userId: string, tenantId: string): never {
  return { userId, principalId: userId, tenantId, role: "admin", scopes: ["hub.admin", "security.read"] } as never;
}

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
    principal: owner(CANON),
    ...overrides,
  };
}

interface AuditRow {
  id: string;
  tenant_id: string | null;
  principal_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  decision: string;
  session_id: string | null;
  metadata_json: string;
  created_at: string;
}

// RETENTION-R3d round-7: the dedicated, retention-GOVERNED receipt store row shape.
interface ReceiptStoreRow {
  receipt_id: string;
  principal_id: string;
  tenant_id: string | null;
  correlation_id: string;
  audit_id: string;
  recovery_key_hash: string | null;
  payload_digest: string | null;
  before_json: string;
  after_json: string;
  changed_categories_json: string;
  applied_updates_json: string;
  created_at: string;
}

describe("friday-retention-settings PUT — RETENTION-R3d (audit + receipt, handler seam)", () => {
  let db: FridaySqliteLayer;
  let store: FridayRetentionSettingsStore;
  let idCounter = 0;

  function auditRows(): AuditRow[] {
    return db.writer
      .prepare("SELECT * FROM security_audit_log ORDER BY created_at, id")
      .all() as AuditRow[];
  }
  function policyRows(principalId: string): Array<{ content_category: string; after_days: number }> {
    return db.writer
      .prepare(
        "SELECT content_category, after_days FROM friday_retention_settings WHERE principal_id = ? ORDER BY content_category",
      )
      .all(principalId) as Array<{ content_category: string; after_days: number }>;
  }
  // RETENTION-R3d round-7: the full receipt facts now live in the dedicated,
  // retention-GOVERNED store — NOT in `security_audit_log` (only a content-free
  // linkage/digest anchor stays there).
  function receiptRows(): ReceiptStoreRow[] {
    return db.writer
      .prepare("SELECT * FROM retention_recovery_receipts ORDER BY created_at, receipt_id")
      .all() as ReceiptStoreRow[];
  }

  function makeStore(): FridayRetentionSettingsStore {
    return createFridayRetentionSettingsStore({
      db,
      repo: createFridayRetentionSettingsRepository(),
      idGenerator: () => `ret-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
    });
  }

  function makeRoutes(
    appendPolicyAudit: (entry: FridayRetentionPolicyAuditEntry) => FridaySecurityAuditEntry,
    opts: {
      projectCommittedAudit?: (entry: FridaySecurityAuditEntry) => void;
      store?: FridayRetentionSettingsStore;
      db?: FridaySqliteLayer;
    } = {},
  ): ReturnType<typeof createFridayRetentionSettingsRoutes> {
    return createFridayRetentionSettingsRoutes({
      store: opts.store ?? store,
      resolveCanonicalOwnerId: () => CANON,
      db: opts.db ?? db,
      appendPolicyAudit,
      nowIso: () => NOW,
      idGenerator: () => `op-${String(++idCounter).padStart(4, "0")}`,
      readReceiptByRecoveryKey: createFridayRetentionReceiptRecovery({ sqlite: db }),
      ...(opts.projectCommittedAudit ? { projectCommittedAudit: opts.projectCommittedAudit } : {}),
    });
  }

  function realAppender(): (entry: FridayRetentionPolicyAuditEntry) => FridaySecurityAuditEntry {
    return createFridayRetentionPolicyAuditAppender({
      sqlite: db,
      idGenerator: () => `aud-${String(++idCounter).padStart(4, "0")}`,
    });
  }

  function receiptRouteOf(routes: ReturnType<typeof createFridayRetentionSettingsRoutes>) {
    return routes.find((r) => r.operationId === "uix.retention.policy.receipt.get")!;
  }

  function putRouteOf(routes: ReturnType<typeof createFridayRetentionSettingsRoutes>) {
    return routes.find((r) => r.operationId === "uix.retention.policy.update")!;
  }
  function getRouteOf(routes: ReturnType<typeof createFridayRetentionSettingsRoutes>) {
    return routes.find((r) => r.operationId === "uix.retention.policy.get")!;
  }

  beforeEach(() => {
    db = createTestDb();
    store = makeStore();
    idCounter = 0;
  });

  afterEach(() => {
    db.close();
  });

  // ── 1. Happy path: well-formed receipt + exactly one durable audit row ──────
  it("returns a receipt binding correlationId + before + after + changed[] + deletedData:false, and writes ONE audit row", async () => {
    const routes = makeRoutes(realAppender());
    const result = (await putRouteOf(routes).handler(
      makeCtx({ body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    )) as { policy: Record<string, unknown>; receipt: FridayRetentionPolicyUpdateReceipt };

    // Policy applied + returned.
    expect(result.policy.auditLogs).toEqual({ mode: "after_days", days: 30 });

    // Receipt is well-formed and bound. Identities carry a readable domain prefix
    // but their UNIQUENESS is id-generator-seeded (not clock-derived).
    const r = result.receipt;
    expect(r.receiptId).toMatch(new RegExp(`^retention-receipt:${CANON}:op-\\d+$`));
    expect(r.correlationId).toMatch(new RegExp(`^retention-policy-update:${CANON}:op-\\d+$`));
    expect(r.auditId).toBeTruthy();
    expect(r.status).toBe("applied");
    expect(r.runAt).toBe(NOW);
    expect(r.requestedBy).toBe(CANON); // resolved canonical owner, never caller-supplied
    expect(r.rollbackClass).toBe("reversible_local_settings");
    // BEFORE is the authoritative pre-state (permanent), AFTER the authoritative
    // post-state (the opt-in) — never an echo of the request.
    expect(r.evidence.before.auditLogs).toEqual({ mode: "permanent" });
    expect(r.evidence.after.auditLogs).toEqual({ mode: "after_days", days: 30 });
    expect(r.evidence.changed).toEqual(["auditLogs"]);
    expect(r.evidence.deletedData).toBe(false);

    // Exactly ONE durable, CONTENT-MINIMIZED audit anchor (durable recovery:
    // id == auditId; metadata holds ONLY the linkage receiptId/correlationId +
    // payloadDigest — NEVER the before/after recovery payload).
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(r.auditId);
    expect(rows[0].principal_id).toBe(CANON);
    expect(rows[0].action).toBe("retention.policy.update");
    expect(rows[0].resource_type).toBe("policy");
    expect(rows[0].decision).toBe("allow");
    expect(rows[0].resource_id).toBe(`retention-policy:${CANON}`);
    const meta = JSON.parse(rows[0].metadata_json) as Record<string, unknown>;
    expect(meta.receiptId).toBe(r.receiptId);
    expect(meta.correlationId).toBe(r.correlationId);
    expect(typeof meta.payloadDigest).toBe("string");
    // AUDIT-AUTHENTIC-ANCHOR-001: the anchor is content-free — the full recovery
    // payload is NOT embedded in `security_audit_log`.
    expect(meta.before).toBeUndefined();
    expect(meta.after).toBeUndefined();
    expect(meta.appliedUpdates).toBeUndefined();
    expect(meta.changedCategories).toBeUndefined();

    // The FULL receipt facts live in the dedicated, retention-GOVERNED store — ONE
    // owner-scoped row linked back to the audit anchor by audit_id.
    const receipts = receiptRows();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].receipt_id).toBe(r.receiptId);
    expect(receipts[0].principal_id).toBe(CANON);
    expect(receipts[0].correlation_id).toBe(r.correlationId);
    expect(receipts[0].audit_id).toBe(r.auditId);
    expect(JSON.parse(receipts[0].before_json)).toEqual(r.evidence.before);
    expect(JSON.parse(receipts[0].after_json)).toEqual(r.evidence.after);
    expect(JSON.parse(receipts[0].changed_categories_json)).toEqual(["auditLogs"]);
  });

  // ── 2. Audit throws (injected) → 503 AND zero mutation (re-GET == before) ───
  it("audit-append throws → PUT 503, policy byte-unchanged (no orphan write), zero audit rows", async () => {
    const throwingRoutes = makeRoutes(() => {
      throw new FridayDomainError(
        "RETENTION_AUDIT_APPEND_FAILED",
        "injected audit failure",
        { httpStatus: 503 },
      );
    });

    const before = (await getRouteOf(makeRoutes(realAppender())).handler(makeCtx())) as {
      policy: Record<string, unknown>;
    };

    await expect(
      putRouteOf(throwingRoutes).handler(
        makeCtx({ body: { policy: { auditLogs: { mode: "after_days", days: 45 } } } }),
      ),
    ).rejects.toMatchObject({ httpStatus: 503, code: "RETENTION_AUDIT_APPEND_FAILED" });

    // The policy write rolled back with the audit failure: NOTHING persisted.
    expect(policyRows(CANON)).toHaveLength(0);
    const after = (await getRouteOf(makeRoutes(realAppender())).handler(makeCtx())) as {
      policy: Record<string, unknown>;
    };
    expect(after.policy).toEqual(before.policy); // re-GET == before, byte-identical
    expect(JSON.stringify(after.policy)).toBe(JSON.stringify(before.policy));
    expect(auditRows()).toHaveLength(0); // no un-audited mutation, no orphan audit
    expect(receiptRows()).toHaveLength(0); // no orphan receipt either (all-or-nothing)
  });

  // ── 3. Audit throws via REAL persistence failure → same fail-closed rollback ─
  it("REAL audit persistence failure (audit table missing) → 503 AND policy unchanged", async () => {
    const routes = makeRoutes(realAppender());
    // Break the durable audit chain so the real INSERT throws inside the txn.
    db.writer.prepare("DROP TABLE security_audit_log").run();

    await expect(
      putRouteOf(routes).handler(
        makeCtx({ body: { policy: { agentRuns: { mode: "after_days", days: 10 } } } }),
      ),
    ).rejects.toMatchObject({ httpStatus: 503, code: "RETENTION_AUDIT_APPEND_FAILED" });

    // The settings table is intact and the write rolled back byte-for-byte.
    expect(policyRows(CANON)).toHaveLength(0);
  });

  // ── 4. Validation failures fail closed BEFORE any audit/receipt/mutation ────
  const invalid: Array<[string, unknown]> = [
    ["unknown category", { bogusCategory: { mode: "after_days", days: 30 } }],
    ["negative days", { auditLogs: { mode: "after_days", days: -1 } }],
    ["overflow days (1e9, reaper-unhonored)", { auditLogs: { mode: "after_days", days: 1_000_000_000 } }],
    ["corrupted mode", { auditLogs: { mode: "forever" } }],
    ["missing days", { auditLogs: { mode: "after_days" } }],
  ];
  it.each(invalid)(
    "PUT with %s → 400 BEFORE any audit/receipt/mutation (zero audit + zero policy rows)",
    async (_label, policy) => {
      const routes = makeRoutes(realAppender());
      await expect(
        putRouteOf(routes).handler(makeCtx({ body: { policy } as never })),
      ).rejects.toMatchObject({ httpStatus: 400 });
      expect(policyRows(CANON)).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    },
  );

  // ── 5. Rollback: an invalid entry mid-batch rejects the WHOLE update ────────
  it("a mixed body with one invalid entry → 400, before-state intact, zero audit rows", async () => {
    const routes = makeRoutes(realAppender());
    // Seed a prior opt-in so "before-state intact" is a non-trivial assertion.
    await putRouteOf(routes).handler(
      makeCtx({ body: { policy: { learningEvents: { mode: "after_days", days: 20 } } } }),
    );
    expect(policyRows(CANON)).toEqual([{ content_category: "learningEvents", after_days: 20 }]);
    const auditsAfterSeed = auditRows().length;
    expect(auditsAfterSeed).toBe(1);

    await expect(
      putRouteOf(routes).handler(
        makeCtx({
          body: {
            policy: {
              auditLogs: { mode: "after_days", days: 30 }, // valid
              agentRuns: { mode: "after_days", days: 0 }, // invalid → whole PUT rejected
            },
          } as never,
        }),
      ),
    ).rejects.toMatchObject({ httpStatus: 400 });

    // Neither new entry persisted; the seeded opt-in is untouched; no new audit row.
    expect(policyRows(CANON)).toEqual([{ content_category: "learningEvents", after_days: 20 }]);
    expect(auditRows()).toHaveLength(auditsAfterSeed);
  });

  // ── 6. Concurrency: two racing PUTs → consistent, fully-applied-or-failed ───
  it("two racing PUTs → consistent authoritative final state, one audit row each, no torn write", async () => {
    const routes = makeRoutes(realAppender());
    const [a, b] = await Promise.all([
      putRouteOf(routes).handler(
        makeCtx({ body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
      ) as Promise<{ receipt: FridayRetentionPolicyUpdateReceipt }>,
      putRouteOf(routes).handler(
        makeCtx({ body: { policy: { agentRuns: { mode: "after_days", days: 60 } } } }),
      ) as Promise<{ receipt: FridayRetentionPolicyUpdateReceipt }>,
    ]);

    // Each PUT fully applied AND was audited.
    expect(a.receipt.status).toBe("applied");
    expect(b.receipt.status).toBe("applied");
    expect(auditRows()).toHaveLength(2);

    // Final authoritative state is a clean merge — no partial/torn row.
    const final = (await getRouteOf(routes).handler(makeCtx())) as {
      policy: Record<string, unknown>;
    };
    expect(final.policy.auditLogs).toEqual({ mode: "after_days", days: 30 });
    expect(final.policy.agentRuns).toEqual({ mode: "after_days", days: 60 });
    expect(policyRows(CANON)).toEqual([
      { content_category: "agentRuns", after_days: 60 },
      { content_category: "auditLogs", after_days: 30 },
    ]);
  });

  // ── 7. No-deletion negative control: a settings write never deletes data ────
  it("a settings PUT deletes NO data rows; opt-out (permanent) makes the reaper delete 0", async () => {
    const routes = makeRoutes(realAppender());
    // Aged data-bearing row in a reaper-managed table.
    db.writer
      .prepare(
        `INSERT INTO audit_logs (id, ts, actor_type, actor_id, action, resource_type, resource_id)
         VALUES ('al-aged', ?, 'user', 'u1', 'create', 'skill', 's1')`,
      )
      .run(AGED);

    // A settings update (opt-out = permanent) — must delete no data.
    await putRouteOf(routes).handler(
      makeCtx({ body: { policy: { auditLogs: { mode: "permanent" } } } }),
    );
    expect(
      (db.writer.prepare("SELECT COUNT(*) c FROM audit_logs").get() as { c: number }).c,
    ).toBe(1); // the aged row is STILL present — the settings write touched no data

    // And the reaper, loading the (permanent) opt-out policy, deletes 0.
    const loader = createFridayRetentionPolicyLoader({
      db,
      repo: createFridayRetentionSettingsRepository(),
      principalId: CANON,
    });
    const job = createFridayRetentionJob({
      db,
      pairingRequestRepo: createFridaySatellitePairingRequestRepository(),
      heartbeatRepo: createFridaySatelliteHeartbeatRepository(),
      outboxRepo: createFridayOutboxMessageRepository(),
      learningLedger: createFridayLearningEventLedger({ db }),
      skillRunStore: createFridaySkillRunStore({ db }),
      bootstrapNonceRepo: createFridaySetupBootstrapNonceRepository(),
      nowIso: () => NOW,
      policy: loader.load(),
    });
    const result = job.run(NOW);
    expect(result.deletedAuditLogs).toBe(0);
    expect(
      (db.writer.prepare("SELECT COUNT(*) c FROM audit_logs").get() as { c: number }).c,
    ).toBe(1);
  });

  // ── 8. P0 #1 — traceability: same-owner/same-clock writes get UNIQUE ids ─────
  it("two same-owner PUTs under an IDENTICAL fixed clock → distinct correlationId, receiptId, auditId", async () => {
    const routes = makeRoutes(realAppender());
    const w1 = (await putRouteOf(routes).handler(
      makeCtx({ body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };
    const w2 = (await putRouteOf(routes).handler(
      makeCtx({ body: { policy: { auditLogs: { mode: "after_days", days: 60 } } } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };

    // BOTH writes ran under the exact same clock value — uniqueness must therefore
    // come from the id generator, NOT the timestamp.
    expect(w1.receipt.runAt).toBe(NOW);
    expect(w2.receipt.runAt).toBe(NOW);

    // Every traceability identity is pairwise DISTINCT across the two writes.
    expect(w1.receipt.correlationId).not.toBe(w2.receipt.correlationId);
    expect(w1.receipt.receiptId).not.toBe(w2.receipt.receiptId);
    expect(w1.receipt.auditId).not.toBe(w2.receipt.auditId);

    // All six identities are globally unique (no cross-field collision either).
    expect(
      new Set([
        w1.receipt.correlationId,
        w1.receipt.receiptId,
        w1.receipt.auditId,
        w2.receipt.correlationId,
        w2.receipt.receiptId,
        w2.receipt.auditId,
      ]).size,
    ).toBe(6);

    // Two durable audit rows, one per write, with distinct ids.
    const rows = auditRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].id).not.toBe(rows[1].id);
  });

  // ── 9. P0 #2 — write-closure: an injected POST-COMMIT read failure must NEVER
  //       leave a committed policy/audit effect without a durable receipt. The
  //       fixed handler performs NO fallible read after commit, so the injected
  //       failure never fires and the receipt is durably recoverable in-txn. ─────
  it("injected post-commit read failure → committed effect ALWAYS has a durable, recoverable receipt (no orphan)", async () => {
    let committed = false;
    // db proxy: flips `committed` the moment the write transaction commits.
    const dbProxy: FridaySqliteLayer = {
      ...db,
      withWriteTransaction<T>(fn: Parameters<FridaySqliteLayer["withWriteTransaction"]>[0]): T {
        const out = db.withWriteTransaction(fn) as T;
        committed = true;
        return out;
      },
    };
    // store proxy: ANY effective-policy read AFTER commit throws (the Advisor's
    // post-commit probe). The fixed handler reads before/after IN-TXN (committed is
    // still false there) and performs NO store read after commit, so this never
    // fires — proving the orphan window is closed.
    const storeProxy: FridayRetentionSettingsStore = {
      ...store,
      readOwnerContentPolicy(input) {
        if (committed) throw new Error("injected post-commit read failure");
        return store.readOwnerContentPolicy(input);
      },
      readOwnerContentPolicyOnConnection(conn, input) {
        if (committed) throw new Error("injected post-commit read failure");
        return store.readOwnerContentPolicyOnConnection(conn, input);
      },
    };
    const routes = createFridayRetentionSettingsRoutes({
      store: storeProxy,
      resolveCanonicalOwnerId: () => CANON,
      db: dbProxy,
      appendPolicyAudit: realAppender(),
      nowIso: () => NOW,
      idGenerator: () => `op-${String(++idCounter).padStart(4, "0")}`,
    });

    const result = (await putRouteOf(routes).handler(
      makeCtx({ body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };

    // The transaction committed (policy + audit rows persisted)...
    expect(policyRows(CANON)).toEqual([{ content_category: "auditLogs", after_days: 30 }]);
    const rows = auditRows();
    expect(rows).toHaveLength(1);

    // ...AND the full receipt is durably recoverable from the committed GOVERNED
    // receipt store (linked to the content-minimized anchor): never "committed
    // effect + error + no durable receipt".
    const meta = JSON.parse(rows[0].metadata_json) as {
      receiptId: string;
      correlationId: string;
    };
    expect(rows[0].id).toBe(result.receipt.auditId);
    expect(meta.receiptId).toBe(result.receipt.receiptId);
    expect(meta.correlationId).toBe(result.receipt.correlationId);
    const receipts = receiptRows();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].audit_id).toBe(result.receipt.auditId);
    expect(JSON.parse(receipts[0].after_json)).toEqual(result.receipt.evidence.after);
  });

  // ── 10. P0 — CONCURRENT authoritative readback: a DISJOINT-category write that
  //        commits just before this PUT's txn opens → the receipt's authoritative
  //        after (and changed[] and the DB) reflect BOTH categories' TRUE committed
  //        values, never a stale pre-txn synthesis. ──────────────────────────────
  it("a disjoint concurrent commit before this txn → receipt.after + DB reflect BOTH categories (no stale snapshot)", async () => {
    let injected = false;
    const dbProxy: FridaySqliteLayer = {
      ...db,
      withWriteTransaction<T>(fn: Parameters<FridaySqliteLayer["withWriteTransaction"]>[0]): T {
        if (!injected) {
          injected = true;
          // A legitimate DISJOINT write commits in the interval a pre-txn snapshot
          // would have missed — but before this PUT's txn opens.
          store.applyOwnerContentPolicy({
            principalId: CANON,
            updates: { learningEvents: { mode: "after_days", days: 90 } },
          });
        }
        return db.withWriteTransaction(fn) as T;
      },
    };
    const routes = createFridayRetentionSettingsRoutes({
      store,
      resolveCanonicalOwnerId: () => CANON,
      db: dbProxy,
      appendPolicyAudit: realAppender(),
      nowIso: () => NOW,
      idGenerator: () => `op-${String(++idCounter).padStart(4, "0")}`,
    });

    const result = (await putRouteOf(routes).handler(
      makeCtx({ body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    )) as { policy: Record<string, unknown>; receipt: FridayRetentionPolicyUpdateReceipt };

    // Authoritative after reflects the concurrent disjoint commit AND this write.
    expect(result.receipt.evidence.after.learningEvents).toEqual({ mode: "after_days", days: 90 });
    expect(result.receipt.evidence.after.auditLogs).toEqual({ mode: "after_days", days: 30 });
    expect(result.policy.learningEvents).toEqual({ mode: "after_days", days: 90 });
    // This operation only changed auditLogs (learningEvents was already committed).
    expect(result.receipt.evidence.changed).toEqual(["auditLogs"]);
    // Durable DB state matches the receipt.
    expect(policyRows(CANON)).toEqual([
      { content_category: "auditLogs", after_days: 30 },
      { content_category: "learningEvents", after_days: 90 },
    ]);
    // The committed GOVERNED receipt row carries the same authoritative after
    // (the content-minimized audit anchor no longer embeds it).
    const receipts = receiptRows();
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(receipts[0].after_json)).toEqual(result.receipt.evidence.after);
    expect(JSON.parse(auditRows()[0].metadata_json).after).toBeUndefined();
  });

  // ── 11. P0 — concurrent SAME-category commit before this txn → the authoritative
  //        BEFORE reflects the committed value (not a stale permanent snapshot). ──
  it("a same-category concurrent commit before this txn → receipt.before is the TRUE committed value", async () => {
    let injected = false;
    const dbProxy: FridaySqliteLayer = {
      ...db,
      withWriteTransaction<T>(fn: Parameters<FridaySqliteLayer["withWriteTransaction"]>[0]): T {
        if (!injected) {
          injected = true;
          store.applyOwnerContentPolicy({
            principalId: CANON,
            updates: { auditLogs: { mode: "after_days", days: 5 } },
          });
        }
        return db.withWriteTransaction(fn) as T;
      },
    };
    const routes = createFridayRetentionSettingsRoutes({
      store,
      resolveCanonicalOwnerId: () => CANON,
      db: dbProxy,
      appendPolicyAudit: realAppender(),
      nowIso: () => NOW,
      idGenerator: () => `op-${String(++idCounter).padStart(4, "0")}`,
    });

    const result = (await putRouteOf(routes).handler(
      makeCtx({ body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };

    // BEFORE = the concurrently-committed 5 (authoritative in-txn read), not permanent.
    expect(result.receipt.evidence.before.auditLogs).toEqual({ mode: "after_days", days: 5 });
    expect(result.receipt.evidence.after.auditLogs).toEqual({ mode: "after_days", days: 30 });
    expect(result.receipt.evidence.changed).toEqual(["auditLogs"]);
  });

  // ── 12. P0 — audit-projection VISIBILITY: the committed retention audit is
  //        queryable through the product's live AuditLogger projection (not just a
  //        raw SQLite row), while staying rollback-safe. ──────────────────────────
  it("committed retention audit is visible through the live AuditLogger projection", async () => {
    const auditLogger = new AuditLogger({ persistence: createSqliteAuditPersistence(db) });
    const routes = makeRoutes(realAppender(), {
      projectCommittedAudit: (e) => auditLogger.hydratePersistedEntry(e),
    });
    // The boot-hydrated projection is empty before the write.
    expect(auditLogger.queryAuditLog({ tenantId: null }).length).toBe(0);

    const result = (await putRouteOf(routes).handler(
      makeCtx({ body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };

    // The committed entry is now returned by the LIVE projection query (not zero).
    const projected = auditLogger.queryAuditLog({ tenantId: null });
    expect(projected.length).toBe(1);
    expect(projected[0].id).toBe(result.receipt.auditId);
    expect(projected[0].action).toBe("retention.policy.update");
    expect(auditLogger.getAuditEntry(null, result.receipt.auditId)?.resourceType).toBe("policy");
  });

  // ── 13. P0 — uncertain-outcome RECOVERY: an owner-bound seam returns the EXACT
  //        committed receipt by the client-known key; cross-principal is denied. ──
  it("committed receipt is recoverable by client key via the owner-bound seam; cross-principal denied", async () => {
    const routes = makeRoutes(realAppender());
    const KEY = "client-key-abc";
    const put = (await putRouteOf(routes).handler(
      makeCtx({
        headers: { "idempotency-key": KEY },
        body: { policy: { auditLogs: { mode: "after_days", days: 30 } } },
      }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };

    // Recover the EXACT committed receipt through the product seam by the client key.
    const rec = (await receiptRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt | null };
    expect(rec.receipt).not.toBeNull();
    expect(rec.receipt!.receiptId).toBe(put.receipt.receiptId);
    expect(rec.receipt!.correlationId).toBe(put.receipt.correlationId);
    expect(rec.receipt!.auditId).toBe(put.receipt.auditId);
    expect(rec.receipt!.evidence.after).toEqual(put.receipt.evidence.after);
    expect(rec.receipt!.evidence.changed).toEqual(put.receipt.evidence.changed);

    // Unknown key → null (never fabricated).
    const miss = (await receiptRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": "no-such-key" } }),
    )) as { receipt: unknown };
    expect(miss.receipt).toBeNull();

    // Cross-principal (admin-002) → 403 BEFORE any lookup (zero disclosure).
    await expect(
      receiptRouteOf(routes).handler(
        makeCtx({ principal: owner("admin-002"), headers: { "idempotency-key": KEY } }),
      ),
    ).rejects.toMatchObject({ httpStatus: 403 });

    // Missing key → 400.
    await expect(
      receiptRouteOf(routes).handler(makeCtx({ headers: {} })),
    ).rejects.toMatchObject({ httpStatus: 400 });
  });

  // ── 14. P1 — recovery identity across key REUSE + journal expiry: the durable
  //        (owner, key) binding is IMMUTABLE. Same key + same payload replays the
  //        EXACT first receipt (idempotent); same key + DIFFERENT payload is a 409
  //        conflict — the first committed receipt is NEVER shadowed. ─────────────
  it("same key + same payload replays the FIRST receipt; same key + different payload → 409; first is never shadowed", async () => {
    const routes = makeRoutes(realAppender());
    const KEY = "reused-key-Z";

    // First write with the key.
    const first = (await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };
    expect(auditRows()).toHaveLength(1);

    // A LATER write (simulating 48h later, past the 24h HTTP-journal expiry) with
    // the SAME key + SAME payload → idempotent replay of the EXACT first receipt,
    // NO second audit row.
    const replay = (await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };
    expect(replay.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(replay.receipt.auditId).toBe(first.receipt.auditId);
    expect(replay.receipt.evidence.after).toEqual(first.receipt.evidence.after);
    expect(auditRows()).toHaveLength(1); // NOT a second write.

    // A LATER write with the SAME key + DIFFERENT payload → 409 conflict, no write.
    await expect(
      putRouteOf(routes).handler(
        makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 90 } } } }),
      ),
    ).rejects.toMatchObject({ httpStatus: 409 });
    expect(auditRows()).toHaveLength(1);

    // The FIRST committed receipt remains EXACTLY recoverable by its key — never
    // shadowed by a "latest wins" second row.
    const recovered = (await receiptRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt | null };
    expect(recovered.receipt).not.toBeNull();
    expect(recovered.receipt!.receiptId).toBe(first.receipt.receiptId);
    expect(recovered.receipt!.evidence.after.auditLogs).toEqual({ mode: "after_days", days: 30 });
  });

  // ── 15. P1 — product audit VISIBILITY through the REAL tenant-scoped audit route
  //        after restart: the entry is bound to the canonical owner's tenant, so the
  //        owner's `/v1/security/tenants/:tenantId/audit-log` query returns it; the
  //        null tenant does NOT (exact-tenant binding). ──────────────────────────
  it("retention audit is readable via the REAL tenant-scoped audit route after restart; wrong tenant sees zero", async () => {
    const TENANT = "tenant-admin-001";
    // Write under a canonical owner authenticated with the tenant namespace.
    const routes = makeRoutes(realAppender());
    await putRouteOf(routes).handler(
      makeCtx({
        principal: ownerWithTenant(CANON, TENANT),
        body: { policy: { auditLogs: { mode: "after_days", days: 30 } } },
      }),
    );

    // Simulate a RESTART: a fresh AuditLogger re-hydrates from the durable
    // security_audit_log at construction (no in-memory carryover).
    const restartedLogger = new AuditLogger({ persistence: createSqliteAuditPersistence(db) });

    // Drive the REAL product audit route (`security.audit.list`) — same code path
    // bootstrap wires (`deps.audit.list → queryAuditLog({ tenantId })`).
    const securityRoutes = createFridayMultiTenantSecurityRoutes({
      audit: {
        list: (tenantId: string, query?: Record<string, unknown>) => ({
          items: [...restartedLogger.queryAuditLog({ tenantId, ...(query ?? {}) } as never)],
        }),
      },
    } as unknown as Parameters<typeof createFridayMultiTenantSecurityRoutes>[0]);
    const auditListRoute = securityRoutes.find((r) => r.operationId === "security.audit.list")!;

    // The canonical owner's tenant query returns the retention entry post-restart.
    const viaTenant = (await auditListRoute.handler(
      makeCtx({ principal: ownerWithTenant(CANON, TENANT), params: { tenantId: TENANT } }),
    )) as { items: Array<{ action: string; tenantId: string | null }> };
    const retentionEntries = viaTenant.items.filter((e) => e.action === "retention.policy.update");
    expect(retentionEntries).toHaveLength(1);
    expect(retentionEntries[0].tenantId).toBe(TENANT);

    // The NULL tenant (the round-3 wrong binding) does NOT see it — proving the
    // entry is bound to the owner's real tenant namespace, not null.
    const viaNull = (await auditListRoute.handler(
      makeCtx({ principal: ownerWithTenant(CANON, TENANT), params: { tenantId: null as unknown as string } }),
    )) as { items: Array<{ action: string }> };
    expect(viaNull.items.filter((e) => e.action === "retention.policy.update")).toHaveLength(0);
  });

  // ── 16. P2 — recovery key is HEADER-ONLY: a `?key=` query string is NOT honored
  //        (so the sensitive key can never land in access logs / URLs). ──────────
  it("recovery ignores ?key= query string; requires the Idempotency-Key header", async () => {
    const routes = makeRoutes(realAppender());
    const KEY = "header-only-key";
    await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    );

    // Key ONLY in the query string, NO header → 400 (query fallback removed).
    await expect(
      receiptRouteOf(routes).handler(makeCtx({ headers: {}, query: { key: KEY } })),
    ).rejects.toMatchObject({ httpStatus: 400 });

    // Key in the HEADER → recovers. (The key never appears in the URL/query.)
    const rec = (await receiptRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, query: {} }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt | null };
    expect(rec.receipt).not.toBeNull();
  });

  // ── 17. P1(a) — raw-key MINIMIZATION: the RAW recovery key is NEVER persisted;
  //        only its non-reversible sha256 hash is stored, and recovery + conflict
  //        detection still work by hashing the presented key. ───────────────────
  it("the RAW recovery key is never at rest; only its sha256 hash is stored, and recovery still matches", async () => {
    const routes = makeRoutes(realAppender());
    const KEY = "raw-secret-recovery-key-xyz";
    await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    );

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    // The RAW key appears NOWHERE in the persisted anchor, AND the content-minimized
    // anchor carries neither the raw key NOR its hash (both live in the store).
    expect(rows[0].metadata_json).not.toContain(KEY);
    const meta = JSON.parse(rows[0].metadata_json) as {
      recoveryKey?: unknown;
      recoveryKeyHash?: unknown;
    };
    expect(meta.recoveryKey).toBeUndefined(); // no raw-key field at all
    expect(meta.recoveryKeyHash).toBeUndefined(); // hash is NOT in the audit anchor

    // The GOVERNED receipt store holds ONLY the non-reversible sha256 hash — never
    // the raw key (neither the hash column nor any serialized column contains it).
    const receipts = receiptRows();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].recovery_key_hash).toBe(hashRecoveryKey(KEY));
    expect(JSON.stringify(receipts[0])).not.toContain(KEY);

    // Recovery still matches by hashing the presented key (exact-replay preserved).
    const rec = (await receiptRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt | null };
    expect(rec.receipt).not.toBeNull();

    // Same key + different payload still 409 (conflict detection works on the hash).
    await expect(
      putRouteOf(routes).handler(
        makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 90 } } } }),
      ),
    ).rejects.toMatchObject({ httpStatus: 409 });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // RETENTION-R3d ROUND-7 — governed receipt store: RED-FIRST negative controls.
  //
  // The finding (Advisor, reproduced by a production probe): the FULL recovery
  // receipt lived in `security_audit_log.metadata_json`; the auditLogs retention
  // job deletes only `audit_logs` rows, so an aged receipt SURVIVED a 2-year
  // advance — the user's auditLogs deletion policy was silently NOT honored for the
  // receipt (an operator-locked U9/DATA-RETENTION-001 violation). The fix moves the
  // receipt into the dedicated, retention-GOVERNED `retention_recovery_receipts`
  // store and expires it under the SAME auditLogs category.
  // ══════════════════════════════════════════════════════════════════════════

  // Build routes with an explicit clock so a receipt can be committed with an AGED
  // created_at (older than a future reaper cutoff), plus an optional persistReceipt
  // override for fault injection.
  function makeRoutesAt(
    clockIso: string,
    opts: { persistReceipt?: (db: never, record: FridayRetentionReceiptRecord) => void } = {},
  ) {
    return createFridayRetentionSettingsRoutes({
      store,
      resolveCanonicalOwnerId: () => CANON,
      db,
      appendPolicyAudit: createFridayRetentionPolicyAuditAppender({
        sqlite: db,
        idGenerator: () => `aud-${String(++idCounter).padStart(4, "0")}`,
      }),
      nowIso: () => clockIso,
      idGenerator: () => `op-${String(++idCounter).padStart(4, "0")}`,
      readReceiptByRecoveryKey: createFridayRetentionReceiptRecovery({ sqlite: db }),
      ...(opts.persistReceipt
        ? { persistReceipt: opts.persistReceipt as unknown as never }
        : {}),
    });
  }

  // Reaper bound to the canonical owner, loading the LIVE persisted policy (so the
  // owner's opt-in governs the sweep) — mirrors production wiring.
  function reaperForOwner() {
    const loader = createFridayRetentionPolicyLoader({
      db,
      repo: createFridayRetentionSettingsRepository(),
      principalId: CANON,
    });
    return createFridayRetentionJob({
      db,
      pairingRequestRepo: createFridaySatellitePairingRequestRepository(),
      heartbeatRepo: createFridaySatelliteHeartbeatRepository(),
      outboxRepo: createFridayOutboxMessageRepository(),
      learningLedger: createFridayLearningEventLedger({ db }),
      skillRunStore: createFridaySkillRunStore({ db }),
      bootstrapNonceRepo: createFridaySetupBootstrapNonceRepository(),
      nowIso: () => NOW,
      loadPolicy: () => loader.load(),
    });
  }

  // (a) FINITE retention → an AGED receipt EXPIRES from the store AND recovery
  //     returns null. (RED pre-fix: the receipt survived in `security_audit_log`.)
  it("(a) auditLogs opted into FINITE retention → aged receipt EXPIRES from the store AND recovery returns null", async () => {
    const KEY = "finite-expiry-key";
    // Commit an AGED receipt while opting auditLogs into a finite 30-day window.
    const routes = makeRoutesAt(AGED);
    const put = (await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };

    // Pre-sweep: the receipt is durable and recoverable by the client key.
    expect(receiptRows()).toHaveLength(1);
    const recBefore = (await receiptRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt | null };
    expect(recBefore.receipt?.receiptId).toBe(put.receipt.receiptId);

    // The reaper runs at NOW with the owner's finite auditLogs policy.
    const result = reaperForOwner().run(NOW);

    // The receipt EXPIRED under the auditLogs category (this is the fix — pre-fix
    // it survived because it lived in the untouched `security_audit_log`).
    expect(result.deletedRetentionReceipts).toBe(1);
    expect(receiptRows()).toHaveLength(0);

    // Recovery now returns null exactly because the user's deletion policy removed it.
    const recAfter = (await receiptRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt | null };
    expect(recAfter.receipt).toBeNull();

    // AUDIT-AUTHENTIC-ANCHOR-001: the content-free audit anchor is NOT swept (it is
    // authentic-audit truth, default-permanent) — only the user receipt content went.
    expect(auditRows()).toHaveLength(1);
    expect(JSON.parse(auditRows()[0].metadata_json).before).toBeUndefined();
  });

  // (b) PERMANENT (default) retention → the receipt is PRESERVED + recovery works.
  //     The receipt store is governed ONLY by the auditLogs category: a finite
  //     window on a DIFFERENT category never expires it.
  it("(b) auditLogs PERMANENT (default) → aged receipt is preserved + recovery still works, even with another category finite", async () => {
    const KEY = "permanent-preserve-key";
    // Aged receipt; auditLogs stays permanent, learningEvents opted into finite.
    const routes = makeRoutesAt(AGED);
    const put = (await putRouteOf(routes).handler(
      makeCtx({
        headers: { "idempotency-key": KEY },
        body: { policy: { learningEvents: { mode: "after_days", days: 30 } } },
      }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };
    expect(receiptRows()).toHaveLength(1);

    // The reaper runs at NOW: learningEvents finite, auditLogs PERMANENT.
    const result = reaperForOwner().run(NOW);

    // auditLogs is permanent ⇒ ZERO receipts expired; the receipt is preserved.
    expect(result.deletedRetentionReceipts).toBe(0);
    expect(receiptRows()).toHaveLength(1);

    // Recovery still returns the exact committed receipt.
    const rec = (await receiptRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt | null };
    expect(rec.receipt?.receiptId).toBe(put.receipt.receiptId);
  });

  // (c) Cross-owner recovery remains DENIED at the STORE layer: an owner's lookup by
  //     key hash never returns a different principal's receipt (owner-scoped query).
  it("(c) receipt-store lookup is owner-scoped — a shared recovery-key hash never crosses principals", () => {
    const repo = createFridayRetentionReceiptRepository();
    const sharedHash = hashRecoveryKey("shared-key-across-owners");
    const base = (ownerId: string, receiptId: string): FridayRetentionReceiptRecord => ({
      receiptId,
      ownerId,
      ownerTenantId: ownerId,
      correlationId: `corr:${receiptId}`,
      auditId: `aud:${receiptId}`,
      recoveryKeyHash: sharedHash,
      payloadDigest: "digest",
      before: { auditLogs: { mode: "permanent" } } as never,
      after: { auditLogs: { mode: "after_days", days: 30 } } as never,
      changedCategories: ["auditLogs"],
      appliedUpdates: { auditLogs: { mode: "after_days", days: 30 } },
      createdAt: NOW,
    });
    db.withWriteTransaction((conn) => {
      repo.insert(conn, base(CANON, "receipt-owner-a"));
      repo.insert(conn, base("admin-002", "receipt-owner-b"));
    });

    const a = db.withReadConnection((conn) =>
      repo.findOldestByRecoveryKey(conn, { ownerId: CANON, recoveryKeyHash: sharedHash }),
    );
    const b = db.withReadConnection((conn) =>
      repo.findOldestByRecoveryKey(conn, { ownerId: "admin-002", recoveryKeyHash: sharedHash }),
    );
    expect(a?.receiptId).toBe("receipt-owner-a");
    expect(a?.ownerId).toBe(CANON);
    expect(b?.receiptId).toBe("receipt-owner-b");
    expect(b?.ownerId).toBe("admin-002");
  });

  // (d) ATOMICITY: a failure injected at the RECEIPT-WRITE stage rolls the WHOLE
  //     transaction back — zero policy rows, zero audit anchor, zero receipt rows.
  it("(d) receipt-write throws → 503-class abort with zero partial rows (policy + audit + receipt all rolled back)", async () => {
    const routes = makeRoutesAt(NOW, {
      persistReceipt: () => {
        throw new FridayDomainError(
          "RETENTION_RECEIPT_PERSIST_FAILED",
          "injected receipt-write failure",
          { httpStatus: 503 },
        );
      },
    });
    await expect(
      putRouteOf(routes).handler(
        makeCtx({ headers: { "idempotency-key": "atomic-key" }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
      ),
    ).rejects.toMatchObject({ httpStatus: 503 });

    // All-or-nothing: nothing persisted across ANY of the three stores.
    expect(policyRows(CANON)).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
    expect(receiptRows()).toHaveLength(0);
  });

  // (e) The `security_audit_log` anchor no longer contains the full before/after
  //     recovery payload — only the linkage (receiptId/correlationId) + digest.
  it("(e) security_audit_log anchor is content-minimized — only linkage + digest, no before/after payload", async () => {
    const routes = makeRoutes(realAppender());
    await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": "min-key" }, body: { policy: { auditLogs: { mode: "after_days", days: 42 } } } }),
    );
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0].metadata_json) as Record<string, unknown>;
    // ONLY these keys are permitted on the authentic-audit anchor.
    expect(Object.keys(meta).sort()).toEqual(["correlationId", "payloadDigest", "receiptId"]);
    // No user recovery payload / no recovery-key material at rest in the anchor.
    for (const forbidden of ["before", "after", "appliedUpdates", "changedCategories", "recoveryKeyHash", "recoveryKey", "deletedData"]) {
      expect(meta[forbidden]).toBeUndefined();
    }
    // The applied window (42) lives ONLY in the GOVERNED store, never the anchor —
    // the anchor's `after` is absent, so a retention advance cannot orphan content.
    expect(JSON.parse(receiptRows()[0].after_json).auditLogs).toEqual({ mode: "after_days", days: 42 });
  });
});

// ── Real public-HTTP seam: owner-auth happy path + cross-principal denial ─────

type StubPrincipal = {
  principalId: string;
  userId: string;
  tenantId: string;
  role: string;
  scopes: string[];
  tokenId: string;
};

const OWNER_A: StubPrincipal = {
  principalId: "user:admin-001",
  userId: CANON,
  tenantId: "admin-001",
  role: "admin",
  scopes: ["hub.admin", "session.read"],
  tokenId: "tok-admin-001",
};
const OWNER_B: StubPrincipal = {
  principalId: "user:admin-002",
  userId: "admin-002",
  tenantId: "admin-002",
  role: "admin",
  scopes: ["hub.admin", "session.read"],
  tokenId: "tok-admin-002",
};

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("failed to allocate free port"));
        return;
      }
      const p = addr.port;
      srv.close((closeErr) => (closeErr ? reject(closeErr) : resolve(p)));
    });
    srv.on("error", reject);
  });
}

function makeStubWsGateway(): FridayRealtimeWsGateway {
  return {
    handleClientFrame: () => ({ handled: false }),
    addConnection: () => {},
    removeConnection: () => {},
    broadcastEvent: () => {},
  } as unknown as FridayRealtimeWsGateway;
}

function makeBearerStubMiddleware(
  validTokens: Record<string, StubPrincipal>,
): FridayAuthMiddlewareFactory {
  return {
    requireAuth: (ctx) => {
      if (ctx.principal) return { passed: true as const };
      const auth = ctx.headers["authorization"] ?? ctx.headers["Authorization"];
      if (!auth) return { passed: false as const, statusCode: 401, code: "UNAUTHORIZED", message: "missing token" };
      const parts = auth.split(" ");
      if (parts.length !== 2 || parts[0] !== "Bearer") {
        return { passed: false as const, statusCode: 401, code: "UNAUTHORIZED", message: "malformed header" };
      }
      const principal = validTokens[parts[1]];
      if (!principal) return { passed: false as const, statusCode: 401, code: "UNAUTHORIZED", message: "invalid token" };
      (ctx as { principal: unknown }).principal = principal;
      return { passed: true as const };
    },
    requireAnyScope: () => ({ passed: true as const }),
  } as unknown as FridayAuthMiddlewareFactory;
}

describe("FridayHttpServer — RETENTION-R3d real-HTTP receipt + denial isolation", () => {
  let server: FridayHttpServer | null = null;
  let db: FridaySqliteLayer | null = null;
  let store: FridayRetentionSettingsStore;
  let port = 0;
  let baseUrl = "";
  let idc = 0;

  function auditCount(): number {
    return (db!.writer.prepare("SELECT COUNT(*) c FROM security_audit_log").get() as { c: number }).c;
  }

  beforeEach(async () => {
    port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    idc = 0;
    db = createTestDb();
    store = createFridayRetentionSettingsStore({
      db,
      repo: createFridayRetentionSettingsRepository(),
      idGenerator: () => `ret-${String(++idc).padStart(4, "0")}`,
      nowIso: () => NOW,
    });
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    if (db) {
      db.close();
      db = null;
    }
  });

  function startServer(
    tokens: Record<string, StubPrincipal>,
    logOpts?: { logRequests?: boolean; logger?: (line: string) => void },
  ) {
    const routes = createFridayHttpRouteRegistry();
    for (const route of createFridayRetentionSettingsRoutes({
      store,
      resolveCanonicalOwnerId: () => CANON,
      db: db!,
      appendPolicyAudit: createFridayRetentionPolicyAuditAppender({
        sqlite: db!,
        idGenerator: () => `aud-${String(++idc).padStart(4, "0")}`,
      }),
      nowIso: () => NOW,
      idGenerator: () => `op-${String(++idc).padStart(4, "0")}`,
      readReceiptByRecoveryKey: createFridayRetentionReceiptRecovery({ sqlite: db! }),
    })) {
      routes.register(route);
    }
    server = createFridayHttpServer({
      routes,
      wsGateway: makeStubWsGateway(),
      middleware: makeBearerStubMiddleware(tokens),
      port,
      host: "127.0.0.1",
      ...(logOpts ?? {}),
    });
    return server.listen();
  }

  it("canonical owner PUT → 200 with a well-formed receipt + exactly one audit row", async () => {
    await startServer({ [OWNER_A.tokenId]: OWNER_A });
    const res = await fetch(`${baseUrl}/v1/uix/retention-policy`, {
      method: "PUT",
      headers: { authorization: `Bearer ${OWNER_A.tokenId}`, "content-type": "application/json" },
      body: JSON.stringify({ policy: { auditLogs: { mode: "after_days", days: 30 } } }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: true;
      data: {
        policy: Record<string, unknown>;
        receipt: FridayRetentionPolicyUpdateReceipt;
      };
    };
    const { policy, receipt } = json.data;
    expect(policy.auditLogs).toEqual({ mode: "after_days", days: 30 });
    expect(receipt.correlationId).toMatch(new RegExp(`^retention-policy-update:${CANON}:op-\\d+$`));
    expect(receipt.receiptId).toMatch(new RegExp(`^retention-receipt:${CANON}:op-\\d+$`));
    expect(receipt.requestedBy).toBe(CANON);
    expect(receipt.evidence.before.auditLogs).toEqual({ mode: "permanent" });
    expect(receipt.evidence.after.auditLogs).toEqual({ mode: "after_days", days: 30 });
    expect(receipt.evidence.changed).toEqual(["auditLogs"]);
    expect(receipt.evidence.deletedData).toBe(false);
    expect(receipt.auditId).toBeTruthy();
    expect(auditCount()).toBe(1);
  });

  it("a second admin (admin-002) PUT → 403 with ZERO audit/receipt side effect", async () => {
    await startServer({ [OWNER_A.tokenId]: OWNER_A, [OWNER_B.tokenId]: OWNER_B });
    const res = await fetch(`${baseUrl}/v1/uix/retention-policy`, {
      method: "PUT",
      headers: { authorization: `Bearer ${OWNER_B.tokenId}`, "content-type": "application/json" },
      body: JSON.stringify({ policy: { auditLogs: { mode: "after_days", days: 30 } } }),
    });
    expect(res.status).toBe(403);
    // The denial happened BEFORE any before-readback/audit/receipt/mutation.
    expect(auditCount()).toBe(0);
    expect(
      (db!.writer.prepare("SELECT COUNT(*) c FROM friday_retention_settings").get() as { c: number }).c,
    ).toBe(0);
  });

  // P2 (real HTTP): the recovery key travels ONLY in the Idempotency-Key HEADER —
  // it is never placed in the request URL/query, so it cannot reach access logs.
  it("recovery over real HTTP is header-only; the key never appears in the request URL, and ?key= is not honored", async () => {
    await startServer({ [OWNER_A.tokenId]: OWNER_A });
    const KEY = "sensitive-recovery-key-42";
    // Commit a receipt bound to the key (header on the PUT).
    const putRes = await fetch(`${baseUrl}/v1/uix/retention-policy`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${OWNER_A.tokenId}`,
        "content-type": "application/json",
        "idempotency-key": KEY,
      },
      body: JSON.stringify({ policy: { auditLogs: { mode: "after_days", days: 30 } } }),
    });
    expect(putRes.status).toBe(200);

    // Recovery: key in the HEADER, URL carries NO key.
    const recoverUrl = `${baseUrl}/v1/uix/retention-policy/receipt`;
    expect(recoverUrl).not.toContain(KEY); // the sensitive key is never in the URL
    const recRes = await fetch(recoverUrl, {
      headers: { authorization: `Bearer ${OWNER_A.tokenId}`, "idempotency-key": KEY },
    });
    expect(recRes.status).toBe(200);
    const recJson = (await recRes.json()) as { ok: true; data: { receipt: FridayRetentionPolicyUpdateReceipt | null } };
    expect(recJson.data.receipt).not.toBeNull();
    expect(recJson.data.receipt!.evidence.after.auditLogs).toEqual({ mode: "after_days", days: 30 });

    // Putting the key ONLY in the query string (the removed fallback) → 400: the
    // key in a URL is never honored, removing any incentive to log it there.
    const queryRes = await fetch(`${recoverUrl}?key=${encodeURIComponent(KEY)}`, {
      headers: { authorization: `Bearer ${OWNER_A.tokenId}` },
    });
    expect(queryRes.status).toBe(400);
  });

  // P2 (real HTTP + access-log capture): a `?key=…` (real, encoded, and
  // multi-param) is rejected AND the sensitive key NEVER appears in ANY emitted
  // access-log line — including for the rejected/unknown-route requests.
  it("the recovery key never reaches the access log via query string (real, %3F-encoded, multi-param)", async () => {
    const logs: string[] = [];
    await startServer({ [OWNER_A.tokenId]: OWNER_A }, { logRequests: true, logger: (l) => logs.push(l) });
    const SECRET = "advisor-secret-recovery-key"; // pragma: allowlist secret (test fixture, not a real secret)
    const auth = { authorization: `Bearer ${OWNER_A.tokenId}` };

    // (1) real query string → 400 (fallback removed).
    const r1 = await fetch(`${baseUrl}/v1/uix/retention-policy/receipt?key=${SECRET}`, { headers: auth });
    expect(r1.status).toBe(400);
    // (2) multiple params.
    await fetch(`${baseUrl}/v1/uix/retention-policy/receipt?key=${SECRET}&x=1`, { headers: auth });
    // (3) percent-encoded `?`/`=` (unknown-route path; the finish-logger still runs).
    await fetch(`${baseUrl}/v1/uix/retention-policy/receipt%3Fkey%3D${SECRET}`, { headers: auth });

    // Let the response `finish` events fire the access-log sink.
    await new Promise((r) => setTimeout(r, 60));

    // Logging was actually ON, and the secret is in NONE of the emitted lines.
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain(SECRET);
    }
  });
});

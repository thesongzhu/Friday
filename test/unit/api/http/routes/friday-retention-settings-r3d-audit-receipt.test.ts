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
import { hashIdempotencyPayload } from "../../../../../src/api/http/routes/friday-route-idempotency.js";
import {
  createFridayRetentionJob,
  createFridayRetentionPolicyLoader,
  createFridayRetentionReceiptRepository,
  createFridayRetentionSettingsRepository,
  createFridayRetentionSettingsStore,
  isValidCategoryRetention,
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
// A wall-clock instant AFTER NOW — used to write a receipt+anchor that is then swept
// by a reaper running at NOW (a BACKWARD wall-clock jump / NTP correction). The
// receipt's created_at is "future" relative to the rolled-back now, yet legitimate.
const FUTURE = "2026-07-18T10:00:00.000Z";

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
    // WHOLE-ROW INVARIANT: ids carry the canonical write-path shape and each receipt
    // has a matching content-minimized `security_audit_log` anchor (the invariant now
    // cross-checks every inserted/decoded receipt against its anchor). The fixtures are
    // otherwise fully coherent so the test isolates OWNER-SCOPING, not integrity.
    const digest = hashIdempotencyPayload({ auditLogs: { mode: "after_days", days: 30 } });
    const base = (ownerId: string, opId: string): FridayRetentionReceiptRecord => ({
      receiptId: `retention-receipt:${ownerId}:${opId}`,
      ownerId,
      ownerTenantId: ownerId,
      correlationId: `retention-policy-update:${ownerId}:${opId}`,
      auditId: `aud-${opId}`,
      recoveryKeyHash: sharedHash,
      payloadDigest: digest,
      // Full 7-category content policies — exactly what the store always emits (the
      // decode path strict-validates completeness, so a receipt's before/after must
      // carry every canonical category).
      before: {
        learningEvents: { mode: "permanent" },
        heartbeats: { mode: "permanent" },
        skillRunTerminal: { mode: "permanent" },
        auditLogs: { mode: "permanent" },
        agentRuns: { mode: "permanent" },
        llmUsageRecords: { mode: "permanent" },
        errorIncidents: { mode: "permanent" },
      } as never,
      after: {
        learningEvents: { mode: "permanent" },
        heartbeats: { mode: "permanent" },
        skillRunTerminal: { mode: "permanent" },
        auditLogs: { mode: "after_days", days: 30 },
        agentRuns: { mode: "permanent" },
        llmUsageRecords: { mode: "permanent" },
        errorIncidents: { mode: "permanent" },
      } as never,
      changedCategories: ["auditLogs"],
      appliedUpdates: { auditLogs: { mode: "after_days", days: 30 } },
      createdAt: NOW,
    });
    // Seed each receipt's authentic-audit anchor FIRST (content-minimized: linkage +
    // digest only), so the whole-row invariant's cross-store check passes on insert.
    const seedAnchor = (rec: FridayRetentionReceiptRecord): void => {
      db.writer
        .prepare(
          // The anchor must carry the FULL canonical semantic envelope (the whole-row
          // invariant now cross-checks action/resource_type/resource_id/decision/
          // session_id/reason), so this fixture uses the canonical reason (not a
          // placeholder) to isolate OWNER-SCOPING, not the envelope.
          `INSERT INTO security_audit_log
             (id, tenant_id, principal_id, action, resource_type, resource_id,
              decision, reason, session_id, metadata_json, created_at)
           VALUES (?, ?, ?, 'retention.policy.update', 'policy', ?, 'allow', 'canonical-owner retention policy update', ?, ?, ?)`,
        )
        .run(
          rec.auditId,
          rec.ownerTenantId,
          rec.ownerId,
          `retention-policy:${rec.ownerId}`,
          rec.correlationId,
          JSON.stringify({
            receiptId: rec.receiptId,
            correlationId: rec.correlationId,
            payloadDigest: rec.payloadDigest,
          }),
          rec.createdAt,
        );
    };
    const recA = base(CANON, "op-a");
    const recB = base("admin-002", "op-b");
    seedAnchor(recA);
    seedAnchor(recB);
    db.withWriteTransaction((conn) => {
      repo.insert(conn, recA);
      repo.insert(conn, recB);
    });

    const a = db.withReadConnection((conn) =>
      repo.findOldestByRecoveryKey(conn, { ownerId: CANON, recoveryKeyHash: sharedHash }),
    );
    const b = db.withReadConnection((conn) =>
      repo.findOldestByRecoveryKey(conn, { ownerId: "admin-002", recoveryKeyHash: sharedHash }),
    );
    expect(a?.receiptId).toBe(recA.receiptId);
    expect(a?.ownerId).toBe(CANON);
    expect(b?.receiptId).toBe(recB.receiptId);
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

  // ══════════════════════════════════════════════════════════════════════════
  // RETENTION-R3d ROUND-8 — receipt-INTEGRITY fail-closed (P1 fail-OPEN fix).
  //
  // Finding (Advisor, reproduced by an adversarial real-SQLite probe): a MATCHING
  // but MALFORMED persisted receipt decoded to `null`, so the PUT idempotency guard
  // read a corrupt binding as an UNUSED key and RE-EXECUTED a same-key/DIFFERENT-
  // payload mutation (auditLogs 30→90, receipt & audit counts 1→2) — a fail-OPEN
  // that also broke same-key immutability. The fix: a matching-but-corrupt receipt
  // raises a TYPED integrity error (fail-CLOSED); `null` is reserved EXCLUSIVELY for
  // a genuinely ABSENT / expired binding.
  // ══════════════════════════════════════════════════════════════════════════

  // The typed fail-closed signature the guard + recovery must surface on corruption.
  const INTEGRITY = { httpStatus: 500, code: "RETENTION_RECEIPT_INTEGRITY_FAILURE" };

  // Seed ONE valid receipt bound to KEY (auditLogs→30), corrupt its stored row (owner
  // + recovery-key binding preserved), then replay the SAME key with a DIFFERENT
  // payload (90). Post-fix this MUST fail closed with a typed integrity error, leaving
  // the persisted policy BYTE-UNCHANGED and receipt + audit counts at 1.
  async function seedCorruptThenReplayDifferent(
    KEY: string,
    corrupt: (recoveryKeyHash: string) => void,
  ): Promise<void> {
    const routes = makeRoutes(realAppender());
    await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    );
    expect(receiptRows()).toHaveLength(1);
    expect(auditRows()).toHaveLength(1);
    const policyBefore = policyRows(CANON);
    expect(policyBefore).toEqual([{ content_category: "auditLogs", after_days: 30 }]);

    corrupt(hashRecoveryKey(KEY));

    await expect(
      putRouteOf(routes).handler(
        makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 90 } } } }),
      ),
    ).rejects.toMatchObject(INTEGRITY);

    // Fail-CLOSED: policy byte-unchanged (still 30, never 90); NO second receipt/audit.
    expect(policyRows(CANON)).toEqual(policyBefore);
    const get = (await getRouteOf(routes).handler(makeCtx())) as { policy: Record<string, unknown> };
    expect(get.policy.auditLogs).toEqual({ mode: "after_days", days: 30 });
    expect(receiptRows()).toHaveLength(1);
    expect(auditRows()).toHaveLength(1);
  }

  // (a) MALFORMED JSON on a matching receipt → typed integrity error; byte-unchanged.
  it("(round-8 a) matching MALFORMED receipt (undecodable before_json) + same key/DIFFERENT payload → typed integrity error (fail-closed), policy byte-unchanged, counts stay 1", async () => {
    await seedCorruptThenReplayDifferent("corrupt-json-key", (hash) =>
      db.writer
        .prepare("UPDATE retention_recovery_receipts SET before_json = ? WHERE recovery_key_hash = ?")
        .run("{not-valid-json", hash),
    );
  });

  // (b) STRUCTURALLY-INVALID JSON (valid JSON, bad shape) → same fail-closed posture.
  const structuralCorruptions: Array<[string, (recoveryKeyHash: string) => void]> = [
    [
      "changedCategories is not an array",
      (h) =>
        db.writer
          .prepare("UPDATE retention_recovery_receipts SET changed_categories_json = ? WHERE recovery_key_hash = ?")
          .run(JSON.stringify({ not: "an-array" }), h),
    ],
    [
      "changedCategories has an unknown category name",
      (h) =>
        db.writer
          .prepare("UPDATE retention_recovery_receipts SET changed_categories_json = ? WHERE recovery_key_hash = ?")
          .run(JSON.stringify(["notARealCategory"]), h),
    ],
    [
      "appliedUpdates has an unknown category key",
      (h) =>
        db.writer
          .prepare("UPDATE retention_recovery_receipts SET applied_updates_json = ? WHERE recovery_key_hash = ?")
          .run(JSON.stringify({ notARealCategory: { mode: "permanent" } }), h),
    ],
    [
      "appliedUpdates has an out-of-range CategoryRetention (reaper-unhonored)",
      (h) =>
        db.writer
          .prepare("UPDATE retention_recovery_receipts SET applied_updates_json = ? WHERE recovery_key_hash = ?")
          .run(JSON.stringify({ auditLogs: { mode: "after_days", days: 1_000_000_000 } }), h),
    ],
    [
      "appliedUpdates has a bad mode",
      (h) =>
        db.writer
          .prepare("UPDATE retention_recovery_receipts SET applied_updates_json = ? WHERE recovery_key_hash = ?")
          .run(JSON.stringify({ auditLogs: { mode: "forever" } }), h),
    ],
  ];
  it.each(structuralCorruptions)(
    "(round-8 b) structurally-invalid receipt [%s] + same key/different payload → fail-closed integrity error; policy byte-unchanged; counts stay 1",
    async (_label, corrupt) => {
      await seedCorruptThenReplayDifferent("struct-invalid-key", corrupt);
    },
  );

  // (b-policy) schema-valid JSON policy but semantically invalid: an out-of-range
  // per-category value, and a TRUNCATED policy (missing a canonical category).
  it("(round-8 b-policy) 'before' is a schema-valid policy with an out-of-range per-category value → fail-closed; counts stay 1", async () => {
    await seedCorruptThenReplayDifferent("before-out-of-range-key", (hash) => {
      // Start from the committed (valid) 7-category policy, tamper ONE category to an
      // out-of-domain window → valid JSON, invalid CategoryRetention.
      const policy = JSON.parse(receiptRows()[0].after_json) as Record<string, unknown>;
      policy.auditLogs = { mode: "after_days", days: 1_000_000_000 };
      db.writer
        .prepare("UPDATE retention_recovery_receipts SET before_json = ? WHERE recovery_key_hash = ?")
        .run(JSON.stringify(policy), hash);
    });
  });
  it("(round-8 b-policy) 'after' is a TRUNCATED policy (missing a canonical category) → fail-closed; counts stay 1", async () => {
    await seedCorruptThenReplayDifferent("after-truncated-key", (hash) => {
      const policy = JSON.parse(receiptRows()[0].after_json) as Record<string, unknown>;
      delete policy.errorIncidents; // now 6 of 7 canonical categories → not exactly seven
      db.writer
        .prepare("UPDATE retention_recovery_receipts SET after_json = ? WHERE recovery_key_hash = ?")
        .run(JSON.stringify(policy), hash);
    });
  });

  // (c) RECOVERY on a corrupt matching binding → typed integrity error, not null/success.
  it("(round-8 c) recovery on a corrupt MATCHING binding → typed integrity error (fail-closed), never a silent null", async () => {
    const KEY = "recover-corrupt-key";
    const routes = makeRoutes(realAppender());
    await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    );
    // Corrupt the matching receipt (undecodable applied_updates_json) — binding kept.
    db.writer
      .prepare("UPDATE retention_recovery_receipts SET applied_updates_json = ? WHERE recovery_key_hash = ?")
      .run("{bad", hashRecoveryKey(KEY));
    await expect(
      receiptRouteOf(routes).handler(makeCtx({ headers: { "idempotency-key": KEY } })),
    ).rejects.toMatchObject(INTEGRITY);
  });

  // (d) A GENUINELY-absent key still returns null → recovery null AND a fresh PUT
  //     proceeds normally (do NOT over-fail-close valid new writes).
  it("(round-8 d) a GENUINELY-absent key → recovery null AND a fresh PUT applies normally (no over-fail-close)", async () => {
    const routes = makeRoutes(realAppender());
    const miss = (await receiptRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": "never-used-key" } }),
    )) as { receipt: unknown };
    expect(miss.receipt).toBeNull(); // genuine absence → null, NOT an integrity error

    const put = (await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": "fresh-unused-key" }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };
    expect(put.receipt.status).toBe("applied");
    expect(policyRows(CANON)).toEqual([{ content_category: "auditLogs", after_days: 30 }]);
    expect(receiptRows()).toHaveLength(1);
    expect(auditRows()).toHaveLength(1);
  });

  // (e) A GENUINELY-expired receipt (deleted by finite auditLogs retention) → null →
  //     a same-key PUT proceeds (expiry is REAL absence, not corruption).
  it("(round-8 e) a GENUINELY-expired receipt (reaped) → recovery null AND a same-key PUT proceeds (expiry is real absence)", async () => {
    const KEY = "expired-then-reused-key";
    // Commit an AGED receipt under a finite auditLogs window, then reap it.
    const agedRoutes = makeRoutesAt(AGED);
    await putRouteOf(agedRoutes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    );
    expect(receiptRows()).toHaveLength(1);
    const reaped = reaperForOwner().run(NOW);
    expect(reaped.deletedRetentionReceipts).toBe(1);
    expect(receiptRows()).toHaveLength(0);

    // Recovery returns null (the row is truly gone) — NOT an integrity error.
    const rec = (await receiptRouteOf(agedRoutes).handler(
      makeCtx({ headers: { "idempotency-key": KEY } }),
    )) as { receipt: unknown };
    expect(rec.receipt).toBeNull();

    // A same-key PUT with a DIFFERENT payload now PROCEEDS: the prior binding was
    // legitimately deleted (genuine absence), so this is a valid new write.
    const nowRoutes = makeRoutes(realAppender());
    const put = (await putRouteOf(nowRoutes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 90 } } } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };
    expect(put.receipt.status).toBe("applied");
    expect(put.receipt.evidence.after.auditLogs).toEqual({ mode: "after_days", days: 90 });
    expect(receiptRows()).toHaveLength(1);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // RETENTION-R3d ROUND-9 — cross-field COHERENCE + exact-shape validation
  // (P1 fail-OPEN fix).
  //
  // Finding (fresh Advisor audit, reproduced by real-SQLite probes):
  //   P1-A — decodeReceiptRow validated each JSON field INDEPENDENTLY but never
  //     checked mutual coherence. Corrupting ONLY `after_json` from a valid 30-day
  //     policy to a valid 90-day policy (leaving before/appliedUpdates/
  //     changedCategories/payloadDigest describing the 30-day mutation) was ACCEPTED
  //     — so a same-key/SAME-payload replay AND the recovery seam served the tampered
  //     90 while the authoritative SQLite policy stayed 30 (fail-OPEN).
  //   P1-B — isValidCategoryRetention did not reject unknown properties, so a
  //     CategoryRetention carrying an EXTRA property decoded fine and EGRESSED
  //     through the owner-facing recovery response.
  //
  // The fix: decodeReceiptRow now validates cross-field coherence AFTER per-field
  // shape validation — after == overlay(before, appliedUpdates) (all 7 categories),
  // changedCategories == the authoritative sorted diff, payloadDigest == the
  // canonical recompute — and isValidCategoryRetention rejects unknown properties.
  // Coherence is INTERNAL to the receipt only (a legitimately STALE receipt still
  // decodes); `null` stays reserved EXCLUSIVELY for genuine absence/expiry.
  // ══════════════════════════════════════════════════════════════════════════

  // (P1-A/1) Corrupt ONLY after_json 30→90 (still individually valid). A same-key
  // SAME-payload replay must fail closed (not serve the tampered 90 via the
  // idempotent-replay path), and recovery must 500 (not return the 90-day receipt).
  // Authoritative policy stays 30; receipt + audit counts stay 1.
  it("(round-9 P1-A/1) corrupt after_json 30→90 → same-key replay 500 + recovery 500 (never the tampered 90); policy stays 30; counts stay 1", async () => {
    const KEY = "coherence-after-tamper-key";
    const routes = makeRoutes(realAppender());
    // 1) Coherent first write: auditLogs → 30.
    await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    );
    expect(receiptRows()).toHaveLength(1);
    expect(auditRows()).toHaveLength(1);
    expect(policyRows(CANON)).toEqual([{ content_category: "auditLogs", after_days: 30 }]);

    // 2) Corrupt ONLY after_json: auditLogs 30 → 90 (a still-individually-valid
    //    policy). before / appliedUpdates / changedCategories / payload_digest all
    //    still describe the 30-day mutation → the receipt is now cross-field INCOHERENT.
    const after = JSON.parse(receiptRows()[0].after_json) as Record<string, unknown>;
    after.auditLogs = { mode: "after_days", days: 90 };
    db.writer
      .prepare("UPDATE retention_recovery_receipts SET after_json = ? WHERE recovery_key_hash = ?")
      .run(JSON.stringify(after), hashRecoveryKey(KEY));

    // (i) Same-key SAME-payload replay: the in-txn idempotency read decodes the
    //     corrupt receipt → fail-closed integrity error (NOT an idempotent replay of
    //     the tampered 90). On base 546ab54f this RESOLVED, serving after=90.
    await expect(
      putRouteOf(routes).handler(
        makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
      ),
    ).rejects.toMatchObject({ ...INTEGRITY, details: { reason: "apply_incoherent" } });

    // (ii) Recovery seam on the same key → 500 (never the tampered 90-day receipt).
    await expect(
      receiptRouteOf(routes).handler(makeCtx({ headers: { "idempotency-key": KEY } })),
    ).rejects.toMatchObject(INTEGRITY);

    // Authoritative policy remains 30; no second receipt/audit row.
    expect(policyRows(CANON)).toEqual([{ content_category: "auditLogs", after_days: 30 }]);
    const get = (await getRouteOf(routes).handler(makeCtx())) as { policy: Record<string, unknown> };
    expect(get.policy.auditLogs).toEqual({ mode: "after_days", days: 30 });
    expect(receiptRows()).toHaveLength(1);
    expect(auditRows()).toHaveLength(1);
  });

  // Seed a coherent receipt (auditLogs→30) under KEY, corrupt ONE field so the row is
  // structurally valid but cross-field INCOHERENT, then recover by the key → the seam
  // must 500 with the expected reason; the authoritative policy + counts stay put.
  async function seedCoherentThenCorruptField(
    KEY: string,
    corrupt: (recoveryKeyHash: string) => void,
    expectedReason: string,
  ): Promise<void> {
    const routes = makeRoutes(realAppender());
    await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    );
    expect(receiptRows()).toHaveLength(1);
    expect(auditRows()).toHaveLength(1);
    expect(policyRows(CANON)).toEqual([{ content_category: "auditLogs", after_days: 30 }]);

    corrupt(hashRecoveryKey(KEY));

    // Recovery on the (structurally valid but incoherent) matching binding → 500 with
    // the exact reason. On base 546ab54f this RESOLVED (returned the tampered receipt).
    await expect(
      receiptRouteOf(routes).handler(makeCtx({ headers: { "idempotency-key": KEY } })),
    ).rejects.toMatchObject({ ...INTEGRITY, details: { reason: expectedReason } });

    // Authoritative policy + durable counts untouched by the failed decode.
    expect(policyRows(CANON)).toEqual([{ content_category: "auditLogs", after_days: 30 }]);
    expect(receiptRows()).toHaveLength(1);
    expect(auditRows()).toHaveLength(1);
  }

  // (P1-A/2 — changed_categories) each isolated corruption → changed_categories_incoherent.
  const changedCategoryCorruptions: Array<[string, (h: string) => void]> = [
    [
      "extra (bogus-but-canonical) category",
      (h) =>
        db.writer
          .prepare("UPDATE retention_recovery_receipts SET changed_categories_json = ? WHERE recovery_key_hash = ?")
          .run(JSON.stringify(["agentRuns", "auditLogs"]), h), // agentRuns did not change
    ],
    [
      "dropped category (empty)",
      (h) =>
        db.writer
          .prepare("UPDATE retention_recovery_receipts SET changed_categories_json = ? WHERE recovery_key_hash = ?")
          .run(JSON.stringify([]), h),
    ],
    [
      "duplicated category",
      (h) =>
        db.writer
          .prepare("UPDATE retention_recovery_receipts SET changed_categories_json = ? WHERE recovery_key_hash = ?")
          .run(JSON.stringify(["auditLogs", "auditLogs"]), h),
    ],
  ];
  it.each(changedCategoryCorruptions)(
    "(round-9 P1-A/2 changed_categories) [%s] → recovery 500 changed_categories_incoherent; authoritative unchanged; counts 1",
    async (label, corrupt) => {
      await seedCoherentThenCorruptField(`changed-${label}`, corrupt, "changed_categories_incoherent");
    },
  );

  // (P1-A/2 — changed_categories WRONG ORDER) a two-category write's changedCategories
  // is the SORTED authoritative diff; an unsorted stored array is rejected.
  it("(round-9 P1-A/2 changed_categories) UNSORTED stored order → recovery 500 changed_categories_incoherent", async () => {
    const KEY = "changed-unsorted-key";
    const routes = makeRoutes(realAppender());
    // A two-category write: changed = ["agentRuns","auditLogs"] (sorted).
    await putRouteOf(routes).handler(
      makeCtx({
        headers: { "idempotency-key": KEY },
        body: { policy: { auditLogs: { mode: "after_days", days: 30 }, agentRuns: { mode: "after_days", days: 60 } } },
      }),
    );
    expect(JSON.parse(receiptRows()[0].changed_categories_json)).toEqual(["agentRuns", "auditLogs"]);
    // Store the SAME set but unsorted → element-by-element mismatch vs the sorted diff.
    db.writer
      .prepare("UPDATE retention_recovery_receipts SET changed_categories_json = ? WHERE recovery_key_hash = ?")
      .run(JSON.stringify(["auditLogs", "agentRuns"]), hashRecoveryKey(KEY));
    await expect(
      receiptRouteOf(routes).handler(makeCtx({ headers: { "idempotency-key": KEY } })),
    ).rejects.toMatchObject({ ...INTEGRITY, details: { reason: "changed_categories_incoherent" } });
  });

  // (P1-A/2 — payload_digest) a bogus digest AND a NULL digest → digest_mismatch.
  it("(round-9 P1-A/2 payload_digest) a WRONG digest → recovery 500 digest_mismatch", async () => {
    await seedCoherentThenCorruptField(
      "digest-wrong-key",
      (h) =>
        db.writer
          .prepare("UPDATE retention_recovery_receipts SET payload_digest = ? WHERE recovery_key_hash = ?")
          .run("deadbeef".repeat(8), h),
      "digest_mismatch",
    );
  });
  it("(round-9 P1-A/2 payload_digest) a NULL digest (write path ALWAYS sets it) → recovery 500 digest_mismatch", async () => {
    await seedCoherentThenCorruptField(
      "digest-null-key",
      (h) =>
        db.writer
          .prepare("UPDATE retention_recovery_receipts SET payload_digest = NULL WHERE recovery_key_hash = ?")
          .run(h),
      "digest_mismatch",
    );
  });

  // (P1-A/2 — applied_updates) overlay(before, applied) ≠ after → apply_incoherent.
  it("(round-9 P1-A/2 applied_updates) applied changed so overlay(before,applied) ≠ after → recovery 500 apply_incoherent", async () => {
    await seedCoherentThenCorruptField(
      "applied-incoherent-key",
      (h) =>
        db.writer
          .prepare("UPDATE retention_recovery_receipts SET applied_updates_json = ? WHERE recovery_key_hash = ?")
          // still a valid appliedUpdates map, but overlay(allPermanent,{auditLogs:90})
          // = {auditLogs:90} ≠ the stored after {auditLogs:30}.
          .run(JSON.stringify({ auditLogs: { mode: "after_days", days: 90 } }), h),
      "apply_incoherent",
    );
  });

  // (P1-B) a CategoryRetention carrying an EXTRA property is rejected by decode, and
  // the leaked property NEVER egresses through the owner-facing recovery response.
  it("(round-9 P1-B) after.auditLogs carries an EXTRA property → recovery 500 (invalid_after) AND 'leaked' never egresses", async () => {
    const KEY = "extra-prop-after-key";
    const routes = makeRoutes(realAppender());
    await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    );
    const after = JSON.parse(receiptRows()[0].after_json) as Record<string, unknown>;
    after.auditLogs = { mode: "after_days", days: 30, leaked: "x" };
    db.writer
      .prepare("UPDATE retention_recovery_receipts SET after_json = ? WHERE recovery_key_hash = ?")
      .run(JSON.stringify(after), hashRecoveryKey(KEY));

    let resolved: unknown;
    let threw = false;
    try {
      resolved = await receiptRouteOf(routes).handler(makeCtx({ headers: { "idempotency-key": KEY } }));
    } catch (e) {
      threw = true;
      expect(e).toMatchObject({ ...INTEGRITY, details: { reason: "invalid_after" } });
    }
    // Post-fix: decode fails closed (threw). On base it RESOLVED and egressed 'leaked'.
    expect(threw).toBe(true);
    // Belt-and-suspenders: nothing the seam returned ever carries the leaked property.
    expect(JSON.stringify(resolved ?? "")).not.toContain("leaked");
  });
  it("(round-9 P1-B) appliedUpdates.auditLogs carries an EXTRA property → recovery 500 (invalid_applied_updates)", async () => {
    await seedCoherentThenCorruptField(
      "extra-prop-applied-key",
      (h) =>
        db.writer
          .prepare("UPDATE retention_recovery_receipts SET applied_updates_json = ? WHERE recovery_key_hash = ?")
          .run(JSON.stringify({ auditLogs: { mode: "after_days", days: 30, leaked: "y" } }), h),
      "invalid_applied_updates",
    );
  });

  // ── ROUND-9 GREEN over-fail-close controls: coherence is INTERNAL-only; it must
  //    NEVER fail a legitimate receipt (a fresh write, a stale receipt, an empty
  //    update) and must never break genuine idempotency/absence. These prove the
  //    overlay oracle matches the REAL store (load-bearing). ─────────────────────

  it("(round-9 green) a normal write decodes its OWN receipt with coherence PASSING (no over-fail-close)", async () => {
    const KEY = "coherent-normal-key";
    const routes = makeRoutes(realAppender());
    const put = (await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };
    const rec = (await receiptRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt | null };
    expect(rec.receipt).not.toBeNull();
    expect(rec.receipt!.receiptId).toBe(put.receipt.receiptId);
    expect(rec.receipt!.evidence.after.auditLogs).toEqual({ mode: "after_days", days: 30 });
  });

  it("(round-9 green) empty-update policy:{} write → coherent receipt decodes (overlay of a no-op == before == after)", async () => {
    const KEY = "coherent-empty-key";
    const routes = makeRoutes(realAppender());
    const put = (await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: {} } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };
    expect(put.receipt.evidence.changed).toEqual([]);
    const rec = (await receiptRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt | null };
    expect(rec.receipt).not.toBeNull();
    expect(rec.receipt!.receiptId).toBe(put.receipt.receiptId);
  });

  it("(round-9 green) a later DIFFERENT-key write moves the policy — decoding the EARLIER (now-stale) receipt still PASSES coherence (internal-only, never vs current policy)", async () => {
    const routes = makeRoutes(realAppender());
    const KEY_A = "stale-A-key";
    const KEY_B = "stale-B-key";
    const a = (await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY_A }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };
    // A DIFFERENT key later changes auditLogs 30 → 90 (the current policy moves on).
    await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY_B }, body: { policy: { auditLogs: { mode: "after_days", days: 90 } } } }),
    );
    expect(policyRows(CANON)).toEqual([{ content_category: "auditLogs", after_days: 90 }]);
    // Recovering A's receipt still SUCCEEDS and returns A's OWN historical after (30),
    // NOT the now-current 90 — coherence never compares against the current policy.
    const recA = (await receiptRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY_A } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt | null };
    expect(recA.receipt).not.toBeNull();
    expect(recA.receipt!.receiptId).toBe(a.receipt.receiptId);
    expect(recA.receipt!.evidence.after.auditLogs).toEqual({ mode: "after_days", days: 30 });
  });

  it("(round-9 green) same-key/same-payload idempotent replay still works; same-key/different-payload → 409 (coherence never breaks genuine idempotency)", async () => {
    const routes = makeRoutes(realAppender());
    const KEY = "idem-green-key";
    const first = (await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };
    const replay = (await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };
    expect(replay.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(auditRows()).toHaveLength(1);
    await expect(
      putRouteOf(routes).handler(
        makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 90 } } } }),
      ),
    ).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("(round-9 green) a genuinely-absent key → recovery null AND a fresh PUT applies (coherence never over-fails a new write)", async () => {
    const routes = makeRoutes(realAppender());
    const miss = (await receiptRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": "round9-absent-key" } }),
    )) as { receipt: unknown };
    expect(miss.receipt).toBeNull();
    const put = (await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": "round9-fresh-key" }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };
    expect(put.receipt.status).toBe("applied");
    expect(receiptRows()).toHaveLength(1);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // RETENTION-R3d ROUND-10 — ONE canonical WHOLE-ROW invariant (P1 fail-OPEN fix).
  //
  // Finding (fresh Advisor audit, NO-LOOP): round-9 validated the JSON columns +
  // digest coherence but returned the SCALAR columns (receipt_id, principal_id,
  // tenant_id, correlation_id, audit_id, recovery_key_hash, created_at) UNVALIDATED
  // and never cross-checked the row against its authentic-audit anchor. Two confirmed
  // fail-opens:
  //   Probe-1 (timestamp → retention EVASION): a receipt with `created_at="zzzz"`
  //     sorts AFTER any ISO cutoff, so the finite auditLogs sweep returned
  //     deletedRetentionReceipts=0 and the row SURVIVED the window the user opted
  //     into (DATA-RETENTION-001 truthfulness break).
  //   Probe-2 (linkage corruption SERVED): a one-sided `correlation_id`/`audit_id`
  //     tamper decoded unvalidated and was served as a valid correlated receipt.
  //
  // The fix: ONE canonical validator (`assertReceiptRowIntegrity`) enforces the
  // whole-row invariant at write + read/decode; the reaper enforces the SAME
  // canonical `created_at` shape (shared GLOB) at storage (v108 CHECK) and reap; the
  // finite sweep QUARANTINE-deletes un-datable rows and surfaces a typed incident;
  // and every served receipt is cross-checked against its `security_audit_log`
  // anchor. RED on base 55553fc8, GREEN here.
  // ══════════════════════════════════════════════════════════════════════════

  // Inject a NON-canonical created_at, bypassing the v108 storage CHECK via
  // `ignore_check_constraints` — simulating a row that entered before the guard
  // existed (a v107-era upgrade) or via a raw sqlite-file edit that bypasses
  // engine-enforced constraints. On base (no v108) the PRAGMA is a harmless no-op.
  function forceCreatedAt(recoveryKeyHash: string, value: string): void {
    db.writer.pragma("ignore_check_constraints = ON");
    try {
      db.writer
        .prepare("UPDATE retention_recovery_receipts SET created_at = ? WHERE recovery_key_hash = ?")
        .run(value, recoveryKeyHash);
    } finally {
      db.writer.pragma("ignore_check_constraints = OFF");
    }
  }

  // ── PROBE-1: timestamp → retention evasion, closed at the REAPER (quarantine) ──
  it("(round-10 Probe-1) created_at='zzzz' under FINITE 30d auditLogs → reaper QUARANTINE-deletes it + surfaces the incident counter; it does NOT survive", async () => {
    const KEY = "probe1-zzzz-key";
    const routes = makeRoutesAt(AGED);
    await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    );
    expect(receiptRows()).toHaveLength(1);
    // Tamper: 'zzzz' sorts AFTER any ISO cutoff → a string-compare sweep would retain it.
    forceCreatedAt(hashRecoveryKey(KEY), "zzzz");
    expect(receiptRows()[0].created_at).toBe("zzzz");

    const result = reaperForOwner().run(NOW);

    // HEAD: the un-datable row is QUARANTINED (typed incident counter) and gone. On
    // base 55553fc8 quarantinedIntegrityReceipts is undefined and the row survives.
    expect(result.quarantinedIntegrityReceipts).toBe(1);
    expect(result.deletedRetentionReceipts).toBe(0); // it was quarantined, not date-expired
    expect(receiptRows()).toHaveLength(0);
  });

  // A canonical AGED receipt (normal-expired) ALONGSIDE a 'zzzz' receipt (quarantined)
  // in the SAME finite sweep — the quarantine never blocks reaping valid rows.
  it("(round-10 Probe-1) mixed sweep: a datable aged row is date-expired AND a 'zzzz' row is quarantined — both gone, neither blocks the other", async () => {
    const KEY_OK = "probe1-mixed-ok"; // canonical aged → normal expiry
    const KEY_BAD = "probe1-mixed-bad"; // 'zzzz' → quarantine
    const routes = makeRoutesAt(AGED);
    await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY_OK }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    );
    await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY_BAD }, body: { policy: { agentRuns: { mode: "after_days", days: 60 } } } }),
    );
    expect(receiptRows()).toHaveLength(2);
    forceCreatedAt(hashRecoveryKey(KEY_BAD), "zzzz");

    const result = reaperForOwner().run(NOW);
    expect(result.deletedRetentionReceipts).toBe(1); // the canonical aged row
    expect(result.quarantinedIntegrityReceipts).toBe(1); // the 'zzzz' row
    expect(receiptRows()).toHaveLength(0);
  });

  // ── STORAGE boundary: the v108 CHECK blocks a direct-DB created_at tamper ──────
  it("(round-10 storage) the v108 CHECK rejects a direct-DB created_at tamper at the storage boundary (engine-enforced on UPDATE)", async () => {
    const KEY = "storage-check-key";
    const routes = makeRoutes(realAppender());
    await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    );
    // A plain UPDATE to a non-canonical value is REJECTED by the CHECK (base: no v108,
    // so this does NOT throw — a RED-on-base discriminator for the storage boundary).
    expect(() =>
      db.writer
        .prepare("UPDATE retention_recovery_receipts SET created_at = 'zzzz' WHERE recovery_key_hash = ?")
        .run(hashRecoveryKey(KEY)),
    ).toThrow(/CHECK/i);
    // The tamper never landed — the row is still canonical.
    expect(receiptRows()[0].created_at).toBe(NOW);
  });

  // ── PROBE-2: one-sided linkage corruption is never SERVED (anchor cross-check) ─
  it("(round-10 Probe-2/audit) a tampered audit_id (no such anchor) → recovery 500 anchor_absent; never served", async () => {
    const KEY = "probe2-audit-absent-key";
    const routes = makeRoutes(realAppender());
    await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    );
    db.writer
      .prepare("UPDATE retention_recovery_receipts SET audit_id = 'aud-does-not-exist' WHERE recovery_key_hash = ?")
      .run(hashRecoveryKey(KEY));
    await expect(
      receiptRouteOf(routes).handler(makeCtx({ headers: { "idempotency-key": KEY } })),
    ).rejects.toMatchObject({ ...INTEGRITY, details: { reason: "anchor_absent" } });
  });

  it("(round-10 Probe-2/audit) audit_id repointed to a DIFFERENT live anchor → recovery 500 anchor_mismatch:receiptId", async () => {
    const routes = makeRoutes(realAppender());
    const KEY1 = "probe2-mismatch-1";
    const KEY2 = "probe2-mismatch-2";
    await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY1 }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    );
    const w2 = (await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY2 }, body: { policy: { agentRuns: { mode: "after_days", days: 60 } } } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };
    // Repoint receipt-1's audit_id at receipt-2's anchor: the anchor EXISTS but its
    // metadata.receiptId is receipt-2's, so the cross-store check fails closed.
    db.writer
      .prepare("UPDATE retention_recovery_receipts SET audit_id = ? WHERE recovery_key_hash = ?")
      .run(w2.receipt.auditId, hashRecoveryKey(KEY1));
    await expect(
      receiptRouteOf(routes).handler(makeCtx({ headers: { "idempotency-key": KEY1 } })),
    ).rejects.toMatchObject({ ...INTEGRITY, details: { reason: "anchor_mismatch:receiptId" } });
  });

  // ── TABLE-DRIVEN mutation matrix: EVERY scalar column mutated at the recovery
  //    seam → typed 500 fail-closed, policy byte-unchanged, counts stay 1. Reuses
  //    `seedCoherentThenCorruptField` (seeds auditLogs→30, corrupts one column,
  //    recovers, asserts the exact reason + authoritative state untouched). Each
  //    case is RED on base 55553fc8 (which served the tampered scalar) and GREEN here.
  const scalarColumnMutations: Array<[string, (h: string) => void, string]> = [
    [
      "receipt_id empty",
      (h) => db.writer.prepare("UPDATE retention_recovery_receipts SET receipt_id = '' WHERE recovery_key_hash = ?").run(h),
      "invalid_receipt_id",
    ],
    [
      "receipt_id wrong prefix",
      (h) => db.writer.prepare("UPDATE retention_recovery_receipts SET receipt_id = ? WHERE recovery_key_hash = ?").run(`bogus:${CANON}:op-1`, h),
      "invalid_receipt_id",
    ],
    [
      "receipt_id wrong principal segment",
      (h) => db.writer.prepare("UPDATE retention_recovery_receipts SET receipt_id = ? WHERE recovery_key_hash = ?").run("retention-receipt:someone-else:op-1", h),
      "invalid_receipt_id",
    ],
    [
      "correlation_id wrong prefix",
      (h) => db.writer.prepare("UPDATE retention_recovery_receipts SET correlation_id = 'corr:x' WHERE recovery_key_hash = ?").run(h),
      "invalid_correlation_id",
    ],
    [
      "correlation_id operation id diverges from receipt_id",
      (h) => db.writer.prepare("UPDATE retention_recovery_receipts SET correlation_id = ? WHERE recovery_key_hash = ?").run(`retention-policy-update:${CANON}:op-OTHER`, h),
      "linkage_operation_mismatch",
    ],
    [
      "tenant_id empty string (neither null nor non-empty)",
      (h) => db.writer.prepare("UPDATE retention_recovery_receipts SET tenant_id = '' WHERE recovery_key_hash = ?").run(h),
      "invalid_tenant_id",
    ],
    [
      "tenant_id diverges from the anchor",
      (h) => db.writer.prepare("UPDATE retention_recovery_receipts SET tenant_id = 'other-tenant' WHERE recovery_key_hash = ?").run(h),
      "anchor_mismatch:tenantId",
    ],
    [
      "audit_id empty",
      (h) => db.writer.prepare("UPDATE retention_recovery_receipts SET audit_id = '' WHERE recovery_key_hash = ?").run(h),
      "invalid_audit_id",
    ],
    [
      "created_at 'zzzz' (non-canonical, served-path)",
      (h) => forceCreatedAt(h, "zzzz"),
      "invalid_created_at",
    ],
    [
      "created_at impossible 9999-99-99 (shape-passing junk)",
      (h) => forceCreatedAt(h, "9999-99-99T99:99:99.999Z"),
      "invalid_created_at",
    ],
    [
      "created_at non-Z offset (does not round-trip)",
      (h) => forceCreatedAt(h, "2026-07-16T10:00:00.000+00:00"),
      "invalid_created_at",
    ],
  ];
  it.each(scalarColumnMutations)(
    "(round-10 matrix) scalar column [%s] mutated → recovery 500 fail-closed; authoritative policy unchanged; counts stay 1",
    async (label, corrupt, reason) => {
      await seedCoherentThenCorruptField(`matrix-${label}`, corrupt, reason);
    },
  );

  // recovery_key_hash — the recovery lookup matches by this exact value, so a route
  // seam cannot exercise a non-hex hash (it hashes the header). Prove it directly at
  // the repository: a seeded (non-hex-hash) row with a matching anchor fails closed
  // on lookup by that same value — never returns a corrupt binding as valid.
  it("(round-10 matrix) recovery_key_hash non-hex → repository decode 500 invalid_recovery_key_hash (never served)", () => {
    const repo = createFridayRetentionReceiptRepository();
    const BAD_HASH = "not-a-64-char-lowercase-hex-value"; // pragma: allowlist secret (test fixture)
    const opId = "op-badhash";
    const receiptId = `retention-receipt:${CANON}:${opId}`;
    const correlationId = `retention-policy-update:${CANON}:${opId}`;
    const auditId = `aud-${opId}`;
    const digest = hashIdempotencyPayload({ auditLogs: { mode: "after_days", days: 30 } });
    // Seed the matching anchor so ONLY the recovery_key_hash is out of shape.
    db.writer
      .prepare(
        `INSERT INTO security_audit_log
           (id, tenant_id, principal_id, action, resource_type, resource_id,
            decision, reason, session_id, metadata_json, created_at)
         VALUES (?, NULL, ?, 'retention.policy.update', 'policy', ?, 'allow', 'seed', ?, ?, ?)`,
      )
      .run(
        auditId,
        CANON,
        `retention-policy:${CANON}`,
        correlationId,
        JSON.stringify({ receiptId, correlationId, payloadDigest: digest }),
        NOW,
      );
    // Insert the row DIRECTLY (bypassing the validating repo.insert) with a non-hex
    // recovery_key_hash — the exact value the lookup will match on.
    const fullPolicy = {
      learningEvents: { mode: "permanent" },
      heartbeats: { mode: "permanent" },
      skillRunTerminal: { mode: "permanent" },
      auditLogs: { mode: "permanent" },
      agentRuns: { mode: "permanent" },
      llmUsageRecords: { mode: "permanent" },
      errorIncidents: { mode: "permanent" },
    };
    const afterPolicy = { ...fullPolicy, auditLogs: { mode: "after_days", days: 30 } };
    db.writer
      .prepare(
        `INSERT INTO retention_recovery_receipts
           (receipt_id, principal_id, tenant_id, correlation_id, audit_id,
            recovery_key_hash, payload_digest, before_json, after_json,
            changed_categories_json, applied_updates_json, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receiptId,
        CANON,
        correlationId,
        auditId,
        BAD_HASH,
        digest,
        JSON.stringify(fullPolicy),
        JSON.stringify(afterPolicy),
        JSON.stringify(["auditLogs"]),
        JSON.stringify({ auditLogs: { mode: "after_days", days: 30 } }),
        NOW,
      );
    expect(() =>
      db.withReadConnection((conn) =>
        repo.findOldestByRecoveryKey(conn, { ownerId: CANON, recoveryKeyHash: BAD_HASH }),
      ),
    ).toThrow(
      expect.objectContaining({ code: "RETENTION_RECEIPT_INTEGRITY_FAILURE", details: expect.objectContaining({ reason: "invalid_recovery_key_hash" }) }),
    );
  });

  // ── GREEN over-fail-close controls (load-bearing) ─────────────────────────────

  it("(round-10 green) a normal write's receipt cross-checks CLEAN against its live anchor (no over-fail-close)", async () => {
    const KEY = "round10-clean-key";
    const routes = makeRoutes(realAppender());
    const put = (await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };
    const rec = (await receiptRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt | null };
    expect(rec.receipt?.receiptId).toBe(put.receipt.receiptId);
    // The anchor the cross-check validated against is the live audit row.
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0].id).toBe(put.receipt.auditId);
  });

  it("(round-10 green) OVER-FAIL-CLOSE COUPLING: a finite sweep removes the RECEIPT and LEAVES its permanent anchor (anchor outlives receipt); recovery is then null (absence), never an anchor 500", async () => {
    const KEY = "round10-couple-key";
    const routes = makeRoutesAt(AGED);
    const put = (await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };
    expect(receiptRows()).toHaveLength(1);
    expect(auditRows()).toHaveLength(1);

    const result = reaperForOwner().run(NOW);
    expect(result.deletedRetentionReceipts).toBe(1); // datable → normal expiry
    expect(result.quarantinedIntegrityReceipts).toBe(0); // nothing un-datable
    expect(receiptRows()).toHaveLength(0); // receipt gone
    // The content-minimized anchor is permanent (no reaper/Delete-All deletes
    // security_audit_log) — so a LIVE receipt ALWAYS had a live anchor; the sweep
    // never produces a live-receipt-without-anchor state.
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0].id).toBe(put.receipt.auditId);

    // Recovery after the sweep → null (GENUINE absence), NOT an anchor-driven 500.
    const rec = (await receiptRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY } }),
    )) as { receipt: unknown };
    expect(rec.receipt).toBeNull();
  });

  it("(round-10 green) default-permanent sweep deletes 0 AND quarantines 0 even for a non-canonical row (fail-closed default-permanent preserved; un-datable row RETAINED, never served)", async () => {
    const KEY = "round10-permanent-key";
    const routes = makeRoutesAt(AGED);
    // auditLogs stays PERMANENT (learningEvents opted finite) → the receipt store is
    // governed by auditLogs only, so nothing is swept/quarantined.
    await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { learningEvents: { mode: "after_days", days: 30 } } } }),
    );
    forceCreatedAt(hashRecoveryKey(KEY), "zzzz");

    const result = reaperForOwner().run(NOW);
    expect(result.deletedRetentionReceipts).toBe(0);
    expect(result.quarantinedIntegrityReceipts).toBe(0);
    expect(receiptRows()).toHaveLength(1); // un-datable row is retained under permanent
    // ...but it can never be SERVED: the read path fails closed on the non-canonical
    // created_at (invalid_created_at).
    await expect(
      receiptRouteOf(routes).handler(makeCtx({ headers: { "idempotency-key": KEY } })),
    ).rejects.toMatchObject({ ...INTEGRITY, details: { reason: "invalid_created_at" } });
  });

  // ── ROUND-10b: shaped-but-IMPOSSIBLE created_at (GLOB-passing, calendar-invalid).
  //    The coarse shape GLOB accepts `2026-19-39T29:59:59.000Z` (month 19, day 39,
  //    hour 29) — it has no calendar semantics — so a `NOT GLOB` quarantine would
  //    MISS it and (sorting after any ISO cutoff) it would silently SURVIVE a finite
  //    sweep. The quarantine now uses the STRICT round-trip gate, which rejects it.
  it("(round-10b Probe-1) a shaped-but-IMPOSSIBLE created_at (2026-19-39…, GLOB-passing) under FINITE 30d → reaper QUARANTINE-deletes it (strict gate); it does NOT survive", async () => {
    const KEY = "probe1b-impossible-key";
    const IMPOSSIBLE = "2026-19-39T29:59:59.000Z"; // month 19 / day 39 / hour 29
    const routes = makeRoutesAt(AGED);
    await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    );
    expect(receiptRows()).toHaveLength(1);
    // The v108 CHECK ACCEPTS the impossible value (GLOB is shape-only) → a PLAIN
    // UPDATE succeeds; no CHECK bypass needed. This is the crux of the gap.
    expect(() =>
      db.writer
        .prepare("UPDATE retention_recovery_receipts SET created_at = ? WHERE recovery_key_hash = ?")
        .run(IMPOSSIBLE, hashRecoveryKey(KEY)),
    ).not.toThrow();
    expect(receiptRows()[0].created_at).toBe(IMPOSSIBLE);

    const result = reaperForOwner().run(NOW);
    // HEAD (strict quarantine): counted + gone. On base 0a9b9107 (coarse NOT GLOB):
    // quarantinedIntegrityReceipts=0 AND deletedRetentionReceipts=0 → the row SURVIVES.
    expect(result.quarantinedIntegrityReceipts).toBe(1);
    expect(result.deletedRetentionReceipts).toBe(0);
    expect(receiptRows()).toHaveLength(0);

    // Unchanged: the read/recovery path already 500s on it (strict round-trip).
    // (Re-seed is not needed — assert the strict gate directly on the value.)
  });

  it("(round-10b Probe-1) the read/recovery path already 500s on the impossible created_at (invalid_created_at) — unchanged", async () => {
    const KEY = "probe1b-impossible-read-key";
    const routes = makeRoutes(realAppender());
    await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    );
    db.writer
      .prepare("UPDATE retention_recovery_receipts SET created_at = '2026-19-39T29:59:59.000Z' WHERE recovery_key_hash = ?")
      .run(hashRecoveryKey(KEY));
    await expect(
      receiptRouteOf(routes).handler(makeCtx({ headers: { "idempotency-key": KEY } })),
    ).rejects.toMatchObject({ ...INTEGRITY, details: { reason: "invalid_created_at" } });
  });

  // Green over-fail-close: a CANONICAL not-yet-expired receipt (created_at=now) is
  // NEVER quarantined (it round-trips) and is NOT date-expired; a CANONICAL expired
  // receipt (created_at=aged) is deleted via `deleteExpiredBefore`, NOT the quarantine.
  it("(round-10b green) canonical not-yet-expired row survives (never quarantined); a canonical aged row is date-expired — quarantine touches neither", async () => {
    const KEY_NEW = "round10b-canon-new";
    const KEY_OLD = "round10b-canon-old";
    // A not-yet-expired receipt committed at NOW (> NOW-30d cutoff), and an aged one.
    const nowRoutes = makeRoutes(realAppender()); // clock = NOW
    await putRouteOf(nowRoutes).handler(
      makeCtx({ headers: { "idempotency-key": KEY_NEW }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    );
    const agedRoutes = makeRoutesAt(AGED);
    await putRouteOf(agedRoutes).handler(
      makeCtx({ headers: { "idempotency-key": KEY_OLD }, body: { policy: { agentRuns: { mode: "after_days", days: 60 } } } }),
    );
    expect(receiptRows()).toHaveLength(2);

    const result = reaperForOwner().run(NOW);
    expect(result.quarantinedIntegrityReceipts).toBe(0); // both are canonical → none quarantined
    expect(result.deletedRetentionReceipts).toBe(1); // only the aged (canonical, < cutoff) row
    // The canonical not-yet-expired receipt SURVIVES correctly (no over-fail-close).
    const survivors = receiptRows();
    expect(survivors).toHaveLength(1);
    expect(survivors[0].created_at).toBe(NOW);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // RETENTION-R3d ROUND-10c — anchor TIMESTAMP cross-check (required_action #3
  // closure) + FUTURE-dated reaper quarantine.
  //
  //   Fix #1 (READ path): the anchor cross-check now also verifies the anchor's own
  //     `created_at` == the receipt's `created_at` (both stamped from the SAME
  //     write-path `runAt` — byte-equal on a legit write, empirically verified). A
  //     raw-DB `created_at` tamper to a DIFFERENT canonical value was previously
  //     SERVED through recovery with the wrong timestamp; it now fails closed.
  //   Fix #2 (REAP path): a FUTURE-dated canonical `created_at` passes the v108 GLOB +
  //     round-trip yet sorts after any cutoff, so a finite sweep never reaped it. The
  //     quarantine handles it via an ANCHOR-COMPARISON model (see round-11 below):
  //     future + anchor MISMATCH → quarantine; future + anchor MATCHES (legit clock
  //     skew) → PRESERVE + flag. NB: the blind `created_at > nowIso ⇒ delete` rule
  //     this once used was itself an over-fail-close (a BACKWARD clock destroyed legit
  //     data) — closed in round-11; the test below is now the anchor-MISMATCH case.
  // ══════════════════════════════════════════════════════════════════════════

  // Fix #1 — RED-first: tamper ONLY the receipt's created_at (anchor untouched).
  it("(round-10c Fix#1) receipt created_at tampered to a DIFFERENT canonical value (anchor unchanged) → recovery 500 anchor_mismatch:createdAt (was served with the wrong date pre-fix)", async () => {
    const KEY = "round10c-createdat-tamper-key";
    const routes = makeRoutes(realAppender());
    await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    );
    // Both receipt + anchor were stamped from NOW. Tamper ONLY the receipt's
    // created_at to a DIFFERENT canonical value — the v108 CHECK accepts it (canonical),
    // and the scalar `isCanonicalReceiptCreatedAt` gate passes → only the anchor
    // cross-check can catch it.
    expect(() =>
      db.writer
        .prepare("UPDATE retention_recovery_receipts SET created_at = '2026-01-01T00:00:00.000Z' WHERE recovery_key_hash = ?")
        .run(hashRecoveryKey(KEY)),
    ).not.toThrow();
    await expect(
      receiptRouteOf(routes).handler(makeCtx({ headers: { "idempotency-key": KEY } })),
    ).rejects.toMatchObject({ ...INTEGRITY, details: { reason: "anchor_mismatch:createdAt" } });
  });

  // Fix #1 — GREEN over-fail-close: a NORMAL write recovers clean through the anchor
  // created_at cross-check (single-tenant AND multi-tenant), returning the AUTHENTIC
  // timestamp. This is the catastrophic-risk control — a false mismatch here would
  // 500 every recovery/replay.
  it("(round-10c Fix#1 green) a normal write recovers CLEAN through the anchor created_at cross-check (single + multi-tenant); authentic runAt returned", async () => {
    for (const [label, principal] of [
      ["single", owner(CANON)],
      ["multi", ownerWithTenant(CANON, "admin-001")],
    ] as const) {
      const KEY = `round10c-clean-${label}`;
      const routes = makeRoutes(realAppender());
      const put = (await putRouteOf(routes).handler(
        makeCtx({ principal, headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
      )) as { receipt: FridayRetentionPolicyUpdateReceipt };
      const rec = (await receiptRouteOf(routes).handler(
        makeCtx({ principal, headers: { "idempotency-key": KEY } }),
      )) as { receipt: FridayRetentionPolicyUpdateReceipt | null };
      expect(rec.receipt?.receiptId).toBe(put.receipt.receiptId);
      expect(rec.receipt?.runAt).toBe(NOW); // authentic (untampered) timestamp
    }
  });

  // Fix #2 — ONE-SIDED future corruption (anchor MISMATCH): only the receipt's
  // created_at is tampered to a far-future canonical value; its anchor's created_at is
  // UNCHANGED (AGED) → the two DISAGREE → this is corruption, not clock skew →
  // quarantine. Contrast with round-11a (future + anchor AGREES → PRESERVE): together
  // they prove the decision is ANCHOR-BASED, not blind `> now`. A legit NOW-dated row
  // in the same sweep survives (no over-fail-close).
  it("(round-10c Fix#2) a FUTURE-dated receipt whose anchor DISAGREES (one-sided corruption) under FINITE 30d → reaper QUARANTINE-deletes it; a NOW-dated row survives", async () => {
    const KEY_FUTURE = "round10c-future-key";
    const KEY_NOW = "round10c-now-key";
    const agedRoutes = makeRoutesAt(AGED); // receipt + anchor both stamped AGED
    await putRouteOf(agedRoutes).handler(
      makeCtx({ headers: { "idempotency-key": KEY_FUTURE }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    );
    const nowRoutes = makeRoutes(realAppender()); // clock = NOW
    await putRouteOf(nowRoutes).handler(
      makeCtx({ headers: { "idempotency-key": KEY_NOW }, body: { policy: { agentRuns: { mode: "after_days", days: 60 } } } }),
    );
    // Tamper ONLY the receipt's created_at to a far-future canonical value (the v108
    // CHECK accepts it — valid ISO shape). The anchor stays at AGED → they DISAGREE.
    expect(() =>
      db.writer
        .prepare("UPDATE retention_recovery_receipts SET created_at = '9999-12-31T23:59:59.000Z' WHERE recovery_key_hash = ?")
        .run(hashRecoveryKey(KEY_FUTURE)),
    ).not.toThrow();

    const result = reaperForOwner().run(NOW);
    // Future + anchor MISMATCH → quarantined (NOT preserved). It is corruption, not
    // clock skew, so clockAnomalyRetentionReceipts stays 0.
    expect(result.quarantinedIntegrityReceipts).toBe(1);
    expect(result.clockAnomalyRetentionReceipts).toBe(0);
    expect(result.deletedRetentionReceipts).toBe(0);
    // The legit NOW-dated receipt is NEVER quarantined (== now, not > now) → survives.
    const survivors = receiptRows();
    expect(survivors).toHaveLength(1);
    expect(survivors[0].created_at).toBe(NOW);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // RETENTION-R3d ROUND-11 — clock-regression-safe reaper (anchor-comparison, NOT a
  // blind `> now`) + full audit-anchor SEMANTIC-ENVELOPE invariant. Two BLOCKED P1s:
  //
  //   P1 #1 (temporal over-fail-close): the old quarantine deleted ANY row with
  //     `created_at > nowIso`. A receipt written at a real instant, then a BACKWARD
  //     wall-clock jump (NTP correction / rolled-back restart), makes that instant
  //     "future" → the row was DELETED = legitimate user data destroyed by a clock
  //     rollback (DATA-RETENTION-001 / U9 violation). Fix: for a future-relative row,
  //     compare against the audit anchor's own created_at — MATCH ⇒ PRESERVE + flag
  //     (clockAnomalyRetentionReceipts); MISMATCH ⇒ quarantine; ABSENT ⇒ preserve.
  //   P1 #2 (anchor semantic gap): the anchor cross-check omitted the audit record's
  //     SEMANTIC ENVELOPE, so `audit_id` could point at an anchor whose action was
  //     retargeted (e.g. `unrelated.action`) and the receipt was STILL served. Fix:
  //     the cross-check now also asserts action/resource_type/resource_id/decision/
  //     session_id/reason against the canonical write-path values.
  //
  // RED on HEAD 2c97932f (backward clock deletes the legit row; retargeted anchors are
  // served), GREEN here. Envelope constants empirically confirmed against a real
  // single- AND multi-tenant PUT.
  // ══════════════════════════════════════════════════════════════════════════

  // ── P1 #1 — clock-regression PRESERVATION (the core RED) ──────────────────────
  it("(round-11a) backward wall-clock jump: a valid receipt whose anchor AGREES on created_at is PRESERVED + flagged (clockAnomaly=1), never quarantined; recovery still returns it", async () => {
    const KEY = "round11a-clockskew-key";
    // Write the receipt+anchor at FUTURE (both stamped from the SAME runAt=FUTURE).
    const futureRoutes = makeRoutesAt(FUTURE);
    const put = (await putRouteOf(futureRoutes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };
    expect(receiptRows()).toHaveLength(1);
    expect(receiptRows()[0].created_at).toBe(FUTURE);

    // The reaper runs at NOW (< FUTURE): a BACKWARD wall-clock jump. The row is now
    // "future" relative to now, but the anchor carries the SAME created_at.
    const result = reaperForOwner().run(NOW);

    // PRESERVED (not destroyed) + surfaced as a clock anomaly. On HEAD the blind
    // `> now` rule quarantine-DELETES it (quarantined=1, row gone, no clockAnomaly).
    expect(result.deletedRetentionReceipts).toBe(0);
    expect(result.quarantinedIntegrityReceipts).toBe(0);
    expect(result.clockAnomalyRetentionReceipts).toBe(1);
    expect(receiptRows()).toHaveLength(1);
    expect(receiptRows()[0].created_at).toBe(FUTURE);

    // The legit clock-skewed receipt is still recoverable (anchor created_at agrees).
    const rec = (await receiptRouteOf(futureRoutes).handler(
      makeCtx({ headers: { "idempotency-key": KEY } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt | null };
    expect(rec.receipt?.receiptId).toBe(put.receipt.receiptId);
    expect(rec.receipt?.runAt).toBe(FUTURE);
  });

  // Same preservation, but the recovery happens through a FRESH repo/recovery over the
  // SAME DB (a simulated process restart) — the flag/preserve decision is durable.
  it("(round-11a) clock-skew preservation SURVIVES a simulated restart: fresh recovery over the same DB still returns the preserved receipt", async () => {
    const KEY = "round11a-restart-key";
    const put = (await putRouteOf(makeRoutesAt(FUTURE)).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt };

    const result = reaperForOwner().run(NOW);
    expect(result.clockAnomalyRetentionReceipts).toBe(1);
    expect(receiptRows()).toHaveLength(1);

    // Simulate a restart: brand-new route/recovery instances over the SAME db handle.
    const freshRoutes = makeRoutesAt(FUTURE);
    const rec = (await receiptRouteOf(freshRoutes).handler(
      makeCtx({ headers: { "idempotency-key": KEY } }),
    )) as { receipt: FridayRetentionPolicyUpdateReceipt | null };
    expect(rec.receipt?.receiptId).toBe(put.receipt.receiptId);
  });

  // Fail-closed on uncertainty: a future-relative row whose anchor is ABSENT is
  // PRESERVED (never deleted), and is NOT flagged as a clock anomaly (unconfirmed).
  it("(round-11a) a FUTURE-dated row whose anchor is ABSENT is PRESERVED (fail-closed), not quarantined and not counted as a clock anomaly", async () => {
    const KEY = "round11a-anchorabsent-key";
    const routes = makeRoutesAt(FUTURE);
    await putRouteOf(routes).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    );
    // Repoint the receipt at a non-existent anchor → future + anchor ABSENT.
    db.writer
      .prepare("UPDATE retention_recovery_receipts SET audit_id = 'aud-missing' WHERE recovery_key_hash = ?")
      .run(hashRecoveryKey(KEY));

    const result = reaperForOwner().run(NOW);
    expect(result.deletedRetentionReceipts).toBe(0);
    expect(result.quarantinedIntegrityReceipts).toBe(0);
    expect(result.clockAnomalyRetentionReceipts).toBe(0); // absent anchor → not confirmed skew
    expect(receiptRows()).toHaveLength(1); // preserved (uncertain data never deleted)
    // ...but never served — the read path fails closed on the absent anchor.
    await expect(
      receiptRouteOf(routes).handler(makeCtx({ headers: { "idempotency-key": KEY } })),
    ).rejects.toMatchObject({ ...INTEGRITY, details: { reason: "anchor_absent" } });
  });

  // ── P1 #2 — anchor SEMANTIC-ENVELOPE per-column negative matrix ────────────────
  const anchorEnvelopeMutations: Array<[string, string, string, string]> = [
    ["action", "action", "unrelated.action", "anchor_mismatch:action"],
    ["resource_type", "resource_type", "session", "anchor_mismatch:resource_type"],
    ["resource_id", "resource_id", "retention-policy:someone-else", "anchor_mismatch:resource_id"],
    ["decision", "decision", "deny", "anchor_mismatch:decision"],
    ["session_id", "session_id", "retention-policy-update:admin-001:op-OTHER", "anchor_mismatch:session_id"],
    ["reason", "reason", "tampered audit reason", "anchor_mismatch:reason"],
  ];
  it.each(anchorEnvelopeMutations)(
    "(round-11 envelope) anchor column [%s] retargeted → recovery 500 %s; authoritative policy unchanged; counts stay 1 (RED on HEAD: served)",
    async (_label, column, value, reason) => {
      await seedCoherentThenCorruptField(
        `env-${column}`,
        (h) =>
          db.writer
            .prepare(
              `UPDATE security_audit_log SET ${column} = ?
                 WHERE id = (SELECT audit_id FROM retention_recovery_receipts WHERE recovery_key_hash = ?)`,
            )
            .run(value, h),
        reason,
      );
    },
  );

  // ── P1 #2 — ROUND-10 anchor LINKAGE columns (matrix completeness): explicit
  //    negatives for the three anchor-checked fields NOT in the envelope matrix —
  //    anchor.principal_id, anchor.metadata.correlationId, anchor.metadata.payloadDigest
  //    — so the per-anchor-column matrix literally covers EVERY column
  //    `assertReceiptAnchor` checks. Tamper ONLY the one anchor field on the
  //    `security_audit_log` row (receipt intact) → recovery fails closed with the
  //    exact `anchor_mismatch:<label>` (labels per the checks array: principalId /
  //    correlationId / payloadDigest). (The remaining anchor columns are covered
  //    elsewhere: receiptId → round-10 Probe-2; tenantId → the scalar matrix;
  //    createdAt → round-10c Fix#1.)
  function tamperAnchorMetadata(
    recoveryKeyHash: string,
    mutate: (metadata: Record<string, unknown>) => void,
  ): void {
    const anchor = db.writer
      .prepare(
        `SELECT id, metadata_json FROM security_audit_log
           WHERE id = (SELECT audit_id FROM retention_recovery_receipts WHERE recovery_key_hash = ?)`,
      )
      .get(recoveryKeyHash) as { id: string; metadata_json: string };
    const metadata = JSON.parse(anchor.metadata_json) as Record<string, unknown>;
    mutate(metadata);
    db.writer
      .prepare("UPDATE security_audit_log SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify(metadata), anchor.id);
  }
  const anchorLinkageMutations: Array<[string, string, (h: string) => void]> = [
    [
      "principal_id → a different owner",
      "anchor_mismatch:principalId",
      (h) =>
        db.writer
          .prepare(
            `UPDATE security_audit_log SET principal_id = 'someone-else'
               WHERE id = (SELECT audit_id FROM retention_recovery_receipts WHERE recovery_key_hash = ?)`,
          )
          .run(h),
    ],
    [
      "metadata.correlationId → a different valid correlation",
      "anchor_mismatch:correlationId",
      (h) =>
        tamperAnchorMetadata(h, (m) => {
          m.correlationId = `retention-policy-update:${CANON}:op-TAMPERED`;
        }),
    ],
    [
      "metadata.payloadDigest → a different 64-hex",
      "anchor_mismatch:payloadDigest",
      (h) =>
        tamperAnchorMetadata(h, (m) => {
          // A real, well-shaped digest that DIFFERS from the receipt's (auditLogs→30).
          m.payloadDigest = hashIdempotencyPayload({ auditLogs: { mode: "after_days", days: 31 } });
        }),
    ],
  ];
  it.each(anchorLinkageMutations)(
    "(round-11 anchor-linkage) anchor column [%s] tampered → recovery 500 %s; authoritative policy unchanged; counts stay 1",
    async (_label, reason, corrupt) => {
      await seedCoherentThenCorruptField(`link-${reason.replace(/[^a-zA-Z]/g, "")}`, corrupt, reason);
    },
  );

  // ── P1 #2 — GREEN over-fail-close (CATASTROPHIC control): a normal write recovers
  //    clean through the FULL envelope, single AND multi-tenant; the stored anchor
  //    columns equal the canonical constants (empirical guard, in-suite).
  it("(round-11 envelope green) normal single + multi-tenant write recovers CLEAN through the full envelope; stored anchor columns == canonical constants", async () => {
    for (const [label, principal] of [
      ["single", owner(CANON)],
      ["multi", ownerWithTenant(CANON, "admin-001")],
    ] as const) {
      const KEY = `round11-envelope-clean-${label}`;
      const routes = makeRoutes(realAppender());
      const put = (await putRouteOf(routes).handler(
        makeCtx({ principal, headers: { "idempotency-key": KEY }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
      )) as { receipt: FridayRetentionPolicyUpdateReceipt };
      // Recovery passes the full anchor envelope (no over-fail-close).
      const rec = (await receiptRouteOf(routes).handler(
        makeCtx({ principal, headers: { "idempotency-key": KEY } }),
      )) as { receipt: FridayRetentionPolicyUpdateReceipt | null };
      expect(rec.receipt?.receiptId).toBe(put.receipt.receiptId);
      // The stored anchor columns are EXACTLY the canonical constants the check asserts.
      const anchor = db.writer
        .prepare(
          "SELECT action, resource_type, resource_id, decision, session_id, reason FROM security_audit_log WHERE id = ?",
        )
        .get(put.receipt.auditId) as AuditRow;
      expect(anchor.action).toBe("retention.policy.update");
      expect(anchor.resource_type).toBe("policy");
      expect(anchor.resource_id).toBe(`retention-policy:${CANON}`);
      expect(anchor.decision).toBe("allow");
      expect(anchor.session_id).toBe(put.receipt.correlationId);
      expect(anchor.reason).toBe("canonical-owner retention policy update");
    }
  });

  // ── Cutoff boundary: exactly-at / just-inside / just-outside behave correctly ──
  it("(round-11 boundary) canonical rows at exactly-cutoff / just-outside SURVIVE; just-inside is date-expired; none quarantined", async () => {
    // cutoff = NOW − 30d = 2026-06-16T10:00:00.000Z (deleteExpiredBefore: created_at < cutoff).
    const AT_CUTOFF = "2026-06-16T10:00:00.000Z"; // == cutoff → NOT < cutoff → survives
    const INSIDE = "2026-06-16T09:59:59.999Z"; // < cutoff → date-expired
    const OUTSIDE = "2026-06-16T10:00:00.001Z"; // > cutoff → survives
    for (const [key, iso] of [
      ["b-at", AT_CUTOFF],
      ["b-in", INSIDE],
      ["b-out", OUTSIDE],
    ] as const) {
      await putRouteOf(makeRoutesAt(iso)).handler(
        makeCtx({ headers: { "idempotency-key": key }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
      );
    }
    expect(receiptRows()).toHaveLength(3);

    const result = reaperForOwner().run(NOW);
    expect(result.deletedRetentionReceipts).toBe(1); // only INSIDE
    expect(result.quarantinedIntegrityReceipts).toBe(0);
    expect(result.clockAnomalyRetentionReceipts).toBe(0);
    const survivors = receiptRows().map((r) => r.created_at).sort();
    expect(survivors).toEqual([AT_CUTOFF, OUTSIDE].sort());
  });

  // ── Forward clock: a FORWARD jump does not over-delete beyond `< cutoff` and never
  //    quarantines a canonical past row. ──
  it("(round-11 forward-clock) a forward wall-clock jump date-expires only rows < the (later) cutoff; a row between cutoff and now survives; nothing quarantined", async () => {
    const FWD = "2027-07-16T10:00:00.000Z"; // a year forward → cutoff = 2027-06-16T10:00:00.000Z
    const BETWEEN = "2027-07-01T00:00:00.000Z"; // > cutoff and < FWD → survives
    // R1 between cutoff and FWD (survives); R2 at NOW (< cutoff → expired).
    await putRouteOf(makeRoutesAt(BETWEEN)).handler(
      makeCtx({ headers: { "idempotency-key": "fwd-between" }, body: { policy: { auditLogs: { mode: "after_days", days: 30 } } } }),
    );
    await putRouteOf(makeRoutesAt(NOW)).handler(
      makeCtx({ headers: { "idempotency-key": "fwd-now" }, body: { policy: { agentRuns: { mode: "after_days", days: 60 } } } }),
    );
    expect(receiptRows()).toHaveLength(2);

    const result = reaperForOwner().run(FWD);
    expect(result.deletedRetentionReceipts).toBe(1); // only the NOW row (< cutoff)
    expect(result.quarantinedIntegrityReceipts).toBe(0); // canonical past rows never quarantined
    expect(result.clockAnomalyRetentionReceipts).toBe(0);
    const survivors = receiptRows();
    expect(survivors).toHaveLength(1);
    expect(survivors[0].created_at).toBe(BETWEEN);
  });

  // ── GREEN over-fail-close: default-permanent ⇒ deleted 0, quarantined 0, clockAnomaly 0
  //    even for a future-dated row (the finite sweep never runs; nothing is touched). ──
  it("(round-11 green) default-permanent (auditLogs permanent) ⇒ deleted 0, quarantined 0, clockAnomaly 0 even with a future-dated row present", async () => {
    const KEY = "round11-permanent-future";
    // auditLogs stays PERMANENT (learningEvents opted finite) → receipt store untouched.
    await putRouteOf(makeRoutesAt(FUTURE)).handler(
      makeCtx({ headers: { "idempotency-key": KEY }, body: { policy: { learningEvents: { mode: "after_days", days: 30 } } } }),
    );
    expect(receiptRows()).toHaveLength(1);

    const result = reaperForOwner().run(NOW);
    expect(result.deletedRetentionReceipts).toBe(0);
    expect(result.quarantinedIntegrityReceipts).toBe(0);
    expect(result.clockAnomalyRetentionReceipts).toBe(0);
    expect(receiptRows()).toHaveLength(1); // preserved under default-permanent
  });
});

// ── ROUND-9 P1-B (pure unit): isValidCategoryRetention rejects unknown properties ─
describe("isValidCategoryRetention — exact-shape validation (round-9 P1-B)", () => {
  it("accepts EXACTLY {mode:'permanent'} / {mode:'after_days',days:N} and rejects any extra property", () => {
    // Canonical shapes accepted.
    expect(isValidCategoryRetention({ mode: "permanent" })).toBe(true);
    expect(isValidCategoryRetention({ mode: "after_days", days: 30 })).toBe(true);
    // Unknown properties → invalid (the P1-B fix).
    expect(isValidCategoryRetention({ mode: "permanent", x: 1 })).toBe(false);
    expect(isValidCategoryRetention({ mode: "after_days", days: 30, x: 1 })).toBe(false);
    expect(isValidCategoryRetention({ mode: "after_days", days: 30, leaked: "x" })).toBe(false);
    // permanent must NOT carry days (exactly one own-enumerable key).
    expect(isValidCategoryRetention({ mode: "permanent", days: 30 })).toBe(false);
    // Pre-existing rejections still hold.
    expect(isValidCategoryRetention({ mode: "forever" })).toBe(false);
    expect(isValidCategoryRetention({ mode: "after_days", days: 0 })).toBe(false);
    expect(isValidCategoryRetention({ mode: "after_days" })).toBe(false);
    expect(isValidCategoryRetention(null)).toBe(false);
    expect(isValidCategoryRetention([{ mode: "permanent" }])).toBe(false);
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

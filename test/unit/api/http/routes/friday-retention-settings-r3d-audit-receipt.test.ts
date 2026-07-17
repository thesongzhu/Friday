import * as net from "node:net";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  createFridayHttpRouteRegistry,
  createFridayHttpServer,
  createFridayRetentionSettingsRoutes,
  createFridayRetentionPolicyAuditAppender,
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
import {
  createFridayRetentionJob,
  createFridayRetentionPolicyLoader,
  createFridayRetentionSettingsRepository,
  createFridayRetentionSettingsStore,
} from "#jobs";
import type { FridayRetentionSettingsStore } from "#jobs";
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

  function makeStore(): FridayRetentionSettingsStore {
    return createFridayRetentionSettingsStore({
      db,
      repo: createFridayRetentionSettingsRepository(),
      idGenerator: () => `ret-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
    });
  }

  function makeRoutes(
    appendPolicyAudit: (entry: FridayRetentionPolicyAuditEntry) => string,
  ): ReturnType<typeof createFridayRetentionSettingsRoutes> {
    return createFridayRetentionSettingsRoutes({
      store,
      resolveCanonicalOwnerId: () => CANON,
      db,
      appendPolicyAudit,
      nowIso: () => NOW,
    });
  }

  function realAppender(): (entry: FridayRetentionPolicyAuditEntry) => string {
    return createFridayRetentionPolicyAuditAppender({
      sqlite: db,
      idGenerator: () => `aud-${String(++idCounter).padStart(4, "0")}`,
    });
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

    // Receipt is well-formed and bound.
    const r = result.receipt;
    expect(r.receiptId).toBe(`retention-receipt:${CANON}:${NOW}`);
    expect(r.correlationId).toBe(`retention-policy-update:${CANON}:${NOW}`);
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

    // Exactly ONE durable audit row, bound to the same correlation id.
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(r.auditId);
    expect(rows[0].principal_id).toBe(CANON);
    expect(rows[0].action).toBe("retention.policy.update");
    expect(rows[0].resource_type).toBe("policy");
    expect(rows[0].decision).toBe("allow");
    expect(rows[0].resource_id).toBe(`retention-policy:${CANON}`);
    const meta = JSON.parse(rows[0].metadata_json) as {
      correlationId: string;
      deletedData: boolean;
      changedCategories: string[];
    };
    expect(meta.correlationId).toBe(r.correlationId);
    expect(meta.deletedData).toBe(false);
    expect(meta.changedCategories).toEqual(["auditLogs"]);
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

  function startServer(tokens: Record<string, StubPrincipal>) {
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
    })) {
      routes.register(route);
    }
    server = createFridayHttpServer({
      routes,
      wsGateway: makeStubWsGateway(),
      middleware: makeBearerStubMiddleware(tokens),
      port,
      host: "127.0.0.1",
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
    expect(receipt.correlationId).toBe(`retention-policy-update:${CANON}:${NOW}`);
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
});

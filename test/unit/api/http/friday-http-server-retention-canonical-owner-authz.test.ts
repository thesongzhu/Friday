import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFridayHttpRouteRegistry,
  createFridayHttpServer,
  createFridayRetentionSettingsRoutes,
  createFridayRetentionPolicyAuditAppender,
  createFridaySetupBootstrapNonceRepository,
  type FridayAuthMiddlewareFactory,
  type FridayHttpServer,
  type FridayRealtimeWsGateway,
} from "#api";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayRetentionJob,
  createFridayRetentionPolicyLoader,
  createFridayRetentionSettingsRepository,
  createFridayRetentionSettingsStore,
} from "#jobs";
import type { FridayRetentionSettingsStore } from "#jobs";
import {
  createFridaySatelliteHeartbeatRepository,
  createFridayOutboxMessageRepository,
  createFridaySatellitePairingRequestRepository,
} from "#satellites";
import { createFridayLearningEventLedger, createFridaySkillRunStore } from "#ledger";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

/**
 * RETENTION-R3a — CANONICAL-OWNER binding (Advisor round 3 P0).
 *
 * The finding: the route authorized ANY owner/admin-role principal and then keyed
 * the retention-policy row to the caller's arbitrary `principal.userId`. But the
 * product fixes a SINGLE canonical owner (`admin-001` = hub-bootstrap's
 * `learningDefaultUserId`) and the production reaper's loader reads ONLY that id.
 * A DIFFERENT legitimately-authenticated admin (`admin-002`) was accepted → 200
 * active-policy readback → persisted an `admin-002` override the reaper never
 * reads, while the canonical loader stayed permanent (deletes 0).
 *
 * These tests drive the REAL `createFridayHttpServer` + REAL store + the REAL
 * per-sweep reaper loader and assert the canonical-owner binding: only the
 * principal whose userId MATCHES the canonical-owner id the reaper consumes may
 * read or mutate; a second admin is denied 403 with ZERO effect; and if the
 * canonical-owner id cannot be resolved the route fails closed (403, zero effect)
 * rather than falling open to "any admin".
 */

const ROUTE = "/v1/uix/retention-policy";
const NOW = "2026-07-15T10:00:00.000Z";
const AGED = "2024-01-01T00:00:00.000Z";

// The canonical owner id the production reaper's policy loader is bound to
// (hub-bootstrap wires `principalId: learningDefaultUserId = "admin-001"`).
const CANONICAL_OWNER_ID = "admin-001";

type StubPrincipal = {
  principalId: string;
  userId: string;
  tenantId: string;
  role: string;
  scopes: string[];
  tokenId: string;
  principalType?: string;
};

// The CANONICAL owner: userId === the id the reaper reads. role admin (grants the
// hub.admin scope) via the local passphrase → bearer flow.
const CANONICAL_OWNER: StubPrincipal = {
  principalId: "user:admin-001",
  userId: CANONICAL_OWNER_ID,
  tenantId: "admin-001",
  role: "admin",
  scopes: ["hub.admin", "session.read"],
  tokenId: "tok-admin-001",
};

// A SECOND, legitimately-authenticated admin — a DISTINCT userId with a REAL
// role-derived hub.admin token (email/password login mints each user a
// role-derived admin token, so the schema permits multiple such principals).
// Role/scope alone is NOT canonical-owner identity → must be DENIED.
const SECOND_ADMIN: StubPrincipal = {
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
    requireAnyRole: () => ({ passed: true as const }),
    enforceRateLimit: () => ({ passed: true as const }),
  };
}

describe("FridayHttpServer — /v1/uix/retention-policy canonical-owner binding (RETENTION-R3a Advisor R3)", () => {
  let server: FridayHttpServer | null = null;
  let db: FridaySqliteLayer | null = null;
  let store: FridayRetentionSettingsStore;
  let port = 0;
  let baseUrl = "";
  let idc = 0;

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
    resolveCanonicalOwnerId: () => string | null | undefined = () => CANONICAL_OWNER_ID,
  ) {
    const routes = createFridayHttpRouteRegistry();
    for (const route of createFridayRetentionSettingsRoutes({
      store,
      resolveCanonicalOwnerId,
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

  function rowsFor(principalId: string): Array<{ content_category: string; after_days: number }> {
    return db!.writer
      .prepare(
        "SELECT content_category, after_days FROM friday_retention_settings WHERE principal_id = ? ORDER BY content_category",
      )
      .all(principalId) as Array<{ content_category: string; after_days: number }>;
  }

  function totalRows(): number {
    return (
      db!.writer.prepare("SELECT COUNT(*) AS c FROM friday_retention_settings").get() as { c: number }
    ).c;
  }

  async function get(headers: Record<string, string>) {
    return fetch(`${baseUrl}${ROUTE}`, { headers });
  }
  async function put(headers: Record<string, string>, bodyObj: unknown) {
    return fetch(`${baseUrl}${ROUTE}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(bodyObj),
    });
  }

  // Run the REAL per-sweep reaper with a loader bound to the CANONICAL owner id
  // (exactly as hub-bootstrap wires it) and return its audit-log deletion count.
  function canonicalReaperDeletedAuditLogs(): number {
    const loader = createFridayRetentionPolicyLoader({
      db: db!,
      repo: createFridayRetentionSettingsRepository(),
      principalId: CANONICAL_OWNER_ID,
    });
    return createFridayRetentionJob({
      db: db!,
      pairingRequestRepo: createFridaySatellitePairingRequestRepository(),
      heartbeatRepo: createFridaySatelliteHeartbeatRepository(),
      outboxRepo: createFridayOutboxMessageRepository(),
      learningLedger: createFridayLearningEventLedger({ db: db! }),
      skillRunStore: createFridaySkillRunStore({ db: db! }),
      bootstrapNonceRepo: createFridaySetupBootstrapNonceRepository(),
      nowIso: () => NOW,
      loadPolicy: () => loader.load(),
    }).run(NOW).deletedAuditLogs;
  }

  // ── TEST 1: a SECOND legitimately-authenticated admin is DENIED (403) with
  //           ZERO persistence, ZERO readback, ZERO deletion effect. ───────────
  it("second admin (admin-002, real hub.admin token) → 403 on GET+PUT; zero rows; zero reaper effect", async () => {
    await startServer({ "tok-admin-002": SECOND_ADMIN });

    // Seed an aged audit row so a wrongful opt-in would visibly delete it.
    db!.writer
      .prepare(
        `INSERT INTO audit_logs (id, ts, actor_type, actor_id, action, resource_type, resource_id)
         VALUES ('al-aged', ?, 'user', 'u1', 'create', 'skill', 's1')`,
      )
      .run(AGED);

    const getRes = await get({ Authorization: "Bearer tok-admin-002" });
    expect(getRes.status).toBe(403);

    const putRes = await put(
      { Authorization: "Bearer tok-admin-002" },
      { policy: { auditLogs: { mode: "after_days", days: 1 } } },
    );
    expect(putRes.status).toBe(403);

    // ZERO persistence: neither under admin-002 nor anywhere.
    expect(rowsFor("admin-002")).toHaveLength(0);
    expect(totalRows()).toBe(0);

    // ZERO deletion effect: the canonical reaper still deletes nothing (the
    // aged audit row survives — the second admin had NO destructive reach).
    expect(canonicalReaperDeletedAuditLogs()).toBe(0);
    expect((db!.writer.prepare("SELECT COUNT(*) c FROM audit_logs").get() as { c: number }).c).toBe(1);
  });

  // ── TEST 2: the CANONICAL owner's opt-in is persisted AND honored by the SAME
  //           per-sweep production loader the reaper consumes (accept==honored). ─
  it("canonical owner (admin-001) PUT persists and the reaper's loader honors it end-to-end", async () => {
    await startServer({ "tok-admin-001": CANONICAL_OWNER });

    const putRes = await put(
      { Authorization: "Bearer tok-admin-001" },
      { policy: { auditLogs: { mode: "after_days", days: 90 } } },
    );
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as { ok: true; data: { policy: Record<string, { mode: string; days?: number }> } };
    expect(putBody.data.policy.auditLogs).toEqual({ mode: "after_days", days: 90 });

    // Persisted under the canonical owner id (the id the reaper reads).
    expect(rowsFor(CANONICAL_OWNER_ID)).toEqual([{ content_category: "auditLogs", after_days: 90 }]);

    // GET reads it back active.
    const getRes = await get({ Authorization: "Bearer tok-admin-001" });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { ok: true; data: { policy: Record<string, { mode: string; days?: number }> } };
    expect(getBody.data.policy.auditLogs).toEqual({ mode: "after_days", days: 90 });

    // The SAME production loader the reaper uses honors the write: an aged audit
    // row is deleted (accept == honored: the canonical owner's policy DRIVES the
    // reaper).
    db!.writer
      .prepare(
        `INSERT INTO audit_logs (id, ts, actor_type, actor_id, action, resource_type, resource_id)
         VALUES ('al-aged', ?, 'user', 'u1', 'create', 'skill', 's1')`,
      )
      .run(AGED);
    expect(canonicalReaperDeletedAuditLogs()).toBe(1);
    expect((db!.writer.prepare("SELECT COUNT(*) c FROM audit_logs").get() as { c: number }).c).toBe(0);
  });

  // ── TEST 3: fail-closed if the canonical-owner id cannot be resolved. Even the
  //           canonical owner principal is denied — NEVER fall open to any admin. ─
  it("provider returns null → 403 on GET+PUT even for the canonical owner; zero persistence", async () => {
    await startServer({ "tok-admin-001": CANONICAL_OWNER }, () => null);

    const getRes = await get({ Authorization: "Bearer tok-admin-001" });
    expect(getRes.status).toBe(403);
    const putRes = await put(
      { Authorization: "Bearer tok-admin-001" },
      { policy: { auditLogs: { mode: "after_days", days: 30 } } },
    );
    expect(putRes.status).toBe(403);
    expect(totalRows()).toBe(0);
  });

  it("provider throws → 403 on GET+PUT even for the canonical owner; zero persistence", async () => {
    await startServer({ "tok-admin-001": CANONICAL_OWNER }, () => {
      throw new Error("canonical-owner resolution failed");
    });

    const getRes = await get({ Authorization: "Bearer tok-admin-001" });
    expect(getRes.status).toBe(403);
    const putRes = await put(
      { Authorization: "Bearer tok-admin-001" },
      { policy: { auditLogs: { mode: "after_days", days: 30 } } },
    );
    expect(putRes.status).toBe(403);
    expect(totalRows()).toBe(0);
  });

  it("provider returns empty/whitespace string → 403 (fail closed, not 'any admin')", async () => {
    await startServer({ "tok-admin-001": CANONICAL_OWNER }, () => "   ");
    const getRes = await get({ Authorization: "Bearer tok-admin-001" });
    expect(getRes.status).toBe(403);
    const putRes = await put(
      { Authorization: "Bearer tok-admin-001" },
      { policy: { auditLogs: { mode: "after_days", days: 30 } } },
    );
    expect(putRes.status).toBe(403);
    expect(totalRows()).toBe(0);
  });
});

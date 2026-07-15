import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFridayHttpRouteRegistry,
  createFridayHttpServer,
  createFridayRetentionSettingsRoutes,
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
import { ERROR_CODE_BOUND_PRINCIPAL_REQUIRED } from "../../../../src/security/friday-owner-session-channel-capability.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

/**
 * RETENTION-R3a — REAL end-to-end HTTP authz + cross-owner isolation proof.
 *
 * The #1606 lesson: handler-level authz stubs do NOT prove the auth composition
 * through the real pipeline. These tests drive the REAL `createFridayHttpServer`
 * (public-mutation floor + sensitive-read floor + bearer middleware) against
 * `/v1/uix/retention-policy` backed by a REAL store over an in-memory sqlite.
 *
 * Load-bearing: breaking the repo's `WHERE principal_id = ?` scoping makes the
 * two-owner isolation test go RED (owner B would read owner A's opt-in).
 */

const ROUTE = "/v1/uix/retention-policy";
const NOW = "2026-07-15T10:00:00.000Z";
const AGED = "2024-01-01T00:00:00.000Z";

type StubPrincipal = {
  principalId: string;
  userId: string;
  tenantId: string;
  role: string;
  scopes: string[];
  tokenId: string;
};

const OWNER_A: StubPrincipal = {
  principalId: "user:alice",
  userId: "11111111-1111-1111-1111-111111111111",
  tenantId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  role: "viewer",
  scopes: ["session.read"],
  tokenId: "33333333-3333-3333-3333-333333333333",
};
const OWNER_B: StubPrincipal = {
  principalId: "user:bob",
  userId: "22222222-2222-2222-2222-222222222222",
  tenantId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  role: "viewer",
  scopes: ["session.read"],
  tokenId: "44444444-4444-4444-4444-444444444444",
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

// Missing/invalid Authorization leaves ctx.principal untouched (server falls back
// to the synthetic public principal); a valid bearer sets the real bound principal.
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

describe("FridayHttpServer — /v1/uix/retention-policy real-HTTP authz + cross-owner isolation (RETENTION-R3a)", () => {
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

  function startServer(tokens: Record<string, StubPrincipal> = {}) {
    const routes = createFridayHttpRouteRegistry();
    for (const route of createFridayRetentionSettingsRoutes({ store })) {
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

  async function put(headers: Record<string, string>, bodyObj: unknown) {
    return fetch(`${baseUrl}${ROUTE}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(bodyObj),
    });
  }

  // ── AUTH NEGATIVES: anonymous / synthetic-public / invalid-bearer → 401 ────
  it("anonymous GET → 401 (sensitive-read floor) before the handler runs", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}${ROUTE}`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe(ERROR_CODE_BOUND_PRINCIPAL_REQUIRED);
    expect(totalRows()).toBe(0);
  });

  it("anonymous PUT → 401 (public-mutation floor); nothing persisted", async () => {
    await startServer();
    const res = await put({}, { policy: { auditLogs: { mode: "after_days", days: 30 } } });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe(ERROR_CODE_BOUND_PRINCIPAL_REQUIRED);
    expect(totalRows()).toBe(0);
  });

  it("invalid/malformed bearer → 401 on BOTH GET and PUT (falls back to synthetic public); nothing persisted", async () => {
    await startServer({ "good-token": OWNER_A }); // the bogus bearer below is NOT this token
    const getRes = await fetch(`${baseUrl}${ROUTE}`, { headers: { Authorization: "Bearer not-a-real-token" } });
    expect(getRes.status).toBe(401);
    expect(((await getRes.json()) as { error: { code: string } }).error.code).toBe(
      ERROR_CODE_BOUND_PRINCIPAL_REQUIRED,
    );

    const putRes = await put(
      { Authorization: "Bearer not-a-real-token" },
      { policy: { auditLogs: { mode: "after_days", days: 30 } } },
    );
    expect(putRes.status).toBe(401);
    expect(((await putRes.json()) as { error: { code: string } }).error.code).toBe(
      ERROR_CODE_BOUND_PRINCIPAL_REQUIRED,
    );

    // A malformed (non-"Bearer x") header also falls back → gated.
    const malformed = await fetch(`${baseUrl}${ROUTE}`, { headers: { Authorization: "Token abc" } });
    expect(malformed.status).toBe(401);

    expect(totalRows()).toBe(0);
  });

  // ── CROSS-OWNER ISOLATION (the class missed in #1606) ─────────────────────
  it("two authenticated owners: A's opt-in is invisible to B; body-supplied owner id is ignored; rows are principal-scoped", async () => {
    await startServer({ "token-a": OWNER_A, "token-b": OWNER_B });

    // A PUTs an opt-in — and the body ALSO tries to target owner B (userId /
    // principalId / ownerId). The handler must ignore the body ids and write
    // under the AUTHENTICATED principal (A) only.
    const putRes = await put(
      { Authorization: "Bearer token-a" },
      {
        userId: OWNER_B.userId,
        principalId: OWNER_B.principalId,
        ownerId: OWNER_B.userId,
        policy: { auditLogs: { mode: "after_days", days: 30 } },
      },
    );
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as { ok: true; data: { policy: Record<string, { mode: string; days?: number }> } };
    expect(putBody.data.policy.auditLogs).toEqual({ mode: "after_days", days: 30 });

    // B GETs → every category permanent (A's opt-in is NOT visible to B).
    const bGet = await fetch(`${baseUrl}${ROUTE}`, { headers: { Authorization: "Bearer token-b" } });
    expect(bGet.status).toBe(200);
    const bBody = (await bGet.json()) as { ok: true; data: { policy: Record<string, { mode: string; days?: number }> } };
    for (const retention of Object.values(bBody.data.policy)) {
      expect(retention.mode).toBe("permanent");
    }
    expect(bBody.data.policy.auditLogs).toEqual({ mode: "permanent" });

    // A GETs → sees its own opt-in.
    const aGet = await fetch(`${baseUrl}${ROUTE}`, { headers: { Authorization: "Bearer token-a" } });
    const aBody = (await aGet.json()) as { ok: true; data: { policy: Record<string, { mode: string; days?: number }> } };
    expect(aBody.data.policy.auditLogs).toEqual({ mode: "after_days", days: 30 });

    // Physical persistence is principal-scoped: the row lands under A's userId,
    // NOT under B's (despite the body attempting to target B).
    expect(rowsFor(OWNER_A.userId)).toEqual([{ content_category: "auditLogs", after_days: 30 }]);
    expect(rowsFor(OWNER_B.userId)).toHaveLength(0);
    expect(totalRows()).toBe(1);
  });

  // ── CORRECTNESS: the reaper honors an owner opt-in submitted via the real API.
  it("reaper honors an owner opt-in submitted via the real API (single-owner id linkage)", async () => {
    // OWNER = admin-001. This id is the SAME across the whole chain in the
    // single-owner product, which is exactly why the reaper reads what the API
    // wrote:
    //   * hub-bootstrap seeds the owner user with id "admin-001";
    //   * friday-auth-service.generateTokenPair mints principal.userId = user.id
    //     (so the authenticated owner principal carries userId "admin-001");
    //   * the API scopes persistence by requireUserId(principal) = principal.userId;
    //   * hub-bootstrap wires the loader with principalId = learningDefaultUserId
    //     = "admin-001".
    // API-write id == reaper-read id ⇒ the owner's opt-in is honored.
    const ownerToken = "owner-admin-token";
    const ownerPrincipal: StubPrincipal = {
      principalId: "admin-001",
      userId: "admin-001",
      tenantId: "admin-001",
      role: "admin",
      scopes: ["session.read"],
      tokenId: "tok-admin-001",
    };
    await startServer({ [ownerToken]: ownerPrincipal });

    // 1) PUT the opt-in via the REAL HTTP API under the owner principal.
    const putRes = await put(
      { Authorization: `Bearer ${ownerToken}` },
      { policy: { auditLogs: { mode: "after_days", days: 90 } } },
    );
    expect(putRes.status).toBe(200);

    // 2) Seed an aged audit_logs row and resolve the reaper policy with the SAME
    //    id the hub wires (learningDefaultUserId = "admin-001").
    db!.writer
      .prepare(
        `INSERT INTO audit_logs (id, ts, actor_type, actor_id, action, resource_type, resource_id)
         VALUES ('al-aged', ?, 'user', 'u1', 'create', 'skill', 's1')`,
      )
      .run(AGED);
    const loader = createFridayRetentionPolicyLoader({
      db: db!,
      repo: createFridayRetentionSettingsRepository(),
      principalId: "admin-001",
    });
    const policy = loader.load();
    expect(policy.auditLogs).toEqual({ mode: "after_days", days: 90 });

    // 3) Run the reaper → the owner's opt-in is honored (aged row deleted);
    //    every other content category stays permanent (0 deletes) = fail-closed.
    const result = createFridayRetentionJob({
      db: db!,
      pairingRequestRepo: createFridaySatellitePairingRequestRepository(),
      heartbeatRepo: createFridaySatelliteHeartbeatRepository(),
      outboxRepo: createFridayOutboxMessageRepository(),
      learningLedger: createFridayLearningEventLedger({ db: db! }),
      skillRunStore: createFridaySkillRunStore({ db: db! }),
      bootstrapNonceRepo: createFridaySetupBootstrapNonceRepository(),
      nowIso: () => NOW,
      policy,
    }).run(NOW);

    expect(result.deletedAuditLogs).toBe(1);
    expect(result.deletedAgentRuns).toBe(0);
    expect(result.deletedLearningEvents).toBe(0);
    expect(result.deletedLlmUsageRecords).toBe(0);
    expect(result.deletedErrorIncidents).toBe(0);
    expect(result.deletedSkillRuns).toBe(0);
    expect(result.deletedHeartbeats).toBe(0);
    expect(
      (db!.writer.prepare("SELECT COUNT(*) c FROM audit_logs").get() as { c: number }).c,
    ).toBe(0);
  });
});

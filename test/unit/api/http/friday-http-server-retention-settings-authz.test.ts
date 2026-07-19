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
 * Load-bearing: the canonical-owner binding (Advisor R3) requires the
 * authenticated principal's userId to MATCH the single canonical-owner id the
 * reaper consumes; a second legitimately-authenticated admin is refused, and the
 * repo's `WHERE principal_id = ?` scoping keys every row to that canonical id.
 */

const ROUTE = "/v1/uix/retention-policy";
const NOW = "2026-07-15T10:00:00.000Z";
const AGED = "2024-01-01T00:00:00.000Z";

// The single canonical-owner id the production reaper's policy loader is bound to
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

// The CANONICAL owner: role "admin" (grants the hub.admin scope) via the local
// passphrase → bearer flow, AND userId == the single canonical-owner id the
// production reaper's policy loader is bound to (learningDefaultUserId).
const OWNER_A: StubPrincipal = {
  principalId: "user:admin-001",
  userId: CANONICAL_OWNER_ID,
  tenantId: "admin-001",
  role: "admin",
  scopes: ["hub.admin", "session.read"],
  tokenId: "33333333-3333-3333-3333-333333333333",
};
// A SECOND, legitimately-authenticated admin — a DISTINCT userId with a REAL
// role-derived hub.admin token (the schema permits multiple such users). Role/
// scope is NOT canonical-owner identity, so this principal is REFUSED 403 on the
// canonical-owner-bound retention surface (Advisor R3): it must never receive an
// active-policy readback nor persist an override the canonical reaper won't read.
const OWNER_B: StubPrincipal = {
  principalId: "user:admin-002",
  userId: "admin-002",
  tenantId: "admin-002",
  role: "admin",
  scopes: ["hub.admin", "session.read"],
  tokenId: "44444444-4444-4444-4444-444444444444",
};

// NON-OWNER principals that must be REFUSED (owner-only retention config).
const VIEWER: StubPrincipal = {
  principalId: "user:viewer",
  userId: "55555555-5555-5555-5555-555555555555",
  tenantId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  role: "viewer",
  scopes: ["session.read"], // exactly the Advisor's probe principal
  tokenId: "66666666-6666-6666-6666-666666666666",
};
const OPERATOR: StubPrincipal = {
  principalId: "user:operator",
  userId: "77777777-7777-7777-7777-777777777777",
  tenantId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
  role: "operator", // no hub.admin scope, not owner/admin
  scopes: ["workflow.write", "agent.run", "session.read"],
  tokenId: "88888888-8888-8888-8888-888888888888",
};
// A device-bound OWNER principal while device-owner authority is DISABLED (the
// default profile / a revoked-or-expired device). isReleaseDisabledDevicePrincipal
// treats it exactly like the synthetic public principal ⇒ 401.
const DEVICE_OWNER_DISABLED: StubPrincipal = {
  principalType: "device",
  principalId: "device-owner:revoked",
  userId: "admin-001",
  tenantId: "admin-001",
  role: "admin",
  scopes: ["hub.admin"],
  tokenId: "99999999-9999-9999-9999-999999999999",
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

  function startServer(
    tokens: Record<string, StubPrincipal> = {},
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
      idGenerator: () => `op-${String(++idc).padStart(4, "0")}`,
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

  // ── CANONICAL-OWNER BINDING (Advisor R3): a second legitimately-authenticated
  //    admin is REFUSED; the canonical owner writes under its own id; a body-
  //    supplied owner id is ignored; rows are canonical-scoped. ────────────────
  it("second admin (B) is denied 403 on GET+PUT; canonical owner (A) writes; body-supplied owner id ignored; rows canonical-scoped", async () => {
    await startServer({ "token-a": OWNER_A, "token-b": OWNER_B });

    // The CANONICAL owner (A = admin-001) PUTs an opt-in — the body ALSO tries to
    // target the second admin B (userId / principalId / ownerId). The handler must
    // ignore the body ids and write under the resolved CANONICAL owner only.
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

    // The SECOND admin (B) — a distinct userId with a real hub.admin token — is
    // REFUSED on BOTH GET and PUT: role/scope is NOT canonical-owner identity.
    const bGet = await fetch(`${baseUrl}${ROUTE}`, { headers: { Authorization: "Bearer token-b" } });
    expect(bGet.status).toBe(403);
    const bPut = await put(
      { Authorization: "Bearer token-b" },
      { policy: { auditLogs: { mode: "after_days", days: 1 } } },
    );
    expect(bPut.status).toBe(403);

    // A GETs → sees its own opt-in.
    const aGet = await fetch(`${baseUrl}${ROUTE}`, { headers: { Authorization: "Bearer token-a" } });
    const aBody = (await aGet.json()) as { ok: true; data: { policy: Record<string, { mode: string; days?: number }> } };
    expect(aBody.data.policy.auditLogs).toEqual({ mode: "after_days", days: 30 });

    // Physical persistence is canonical-scoped: the row lands under the canonical
    // owner id (== admin-001), NOT under B's id (despite the body targeting B),
    // and B's denied PUT wrote nothing.
    expect(rowsFor(OWNER_A.userId)).toEqual([{ content_category: "auditLogs", after_days: 30 }]);
    expect(rowsFor(OWNER_B.userId)).toHaveLength(0);
    expect(totalRows()).toBe(1);
  });

  // ── OWNER-AUTHORITY MATRIX (SEC-NET-PRINCIPAL-001): retention config is
  //    canonical-local-owner-only. Only the owner may READ or MUTATE it. ──────
  it("owner-authority matrix: non-owner principals are refused on GET+PUT with ZERO writes and ZERO deletion effect; only the owner succeeds", async () => {
    await startServer({
      "tok-viewer": VIEWER,
      "tok-operator": OPERATOR,
      "tok-device": DEVICE_OWNER_DISABLED,
      "tok-admin-2": OWNER_B,
      "tok-owner": OWNER_A,
    });

    // DENIED matrix: [label, authHeader, expectedStatus]. Anonymous / synthetic
    // and release-disabled-device → 401 (bound-principal floor); bound non-owner
    // (viewer / operator) → 403 (owner authority required); a bound owner/admin
    // that is NOT the canonical owner (second admin) → 403 (canonical binding).
    const denied: Array<[string, Record<string, string>, number]> = [
      ["anonymous", {}, 401],
      ["invalid-bearer (synthetic fallback)", { Authorization: "Bearer nope" }, 401],
      ["viewer (session.read only)", { Authorization: "Bearer tok-viewer" }, 403],
      ["operator (no owner authority)", { Authorization: "Bearer tok-operator" }, 403],
      ["revoked/disabled device-owner", { Authorization: "Bearer tok-device" }, 401],
      ["second admin (owner/admin role, NOT canonical owner)", { Authorization: "Bearer tok-admin-2" }, 403],
    ];

    for (const [, headers, expected] of denied) {
      const getRes = await fetch(`${baseUrl}${ROUTE}`, { headers });
      expect(getRes.status).toBe(expected);
      const putRes = await put(headers, { policy: { auditLogs: { mode: "after_days", days: 1 } } });
      expect(putRes.status).toBe(expected);
    }

    // ZERO WRITES: no denied principal persisted any override.
    expect(totalRows()).toBe(0);

    // ZERO DELETION EFFECT: with no persisted override, the live reaper policy is
    // all-permanent ⇒ an aged audit row survives a sweep (denied principals had
    // no destructive effect).
    db!.writer
      .prepare(
        `INSERT INTO audit_logs (id, ts, actor_type, actor_id, action, resource_type, resource_id)
         VALUES ('al-untouched', ?, 'user', 'u1', 'create', 'skill', 's1')`,
      )
      .run(AGED);
    const loader = createFridayRetentionPolicyLoader({
      db: db!,
      repo: createFridayRetentionSettingsRepository(),
      principalId: OWNER_A.userId,
    });
    const deniedSweep = createFridayRetentionJob({
      db: db!,
      pairingRequestRepo: createFridaySatellitePairingRequestRepository(),
      heartbeatRepo: createFridaySatelliteHeartbeatRepository(),
      outboxRepo: createFridayOutboxMessageRepository(),
      learningLedger: createFridayLearningEventLedger({ db: db! }),
      skillRunStore: createFridaySkillRunStore({ db: db! }),
      bootstrapNonceRepo: createFridaySetupBootstrapNonceRepository(),
      nowIso: () => NOW,
      loadPolicy: () => loader.load(),
    }).run(NOW);
    expect(deniedSweep.deletedAuditLogs).toBe(0);

    // ONLY the canonical owner succeeds: GET 200 + PUT 200 (opt-in persisted).
    const ownerGet = await fetch(`${baseUrl}${ROUTE}`, { headers: { Authorization: "Bearer tok-owner" } });
    expect(ownerGet.status).toBe(200);
    const ownerPut = await put(
      { Authorization: "Bearer tok-owner" },
      { policy: { auditLogs: { mode: "after_days", days: 30 } } },
    );
    expect(ownerPut.status).toBe(200);
    expect(rowsFor(OWNER_A.userId)).toEqual([{ content_category: "auditLogs", after_days: 30 }]);
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
      scopes: ["hub.admin", "session.read"],
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

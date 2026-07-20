/**
 * SEC-SETUP-BOOTSTRAP-001 · Slice 3 — runtime proof over REAL HTTP.
 *
 * Two production-posture proofs that the DISABLED device principal carries ZERO
 * owner data/control authority:
 *
 *  A. The device-claim endpoint now REQUIRES proof-of-possession: a missing or
 *     PoP-unverified key is refused (owner slot untouched, nonce un-burned) —
 *     driven over a real TCP socket against a real file-backed SQLite hub in
 *     NODE_ENV=production on an ephemeral port > 49152 (no allowTestOnly).
 *
 *  B. The real http-server enforcement floors (L1 public-mutation, L2
 *     sensitive-read) refuse a device principal EXACTLY like the synthetic
 *     anonymous principal, while a NON-device principal of identical shape is
 *     allowed — proving the floor consults the principal TYPE + the server-derived
 *     switch, not the id/scope shape (the central attestation-theater trap).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFridayAuthRoutes,
  createFridayAuthService,
  createFridayHttpRouteRegistry,
  createFridayHttpServer,
  type FridayAuthMiddlewareFactory,
  type FridayHttpServer,
  type FridayRealtimeWsGateway,
} from "#api";
import { createFridaySqliteLayer } from "#state";
import type { FridaySqliteLayer } from "#state";

import type { FridayAuthPrincipal, FridayScope } from "../../../src/api/model/friday-api-auth.types.js";
import { FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID } from "../../../src/api/http/friday-default-public-principal.js";
import { ERROR_CODE_BOUND_PRINCIPAL_REQUIRED } from "../../../src/security/friday-owner-session-channel-capability.js";
import {
  DEVICE_OWNER_PRINCIPAL_TYPE,
  deviceOwnerPrincipalId,
} from "../../../src/security/friday-device-owner-authority-precondition.js";
import { generateTestDeviceKey, makeTranscript, signTranscriptLowS } from "../../adversarial/_secsetup-s2a.helpers.js";

const OWNER_ID = "admin-001";
const NOW = "2026-07-13T00:00:00.000Z";
const ORIGIN = "https://friday.localhost";
const DEVICE_KEY = generateTestDeviceKey();
const DEVICE_PUBKEY = DEVICE_KEY.spkiDerBase64;
const DEVICE_ID = "device-s3-http-001";
const OWNER_SCOPES: FridayScope[] = ["workflow.read", "security.read", "session.read"];

function sha256Hex(v: string): string {
  return crypto.createHash("sha256").update(v).digest("hex");
}

async function findEphemeralPortAbove(min: number): Promise<number> {
  const lo = Math.max(min + 1, 49153);
  const hi = 65535;
  const span = hi - lo + 1;
  // Random per-call seed so consecutive servers in the same worker never reuse a
  // just-closed port (which can be in TIME_WAIT and race the first request).
  const seed = Math.floor(Math.random() * span);
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const candidate = lo + ((seed + attempt * 2861) % span);
    const bound = await new Promise<number | null>((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(null));
      srv.listen(candidate, "127.0.0.1", () => {
        srv.close((e) => resolve(e ? null : candidate));
      });
    });
    if (bound !== null && bound > min) return bound;
  }
  throw new Error(`could not allocate an ephemeral port > ${min}`);
}

function makeStubWsGateway(): FridayRealtimeWsGateway {
  return {
    handleClientFrame: () => ({ handled: false }),
    addConnection: () => {},
    removeConnection: () => {},
    broadcastEvent: () => {},
  } as unknown as FridayRealtimeWsGateway;
}

function makePassthroughMiddleware(): FridayAuthMiddlewareFactory {
  return {
    requireAuth: () => ({ passed: true as const }),
    requireAnyScope: () => ({ passed: true as const }),
    requireAnyRole: () => ({ passed: true as const }),
    enforceRateLimit: () => ({ passed: true as const }),
  } as unknown as FridayAuthMiddlewareFactory;
}

/** Bearer-stub middleware that hydrates a FULL principal (incl. principalType). */
function makePrincipalBearerMiddleware(
  tokens: Record<string, FridayAuthPrincipal>,
): FridayAuthMiddlewareFactory {
  return {
    requireAuth: (ctx: { principal?: unknown; headers: Record<string, string | undefined> }) => {
      if (ctx.principal) return { passed: true as const };
      const auth = ctx.headers["authorization"] ?? ctx.headers["Authorization"];
      if (!auth) return { passed: false as const, statusCode: 401, code: "UNAUTHORIZED", message: "missing token" };
      const [scheme, token] = auth.split(" ");
      if (scheme !== "Bearer" || !token || !tokens[token]) {
        return { passed: false as const, statusCode: 401, code: "UNAUTHORIZED", message: "invalid token" };
      }
      (ctx as { principal: unknown }).principal = tokens[token];
      return { passed: true as const };
    },
    requireAnyScope: () => ({ passed: true as const }),
    requireAnyRole: () => ({ passed: true as const }),
    enforceRateLimit: () => ({ passed: true as const }),
  } as unknown as FridayAuthMiddlewareFactory;
}

function claimBody(nonce: string, over: Partial<{ origin: string; withProof: boolean; badSig: boolean }> = {}): Record<string, unknown> {
  const origin = over.origin ?? ORIGIN;
  const base = {
    nonce,
    devicePublicKey: DEVICE_PUBKEY,
    deviceId: DEVICE_ID,
    origin,
    installId: "install-s3",
    osUser: "jarvis",
  };
  if (over.withProof === false) return base; // no proof at all
  const transcript = makeTranscript(DEVICE_KEY, { nonce, origin, deviceId: DEVICE_ID, installId: "install-s3", osUser: "jarvis" });
  const value = over.badSig
    ? Buffer.from(crypto.randomBytes(64)).toString("base64")
    : signTranscriptLowS(DEVICE_KEY, transcript);
  return { ...base, deviceClaimProof: { transcript, signature: { encoding: "ieee-p1363-base64", value } } };
}

// ─── A. device-claim PoP enforcement over real HTTP + sqlite ───

describe("S3 runtime proof A — device-claim requires PoP (real HTTP, production posture)", () => {
  let server: FridayHttpServer | null = null;
  let db: FridaySqliteLayer;
  let tmpDir: string;
  let baseUrl = "";
  const savedNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    process.env.NODE_ENV = "production";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-secsetup-s3-http-"));
    db = createFridaySqliteLayer({
      dbPath: path.join(tmpDir, "friday.db"),
      readPoolSize: 2,
      pragmas: { busyTimeoutMs: 5_000, synchronous: "NORMAL" },
    });
    db.withWriteTransaction((conn) => {
      conn
        .prepare(
          `INSERT INTO users (id, email, display_name, role, password_hash, is_local_only, last_login_at, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, NULL, 1, NULL, ?, ?, NULL)`,
        )
        .run(OWNER_ID, "admin@friday.dev", "Admin", "admin", NOW, NOW);
    });

    const authService = createFridayAuthService({
      db,
      idGenerator: (() => {
        let n = 0;
        return () => `id-${String(++n).padStart(4, "0")}`;
      })(),
      nowIso: () => NOW,
      tokenSecret: crypto.randomBytes(32).toString("hex"), // pragma: allowlist secret
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604_800,
      hubId: "s3-http-hub",
      bootstrapNonceTtlSec: 300,
      warn: () => {},
    });
    const routes = createFridayHttpRouteRegistry();
    for (const route of createFridayAuthRoutes({ authService })) routes.register(route);

    const port = await findEphemeralPortAbove(49152);
    baseUrl = `http://127.0.0.1:${port}`;
    server = createFridayHttpServer({
      routes,
      wsGateway: makeStubWsGateway(),
      middleware: makePassthroughMiddleware(),
      port,
      host: "127.0.0.1",
      logRequests: false,
    });
    await server.listen();
  });

  afterEach(async () => {
    if (server) await server.close();
    server = null;
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env.NODE_ENV = savedNodeEnv;
  });

  async function post(body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}/v1/auth/bootstrap/device-claim`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(body),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  function ownerHash(): string | null {
    return db.withReadConnection((conn) => {
      const row = conn.prepare("SELECT password_hash AS h FROM users WHERE id = ?").get(OWNER_ID) as
        | { h: string | null }
        | undefined;
      return row?.h ?? null;
    });
  }

  function nonceConsumedAt(nonce: string): unknown {
    return db.withReadConnection((conn) => {
      const row = conn
        .prepare("SELECT consumed_at FROM friday_setup_bootstrap_nonces WHERE nonce_hash = ?")
        .get(sha256Hex(nonce)) as { consumed_at: unknown } | undefined;
      return row?.consumed_at ?? null;
    });
  }

  async function issue(): Promise<string> {
    const res = await fetch(`${baseUrl}/v1/auth/bootstrap/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ installId: "install-s3", osUser: "jarvis", origin: ORIGIN }),
    });
    const json = (await res.json()) as any;
    return json.data.nonce as string;
  }

  it("MUST-REFUSE: a claim with NO proof → 400 POP_REQUIRED; owner NULL, nonce un-burned", async () => {
    const nonce = await issue();
    const r = await post(claimBody(nonce, { withProof: false }));
    expect(r.status).toBe(400);
    expect(r.json?.error?.code).toBe("AUTH_BOOTSTRAP_POP_REQUIRED");
    expect(ownerHash()).toBeNull();
    expect(nonceConsumedAt(nonce)).toBeNull();
  });

  it("MUST-REFUSE: a PoP-unverified (bad signature) key → 401 POP_INVALID; owner NULL, nonce un-burned", async () => {
    const nonce = await issue();
    const r = await post(claimBody(nonce, { badSig: true }));
    expect(r.status).toBe(401);
    expect(r.json?.error?.code).toBe("AUTH_BOOTSTRAP_POP_INVALID");
    expect(ownerHash()).toBeNull();
    expect(nonceConsumedAt(nonce)).toBeNull();
  });

  it("LIVE-DEFECT CLOSED (production posture, real HTTP): a valid PoP claim with NO native capability → 401 refused; owner NULL, nonce un-burned", async () => {
    // At head this returned 200 claimed with deviceAuthorityEnabled=false — a valid
    // software-key PoP seized the owner slot in a NODE_ENV=production posture with NO
    // native authority. Option C gates the owner-sentinel write + nonce consume on a
    // per-claim VerifiedNativeOwnerClaimContext; this authService is built with the
    // DEFAULT absent resolver (no native accept boundary) → the claim is refused with
    // ZERO state change.
    const nonce = await issue();
    const r = await post(claimBody(nonce));
    expect(r.status).toBe(401);
    expect(r.json?.error?.code).toBe("AUTH_BOOTSTRAP_DEVICE_AUTHORITY_UNVERIFIED");
    expect(ownerHash()).toBeNull();
    expect(nonceConsumedAt(nonce)).toBeNull();
  });
});

// ─── B. http-server floors refuse the DISABLED device principal ───

describe("S3 runtime proof B — L1/L2 floors refuse a device principal (real http-server)", () => {
  let server: FridayHttpServer | null = null;
  let baseUrl = "";
  let handlerCalls = 0;

  const devicePrincipal: FridayAuthPrincipal = {
    principalType: DEVICE_OWNER_PRINCIPAL_TYPE,
    principalId: deviceOwnerPrincipalId(sha256Hex("device-key")),
    tenantId: "11111111-1111-1111-1111-111111111111",
    userId: "22222222-2222-2222-2222-222222222222",
    role: "owner",
    scopes: [...OWNER_SCOPES],
    tokenId: "33333333-3333-3333-3333-333333333333",
    tokenKind: "access",
    issuedAt: NOW,
  };
  // Identical shape (id/scopes/role), but a NON-device type → allowed.
  const userPrincipal: FridayAuthPrincipal = { ...devicePrincipal, principalType: "user", principalId: "user:alice" };

  beforeEach(async () => {
    handlerCalls = 0;
    const routes = createFridayHttpRouteRegistry();
    routes.register({
      operationId: "test.s3.mutate",
      method: "POST",
      path: "/v1/test/s3/mutate",
      auth: { public: true },
      async handler() {
        handlerCalls += 1;
        return { handlerRan: true };
      },
    });
    routes.register({
      operationId: "test.s3.sensitive.read",
      method: "GET",
      path: "/v1/memory/items/s3", // under the /v1/memory sensitive-read prefix
      auth: { public: true },
      async handler() {
        handlerCalls += 1;
        return { ownerData: "owner-only" };
      },
    });

    const port = await findEphemeralPortAbove(49152);
    baseUrl = `http://127.0.0.1:${port}`;
    server = createFridayHttpServer({
      routes,
      wsGateway: makeStubWsGateway(),
      middleware: makePrincipalBearerMiddleware({ "device-token": devicePrincipal, "user-token": userPrincipal }),
      port,
      host: "127.0.0.1",
      logRequests: false,
    });
    await server.listen();
  });

  afterEach(async () => {
    if (server) await server.close();
    server = null;
  });

  async function req(method: "POST" | "GET", pathname: string, token?: string): Promise<{ status: number; code?: string }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify({}) : undefined,
    });
    let code: string | undefined;
    try {
      const j = (await res.json()) as any;
      code = j?.error?.code;
    } catch {
      code = undefined;
    }
    return { status: res.status, code };
  }

  it("RF-C1 (L1): POST mutating public route with the device principal → 401 BOUND_PRINCIPAL_REQUIRED; handler not run", async () => {
    const r = await req("POST", "/v1/test/s3/mutate", "device-token");
    expect(r.status).toBe(401);
    expect(r.code).toBe(ERROR_CODE_BOUND_PRINCIPAL_REQUIRED);
    expect(handlerCalls).toBe(0);
  });

  it("positive control (L1): the SAME shape as a NON-device principal → 200 (handler runs)", async () => {
    const r = await req("POST", "/v1/test/s3/mutate", "user-token");
    expect(r.status).toBe(200);
    expect(handlerCalls).toBe(1);
  });

  it("regression (L1): anonymous (no bearer) → 401 BOUND_PRINCIPAL_REQUIRED (existing floor intact)", async () => {
    const r = await req("POST", "/v1/test/s3/mutate");
    expect(r.status).toBe(401);
    expect(r.code).toBe(ERROR_CODE_BOUND_PRINCIPAL_REQUIRED);
    expect(handlerCalls).toBe(0);
  });

  it("RF-C2 (L2): GET sensitive-read route with the device principal → 401; handler not run", async () => {
    const r = await req("GET", "/v1/memory/items/s3", "device-token");
    expect(r.status).toBe(401);
    expect(r.code).toBe(ERROR_CODE_BOUND_PRINCIPAL_REQUIRED);
    expect(handlerCalls).toBe(0);
  });

  it("positive control (L2): the SAME shape as a NON-device principal → 200 (sensitive read allowed)", async () => {
    const r = await req("GET", "/v1/memory/items/s3", "user-token");
    expect(r.status).toBe(200);
    expect(handlerCalls).toBe(1);
  });

  it("regression (L2): anonymous (no bearer) → 401 (existing sensitive-read floor intact)", async () => {
    const r = await req("GET", "/v1/memory/items/s3");
    expect(r.status).toBe(401);
    expect(r.code).toBe(ERROR_CODE_BOUND_PRINCIPAL_REQUIRED);
    expect(handlerCalls).toBe(0);
  });

  it("sanity: the device principalId is non-synthetic (proves the danger surface is real, not a public:default alias)", () => {
    expect(devicePrincipal.principalId).not.toBe(FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID);
  });
});

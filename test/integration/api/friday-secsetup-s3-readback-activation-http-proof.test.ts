/**
 * SEC-SETUP-BOOTSTRAP-001 · FIXED-order Stage 3+4 — device-readback activation
 * runtime proof over REAL HTTP, REAL auth middleware, REAL file-backed SQLite
 * (NODE_ENV=production).
 *
 * Drives the FULL production path route → middleware(real token validator + rate
 * limiter + auth floors) → auth service → sqlite on an ephemeral port > 49152.
 * migrate/device-readback is `public:true` WITHOUT allowUnauthenticatedMutation,
 * so the http-server L1 public-mutation floor refuses the synthetic public
 * principal — a real OWNER bearer (from a passphrase login) is required.
 *
 * Proven:
 *  A. Unauthenticated POST /v1/auth/migrate/device-readback → 401 (bound-principal
 *     floor); binding stays provisional, hash unchanged.
 *  B. Authenticated NON-owner (viewer authority) bearer → 403 (authority gate).
 *  C. Authenticated OWNER → migrate (provisional) then readback → 200 state
 *     'active'; password_hash stays scrypt$… (passphrase login STILL works);
 *     deviceAuthorityEnabled=false.
 *  D. RESTART-PERSISTENCE: a fresh better-sqlite3 connection to the same dbPath
 *     still sees the 'active' binding with activated_at; the owner-gated GET read
 *     seam returns state 'active'.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFridayAuthMiddlewareFactory,
  createFridayAuthRoutes,
  createFridayAuthService,
  createFridayHttpRouteRegistry,
  createFridayHttpServer,
  createFridayRateLimitService,
  createFridayTokenValidator,
  encodeToken,
  type FridayHttpServer,
  type FridayRealtimeWsGateway,
} from "#api";
import { createFridaySqliteLayer } from "#state";
import type { FridaySqliteLayer } from "#state";
import type { FridayAccessTokenClaims, FridayScope } from "../../../src/api/model/friday-api-auth.types.js";
import { getScopesForRole } from "../../../src/api/auth/friday-rbac-policy.js";
import { generateTestDeviceKey, makeTranscript, signTranscriptLowS } from "../../adversarial/_secsetup-s2a.helpers.js";

const OWNER_ID = "admin-001";
const NOW = "2026-07-13T00:00:00.000Z";
const ORIGIN = "https://friday.localhost";
const PASSPHRASE = "owner-passphrase-http-9988"; // pragma: allowlist secret
const TOKEN_SECRET = crypto.randomBytes(32).toString("hex"); // pragma: allowlist secret
const DEVICE_KEY = generateTestDeviceKey();
const DEVICE_PUBKEY = DEVICE_KEY.spkiDerBase64;
const DEVICE_ID = "device-s3-http-001";

function sha256Hex(v: string): string {
  return crypto.createHash("sha256").update(v).digest("hex");
}

async function findEphemeralPortAbove(min: number): Promise<number> {
  const lo = Math.max(min + 1, 49153);
  const hi = 65535;
  const span = hi - lo + 1;
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

describe("S3 runtime proof — device-readback activation over real HTTP (production posture)", () => {
  let server: FridayHttpServer | null = null;
  let db: FridaySqliteLayer;
  let dbPath = "";
  let tmpDir: string;
  let baseUrl = "";
  let ownerBearer = "";
  const savedNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    process.env.NODE_ENV = "production";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-secsetup-s3-http-"));
    dbPath = path.join(tmpDir, "friday.db");
    db = createFridaySqliteLayer({
      dbPath,
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
      nowIso: () => new Date().toISOString(),
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604_800,
      hubId: "s3-http-hub",
      bootstrapNonceTtlSec: 300,
      warn: () => {},
    });

    authService.bootstrapLocalPassphrase({ passphrase: PASSPHRASE }, "127.0.0.1");
    ownerBearer = authService.login({ localPassphrase: PASSPHRASE }, "127.0.0.1").accessToken;

    const tokenValidator = createFridayTokenValidator({
      tokenSecret: TOKEN_SECRET,
      nowMs: () => Date.now(),
      lookupTokenRevocation: () => false,
    });
    const rateLimitService = createFridayRateLimitService({
      db,
      nowIso: () => new Date().toISOString(),
      policyOverrides: { "auth.login": { maxHits: 1000, windowMs: 60_000 } },
    });
    const middleware = createFridayAuthMiddlewareFactory({ tokenValidator, rateLimitService });

    const routes = createFridayHttpRouteRegistry();
    for (const route of createFridayAuthRoutes({ authService })) routes.register(route);

    const port = await findEphemeralPortAbove(49152);
    baseUrl = `http://127.0.0.1:${port}`;
    server = createFridayHttpServer({
      routes,
      wsGateway: makeStubWsGateway(),
      middleware,
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

  async function post(pathname: string, body: unknown, bearer?: string): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { "content-type": "application/json", origin: ORIGIN };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const res = await fetch(`${baseUrl}${pathname}`, { method: "POST", headers, body: JSON.stringify(body) });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  async function get(pathname: string, bearer?: string): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { origin: ORIGIN };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const res = await fetch(`${baseUrl}${pathname}`, { method: "GET", headers });
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

  function bindingState(): string | null {
    return db.withReadConnection((conn) => {
      const row = conn
        .prepare("SELECT state FROM friday_device_owner_bindings WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(OWNER_ID) as { state: string } | undefined;
      return row?.state ?? null;
    });
  }

  async function issueMigrationNonce(bearer: string): Promise<string> {
    const r = await post("/v1/auth/migrate/challenge", { installId: "install-s3", osUser: "jarvis", origin: ORIGIN }, bearer);
    expect(r.status).toBe(200);
    return r.json.data.nonce as string;
  }

  function migrateBody(nonce: string) {
    const transcript = makeTranscript(DEVICE_KEY, { nonce, origin: ORIGIN, deviceId: DEVICE_ID, action: "owner-migrate", installId: "install-s3", osUser: "jarvis" });
    return {
      nonce,
      devicePublicKey: DEVICE_PUBKEY,
      deviceId: DEVICE_ID,
      origin: ORIGIN,
      installId: "install-s3",
      osUser: "jarvis",
      deviceClaimProof: { transcript, signature: { encoding: "ieee-p1363-base64" as const, value: signTranscriptLowS(DEVICE_KEY, transcript) } },
    };
  }

  function readbackBody() {
    const nonce = "readback-http-0001";
    const transcript = makeTranscript(DEVICE_KEY, { nonce, origin: ORIGIN, deviceId: DEVICE_ID, action: "owner-readback", installId: "install-s3", osUser: "jarvis" });
    return {
      nonce,
      devicePublicKey: DEVICE_PUBKEY,
      deviceId: DEVICE_ID,
      origin: ORIGIN,
      installId: "install-s3",
      osUser: "jarvis",
      deviceClaimProof: { transcript, signature: { encoding: "ieee-p1363-base64" as const, value: signTranscriptLowS(DEVICE_KEY, transcript) } },
    };
  }

  /** Drive migrate/challenge + migrate/device-claim to leave a PROVISIONAL binding. */
  async function seedProvisionalOverHttp(): Promise<void> {
    const nonce = await issueMigrationNonce(ownerBearer);
    const claim = await post("/v1/auth/migrate/device-claim", migrateBody(nonce), ownerBearer);
    expect(claim.status).toBe(200);
    expect(claim.json.data.state).toBe("provisional");
  }

  it("A: unauthenticated readback → 401 (bound-principal floor); binding untouched, hash unchanged", async () => {
    await seedProvisionalOverHttp();
    const before = ownerHash();
    const r = await post("/v1/auth/migrate/device-readback", readbackBody());
    expect(r.status).toBe(401);
    expect(bindingState()).toBe("provisional");
    expect(ownerHash()).toBe(before);
  });

  it("B: authenticated NON-owner (viewer authority) bearer → 403 (authority gate); binding untouched", async () => {
    await seedProvisionalOverHttp();
    const nowSec = Math.floor(Date.now() / 1000);
    const viewerClaims: FridayAccessTokenClaims = {
      tokenId: "tok-viewer-0001",
      principalType: "user",
      principalId: "user:viewer",
      tenantId: "user:viewer",
      userId: "user:viewer",
      role: "viewer",
      scopes: [...getScopesForRole("viewer")] as FridayScope[],
      iat: nowSec,
      exp: nowSec + 900,
    };
    const viewerBearer = encodeToken(viewerClaims, TOKEN_SECRET);

    const r = await post("/v1/auth/migrate/device-readback", readbackBody(), viewerBearer);
    expect(r.status).toBe(403);
    expect(bindingState()).toBe("provisional");
  });

  it("C+D: authenticated OWNER → active; hash stays scrypt; passphrase login works; persists across a fresh SQLite connection", async () => {
    await seedProvisionalOverHttp();
    const before = ownerHash();
    expect(before?.startsWith("scrypt$")).toBe(true);

    const readback = await post("/v1/auth/migrate/device-readback", readbackBody(), ownerBearer);
    expect(readback.status).toBe(200);
    expect(readback.json.data.activated).toBe(true);
    expect(readback.json.data.state).toBe("active");
    expect(readback.json.data.passphraseStillActive).toBe(true);
    expect(readback.json.data.deviceAuthorityEnabled).toBe(false);
    expect(readback.json.data.devicePublicKeyHash).toBe(sha256Hex(DEVICE_PUBKEY));
    expect(typeof readback.json.data.activatedAt).toBe("string");

    // DUAL-READ: password_hash UNCHANGED (still scrypt).
    expect(ownerHash()).toBe(before);

    // NO-LOCKOUT: passphrase login STILL works over the real HTTP login route.
    const login = await post("/v1/auth/login", { localPassphrase: PASSPHRASE });
    expect(login.status).toBe(200);
    expect(login.json.data.user.id).toBe(OWNER_ID);

    // RESTART-PERSISTENCE: a fresh better-sqlite3 connection to the same dbPath
    // still sees the durable 'active' binding with activated_at.
    const reopened = new Database(dbPath, { readonly: true });
    try {
      const row = reopened
        .prepare("SELECT state, activated_at FROM friday_device_owner_bindings WHERE user_id = ? AND state = 'active'")
        .get(OWNER_ID) as { state: string; activated_at: string | null } | undefined;
      expect(row?.state).toBe("active");
      expect(row?.activated_at).toBeTruthy();
    } finally {
      reopened.close();
    }

    // The owner-gated GET read seam reports the active binding (observability).
    const seam = await get("/v1/auth/migrate/device-binding", ownerBearer);
    expect(seam.status).toBe(200);
    expect(seam.json.data.state).toBe("active");
    expect(seam.json.data.hasActiveBinding).toBe(true);
    expect(seam.json.data.activatedAt).toBeTruthy();
    expect(seam.json.data.deviceAuthorityEnabled).toBe(false);
  });

  it("read seam: unauthenticated GET /v1/auth/migrate/device-binding → 401", async () => {
    await seedProvisionalOverHttp();
    const r = await get("/v1/auth/migrate/device-binding");
    expect(r.status).toBe(401);
  });
});

/**
 * Runtime proof (SEC-SETUP-BOOTSTRAP-001, slice 1): the device-bound owner
 * claim driven over REAL HTTP against a REAL file-backed SQLite hub, on an
 * ephemeral port > 49152, in a production runtime posture (NODE_ENV=production,
 * real ≥32-char token secret, real migrations, NO allowTestOnly bypass — the
 * primitive gates on none of those flags). This is NOT a route-exists smoke
 * check: it exercises issue → cross-origin-reject → claim → replay-reject → and
 * captures the real DB rows + HTTP statuses to a committed evidence file.
 *
 * Loopback-negative and crash/atomicity are proven in the unit path
 * (test/adversarial/bootstrap-device-claim.test.ts) because a real TCP socket
 * from localhost cannot be given a non-loopback remote address here.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

const OWNER_ID = "admin-001";
const NOW = "2026-07-13T00:00:00.000Z";
const ORIGIN = "https://friday.localhost";
const EVIL_ORIGIN = "https://evil.localhost";
const DEVICE_PUBKEY = crypto.randomBytes(32).toString("base64url");
const DEVICE_ID = "device-http-proof-001";
// Evidence is written to a scratch path (NOT into the repo tree) so CI never
// dirties the working tree. A representative captured run is committed at
// test/adversarial/evidence/secsetup-device-claim-runtime-proof.txt.
const EVIDENCE_PATH = path.join(os.tmpdir(), "secsetup-device-claim-runtime-proof.txt");

function sha256Hex(v: string): string {
  return crypto.createHash("sha256").update(v).digest("hex");
}

/** Allocate a free ephemeral port, re-rolling until it is > 49152 as required. */
async function findEphemeralPortAbove(min: number): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        if (!addr || typeof addr === "string") {
          srv.close();
          reject(new Error("no port"));
          return;
        }
        const p = addr.port;
        srv.close((e) => (e ? reject(e) : resolve(p)));
      });
      srv.on("error", reject);
    });
    if (port > min) return port;
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

// Public first-boot routes carry auth:{public,allowUnauthenticatedMutation}; the
// real middleware passes them through pre-auth exactly as this stub does. All
// security under proof lives in the auth SERVICE, not the middleware.
function makePassthroughMiddleware(): FridayAuthMiddlewareFactory {
  return {
    requireAuth: () => ({ passed: true as const }),
    requireAnyScope: () => ({ passed: true as const }),
    requireAnyRole: () => ({ passed: true as const }),
    enforceRateLimit: () => ({ passed: true as const }),
  } as unknown as FridayAuthMiddlewareFactory;
}

describe("SEC-SETUP-BOOTSTRAP-001 runtime proof: device claim over real HTTP + real sqlite", () => {
  let server: FridayHttpServer | null = null;
  let db: FridaySqliteLayer;
  let tmpDir: string;
  let port = 0;
  let baseUrl = "";
  const savedNodeEnv = process.env.NODE_ENV;
  const evidence: string[] = [];

  beforeAll(async () => {
    process.env.NODE_ENV = "production";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-secsetup-http-"));
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
      // Real, production-length token secret (64 hex). NODE_ENV=production would
      // throw for anything shorter — proving prod posture, not a test relaxation.
      tokenSecret: crypto.randomBytes(32).toString("hex"), // pragma: allowlist secret
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604_800,
      hubId: "http-proof-hub",
      bootstrapNonceTtlSec: 300,
      warn: () => {},
    });

    const routes = createFridayHttpRouteRegistry();
    for (const route of createFridayAuthRoutes({ authService })) {
      routes.register(route);
    }

    port = await findEphemeralPortAbove(49152);
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

    evidence.push("SEC-SETUP-BOOTSTRAP-001 slice 1 — device-claim runtime proof");
    evidence.push(`posture: NODE_ENV=production, real file-backed sqlite (WAL), ephemeral port=${port} (>49152)`);
    evidence.push(`db: ${path.join(tmpDir, "friday.db")}`);
    evidence.push("(raw nonces are REDACTED to sha256; only hashes are persisted)");
    evidence.push("");
  });

  afterAll(async () => {
    if (server) await server.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env.NODE_ENV = savedNodeEnv;
    fs.mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
    fs.writeFileSync(EVIDENCE_PATH, `${evidence.join("\n")}\n`, "utf8");
  });

  async function post(pathname: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}${pathname}`, {
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

  function nonceRow(nonce: string): Record<string, any> | null {
    return db.withReadConnection((conn) => {
      const row = conn
        .prepare("SELECT * FROM friday_setup_bootstrap_nonces WHERE nonce_hash = ?")
        .get(sha256Hex(nonce)) as Record<string, any> | undefined;
      return row ?? null;
    });
  }

  it("drives issue → cross-origin reject → claim → replay reject over real HTTP", async () => {
    // 1. Issue a single-use install nonce (loopback, bound to ORIGIN).
    const issue = await post("/v1/auth/bootstrap/challenge", {
      installId: "install-http-1",
      osUser: "jarvis",
      origin: ORIGIN,
    });
    expect(issue.status).toBe(200);
    const nonce: string = issue.json.data.nonce;
    expect(typeof nonce).toBe("string");
    expect(issue.json.data.kind).toBe("install_owner_claim");
    evidence.push(`1) POST /v1/auth/bootstrap/challenge -> HTTP ${issue.status}`);
    evidence.push(`   challengeId=${issue.json.data.challengeId} nonce_sha256=${sha256Hex(nonce)} expiresAt=${issue.json.data.expiresAt}`);
    evidence.push(`   persisted row: nonce_hash=${nonceRow(nonce)?.nonce_hash} consumed_at=${nonceRow(nonce)?.consumed_at}`);

    // 2. Cross-origin claim MUST fail closed; owner NULL; nonce unconsumed.
    const evil = await post("/v1/auth/bootstrap/device-claim", {
      nonce,
      devicePublicKey: DEVICE_PUBKEY,
      deviceId: DEVICE_ID,
      origin: EVIL_ORIGIN,
      installId: "install-http-1",
      osUser: "jarvis",
    });
    expect(evil.status).toBe(409);
    expect(ownerHash()).toBeNull();
    expect(nonceRow(nonce)?.consumed_at).toBeNull();
    evidence.push(`2) POST /v1/auth/bootstrap/device-claim (origin=${EVIL_ORIGIN}) -> HTTP ${evil.status} code=${evil.json?.error?.code ?? evil.json?.code}`);
    evidence.push(`   owner password_hash=${ownerHash()} (unchanged) nonce consumed_at=${nonceRow(nonce)?.consumed_at}`);

    // 3. Correct-origin claim wins: owner sentinel set, nonce consumed + bound.
    const ok = await post("/v1/auth/bootstrap/device-claim", {
      nonce,
      devicePublicKey: DEVICE_PUBKEY,
      deviceId: DEVICE_ID,
      origin: ORIGIN,
      installId: "install-http-1",
      osUser: "jarvis",
    });
    expect(ok.status).toBe(200);
    expect(ok.json.data.claimed).toBe(true);
    expect(ok.json.data.devicePublicKeyHash).toBe(sha256Hex(DEVICE_PUBKEY));
    const claimedHash = ownerHash();
    expect(claimedHash).toBe(`device-owner$v1$${sha256Hex(DEVICE_PUBKEY)}`);
    const consumedRow = nonceRow(nonce);
    expect(consumedRow?.consumed_at).not.toBeNull();
    expect(consumedRow?.device_public_key).toBe(DEVICE_PUBKEY);
    expect(consumedRow?.claimed_user_id).toBe(OWNER_ID);
    evidence.push(`3) POST /v1/auth/bootstrap/device-claim (origin=${ORIGIN}) -> HTTP ${ok.status} claimed=${ok.json.data.claimed}`);
    evidence.push(`   owner password_hash=${claimedHash}`);
    evidence.push(`   consumed row: consumed_at=${consumedRow?.consumed_at} device_id=${consumedRow?.device_id} device_public_key_hash=${consumedRow?.device_public_key_hash} claimed_user_id=${consumedRow?.claimed_user_id}`);

    // 4. Replay the same nonce MUST fail closed; sentinel unchanged.
    const replay = await post("/v1/auth/bootstrap/device-claim", {
      nonce,
      devicePublicKey: DEVICE_PUBKEY,
      deviceId: DEVICE_ID,
      origin: ORIGIN,
      installId: "install-http-1",
      osUser: "jarvis",
    });
    expect(replay.status).toBe(409);
    expect(ownerHash()).toBe(claimedHash);
    evidence.push(`4) POST /v1/auth/bootstrap/device-claim (replay same nonce) -> HTTP ${replay.status} code=${replay.json?.error?.code ?? replay.json?.code}`);
    evidence.push(`   owner password_hash=${ownerHash()} (unchanged — no re-claim)`);
    evidence.push("");
    evidence.push("RESULT: issue persists hash-only; cross-origin + replay fail closed with zero state change; single device-bound owner survives.");
  });
});

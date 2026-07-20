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
// SEC-SETUP-BOOTSTRAP-001 Slice 3: device-claim now requires a real PoP. Reuse
// the S2a signing helpers so this runtime proof drives the REAL verifier.
import { generateTestDeviceKey, makeTranscript, signTranscriptLowS } from "../../adversarial/_secsetup-s2a.helpers.js";
import { createTestNativeOwnerResolver } from "../../adversarial/_native-owner-capability.helpers.js";

const OWNER_ID = "admin-001";
const NOW = "2026-07-13T00:00:00.000Z";
const ORIGIN = "https://friday.localhost";
const EVIL_ORIGIN = "https://evil.localhost";
const DEVICE_KEY = generateTestDeviceKey();
const DEVICE_PUBKEY = DEVICE_KEY.spkiDerBase64;
const DEVICE_ID = "device-http-proof-001";

/** Build a device-claim body carrying a valid PoP bound to (nonce, origin). */
function claimBody(nonce: string, origin: string): Record<string, unknown> {
  const transcript = makeTranscript(DEVICE_KEY, {
    nonce,
    origin,
    deviceId: DEVICE_ID,
    installId: "install-http-1",
    osUser: "jarvis",
  });
  return {
    nonce,
    devicePublicKey: DEVICE_PUBKEY,
    deviceId: DEVICE_ID,
    origin,
    installId: "install-http-1",
    osUser: "jarvis",
    deviceClaimProof: {
      transcript,
      signature: { encoding: "ieee-p1363-base64", value: signTranscriptLowS(DEVICE_KEY, transcript) },
    },
  };
}
// Evidence is written to a scratch path (NOT into the repo tree) so CI never
// dirties the working tree. A representative captured run is committed at
// test/adversarial/evidence/secsetup-device-claim-runtime-proof.txt.
const EVIDENCE_PATH = path.join(os.tmpdir(), "secsetup-device-claim-runtime-proof.txt");

function sha256Hex(v: string): string {
  return crypto.createHash("sha256").update(v).digest("hex");
}

/**
 * Allocate a free port strictly above `min` (§5 production posture requires
 * a port > 49152). We EXPLICITLY probe ports in the private/dynamic range
 * rather than relying on OS ephemeral auto-assignment (listen(0)): on Linux
 * CI `ip_local_port_range` frequently caps at/below 49152 so auto-assignment
 * never yields a qualifying port, whereas an explicit bind to a specific high
 * port is always permitted. Deterministic stride (no RNG) spreads candidates
 * to avoid collisions between parallel test workers.
 */
async function findEphemeralPortAbove(min: number): Promise<number> {
  const lo = Math.max(min + 1, 49153);
  const hi = 65535;
  const span = hi - lo + 1;
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const candidate = lo + ((attempt * 2861 + 7919) % span);
    const bound = await new Promise<number | null>((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(null)); // EADDRINUSE / EACCES → try next candidate
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
      // Option C: seizing the owner slot for a device key REQUIRES a per-claim
      // native capability. This proof drives the GRANTED path over real HTTP in a
      // production posture by injecting a resolver that runs the REAL capability
      // mint over injected native-evidence doubles (the same shape a signed release
      // supplies from the Companion accept boundary). The capability-ABSENT refusal
      // is proven in the sibling s3-device-principal-http-proof suite.
      resolveNativeOwnerClaimContext: createTestNativeOwnerResolver(),
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
    const evil = await post("/v1/auth/bootstrap/device-claim", claimBody(nonce, EVIL_ORIGIN));
    expect(evil.status).toBe(409);
    expect(ownerHash()).toBeNull();
    expect(nonceRow(nonce)?.consumed_at).toBeNull();
    evidence.push(`2) POST /v1/auth/bootstrap/device-claim (origin=${EVIL_ORIGIN}) -> HTTP ${evil.status} code=${evil.json?.error?.code ?? evil.json?.code}`);
    evidence.push(`   owner password_hash=${ownerHash()} (unchanged) nonce consumed_at=${nonceRow(nonce)?.consumed_at}`);

    // 3. Correct-origin claim wins: owner sentinel set, nonce consumed + bound.
    const ok = await post("/v1/auth/bootstrap/device-claim", claimBody(nonce, ORIGIN));
    expect(ok.status).toBe(200);
    expect(ok.json.data.claimed).toBe(true);
    expect(ok.json.data.devicePublicKeyHash).toBe(sha256Hex(DEVICE_PUBKEY));
    // Option C authoritative readback: a release-trusted per-claim native capability
    // was consumed (Secure-Enclave OS-verified custody) → authority granted for THIS
    // claim. Authority is the per-claim capability, never a global boolean.
    expect(ok.json.data.deviceAuthorityEnabled).toBe(true);
    expect(ok.json.data.keyProtection).toBe("secure_enclave_os_verified");
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
    const replay = await post("/v1/auth/bootstrap/device-claim", claimBody(nonce, ORIGIN));
    expect(replay.status).toBe(409);
    expect(ownerHash()).toBe(claimedHash);
    evidence.push(`4) POST /v1/auth/bootstrap/device-claim (replay same nonce) -> HTTP ${replay.status} code=${replay.json?.error?.code ?? replay.json?.code}`);
    evidence.push(`   owner password_hash=${ownerHash()} (unchanged — no re-claim)`);
    evidence.push("");
    evidence.push("RESULT: issue persists hash-only; cross-origin + replay fail closed with zero state change; single device-bound owner survives.");
  });
});

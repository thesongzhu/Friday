// ─── SEC-NATIVE-OWNER-CLAIM-CAPABILITY-001 · CORE-A CR-1 (F1) — surface wiring ──
//
// F1 acceptance: `createFridayApiRuntime` now wires the native-owner claim SURFACE +
// resolver so `GET /v1/auth/bootstrap/status → deviceClaimAvailable` drives the UI's
// first-run gate (router.tsx routes to the device-claim gate when true, else the
// passphrase gate). This proves, over real HTTP through the production runtime:
//   • a release-shaped fixture (resolver+surface injected) → deviceClaimAvailable:true,
//     fresh passphrase CREATION is retired on a release profile, and device claim →
//     deviceKeyLogin mints a REAL `user.id` session;
//   • default dev/CI (no injection, non-release) → deviceClaimAvailable:false (passphrase
//     gate) — the honest state on this unsigned tree;
//   • HONESTY: the SURFACE flag may be true while the capability stays UNMINTABLE on an
//     unsigned tree (resolver mints nothing) → device claim fails CLOSED, and the login
//     challenge stays live — never fake-enabled;
//   • the emergency kill switch forces a refusal even with a resolver present.
//
// `NATIVE_IPC_ATTESTATION_AVAILABLE` stays `false` throughout.

import * as crypto from "node:crypto";
import * as net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createFridayApiRuntime, createFridayHttpServer } from "#api";
import type { FridayHttpServer } from "#api";
import type { FridayProviderService } from "#providers";
import type { FridaySqliteLayer } from "#state";
import type { NativeOwnerClaimContextResolver } from "../../../src/security/attestation/friday-verified-native-owner-claim-context.js";
import { DEVICE_OWNER_AUTHORITY_KILL_SWITCH_ENV, NATIVE_IPC_ATTESTATION_AVAILABLE } from "../../../src/security/friday-device-owner-authority-precondition.js";
import { createTestDb } from "../../helpers/friday-test-db.helper.js";
import { createTestNativeOwnerResolver } from "../../adversarial/_native-owner-capability.helpers.js";
import {
  generateTestDeviceKey,
  makeTranscript,
  signTranscriptLowS,
  type TestDeviceKey,
} from "../../adversarial/_secsetup-s2a.helpers.js";

const ORIGIN = "https://friday.localhost";
const INSTALL_ID = "install-surface-1";
const OS_USER = "jarvis";
const DEVICE_ID = "device-surface-1";

function mockProviderService(): FridayProviderService {
  return {
    listProviders: async () => [],
    getProvider: async () => null,
    createProvider: async () => ({}) as never,
    updateProvider: async () => ({}) as never,
    deleteProvider: async () => undefined,
    validateProvider: async () => ({ status: "ok" as const, checkedAt: new Date(0).toISOString() }),
    getRoutingConfig: async () => ({ defaultProviderId: "", fallbackProviderIds: [] }),
    setRoutingConfig: async (input) => input,
    resolveRoute: async () => ({}) as never,
    runWithFallback: async () => ({}) as never,
  } as unknown as FridayProviderService;
}

const usedPorts = new Set<number>();
async function findEphemeralPortAbove(min: number): Promise<number> {
  const lo = Math.max(min + 1, 49153);
  const hi = 65535;
  const span = hi - lo + 1;
  for (let attempt = 0; attempt < 512; attempt += 1) {
    const candidate = lo + ((attempt * 3671 + 5003) % span);
    if (usedPorts.has(candidate)) continue;
    const bound = await new Promise<number | null>((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(null));
      srv.listen(candidate, "127.0.0.1", () => srv.close((e) => resolve(e ? null : candidate)));
    });
    if (bound !== null && bound > min) {
      usedPorts.add(bound);
      return bound;
    }
  }
  throw new Error(`could not allocate an ephemeral port > ${min}`);
}

interface Harness {
  server: FridayHttpServer;
  db: FridaySqliteLayer;
  post(path: string, body: unknown): Promise<{ status: number; json: any }>;
  get(path: string): Promise<{ status: number; json: any }>;
}

async function makeHarness(opts: {
  resolver?: NativeOwnerClaimContextResolver;
  surfaceAvailable?: () => boolean;
}): Promise<Harness> {
  const db = createTestDb();
  const runtime = createFridayApiRuntime({
    db,
    idGenerator: (() => {
      let n = 0;
      return () => `id-${String(++n).padStart(5, "0")}`;
    })(),
    nowIso: () => new Date().toISOString(),
    providerService: mockProviderService(),
    tokenSecret: crypto.randomBytes(32).toString("hex"), // pragma: allowlist secret
    computeChecksum: (content: string) => `checksum-${content.length}`,
    resolveSkill: () => null,
    invokeSkill: async () => ({}),
    ...(opts.resolver ? { resolveNativeOwnerClaimContext: opts.resolver } : {}),
    ...(opts.surfaceAvailable ? { nativeOwnerClaimSurfaceAvailable: opts.surfaceAvailable } : {}),
  });
  const port = await findEphemeralPortAbove(49152);
  const server = createFridayHttpServer({
    routes: runtime.routes,
    wsGateway: runtime.wsGateway,
    middleware: runtime.middleware,
    port,
    host: "127.0.0.1",
    logRequests: false,
  });
  await server.listen();
  const baseUrl = `http://127.0.0.1:${port}`;

  const request = async (method: string, path: string, body?: unknown) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: { "content-type": "application/json", origin: ORIGIN, connection: "close" },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        let json: any = null;
        try { json = await res.json(); } catch { json = null; }
        return { status: res.status, json };
      } catch (err) {
        if (attempt === 2) throw err;
      }
    }
    throw new Error("unreachable");
  };
  return {
    server,
    db,
    post: (path, body) => request("POST", path, body),
    get: (path) => request("GET", path),
  };
}

/** Issue a bootstrap challenge and attempt to claim the owner slot with `key`. */
async function attemptClaim(h: Harness, key: TestDeviceKey): Promise<{ status: number; json: any }> {
  const challenge = (await h.post("/v1/auth/bootstrap/challenge", {
    installId: INSTALL_ID,
    osUser: OS_USER,
    origin: ORIGIN,
  })).json.data;
  const transcript = makeTranscript(key, {
    action: challenge.action,
    nonce: challenge.nonce,
    origin: challenge.origin,
    deviceId: DEVICE_ID,
    hubId: challenge.hubId,
    installId: challenge.installId,
    osUser: challenge.osUser,
    expiresAt: challenge.expiresAt,
  });
  return h.post("/v1/auth/bootstrap/device-claim", {
    nonce: challenge.nonce,
    devicePublicKey: key.spkiDerBase64,
    deviceId: DEVICE_ID,
    origin: challenge.origin,
    installId: challenge.installId,
    osUser: challenge.osUser,
    deviceClaimProof: {
      transcript,
      signature: { encoding: "ieee-p1363-base64", value: signTranscriptLowS(key, transcript) },
    },
  });
}

/** Claim (must succeed) then deviceKeyLogin with `key`; returns the login response. */
async function claimAndLogin(h: Harness, key: TestDeviceKey): Promise<{ status: number; json: any }> {
  const claim = await attemptClaim(h, key);
  expect(claim.json?.data?.claimed).toBe(true);
  const loginChallenge = (await h.post("/v1/auth/login/challenge", {
    installId: INSTALL_ID,
    osUser: OS_USER,
    origin: ORIGIN,
    deviceId: DEVICE_ID,
    devicePublicKey: key.spkiDerBase64,
  })).json.data;
  const transcript = makeTranscript(key, {
    action: "owner-login",
    nonce: loginChallenge.nonce,
    origin: loginChallenge.origin,
    deviceId: DEVICE_ID,
    hubId: loginChallenge.hubId,
    installId: loginChallenge.installId,
    osUser: loginChallenge.osUser,
    expiresAt: loginChallenge.expiresAt,
  });
  return h.post("/v1/auth/login", {
    devicePublicKey: key.spkiDerBase64,
    deviceId: DEVICE_ID,
    origin: loginChallenge.origin,
    deviceLoginProof: {
      transcript,
      signature: { encoding: "ieee-p1363-base64", value: signTranscriptLowS(key, transcript) },
    },
  });
}

describe("SEC-NATIVE-OWNER-CLAIM-CAPABILITY-001 (F1): device-claim surface + resolver wiring", () => {
  const servers: FridayHttpServer[] = [];
  const dbs: FridaySqliteLayer[] = [];
  const savedEnv: Record<string, string | undefined> = {
    FRIDAY_RELEASE_TAG: process.env.FRIDAY_RELEASE_TAG,
    [DEVICE_OWNER_AUTHORITY_KILL_SWITCH_ENV]: process.env[DEVICE_OWNER_AUTHORITY_KILL_SWITCH_ENV],
  };

  afterEach(async () => {
    while (servers.length) await servers.pop()!.close();
    while (dbs.length) dbs.pop()!.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function harness(opts: Parameters<typeof makeHarness>[0]): Promise<Harness> {
    const h = await makeHarness(opts);
    servers.push(h.server);
    dbs.push(h.db);
    return h;
  }

  it("HONESTY: NATIVE_IPC_ATTESTATION_AVAILABLE stays false", () => {
    expect(NATIVE_IPC_ATTESTATION_AVAILABLE).toBe(false);
  });

  it("RELEASE FIXTURE: deviceClaimAvailable:true, passphrase CREATION retired, device claim→login mints a user.id session", async () => {
    // Release profile → passphrase creation retired; resolver+surface injected (as a
    // signed native slice supplies) so the capability is actually mintable.
    process.env.FRIDAY_RELEASE_TAG = "v1-f1-acceptance";
    const h = await harness({
      resolver: createTestNativeOwnerResolver(),
      surfaceAvailable: () => true,
    });

    const status = await h.get("/v1/auth/bootstrap/status");
    expect(status.json.data.deviceClaimAvailable).toBe(true);
    expect(status.json.data.bootstrapRequired).toBe(true);

    // On a release profile, creating a fresh passphrase owner is retired (device-native).
    const passphrase = await h.post("/v1/auth/bootstrap/local-passphrase", { passphrase: "friday-f1-should-be-retired" });
    expect(passphrase.status).toBe(403);
    expect(passphrase.json.error.code).toBe("AUTH_BOOTSTRAP_PASSPHRASE_RETIRED");

    const owner = generateTestDeviceKey();
    const login = await claimAndLogin(h, owner);
    expect(login.status).toBe(200);
    expect(login.json.data.accessToken).toBeTruthy();
    // The minted session principal is the ordinary local owner user.id — NOT device-owner:.
    expect(login.json.data.user.id).not.toContain("device-owner:");
  });

  it("DEFAULT dev/CI: no resolver + non-release → deviceClaimAvailable:false (passphrase gate)", async () => {
    delete process.env.FRIDAY_RELEASE_TAG;
    const h = await harness({}); // runtime defaults: honest-absent resolver + release-gated surface
    const status = await h.get("/v1/auth/bootstrap/status");
    expect(status.json.data.deviceClaimAvailable).toBe(false);
    expect(status.json.data.bootstrapRequired).toBe(true);
  });

  it("HONESTY: surface present but UNSIGNED (no mintable capability) → device claim fails CLOSED, login challenge still live", async () => {
    // The surface is honestly present (UI shows the device gate) but the resolver mints
    // NOTHING on this unsigned tree — the capability is UNMINTABLE. Never fake-enabled.
    const h = await harness({ surfaceAvailable: () => true }); // NO resolver → runtime default → null

    const status = await h.get("/v1/auth/bootstrap/status");
    expect(status.json.data.deviceClaimAvailable).toBe(true);

    const owner = generateTestDeviceKey();
    const claim = await attemptClaim(h, owner);
    expect(claim.status).toBe(401);
    expect(claim.json.error.code).toBe("AUTH_BOOTSTRAP_DEVICE_AUTHORITY_UNVERIFIED");
    // The owner slot stays unclaimed (fail-closed, zero state change).
    const status2 = await h.get("/v1/auth/bootstrap/status");
    expect(status2.json.data.bootstrapRequired).toBe(true);
    // A fresh login challenge can still be issued (nothing was burned).
    const lc = await h.post("/v1/auth/login/challenge", {
      installId: INSTALL_ID,
      osUser: OS_USER,
      origin: ORIGIN,
      deviceId: DEVICE_ID,
      devicePublicKey: owner.spkiDerBase64,
    });
    expect(lc.status).toBe(200);
    expect(lc.json.data.nonce).toBeTruthy();
  });

  it("KILL SWITCH: even with a resolver present, device claim is refused", async () => {
    process.env[DEVICE_OWNER_AUTHORITY_KILL_SWITCH_ENV] = "1";
    const h = await harness({
      resolver: createTestNativeOwnerResolver(),
      surfaceAvailable: () => true,
    });
    const owner = generateTestDeviceKey();
    const claim = await attemptClaim(h, owner);
    expect(claim.status).toBe(401);
    expect(claim.json.error.code).toBe("AUTH_BOOTSTRAP_DEVICE_AUTHORITY_UNVERIFIED");
  });
});

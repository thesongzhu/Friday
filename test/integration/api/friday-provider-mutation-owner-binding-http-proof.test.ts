// ─── SEC-APPROVAL-AUTHORITY-001 · CORE-A CR-2 (Option B*) — production public-seam ──
//
// F2 acceptance: the device-authored provider-mutation approval path admits ONLY
// when driven through the REAL production auth surface — a genuine owner-bootstrap →
// deviceKeyLogin session whose principal is the ordinary local owner `user.id` (NOT a
// fabricated `device-owner:` token) — and the server resolves the durable owner↔device
// binding (`users.password_hash = device-owner$v1$<sha256Hex(devicePublicKey)>`)
// SERVER-SIDE. Everything runs through `createFridayApiRuntime` over real HTTP:
//   bootstrap/challenge → device-claim → login/challenge → deviceKeyLogin →
//   POST /v1/providers/plan → /plan/confirm (device-authored) → POST /v1/providers.
//
// Native attestation is honestly ABSENT on this tree; the device claim/login are made
// mintable ONLY by injecting a resolver that runs the REAL capability mint over
// injected native-evidence doubles (`createTestNativeOwnerResolver`), exactly as a
// signed release supplies from the Companion accept boundary. No test fabricates a
// `device-owner:` token via `encodeToken`, and `NATIVE_IPC_ATTESTATION_AVAILABLE`
// stays `false`.

import * as crypto from "node:crypto";
import * as net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createFridayApiRuntime, createFridayHttpServer } from "#api";
import type { FridayHttpServer } from "#api";
import type { FridayProviderProfile, FridayProviderService } from "#providers";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../helpers/friday-test-db.helper.js";
import { createTestNativeOwnerResolver } from "../../adversarial/_native-owner-capability.helpers.js";
import {
  generateTestDeviceKey,
  makeTranscript,
  signTranscriptLowS,
  type TestDeviceKey,
} from "../../adversarial/_secsetup-s2a.helpers.js";
import {
  deviceOwnerPrincipalIdFor,
  makeApprovalProof,
  makeApprovalTranscript,
} from "../../helpers/friday-provider-approval-test-kit.js";
import { NATIVE_IPC_ATTESTATION_AVAILABLE } from "../../../src/security/friday-device-owner-authority-precondition.js";

const ORIGIN = "https://friday.localhost";
const INSTALL_ID = "install-owner-binding-1";
const OS_USER = "jarvis";

const CREATE_PARAMS = {
  kind: "openai" as const,
  name: "OpenAI",
  baseUrl: "https://api.openai.com",
  authMode: "api-key" as const,
  api: "openai-completions" as const,
  supportedModels: ["gpt-4o"],
  apiKey: "sk-mock-owner-binding", // pragma: allowlist secret
};

function sampleProfile(): FridayProviderProfile {
  return {
    id: "p-owner-binding",
    kind: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com",
    enabled: true,
    defaultModel: "gpt-4o",
    config: {
      api: "openai-completions",
      authMode: "api-key",
      keySource: { kind: "env-ref", envVar: "OPENAI_API_KEY" },
      supportedModels: ["gpt-4o"],
      validation: { status: "ok", checkedAt: new Date(0).toISOString() },
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function mockProviderService(): FridayProviderService {
  let created: FridayProviderProfile | null = null;
  return {
    listProviders: async () => (created ? [created] : []),
    getProvider: async () => created,
    createProvider: async () => {
      created = sampleProfile();
      return created;
    },
    updateProvider: async () => ({}) as never,
    deleteProvider: async () => undefined,
    validateProvider: async () => ({ status: "ok" as const, checkedAt: new Date(0).toISOString() }),
    getRoutingConfig: async () => ({ defaultProviderId: "p-owner-binding", fallbackProviderIds: [] }),
    setRoutingConfig: async (input) => input,
    resolveRoute: async () => ({}) as never,
    runWithFallback: async () => ({}) as never,
  } as unknown as FridayProviderService;
}

// Track ports already handed out in this file so consecutive per-test servers NEVER
// reuse a port — a reused port would let the global fetch (undici) keep-alive pool
// dial a stale connection to a closed prior server → ECONNRESET.
const usedPorts = new Set<number>();

async function findEphemeralPortAbove(min: number): Promise<number> {
  const lo = Math.max(min + 1, 49153);
  const hi = 65535;
  const span = hi - lo + 1;
  for (let attempt = 0; attempt < 512; attempt += 1) {
    const candidate = lo + ((attempt * 2861 + 7919) % span);
    if (usedPorts.has(candidate)) continue;
    const bound = await new Promise<number | null>((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(null));
      srv.listen(candidate, "127.0.0.1", () => {
        srv.close((e) => resolve(e ? null : candidate));
      });
    });
    if (bound !== null && bound > min) {
      usedPorts.add(bound);
      return bound;
    }
  }
  throw new Error(`could not allocate an ephemeral port > ${min}`);
}

interface Harness {
  baseUrl: string;
  db: FridaySqliteLayer;
  server: FridayHttpServer;
  post(path: string, body: unknown, token?: string): Promise<{ status: number; json: any }>;
}

async function makeHarness(opts: { releaseNativeOnly?: boolean } = {}): Promise<Harness> {
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
    canonicalMutatingActionGate: true,
    computeChecksum: (content: string) => `checksum-${content.length}`,
    resolveSkill: () => null,
    invokeSkill: async () => ({}),
    // Option C: inject a resolver that runs the REAL capability mint over injected
    // native-evidence doubles, so the REAL device claim/login mint. Surface true →
    // the bootstrap-status honestly reports device-claim availability. Absent for the
    // passphrase-owner negative below (that hub keeps the passphrase path live).
    ...(opts.releaseNativeOnly
      ? {}
      : {
          resolveNativeOwnerClaimContext: createTestNativeOwnerResolver(),
          nativeOwnerClaimSurfaceAvailable: () => true,
        }),
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

  const post = async (path: string, body: unknown, token?: string) => {
    const doFetch = () =>
      fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          connection: "close", // avoid keep-alive pooling across per-test servers
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    let res: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        res = await doFetch();
        break;
      } catch (err) {
        // A stale keep-alive connection to a prior server can surface as ECONNRESET;
        // a fresh dial succeeds. Retry a bounded number of times.
        if (attempt === 2) throw err;
      }
    }
    let json: any = null;
    try {
      json = await res!.json();
    } catch {
      json = null;
    }
    return { status: res!.status, json };
  };

  return { baseUrl, db, server, post };
}

/** Real owner-bootstrap → deviceKeyLogin with `key`; returns the session token + user id. */
async function deviceOwnerLogin(
  h: Harness,
  key: TestDeviceKey,
  deviceId = "device-owner-binding-1",
): Promise<{ token: string; userId: string }> {
  const challenge = (await h.post("/v1/auth/bootstrap/challenge", {
    installId: INSTALL_ID,
    osUser: OS_USER,
    origin: ORIGIN,
  })).json.data;
  const claimTranscript = makeTranscript(key, {
    action: challenge.action,
    nonce: challenge.nonce,
    origin: challenge.origin,
    deviceId,
    hubId: challenge.hubId,
    installId: challenge.installId,
    osUser: challenge.osUser,
    expiresAt: challenge.expiresAt,
  });
  const claim = await h.post("/v1/auth/bootstrap/device-claim", {
    nonce: challenge.nonce,
    devicePublicKey: key.spkiDerBase64,
    deviceId,
    origin: challenge.origin,
    installId: challenge.installId,
    osUser: challenge.osUser,
    deviceClaimProof: {
      transcript: claimTranscript,
      signature: { encoding: "ieee-p1363-base64", value: signTranscriptLowS(key, claimTranscript) },
    },
  });
  expect(claim.json?.data?.claimed ?? claim.json?.claimed).toBe(true);

  const loginChallenge = (await h.post("/v1/auth/login/challenge", {
    installId: INSTALL_ID,
    osUser: OS_USER,
    origin: ORIGIN,
    deviceId,
    devicePublicKey: key.spkiDerBase64,
  })).json.data;
  const loginTranscript = makeTranscript(key, {
    action: "owner-login",
    nonce: loginChallenge.nonce,
    origin: loginChallenge.origin,
    deviceId,
    hubId: loginChallenge.hubId,
    installId: loginChallenge.installId,
    osUser: loginChallenge.osUser,
    expiresAt: loginChallenge.expiresAt,
  });
  const login = await h.post("/v1/auth/login", {
    devicePublicKey: key.spkiDerBase64,
    deviceId,
    origin: loginChallenge.origin,
    deviceLoginProof: {
      transcript: loginTranscript,
      signature: { encoding: "ieee-p1363-base64", value: signTranscriptLowS(key, loginTranscript) },
    },
  });
  const data = login.json.data;
  expect(data?.accessToken).toBeTruthy();
  // The session principal is the ordinary local owner user.id — NOT a device-owner id.
  expect(data.user.id).not.toContain("device-owner:");
  return { token: data.accessToken as string, userId: data.user.id as string };
}

/** Plan → device-authored confirm; returns { planDigest, canonicalApproval } (or throws on refusal). */
async function planAndConfirm(
  h: Harness,
  token: string,
  approvalKey: TestDeviceKey,
  opts: { decidedByPrincipalId?: string } = {},
): Promise<{ status: number; json: any }> {
  const planResp = await h.post("/v1/providers/plan", { action: "providers.create", params: CREATE_PARAMS }, token);
  if (!planResp.json?.data?.plan) {
    throw new Error(`plan failed (status ${planResp.status}): ${JSON.stringify(planResp.json)}`);
  }
  const planned = planResp.json.data.plan as { planDigest: string; actionDigest: string };
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const transcript = makeApprovalTranscript(approvalKey, {
    actionDigest: planned.actionDigest,
    decidedByPrincipalId: opts.decidedByPrincipalId ?? deviceOwnerPrincipalIdFor(approvalKey),
    approvalId: "approval-owner-binding-1",
    expiresAt,
  });
  const deviceApproval = makeApprovalProof(approvalKey, transcript);
  const confirm = await h.post(
    "/v1/providers/plan/confirm",
    { planDigest: planned.planDigest, confirm: true, deviceApproval },
    token,
  );
  return { status: confirm.status, json: { ...confirm.json, planDigest: planned.planDigest } };
}

describe("SEC-APPROVAL-AUTHORITY-001 (Option B*): provider mutation binds to the authenticated owner's device", () => {
  const servers: FridayHttpServer[] = [];
  const dbs: FridaySqliteLayer[] = [];

  afterEach(async () => {
    while (servers.length) await servers.pop()!.close();
    while (dbs.length) dbs.pop()!.close();
  });

  async function harness(opts?: { releaseNativeOnly?: boolean }): Promise<Harness> {
    const h = await makeHarness(opts);
    servers.push(h.server);
    dbs.push(h.db);
    return h;
  }

  it("HONESTY: NATIVE_IPC_ATTESTATION_AVAILABLE stays false", () => {
    expect(NATIVE_IPC_ATTESTATION_AVAILABLE).toBe(false);
  });

  it("ADMITS + PERSISTS a device-authored mutation through the REAL owner session (principal = user.id)", async () => {
    const h = await harness();
    const owner = generateTestDeviceKey();
    const { token, userId } = await deviceOwnerLogin(h, owner);

    // The durable binding is the sentinel — resolved server-side, principal stays user.id.
    const storedHash = h.db.withReadConnection((c) =>
      (c.prepare("SELECT password_hash AS h FROM users WHERE id = ?").get(userId) as { h: string }).h,
    );
    expect(storedHash).toBe(`device-owner$v1$${crypto.createHash("sha256").update(owner.spkiDerBase64).digest("hex")}`);

    const confirmed = await planAndConfirm(h, token, owner);
    expect(confirmed.status).toBe(200);
    const approval = confirmed.json.data.approval.canonicalApproval;
    expect(approval.issuer).toBe("friday_device_owner");

    const mutate = await h.post(
      "/v1/providers",
      { ...CREATE_PARAMS, planDigest: confirmed.json.planDigest, canonicalApproval: approval },
      token,
    );
    if (mutate.status !== 200) throw new Error(`mutate failed: ${JSON.stringify(mutate.json)}`);
    expect(mutate.status).toBe(200);
    expect(mutate.json.ok).toBe(true);
    expect(mutate.json.data.provider.id).toBe("p-owner-binding");
  });

  it("NEGATIVE (1): an approval signed by a DIFFERENT owner device is refused", async () => {
    const h = await harness();
    const owner = generateTestDeviceKey();
    const attacker = generateTestDeviceKey();
    const { token } = await deviceOwnerLogin(h, owner);

    // The attacker signs with its own key but claims to be the owner device.
    const confirm = await planAndConfirm(h, token, attacker, {
      decidedByPrincipalId: deviceOwnerPrincipalIdFor(attacker),
    });
    expect(confirm.status).toBe(403);
    expect(confirm.json.error.code).toBe("PROVIDER_MUTATION_APPROVAL_DEVICE_NOT_BOUND");
  });

  it("NEGATIVE (2): a PASSPHRASE owner (no device binding) cannot use a device-authored approval", async () => {
    const h = await harness({ releaseNativeOnly: false });
    // Passphrase-bootstrap the local owner (no device sentinel is ever written).
    await h.post("/v1/auth/bootstrap/local-passphrase", { passphrase: "friday-owner-binding-pass" });
    const login = await h.post("/v1/auth/login", { localPassphrase: "friday-owner-binding-pass" });
    const token = login.json.data.accessToken as string;
    expect(token).toBeTruthy();

    const some = generateTestDeviceKey();
    const confirm = await planAndConfirm(h, token, some);
    expect(confirm.status).toBe(403);
    expect(confirm.json.error.code).toBe("PROVIDER_MUTATION_APPROVAL_DEVICE_NOT_BOUND");
  });

  it("NEGATIVE (3): cross-device — an approval bound to another owner's device is refused", async () => {
    const h = await harness();
    const owner = generateTestDeviceKey();
    const otherOwnerDevice = generateTestDeviceKey();
    const { token } = await deviceOwnerLogin(h, owner);

    // A structurally valid, self-consistent approval — but for a DIFFERENT device than
    // the one bound to the authenticated owner.
    const confirm = await planAndConfirm(h, token, otherOwnerDevice, {
      decidedByPrincipalId: deviceOwnerPrincipalIdFor(otherOwnerDevice),
    });
    expect(confirm.status).toBe(403);
    expect(confirm.json.error.code).toBe("PROVIDER_MUTATION_APPROVAL_DEVICE_NOT_BOUND");
  });
});

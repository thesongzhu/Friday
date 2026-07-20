// ─── SEC-APPROVAL-AUTHORITY-001 · CORE-A round-3 Lane B (Advisor round-2 finding #3) ──
//
// Authoritative DURABLE-SINK readback: a device-authored provider-mutation approval that
// is confirmed + consumed ONCE cannot be replayed after a restart, nor by a concurrent
// request. Everything runs through the REAL production public seam — a genuine
// owner-bootstrap → deviceKeyLogin session, the REAL sqlite-backed provider service, and
// the durable v108 consumption ledger — over real HTTP:
//   bootstrap/challenge → device-claim → login → plan → confirm (device-authored) →
//   POST /v1/providers, then a fresh runtime on the SAME db replays the identical approval.
//
// The provider TABLE is read directly to assert ZERO second durable side-effect. Native
// attestation stays honestly ABSENT (`createTestNativeOwnerResolver` mints the claim/login
// capability over injected native-evidence doubles, exactly as a signed release supplies).

import * as crypto from "node:crypto";
import * as net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createFridayApiRuntime, createFridayHttpServer } from "#api";
import type { FridayHttpServer } from "#api";
import { createFridayProviderService, resetMasterKeyCache } from "#providers";
import type { FridayProviderService } from "#providers";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";
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

const ORIGIN = "https://friday.localhost";
const INSTALL_ID = "install-approval-consumption-1";
const OS_USER = "jarvis";

// validateOnSave:false + an env-ref key → the real service persists with NO network probe
// and NO secret encryption (no master key needed), so the create is a pure durable write.
const CREATE_PARAMS = {
  kind: "openai" as const,
  name: "OpenAI",
  baseUrl: "https://api.openai.com",
  authMode: "api-key" as const,
  api: "openai-completions" as const,
  supportedModels: ["gpt-4o"],
  apiKey: "$OPENAI_API_KEY",
  preserveEnvRef: true,
  validateOnSave: false,
};

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
  db: FridaySqliteLayer;
  server: FridayHttpServer;
  service: FridayProviderService;
  post(path: string, body: unknown, token?: string): Promise<{ status: number; json: any }>;
}

/** Build a runtime + server on the given db, with the REAL sqlite-backed provider service. */
async function makeHarness(db: FridaySqliteLayer, tokenSecret: string): Promise<Harness> {
  const service = createFridayProviderService({
    db,
    idGenerator: createTestIdGenerator(),
    nowIso: () => new Date().toISOString(),
  });
  const runtime = createFridayApiRuntime({
    db,
    idGenerator: (() => {
      let n = 0;
      return () => `id-${String(++n).padStart(5, "0")}`;
    })(),
    nowIso: () => new Date().toISOString(),
    providerService: service,
    tokenSecret,
    canonicalMutatingActionGate: true,
    computeChecksum: (content: string) => `checksum-${content.length}`,
    resolveSkill: () => null,
    invokeSkill: async () => ({}),
    resolveNativeOwnerClaimContext: createTestNativeOwnerResolver(),
    nativeOwnerClaimSurfaceAvailable: () => true,
  });

  // Allocate + listen with a bounded retry: the probe→bind window can race a sibling
  // integration suite that dialed the same ephemeral port (EADDRINUSE), so re-allocate.
  let port = 0;
  let server: FridayHttpServer | null = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    port = await findEphemeralPortAbove(51000 + attempt * 500);
    const candidate = createFridayHttpServer({
      routes: runtime.routes,
      wsGateway: runtime.wsGateway,
      middleware: runtime.middleware,
      port,
      host: "127.0.0.1",
      logRequests: false,
    });
    try {
      await candidate.listen();
      server = candidate;
      break;
    } catch (err) {
      await candidate.close().catch(() => {});
      if (attempt === 7 || (err as NodeJS.ErrnoException)?.code !== "EADDRINUSE") throw err;
    }
  }
  if (!server) throw new Error("could not bind an ephemeral port for the test server");
  const baseUrl = `http://127.0.0.1:${port}`;

  const post = async (path: string, body: unknown, token?: string) => {
    const doFetch = () =>
      fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          connection: "close",
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

  return { db, server, service, post };
}

async function bootstrapAndClaim(h: Harness, key: TestDeviceKey, deviceId: string): Promise<void> {
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
}

/** Login only (device already claimed) → session token + user id. */
async function loginOnly(
  h: Harness,
  key: TestDeviceKey,
  deviceId: string,
): Promise<{ token: string; userId: string }> {
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
  expect(data.user.id).not.toContain("device-owner:");
  return { token: data.accessToken as string, userId: data.user.id as string };
}

/** Plan → device-authored confirm; returns the confirmed canonical approval + plan digest. */
async function planAndConfirm(
  h: Harness,
  token: string,
  approvalKey: TestDeviceKey,
): Promise<{ planDigest: string; approval: any }> {
  const planResp = await h.post("/v1/providers/plan", { action: "providers.create", params: CREATE_PARAMS }, token);
  const planned = planResp.json?.data?.plan as { planDigest: string; actionDigest: string };
  if (!planned) throw new Error(`plan failed (status ${planResp.status}): ${JSON.stringify(planResp.json)}`);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const transcript = makeApprovalTranscript(approvalKey, {
    actionDigest: planned.actionDigest,
    decidedByPrincipalId: deviceOwnerPrincipalIdFor(approvalKey),
    approvalId: "approval-consumption-1",
    expiresAt,
  });
  const deviceApproval = makeApprovalProof(approvalKey, transcript);
  const confirm = await h.post(
    "/v1/providers/plan/confirm",
    { planDigest: planned.planDigest, confirm: true, deviceApproval },
    token,
  );
  if (confirm.status !== 200) throw new Error(`confirm failed: ${JSON.stringify(confirm.json)}`);
  return { planDigest: planned.planDigest, approval: confirm.json.data.approval.canonicalApproval };
}

function countProviderRows(db: FridaySqliteLayer): number {
  return db.withReadConnection((c) =>
    (c.prepare("SELECT COUNT(*) AS n FROM provider_profiles").get() as { n: number }).n,
  );
}

function consumptionStatus(db: FridaySqliteLayer): string[] {
  return db
    .withReadConnection((c) =>
      c.prepare("SELECT status FROM provider_mutation_approval_consumption").all() as Array<{ status: string }>,
    )
    .map((r) => r.status);
}

describe("SEC-APPROVAL-AUTHORITY-001: a consumed provider approval cannot be replayed (durable)", () => {
  const servers: FridayHttpServer[] = [];
  const dbs: FridaySqliteLayer[] = [];

  afterEach(async () => {
    while (servers.length) await servers.pop()!.close();
    while (dbs.length) dbs.pop()!.close();
    resetMasterKeyCache();
  });

  async function harness(db: FridaySqliteLayer, tokenSecret: string): Promise<Harness> {
    // No global fetch mock: the test's own HTTP client uses fetch to hit the server, and
    // validateOnSave:false means the provider service performs NO network probe.
    const h = await makeHarness(db, tokenSecret);
    servers.push(h.server);
    return h;
  }

  it("RESTART REPLAY: a fresh process on the SAME db refuses the identical approval, ZERO second effect", async () => {
    const db = createTestDb();
    dbs.push(db);
    const tokenSecret = crypto.randomBytes(32).toString("hex");
    const deviceId = "device-consumption-1";
    const owner = generateTestDeviceKey();

    // ── Process 1: full flow, confirm + mutate ONCE ──
    const h1 = await harness(db, tokenSecret);
    await bootstrapAndClaim(h1, owner, deviceId);
    const login1 = await loginOnly(h1, owner, deviceId);
    const { planDigest, approval } = await planAndConfirm(h1, login1.token, owner);

    const mutate1 = await h1.post(
      "/v1/providers",
      { ...CREATE_PARAMS, planDigest, canonicalApproval: approval },
      login1.token,
    );
    if (mutate1.status !== 200) throw new Error(`first mutate failed: ${JSON.stringify(mutate1.json)}`);
    expect(mutate1.json.ok).toBe(true);
    expect(countProviderRows(db)).toBe(1);
    // The approval is durably consumed.
    expect(consumptionStatus(db)).toEqual(["consumed"]);

    // ── "Restart": a brand-new runtime + gate + consumption store on the SAME db ──
    // (same tokenSecret + the persisted session ⇒ the owner's token is still valid, so we
    // isolate the variable under test to the fresh in-memory gate/store on the same db.)
    await servers.pop()!.close(); // close process-1 server
    const h2 = await harness(db, tokenSecret);

    // Replay the IDENTICAL confirmed approval against the fresh process.
    const replay = await h2.post(
      "/v1/providers",
      { ...CREATE_PARAMS, planDigest, canonicalApproval: approval },
      login1.token,
    );
    expect(replay.status).toBe(403);
    expect(JSON.stringify(replay.json)).toContain("canonical_approval_already_used");

    // Authoritative durable-sink readback: NO second provider row was written.
    expect(countProviderRows(db)).toBe(1);
    expect(consumptionStatus(db)).toEqual(["consumed"]);
  });

  it("CONCURRENT REPLAY: two simultaneous mutates with the same approval → exactly ONE effect", async () => {
    const db = createTestDb();
    dbs.push(db);
    const tokenSecret = crypto.randomBytes(32).toString("hex");
    const deviceId = "device-consumption-2";
    const owner = generateTestDeviceKey();

    const h = await harness(db, tokenSecret);
    await bootstrapAndClaim(h, owner, deviceId);
    const { token } = await loginOnly(h, owner, deviceId);
    const { planDigest, approval } = await planAndConfirm(h, token, owner);

    const body = { ...CREATE_PARAMS, planDigest, canonicalApproval: approval };
    const [a, b] = await Promise.all([
      h.post("/v1/providers", body, token),
      h.post("/v1/providers", body, token),
    ]);

    const statuses = [a.status, b.status].sort();
    // Exactly one 200 winner; the other refused (403 already-used / denied).
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s !== 200)).toHaveLength(1);
    const refused = a.status === 200 ? b : a;
    expect(JSON.stringify(refused.json)).toContain("canonical_approval_already_used");

    // Exactly ONE durable provider effect.
    expect(countProviderRows(db)).toBe(1);
    expect(consumptionStatus(db)).toEqual(["consumed"]);
  });
});

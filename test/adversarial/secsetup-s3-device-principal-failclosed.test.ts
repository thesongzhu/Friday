/**
 * SEC-SETUP-BOOTSTRAP-001 · Slice 3 — fail-closed DISABLED device-principal
 * owner data/control plumbing (adversarial, service + floor level).
 *
 * This proves the DISABLED device principal is refused everywhere and that S1
 * claim/nonce-possession confers ZERO authority — WITHOUT granting any device
 * real owner authority. Every device path here is fail-closed because the
 * server-derived device-authority switch is OFF (native-IPC precondition (b) is
 * ABSENT) and keyProtection is `unverified`.
 *
 * Red-first: each guard is load-bearing — reverting it flips a MUST-REFUSE row
 * from 401/403 back to allow (see PR body red→green→revert-red evidence).
 *
 * Groups (inventory §3.1/§3.2, §4):
 *   A — device mint seam fails closed; the switch is server-derived only.
 *   B — floors refuse a (synthesized) device principal exactly like anonymous.
 *   E1 — conversational session-dispatch refuses a device-owner actor id.
 *   PoP — device-claim requires proof-of-possession; nonce not burned on failure.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFridayAuthService } from "#api";
import { FridayDomainError } from "#errors";
import { createFridaySqliteLayer } from "#state";
import type { FridaySqliteLayer } from "#state";

import type { FridayAuthPrincipal, FridayScope } from "../../src/api/model/friday-api-auth.types.js";
import {
  assertBoundActorForSessionOperation,
  assertBoundPrincipalAuthorityForOperation,
  assertBoundPrincipalForOperation,
  isReleaseDisabledDevicePrincipal,
  isUnauthenticatedPublicPrincipal,
} from "../../src/security/friday-owner-session-channel-capability.js";
import {
  DEVICE_OWNER_AUTHORITY_KILL_SWITCH_ENV,
  DEVICE_OWNER_PRINCIPAL_TYPE,
  NATIVE_IPC_ATTESTATION_AVAILABLE,
  deriveDeviceKeyProtection,
  deviceOwnerPrincipalId,
  isDeviceOwnerAuthorityEnabled,
  isDeviceOwnerAuthorityKillSwitchEngaged,
  isReleaseTrustedKeyProtection,
  mintDeviceOwnerPrincipal,
  type FridayDeviceKeyProtection,
} from "../../src/security/friday-device-owner-authority-precondition.js";
import { generateTestDeviceKey, makeTranscript, signTranscriptLowS } from "./_secsetup-s2a.helpers.js";
import { createTestNativeOwnerResolver } from "./_native-owner-capability.helpers.js";
import type { NativeOwnerClaimContextResolver } from "../../src/security/attestation/friday-verified-native-owner-claim-context.js";

const OWNER_ID = "admin-001";
const NOW = "2026-07-13T00:00:00.000Z";
const LOOPBACK = "127.0.0.1";
const ORIGIN = "https://friday.localhost";
const DEVICE_KEY = generateTestDeviceKey();
const DEVICE_PUBKEY = DEVICE_KEY.spkiDerBase64;
const DEVICE_ID = "device-s3-001";
const OWNER_SCOPES: FridayScope[] = ["workflow.read", "security.read", "session.read"];

function sha256Hex(v: string): string {
  return crypto.createHash("sha256").update(v).digest("hex");
}

/** A NON-synthetic device principal carrying owner scopes — the danger surface. */
function makeDevicePrincipal(over: Partial<FridayAuthPrincipal> = {}): FridayAuthPrincipal {
  return {
    principalType: DEVICE_OWNER_PRINCIPAL_TYPE,
    principalId: deviceOwnerPrincipalId(sha256Hex("device-key")),
    tenantId: "11111111-1111-1111-1111-111111111111",
    userId: "22222222-2222-2222-2222-222222222222",
    role: "owner",
    scopes: [...OWNER_SCOPES],
    tokenId: "33333333-3333-3333-3333-333333333333",
    tokenKind: "access",
    issuedAt: NOW,
    ...over,
  };
}

// ── SQLite harness (mirrors the slice-1 adversarial suite) ──

function seedOwner(db: FridaySqliteLayer): void {
  db.withWriteTransaction((conn) => {
    conn
      .prepare(
        `INSERT INTO users (id, email, display_name, role, password_hash, is_local_only, last_login_at, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, NULL, 1, NULL, ?, ?, NULL)`,
      )
      .run(OWNER_ID, "admin@friday.dev", "Admin", "admin", NOW, NOW);
  });
}

function makeService(db: FridaySqliteLayer, resolver?: NativeOwnerClaimContextResolver) {
  return createFridayAuthService({
    db,
    idGenerator: (() => {
      let n = 0;
      return () => `id-${String(++n).padStart(4, "0")}`;
    })(),
    nowIso: () => NOW,
    tokenSecret: "test-secret-key-for-device-claim-s3-00", // pragma: allowlist secret
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 604_800,
    hubId: "test-hub",
    bootstrapNonceTtlSec: 300,
    // Option C: default (no resolver) → absent native boundary → device claim
    // fails closed. A test that exercises the granted path injects a resolver that
    // runs the REAL capability mint over injected native-evidence doubles.
    ...(resolver ? { resolveNativeOwnerClaimContext: resolver } : {}),
  });
}

function readOwnerHash(db: FridaySqliteLayer): string | null {
  return db.withReadConnection((conn) => {
    const row = conn.prepare("SELECT password_hash AS h FROM users WHERE id = ?").get(OWNER_ID) as
      | { h: string | null }
      | undefined;
    return row?.h ?? null;
  });
}

function readNonceConsumedAt(db: FridaySqliteLayer, nonce: string): unknown {
  return db.withReadConnection((conn) => {
    const row = conn
      .prepare("SELECT consumed_at FROM friday_setup_bootstrap_nonces WHERE nonce_hash = ?")
      .get(sha256Hex(nonce)) as { consumed_at: unknown } | undefined;
    return row?.consumed_at ?? null;
  });
}

function issueNonce(db: FridaySqliteLayer): string {
  return makeService(db).issueBootstrapChallenge(
    { installId: "install-1", osUser: "jarvis", origin: ORIGIN },
    LOOPBACK,
  ).nonce;
}

function validProof(nonce: string, over: { origin?: string; deviceId?: string } = {}) {
  const transcript = makeTranscript(DEVICE_KEY, {
    nonce,
    origin: over.origin ?? ORIGIN,
    deviceId: over.deviceId ?? DEVICE_ID,
    installId: "install-1",
    osUser: "jarvis",
  });
  return {
    transcript,
    signature: { encoding: "ieee-p1363-base64" as const, value: signTranscriptLowS(DEVICE_KEY, transcript) },
  };
}

function baseClaim(nonce: string, over: Partial<{ origin: string; deviceId: string; devicePublicKey: string }> = {}) {
  return {
    nonce,
    devicePublicKey: over.devicePublicKey ?? DEVICE_PUBKEY,
    deviceId: over.deviceId ?? DEVICE_ID,
    origin: over.origin ?? ORIGIN,
    installId: "install-1",
    osUser: "jarvis",
  };
}

let db: FridaySqliteLayer;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-secsetup-s3-"));
  db = createFridaySqliteLayer({
    dbPath: path.join(tmpDir, "friday.db"),
    readPoolSize: 2,
    pragmas: { busyTimeoutMs: 5_000, synchronous: "NORMAL" },
  });
  seedOwner(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Group A — device mint seam fails closed; switch is server-derived ───

describe("S3 Group A — device mint seam + authority switch (fail-closed)", () => {
  it("RF-A1: mint seam issues NO token/principal while preconditions unmet (PoP-verified, unverified keyProtection)", () => {
    const result = mintDeviceOwnerPrincipal({
      deviceId: DEVICE_ID,
      devicePublicKeyHash: DEVICE_KEY.publicKeyHash,
      ownerUserId: OWNER_ID,
      tenantId: "t-1",
      keyProtection: deriveDeviceKeyProtection(), // "unverified"
      popVerified: true,
      ownerScopes: OWNER_SCOPES,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("mint seam MUST NOT grant authority");
    expect(result.disabled).toBe(true);
    expect(result.deviceAuthorityEnabled).toBe(false);
    // Off because the switch is off (b absent) — never a Secure-Enclave label.
    expect(result.reason).toBe("device-owner-authority-disabled-pending-native-ipc");
    expect(result.keyProtection).toBe("unverified");
  });

  it("RF-A1: even a (hypothetical) hardware-backed keyProtection is disabled while the switch is off", () => {
    const result = mintDeviceOwnerPrincipal({
      deviceId: DEVICE_ID,
      devicePublicKeyHash: DEVICE_KEY.publicKeyHash,
      ownerUserId: OWNER_ID,
      tenantId: "t-1",
      keyProtection: "secure_enclave_os_verified",
      popVerified: true,
      ownerScopes: OWNER_SCOPES,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("switch off ⇒ never mint");
    expect(result.reason).toBe("device-owner-authority-disabled-pending-native-ipc");
  });

  it("RF-A1: mere nonce/claim possession (no PoP) is disabled at the seam", () => {
    const result = mintDeviceOwnerPrincipal({
      deviceId: DEVICE_ID,
      devicePublicKeyHash: DEVICE_KEY.publicKeyHash,
      ownerUserId: OWNER_ID,
      tenantId: "t-1",
      keyProtection: "unverified",
      popVerified: false,
      ownerScopes: OWNER_SCOPES,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("no PoP ⇒ never mint");
    expect(result.reason).toBe("pop-unverified");
  });

  it("Option C: retired global authority is ALWAYS off; NO env forces it on; honesty anchor untouched", () => {
    // Honesty anchor is retired-as-authority but LEFT in place and still false.
    expect(NATIVE_IPC_ATTESTATION_AVAILABLE).toBe(false);
    // There is no global "device authority enabled" — always false, no positive path.
    expect(isDeviceOwnerAuthorityEnabled()).toBe(false);
    // The RETIRED positive opt-in cannot flip it on any more (env is inert here).
    expect(isDeviceOwnerAuthorityEnabled({ FRIDAY_DEVICE_OWNER_AUTHORITY_ENABLED: "1" })).toBe(false);
    // keyProtection derives to a fail-closed state server-side (never trusted).
    const kp: FridayDeviceKeyProtection = deriveDeviceKeyProtection();
    expect(kp).toBe("unverified");
    expect(isReleaseTrustedKeyProtection(kp)).toBe(false);
  });

  it("the retired predicate takes NO request-derived input and no env can force it true", () => {
    // Passing request-shaped facts — or even the retired positive opt-in — as an
    // env-like object does nothing: there is structurally no path to `true`.
    const hostileEnvs: NodeJS.ProcessEnv[] = [
      { origin: "https://friday.localhost" } as unknown as NodeJS.ProcessEnv,
      { "user-agent": "Friday-Native/1.0" } as unknown as NodeJS.ProcessEnv,
      { "x-forwarded-for": "127.0.0.1" } as unknown as NodeJS.ProcessEnv,
      { nonce: "attacker-nonce" } as unknown as NodeJS.ProcessEnv,
      { bundleId: "com.friday.native" } as unknown as NodeJS.ProcessEnv,
      { FRIDAY_DEVICE_OWNER_AUTHORITY_ENABLED: "1" } as unknown as NodeJS.ProcessEnv,
    ];
    for (const env of hostileEnvs) {
      expect(isDeviceOwnerAuthorityEnabled(env)).toBe(false);
    }
  });

  it("kill switch can force OFF but there is NO counterpart that forces ON", () => {
    expect(isDeviceOwnerAuthorityKillSwitchEngaged({})).toBe(false);
    for (const v of ["1", "true", "on", "disable", "disabled"]) {
      expect(
        isDeviceOwnerAuthorityKillSwitchEngaged({ [DEVICE_OWNER_AUTHORITY_KILL_SWITCH_ENV]: v }),
      ).toBe(true);
    }
    // No env value engages "authority ON" — the predicate only ever forces OFF.
    expect(isDeviceOwnerAuthorityKillSwitchEngaged({ [DEVICE_OWNER_AUTHORITY_KILL_SWITCH_ENV]: "off" }))
      .toBe(false);
  });
});

// ─── Group B — floors refuse a device principal exactly like anonymous ───

describe("S3 Group B — enforcement floors refuse the DISABLED device principal", () => {
  it("RF-A2: isUnauthenticatedPublicPrincipal treats a non-synthetic device principal as unauthenticated", () => {
    const device = makeDevicePrincipal();
    expect(isReleaseDisabledDevicePrincipal(device)).toBe(true);
    // The danger surface: device principal is non-synthetic + owner-scoped, yet
    // still refused — proving the floor consults TYPE + switch, not the id shape.
    expect(isUnauthenticatedPublicPrincipal(device)).toBe(true);
  });

  it("positive control: a NON-device principal of identical shape is NOT refused (it is the type+switch, not the shape)", () => {
    const userLike = makeDevicePrincipal({ principalType: "user", principalId: "user:alice" });
    expect(isReleaseDisabledDevicePrincipal(userLike)).toBe(false);
    expect(isUnauthenticatedPublicPrincipal(userLike)).toBe(false);
  });

  it("RF-C1: assertBoundPrincipalForOperation refuses the device principal on a high-risk owner op (401)", () => {
    const device = makeDevicePrincipal();
    let caught: unknown;
    try {
      assertBoundPrincipalForOperation(device, "workflow.run.start", "device");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FridayDomainError);
    expect((caught as FridayDomainError).code).toBe("OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED");
    expect((caught as FridayDomainError).httpStatus).toBe(401);
  });

  it("RF-C1: assertBoundPrincipalAuthorityForOperation refuses the device principal BEFORE scope evaluation (401)", () => {
    const device = makeDevicePrincipal({ scopes: ["runtime.secret.read"] as FridayScope[] });
    let caught: unknown;
    try {
      assertBoundPrincipalAuthorityForOperation(device, "runtime.secret.read", "device", {
        anyOfScopes: ["runtime.secret.read"] as FridayScope[],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FridayDomainError);
    // Bound-principal check fires first → PRINCIPAL_REQUIRED, not AUTHORITY_REQUIRED.
    expect((caught as FridayDomainError).code).toBe("OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED");
    expect((caught as FridayDomainError).httpStatus).toBe(401);
  });
});

// ─── Group E1 — conversational session-dispatch parity ───

describe("S3 Group E1 — session-text dispatch refuses a disabled device actor", () => {
  it("RF-E1: refuses '', whitespace, public:default, system, AND a device-owner actor id", () => {
    const refused = ["", "   ", "public:default", "system", deviceOwnerPrincipalId(sha256Hex("device-key"))];
    for (const actorId of refused) {
      let caught: unknown;
      try {
        assertBoundActorForSessionOperation(actorId, "memory.spine.decide");
      } catch (err) {
        caught = err;
      }
      expect(caught, `actorId=${JSON.stringify(actorId)} must be refused`).toBeInstanceOf(FridayDomainError);
      expect((caught as FridayDomainError).code).toBe("OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED");
    }
  });

  it("positive control: a bound owner/session actor id is accepted", () => {
    expect(assertBoundActorForSessionOperation("owner-session:alice", "memory.spine.decide")).toBe(
      "owner-session:alice",
    );
  });
});

// ─── PoP — device-claim requires proof-of-possession (nonce not burned on failure) ───

describe("S3 PoP — device-claim refuses a PoP-unverified key (nonce-possession ⇏ authority)", () => {
  it("RF-B: a claim with NO proof is refused (400 POP_REQUIRED); owner NULL, nonce unconsumed", () => {
    const nonce = issueNonce(db);
    let caught: unknown;
    try {
      makeService(db).claimOwnerWithDeviceKey(baseClaim(nonce), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FridayDomainError);
    expect((caught as FridayDomainError).code).toBe("AUTH_BOOTSTRAP_POP_REQUIRED");
    expect((caught as FridayDomainError).httpStatus).toBe(400);
    expect(readOwnerHash(db)).toBeNull();
    expect(readNonceConsumedAt(db, nonce)).toBeNull(); // nonce NOT burned
  });

  it("RF-B3: a signature from a DIFFERENT key (nonce-possession, no private-key possession) is refused (401); nonce unconsumed", () => {
    const nonce = issueNonce(db);
    const attackerKey = generateTestDeviceKey();
    // Transcript binds the REAL device key hash + the real nonce/origin/deviceId,
    // but the signature is produced by the attacker key → possession NOT proven.
    const transcript = makeTranscript(DEVICE_KEY, { nonce, origin: ORIGIN, deviceId: DEVICE_ID });
    const forged = {
      transcript,
      signature: { encoding: "ieee-p1363-base64" as const, value: signTranscriptLowS(attackerKey, transcript) },
    };
    let caught: unknown;
    try {
      makeService(db).claimOwnerWithDeviceKey({ ...baseClaim(nonce), deviceClaimProof: forged }, LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FridayDomainError);
    expect((caught as FridayDomainError).code).toBe("AUTH_BOOTSTRAP_POP_INVALID");
    expect((caught as FridayDomainError).httpStatus).toBe(401);
    expect(readOwnerHash(db)).toBeNull();
    expect(readNonceConsumedAt(db, nonce)).toBeNull(); // nonce NOT burned on failed possession
  });

  it("RF-B3: a tampered signature is refused (401); nonce unconsumed", () => {
    const nonce = issueNonce(db);
    const good = validProof(nonce);
    // Flip the base64 payload so the signature no longer verifies.
    const tampered = {
      transcript: good.transcript,
      signature: { encoding: "ieee-p1363-base64" as const, value: Buffer.from(crypto.randomBytes(64)).toString("base64") },
    };
    let caught: unknown;
    try {
      makeService(db).claimOwnerWithDeviceKey({ ...baseClaim(nonce), deviceClaimProof: tampered }, LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).code).toBe("AUTH_BOOTSTRAP_POP_INVALID");
    expect(readOwnerHash(db)).toBeNull();
    expect(readNonceConsumedAt(db, nonce)).toBeNull();
  });

  it("RF-B3: a proof whose transcript does not bind THIS claim (origin mismatch) is refused (401); nonce unconsumed", () => {
    const nonce = issueNonce(db);
    // Sign a valid transcript for a DIFFERENT origin, but submit origin=ORIGIN.
    const mismatched = validProof(nonce, { origin: "https://evil.localhost" });
    let caught: unknown;
    try {
      makeService(db).claimOwnerWithDeviceKey(
        { ...baseClaim(nonce, { origin: ORIGIN }), deviceClaimProof: mismatched },
        LOOPBACK,
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).code).toBe("AUTH_BOOTSTRAP_POP_INVALID");
    expect(readOwnerHash(db)).toBeNull();
    expect(readNonceConsumedAt(db, nonce)).toBeNull();
  });

  // ── LIVE-DEFECT CLOSURE (Advisor Option C, finding #7) ──
  // At head, a valid-PoP claim ATOMICALLY consumed the nonce AND wrote
  // `device-owner$v1$…` while carrying NO native authority — any loopback process
  // with a software key could seize the single owner slot. Option C gates the
  // owner-sentinel write + nonce consume on a per-claim VerifiedNativeOwnerClaimContext.
  it("LIVE-DEFECT CLOSED: a valid-PoP claim with NO native capability is REFUSED with ZERO state change", () => {
    const nonce = issueNonce(db);
    let caught: unknown;
    try {
      // Default service → absent native boundary → no capability.
      makeService(db).claimOwnerWithDeviceKey(
        { ...baseClaim(nonce), deviceClaimProof: validProof(nonce) },
        LOOPBACK,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FridayDomainError);
    expect((caught as FridayDomainError).code).toBe("AUTH_BOOTSTRAP_DEVICE_AUTHORITY_UNVERIFIED");
    // ZERO state change: no owner written (recovery path intact), nonce NOT burned.
    expect(readOwnerHash(db)).toBeNull();
    expect(readNonceConsumedAt(db, nonce)).toBeNull();
  });

  it("granted: a valid-PoP claim WITH a per-claim native capability writes the owner + grants authority", () => {
    const nonce = issueNonce(db);
    const res = makeService(db, createTestNativeOwnerResolver()).claimOwnerWithDeviceKey(
      { ...baseClaim(nonce), deviceClaimProof: validProof(nonce) },
      LOOPBACK,
    );
    expect(res.claimed).toBe(true);
    // A release-trusted native capability was consumed → authority granted + the
    // key-protection posture is the OS-verified Secure-Enclave state.
    expect(res.deviceAuthorityEnabled).toBe(true);
    expect(res.keyProtection).toBe("secure_enclave_os_verified");
    // Owner slot bound to the device sentinel; nonce consumed.
    expect(readOwnerHash(db)).toBe(`device-owner$v1$${sha256Hex(DEVICE_PUBKEY)}`);
    expect(readNonceConsumedAt(db, nonce)).not.toBeNull();
  });
});

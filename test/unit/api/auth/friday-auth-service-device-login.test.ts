// ─── SEC-SETUP-BOOTSTRAP-001 · CR-1 — device-key login mint (RED-FIRST) ───
//
// The device-claim BACKEND already writes a non-scrypt device-owner sentinel to
// users.password_hash, but before CR-1 there was NO device-key login path — a
// device-claimed owner could not obtain a session at all. These tests drive the
// REAL production auth service (real migrations, real P-256 crypto, the REAL S2a
// PoP verifier) through:
//   (1) claim the owner slot with a device key, then log in by proving possession
//       of the bound private key over a fresh `owner-login` transcript,
//   (2) the HONEST native-IPC gate: with attestation disabled (the real build)
//       a cryptographically VALID PoP still mints NOTHING (fall back to passphrase),
//   (3) no cross-path confusion: the device sentinel can NEVER satisfy passphrase
//       login, and a passphrase owner can NEVER be logged in via the device path,
//   (4) negatives: invalid PoP, wrong intent (owner-claim proof replayed as login),
//       wrong presented key, expired/over-TTL transcript — each denied.
//
// TRUTH LABEL: every keypair here is a SOFTWARE dev/test key (see the s2a helper).
// The honesty constant NATIVE_IPC_ATTESTATION_AVAILABLE is asserted false — this
// suite NEVER flips it; it exercises the enabled branch ONLY via the injectable
// authority seam, exactly as a signed-release/native slice would enable it.

import { createHash } from "node:crypto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridayAuthService, FridayAuthError } from "#api";
import type { FridayAuthService } from "#api";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { NATIVE_IPC_ATTESTATION_AVAILABLE } from "../../../../src/security/friday-device-owner-authority-precondition.js";
import {
  generateTestDeviceKey,
  makeTranscript,
  signTranscriptLowS,
  type TestDeviceKey,
} from "../../../adversarial/_secsetup-s2a.helpers.js";

const NOW = "2026-07-13T00:00:00.000Z";
const LOGIN_EXP = "2026-07-13T00:01:00.000Z"; // NOW + 60s (within the 300s login TTL clamp)
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";
const LOOPBACK = "127.0.0.1";
const ORIGIN = "https://friday.localhost";
const DEVICE_ID = "device-login-001";
const OWNER_HASH_PREFIX = "device-owner$v1$";
const TOKEN_SECRET = "test-secret-key-for-device-login-0001"; // pragma: allowlist secret

// Monotonic across the WHOLE file so ids minted by DISTINCT service instances
// (bootstrap challenge, login challenge, session) never collide on the
// friday_setup_bootstrap_nonces PRIMARY KEY (id) within a single test's db.
let idCounter = 0;
function makeIdGen(): () => string {
  return () => `id-${String(++idCounter).padStart(6, "0")}`;
}

function makeService(
  db: FridaySqliteLayer,
  opts: { authorityEnabled?: boolean; failMintAtRegister?: boolean } = {},
): FridayAuthService {
  return createFridayAuthService({
    db,
    idGenerator: makeIdGen(),
    nowIso: () => NOW,
    tokenSecret: TOKEN_SECRET,
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 604_800,
    hubId: "test-hub",
    bootstrapNonceTtlSec: 300,
    // Inject the authority seam ONLY when a test needs the enabled branch. This
    // NEVER flips NATIVE_IPC_ATTESTATION_AVAILABLE — it is the same override a
    // signed-release/native slice supplies once the OS attestation bridge lands.
    ...(opts.authorityEnabled !== undefined
      ? { deviceOwnerAuthorityEnabled: () => opts.authorityEnabled === true }
      : {}),
    // Simulate a crash mid-mint: throw INSIDE the mint transaction AFTER the
    // login-challenge CAS-consume + session insert, so the whole unit must roll back.
    ...(opts.failMintAtRegister
      ? {
        registerIssuedAccessToken: () => {
          throw new Error("simulated crash mid-mint");
        },
      }
      : {}),
  });
}

/** Clear the seeded passphrase so the owner slot is a fresh first-boot NULL. */
function clearOwnerPassphrase(db: FridaySqliteLayer): void {
  db.withWriteTransaction((conn) => {
    conn.prepare("UPDATE users SET password_hash = NULL WHERE id = 'test-user'").run();
  });
}

/** Issue a challenge + atomically claim the owner slot with `key`. */
function claimOwner(db: FridaySqliteLayer, key: TestDeviceKey): void {
  const svc = makeService(db);
  const challenge = svc.issueBootstrapChallenge(
    { installId: "install-1", osUser: "jarvis", origin: ORIGIN },
    LOOPBACK,
  );
  const transcript = makeTranscript(key, {
    action: "owner-claim",
    nonce: challenge.nonce,
    origin: ORIGIN,
    deviceId: DEVICE_ID,
    hubId: "test-hub",
    installId: "install-1",
    osUser: "jarvis",
    expiresAt: challenge.expiresAt,
  });
  const signature = {
    encoding: "ieee-p1363-base64" as const,
    value: signTranscriptLowS(key, transcript),
  };
  const res = svc.claimOwnerWithDeviceKey(
    {
      nonce: challenge.nonce,
      devicePublicKey: key.spkiDerBase64,
      deviceId: DEVICE_ID,
      origin: ORIGIN,
      installId: "install-1",
      osUser: "jarvis",
      deviceClaimProof: { transcript, signature },
    },
    LOOPBACK,
  );
  expect(res.claimed).toBe(true);
  // Authoritative durable binding lives on users.password_hash (the sentinel).
  expect(res.deviceAuthorityEnabled).toBe(false); // real precondition still off
}

/**
 * Issue a SERVER-ISSUED single-use login challenge bound to `key` + device +
 * origin, returning the raw nonce. Issuing does not require device authority.
 */
function issueLoginNonce(
  db: FridaySqliteLayer,
  over: { deviceId?: string; origin?: string; key: TestDeviceKey },
): string {
  const challenge = makeService(db).issueLoginChallenge(
    {
      installId: "install-1",
      osUser: "jarvis",
      origin: over.origin ?? ORIGIN,
      deviceId: over.deviceId ?? DEVICE_ID,
      devicePublicKey: over.key.spkiDerBase64,
    },
    LOOPBACK,
  );
  return challenge.nonce;
}

/**
 * Build a signed device-key LOGIN request for `key`, with optional overrides. By
 * default it FIRST mints a real server-issued login challenge (bound to key +
 * deviceId + origin) and signs the returned nonce into the transcript — the login
 * is only replay-safe because that nonce is single-use. Pass `over.nonce` to inject
 * a foreign / blank / already-used nonce for the negative paths (no challenge is
 * minted in that case).
 */
function loginReq(
  db: FridaySqliteLayer,
  key: TestDeviceKey,
  over: Partial<{
    action: string;
    origin: string;
    deviceId: string;
    devicePublicKey: string;
    expiresAt: string;
    signWith: TestDeviceKey;
    nonce: string;
  }> = {},
) {
  const action = over.action ?? "owner-login";
  const origin = over.origin ?? ORIGIN;
  const deviceId = over.deviceId ?? DEVICE_ID;
  const expiresAt = over.expiresAt ?? LOGIN_EXP;
  const signKey = over.signWith ?? key;
  const nonce =
    over.nonce ?? issueLoginNonce(db, { deviceId, origin, key });
  const transcript = makeTranscript(key, {
    action,
    origin,
    deviceId,
    hubId: "test-hub",
    installId: "install-1",
    osUser: "jarvis",
    nonce,
    expiresAt,
  });
  const signature = {
    encoding: "ieee-p1363-base64" as const,
    value: signTranscriptLowS(signKey, transcript),
  };
  return {
    devicePublicKey: over.devicePublicKey ?? key.spkiDerBase64,
    deviceId,
    origin,
    deviceLoginProof: { transcript, signature },
  };
}

/** Count minted sessions (token pairs) for the local owner. */
function sessionCount(db: FridaySqliteLayer): number {
  return db.withReadConnection((conn) =>
    (conn.prepare("SELECT COUNT(*) AS c FROM auth_sessions").get() as { c: number }).c,
  );
}

/** Read the consumed_at of the login-challenge row for a raw nonce (via its hash). */
function loginChallengeConsumedAt(db: FridaySqliteLayer, nonce: string): string | null {
  const hash = createHash("sha256").update(nonce).digest("hex");
  return db.withReadConnection((conn) => {
    const row = conn
      .prepare(
        "SELECT consumed_at AS c FROM friday_setup_bootstrap_nonces WHERE nonce_hash = ? AND kind = 'device_login_challenge'",
      )
      .get(hash) as { c: string | null } | undefined;
    return row?.c ?? null;
  });
}

describe("FridayAuthService — CR-1 device-key login mint", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
    clearOwnerPassphrase(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── Honesty invariant: the native gate is genuinely off on this build. ──

  it("HONESTY: NATIVE_IPC_ATTESTATION_AVAILABLE is false (native gate not faked)", () => {
    expect(NATIVE_IPC_ATTESTATION_AVAILABLE).toBe(false);
  });

  it("getBootstrapStatus().deviceClaimAvailable is FALSE with the real precondition", () => {
    const svc = makeService(db); // no seam override → real isDeviceOwnerAuthorityEnabled
    expect(svc.getBootstrapStatus().deviceClaimAvailable).toBe(false);
  });

  it("getBootstrapStatus().deviceClaimAvailable is TRUE only when authority is enabled (test seam)", () => {
    const svc = makeService(db, { authorityEnabled: true });
    expect(svc.getBootstrapStatus().deviceClaimAvailable).toBe(true);
  });

  // ── (2) HONEST native-IPC gate: valid PoP, authority OFF → no session. ──

  it("device login with a VALID PoP still fails closed while attestation is disabled", () => {
    const key = generateTestDeviceKey();
    claimOwner(db, key);

    const svc = makeService(db); // real precondition → authority disabled
    let code = "";
    try {
      svc.login(loginReq(db, key), LOOPBACK);
    } catch (err) {
      code = (err as FridayAuthError).code;
    }
    expect(code).toBe("DEVICE_AUTHORITY_DISABLED");
  });

  // ── (1) enabled branch (test-only seam): valid PoP → real session. ──

  it("device login mints a real session when authority is enabled AND PoP is valid", () => {
    const key = generateTestDeviceKey();
    claimOwner(db, key);

    const svc = makeService(db, { authorityEnabled: true });
    const res = svc.login(loginReq(db, key), LOOPBACK);

    expect(res.accessToken.length).toBeGreaterThan(0);
    expect(res.refreshToken.length).toBeGreaterThan(0);
    expect(res.user.id).toBe("test-user");
    expect(res.user.role).toBe("admin");
  });

  // ── (3) no cross-path confusion (both directions). ──

  it("the device sentinel can NEVER satisfy passphrase login", () => {
    const key = generateTestDeviceKey();
    claimOwner(db, key);

    // Sanity: the owner hash really is the non-scrypt device sentinel.
    const hash = db.withReadConnection((conn) =>
      (conn.prepare("SELECT password_hash AS h FROM users WHERE id = 'test-user'").get() as { h: string }).h,
    );
    expect(hash.startsWith(OWNER_HASH_PREFIX)).toBe(true);

    // Even with authority enabled, the passphrase path rejects the sentinel: it is
    // not a valid scrypt/legacy hash, so verifyPassword falls through to reject.
    const svc = makeService(db, { authorityEnabled: true });
    for (const attempt of [hash, `${OWNER_HASH_PREFIX}${"0".repeat(64)}`, "any", "correct horse battery"]) {
      let code = "";
      try {
        svc.login({ localPassphrase: attempt }, LOOPBACK);
      } catch (err) {
        code = (err as FridayAuthError).code;
      }
      expect(code).toBe("INVALID_CREDENTIALS");
    }
  });

  it("a passphrase owner can NEVER be logged in via the device path", () => {
    // Re-seed a real scrypt passphrase owner (undo the first-boot NULL).
    const svc0 = makeService(db);
    svc0.bootstrapLocalPassphrase({ passphrase: "correct horse battery" }, LOOPBACK);

    const key = generateTestDeviceKey();
    const svc = makeService(db, { authorityEnabled: true });
    let code = "";
    try {
      svc.login(loginReq(db, key), LOOPBACK);
    } catch (err) {
      code = (err as FridayAuthError).code;
    }
    // Rejected at the sentinel-prefix cross-path guard (not a device owner).
    expect(code).toBe("INVALID_CREDENTIALS");
  });

  // ── (4) negatives (authority ENABLED so the gate is not what's rejecting). ──

  it("rejects a device login whose PoP is signed by the WRONG key", () => {
    const key = generateTestDeviceKey();
    claimOwner(db, key);
    const attacker = generateTestDeviceKey();

    const svc = makeService(db, { authorityEnabled: true });
    // Present the bound key but sign the transcript with a different private key.
    let code = "";
    try {
      svc.login(loginReq(db, key, { signWith: attacker }), LOOPBACK);
    } catch (err) {
      code = (err as FridayAuthError).code;
    }
    expect(code).toBe("INVALID_CREDENTIALS");
  });

  it("rejects a proof minted for owner-claim replayed into the login leg", () => {
    const key = generateTestDeviceKey();
    claimOwner(db, key);

    const svc = makeService(db, { authorityEnabled: true });
    let code = "";
    try {
      svc.login(loginReq(db, key, { action: "owner-claim" }), LOOPBACK);
    } catch (err) {
      code = (err as FridayAuthError).code;
    }
    expect(code).toBe("INVALID_CREDENTIALS");
  });

  it("rejects a device login presenting a key that is NOT the bound owner key", () => {
    const key = generateTestDeviceKey();
    claimOwner(db, key);
    const other = generateTestDeviceKey();

    const svc = makeService(db, { authorityEnabled: true });
    // Present + sign with `other` (internally consistent PoP), but `other` is not
    // the bound owner key → sentinel-hash mismatch.
    let code = "";
    try {
      svc.login(loginReq(db, other), LOOPBACK);
    } catch (err) {
      code = (err as FridayAuthError).code;
    }
    expect(code).toBe("INVALID_CREDENTIALS");
  });

  it("rejects a device login transcript whose expiry exceeds the max TTL", () => {
    const key = generateTestDeviceKey();
    claimOwner(db, key);

    const svc = makeService(db, { authorityEnabled: true });
    let code = "";
    try {
      svc.login(loginReq(db, key, { expiresAt: FAR_FUTURE }), LOOPBACK);
    } catch (err) {
      code = (err as FridayAuthError).code;
    }
    expect(code).toBe("INVALID_CREDENTIALS");
  });

  it("rejects a device login from a non-loopback caller", () => {
    const key = generateTestDeviceKey();
    claimOwner(db, key);

    const svc = makeService(db, { authorityEnabled: true });
    let code = "";
    try {
      svc.login(loginReq(db, key), "203.0.113.7");
    } catch (err) {
      code = (err as FridayAuthError).code;
    }
    expect(code).toBe("INVALID_CREDENTIALS");
  });

  // ── (5) SERVER-ISSUED SINGLE-USE NONCE — Advisor #1628 finding #2 anti-replay ──

  it("REPLAY REPRO: one challenge, same signed transcript twice → 1st mints, 2nd mints NOTHING", () => {
    const key = generateTestDeviceKey();
    claimOwner(db, key);

    const svc = makeService(db, { authorityEnabled: true });
    // ONE challenge → ONE signed owner-login transcript, submitted TWICE.
    const req = loginReq(db, key);
    const nonce = req.deviceLoginProof.transcript.nonce;

    expect(sessionCount(db)).toBe(0);
    expect(loginChallengeConsumedAt(db, nonce)).toBeNull();

    // 1st call: mints a real token pair, consumes the challenge.
    const first = svc.login(req, LOOPBACK);
    expect(first.accessToken.length).toBeGreaterThan(0);
    expect(first.refreshToken.length).toBeGreaterThan(0);
    expect(sessionCount(db)).toBe(1);
    expect(loginChallengeConsumedAt(db, nonce)).not.toBeNull();

    // 2nd call (the exact Advisor repro): the challenge is already consumed →
    // consume changes=0 → refused, ZERO new token / ZERO state change. BEFORE the
    // fix this minted a 2nd token pair (sessionCount would be 2); AFTER, it stays 1.
    let code = "";
    try {
      svc.login(req, LOOPBACK);
    } catch (err) {
      code = (err as FridayAuthError).code;
    }
    expect(code).toBe("INVALID_CREDENTIALS");
    expect(sessionCount(db)).toBe(1); // still ONE — no second token pair minted
  });

  it("refuses a device login with a BLANK challenge nonce", () => {
    const key = generateTestDeviceKey();
    claimOwner(db, key);

    const svc = makeService(db, { authorityEnabled: true });
    let code = "";
    try {
      svc.login(loginReq(db, key, { nonce: "" }), LOOPBACK);
    } catch (err) {
      code = (err as FridayAuthError).code;
    }
    expect(code).toBe("INVALID_CREDENTIALS");
    expect(sessionCount(db)).toBe(0);
  });

  it("refuses a challenge nonce minted for a DIFFERENT device", () => {
    const key = generateTestDeviceKey();
    claimOwner(db, key);

    // Challenge bound to a different deviceId; login presents the real bound device.
    const foreignNonce = issueLoginNonce(db, { deviceId: "some-other-device", key });
    const svc = makeService(db, { authorityEnabled: true });
    let code = "";
    try {
      svc.login(loginReq(db, key, { nonce: foreignNonce }), LOOPBACK);
    } catch (err) {
      code = (err as FridayAuthError).code;
    }
    expect(code).toBe("INVALID_CREDENTIALS");
    expect(sessionCount(db)).toBe(0);
  });

  it("refuses a challenge nonce minted for a DIFFERENT origin", () => {
    const key = generateTestDeviceKey();
    claimOwner(db, key);

    // Challenge bound to a different origin; login presents the canonical origin.
    const foreignNonce = issueLoginNonce(db, { origin: "https://evil.localhost", key });
    const svc = makeService(db, { authorityEnabled: true });
    let code = "";
    try {
      svc.login(loginReq(db, key, { nonce: foreignNonce }), LOOPBACK);
    } catch (err) {
      code = (err as FridayAuthError).code;
    }
    expect(code).toBe("INVALID_CREDENTIALS");
    expect(sessionCount(db)).toBe(0);
  });

  it("ATTESTATION INDEPENDENCE: valid PoP + valid single-use nonce, authority OFF → DEVICE_AUTHORITY_DISABLED, nonce NOT burned", () => {
    const key = generateTestDeviceKey();
    claimOwner(db, key);

    // Build a fully valid login (real challenge, valid PoP) but run it against the
    // REAL (attestation-disabled) build: it must fail closed at the native gate and
    // must NOT consume the nonce (the replay fix does not open the native gate).
    const req = loginReq(db, key);
    const nonce = req.deviceLoginProof.transcript.nonce;

    const disabled = makeService(db); // real precondition → authority disabled
    let code = "";
    try {
      disabled.login(req, LOOPBACK);
    } catch (err) {
      code = (err as FridayAuthError).code;
    }
    expect(code).toBe("DEVICE_AUTHORITY_DISABLED");
    expect(sessionCount(db)).toBe(0);
    // Fail-closed BEFORE the mint transaction → the challenge is still LIVE.
    expect(loginChallengeConsumedAt(db, nonce)).toBeNull();

    // And with authority enabled, that still-live nonce logs in exactly once.
    const enabled = makeService(db, { authorityEnabled: true });
    const res = enabled.login(req, LOOPBACK);
    expect(res.accessToken.length).toBeGreaterThan(0);
    expect(sessionCount(db)).toBe(1);
    expect(loginChallengeConsumedAt(db, nonce)).not.toBeNull();
  });

  it("CONCURRENCY: two DISTINCT valid proofs race ONE challenge → exactly one wins", () => {
    const key = generateTestDeviceKey();
    claimOwner(db, key);

    const svc = makeService(db, { authorityEnabled: true });
    // One challenge (nonce N). Build TWO distinct valid proofs over N (different
    // transcript expiry → different signature bytes) — both are legitimate PoPs; the
    // single-use CAS must let exactly ONE mint. (better-sqlite3 serializes writes, so
    // "racing" resolves to sequential CAS: winner changes=1, loser changes=0.)
    const reqA = loginReq(db, key);
    const nonce = reqA.deviceLoginProof.transcript.nonce;
    const reqB = loginReq(db, key, { nonce, expiresAt: "2026-07-13T00:02:00.000Z" });
    expect(reqB.deviceLoginProof.transcript.nonce).toBe(nonce);
    expect(reqB.deviceLoginProof.signature.value).not.toBe(reqA.deviceLoginProof.signature.value);

    const winner = svc.login(reqA, LOOPBACK);
    expect(winner.accessToken.length).toBeGreaterThan(0);

    let code = "";
    try {
      svc.login(reqB, LOOPBACK);
    } catch (err) {
      code = (err as FridayAuthError).code;
    }
    expect(code).toBe("INVALID_CREDENTIALS");
    expect(sessionCount(db)).toBe(1); // exactly one token pair minted
  });

  it("CRASH ATOMICITY: a throw mid-mint rolls back the challenge consume AND the session (retry succeeds once)", () => {
    const key = generateTestDeviceKey();
    claimOwner(db, key);

    const req = loginReq(db, key);
    const nonce = req.deviceLoginProof.transcript.nonce;

    // Crash injected AFTER the CAS-consume + session insert, INSIDE the txn.
    const crashing = makeService(db, { authorityEnabled: true, failMintAtRegister: true });
    let threw = false;
    try {
      crashing.login(req, LOOPBACK);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // The whole unit rolled back: no session AND the challenge is still LIVE.
    expect(sessionCount(db)).toBe(0);
    expect(loginChallengeConsumedAt(db, nonce)).toBeNull();

    // Retry with the still-live nonce succeeds exactly once.
    const svc = makeService(db, { authorityEnabled: true });
    const res = svc.login(req, LOOPBACK);
    expect(res.accessToken.length).toBeGreaterThan(0);
    expect(sessionCount(db)).toBe(1);
    expect(loginChallengeConsumedAt(db, nonce)).not.toBeNull();
  });
});

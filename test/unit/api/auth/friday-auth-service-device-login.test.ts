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

function makeIdGen(): () => string {
  let n = 0;
  return () => `id-${String(++n).padStart(4, "0")}`;
}

function makeService(
  db: FridaySqliteLayer,
  opts: { authorityEnabled?: boolean } = {},
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

/** Build a signed device-key LOGIN request for `key`, with optional overrides. */
function loginReq(
  key: TestDeviceKey,
  over: Partial<{
    action: string;
    origin: string;
    deviceId: string;
    devicePublicKey: string;
    expiresAt: string;
    signWith: TestDeviceKey;
  }> = {},
) {
  const action = over.action ?? "owner-login";
  const origin = over.origin ?? ORIGIN;
  const deviceId = over.deviceId ?? DEVICE_ID;
  const expiresAt = over.expiresAt ?? LOGIN_EXP;
  const signKey = over.signWith ?? key;
  const transcript = makeTranscript(key, {
    action,
    origin,
    deviceId,
    hubId: "test-hub",
    installId: "install-1",
    osUser: "jarvis",
    nonce: "login-nonce-0001",
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
      svc.login(loginReq(key), LOOPBACK);
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
    const res = svc.login(loginReq(key), LOOPBACK);

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
      svc.login(loginReq(key), LOOPBACK);
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
      svc.login(loginReq(key, { signWith: attacker }), LOOPBACK);
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
      svc.login(loginReq(key, { action: "owner-claim" }), LOOPBACK);
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
      svc.login(loginReq(other), LOOPBACK);
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
      svc.login(loginReq(key, { expiresAt: FAR_FUTURE }), LOOPBACK);
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
      svc.login(loginReq(key), "203.0.113.7");
    } catch (err) {
      code = (err as FridayAuthError).code;
    }
    expect(code).toBe("INVALID_CREDENTIALS");
  });
});

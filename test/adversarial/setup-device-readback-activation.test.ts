/**
 * Adversarial Device-Readback Activation
 * (SEC-SETUP-BOOTSTRAP-001, FIXED-order Stage 3+4 — provisional → active flip)
 *
 * These tests run the REAL production code path against a REAL file-backed SQLite
 * layer (createFridaySqliteLayer → real migrations incl. v104 → real WAL), seeded
 * with admin-001, given a real scrypt passphrase credential, and then migrated to
 * a PROVISIONAL device binding via the REAL migrateOwnerToDeviceKey path. No
 * in-memory mock, no route-exists smoke check.
 *
 * The readback is ADDITIVE / migration-free / fail-closed:
 *   - authenticated OWNER + a FRESH device PoP → the provisional binding is
 *     CAS-flipped to 'active' AND users.password_hash STAYS scrypt$… (the
 *     passphrase STILL works — NO lockout). The device binding carries ZERO
 *     authority (deviceAuthorityEnabled always false).
 *   - NO install nonce is consumed (freshness is intrinsic to the PoP transcript
 *     expiresAt); anti-replay is intrinsic to the provisional→active CAS.
 *   - the tombstone-write scaffolding stays INACTIVE: password_hash is NEVER
 *     flipped to the device sentinel and NO tombstone row is written.
 *
 * Red-first: each assertion targets a real DEFECT that appears when the
 * corresponding guard is removed (PoP verify, owner-scoped lookup, provisional
 * CAS, tombstone read-guard), not a missing-symbol error.
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
import { getScopesForRole } from "../../src/api/auth/friday-rbac-policy.js";
import { isDeviceOwnerAuthorityEnabled } from "../../src/security/friday-device-owner-authority-precondition.js";
import {
  generateTestDeviceKey,
  makeTranscript,
  signTranscriptLowS,
  signTranscriptRaw,
  toHighSTwin,
  toLowS,
} from "./_secsetup-s2a.helpers.js";
import type { OwnerClaimTranscript } from "../../src/api/auth/device-attest/index.js";

const OWNER_ID = "admin-001";
const NOW = "2026-07-13T00:00:00.000Z";
const LOOPBACK = "127.0.0.1";
const ORIGIN = "https://friday.localhost";
const PASSPHRASE = "owner-passphrase-xyz-123"; // pragma: allowlist secret
const DEVICE_KEY = generateTestDeviceKey();
const DEVICE_PUBKEY = DEVICE_KEY.spkiDerBase64;
const DEVICE_ID = "device-migrate-001";
const DEVICE_OWNER_SENTINEL_PREFIX = "device-owner$v1$";
const READBACK_NONCE = "readback-nonce-0001";
// Follow-up hardening (b): a readback proof's expiry must fall within the
// server-side max TTL (5 min). The happy/state fixtures use a short, in-window
// expiry (relative to the fixed test NOW) so they exercise the clamp's PASS side.
const READBACK_EXPIRES_AT = new Date(Date.parse(NOW) + 4 * 60 * 1000).toISOString();
// Follow-up hardening (c): a SECOND device key + id used to seed a provisional
// binding for the same owner alongside an already-active binding.
const DEVICE_KEY2 = generateTestDeviceKey();
const DEVICE_PUBKEY2 = DEVICE_KEY2.spkiDerBase64;
const DEVICE_ID_2 = "device-migrate-002";

function sha256Hex(v: string): string {
  return crypto.createHash("sha256").update(v).digest("hex");
}

/** The authenticated LOCAL OWNER principal a passphrase login would mint. */
function ownerPrincipal(overrides: Partial<FridayAuthPrincipal> = {}): FridayAuthPrincipal {
  return {
    principalType: "user",
    principalId: OWNER_ID,
    tenantId: OWNER_ID,
    userId: OWNER_ID,
    role: "admin",
    scopes: [...getScopesForRole("admin")] as FridayScope[],
    tokenId: "tok-owner-0001",
    tokenKind: "access",
    issuedAt: NOW,
    ...overrides,
  };
}

/** The synthetic anonymous principal the HTTP server injects for no-auth. */
function publicPrincipal(): FridayAuthPrincipal {
  return {
    principalType: "user",
    principalId: "public:default",
    tenantId: "00000000-0000-0000-0000-000000000001",
    userId: "00000000-0000-0000-0000-000000000001",
    role: "admin",
    scopes: [...getScopesForRole("admin")] as FridayScope[],
    tokenId: "00000000-0000-0000-0000-000000000002",
    tokenKind: "access",
    issuedAt: NOW,
  };
}

function makeService(db: FridaySqliteLayer, nowIso: string = NOW) {
  return createFridayAuthService({
    db,
    idGenerator: (() => {
      let n = 0;
      return () => `id-${String(++n).padStart(4, "0")}`;
    })(),
    nowIso: () => nowIso,
    tokenSecret: "test-secret-key-for-readback-0000001", // pragma: allowlist secret
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 604_800,
    hubId: "test-hub",
    bootstrapNonceTtlSec: 300,
    warn: () => {},
  });
}

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

function readOwnerHash(db: FridaySqliteLayer): string | null {
  return db.withReadConnection((conn) => {
    const row = conn.prepare("SELECT password_hash AS h FROM users WHERE id = ?").get(OWNER_ID) as
      | { h: string | null }
      | undefined;
    return row?.h ?? null;
  });
}

function readBindings(db: FridaySqliteLayer, userId: string = OWNER_ID): Record<string, unknown>[] {
  return db.withReadConnection((conn) =>
    conn
      .prepare("SELECT * FROM friday_device_owner_bindings WHERE user_id = ? ORDER BY created_at")
      .all(userId) as Record<string, unknown>[],
  );
}

function countActiveBindings(db: FridaySqliteLayer, userId: string = OWNER_ID): number {
  return db.withReadConnection((conn) => {
    const row = conn
      .prepare(
        "SELECT COUNT(*) AS c FROM friday_device_owner_bindings WHERE user_id = ? AND state = 'active'",
      )
      .get(userId) as { c: number };
    return row.c;
  });
}

function readTombstones(db: FridaySqliteLayer): Record<string, unknown>[] {
  return db.withReadConnection((conn) =>
    conn.prepare("SELECT * FROM friday_credential_tombstones WHERE user_id = ?").all(OWNER_ID) as Record<string, unknown>[],
  );
}

/** Seed admin-001 AND set the real scrypt passphrase credential (the migration source). */
function seedPassphraseOwner(db: FridaySqliteLayer): void {
  seedOwner(db);
  makeService(db).bootstrapLocalPassphrase({ passphrase: PASSPHRASE }, LOOPBACK);
}

/** Seed a passphrase owner AND a PROVISIONAL device binding via the REAL migrate path. */
function seedProvisionalBinding(db: FridaySqliteLayer): void {
  seedPassphraseOwner(db);
  const svc = makeService(db);
  const nonce = svc.issueMigrationChallenge(
    { installId: "install-m1", osUser: "jarvis", origin: ORIGIN },
    ownerPrincipal(),
    LOOPBACK,
  ).nonce;
  const transcript = makeTranscript(DEVICE_KEY, {
    nonce,
    origin: ORIGIN,
    deviceId: DEVICE_ID,
    action: "owner-migrate",
    installId: "install-m1",
    osUser: "jarvis",
  });
  svc.migrateOwnerToDeviceKey(
    {
      nonce,
      devicePublicKey: DEVICE_PUBKEY,
      deviceId: DEVICE_ID,
      origin: ORIGIN,
      installId: "install-m1",
      osUser: "jarvis",
      deviceClaimProof: {
        transcript,
        signature: { encoding: "ieee-p1363-base64" as const, value: signTranscriptLowS(DEVICE_KEY, transcript) },
      },
    },
    ownerPrincipal(),
    LOOPBACK,
  );
}

/** Build a FRESH readback request with a valid PoP over the given transcript overrides. */
function readbackReq(
  over: Partial<{ nonce: string; origin: string; deviceId: string; devicePublicKey: string }> = {},
  transcriptOver: Partial<OwnerClaimTranscript> = {},
) {
  const nonce = over.nonce ?? READBACK_NONCE;
  const origin = over.origin ?? ORIGIN;
  const deviceId = over.deviceId ?? DEVICE_ID;
  const devicePublicKey = over.devicePublicKey ?? DEVICE_PUBKEY;
  const transcript = makeTranscript(DEVICE_KEY, {
    nonce,
    origin,
    deviceId,
    action: "owner-readback",
    installId: "install-m1",
    osUser: "jarvis",
    expiresAt: READBACK_EXPIRES_AT,
    ...transcriptOver,
  });
  return {
    nonce,
    devicePublicKey,
    deviceId,
    origin,
    installId: "install-m1",
    osUser: "jarvis",
    deviceClaimProof: {
      transcript,
      signature: { encoding: "ieee-p1363-base64" as const, value: signTranscriptLowS(DEVICE_KEY, transcript) },
    },
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
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("SEC-SETUP-BOOTSTRAP-001 Stage 3+4: device-readback activation", () => {
  it("happy path: authenticated owner + fresh PoP flips provisional → active; passphrase STILL works; ZERO device authority", () => {
    seedProvisionalBinding(db);
    const beforeHash = readOwnerHash(db);
    expect(beforeHash?.startsWith("scrypt$")).toBe(true);
    expect(readBindings(db)[0].state).toBe("provisional");

    const res = makeService(db).confirmDeviceReadback(readbackReq(), ownerPrincipal(), LOOPBACK);

    expect(res.activated).toBe(true);
    expect(res.state).toBe("active");
    expect(res.userId).toBe(OWNER_ID);
    expect(res.deviceId).toBe(DEVICE_ID);
    expect(res.devicePublicKeyHash).toBe(sha256Hex(DEVICE_PUBKEY));
    expect(res.passphraseStillActive).toBe(true);
    expect(res.deviceAuthorityEnabled).toBe(false);
    expect(isDeviceOwnerAuthorityEnabled()).toBe(false);
    expect(res.activatedAt).toBe(NOW);

    // DUAL-READ: password_hash UNCHANGED (still scrypt) — NOT flipped to the sentinel.
    const afterHash = readOwnerHash(db);
    expect(afterHash).toBe(beforeHash);
    expect(afterHash?.startsWith(DEVICE_OWNER_SENTINEL_PREFIX)).toBe(false);

    // Exactly one binding, now 'active' with activated_at set.
    const bindings = readBindings(db);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].state).toBe("active");
    expect(bindings[0].activated_at).toBe(NOW);
    expect(bindings[0].revoked_at).toBeNull();

    // NO-LOCKOUT: the passphrase login STILL works after activation.
    const login = makeService(db).login({ localPassphrase: PASSPHRASE }, LOOPBACK);
    expect(login.accessToken).toBeTruthy();
    expect(login.user.id).toBe(OWNER_ID);

    // Tombstone scaffolding is INACTIVE — no tombstone written this slice.
    expect(readTombstones(db)).toHaveLength(0);
  });

  it("refuses the synthetic public principal (401) — binding stays provisional", () => {
    seedProvisionalBinding(db);
    let caught: unknown;
    try {
      makeService(db).confirmDeviceReadback(readbackReq(), publicPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).httpStatus).toBe(401);
    expect((caught as FridayDomainError).code).toBe("AUTH_MIGRATE_OWNER_REQUIRED");
    expect(readBindings(db)[0].state).toBe("provisional");
    expect(countActiveBindings(db)).toBe(0);
  });

  it("refuses a non-owner authenticated principal — wrong identity (403); binding stays provisional", () => {
    seedProvisionalBinding(db);
    const notOwner = ownerPrincipal({ principalId: "user:mallory", userId: "user:mallory" });
    let caught: unknown;
    try {
      makeService(db).confirmDeviceReadback(readbackReq(), notOwner, LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).httpStatus).toBe(403);
    expect((caught as FridayDomainError).code).toBe("AUTH_MIGRATE_FORBIDDEN");
    expect(readBindings(db)[0].state).toBe("provisional");
  });

  it("refuses a non-owner authenticated principal — wrong role (403)", () => {
    seedProvisionalBinding(db);
    const viewer = ownerPrincipal({ role: "viewer", scopes: [...getScopesForRole("viewer")] as FridayScope[] });
    let caught: unknown;
    try {
      makeService(db).confirmDeviceReadback(readbackReq(), viewer, LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).httpStatus).toBe(403);
    expect(readBindings(db)[0].state).toBe("provisional");
  });

  it("loopback-only: a non-loopback readback fails closed (403); binding stays provisional", () => {
    seedProvisionalBinding(db);
    let caught: unknown;
    try {
      makeService(db).confirmDeviceReadback(readbackReq(), ownerPrincipal(), "10.0.0.5");
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).httpStatus).toBe(403);
    expect((caught as FridayDomainError).code).toBe("AUTH_READBACK_NOT_ALLOWED");
    expect(readBindings(db)[0].state).toBe("provisional");
  });

  // ── PoP failure matrix — each leaves the binding provisional (no flip) ──

  it("PoP matrix — missing proof → 400; binding stays provisional", () => {
    seedProvisionalBinding(db);
    const req = readbackReq();
    delete (req as { deviceClaimProof?: unknown }).deviceClaimProof;
    let caught: unknown;
    try {
      makeService(db).confirmDeviceReadback(req, ownerPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).httpStatus).toBe(400);
    expect((caught as FridayDomainError).code).toBe("AUTH_READBACK_POP_REQUIRED");
    expect(readBindings(db)[0].state).toBe("provisional");
  });

  it("PoP matrix — wrong signing key → 401; binding stays provisional", () => {
    seedProvisionalBinding(db);
    // Transcript binds DEVICE_KEY (so the presented-key-hash check passes), but the
    // signature is produced by an UNRELATED key → possession is NOT proven.
    const attacker = generateTestDeviceKey();
    const transcript = makeTranscript(DEVICE_KEY, {
      nonce: READBACK_NONCE,
      origin: ORIGIN,
      deviceId: DEVICE_ID,
      action: "owner-readback",
      installId: "install-m1",
      osUser: "jarvis",
    });
    const forged = {
      ...readbackReq(),
      deviceClaimProof: {
        transcript,
        signature: { encoding: "ieee-p1363-base64" as const, value: signTranscriptLowS(attacker, transcript) },
      },
    };
    let caught: unknown;
    try {
      makeService(db).confirmDeviceReadback(forged, ownerPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).httpStatus).toBe(401);
    expect((caught as FridayDomainError).code).toBe("AUTH_READBACK_POP_INVALID");
    expect(readBindings(db)[0].state).toBe("provisional");
  });

  it("PoP matrix — transcript/request mismatch (origin) → 401; binding stays provisional", () => {
    seedProvisionalBinding(db);
    // The signed transcript's origin (evil) does not match the request origin
    // (ORIGIN, default) — the request/transcript consistency gate fires.
    const req = readbackReq({}, { origin: "https://evil.localhost" });
    let caught: unknown;
    try {
      makeService(db).confirmDeviceReadback(req, ownerPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).httpStatus).toBe(401);
    expect((caught as FridayDomainError).code).toBe("AUTH_READBACK_POP_INVALID");
    expect(readBindings(db)[0].state).toBe("provisional");
  });

  it("PoP matrix — expired transcript → 401; binding stays provisional", () => {
    seedProvisionalBinding(db);
    const req = readbackReq({}, { expiresAt: "2020-01-01T00:00:00.000Z" });
    let caught: unknown;
    try {
      makeService(db).confirmDeviceReadback(req, ownerPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).httpStatus).toBe(401);
    expect((caught as FridayDomainError).code).toBe("AUTH_READBACK_POP_INVALID");
    expect(readBindings(db)[0].state).toBe("provisional");
  });

  it("PoP matrix — high-S (malleable) signature → 401; binding stays provisional", () => {
    seedProvisionalBinding(db);
    const transcript = makeTranscript(DEVICE_KEY, {
      nonce: READBACK_NONCE,
      origin: ORIGIN,
      deviceId: DEVICE_ID,
      action: "owner-readback",
      installId: "install-m1",
      osUser: "jarvis",
    });
    // Normalize to low-S first, THEN twin, so the result is GUARANTEED high-S
    // (Node's raw ECDSA output is not guaranteed low-S).
    const highS = toHighSTwin(toLowS(signTranscriptRaw(DEVICE_KEY, transcript))).toString("base64");
    const req = {
      ...readbackReq(),
      deviceClaimProof: {
        transcript,
        signature: { encoding: "ieee-p1363-base64" as const, value: highS },
      },
    };
    let caught: unknown;
    try {
      makeService(db).confirmDeviceReadback(req, ownerPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).httpStatus).toBe(401);
    expect((caught as FridayDomainError).code).toBe("AUTH_READBACK_POP_INVALID");
    expect(readBindings(db)[0].state).toBe("provisional");
  });

  // ── State / lookup guards ──

  it("no provisional binding (migration never ran) → 409; no active row, hash intact", () => {
    seedPassphraseOwner(db); // passphrase owner but NO migration → no binding
    const beforeHash = readOwnerHash(db);
    let caught: unknown;
    try {
      makeService(db).confirmDeviceReadback(readbackReq(), ownerPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).httpStatus).toBe(409);
    expect((caught as FridayDomainError).code).toBe("AUTH_READBACK_NO_BINDING");
    expect(readBindings(db)).toHaveLength(0);
    expect(readOwnerHash(db)).toBe(beforeHash);
  });

  it("cross-owner isolation: cannot activate ANOTHER owner's provisional binding (409); their binding stays provisional", () => {
    seedPassphraseOwner(db); // local owner = admin-001, NO binding of their own
    // A provisional binding for the SAME device key but a DIFFERENT user id.
    db.withWriteTransaction((conn) => {
      conn
        .prepare(
          `INSERT INTO friday_device_owner_bindings (
             id, user_id, device_id, device_public_key, device_public_key_hash,
             state, migrated_from, origin, hub_id, created_at, activated_at, revoked_at
           ) VALUES (?, ?, ?, ?, ?, 'provisional', 'passphrase', ?, 'test-hub', ?, NULL, NULL)`,
        )
        .run("binding-mallory", "user:mallory", DEVICE_ID, DEVICE_PUBKEY, sha256Hex(DEVICE_PUBKEY), ORIGIN, NOW);
    });

    let caught: unknown;
    try {
      makeService(db).confirmDeviceReadback(readbackReq(), ownerPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).httpStatus).toBe(409);
    expect((caught as FridayDomainError).code).toBe("AUTH_READBACK_NO_BINDING");
    // The other owner's binding is untouched — no cross-owner activation.
    const mallory = readBindings(db, "user:mallory");
    expect(mallory).toHaveLength(1);
    expect(mallory[0].state).toBe("provisional");
    expect(countActiveBindings(db, "user:mallory")).toBe(0);
  });

  it("revoked binding cannot be activated (changes=0 → 409); stays revoked; passphrase login works", () => {
    seedProvisionalBinding(db);
    db.withWriteTransaction((conn) => {
      conn
        .prepare("UPDATE friday_device_owner_bindings SET state = 'revoked', revoked_at = ? WHERE user_id = ?")
        .run(NOW, OWNER_ID);
    });
    let caught: unknown;
    try {
      makeService(db).confirmDeviceReadback(readbackReq(), ownerPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).httpStatus).toBe(409);
    expect((caught as FridayDomainError).code).toBe("AUTH_READBACK_NOT_PROVISIONAL");
    expect(readBindings(db)[0].state).toBe("revoked");
    expect(countActiveBindings(db)).toBe(0);
    expect(readOwnerHash(db)?.startsWith("scrypt$")).toBe(true);
    expect(makeService(db).login({ localPassphrase: PASSPHRASE }, LOOPBACK).user.id).toBe(OWNER_ID);
  });

  it("replay/idempotency: a second readback flips 0 rows (409); exactly ONE active binding, no second active row", () => {
    seedProvisionalBinding(db);
    const first = makeService(db).confirmDeviceReadback(readbackReq(), ownerPrincipal(), LOOPBACK);
    expect(first.state).toBe("active");
    expect(countActiveBindings(db)).toBe(1);

    let caught: unknown;
    try {
      makeService(db).confirmDeviceReadback(readbackReq(), ownerPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).httpStatus).toBe(409);
    expect((caught as FridayDomainError).code).toBe("AUTH_READBACK_NOT_PROVISIONAL");
    // Still exactly one binding, still active — no duplicate active row was created.
    const bindings = readBindings(db);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].state).toBe("active");
    expect(countActiveBindings(db)).toBe(1);
  });

  it("tombstoned cannot re-activate (409); NO tombstone written by the readback; binding stays provisional; login works", () => {
    seedProvisionalBinding(db);
    // Simulate a later stage having retired the legacy credential (a tombstone exists).
    db.withWriteTransaction((conn) => {
      conn
        .prepare(
          `INSERT INTO friday_credential_tombstones (
             id, user_id, credential_kind, retired_reason, superseded_by_binding_id,
             origin, hub_id, retired_at
           ) VALUES (?, ?, 'passphrase', 'migrated_to_device', NULL, ?, 'test-hub', ?)`,
        )
        .run("tomb-seed-1", OWNER_ID, ORIGIN, NOW);
    });
    const tombstonesBefore = readTombstones(db).length;

    let caught: unknown;
    try {
      makeService(db).confirmDeviceReadback(readbackReq(), ownerPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).httpStatus).toBe(409);
    expect((caught as FridayDomainError).code).toBe("AUTH_READBACK_TOMBSTONED");
    // The read-guard wrote NOTHING: the binding stays provisional and NO new
    // tombstone was written (count unchanged).
    expect(readBindings(db)[0].state).toBe("provisional");
    expect(countActiveBindings(db)).toBe(0);
    expect(readTombstones(db)).toHaveLength(tombstonesBefore);
    // The passphrase still works (this slice never flips password_hash).
    expect(makeService(db).login({ localPassphrase: PASSPHRASE }, LOOPBACK).user.id).toBe(OWNER_ID);
  });

  it("owner-gated read seam observes the provisional → active transition", () => {
    seedProvisionalBinding(db);
    const before = makeService(db).getDeviceBindingState(ownerPrincipal(), LOOPBACK);
    expect(before.state).toBe("provisional");
    expect(before.hasActiveBinding).toBe(false);
    expect(before.activatedAt).toBeNull();
    expect(before.deviceAuthorityEnabled).toBe(false);

    makeService(db).confirmDeviceReadback(readbackReq(), ownerPrincipal(), LOOPBACK);

    const after = makeService(db).getDeviceBindingState(ownerPrincipal(), LOOPBACK);
    expect(after.state).toBe("active");
    expect(after.hasActiveBinding).toBe(true);
    expect(after.activatedAt).toBe(NOW);
    expect(after.devicePublicKeyHash).toBe(sha256Hex(DEVICE_PUBKEY));
    expect(after.passphraseStillActive).toBe(true);
  });

  it("read seam refuses the synthetic public principal (401)", () => {
    seedProvisionalBinding(db);
    let caught: unknown;
    try {
      makeService(db).getDeviceBindingState(publicPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).httpStatus).toBe(401);
  });

  // ── Follow-up hardening (a): domain-separated transcript.action ──

  it("(a) cross-intent domain separation: a VALID proof whose signed action is 'owner-migrate' — sharing the readback nonce/origin/deviceId — is REFUSED (401); binding stays provisional", () => {
    seedProvisionalBinding(db);
    // readbackReq re-signs over the overridden transcript, so this is a fully valid
    // PoP (correct key, fresh, low-S) that merely carries a DIFFERENT signed intent.
    // Without domain separation it would activate the binding by cross-intent replay.
    const req = readbackReq({}, { action: "owner-migrate" });
    let caught: unknown;
    try {
      makeService(db).confirmDeviceReadback(req, ownerPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FridayDomainError);
    expect((caught as FridayDomainError).httpStatus).toBe(401);
    expect((caught as FridayDomainError).code).toBe("AUTH_READBACK_POP_INVALID");
    expect(readBindings(db)[0].state).toBe("provisional");
    expect(countActiveBindings(db)).toBe(0);
  });

  // ── Follow-up hardening (b): server-side max-TTL clamp (readback only) ──

  it("(b) max-TTL clamp: a far-future (NOW + 24h) transcript expiry is REFUSED (401); binding stays provisional", () => {
    seedProvisionalBinding(db);
    // Not expired (NOW < expiry) so the freshness gate passes — but the expiry lies
    // FAR beyond the 5-minute readback max TTL, so the clamp fails it closed.
    const farFuture = new Date(Date.parse(NOW) + 24 * 60 * 60 * 1000).toISOString();
    const req = readbackReq({}, { expiresAt: farFuture });
    let caught: unknown;
    try {
      makeService(db).confirmDeviceReadback(req, ownerPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FridayDomainError);
    expect((caught as FridayDomainError).httpStatus).toBe(401);
    expect((caught as FridayDomainError).code).toBe("AUTH_READBACK_POP_INVALID");
    expect(readBindings(db)[0].state).toBe("provisional");
    expect(countActiveBindings(db)).toBe(0);
  });

  // ── Follow-up hardening (c): graceful 409 on the active-binding UNIQUE, not 500 ──

  it("(c) already-active owner: activating a second device key's provisional binding is a clean 409 AUTH_READBACK_ALREADY_ACTIVE (NOT a raw 500); exactly ONE active row remains", () => {
    seedPassphraseOwner(db);
    // ONE already-active binding (device key #1) + a second PROVISIONAL binding for a
    // DIFFERENT device key (#2), same owner. The partial UNIQUE(user_id) WHERE
    // state='active' allows this at rest but rejects flipping #2 to active.
    db.withWriteTransaction((conn) => {
      conn
        .prepare(
          `INSERT INTO friday_device_owner_bindings (
             id, user_id, device_id, device_public_key, device_public_key_hash,
             state, migrated_from, origin, hub_id, created_at, activated_at, revoked_at
           ) VALUES (?, ?, ?, ?, ?, 'active', 'passphrase', ?, 'test-hub', ?, ?, NULL)`,
        )
        .run("binding-active-1", OWNER_ID, DEVICE_ID, DEVICE_PUBKEY, sha256Hex(DEVICE_PUBKEY), ORIGIN, NOW, NOW);
      conn
        .prepare(
          `INSERT INTO friday_device_owner_bindings (
             id, user_id, device_id, device_public_key, device_public_key_hash,
             state, migrated_from, origin, hub_id, created_at, activated_at, revoked_at
           ) VALUES (?, ?, ?, ?, ?, 'provisional', 'passphrase', ?, 'test-hub', ?, NULL, NULL)`,
        )
        .run("binding-prov-2", OWNER_ID, DEVICE_ID_2, DEVICE_PUBKEY2, sha256Hex(DEVICE_PUBKEY2), ORIGIN, NOW);
    });

    // A fresh, valid readback PoP over device key #2 (the provisional one).
    const nonce = "readback-nonce-key2";
    const transcript = makeTranscript(DEVICE_KEY2, {
      nonce,
      origin: ORIGIN,
      deviceId: DEVICE_ID_2,
      action: "owner-readback",
      installId: "install-m1",
      osUser: "jarvis",
      expiresAt: READBACK_EXPIRES_AT,
    });
    const req = {
      nonce,
      devicePublicKey: DEVICE_PUBKEY2,
      deviceId: DEVICE_ID_2,
      origin: ORIGIN,
      installId: "install-m1",
      osUser: "jarvis",
      deviceClaimProof: {
        transcript,
        signature: { encoding: "ieee-p1363-base64" as const, value: signTranscriptLowS(DEVICE_KEY2, transcript) },
      },
    };

    let caught: unknown;
    try {
      makeService(db).confirmDeviceReadback(req, ownerPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FridayDomainError);
    expect((caught as FridayDomainError).httpStatus).toBe(409);
    expect((caught as FridayDomainError).code).toBe("AUTH_READBACK_ALREADY_ACTIVE");
    // The failed flip rolled back: exactly ONE active row (#1), #2 stayed provisional.
    expect(countActiveBindings(db)).toBe(1);
    const key2 = readBindings(db).find((b) => b.id === "binding-prov-2");
    expect(key2?.state).toBe("provisional");
  });
});

/**
 * Adversarial Bootstrap-Nonce Lifecycle (SEC-SETUP-BOOTSTRAP-001, slice 4)
 *
 * Fork-agnostic hardening of the Slice-1 install-nonce primitive:
 *   - OBS-2 reaper: a bounded TTL/retention sweep for friday_setup_bootstrap_nonces
 *     so a loopback caller cannot mint unbounded challenge rows (local DoS).
 *   - Crash/restart recovery: the single-use / expiry / owner-CAS invariants hold
 *     across a simulated process restart (real file-backed sqlite, reopened).
 *
 * These tests run the REAL production code (auth service + nonce repository)
 * against a REAL file-backed sqlite layer (createFridaySqliteLayer → real
 * migrations → real WAL), seeded with admin-001 EXACTLY as the hub seeds it
 * (password_hash NULL, is_local_only=1). No in-memory mock.
 *
 * Red-first: each assertion targets a real DEFECT that appears when the
 * corresponding guard is removed (see PR body sever→RED→restore→GREEN evidence),
 * not a missing-symbol error.
 *
 * ADDITIVE / no-degrade: the reaper only removes rows that are already unusable
 * (expired-unconsumed) or authoritative-elsewhere (consumed → owner binding held
 * on users.password_hash). It never touches a live unconsumed-unexpired nonce
 * nor the owner slot.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFridayAuthService, createFridaySetupBootstrapNonceRepository } from "#api";
import { FridayDomainError } from "#errors";
import { createFridaySqliteLayer } from "#state";
import type { FridaySqliteLayer } from "#state";
// SEC-SETUP-BOOTSTRAP-001 Slice 3: device-claim now requires proof-of-possession.
import { generateTestDeviceKey, makeTranscript, signTranscriptLowS, type TestDeviceKey } from "./_secsetup-s2a.helpers.js";
import { createTestNativeOwnerResolver } from "./_native-owner-capability.helpers.js";

const OWNER_ID = "admin-001";
const NOW = "2026-07-13T00:00:00.000Z";
const AFTER_TTL = "2026-07-13T00:10:00.000Z"; // > NOW + 300s (nonce TTL)
const LOOPBACK = "127.0.0.1";
const ORIGIN = "https://friday.localhost";
const DEVICE_KEY = generateTestDeviceKey();
const DEVICE_PUBKEY = DEVICE_KEY.spkiDerBase64;
const DEVICE_ID = "device-abc-001";
const OWNER_HASH_PREFIX = "device-owner$v1$";
const BOOTSTRAP_TTL_SEC = 300;

const nonceRepo = createFridaySetupBootstrapNonceRepository();

// Monotonic across the whole file so distinct issued challenges never collide on
// the nonce-row PRIMARY KEY (id), which persists across a simulated restart.
let idCounter = 0;

function sha256Hex(v: string): string {
  return crypto.createHash("sha256").update(v).digest("hex");
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

function makeService(db: FridaySqliteLayer, nowIso: string = NOW) {
  return createFridayAuthService({
    db,
    idGenerator: () => `id-${String(++idCounter).padStart(6, "0")}`,
    nowIso: () => nowIso,
    tokenSecret: "test-secret-key-for-nonce-lifecycle-01", // pragma: allowlist secret
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 604_800,
    hubId: "test-hub",
    bootstrapNonceTtlSec: BOOTSTRAP_TTL_SEC,
    // Option C: the owner-sentinel write requires a per-claim native capability.
    // These tests exercise NONCE lifecycle mechanics, so inject a resolver that
    // mints a real capability over injected native-evidence doubles — the nonce
    // gate remains what's under test.
    resolveNativeOwnerClaimContext: createTestNativeOwnerResolver(),
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

function readNonceRow(db: FridaySqliteLayer, nonce: string): Record<string, unknown> | null {
  return db.withReadConnection((conn) => {
    const row = conn
      .prepare("SELECT * FROM friday_setup_bootstrap_nonces WHERE nonce_hash = ?")
      .get(sha256Hex(nonce)) as Record<string, unknown> | undefined;
    return row ?? null;
  });
}

function countNonces(db: FridaySqliteLayer): number {
  return db.withReadConnection((conn) =>
    (conn.prepare("SELECT COUNT(*) AS c FROM friday_setup_bootstrap_nonces").get() as { c: number }).c,
  );
}

function issueNonce(db: FridaySqliteLayer, over?: { origin?: string; nowIso?: string }): string {
  const svc = makeService(db, over?.nowIso ?? NOW);
  const res = svc.issueBootstrapChallenge(
    { installId: "install-1", osUser: "jarvis", origin: over?.origin ?? ORIGIN },
    LOOPBACK,
  );
  return res.nonce;
}

function claimReq(over?: Partial<{ nonce: string; origin: string; deviceId: string; key: TestDeviceKey }>) {
  const key = over?.key ?? DEVICE_KEY;
  const nonce = over?.nonce ?? "";
  const origin = over?.origin ?? ORIGIN;
  const deviceId = over?.deviceId ?? DEVICE_ID;
  // Far-future transcript expiry so the server nonce store stays the authoritative
  // TTL/single-use gate (slice-1 error codes unchanged); PoP proves key possession.
  const transcript = makeTranscript(key, { nonce, origin, deviceId, installId: "install-1", osUser: "jarvis" });
  return {
    nonce,
    devicePublicKey: key.spkiDerBase64,
    deviceId,
    origin,
    installId: "install-1",
    osUser: "jarvis",
    deviceClaimProof: {
      transcript,
      signature: { encoding: "ieee-p1363-base64" as const, value: signTranscriptLowS(key, transcript) },
    },
  };
}

/** Runs the production reaper against the file-backed layer. */
function runReaper(
  db: FridaySqliteLayer,
  over?: { nowIso?: string; consumedRetentionCutoffIso?: string; batchLimit?: number },
) {
  return db.withWriteTransaction((conn) =>
    nonceRepo.sweepExpiredAndRetired(conn, {
      nowIso: over?.nowIso ?? NOW,
      consumedRetentionCutoffIso: over?.consumedRetentionCutoffIso ?? "2000-01-01T00:00:00.000Z",
      batchLimit: over?.batchLimit ?? 1000,
    }),
  );
}

/** Backdated raw insert to fabricate aged / bulk rows without a real clock. */
function insertRawNonce(
  db: FridaySqliteLayer,
  id: string,
  over?: Partial<{ expiresAt: string; consumedAt: string | null }>,
): void {
  db.withWriteTransaction((conn) => {
    conn
      .prepare(
        `INSERT INTO friday_setup_bootstrap_nonces
           (id, nonce_hash, kind, hub_id, install_id, os_user, origin, action,
            created_at, expires_at, consumed_at)
         VALUES (?, ?, 'install_owner_claim', 'h', 'i', 'u', ?, 'owner-claim', ?, ?, ?)`,
      )
      .run(
        id,
        `hash-${id}`,
        ORIGIN,
        "2024-01-01T00:00:00.000Z",
        over?.expiresAt ?? "2999-01-01T00:00:00.000Z",
        over?.consumedAt ?? null,
      );
  });
}

let db: FridaySqliteLayer;
let tmpDir: string;
let dbPath: string;

function openLayer(): FridaySqliteLayer {
  return createFridaySqliteLayer({
    dbPath,
    readPoolSize: 2,
    pragmas: { busyTimeoutMs: 5_000, synchronous: "NORMAL" },
  });
}

/** Simulate a process restart: close the writer + readers and reopen the file. */
function restart(): void {
  db.close();
  db = openLayer();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-secsetup-s4-"));
  dbPath = path.join(tmpDir, "friday.db");
  db = openLayer();
  seedOwner(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("SEC-SETUP-BOOTSTRAP-001 s4: nonce reaper (OBS-2)", () => {
  it("reaps expired unconsumed nonces but preserves a live one", () => {
    // Live nonce: issued at NOW, expires NOW+300s.
    const live = issueNonce(db, { nowIso: NOW });
    // Expired unconsumed nonce: issued in the past so it is already dead at NOW.
    insertRawNonce(db, "dead", { expiresAt: "2026-07-12T00:00:00.000Z", consumedAt: null });
    expect(countNonces(db)).toBe(2);

    const res = runReaper(db, { nowIso: NOW });

    expect(res.deletedExpiredUnconsumed).toBe(1);
    expect(res.deletedConsumedRetired).toBe(0);
    // Live nonce survives and is still present.
    expect(readNonceRow(db, live)).not.toBeNull();
    // The dead raw row (nonce_hash='hash-dead') is gone.
    const deadRow = db.withReadConnection((conn) =>
      conn.prepare("SELECT id FROM friday_setup_bootstrap_nonces WHERE nonce_hash = 'hash-dead'").get(),
    );
    expect(deadRow).toBeUndefined();
    expect(countNonces(db)).toBe(1);
  });

  it("NO-DEGRADE: reaping a consumed nonce does NOT release the owner slot", () => {
    // Real issue → claim: owner flips to the device sentinel, nonce consumed.
    const nonce = issueNonce(db);
    makeService(db).claimOwnerWithDeviceKey(claimReq({ nonce }), LOOPBACK);
    const ownerHash = readOwnerHash(db);
    expect(ownerHash).toBe(`${OWNER_HASH_PREFIX}${sha256Hex(DEVICE_PUBKEY)}`);
    expect(readNonceRow(db, nonce)?.consumed_at).not.toBeNull();

    // Reap consumed rows past retention (cutoff far in the future).
    const res = runReaper(db, {
      nowIso: NOW,
      consumedRetentionCutoffIso: "2999-01-01T00:00:00.000Z",
    });

    expect(res.deletedConsumedRetired).toBe(1);
    expect(readNonceRow(db, nonce)).toBeNull();
    // The authoritative owner binding is untouched — single-owner still holds.
    expect(readOwnerHash(db)).toBe(ownerHash);
    // And a fresh claim still cannot seize the already-owned slot.
    const nonce2 = issueNonce(db);
    let caught: unknown;
    try {
      makeService(db).claimOwnerWithDeviceKey(claimReq({ nonce: nonce2 }), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).code).toBe("AUTH_BOOTSTRAP_ALREADY_DONE");
    expect(readOwnerHash(db)).toBe(ownerHash);
  });

  it("bounds the work per pass by batchLimit; a backlog drains over passes", () => {
    for (let i = 0; i < 5; i++) {
      insertRawNonce(db, `dead-${i}`, { expiresAt: "2026-07-12T00:00:00.000Z", consumedAt: null });
    }
    expect(countNonces(db)).toBe(5);

    const first = runReaper(db, { nowIso: NOW, batchLimit: 2 });
    expect(first.deletedExpiredUnconsumed).toBe(2);
    expect(countNonces(db)).toBe(3);

    const second = runReaper(db, { nowIso: NOW, batchLimit: 2 });
    expect(second.deletedExpiredUnconsumed).toBe(2);
    expect(countNonces(db)).toBe(1);

    const third = runReaper(db, { nowIso: NOW, batchLimit: 2 });
    expect(third.deletedExpiredUnconsumed).toBe(1);
    expect(countNonces(db)).toBe(0);
  });

  it("a batchLimit of 0 is a no-op (defensive)", () => {
    insertRawNonce(db, "dead", { expiresAt: "2026-07-12T00:00:00.000Z", consumedAt: null });
    const res = runReaper(db, { nowIso: NOW, batchLimit: 0 });
    expect(res.deletedExpiredUnconsumed).toBe(0);
    expect(countNonces(db)).toBe(1);
  });
});

describe("SEC-SETUP-BOOTSTRAP-001 s4: crash / restart recovery", () => {
  it("(a) issued-but-unconsumed nonce survives restart: no partial owner, still claimable", () => {
    const nonce = issueNonce(db, { nowIso: NOW });
    // Crash before the claim.
    restart();

    // No partial owner-claim: the slot is still NULL after restart.
    expect(readOwnerHash(db)).toBeNull();
    // The nonce persisted valid and is still consumable within its TTL.
    const res = makeService(db, NOW).claimOwnerWithDeviceKey(claimReq({ nonce }), LOOPBACK);
    expect(res.claimed).toBe(true);
    expect(readOwnerHash(db)).toBe(`${OWNER_HASH_PREFIX}${sha256Hex(DEVICE_PUBKEY)}`);
  });

  it("(a) issued-but-unconsumed nonce past TTL after restart: claim rejected, then reaped, no partial owner", () => {
    const nonce = issueNonce(db, { nowIso: NOW });
    restart();

    // Clock is now past the nonce TTL: the claim is rejected as expired.
    let caught: unknown;
    try {
      makeService(db, AFTER_TTL).claimOwnerWithDeviceKey(claimReq({ nonce }), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).code).toBe("AUTH_BOOTSTRAP_NONCE_INVALID");
    expect(readOwnerHash(db)).toBeNull();
    expect(readNonceRow(db, nonce)?.consumed_at).toBeNull();

    // The reaper then reclaims the expired, unconsumed row.
    const res = runReaper(db, { nowIso: AFTER_TTL });
    expect(res.deletedExpiredUnconsumed).toBe(1);
    expect(readNonceRow(db, nonce)).toBeNull();
    expect(readOwnerHash(db)).toBeNull();
  });

  it("(b) a consumed nonce stays consumed across restart (single-use holds)", () => {
    const nonce = issueNonce(db);
    makeService(db).claimOwnerWithDeviceKey(claimReq({ nonce }), LOOPBACK);
    expect(readNonceRow(db, nonce)?.consumed_at).not.toBeNull();

    restart();

    // Isolate the single-use nonce gate from the owner fast-path: clear the owner
    // slot, then replay the SAME nonce. It must still be rejected as consumed —
    // proving consumed_at durably survived the restart.
    db.withWriteTransaction((conn) =>
      conn.prepare("UPDATE users SET password_hash = NULL WHERE id = ?").run(OWNER_ID),
    );
    let caught: unknown;
    try {
      makeService(db).claimOwnerWithDeviceKey(claimReq({ nonce }), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).code).toBe("AUTH_BOOTSTRAP_NONCE_INVALID");
    expect(readOwnerHash(db)).toBeNull();
  });

  it("(c) owner-claim is idempotent under retry-after-restart: 409, never a double-claim", () => {
    const nonceA = issueNonce(db);
    makeService(db).claimOwnerWithDeviceKey(claimReq({ nonce: nonceA }), LOOPBACK);
    const ownerHash = readOwnerHash(db);
    expect(ownerHash).toBe(`${OWNER_HASH_PREFIX}${sha256Hex(DEVICE_PUBKEY)}`);

    restart();

    // A retried claim after restart — even with a FRESH nonce and a DIFFERENT
    // device — cannot re-own: it fails closed (409) and leaves the owner intact.
    const nonceB = issueNonce(db);
    const otherKey = generateTestDeviceKey(); // a DIFFERENT real device (valid PoP)
    let caught: unknown;
    try {
      makeService(db).claimOwnerWithDeviceKey(
        claimReq({ nonce: nonceB, key: otherKey, deviceId: "device-other" }),
        LOOPBACK,
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).code).toBe("AUTH_BOOTSTRAP_ALREADY_DONE");
    // No double-claim: owner hash unchanged (still device-A's binding).
    expect(readOwnerHash(db)).toBe(ownerHash);
  });

  it("(e) no-degrade: passphrase bootstrap still works across a restart", () => {
    makeService(db).bootstrapLocalPassphrase({ passphrase: "owner-passphrase-xyz" }, LOOPBACK);
    const afterPass = readOwnerHash(db);
    expect(afterPass?.startsWith("scrypt$")).toBe(true);

    restart();

    // The passphrase owner persists and a device claim still cannot seize it.
    expect(readOwnerHash(db)).toBe(afterPass);
    const nonce = issueNonce(db);
    let caught: unknown;
    try {
      makeService(db).claimOwnerWithDeviceKey(claimReq({ nonce }), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).code).toBe("AUTH_BOOTSTRAP_ALREADY_DONE");
    expect(readOwnerHash(db)).toBe(afterPass);
  });
});

// ─── SEC-SETUP-BOOTSTRAP-001 CR-1: device_login_challenge repo lifecycle ───
//
// Repo-level proofs (against the REAL full migration chain, incl. v107) for the
// single-use login-challenge nonce that makes the device-key login non-replayable
// (Advisor #1628 finding #2). No authority seam needed — this exercises the
// insert/consume CAS + the re-scoped single-owner index directly.

const LOGIN_EXP = "2026-07-13T00:05:00.000Z"; // NOW + 300s
const DEVICE_KEY_HASH = sha256Hex(DEVICE_PUBKEY);

function insertLoginChallenge(
  layer: FridaySqliteLayer,
  over: Partial<{
    nonce: string;
    origin: string;
    deviceId: string;
    devicePublicKeyHash: string;
    expiresAt: string;
  }> = {},
): string {
  const nonce = over.nonce ?? `login-nonce-${++idCounter}`;
  layer.withWriteTransaction((conn) =>
    nonceRepo.insertLoginChallengeNonce(conn, {
      id: `lc-${idCounter}-${Math.random().toString(36).slice(2, 8)}`,
      nonceHash: sha256Hex(nonce),
      hubId: "test-hub",
      installId: "install-1",
      osUser: "jarvis",
      origin: over.origin ?? ORIGIN,
      action: "owner-login",
      deviceId: over.deviceId ?? DEVICE_ID,
      devicePublicKey: DEVICE_PUBKEY,
      devicePublicKeyHash: over.devicePublicKeyHash ?? DEVICE_KEY_HASH,
      createdAt: NOW,
      expiresAt: over.expiresAt ?? LOGIN_EXP,
    }),
  );
  return nonce;
}

function consumeLogin(
  layer: FridaySqliteLayer,
  over: {
    nonce: string;
    origin?: string;
    nowIso?: string;
    deviceId?: string;
    devicePublicKeyHash?: string;
  },
): number {
  return layer.withWriteTransaction((conn) =>
    nonceRepo.consumeLoginChallengeNonce(conn, {
      nonceHash: sha256Hex(over.nonce),
      origin: over.origin ?? ORIGIN,
      nowIso: over.nowIso ?? NOW,
      deviceId: over.deviceId ?? DEVICE_ID,
      devicePublicKeyHash: over.devicePublicKeyHash ?? DEVICE_KEY_HASH,
    }),
  );
}

describe("SEC-SETUP-BOOTSTRAP-001 CR-1: device_login_challenge nonce", () => {
  it("is single-use: first consume wins (1), a replay yields 0", () => {
    const nonce = insertLoginChallenge(db);
    expect(consumeLogin(db, { nonce })).toBe(1);
    expect(readNonceRow(db, nonce)?.consumed_at).not.toBeNull();
    // Replay of the SAME nonce → already consumed → 0.
    expect(consumeLogin(db, { nonce })).toBe(0);
  });

  it("binds device + origin + key hash: any mismatch yields 0, the exact match yields 1", () => {
    const nonce = insertLoginChallenge(db);
    expect(consumeLogin(db, { nonce, deviceId: "other-device" })).toBe(0);
    expect(consumeLogin(db, { nonce, origin: "https://evil.localhost" })).toBe(0);
    expect(consumeLogin(db, { nonce, devicePublicKeyHash: sha256Hex("other-key") })).toBe(0);
    // Still unconsumed after all the mismatched attempts.
    expect(readNonceRow(db, nonce)?.consumed_at).toBeNull();
    // The exact match consumes it once.
    expect(consumeLogin(db, { nonce })).toBe(1);
  });

  it("cannot be consumed past its expiry", () => {
    const nonce = insertLoginChallenge(db, { expiresAt: "2026-07-12T00:00:00.000Z" });
    expect(consumeLogin(db, { nonce, nowIso: NOW })).toBe(0);
    expect(readNonceRow(db, nonce)?.consumed_at).toBeNull();
  });

  it("a consumed login challenge stays consumed across a restart (single-use holds)", () => {
    const nonce = insertLoginChallenge(db);
    expect(consumeLogin(db, { nonce })).toBe(1);

    restart();

    expect(readNonceRow(db, nonce)?.consumed_at).not.toBeNull();
    // A replay after restart still finds it consumed → 0.
    expect(consumeLogin(db, { nonce })).toBe(0);
  });

  it("MANY login challenges can be consumed (the re-scoped single-owner index excludes the login kind)", () => {
    // Two DISTINCT login challenges, both consumed — this would violate the pre-v107
    // single-owner UNIQUE(kind) belt, but v107 re-scoped it to exclude the login kind.
    const a = insertLoginChallenge(db, { nonce: "login-a" });
    const b = insertLoginChallenge(db, { nonce: "login-b" });
    expect(consumeLogin(db, { nonce: a })).toBe(1);
    expect(consumeLogin(db, { nonce: b })).toBe(1);
    const consumed = db.withReadConnection((conn) =>
      (conn
        .prepare(
          "SELECT COUNT(*) AS c FROM friday_setup_bootstrap_nonces WHERE kind = 'device_login_challenge' AND consumed_at IS NOT NULL",
        )
        .get() as { c: number }).c,
    );
    expect(consumed).toBe(2);
  });
});

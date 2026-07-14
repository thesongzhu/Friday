/**
 * Adversarial Device-Bound Owner Claim (SEC-SETUP-BOOTSTRAP-001, slice 1)
 *
 * Backend primitive that will replace the developer-passphrase bootstrap: a
 * single-use install nonce (challenge) + a device-bound, replay-protected,
 * origin-bound, crash-safe atomic owner claim on the local admin-001 slot.
 *
 * These tests run the REAL production code path against a REAL file-backed
 * SQLite layer (createFridaySqliteLayer → real migrations → real WAL), seeded
 * with admin-001 EXACTLY as src/hub/friday-hub-bootstrap.ts seeds it
 * (password_hash NULL, is_local_only=1). No in-memory mock, no route-exists
 * smoke check — the claim's security properties are exercised end-to-end.
 *
 * §5 matrix:
 *   (a) concurrent claim — exactly one wins; the loser changes ZERO state.
 *   (b) replay          — a consumed / expired install-nonce is rejected.
 *   (c) crash/atomicity — a failure mid-claim leaves NO partial owner.
 *   (d) origin/loopback — cross-origin + non-loopback claims fail closed.
 *   (e) no-degrade      — the passphrase bootstrap + login path still behave.
 *
 * Red-first: each assertion targets a real DEFECT that appears when the
 * corresponding guard is removed (see PR body red→green→revert-red evidence),
 * not a missing-symbol error.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { createFridayAuthService } from "#api";
import { FridayDomainError } from "#errors";
import { createFridaySqliteLayer } from "#state";
import type { FridaySqliteLayer } from "#state";

const OWNER_ID = "admin-001";
const NOW = "2026-07-13T00:00:00.000Z";
const LATER_AFTER_TTL = "2026-07-13T00:10:00.000Z"; // > NOW + 300s
const LOOPBACK = "127.0.0.1";
const ORIGIN = "https://friday.localhost";
const DEVICE_PUBKEY = crypto.randomBytes(32).toString("base64url");
const DEVICE_ID = "device-abc-001";
const OWNER_HASH_PREFIX = "device-owner$v1$";

function sha256Hex(v: string): string {
  return crypto.createHash("sha256").update(v).digest("hex");
}

/** Seeds admin-001 byte-for-byte like the hub's first-boot seed. */
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
    idGenerator: (() => {
      let n = 0;
      return () => `id-${String(++n).padStart(4, "0")}`;
    })(),
    nowIso: () => nowIso,
    tokenSecret: "test-secret-key-for-device-claim-0001", // pragma: allowlist secret
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 604_800,
    hubId: "test-hub",
    bootstrapNonceTtlSec: 300,
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

function issueNonce(db: FridaySqliteLayer, over?: { origin?: string; nowIso?: string }): string {
  const svc = makeService(db, over?.nowIso ?? NOW);
  const res = svc.issueBootstrapChallenge(
    { installId: "install-1", osUser: "jarvis", origin: over?.origin ?? ORIGIN },
    LOOPBACK,
  );
  return res.nonce;
}

function claimReq(over?: Partial<{ nonce: string; origin: string; devicePublicKey: string; deviceId: string }>) {
  return {
    nonce: over?.nonce ?? "",
    devicePublicKey: over?.devicePublicKey ?? DEVICE_PUBKEY,
    deviceId: over?.deviceId ?? DEVICE_ID,
    origin: over?.origin ?? ORIGIN,
    installId: "install-1",
    osUser: "jarvis",
  };
}

let db: FridaySqliteLayer;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-secsetup-"));
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

describe("SEC-SETUP-BOOTSTRAP-001: device-bound owner claim", () => {
  it("happy path: issue → claim binds device + flips ownership, nonce consumed", () => {
    const nonce = issueNonce(db);
    const svc = makeService(db);

    const res = svc.claimOwnerWithDeviceKey(claimReq({ nonce }), LOOPBACK);

    expect(res.claimed).toBe(true);
    expect(res.userId).toBe(OWNER_ID);
    expect(res.deviceId).toBe(DEVICE_ID);
    expect(res.devicePublicKeyHash).toBe(sha256Hex(DEVICE_PUBKEY));

    // Ownership flipped to the device-owner sentinel (never a real passphrase).
    const ownerHash = readOwnerHash(db);
    expect(ownerHash?.startsWith(OWNER_HASH_PREFIX)).toBe(true);
    expect(ownerHash).toBe(`${OWNER_HASH_PREFIX}${sha256Hex(DEVICE_PUBKEY)}`);

    // Nonce row is durably consumed and carries the winning device binding.
    const row = readNonceRow(db, nonce);
    expect(row?.consumed_at).not.toBeNull();
    expect(row?.device_public_key).toBe(DEVICE_PUBKEY);
    expect(row?.device_public_key_hash).toBe(sha256Hex(DEVICE_PUBKEY));
    expect(row?.claimed_user_id).toBe(OWNER_ID);

    // Bootstrap is now reported complete.
    expect(svc.getBootstrapStatus().bootstrapRequired).toBe(false);
  });

  it("(a) concurrent claim: a competitor inside the TOCTOU window wins; loser changes ZERO state", () => {
    const nonce = issueNonce(db);
    const competitorHash = `${OWNER_HASH_PREFIX}${sha256Hex("competitor-device")}`;

    // racyDb models a second install/device that committed its own owner claim
    // INSIDE the window: on the FIRST withWriteTransaction (our claim txn) it
    // first commits the competitor's owner slot, then delegates to the real txn.
    let fired = false;
    const racyDb: FridaySqliteLayer = {
      ...db,
      withWriteTransaction<T>(fn: (conn: Database.Database) => T): T {
        if (!fired) {
          fired = true;
          db.writer
            .prepare("UPDATE users SET password_hash = ? WHERE id = ? AND password_hash IS NULL")
            .run(competitorHash, OWNER_ID);
        }
        return db.withWriteTransaction(fn);
      },
    };
    const svc = makeService(racyDb);

    let caught: unknown;
    try {
      svc.claimOwnerWithDeviceKey(claimReq({ nonce }), LOOPBACK);
    } catch (err) {
      caught = err;
    }

    // Loser fails closed (409). The service's early read saw NULL, so the CAS is
    // the only thing that can reject — proving the atomic guard, not the pre-check.
    expect(caught).toBeInstanceOf(FridayDomainError);
    expect((caught as FridayDomainError).httpStatus).toBe(409);

    // ZERO state change from the loser: competitor survives, nonce NOT consumed.
    expect(readOwnerHash(db)).toBe(competitorHash);
    expect(readNonceRow(db, nonce)?.consumed_at).toBeNull();
  });

  it("(b) replay: a consumed install-nonce is rejected (NONCE_INVALID), ZERO state change", () => {
    const nonce = issueNonce(db);
    makeService(db).claimOwnerWithDeviceKey(claimReq({ nonce }), LOOPBACK);

    // Clear the owner slot to ISOLATE the nonce-replay gate from the owner-CAS.
    db.withWriteTransaction((conn) =>
      conn.prepare("UPDATE users SET password_hash = NULL WHERE id = ?").run(OWNER_ID),
    );

    let caught: unknown;
    try {
      makeService(db).claimOwnerWithDeviceKey(claimReq({ nonce }), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FridayDomainError);
    expect((caught as FridayDomainError).code).toBe("AUTH_BOOTSTRAP_NONCE_INVALID");
    // Owner slot stays NULL — the replayed nonce produced no ownership.
    expect(readOwnerHash(db)).toBeNull();
  });

  it("(b) replay: an EXPIRED install-nonce is rejected, ZERO state change", () => {
    const nonce = issueNonce(db, { nowIso: NOW }); // expires_at = NOW + 300s
    // Claim with a clock AFTER expiry.
    const svc = makeService(db, LATER_AFTER_TTL);

    let caught: unknown;
    try {
      svc.claimOwnerWithDeviceKey(claimReq({ nonce }), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FridayDomainError);
    expect((caught as FridayDomainError).code).toBe("AUTH_BOOTSTRAP_NONCE_INVALID");
    expect(readOwnerHash(db)).toBeNull();
    expect(readNonceRow(db, nonce)?.consumed_at).toBeNull();
  });

  it("(c) crash/atomicity: a failure AFTER nonce-consume, BEFORE owner-set leaves NO partial owner", () => {
    const nonce = issueNonce(db);

    // crashDb runs the claim inside a REAL write transaction but makes the owner
    // CAS statement throw — modelling a crash/IO error mid-claim. Because both
    // writes share one transaction, the already-run nonce-consume MUST roll back.
    const crashDb: FridaySqliteLayer = {
      ...db,
      withWriteTransaction<T>(fn: (conn: Database.Database) => T): T {
        const proxy = new Proxy(db.writer, {
          get(target, prop, receiver) {
            if (prop === "prepare") {
              return (sql: string) => {
                // Match the owner-slot write only (never the nonce consume, which
                // targets friday_setup_bootstrap_nonces) so the injection is robust
                // to the exact owner-CAS predicate text.
                if (sql.includes("UPDATE users SET password_hash")) {
                  return {
                    run() {
                      throw new Error("injected crash mid-claim (owner CAS)");
                    },
                  } as unknown as Database.Statement;
                }
                return target.prepare(sql);
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as unknown as Database.Database;
        const txn = db.writer.transaction(() => fn(proxy));
        return txn.immediate();
      },
    };

    let caught: unknown;
    try {
      makeService(crashDb).claimOwnerWithDeviceKey(claimReq({ nonce }), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);

    // No partial owner: slot NULL AND nonce NOT consumed (whole unit rolled back).
    expect(readOwnerHash(db)).toBeNull();
    expect(readNonceRow(db, nonce)?.consumed_at).toBeNull();
  });

  it("(d) cross-origin: a claim from a different origin fails closed, ZERO state change", () => {
    const nonce = issueNonce(db, { origin: ORIGIN });

    let caught: unknown;
    try {
      makeService(db).claimOwnerWithDeviceKey(
        claimReq({ nonce, origin: "https://evil.localhost" }),
        LOOPBACK,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FridayDomainError);
    expect((caught as FridayDomainError).code).toBe("AUTH_BOOTSTRAP_NONCE_INVALID");
    expect(readOwnerHash(db)).toBeNull();
    expect(readNonceRow(db, nonce)?.consumed_at).toBeNull();
  });

  it("(d) loopback-only: a non-loopback claim / issue fails closed (403)", () => {
    const nonce = issueNonce(db);

    let claimErr: unknown;
    try {
      makeService(db).claimOwnerWithDeviceKey(claimReq({ nonce }), "10.0.0.5");
    } catch (err) {
      claimErr = err;
    }
    expect((claimErr as FridayDomainError).httpStatus).toBe(403);
    expect(readOwnerHash(db)).toBeNull();

    let issueErr: unknown;
    try {
      makeService(db).issueBootstrapChallenge(
        { installId: "install-1", osUser: "jarvis", origin: ORIGIN },
        "10.0.0.5",
      );
    } catch (err) {
      issueErr = err;
    }
    expect((issueErr as FridayDomainError).httpStatus).toBe(403);
  });

  it("only the raw-nonce HASH is persisted — never the raw nonce", () => {
    const nonce = issueNonce(db);
    const raw = db.withReadConnection((conn) => {
      const rows = conn.prepare("SELECT nonce_hash FROM friday_setup_bootstrap_nonces").all() as {
        nonce_hash: string;
      }[];
      return rows.map((r) => r.nonce_hash);
    });
    expect(raw).toContain(sha256Hex(nonce));
    expect(raw).not.toContain(nonce);
  });

  it("(e) no-degrade: device claim after passphrase bootstrap fails closed (single owner slot)", () => {
    const svc = makeService(db);
    // Passphrase path still works unchanged.
    const boot = svc.bootstrapLocalPassphrase({ passphrase: "owner-passphrase-xyz" }, LOOPBACK);
    expect(boot.initialized).toBe(true);
    const afterPass = readOwnerHash(db);
    expect(afterPass?.startsWith("scrypt$")).toBe(true);

    // A device claim now cannot seize the already-owned slot.
    const nonce = issueNonce(db);
    let caught: unknown;
    try {
      makeService(db).claimOwnerWithDeviceKey(claimReq({ nonce }), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).code).toBe("AUTH_BOOTSTRAP_ALREADY_DONE");
    // Passphrase hash untouched — no degrade.
    expect(readOwnerHash(db)).toBe(afterPass);
  });

  it("(e) no-degrade: passphrase login fails closed against a device-claimed owner (no bypass)", () => {
    const nonce = issueNonce(db);
    makeService(db).claimOwnerWithDeviceKey(claimReq({ nonce }), LOOPBACK);

    // The device-owner sentinel is NOT a usable passphrase credential.
    let caught: unknown;
    try {
      makeService(db).login({ localPassphrase: "anything-at-all" }, LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as FridayDomainError).code).toBe("INVALID_CREDENTIALS");

    // And passphrase bootstrap is now closed (owner already claimed).
    let bootErr: unknown;
    try {
      makeService(db).bootstrapLocalPassphrase({ passphrase: "brand-new-passphrase" }, LOOPBACK);
    } catch (err) {
      bootErr = err;
    }
    expect((bootErr as FridayDomainError).code).toBe("AUTH_BOOTSTRAP_ALREADY_DONE");
  });
});

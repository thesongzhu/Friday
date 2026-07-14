/**
 * Adversarial Authenticated Legacy-Passphrase → Device Migration
 * (SEC-SETUP-BOOTSTRAP-001, Slice 5 — stage 2 of the operator-locked FIXED order)
 *
 * These tests run the REAL production code path against a REAL file-backed SQLite
 * layer (createFridaySqliteLayer → real migrations incl. v104 → real WAL), seeded
 * with admin-001 EXACTLY as src/hub/friday-hub-bootstrap.ts seeds it, then given a
 * real scrypt passphrase credential via the REAL bootstrapLocalPassphrase path.
 * No in-memory mock, no route-exists smoke check.
 *
 * The migration is ADDITIVE / dual-read / reversible:
 *   - authenticated OWNER + valid device PoP → a PROVISIONAL device binding is
 *     added AND users.password_hash STAYS scrypt$… (the passphrase STILL works —
 *     NO lockout). The device binding carries ZERO authority.
 *   - it CAS-consumes a SECOND-kind ('device_migration_claim') install nonce.
 *   - the tombstone/rollback scaffolding is INACTIVE: password_hash is NEVER
 *     flipped to the device sentinel this slice, and no tombstone row is written.
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
import type { FridayAuthPrincipal, FridayScope } from "../../src/api/model/friday-api-auth.types.js";
import { getScopesForRole } from "../../src/api/auth/friday-rbac-policy.js";
import { isDeviceOwnerAuthorityEnabled } from "../../src/security/friday-device-owner-authority-precondition.js";
import { generateTestDeviceKey, makeTranscript, signTranscriptLowS } from "./_secsetup-s2a.helpers.js";

const OWNER_ID = "admin-001";
const NOW = "2026-07-13T00:00:00.000Z";
const LATER_AFTER_TTL = "2026-07-13T00:10:00.000Z"; // > NOW + 300s
const LOOPBACK = "127.0.0.1";
const ORIGIN = "https://friday.localhost";
const PASSPHRASE = "owner-passphrase-xyz-123"; // pragma: allowlist secret
const DEVICE_KEY = generateTestDeviceKey();
const DEVICE_PUBKEY = DEVICE_KEY.spkiDerBase64;
const DEVICE_ID = "device-migrate-001";
const DEVICE_OWNER_SENTINEL_PREFIX = "device-owner$v1$";

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
    tokenSecret: "test-secret-key-for-migration-000001", // pragma: allowlist secret
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 604_800,
    hubId: "test-hub",
    bootstrapNonceTtlSec: 300,
    warn: () => {},
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

function readBindings(db: FridaySqliteLayer): Record<string, unknown>[] {
  return db.withReadConnection((conn) =>
    conn.prepare("SELECT * FROM friday_device_owner_bindings WHERE user_id = ?").all(OWNER_ID) as Record<string, unknown>[],
  );
}

function readTombstones(db: FridaySqliteLayer): Record<string, unknown>[] {
  return db.withReadConnection((conn) =>
    conn.prepare("SELECT * FROM friday_credential_tombstones WHERE user_id = ?").all(OWNER_ID) as Record<string, unknown>[],
  );
}

function readNonceRow(db: FridaySqliteLayer, nonce: string): Record<string, unknown> | null {
  return db.withReadConnection((conn) => {
    const row = conn
      .prepare("SELECT * FROM friday_setup_bootstrap_nonces WHERE nonce_hash = ?")
      .get(sha256Hex(nonce)) as Record<string, unknown> | undefined;
    return row ?? null;
  });
}

/** Seed admin-001 AND set the real scrypt passphrase credential (the migration source). */
function seedPassphraseOwner(db: FridaySqliteLayer): void {
  seedOwner(db);
  makeService(db).bootstrapLocalPassphrase({ passphrase: PASSPHRASE }, LOOPBACK);
}

function issueMigrationNonce(
  db: FridaySqliteLayer,
  principal: FridayAuthPrincipal = ownerPrincipal(),
  over?: { origin?: string; nowIso?: string },
): string {
  const svc = makeService(db, over?.nowIso ?? NOW);
  const res = svc.issueMigrationChallenge(
    { installId: "install-m1", osUser: "jarvis", origin: over?.origin ?? ORIGIN },
    principal,
    LOOPBACK,
  );
  return res.nonce;
}

function migrateReq(over?: Partial<{ nonce: string; origin: string; devicePublicKey: string; deviceId: string }>) {
  const nonce = over?.nonce ?? "";
  const origin = over?.origin ?? ORIGIN;
  const deviceId = over?.deviceId ?? DEVICE_ID;
  const devicePublicKey = over?.devicePublicKey ?? DEVICE_PUBKEY;
  const transcript = makeTranscript(DEVICE_KEY, {
    nonce,
    origin,
    deviceId,
    action: "owner-migrate",
    installId: "install-m1",
    osUser: "jarvis",
  });
  const signature = { encoding: "ieee-p1363-base64" as const, value: signTranscriptLowS(DEVICE_KEY, transcript) };
  return {
    nonce,
    devicePublicKey,
    deviceId,
    origin,
    installId: "install-m1",
    osUser: "jarvis",
    deviceClaimProof: { transcript, signature },
  };
}

let db: FridaySqliteLayer;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-secsetup-s5-"));
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

describe("SEC-SETUP-BOOTSTRAP-001 Slice 5: authenticated dual-read migration", () => {
  it("happy path: authenticated owner + valid PoP → provisional bind; passphrase STILL works; ZERO device authority", () => {
    seedPassphraseOwner(db);
    const beforeHash = readOwnerHash(db);
    expect(beforeHash?.startsWith("scrypt$")).toBe(true);

    const nonce = issueMigrationNonce(db);
    const res = makeService(db).migrateOwnerToDeviceKey(migrateReq({ nonce }), ownerPrincipal(), LOOPBACK);

    // Provisional migration succeeded with ZERO authority.
    expect(res.migrated).toBe(true);
    expect(res.state).toBe("provisional");
    expect(res.userId).toBe(OWNER_ID);
    expect(res.deviceId).toBe(DEVICE_ID);
    expect(res.devicePublicKeyHash).toBe(sha256Hex(DEVICE_PUBKEY));
    expect(res.passphraseStillActive).toBe(true);
    expect(res.deviceAuthorityEnabled).toBe(false);
    expect(res.keyProtection).toBe("unverified");
    expect(isDeviceOwnerAuthorityEnabled()).toBe(false);

    // DUAL-READ: password_hash UNCHANGED (still scrypt) — NOT flipped to the sentinel.
    const afterHash = readOwnerHash(db);
    expect(afterHash).toBe(beforeHash);
    expect(afterHash?.startsWith(DEVICE_OWNER_SENTINEL_PREFIX)).toBe(false);

    // A single 'provisional' binding row was added, NOT 'active'.
    const bindings = readBindings(db);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].state).toBe("provisional");
    expect(bindings[0].migrated_from).toBe("passphrase");
    expect(bindings[0].device_public_key_hash).toBe(sha256Hex(DEVICE_PUBKEY));
    expect(bindings[0].activated_at).toBeNull();

    // NO-LOCKOUT: the passphrase login STILL works after migration.
    const login = makeService(db).login({ localPassphrase: PASSPHRASE }, LOOPBACK);
    expect(login.accessToken).toBeTruthy();
    expect(login.user.id).toBe(OWNER_ID);

    // Tombstone scaffolding is INACTIVE — no tombstone written this slice.
    expect(readTombstones(db)).toHaveLength(0);

    // The migration nonce is durably consumed and carries the binding context.
    const row = readNonceRow(db, nonce);
    expect(row?.consumed_at).not.toBeNull();
    expect(row?.kind).toBe("device_migration_claim");
    expect(row?.claimed_user_id).toBe(OWNER_ID);
  });

  it("refuses the synthetic public principal (401) — ZERO state change", () => {
    seedPassphraseOwner(db);
    const nonce = issueMigrationNonce(db);

    let caught: unknown;
    try {
      makeService(db).migrateOwnerToDeviceKey(migrateReq({ nonce }), publicPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).httpStatus).toBe(401);
    expect((caught as FridayDomainError).code).toBe("AUTH_MIGRATE_OWNER_REQUIRED");
    expect(readBindings(db)).toHaveLength(0);
    expect(readNonceRow(db, nonce)?.consumed_at).toBeNull();
  });

  it("refuses a null principal (401)", () => {
    seedPassphraseOwner(db);
    const nonce = issueMigrationNonce(db);
    let caught: unknown;
    try {
      makeService(db).migrateOwnerToDeviceKey(migrateReq({ nonce }), null, LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).httpStatus).toBe(401);
    expect(readBindings(db)).toHaveLength(0);
  });

  it("refuses a non-owner authenticated principal — wrong identity (403)", () => {
    seedPassphraseOwner(db);
    const nonce = issueMigrationNonce(db);
    // admin role + security.write scope, but principalId is a DIFFERENT user.
    const notOwner = ownerPrincipal({ principalId: "user:mallory", userId: "user:mallory" });

    let caught: unknown;
    try {
      makeService(db).migrateOwnerToDeviceKey(migrateReq({ nonce }), notOwner, LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).httpStatus).toBe(403);
    expect((caught as FridayDomainError).code).toBe("AUTH_MIGRATE_FORBIDDEN");
    expect(readBindings(db)).toHaveLength(0);
    expect(readNonceRow(db, nonce)?.consumed_at).toBeNull();
  });

  it("refuses a non-owner authenticated principal — wrong role (403)", () => {
    seedPassphraseOwner(db);
    const nonce = issueMigrationNonce(db);
    // Correct local-owner id, but a viewer role (not owner/admin).
    const viewer = ownerPrincipal({ role: "viewer", scopes: [...getScopesForRole("viewer")] as FridayScope[] });

    let caught: unknown;
    try {
      makeService(db).migrateOwnerToDeviceKey(migrateReq({ nonce }), viewer, LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).httpStatus).toBe(403);
    expect((caught as FridayDomainError).code).toBe("AUTH_MIGRATE_FORBIDDEN");
    expect(readBindings(db)).toHaveLength(0);
  });

  it("refuses a missing proof-of-possession (400) — nonce un-burned, no binding", () => {
    seedPassphraseOwner(db);
    const nonce = issueMigrationNonce(db);
    const req = migrateReq({ nonce });
    delete (req as { deviceClaimProof?: unknown }).deviceClaimProof;

    let caught: unknown;
    try {
      makeService(db).migrateOwnerToDeviceKey(req, ownerPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).httpStatus).toBe(400);
    expect((caught as FridayDomainError).code).toBe("AUTH_MIGRATE_POP_REQUIRED");
    expect(readBindings(db)).toHaveLength(0);
    expect(readNonceRow(db, nonce)?.consumed_at).toBeNull();
  });

  it("refuses a PoP-unverified (wrong-key) claim (401) — nonce un-burned, no binding", () => {
    seedPassphraseOwner(db);
    const nonce = issueMigrationNonce(db);
    // Sign the transcript with an UNRELATED key: possession of the presented key
    // is NOT proven, so the S2a verifier rejects it.
    const attacker = generateTestDeviceKey();
    const transcript = makeTranscript(DEVICE_KEY, { nonce, origin: ORIGIN, deviceId: DEVICE_ID, action: "owner-migrate", installId: "install-m1", osUser: "jarvis" });
    const forged = {
      ...migrateReq({ nonce }),
      deviceClaimProof: {
        transcript,
        signature: { encoding: "ieee-p1363-base64" as const, value: signTranscriptLowS(attacker, transcript) },
      },
    };

    let caught: unknown;
    try {
      makeService(db).migrateOwnerToDeviceKey(forged, ownerPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).httpStatus).toBe(401);
    expect((caught as FridayDomainError).code).toBe("AUTH_MIGRATE_POP_INVALID");
    expect(readBindings(db)).toHaveLength(0);
    expect(readNonceRow(db, nonce)?.consumed_at).toBeNull();
  });

  it("refuses migration against a NULL owner slot — first-boot must NOT reuse the bootstrap leg (409)", () => {
    seedOwner(db); // password_hash NULL, NO passphrase set
    // The challenge itself is refused for a NULL owner, so issue directly via a
    // service that has a passphrase, then clear it to isolate the migrate CAS.
    // Simpler: assert issueMigrationChallenge refuses NULL, then assert migrate
    // refuses even if a nonce somehow existed.
    let challengeErr: unknown;
    try {
      issueMigrationNonce(db);
    } catch (err) {
      challengeErr = err;
    }
    expect((challengeErr as FridayDomainError).httpStatus).toBe(409);
    expect((challengeErr as FridayDomainError).code).toBe("AUTH_MIGRATE_NO_LEGACY_OWNER");

    // And the migrate primitive itself refuses a NULL owner (defence-in-depth),
    // regardless of any nonce — proving it never reuses the first-boot leg.
    let migrateErr: unknown;
    try {
      makeService(db).migrateOwnerToDeviceKey(migrateReq({ nonce: "any-nonce" }), ownerPrincipal(), LOOPBACK);
    } catch (err) {
      migrateErr = err;
    }
    expect((migrateErr as FridayDomainError).code).toBe("AUTH_MIGRATE_NO_LEGACY_OWNER");
    expect(readOwnerHash(db)).toBeNull();
    expect(readBindings(db)).toHaveLength(0);
  });

  it("refuses migration when already device-owned (sentinel) — no re-migration (409)", () => {
    seedOwner(db);
    // Simulate a committed device-owner (a later stage's terminal state).
    db.withWriteTransaction((conn) =>
      conn
        .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
        .run(`${DEVICE_OWNER_SENTINEL_PREFIX}${sha256Hex("some-device")}`, OWNER_ID),
    );
    let caught: unknown;
    try {
      makeService(db).migrateOwnerToDeviceKey(migrateReq({ nonce: "any-nonce" }), ownerPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).code).toBe("AUTH_MIGRATE_NO_LEGACY_OWNER");
    expect(readBindings(db)).toHaveLength(0);
  });

  it("replay: a consumed migration nonce is rejected (409), no second binding", () => {
    seedPassphraseOwner(db);
    const nonce = issueMigrationNonce(db);
    makeService(db).migrateOwnerToDeviceKey(migrateReq({ nonce }), ownerPrincipal(), LOOPBACK);
    expect(readBindings(db)).toHaveLength(1);

    let caught: unknown;
    try {
      makeService(db).migrateOwnerToDeviceKey(migrateReq({ nonce }), ownerPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).code).toBe("AUTH_MIGRATE_NONCE_INVALID");
    // Still exactly ONE binding, password_hash still scrypt.
    expect(readBindings(db)).toHaveLength(1);
    expect(readOwnerHash(db)?.startsWith("scrypt$")).toBe(true);
  });

  it("expiry: an expired migration nonce is rejected at the DB CAS (409)", () => {
    seedPassphraseOwner(db);
    const nonce = issueMigrationNonce(db, ownerPrincipal(), { nowIso: NOW }); // expires NOW+300s
    // Present with a clock AFTER expiry.
    let caught: unknown;
    try {
      makeService(db, LATER_AFTER_TTL).migrateOwnerToDeviceKey(migrateReq({ nonce }), ownerPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).code).toBe("AUTH_MIGRATE_NONCE_INVALID");
    expect(readBindings(db)).toHaveLength(0);
    expect(readNonceRow(db, nonce)?.consumed_at).toBeNull();
  });

  it("cross-origin: a migration nonce presented from a different origin fails at the DB CAS (409)", () => {
    seedPassphraseOwner(db);
    const nonce = issueMigrationNonce(db, ownerPrincipal(), { origin: ORIGIN });
    let caught: unknown;
    try {
      makeService(db).migrateOwnerToDeviceKey(
        migrateReq({ nonce, origin: "https://evil.localhost" }),
        ownerPrincipal(),
        LOOPBACK,
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).code).toBe("AUTH_MIGRATE_NONCE_INVALID");
    expect(readBindings(db)).toHaveLength(0);
    expect(readNonceRow(db, nonce)?.consumed_at).toBeNull();
  });

  it("cross-kind: an install_owner_claim (first-boot) nonce cannot be consumed by migration (409)", () => {
    seedPassphraseOwner(db);
    // Mint a FIRST-BOOT owner-claim nonce (kind install_owner_claim), then try to
    // spend it on the migration path. The consume CAS matches on kind, so it
    // fails closed — a first-boot nonce can never be replayed into a migration.
    const bootstrapNonce = makeService(db).issueBootstrapChallenge(
      { installId: "install-m1", osUser: "jarvis", origin: ORIGIN },
      LOOPBACK,
    ).nonce;

    let caught: unknown;
    try {
      makeService(db).migrateOwnerToDeviceKey(migrateReq({ nonce: bootstrapNonce }), ownerPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).code).toBe("AUTH_MIGRATE_NONCE_INVALID");
    expect(readBindings(db)).toHaveLength(0);
    expect(readNonceRow(db, bootstrapNonce)?.consumed_at).toBeNull();
  });

  it("loopback-only: a non-loopback migrate / challenge fails closed (403)", () => {
    seedPassphraseOwner(db);
    let migrateErr: unknown;
    try {
      makeService(db).migrateOwnerToDeviceKey(migrateReq({ nonce: "any" }), ownerPrincipal(), "10.0.0.5");
    } catch (err) {
      migrateErr = err;
    }
    expect((migrateErr as FridayDomainError).httpStatus).toBe(403);
    expect(readBindings(db)).toHaveLength(0);

    let challengeErr: unknown;
    try {
      makeService(db).issueMigrationChallenge({ installId: "i", osUser: "u", origin: ORIGIN }, ownerPrincipal(), "10.0.0.5");
    } catch (err) {
      challengeErr = err;
    }
    expect((challengeErr as FridayDomainError).httpStatus).toBe(403);
  });

  it("crash/atomicity: a failure AFTER nonce-consume, BEFORE the binding insert leaves NO partial state", () => {
    seedPassphraseOwner(db);
    const nonce = issueMigrationNonce(db);
    const beforeHash = readOwnerHash(db);

    // crashDb runs the migrate inside a REAL write transaction but makes the
    // binding INSERT throw. Because both writes share one transaction, the
    // already-run nonce-consume MUST roll back.
    const crashDb: FridaySqliteLayer = {
      ...db,
      withWriteTransaction<T>(fn: (conn: Database.Database) => T): T {
        const proxy = new Proxy(db.writer, {
          get(target, prop, receiver) {
            if (prop === "prepare") {
              return (sql: string) => {
                if (sql.includes("INSERT INTO friday_device_owner_bindings")) {
                  return {
                    run() {
                      throw new Error("injected crash mid-migration (binding insert)");
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
      makeService(crashDb).migrateOwnerToDeviceKey(migrateReq({ nonce }), ownerPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);

    // Whole unit rolled back: nonce NOT consumed, NO binding, password_hash unchanged.
    expect(readNonceRow(db, nonce)?.consumed_at).toBeNull();
    expect(readBindings(db)).toHaveLength(0);
    expect(readOwnerHash(db)).toBe(beforeHash);
  });

  it("concurrent owner-change: password_hash rotated mid-migration aborts with ZERO state change (409)", () => {
    seedPassphraseOwner(db);
    const nonce = issueMigrationNonce(db);
    const rotatedHash = `scrypt$${"a".repeat(64)}$${"b".repeat(128)}`;

    // racyDb rotates the owner's password_hash INSIDE the TOCTOU window (after the
    // service captured `observedHash` but before/within the migrate txn).
    let fired = false;
    const racyDb: FridaySqliteLayer = {
      ...db,
      withWriteTransaction<T>(fn: (conn: Database.Database) => T): T {
        if (!fired) {
          fired = true;
          db.writer.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(rotatedHash, OWNER_ID);
        }
        return db.withWriteTransaction(fn);
      },
    };

    let caught: unknown;
    try {
      makeService(racyDb).migrateOwnerToDeviceKey(migrateReq({ nonce }), ownerPrincipal(), LOOPBACK);
    } catch (err) {
      caught = err;
    }
    expect((caught as FridayDomainError).httpStatus).toBe(409);
    expect((caught as FridayDomainError).code).toBe("AUTH_MIGRATE_OWNER_CHANGED");
    // The rotated hash survives; no binding; the nonce is NOT consumed (rolled back).
    expect(readOwnerHash(db)).toBe(rotatedHash);
    expect(readBindings(db)).toHaveLength(0);
    expect(readNonceRow(db, nonce)?.consumed_at).toBeNull();
  });

  it("no-degrade: the passphrase bootstrap + login path is fully intact (regression)", () => {
    // A fresh machine still bootstraps + logs in by passphrase exactly as before.
    seedOwner(db);
    const boot = makeService(db).bootstrapLocalPassphrase({ passphrase: PASSPHRASE }, LOOPBACK);
    expect(boot.initialized).toBe(true);
    expect(readOwnerHash(db)?.startsWith("scrypt$")).toBe(true);

    const login = makeService(db).login({ localPassphrase: PASSPHRASE }, LOOPBACK);
    expect(login.user.id).toBe(OWNER_ID);

    let badErr: unknown;
    try {
      makeService(db).login({ localPassphrase: "wrong-passphrase" }, LOOPBACK);
    } catch (err) {
      badErr = err;
    }
    expect((badErr as FridayDomainError).code).toBe("INVALID_CREDENTIALS");
  });
});

/**
 * Adversarial Bootstrap Claim Race (SEC-SETUP-BOOTSTRAP-001)
 *
 * Models the TOCTOU / last-writer-wins ownership-seizure gap in
 * `bootstrapLocalPassphrase`: the ownership pre-check reads `password_hash`
 * OUTSIDE the write transaction, then (before the CAS fix) issued an
 * UNCONDITIONAL UPDATE. Two concurrent claimants (two hub processes, or a
 * hostile local process sharing the SQLite DB) both observe NULL and both
 * write → the losing/late claim clobbers the legitimate owner's passphrase.
 *
 * The race is modelled deterministically at the injected `db` seam: a `racyDb`
 * wraps the real FridaySqliteLayer and, the first time `withWriteTransaction`
 * is entered, commits a COMPETITOR claim (a process that claimed inside the
 * window) BEFORE delegating to the real transaction. The code under test runs
 * 100% real — `findLocalUser` legitimately reads NULL before the competitor
 * commit lands.
 *
 * Requirement: the losing claim MUST fail closed (AUTH_BOOTSTRAP_ALREADY_DONE,
 * 409) and produce ZERO state change — exactly one owner survives.
 *
 * NOTE: this closes the concurrency/CAS leg of SEC-SETUP-BOOTSTRAP-001;
 * device-key / install-nonce binding is a separate, larger follow-up.
 */

import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { createFridayAuthService, hashPasswordScrypt } from "#api";
import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../helpers/friday-test-db.helper.js";

// The seeded local user from createTestDb(): is_local_only=1, password_hash NULL.
const SEEDED_USER_ID = "test-user";
const OWNER_PASSPHRASE = "owner-passphrase-xyz";
const COMPETITOR_HASH = hashPasswordScrypt("competitor-passphrase-abc");

function makeAuthService(db: FridaySqliteLayer) {
  return createFridayAuthService({
    db,
    idGenerator: createTestIdGenerator(),
    nowIso: () => "2026-07-12T00:00:00.000Z",
    tokenSecret: "test-secret-key-bootstrap-race",
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 604_800,
  });
}

/**
 * Wraps the real db so the FIRST `withWriteTransaction` (i.e. the bootstrap
 * UPDATE) is preceded — once — by a committed competitor claim, modelling a
 * process that claimed ownership inside the TOCTOU window. The competitor write
 * runs on the real writer connection outside any transaction, so it commits
 * before the delegated transaction begins.
 */
function createRacyDb(realDb: FridaySqliteLayer): FridaySqliteLayer {
  let fired = false;
  return {
    ...realDb,
    withWriteTransaction<T>(fn: (db: Database.Database) => T): T {
      if (!fired) {
        fired = true;
        realDb.writer
          .prepare(
            "UPDATE users SET password_hash = ? WHERE id = ? AND password_hash IS NULL",
          )
          .run(COMPETITOR_HASH, SEEDED_USER_ID);
      }
      return realDb.withWriteTransaction(fn);
    },
  };
}

function readbackHash(db: FridaySqliteLayer): string | null {
  return db.withReadConnection((conn) => {
    const row = conn
      .prepare("SELECT password_hash AS h FROM users WHERE id = ?")
      .get(SEEDED_USER_ID) as { h: string | null } | undefined;
    return row?.h ?? null;
  });
}

describe("SEC-SETUP-BOOTSTRAP-001: concurrent ownership claim is compare-and-set", () => {
  it("losing claim fails closed with AUTH_BOOTSTRAP_ALREADY_DONE (409)", () => {
    const db = createTestDb();
    try {
      const service = makeAuthService(createRacyDb(db));

      let caught: unknown;
      try {
        service.bootstrapLocalPassphrase({ passphrase: OWNER_PASSPHRASE }, "127.0.0.1");
      } catch (err) {
        caught = err;
      }

      // RED today: unconditional UPDATE returns { initialized: true } (no throw).
      expect(caught).toBeInstanceOf(FridayDomainError);
      expect((caught as FridayDomainError).code).toBe("AUTH_BOOTSTRAP_ALREADY_DONE");
      expect((caught as FridayDomainError).httpStatus).toBe(409);
    } finally {
      db.close();
    }
  });

  it("losing claim produces ZERO state change (competitor hash survives)", () => {
    const db = createTestDb();
    try {
      const service = makeAuthService(createRacyDb(db));

      // Tolerate the fail-closed throw (GREEN); RED today returns normally.
      try {
        service.bootstrapLocalPassphrase({ passphrase: OWNER_PASSPHRASE }, "127.0.0.1");
      } catch {
        /* expected once CAS is in place */
      }

      // RED today: owner hash clobbered the competitor's claim (last-writer-wins).
      expect(readbackHash(db)).toBe(COMPETITOR_HASH);
    } finally {
      db.close();
    }
  });

  it("happy first-claim path is unchanged (no competitor → initialized)", () => {
    const db = createTestDb();
    try {
      const service = makeAuthService(db); // real db, no racy competitor

      const result = service.bootstrapLocalPassphrase(
        { passphrase: OWNER_PASSPHRASE },
        "127.0.0.1",
      );

      expect(result.initialized).toBe(true);
      // The owner's own passphrase is what landed (not the competitor's).
      expect(readbackHash(db)).not.toBe(COMPETITOR_HASH);
      expect(readbackHash(db)).not.toBeNull();
    } finally {
      db.close();
    }
  });
});

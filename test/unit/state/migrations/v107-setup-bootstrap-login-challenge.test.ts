import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { V103_SETUP_BOOTSTRAP_DEVICE_CLAIM_MIGRATION } from "../../../../src/state/sqlite/migrations/v103-setup-bootstrap-device-claim.js";
import { V104_SETUP_BOOTSTRAP_MIGRATION_STATE_MIGRATION } from "../../../../src/state/sqlite/migrations/v104-setup-bootstrap-migration-state.js";
import { V107_SETUP_BOOTSTRAP_LOGIN_CHALLENGE_MIGRATION } from "../../../../src/state/sqlite/migrations/v107-setup-bootstrap-login-challenge.js";

/** Build the nonce-ledger table exactly as it exists at the v104 boundary. */
function makeV104Db(): Database.Database {
  const db = new Database(":memory:");
  db.exec(V103_SETUP_BOOTSTRAP_DEVICE_CLAIM_MIGRATION.sql);
  db.exec(V104_SETUP_BOOTSTRAP_MIGRATION_STATE_MIGRATION.sql);
  return db;
}

let seq = 0;
function insertNonce(
  db: Database.Database,
  over: Partial<{
    id: string;
    kind: string;
    origin: string;
    deviceId: string | null;
    devicePublicKeyHash: string | null;
    consumedAt: string | null;
    expiresAt: string;
  }> = {},
): string {
  const id = over.id ?? `nonce-${++seq}`;
  db.prepare(
    `INSERT INTO friday_setup_bootstrap_nonces (
       id, nonce_hash, kind, hub_id, install_id, os_user, origin, action,
       device_id, device_public_key, device_public_key_hash, claimed_user_id,
       created_at, expires_at, consumed_at
     ) VALUES (?, ?, ?, 'hub', 'install', 'os', ?, 'action', ?, NULL, ?, NULL, ?, ?, ?)`,
  ).run(
    id,
    `hash-${id}`,
    over.kind ?? "install_owner_claim",
    over.origin ?? "https://friday.localhost",
    over.deviceId ?? null,
    over.devicePublicKeyHash ?? null,
    "2026-05-31T00:00:00.000Z",
    over.expiresAt ?? "2999-01-01T00:00:00.000Z",
    over.consumedAt ?? null,
  );
  return id;
}

describe("v107 setup-bootstrap login-challenge migration", () => {
  it("preserves live install/migration nonce rows, accepts the new login kind, and re-scopes the single-owner index", () => {
    const db = makeV104Db();
    try {
      // Seed rows that exist BEFORE the migration: one CONSUMED owner-claim binding,
      // one CONSUMED migration binding, and one LIVE unconsumed challenge.
      insertNonce(db, { id: "claim-consumed", kind: "install_owner_claim", consumedAt: "2026-06-01T00:00:00.000Z" });
      insertNonce(db, { id: "migrate-consumed", kind: "device_migration_claim", consumedAt: "2026-06-02T00:00:00.000Z" });
      insertNonce(db, { id: "claim-live", kind: "install_owner_claim", consumedAt: null });

      // Sanity: the pre-v107 CHECK rejects the login kind.
      expect(() =>
        insertNonce(db, { id: "reject", kind: "device_login_challenge" }),
      ).toThrow(/CHECK|constraint/i);

      // Apply the migration.
      db.exec(V107_SETUP_BOOTSTRAP_LOGIN_CHALLENGE_MIGRATION.sql);

      // (1) All pre-existing rows are preserved verbatim.
      const rows = db
        .prepare("SELECT id, kind, consumed_at FROM friday_setup_bootstrap_nonces ORDER BY id")
        .all() as Array<{ id: string; kind: string; consumed_at: string | null }>;
      expect(rows).toEqual([
        { id: "claim-consumed", kind: "install_owner_claim", consumed_at: "2026-06-01T00:00:00.000Z" },
        { id: "claim-live", kind: "install_owner_claim", consumed_at: null },
        { id: "migrate-consumed", kind: "device_migration_claim", consumed_at: "2026-06-02T00:00:00.000Z" },
      ]);

      // (2) The new device_login_challenge kind is now accepted by the widened CHECK.
      insertNonce(db, {
        id: "login-1",
        kind: "device_login_challenge",
        deviceId: "dev-1",
        devicePublicKeyHash: "keyhash-1",
        consumedAt: "2026-06-03T00:00:00.000Z",
      });

      // (3) A SECOND CONSUMED device_login_challenge row does NOT hit the single-owner
      // UNIQUE index (it was re-scoped to EXCLUDE the login kind) — logins accumulate.
      expect(() =>
        insertNonce(db, {
          id: "login-2",
          kind: "device_login_challenge",
          deviceId: "dev-1",
          devicePublicKeyHash: "keyhash-1",
          consumedAt: "2026-06-04T00:00:00.000Z",
        }),
      ).not.toThrow();
      const consumedLogins = db
        .prepare(
          "SELECT COUNT(*) AS c FROM friday_setup_bootstrap_nonces WHERE kind = 'device_login_challenge' AND consumed_at IS NOT NULL",
        )
        .get() as { c: number };
      expect(consumedLogins.c).toBe(2);

      // (4) The single-owner belt STILL holds for the two single-shot kinds: a 2nd
      // consumed install_owner_claim is a UNIQUE violation (single owner preserved).
      expect(() =>
        insertNonce(db, { id: "claim-consumed-2", kind: "install_owner_claim", consumedAt: "2026-06-05T00:00:00.000Z" }),
      ).toThrow(/UNIQUE|constraint/i);
      // ...and likewise for a 2nd consumed device_migration_claim.
      expect(() =>
        insertNonce(db, { id: "migrate-consumed-2", kind: "device_migration_claim", consumedAt: "2026-06-06T00:00:00.000Z" }),
      ).toThrow(/UNIQUE|constraint/i);
    } finally {
      db.close();
    }
  });

  it("migration metadata is well-formed", () => {
    expect(V107_SETUP_BOOTSTRAP_LOGIN_CHALLENGE_MIGRATION.version).toBe(107);
    expect(V107_SETUP_BOOTSTRAP_LOGIN_CHALLENGE_MIGRATION.name).toBe(
      "v107-setup-bootstrap-login-challenge",
    );
    expect(V107_SETUP_BOOTSTRAP_LOGIN_CHALLENGE_MIGRATION.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(V107_SETUP_BOOTSTRAP_LOGIN_CHALLENGE_MIGRATION.sql).toMatch(/device_login_challenge/);
  });
});

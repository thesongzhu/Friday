import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V104_SETUP_BOOTSTRAP_MIGRATION_STATE_SQL = `
-- ============================================================
-- V104: Authenticated legacy-passphrase → device migration state
-- (SEC-SETUP-BOOTSTRAP-001 Slice 5). ADDITIVE, dual-read, reversible.
-- ============================================================
--
-- Stage 2 of the operator-locked FIXED order (1 native path → 2 authenticated
-- existing-user migration → 3 device readback → 4 restart proof → 5 tombstone →
-- 6 disable legacy login → 7 remove passphrase UI/API). This migration ADDS the
-- storage the authenticated migration primitive needs and REMOVES / DISABLES
-- NOTHING:
--
--   1. Widen the install-nonce ledger 'kind' CHECK to accept the NEW
--      'device_migration_claim' value (a SECOND consumer of the same ledger).
--   2. Add friday_device_owner_bindings — the durable dual-read binding record.
--      A migrated passphrase-owner keeps users.password_hash = scrypt$… (the
--      passphrase STILL works, no lockout) AND gains a provisional device
--      binding row here. Only a later stage flips state='active'.
--   3. Add friday_credential_tombstones — INACTIVE stage-5 scaffolding. No live
--      code path writes it in Slice 5; the passphrase remains the working owner
--      credential throughout.
--
-- No users column is altered; v103 is not renumbered; no destructive change. The
-- whole migration pass runs under one BEGIN IMMEDIATE transaction (the runner),
-- serialized against all other writers — so the nonce-ledger rebuild below is
-- atomic and races nothing.

-- ── (1) Widen the nonce 'kind' CHECK (additive value) ──────────────────────
-- SQLite bakes CHECK into the table definition, so widening it requires a
-- table rebuild. No table has a FOREIGN KEY into friday_setup_bootstrap_nonces,
-- so the drop/rename triggers no cascade. All rows + all three single-use
-- indexes are recreated verbatim; the ONLY change is the widened CHECK, which
-- accepts a SUPERSET of the previous values (strictly additive).

CREATE TABLE friday_setup_bootstrap_nonces__v104 (
  id TEXT PRIMARY KEY,
  nonce_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('install_owner_claim', 'device_migration_claim')),
  hub_id TEXT NOT NULL,
  install_id TEXT NOT NULL,
  os_user TEXT NOT NULL,
  origin TEXT NOT NULL,
  action TEXT NOT NULL,
  device_id TEXT,
  device_public_key TEXT,
  device_public_key_hash TEXT,
  claimed_user_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

INSERT INTO friday_setup_bootstrap_nonces__v104 (
  id, nonce_hash, kind, hub_id, install_id, os_user, origin, action,
  device_id, device_public_key, device_public_key_hash, claimed_user_id,
  created_at, expires_at, consumed_at
)
SELECT
  id, nonce_hash, kind, hub_id, install_id, os_user, origin, action,
  device_id, device_public_key, device_public_key_hash, claimed_user_id,
  created_at, expires_at, consumed_at
FROM friday_setup_bootstrap_nonces;

DROP TABLE friday_setup_bootstrap_nonces;

ALTER TABLE friday_setup_bootstrap_nonces__v104 RENAME TO friday_setup_bootstrap_nonces;

CREATE UNIQUE INDEX IF NOT EXISTS idx_friday_setup_bootstrap_nonces_hash
  ON friday_setup_bootstrap_nonces (nonce_hash);

-- Partial UNIQUE(kind) WHERE consumed_at IS NOT NULL: at most ONE consumed row
-- PER kind. Preserved verbatim — it now ALSO gives "at most one consumed
-- device_migration_claim" as a defence-in-depth single-migration belt.
CREATE UNIQUE INDEX IF NOT EXISTS idx_friday_setup_bootstrap_nonces_single_owner
  ON friday_setup_bootstrap_nonces (kind)
  WHERE consumed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_friday_setup_bootstrap_nonces_expires
  ON friday_setup_bootstrap_nonces (expires_at, consumed_at);

-- ── (2) Durable dual-read owner↔device binding record ──────────────────────
-- Separate from the transient nonce ledger. A provisional row is added at
-- authenticated-migrate time WITHOUT touching users.password_hash (dual-read:
-- the passphrase stays authoritative). A partial UNIQUE(user_id) WHERE
-- state='active' enforces at most ONE active device owner per user; the
-- flip to 'active' is a LATER stage (device readback) — inert in Slice 5.

CREATE TABLE IF NOT EXISTS friday_device_owner_bindings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_public_key TEXT NOT NULL,
  device_public_key_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('provisional', 'active', 'revoked')),
  migrated_from TEXT NOT NULL CHECK (migrated_from IN ('passphrase', 'first_boot')),
  origin TEXT NOT NULL,
  hub_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  revoked_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friday_device_owner_bindings_active
  ON friday_device_owner_bindings (user_id)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS idx_friday_device_owner_bindings_user_state
  ON friday_device_owner_bindings (user_id, state);

-- ── (3) Legacy credential tombstone — INACTIVE stage-5 scaffolding ─────────
-- Durable, fail-closed marker that a passphrase credential existed and was
-- retired. Stores NO secret and NO recoverable hash. NOT written by any live
-- Slice-5 code path — the passphrase remains the working owner credential.

CREATE TABLE IF NOT EXISTS friday_credential_tombstones (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  credential_kind TEXT NOT NULL CHECK (credential_kind IN ('passphrase')),
  retired_reason TEXT NOT NULL CHECK (
    retired_reason IN ('migrated_to_device', 'delete_all', 'release_profile_disable')
  ),
  superseded_by_binding_id TEXT,
  origin TEXT NOT NULL,
  hub_id TEXT NOT NULL,
  retired_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_friday_credential_tombstones_user
  ON friday_credential_tombstones (user_id, credential_kind);
`;

const V104_CHECKSUM = computeFridayMigrationChecksum(V104_SETUP_BOOTSTRAP_MIGRATION_STATE_SQL);

export const V104_SETUP_BOOTSTRAP_MIGRATION_STATE_MIGRATION: FridaySqliteMigration = {
  version: 104,
  name: "v104-setup-bootstrap-migration-state",
  sql: V104_SETUP_BOOTSTRAP_MIGRATION_STATE_SQL,
  checksum: V104_CHECKSUM,
};

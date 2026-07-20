import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V107_SETUP_BOOTSTRAP_LOGIN_CHALLENGE_SQL = `
-- ============================================================
-- V107: server-issued single-use device-key LOGIN challenge
-- (SEC-SETUP-BOOTSTRAP-001 CR-1 · Advisor #1628 finding #2). ADDITIVE.
-- ============================================================
--
-- Advisor #1628 finding #2: the device-key LOGIN proof was replayable — there was
-- no server-issued single-use nonce gating the login mint, so a captured signed
-- owner-login transcript could be resubmitted to mint further token pairs. The fix
-- adds a THIRD consumer of the install-nonce ledger: a 'device_login_challenge'
-- nonce minted per login attempt, bound to the device + origin + action, that
-- deviceKeyLogin CAS-consumes atomically in the SAME transaction that mints the
-- session — a replayed 2nd login finds it already consumed (changes=0) and mints
-- NOTHING. This migration does TWO things and removes/disables NOTHING:
--
--   1. Widen the nonce 'kind' CHECK to accept 'device_login_challenge' (a third,
--      strictly-additive value — a SUPERSET of the previous closed set).
--   2. RE-SCOPE the single-owner partial UNIQUE(kind) WHERE consumed_at IS NOT NULL
--      index to EXCLUDE the login kind. That belt guarantees "at most ONE consumed
--      row PER kind", which is correct for install_owner_claim (single owner) and
--      device_migration_claim (single migration) but WRONG for the login challenge:
--      a machine logs in MANY times, so MANY consumed 'device_login_challenge' rows
--      must coexist. Left unchanged, the 2nd consumed login row would hit the UNIQUE
--      index and wrongly fail the login. The re-scoped predicate keeps the belt for
--      the two single-shot kinds while letting login challenges accumulate (they are
--      reaped by the existing bounded retention sweep).
--
-- SQLite bakes CHECK into the table definition, so widening it requires a table
-- rebuild (mirrors v104). No table has a FOREIGN KEY into friday_setup_bootstrap_
-- nonces, so the drop/rename triggers no cascade. All rows + all columns are copied
-- verbatim; the whole migration pass runs under one BEGIN IMMEDIATE transaction (the
-- runner), serialized against all other writers, so the rebuild is atomic.

CREATE TABLE friday_setup_bootstrap_nonces__v107 (
  id TEXT PRIMARY KEY,
  nonce_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('install_owner_claim', 'device_migration_claim', 'device_login_challenge')
  ),
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

INSERT INTO friday_setup_bootstrap_nonces__v107 (
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

ALTER TABLE friday_setup_bootstrap_nonces__v107 RENAME TO friday_setup_bootstrap_nonces;

CREATE UNIQUE INDEX IF NOT EXISTS idx_friday_setup_bootstrap_nonces_hash
  ON friday_setup_bootstrap_nonces (nonce_hash);

-- RE-SCOPED single-owner belt: at most ONE consumed row for each SINGLE-SHOT kind
-- (install_owner_claim / device_migration_claim). The login-challenge kind is
-- EXCLUDED so many consumed login rows can coexist (one per login) without hitting
-- the UNIQUE index — the single-use guarantee for logins is the per-row CAS
-- (consumed_at IS NULL), not this index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_friday_setup_bootstrap_nonces_single_owner
  ON friday_setup_bootstrap_nonces (kind)
  WHERE consumed_at IS NOT NULL
    AND kind IN ('install_owner_claim', 'device_migration_claim');

CREATE INDEX IF NOT EXISTS idx_friday_setup_bootstrap_nonces_expires
  ON friday_setup_bootstrap_nonces (expires_at, consumed_at);
`;

const V107_CHECKSUM = computeFridayMigrationChecksum(V107_SETUP_BOOTSTRAP_LOGIN_CHALLENGE_SQL);

export const V107_SETUP_BOOTSTRAP_LOGIN_CHALLENGE_MIGRATION: FridaySqliteMigration = {
  version: 107,
  name: "v107-setup-bootstrap-login-challenge",
  sql: V107_SETUP_BOOTSTRAP_LOGIN_CHALLENGE_SQL,
  checksum: V107_CHECKSUM,
};

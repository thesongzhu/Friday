import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V103_SETUP_BOOTSTRAP_DEVICE_CLAIM_SQL = `
-- ============================================================
-- V103: Setup bootstrap challenge / install-nonce for the
-- device-bound consumer first-run owner-claim (SEC-SETUP-BOOTSTRAP-001).
-- ============================================================
--
-- The developer-passphrase bootstrap (bootstrapLocalPassphrase) is being
-- REPLACED by a signed-native + device-bound owner claim. This migration is
-- ADDITIVE and does NOT touch the passphrase path: it only adds the single-use
-- install-nonce ledger the new claim consumes. The passphrase columns and its
-- CAS on users.password_hash are untouched; removal is a much later slice.
--
-- Shape mirrors friday_system_remote_auth_challenges (V045): we persist only a
-- HASH of the nonce (never the raw nonce), a kind, created/expires timestamps,
-- and a NULL-until-used consumed_at. Extra columns bind the nonce to its issue
-- context (hub / install / os-user / origin / action) so a cross-origin or
-- rebinding claim fails closed, plus device columns recorded at consume time
-- (the winning device public key + its hash + the claimed owner user id) — the
-- surviving consumed row IS the durable owner<->device binding record.
--
-- Single-use is enforced at three layers:
--   1. UNIQUE(nonce_hash)                        — a raw nonce maps to one row.
--   2. CAS consume (UPDATE ... WHERE consumed_at IS NULL AND expires_at > now)
--      — a consumed/expired nonce yields changes=0 (replay/expiry rejected).
--   3. PARTIAL UNIQUE(kind) WHERE consumed_at IS NOT NULL
--      — at most ONE consumed owner-claim can ever exist; a second consumed
--        owner-claim row is a UNIQUE violation even if application CAS regressed
--        (defence-in-depth belt for the single-owner invariant).

CREATE TABLE IF NOT EXISTS friday_setup_bootstrap_nonces (
  id TEXT PRIMARY KEY,
  nonce_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('install_owner_claim')),
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_friday_setup_bootstrap_nonces_hash
  ON friday_setup_bootstrap_nonces (nonce_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friday_setup_bootstrap_nonces_single_owner
  ON friday_setup_bootstrap_nonces (kind)
  WHERE consumed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_friday_setup_bootstrap_nonces_expires
  ON friday_setup_bootstrap_nonces (expires_at, consumed_at);
`;

const V103_CHECKSUM = computeFridayMigrationChecksum(V103_SETUP_BOOTSTRAP_DEVICE_CLAIM_SQL);

export const V103_SETUP_BOOTSTRAP_DEVICE_CLAIM_MIGRATION: FridaySqliteMigration = {
  version: 103,
  name: "v103-setup-bootstrap-device-claim",
  sql: V103_SETUP_BOOTSTRAP_DEVICE_CLAIM_SQL,
  checksum: V103_CHECKSUM,
};

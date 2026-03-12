import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V045_SYSTEM_REMOTE_PASSKEYS_SQL = `
CREATE TABLE IF NOT EXISTS friday_system_remote_passkeys (
  device_id TEXT PRIMARY KEY REFERENCES friday_system_remote_devices(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key_b64u TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT,
  device_type TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friday_system_remote_passkeys_credential
  ON friday_system_remote_passkeys (credential_id);

CREATE TABLE IF NOT EXISTS friday_system_remote_auth_challenges (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES friday_system_remote_devices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('register', 'assert')),
  challenge TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_friday_system_remote_auth_challenges_device
  ON friday_system_remote_auth_challenges (device_id, kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_friday_system_remote_auth_challenges_expires
  ON friday_system_remote_auth_challenges (expires_at, used_at);

CREATE TABLE IF NOT EXISTS friday_system_remote_assertion_grants (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES friday_system_remote_devices(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  ip_address TEXT,
  user_agent TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friday_system_remote_assertion_grants_token
  ON friday_system_remote_assertion_grants (token_hash);

CREATE INDEX IF NOT EXISTS idx_friday_system_remote_assertion_grants_device
  ON friday_system_remote_assertion_grants (device_id, expires_at DESC);
`;

const V045_CHECKSUM = computeFridayMigrationChecksum(V045_SYSTEM_REMOTE_PASSKEYS_SQL);

export const V045_SYSTEM_REMOTE_PASSKEYS_MIGRATION: FridaySqliteMigration = {
  version: 45,
  name: "v045-system-remote-passkeys",
  sql: V045_SYSTEM_REMOTE_PASSKEYS_SQL,
  checksum: V045_CHECKSUM,
};

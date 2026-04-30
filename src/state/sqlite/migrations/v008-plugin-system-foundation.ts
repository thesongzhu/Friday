import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V008_PLUGIN_SYSTEM_FOUNDATION_SQL = `
-- V008: Plugin system foundation

CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  version TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('bundled','local')),
  status TEXT NOT NULL CHECK (status IN (
    'not_installed','installed','configured','enabled','running','disabled','error','uninstalled'
  )),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  trust_mode TEXT NOT NULL CHECK (trust_mode IN ('signed','trust_on_install')),
  install_path TEXT NOT NULL,
  kinds_json TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  signature_algorithm TEXT,
  signature_key_id TEXT,
  signature_value TEXT,
  signature_verified INTEGER NOT NULL DEFAULT 0 CHECK (signature_verified IN (0,1)),
  trusted_fingerprint_sha256 TEXT,
  last_verified_at TEXT,
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error_code TEXT,
  last_error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_plugins_status_enabled
  ON plugins(status, enabled);

CREATE INDEX IF NOT EXISTS idx_plugins_source_updated
  ON plugins(source, updated_at DESC);

CREATE TABLE IF NOT EXISTS plugin_dependencies (
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  dependency_plugin_id TEXT NOT NULL,
  semver_range TEXT NOT NULL,
  optional INTEGER NOT NULL DEFAULT 0 CHECK (optional IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, dependency_plugin_id)
);

CREATE INDEX IF NOT EXISTS idx_plugin_deps_dependency
  ON plugin_dependencies(dependency_plugin_id);

CREATE TABLE IF NOT EXISTS plugin_versions (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  package_url TEXT,
  manifest_json TEXT NOT NULL,
  signature_algorithm TEXT,
  signature_key_id TEXT,
  signature_value TEXT,
  released_at TEXT NOT NULL,
  yanked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(plugin_id, version)
);

CREATE INDEX IF NOT EXISTS idx_plugin_versions_plugin_released
  ON plugin_versions(plugin_id, released_at DESC);

`;

const V008_CHECKSUM = computeFridayMigrationChecksum(V008_PLUGIN_SYSTEM_FOUNDATION_SQL);

export const V008_PLUGIN_SYSTEM_FOUNDATION_MIGRATION: FridaySqliteMigration = {
  version: 8,
  name: "v008-plugin-system-foundation",
  sql: V008_PLUGIN_SYSTEM_FOUNDATION_SQL,
  checksum: V008_CHECKSUM,
  acceptedChecksums: ["235ef3974a95b6e176cacc988c8da19177405f621d838554074d8421bf3228c9"], // pragma: allowlist secret
};

import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V079_PACKAGING_PERSISTENCE_SQL = `
-- V079: Packaging system persistence (Phase 11 Module 16)
--
-- Backs the FridayPackagingRoutesDeps surface with durable storage.  Each
-- table maps to the row interfaces declared in
-- src/packaging/model/friday-packaging.types.ts.

CREATE TABLE IF NOT EXISTS package_registry (
  id                TEXT    PRIMARY KEY NOT NULL,
  name              TEXT    NOT NULL,
  version           TEXT    NOT NULL,
  description       TEXT,
  author_json       TEXT    NOT NULL,
  license           TEXT,
  capabilities_json TEXT    NOT NULL,
  dependencies_json TEXT    NOT NULL DEFAULT '{}',
  peer_deps_json    TEXT    NOT NULL DEFAULT '{}',
  friday_version    TEXT    NOT NULL,
  assets_json       TEXT    NOT NULL DEFAULT '{}',
  hooks_json        TEXT    NOT NULL DEFAULT '{}',
  metadata_json     TEXT    NOT NULL DEFAULT '{}',
  size_bytes        INTEGER NOT NULL,
  archive_digest    TEXT    NOT NULL,
  manifest_digest   TEXT    NOT NULL,
  signature_json    TEXT    NOT NULL,
  published_by      TEXT    NOT NULL,
  tenant_id         TEXT,
  etag              TEXT    NOT NULL,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  deleted_at        TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_package_registry_name_version_tenant
  ON package_registry (name, version, IFNULL(tenant_id,'__global__')) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_package_registry_name_tenant
  ON package_registry (name, IFNULL(tenant_id,'__global__')) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_package_registry_created_at
  ON package_registry (created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS package_installs (
  id                TEXT    PRIMARY KEY NOT NULL,
  package_id        TEXT    NOT NULL REFERENCES package_registry(id),
  package_name      TEXT    NOT NULL,
  package_version   TEXT    NOT NULL,
  tenant_id         TEXT    NOT NULL,
  state             TEXT    NOT NULL,
  install_dir       TEXT,
  error_message     TEXT,
  error_code        TEXT,
  previous_version  TEXT,
  etag              TEXT    NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  installed_by      TEXT    NOT NULL,
  idempotency_key   TEXT,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_package_installs_tenant_name
  ON package_installs (tenant_id, package_name);
CREATE INDEX IF NOT EXISTS idx_package_installs_state
  ON package_installs (state);
CREATE INDEX IF NOT EXISTS idx_package_installs_package_id
  ON package_installs (package_id);

CREATE TABLE IF NOT EXISTS package_rollbacks (
  id            TEXT    PRIMARY KEY NOT NULL,
  install_id    TEXT    NOT NULL REFERENCES package_installs(id),
  package_name  TEXT    NOT NULL,
  from_version  TEXT    NOT NULL,
  to_version    TEXT    NOT NULL,
  reason        TEXT    NOT NULL,
  initiated_by  TEXT    NOT NULL,
  state         TEXT    NOT NULL,
  error_message TEXT,
  started_at    TEXT    NOT NULL,
  completed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_package_rollbacks_install_id
  ON package_rollbacks (install_id);

CREATE TABLE IF NOT EXISTS package_trusted_keys (
  id                TEXT    PRIMARY KEY NOT NULL,
  key_id            TEXT    NOT NULL UNIQUE,
  public_key        TEXT    NOT NULL,
  algorithm         TEXT    NOT NULL DEFAULT 'Ed25519',
  owner             TEXT    NOT NULL,
  tenant_id         TEXT,
  trusted_at        TEXT    NOT NULL,
  expires_at        TEXT,
  revoked_at        TEXT,
  revocation_reason TEXT,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_package_trusted_keys_tenant
  ON package_trusted_keys (IFNULL(tenant_id,'__global__'));
CREATE INDEX IF NOT EXISTS idx_package_trusted_keys_revoked
  ON package_trusted_keys (revoked_at) WHERE revoked_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS package_lifecycle_log (
  id              TEXT    PRIMARY KEY NOT NULL,
  package_name    TEXT    NOT NULL,
  package_version TEXT,
  operation       TEXT    NOT NULL,
  state_from      TEXT,
  state_to        TEXT    NOT NULL,
  principal_id    TEXT,
  tenant_id       TEXT,
  details_json    TEXT    NOT NULL DEFAULT '{}',
  created_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_package_lifecycle_log_name
  ON package_lifecycle_log (package_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_package_lifecycle_log_tenant
  ON package_lifecycle_log (tenant_id, created_at DESC) WHERE tenant_id IS NOT NULL;
`;

const V079_CHECKSUM = computeFridayMigrationChecksum(V079_PACKAGING_PERSISTENCE_SQL);

export const V079_PACKAGING_PERSISTENCE_MIGRATION: FridaySqliteMigration = {
  version: 79,
  name: "v079-packaging-persistence",
  sql: V079_PACKAGING_PERSISTENCE_SQL,
  checksum: V079_CHECKSUM,
};

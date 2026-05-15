import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V080_MULTI_TENANT_SECURITY_PERSISTENCE_SQL = `
-- V080: Multi-tenant security persistence (Phase 11 Module 18)
--
-- Phase 2 of the multi-tenant RFC.  Backs the in-memory TenantManager,
-- SecretManager, AuditLogger engines so tenant CRUD and tenant-scoped
-- secrets survive hub restarts and cannot leak across tenants.
--
-- Scope: tenant / workspace / membership / role / role-assignment /
-- secret / secret-rotation / secret-access-log / audit / violation
-- tables PLUS tenant-scoped resource records for sessions, skills,
-- workflows, providers, memory items, and rules.  The records table
-- (security_tenant_scoped_resources) captures the tenant-ownership
-- claim for each legacy domain resource the multi-tenant engine knows
-- about, enabling cross-tenant denial checks and restart-survival of
-- tenant scope, without refactoring the legacy per-domain stores.

CREATE TABLE IF NOT EXISTS security_tenants (
  id                          TEXT    PRIMARY KEY NOT NULL,
  name                        TEXT    NOT NULL,
  slug                        TEXT    NOT NULL UNIQUE,
  status                      TEXT    NOT NULL,
  config_json                 TEXT    NOT NULL DEFAULT '{}',
  etag                        TEXT    NOT NULL,
  created_at                  TEXT    NOT NULL,
  updated_at                  TEXT    NOT NULL,
  deleted_at                  TEXT
);

CREATE INDEX IF NOT EXISTS idx_security_tenants_status
  ON security_tenants (status) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS security_workspaces (
  id           TEXT    PRIMARY KEY NOT NULL,
  tenant_id    TEXT    NOT NULL REFERENCES security_tenants(id),
  name         TEXT    NOT NULL,
  slug         TEXT    NOT NULL,
  status       TEXT    NOT NULL,
  config_json  TEXT    NOT NULL DEFAULT '{}',
  etag         TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  deleted_at   TEXT,
  UNIQUE (tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_security_workspaces_tenant
  ON security_workspaces (tenant_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS security_workspace_memberships (
  id            TEXT    PRIMARY KEY NOT NULL,
  tenant_id     TEXT    NOT NULL,
  workspace_id  TEXT    NOT NULL,
  principal_id  TEXT    NOT NULL,
  role_id       TEXT    NOT NULL,
  granted_by    TEXT    NOT NULL,
  granted_at    TEXT    NOT NULL,
  expires_at    TEXT,
  revoked_at    TEXT,
  FOREIGN KEY (workspace_id) REFERENCES security_workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id) REFERENCES security_tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_security_memberships_tenant_workspace
  ON security_workspace_memberships (tenant_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_security_memberships_principal
  ON security_workspace_memberships (principal_id);

CREATE TABLE IF NOT EXISTS security_roles (
  id            TEXT    PRIMARY KEY NOT NULL,
  tenant_id     TEXT,
  name          TEXT    NOT NULL,
  scope_type    TEXT    NOT NULL,
  is_system     INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  permissions_json TEXT NOT NULL DEFAULT '[]',
  etag          TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  deleted_at    TEXT,
  FOREIGN KEY (tenant_id) REFERENCES security_tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_security_roles_tenant
  ON security_roles (IFNULL(tenant_id,'__system__')) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS security_role_assignments (
  id            TEXT    PRIMARY KEY NOT NULL,
  tenant_id     TEXT,
  principal_id  TEXT    NOT NULL,
  role_id       TEXT    NOT NULL REFERENCES security_roles(id) ON DELETE CASCADE,
  scope_type    TEXT    NOT NULL,
  scope_id      TEXT,
  granted_by    TEXT    NOT NULL,
  granted_at    TEXT    NOT NULL,
  expires_at    TEXT,
  revoked_at    TEXT,
  FOREIGN KEY (tenant_id) REFERENCES security_tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_security_role_assignments_tenant
  ON security_role_assignments (IFNULL(tenant_id,'__system__'));
CREATE INDEX IF NOT EXISTS idx_security_role_assignments_principal
  ON security_role_assignments (principal_id);

CREATE TABLE IF NOT EXISTS security_secrets (
  id                TEXT    PRIMARY KEY NOT NULL,
  tenant_id         TEXT    NOT NULL REFERENCES security_tenants(id) ON DELETE CASCADE,
  workspace_id      TEXT,
  resource_id       TEXT,
  scope_type        TEXT    NOT NULL,
  name              TEXT    NOT NULL,
  description       TEXT,
  encrypted_value   TEXT    NOT NULL,
  encryption_key_id TEXT    NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  rotation_state    TEXT    NOT NULL,
  expires_at        TEXT,
  rotated_at        TEXT,
  etag              TEXT    NOT NULL,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  deleted_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_security_secrets_tenant
  ON security_secrets (tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_security_secrets_workspace
  ON security_secrets (tenant_id, workspace_id) WHERE deleted_at IS NULL AND workspace_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_security_secrets_name_scope
  ON security_secrets (tenant_id, IFNULL(workspace_id,'__tenant__'), IFNULL(resource_id,'__scope__'), name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS security_secret_rotations (
  id              TEXT    PRIMARY KEY NOT NULL,
  secret_id       TEXT    NOT NULL REFERENCES security_secrets(id) ON DELETE CASCADE,
  tenant_id       TEXT    NOT NULL,
  initiated_by    TEXT    NOT NULL,
  state           TEXT    NOT NULL,
  grace_period_seconds INTEGER,
  started_at      TEXT    NOT NULL,
  completed_at    TEXT,
  retired_at      TEXT,
  details_json    TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_security_secret_rotations_secret
  ON security_secret_rotations (secret_id, started_at DESC);

CREATE TABLE IF NOT EXISTS security_secret_access_log (
  id                    TEXT    PRIMARY KEY NOT NULL,
  secret_id             TEXT    NOT NULL REFERENCES security_secrets(id) ON DELETE CASCADE,
  tenant_id             TEXT    NOT NULL,
  principal_id          TEXT    NOT NULL,
  action                TEXT    NOT NULL,
  granted               INTEGER NOT NULL CHECK (granted IN (0,1)),
  policy_evaluation_id  TEXT,
  ip_address            TEXT,
  user_agent            TEXT,
  accessed_at           TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_security_secret_access_log_secret
  ON security_secret_access_log (secret_id, accessed_at DESC);

CREATE TABLE IF NOT EXISTS security_audit_log (
  id            TEXT    PRIMARY KEY NOT NULL,
  tenant_id     TEXT,
  principal_id  TEXT,
  action        TEXT    NOT NULL,
  resource_type TEXT    NOT NULL,
  resource_id   TEXT,
  decision      TEXT    NOT NULL,
  reason        TEXT,
  ip_address    TEXT,
  user_agent    TEXT,
  session_id    TEXT,
  metadata_json TEXT    NOT NULL DEFAULT '{}',
  created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_security_audit_log_tenant
  ON security_audit_log (IFNULL(tenant_id,'__system__'), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_audit_log_principal
  ON security_audit_log (principal_id, created_at DESC);

CREATE TABLE IF NOT EXISTS security_violations (
  id                 TEXT    PRIMARY KEY NOT NULL,
  tenant_id          TEXT,
  principal_id       TEXT    NOT NULL,
  violation_type     TEXT    NOT NULL,
  severity           TEXT    NOT NULL,
  description        TEXT    NOT NULL,
  resource_type      TEXT,
  resource_id        TEXT,
  action_attempted   TEXT,
  ip_address         TEXT,
  resolved           INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0,1)),
  resolved_by        TEXT,
  resolved_at        TEXT,
  metadata_json      TEXT    NOT NULL DEFAULT '{}',
  created_at         TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_security_violations_tenant
  ON security_violations (IFNULL(tenant_id,'__system__'), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_violations_resolved
  ON security_violations (resolved, created_at DESC);

-- Tenant-scoped resource records for legacy domains (Phase 11 Module 18).
--
-- Each row records that a specific legacy resource (session, skill,
-- workflow, provider, memory item, or rule) belongs to a given tenant
-- (and optionally workspace).  The multi-tenant engine consults this
-- table to enforce cross-tenant denial when an actor scoped to tenant B
-- attempts to access tenant A's resources, and to restore tenant scope
-- after a hub restart without touching the per-domain stores.
--
-- The table is intentionally narrow: it does not duplicate per-domain
-- payloads.  It only records (tenant_id, resource_kind, resource_id)
-- plus minimal scoping metadata so that the engine can answer "does
-- tenant T own resource R of kind K?" deterministically.

CREATE TABLE IF NOT EXISTS security_tenant_scoped_resources (
  id             TEXT NOT NULL PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES security_tenants(id) ON DELETE CASCADE,
  workspace_id   TEXT REFERENCES security_workspaces(id) ON DELETE CASCADE,
  resource_kind  TEXT NOT NULL CHECK (resource_kind IN (
    'session','skill','workflow','provider','memory','rule'
  )),
  resource_id    TEXT NOT NULL,
  resource_label TEXT,
  etag           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_security_tenant_scoped_resources_kind_id
  ON security_tenant_scoped_resources (resource_kind, resource_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_security_tenant_scoped_resources_tenant_kind
  ON security_tenant_scoped_resources (tenant_id, resource_kind) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_security_tenant_scoped_resources_workspace
  ON security_tenant_scoped_resources (tenant_id, workspace_id, resource_kind) WHERE deleted_at IS NULL AND workspace_id IS NOT NULL;
`;

const V080_CHECKSUM = computeFridayMigrationChecksum(V080_MULTI_TENANT_SECURITY_PERSISTENCE_SQL);

export const V080_MULTI_TENANT_SECURITY_PERSISTENCE_MIGRATION: FridaySqliteMigration = {
  version: 80,
  name: "v080-multi-tenant-security-persistence",
  sql: V080_MULTI_TENANT_SECURITY_PERSISTENCE_SQL,
  checksum: V080_CHECKSUM,
};

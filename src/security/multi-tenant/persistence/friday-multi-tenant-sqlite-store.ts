/**
 * SQLite-backed persistence for the multi-tenant security engines
 * (Phase 11 Module 18).  Schema is defined in migration v080.
 *
 * The engines (TenantManager, SecretManager, AuditLogger, RbacEngine,
 * PolicyEngine) remain in-memory caches.  This module wires:
 *
 *   - hydrate(target): populate a Map<UUID, T> from SQLite at boot.
 *   - onChange(entity): write-through to SQLite on every mutation.
 *
 * The backends do not enforce business rules — the engines own validation.
 *
 * @module security/multi-tenant/persistence
 */

import type Database from "better-sqlite3";
import type {
  FridayRole,
  FridayRoleAssignment,
  FridaySecretAccessLog,
  FridaySecretEntry,
  FridaySecretRotation,
  FridaySecretScope,
  FridaySecurityAuditEntry,
  FridaySecurityPolicy,
  FridaySecurityViolation,
  FridayTenant,
  FridayWorkspace,
  FridayWorkspaceMembership,
  JsonObject,
  UUID,
} from "../model/friday-multi-tenant-security.types.js";
import type {
  FridayTenantScopedResourceKind,
  FridayTenantScopedResourceRecord,
} from "../engine/tenant-scoped-resource-registry.js";

function safeJsonParse<T>(input: string | null | undefined, fallback: T): T {
  if (!input) return fallback;
  try { return JSON.parse(input) as T; } catch { return fallback; }
}

interface FridaySecuritySqliteLayer {
  withReadConnection<T>(fn: (db: Database.Database) => T): T;
  withWriteTransaction<T>(fn: (db: Database.Database) => T): T;
}

// ─── Tenant persistence ───

export interface TenantPersistenceBackend {
  hydrateTenants(): Map<UUID, FridayTenant>;
  hydrateWorkspaces(): Map<UUID, FridayWorkspace>;
  hydrateMemberships(): Map<UUID, FridayWorkspaceMembership>;
  saveTenant(tenant: FridayTenant): void;
  saveWorkspace(workspace: FridayWorkspace): void;
  saveMembership(membership: FridayWorkspaceMembership): void;
  deleteWorkspacesForTenant(tenantId: UUID): void;
}

interface SecurityTenantRow {
  id: string; name: string; slug: string; status: string; config_json: string;
  etag: string; created_at: string; updated_at: string; deleted_at: string | null;
}
interface SecurityWorkspaceRow {
  id: string; tenant_id: string; name: string; slug: string; status: string;
  config_json: string; etag: string; created_at: string; updated_at: string;
  deleted_at: string | null;
}
interface SecurityMembershipRow {
  id: string; tenant_id: string; workspace_id: string; principal_id: string;
  role_id: string; granted_by: string; granted_at: string;
  expires_at: string | null; revoked_at: string | null;
}

function tenantRowToEntity(row: SecurityTenantRow): FridayTenant {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status as FridayTenant["status"],
    config: safeJsonParse(row.config_json, {
      maxWorkspaces: 50,
      maxMembers: 500,
      maxSecretsPerWorkspace: 200,
      auditRetentionDays: 90,
      featureFlags: {},
    } as FridayTenant["config"]),
    etag: row.etag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
  };
}

function tenantEntityToRow(entity: FridayTenant): SecurityTenantRow {
  return {
    id: entity.id,
    name: entity.name,
    slug: entity.slug,
    status: entity.status,
    config_json: JSON.stringify(entity.config),
    etag: entity.etag,
    created_at: entity.createdAt,
    updated_at: entity.updatedAt,
    deleted_at: entity.deletedAt ?? null,
  };
}

function workspaceRowToEntity(row: SecurityWorkspaceRow): FridayWorkspace {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    slug: row.slug,
    status: row.status as FridayWorkspace["status"],
    config: safeJsonParse(row.config_json, {} as JsonObject),
    etag: row.etag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
  };
}

function workspaceEntityToRow(entity: FridayWorkspace): SecurityWorkspaceRow {
  return {
    id: entity.id,
    tenant_id: entity.tenantId,
    name: entity.name,
    slug: entity.slug,
    status: entity.status,
    config_json: JSON.stringify(entity.config ?? {}),
    etag: entity.etag,
    created_at: entity.createdAt,
    updated_at: entity.updatedAt,
    deleted_at: entity.deletedAt ?? null,
  };
}

function membershipRowToEntity(row: SecurityMembershipRow): FridayWorkspaceMembership {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    roleId: row.role_id,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}

function membershipEntityToRow(entity: FridayWorkspaceMembership): SecurityMembershipRow {
  return {
    id: entity.id,
    tenant_id: entity.tenantId,
    workspace_id: entity.workspaceId,
    principal_id: entity.principalId,
    role_id: entity.roleId,
    granted_by: entity.grantedBy,
    granted_at: entity.grantedAt,
    expires_at: entity.expiresAt ?? null,
    revoked_at: entity.revokedAt ?? null,
  };
}

export function createSqliteTenantPersistence(sqlite: FridaySecuritySqliteLayer): TenantPersistenceBackend {
  return {
    hydrateTenants() {
      const rows = sqlite.withReadConnection((db) => db.prepare("SELECT * FROM security_tenants").all() as SecurityTenantRow[]);
      const map = new Map<UUID, FridayTenant>();
      for (const row of rows) map.set(row.id, tenantRowToEntity(row));
      return map;
    },
    hydrateWorkspaces() {
      const rows = sqlite.withReadConnection((db) => db.prepare("SELECT * FROM security_workspaces").all() as SecurityWorkspaceRow[]);
      const map = new Map<UUID, FridayWorkspace>();
      for (const row of rows) map.set(row.id, workspaceRowToEntity(row));
      return map;
    },
    hydrateMemberships() {
      const rows = sqlite.withReadConnection((db) => db.prepare("SELECT * FROM security_workspace_memberships").all() as SecurityMembershipRow[]);
      const map = new Map<UUID, FridayWorkspaceMembership>();
      for (const row of rows) map.set(row.id, membershipRowToEntity(row));
      return map;
    },
    saveTenant(tenant) {
      const row = tenantEntityToRow(tenant);
      sqlite.withWriteTransaction((db) => {
        db.prepare(
          `INSERT INTO security_tenants (id, name, slug, status, config_json, etag, created_at, updated_at, deleted_at)
           VALUES (@id, @name, @slug, @status, @config_json, @etag, @created_at, @updated_at, @deleted_at)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name, slug = excluded.slug, status = excluded.status,
             config_json = excluded.config_json, etag = excluded.etag,
             updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`,
        ).run(row);
      });
    },
    saveWorkspace(workspace) {
      const row = workspaceEntityToRow(workspace);
      sqlite.withWriteTransaction((db) => {
        db.prepare(
          `INSERT INTO security_workspaces (id, tenant_id, name, slug, status, config_json, etag, created_at, updated_at, deleted_at)
           VALUES (@id, @tenant_id, @name, @slug, @status, @config_json, @etag, @created_at, @updated_at, @deleted_at)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name, slug = excluded.slug, status = excluded.status,
             config_json = excluded.config_json, etag = excluded.etag,
             updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`,
        ).run(row);
      });
    },
    saveMembership(membership) {
      const row = membershipEntityToRow(membership);
      sqlite.withWriteTransaction((db) => {
        db.prepare(
          `INSERT INTO security_workspace_memberships (
             id, tenant_id, workspace_id, principal_id, role_id, granted_by,
             granted_at, expires_at, revoked_at
           ) VALUES (
             @id, @tenant_id, @workspace_id, @principal_id, @role_id, @granted_by,
             @granted_at, @expires_at, @revoked_at
           ) ON CONFLICT(id) DO UPDATE SET
             role_id = excluded.role_id, revoked_at = excluded.revoked_at,
             expires_at = excluded.expires_at`,
        ).run(row);
      });
    },
    deleteWorkspacesForTenant(tenantId: UUID) {
      sqlite.withWriteTransaction((db) => {
        db.prepare("UPDATE security_workspaces SET deleted_at = COALESCE(deleted_at, ?) WHERE tenant_id = ?").run(new Date().toISOString(), tenantId);
        db.prepare("UPDATE security_workspace_memberships SET revoked_at = COALESCE(revoked_at, ?) WHERE tenant_id = ?").run(new Date().toISOString(), tenantId);
      });
    },
  };
}

// ─── Secret persistence ───

export interface SecretPersistenceBackend {
  hydrateSecrets(): Map<UUID, FridaySecretEntry>;
  hydrateRotations(): Map<UUID, FridaySecretRotation>;
  hydrateAccessLogs(): FridaySecretAccessLog[];
  saveSecret(secret: FridaySecretEntry): void;
  saveRotation(rotation: FridaySecretRotation): void;
  appendAccessLog(log: FridaySecretAccessLog): void;
}

interface SecuritySecretRow {
  id: string; tenant_id: string; workspace_id: string | null; resource_id: string | null;
  scope_type: string; name: string; description: string | null;
  encrypted_value: string; encryption_key_id: string; version: number;
  rotation_state: string; expires_at: string | null; rotated_at: string | null;
  etag: string; created_at: string; updated_at: string; deleted_at: string | null;
}
interface SecuritySecretRotationRow {
  id: string; secret_id: string; tenant_id: string; initiated_by: string;
  state: string; grace_period_seconds: number | null;
  started_at: string; completed_at: string | null; retired_at: string | null;
  details_json: string;
}
interface SecuritySecretAccessLogRow {
  id: string; secret_id: string; tenant_id: string; principal_id: string;
  action: string; granted: number; policy_evaluation_id: string | null;
  ip_address: string | null; user_agent: string | null; accessed_at: string;
}

function buildSecretScope(row: SecuritySecretRow): FridaySecretScope {
  switch (row.scope_type) {
    case "tenant":
      return { scopeType: "tenant", tenantId: row.tenant_id } as FridaySecretScope;
    case "workspace":
      return { scopeType: "workspace", tenantId: row.tenant_id, workspaceId: row.workspace_id ?? "" } as FridaySecretScope;
    case "resource":
      return { scopeType: "resource", tenantId: row.tenant_id, workspaceId: row.workspace_id ?? "", resourceId: row.resource_id ?? "" } as FridaySecretScope;
    default:
      return { scopeType: "tenant", tenantId: row.tenant_id } as FridaySecretScope;
  }
}

function secretRowToEntity(row: SecuritySecretRow): FridaySecretEntry {
  return {
    id: row.id,
    scope: buildSecretScope(row),
    name: row.name,
    description: row.description ?? undefined,
    encryptedValue: row.encrypted_value,
    encryptionKeyId: row.encryption_key_id,
    version: row.version,
    rotationState: row.rotation_state as FridaySecretEntry["rotationState"],
    expiresAt: row.expires_at ?? undefined,
    rotatedAt: row.rotated_at ?? undefined,
    etag: row.etag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
  };
}

function secretEntityToRow(entity: FridaySecretEntry): SecuritySecretRow {
  const scope = entity.scope;
  const workspaceId = scope.scopeType === "workspace" || scope.scopeType === "resource" ? (scope as { workspaceId: string }).workspaceId : null;
  const resourceId = scope.scopeType === "resource" ? (scope as { resourceId: string }).resourceId : null;
  return {
    id: entity.id,
    tenant_id: scope.tenantId,
    workspace_id: workspaceId,
    resource_id: resourceId,
    scope_type: scope.scopeType,
    name: entity.name,
    description: entity.description ?? null,
    encrypted_value: entity.encryptedValue,
    encryption_key_id: entity.encryptionKeyId,
    version: entity.version,
    rotation_state: entity.rotationState,
    expires_at: entity.expiresAt ?? null,
    rotated_at: entity.rotatedAt ?? null,
    etag: entity.etag,
    created_at: entity.createdAt,
    updated_at: entity.updatedAt,
    deleted_at: entity.deletedAt ?? null,
  };
}

function rotationRowToEntity(row: SecuritySecretRotationRow): FridaySecretRotation {
  const details = safeJsonParse(row.details_json, {} as JsonObject);
  return {
    id: row.id,
    secretId: row.secret_id,
    tenantId: row.tenant_id,
    fromVersion: typeof details.fromVersion === "number" ? (details.fromVersion as number) : 0,
    toVersion: typeof details.toVersion === "number" ? (details.toVersion as number) : 0,
    initiatedBy: row.initiated_by,
    state: row.state as FridaySecretRotation["state"],
    gracePeriodSeconds: row.grace_period_seconds ?? 0,
    errorMessage: typeof details.errorMessage === "string" ? (details.errorMessage as string) : undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function rotationEntityToRow(entity: FridaySecretRotation): SecuritySecretRotationRow {
  return {
    id: entity.id,
    secret_id: entity.secretId,
    tenant_id: entity.tenantId,
    initiated_by: entity.initiatedBy,
    state: entity.state,
    grace_period_seconds: entity.gracePeriodSeconds,
    started_at: entity.startedAt,
    completed_at: entity.completedAt ?? null,
    retired_at: null,
    details_json: JSON.stringify({
      fromVersion: entity.fromVersion,
      toVersion: entity.toVersion,
      errorMessage: entity.errorMessage,
    }),
  };
}

function accessLogRowToEntity(row: SecuritySecretAccessLogRow): FridaySecretAccessLog {
  return {
    id: row.id,
    secretId: row.secret_id,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    action: row.action as FridaySecretAccessLog["action"],
    granted: row.granted === 1,
    policyEvaluationId: row.policy_evaluation_id ?? undefined,
    ipAddress: row.ip_address ?? undefined,
    userAgent: row.user_agent ?? undefined,
    accessedAt: row.accessed_at,
  };
}

function accessLogEntityToRow(entity: FridaySecretAccessLog): SecuritySecretAccessLogRow {
  return {
    id: entity.id,
    secret_id: entity.secretId,
    tenant_id: entity.tenantId,
    principal_id: entity.principalId,
    action: entity.action,
    granted: entity.granted ? 1 : 0,
    policy_evaluation_id: entity.policyEvaluationId ?? null,
    ip_address: entity.ipAddress ?? null,
    user_agent: entity.userAgent ?? null,
    accessed_at: entity.accessedAt,
  };
}

export function createSqliteSecretPersistence(sqlite: FridaySecuritySqliteLayer): SecretPersistenceBackend {
  return {
    hydrateSecrets() {
      const rows = sqlite.withReadConnection((db) =>
        db.prepare("SELECT * FROM security_secrets").all() as SecuritySecretRow[],
      );
      const map = new Map<UUID, FridaySecretEntry>();
      for (const row of rows) map.set(row.id, secretRowToEntity(row));
      return map;
    },
    hydrateRotations() {
      const rows = sqlite.withReadConnection((db) =>
        db.prepare("SELECT * FROM security_secret_rotations").all() as SecuritySecretRotationRow[],
      );
      const map = new Map<UUID, FridaySecretRotation>();
      for (const row of rows) map.set(row.id, rotationRowToEntity(row));
      return map;
    },
    hydrateAccessLogs() {
      const rows = sqlite.withReadConnection((db) =>
        db.prepare("SELECT * FROM security_secret_access_log ORDER BY accessed_at DESC LIMIT 5000").all() as SecuritySecretAccessLogRow[],
      );
      return rows.map(accessLogRowToEntity);
    },
    saveSecret(secret: FridaySecretEntry) {
      const row = secretEntityToRow(secret);
      sqlite.withWriteTransaction((db) => {
        db.prepare(
          `INSERT INTO security_secrets (
             id, tenant_id, workspace_id, resource_id, scope_type, name, description,
             encrypted_value, encryption_key_id, version, rotation_state,
             expires_at, rotated_at, etag, created_at, updated_at, deleted_at
           ) VALUES (
             @id, @tenant_id, @workspace_id, @resource_id, @scope_type, @name, @description,
             @encrypted_value, @encryption_key_id, @version, @rotation_state,
             @expires_at, @rotated_at, @etag, @created_at, @updated_at, @deleted_at
           ) ON CONFLICT(id) DO UPDATE SET
             description = excluded.description, encrypted_value = excluded.encrypted_value,
             encryption_key_id = excluded.encryption_key_id, version = excluded.version,
             rotation_state = excluded.rotation_state, expires_at = excluded.expires_at,
             rotated_at = excluded.rotated_at, etag = excluded.etag,
             updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`,
        ).run(row);
      });
    },
    saveRotation(rotation: FridaySecretRotation) {
      const row = rotationEntityToRow(rotation);
      sqlite.withWriteTransaction((db) => {
        db.prepare(
          `INSERT INTO security_secret_rotations (
             id, secret_id, tenant_id, initiated_by, state, grace_period_seconds,
             started_at, completed_at, retired_at, details_json
           ) VALUES (
             @id, @secret_id, @tenant_id, @initiated_by, @state, @grace_period_seconds,
             @started_at, @completed_at, @retired_at, @details_json
           ) ON CONFLICT(id) DO UPDATE SET
             state = excluded.state, completed_at = excluded.completed_at,
             retired_at = excluded.retired_at, details_json = excluded.details_json`,
        ).run(row);
      });
    },
    appendAccessLog(log) {
      const row = accessLogEntityToRow(log);
      sqlite.withWriteTransaction((db) => {
        db.prepare(
          `INSERT INTO security_secret_access_log (
             id, secret_id, tenant_id, principal_id, action, granted,
             policy_evaluation_id, ip_address, user_agent, accessed_at
           ) VALUES (
             @id, @secret_id, @tenant_id, @principal_id, @action, @granted,
             @policy_evaluation_id, @ip_address, @user_agent, @accessed_at
           )`,
        ).run(row);
      });
    },
  };
}

// ─── Audit persistence ───

export interface AuditPersistenceBackend {
  hydrateAuditEntries(): Map<UUID, FridaySecurityAuditEntry>;
  hydrateViolations(): Map<UUID, FridaySecurityViolation>;
  saveAuditEntry(entry: FridaySecurityAuditEntry): void;
  saveViolation(violation: FridaySecurityViolation): void;
}

interface SecurityAuditRow {
  id: string; tenant_id: string | null; principal_id: string | null;
  action: string; resource_type: string; resource_id: string | null;
  decision: string; reason: string | null;
  ip_address: string | null; user_agent: string | null;
  session_id: string | null; metadata_json: string; created_at: string;
}
interface SecurityViolationRow {
  id: string; tenant_id: string | null; principal_id: string;
  violation_type: string; severity: string; description: string;
  resource_type: string | null; resource_id: string | null;
  action_attempted: string | null; ip_address: string | null;
  resolved: number; resolved_by: string | null; resolved_at: string | null;
  metadata_json: string; created_at: string;
}

function auditRowToEntity(row: SecurityAuditRow): FridaySecurityAuditEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    principalId: row.principal_id ?? undefined,
    action: row.action,
    resourceType: row.resource_type as FridaySecurityAuditEntry["resourceType"],
    resourceId: row.resource_id ?? undefined,
    decision: row.decision as FridaySecurityAuditEntry["decision"],
    reason: row.reason ?? undefined,
    ipAddress: row.ip_address ?? undefined,
    userAgent: row.user_agent ?? undefined,
    sessionId: row.session_id ?? undefined,
    metadata: safeJsonParse(row.metadata_json, {} as JsonObject),
    createdAt: row.created_at,
  };
}

function auditEntityToRow(entity: FridaySecurityAuditEntry): SecurityAuditRow {
  return {
    id: entity.id,
    tenant_id: entity.tenantId,
    principal_id: entity.principalId ?? null,
    action: entity.action,
    resource_type: entity.resourceType,
    resource_id: entity.resourceId ?? null,
    decision: entity.decision,
    reason: entity.reason ?? null,
    ip_address: entity.ipAddress ?? null,
    user_agent: entity.userAgent ?? null,
    session_id: entity.sessionId ?? null,
    metadata_json: JSON.stringify(entity.metadata ?? {}),
    created_at: entity.createdAt,
  };
}

function violationRowToEntity(row: SecurityViolationRow): FridaySecurityViolation {
  return {
    id: row.id,
    tenantId: row.tenant_id ?? "",
    principalId: row.principal_id,
    violationType: row.violation_type as FridaySecurityViolation["violationType"],
    severity: row.severity as FridaySecurityViolation["severity"],
    description: row.description,
    resourceType: (row.resource_type ?? undefined) as FridaySecurityViolation["resourceType"],
    resourceId: row.resource_id ?? undefined,
    actionAttempted: row.action_attempted ?? undefined,
    ipAddress: row.ip_address ?? undefined,
    resolved: row.resolved === 1,
    resolvedBy: row.resolved_by ?? undefined,
    resolvedAt: row.resolved_at ?? undefined,
    metadata: safeJsonParse(row.metadata_json, {} as JsonObject),
    createdAt: row.created_at,
  };
}

function violationEntityToRow(entity: FridaySecurityViolation): SecurityViolationRow {
  return {
    id: entity.id,
    tenant_id: entity.tenantId ?? null,
    principal_id: entity.principalId,
    violation_type: entity.violationType,
    severity: entity.severity,
    description: entity.description,
    resource_type: entity.resourceType ?? null,
    resource_id: entity.resourceId ?? null,
    action_attempted: entity.actionAttempted ?? null,
    ip_address: entity.ipAddress ?? null,
    resolved: entity.resolved ? 1 : 0,
    resolved_by: entity.resolvedBy ?? null,
    resolved_at: entity.resolvedAt ?? null,
    metadata_json: JSON.stringify(entity.metadata ?? {}),
    created_at: entity.createdAt,
  };
}

export function createSqliteAuditPersistence(sqlite: FridaySecuritySqliteLayer): AuditPersistenceBackend {
  return {
    hydrateAuditEntries() {
      const rows = sqlite.withReadConnection((db) =>
        db.prepare("SELECT * FROM security_audit_log ORDER BY created_at DESC LIMIT 10000").all() as SecurityAuditRow[],
      );
      const map = new Map<UUID, FridaySecurityAuditEntry>();
      for (const row of rows) map.set(row.id, auditRowToEntity(row));
      return map;
    },
    hydrateViolations() {
      const rows = sqlite.withReadConnection((db) =>
        db.prepare("SELECT * FROM security_violations ORDER BY created_at DESC LIMIT 10000").all() as SecurityViolationRow[],
      );
      const map = new Map<UUID, FridaySecurityViolation>();
      for (const row of rows) map.set(row.id, violationRowToEntity(row));
      return map;
    },
    saveAuditEntry(entry: FridaySecurityAuditEntry) {
      const row = auditEntityToRow(entry);
      sqlite.withWriteTransaction((db) => {
        db.prepare(
          `INSERT INTO security_audit_log (
             id, tenant_id, principal_id, action, resource_type, resource_id,
             decision, reason, ip_address, user_agent, session_id, metadata_json, created_at
           ) VALUES (
             @id, @tenant_id, @principal_id, @action, @resource_type, @resource_id,
             @decision, @reason, @ip_address, @user_agent, @session_id, @metadata_json, @created_at
           )`,
        ).run(row);
      });
    },
    saveViolation(violation) {
      const row = violationEntityToRow(violation);
      sqlite.withWriteTransaction((db) => {
        db.prepare(
          `INSERT INTO security_violations (
             id, tenant_id, principal_id, violation_type, severity, description,
             resource_type, resource_id, action_attempted, ip_address,
             resolved, resolved_by, resolved_at, metadata_json, created_at
           ) VALUES (
             @id, @tenant_id, @principal_id, @violation_type, @severity, @description,
             @resource_type, @resource_id, @action_attempted, @ip_address,
             @resolved, @resolved_by, @resolved_at, @metadata_json, @created_at
           ) ON CONFLICT(id) DO UPDATE SET
             resolved = excluded.resolved, resolved_by = excluded.resolved_by,
             resolved_at = excluded.resolved_at`,
        ).run(row);
      });
    },
  };
}

// ─── Role/policy persistence (optional sidecar) ───

interface SecurityRoleRow {
  id: string; tenant_id: string | null; name: string; scope_type: string;
  is_system: number; permissions_json: string; etag: string;
  created_at: string; updated_at: string; deleted_at: string | null;
}
interface SecurityRoleAssignmentRow {
  id: string; tenant_id: string | null; principal_id: string; role_id: string;
  scope_type: string; scope_id: string | null; granted_by: string;
  granted_at: string; expires_at: string | null; revoked_at: string | null;
}

export interface RbacPersistenceBackend {
  hydrateRoles(): Map<UUID, FridayRole>;
  hydrateAssignments(): Map<UUID, FridayRoleAssignment>;
  saveRole(role: FridayRole): void;
  saveAssignment(assignment: FridayRoleAssignment): void;
}

function roleRowToEntity(row: SecurityRoleRow): FridayRole {
  return {
    id: row.id,
    tenantId: row.tenant_id ?? null,
    name: row.name,
    description: undefined,
    scopeType: row.scope_type as FridayRole["scopeType"],
    isSystem: row.is_system === 1,
    permissions: safeJsonParse(row.permissions_json, [] as FridayRole["permissions"]),
    etag: row.etag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
  };
}

function roleEntityToRow(role: FridayRole): SecurityRoleRow {
  return {
    id: role.id,
    tenant_id: role.tenantId ?? null,
    name: role.name,
    scope_type: role.scopeType,
    is_system: role.isSystem ? 1 : 0,
    permissions_json: JSON.stringify(role.permissions ?? []),
    etag: role.etag,
    created_at: role.createdAt,
    updated_at: role.updatedAt,
    deleted_at: (role as { deletedAt?: string }).deletedAt ?? null,
  };
}

function assignmentRowToEntity(row: SecurityRoleAssignmentRow): FridayRoleAssignment {
  const scopeId = row.scope_id ?? null;
  let scope: FridayRoleAssignment["scope"];
  switch (row.scope_type) {
    case "system":
      scope = { scopeType: "system" } as FridayRoleAssignment["scope"];
      break;
    case "tenant":
      scope = { scopeType: "tenant", tenantId: row.tenant_id ?? "" } as FridayRoleAssignment["scope"];
      break;
    case "workspace":
      scope = { scopeType: "workspace", tenantId: row.tenant_id ?? "", workspaceId: scopeId ?? "" } as FridayRoleAssignment["scope"];
      break;
    default:
      scope = { scopeType: "system" } as FridayRoleAssignment["scope"];
  }
  return {
    id: row.id,
    principalId: row.principal_id,
    roleId: row.role_id,
    scope,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  } as FridayRoleAssignment;
}

function assignmentEntityToRow(assignment: FridayRoleAssignment): SecurityRoleAssignmentRow {
  const scope = assignment.scope;
  let tenantId: string | null = null;
  let scopeId: string | null = null;
  if (scope.scopeType === "tenant") {
    tenantId = (scope as { tenantId: string }).tenantId;
  } else if (scope.scopeType === "workspace") {
    tenantId = (scope as { tenantId: string }).tenantId;
    scopeId = (scope as { workspaceId: string }).workspaceId;
  }
  return {
    id: assignment.id,
    tenant_id: tenantId,
    principal_id: assignment.principalId,
    role_id: assignment.roleId,
    scope_type: scope.scopeType,
    scope_id: scopeId,
    granted_by: assignment.grantedBy,
    granted_at: assignment.grantedAt,
    expires_at: assignment.expiresAt ?? null,
    revoked_at: assignment.revokedAt ?? null,
  };
}

export function createSqliteRbacPersistence(sqlite: FridaySecuritySqliteLayer): RbacPersistenceBackend {
  return {
    hydrateRoles() {
      const rows = sqlite.withReadConnection((db) => db.prepare("SELECT * FROM security_roles").all() as SecurityRoleRow[]);
      const map = new Map<UUID, FridayRole>();
      for (const row of rows) map.set(row.id, roleRowToEntity(row));
      return map;
    },
    hydrateAssignments() {
      const rows = sqlite.withReadConnection((db) => db.prepare("SELECT * FROM security_role_assignments").all() as SecurityRoleAssignmentRow[]);
      const map = new Map<UUID, FridayRoleAssignment>();
      for (const row of rows) map.set(row.id, assignmentRowToEntity(row));
      return map;
    },
    saveRole(role) {
      const row = roleEntityToRow(role);
      sqlite.withWriteTransaction((db) => {
        db.prepare(
          `INSERT INTO security_roles (id, tenant_id, name, scope_type, is_system, permissions_json, etag, created_at, updated_at, deleted_at)
           VALUES (@id, @tenant_id, @name, @scope_type, @is_system, @permissions_json, @etag, @created_at, @updated_at, @deleted_at)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name, permissions_json = excluded.permissions_json,
             etag = excluded.etag, updated_at = excluded.updated_at,
             deleted_at = excluded.deleted_at`,
        ).run(row);
      });
    },
    saveAssignment(assignment) {
      const row = assignmentEntityToRow(assignment);
      sqlite.withWriteTransaction((db) => {
        db.prepare(
          `INSERT INTO security_role_assignments (
             id, tenant_id, principal_id, role_id, scope_type, scope_id,
             granted_by, granted_at, expires_at, revoked_at
           ) VALUES (
             @id, @tenant_id, @principal_id, @role_id, @scope_type, @scope_id,
             @granted_by, @granted_at, @expires_at, @revoked_at
           ) ON CONFLICT(id) DO UPDATE SET
             revoked_at = excluded.revoked_at, expires_at = excluded.expires_at`,
        ).run(row);
      });
    },
  };
}

// ─── Tenant-scoped resource records persistence (Phase 11 Module 18) ───

export interface TenantScopedResourcePersistenceBackend {
  hydrate(): Map<UUID, FridayTenantScopedResourceRecord>;
  save(record: FridayTenantScopedResourceRecord): void;
}

interface SecurityTenantScopedResourceRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  resource_kind: string;
  resource_id: string;
  resource_label: string | null;
  etag: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function scopedResourceRowToEntity(
  row: SecurityTenantScopedResourceRow,
): FridayTenantScopedResourceRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id ?? undefined,
    resourceKind: row.resource_kind as FridayTenantScopedResourceKind,
    resourceId: row.resource_id,
    resourceLabel: row.resource_label ?? undefined,
    etag: row.etag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
  };
}

function scopedResourceEntityToRow(
  entity: FridayTenantScopedResourceRecord,
): SecurityTenantScopedResourceRow {
  return {
    id: entity.id,
    tenant_id: entity.tenantId,
    workspace_id: entity.workspaceId ?? null,
    resource_kind: entity.resourceKind,
    resource_id: entity.resourceId,
    resource_label: entity.resourceLabel ?? null,
    etag: entity.etag,
    created_at: entity.createdAt,
    updated_at: entity.updatedAt,
    deleted_at: entity.deletedAt ?? null,
  };
}

export function createSqliteTenantScopedResourcePersistence(
  sqlite: FridaySecuritySqliteLayer,
): TenantScopedResourcePersistenceBackend {
  return {
    hydrate() {
      const rows = sqlite.withReadConnection((db) =>
        db.prepare("SELECT * FROM security_tenant_scoped_resources").all() as SecurityTenantScopedResourceRow[],
      );
      const map = new Map<UUID, FridayTenantScopedResourceRecord>();
      for (const row of rows) map.set(row.id, scopedResourceRowToEntity(row));
      return map;
    },
    save(record: FridayTenantScopedResourceRecord) {
      const row = scopedResourceEntityToRow(record);
      sqlite.withWriteTransaction((db) => {
        db.prepare(
          `INSERT INTO security_tenant_scoped_resources (
             id, tenant_id, workspace_id, resource_kind, resource_id,
             resource_label, etag, created_at, updated_at, deleted_at
           ) VALUES (
             @id, @tenant_id, @workspace_id, @resource_kind, @resource_id,
             @resource_label, @etag, @created_at, @updated_at, @deleted_at
           ) ON CONFLICT(id) DO UPDATE SET
             workspace_id = excluded.workspace_id,
             resource_label = excluded.resource_label,
             etag = excluded.etag,
             updated_at = excluded.updated_at,
             deleted_at = excluded.deleted_at`,
        ).run(row);
      });
    },
  };
}

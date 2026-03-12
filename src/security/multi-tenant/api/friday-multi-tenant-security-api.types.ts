/**
 * Multi-Tenant Security and Permissions — API and SDK Contract.
 *
 * Request/response DTOs for the multi-tenant security REST API.
 * All types follow Friday API conventions: `FridayPage<T>` for pagination,
 * cursor-based pagination, idempotency keys on writes, DTO-only responses.
 *
 * @module security/multi-tenant/api
 */

import type { FridayPage, FridayPaginationQuery } from "../../../api/model/friday-api-common.types.js";

import type {
  FridayPolicyConditionGroup,
  FridayPolicyDecision,
  FridayPolicyEffect,
  FridayRoleAssignmentScope,
  FridayRoleScopeType,
  FridaySecretAccessAction,
  FridaySecretRotationState,
  FridaySecretScopeType,
  FridaySecurityActionType,
  FridaySecurityAuditDecision,
  FridaySecurityResourceType,
  FridaySecurityViolationSeverity,
  FridaySecurityViolationType,
  FridayTenantStatus,
  FridayWorkspaceStatus,
  ISODateTime,
  UUID,
} from "../model/friday-multi-tenant-security.types.js";

// ═══════════════════════════════════════════════════════════════════════
// ERROR CODES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Standardised error codes for the multi-tenant security domain.
 *
 * @example
 * ```ts
 * if (error.code === FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.TENANT_NOT_FOUND) { ... }
 * ```
 */
export const FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES = {
  // ─── Tenant ───
  /** The requested tenant does not exist or has been deleted. */
  TENANT_NOT_FOUND: "SECURITY_TENANT_NOT_FOUND",
  /** A tenant with this slug already exists. */
  TENANT_SLUG_CONFLICT: "SECURITY_TENANT_SLUG_CONFLICT",
  /** The tenant is not in a valid state for this operation. */
  TENANT_INVALID_STATE: "SECURITY_TENANT_INVALID_STATE",
  /** Maximum number of tenants has been reached. */
  TENANT_LIMIT_EXCEEDED: "SECURITY_TENANT_LIMIT_EXCEEDED",

  // ─── Workspace ───
  /** The requested workspace does not exist or has been deleted. */
  WORKSPACE_NOT_FOUND: "SECURITY_WORKSPACE_NOT_FOUND",
  /** A workspace with this slug already exists in the tenant. */
  WORKSPACE_SLUG_CONFLICT: "SECURITY_WORKSPACE_SLUG_CONFLICT",
  /** The workspace is not in a valid state for this operation. */
  WORKSPACE_INVALID_STATE: "SECURITY_WORKSPACE_INVALID_STATE",
  /** Maximum number of workspaces for this tenant has been reached. */
  WORKSPACE_LIMIT_EXCEEDED: "SECURITY_WORKSPACE_LIMIT_EXCEEDED",

  // ─── Membership ───
  /** The requested membership does not exist. */
  MEMBERSHIP_NOT_FOUND: "SECURITY_MEMBERSHIP_NOT_FOUND",
  /** The principal is already a member of this workspace with this role. */
  MEMBERSHIP_ALREADY_EXISTS: "SECURITY_MEMBERSHIP_ALREADY_EXISTS",
  /** Maximum number of members for this tenant has been reached. */
  MEMBERSHIP_LIMIT_EXCEEDED: "SECURITY_MEMBERSHIP_LIMIT_EXCEEDED",

  // ─── Role ───
  /** The requested role does not exist or has been deleted. */
  ROLE_NOT_FOUND: "SECURITY_ROLE_NOT_FOUND",
  /** A role with this name already exists in the scope. */
  ROLE_NAME_CONFLICT: "SECURITY_ROLE_NAME_CONFLICT",
  /** Cannot modify a built-in system role. */
  ROLE_SYSTEM_IMMUTABLE: "SECURITY_ROLE_SYSTEM_IMMUTABLE",

  // ─── Permission ───
  /** The requested permission does not exist. */
  PERMISSION_NOT_FOUND: "SECURITY_PERMISSION_NOT_FOUND",
  /** The principal does not have the required permission. */
  PERMISSION_DENIED: "SECURITY_PERMISSION_DENIED",
  /** Attempt to grant a permission the grantor does not hold (escalation). */
  PERMISSION_ESCALATION: "SECURITY_PERMISSION_ESCALATION",

  // ─── Role Assignment ───
  /** The requested role assignment does not exist. */
  ASSIGNMENT_NOT_FOUND: "SECURITY_ASSIGNMENT_NOT_FOUND",
  /** This role assignment already exists. */
  ASSIGNMENT_ALREADY_EXISTS: "SECURITY_ASSIGNMENT_ALREADY_EXISTS",
  /** Role scope is incompatible with the requested assignment scope (SEC-FIX-R5-03). */
  ASSIGNMENT_SCOPE_INCOMPATIBLE: "SECURITY_ASSIGNMENT_SCOPE_INCOMPATIBLE",

  // ─── Secret ───
  /** The requested secret does not exist or has been deleted. */
  SECRET_NOT_FOUND: "SECURITY_SECRET_NOT_FOUND",
  /** A secret with this name already exists in the scope. */
  SECRET_NAME_CONFLICT: "SECURITY_SECRET_NAME_CONFLICT",
  /** The secret is not in a valid state for rotation. */
  SECRET_ROTATION_INVALID: "SECURITY_SECRET_ROTATION_INVALID",
  /** The secret version has expired. */
  SECRET_VERSION_EXPIRED: "SECURITY_SECRET_VERSION_EXPIRED",
  /** Maximum number of secrets for this workspace has been reached. */
  SECRET_LIMIT_EXCEEDED: "SECURITY_SECRET_LIMIT_EXCEEDED",

  // ─── Policy ───
  /** The requested security policy does not exist or has been deleted. */
  POLICY_NOT_FOUND: "SECURITY_POLICY_NOT_FOUND",
  /** A policy with this name already exists in the scope. */
  POLICY_NAME_CONFLICT: "SECURITY_POLICY_NAME_CONFLICT",
  /** Policy evaluation failed due to an internal error. */
  POLICY_EVALUATION_FAILED: "SECURITY_POLICY_EVALUATION_FAILED",

  // ─── Cross-Cutting ───
  /** Optimistic concurrency conflict — the etag does not match. */
  ETAG_MISMATCH: "SECURITY_ETAG_MISMATCH",
  /** Validation failed on the request payload. */
  VALIDATION_FAILED: "SECURITY_VALIDATION_FAILED",
  /** Idempotency key reused with a different payload inside retention window. */
  IDEMPOTENCY_KEY_CONFLICT: "SECURITY_IDEMPOTENCY_KEY_CONFLICT",
  /** The requesting principal lacks the required scope for this operation. */
  INSUFFICIENT_SCOPE: "SECURITY_INSUFFICIENT_SCOPE",
  /** Cross-tenant access attempted and denied. */
  CROSS_TENANT_DENIED: "SECURITY_CROSS_TENANT_DENIED",
} as const;

/** Union type of all multi-tenant security error codes. */
export type FridayMultiTenantSecurityErrorCode =
  (typeof FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES)[keyof typeof FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES];

// ═══════════════════════════════════════════════════════════════════════
// PAGINATION
// ═══════════════════════════════════════════════════════════════════════

/** Pagination query for multi-tenant security endpoints. */
export type FridaySecurityPaginationQuery = FridayPaginationQuery;

/** Paginated result for multi-tenant security endpoints. */
export type FridaySecurityPage<TItem> = FridayPage<TItem>;

// ═══════════════════════════════════════════════════════════════════════
// IDEMPOTENCY CONTRACT
// ═══════════════════════════════════════════════════════════════════════

/** Idempotency TTL in hours for security API write operations. */
export const FRIDAY_SECURITY_IDEMPOTENCY_TTL_HOURS = 24 as const;

/**
 * Idempotency contract specification for multi-tenant security API write operations.
 *
 * Scope is `(principalId, tenantId, operationId, key)` — tenant-isolated to prevent
 * cross-tenant idempotency key collisions (SEC-FIX-R5-02).
 */
export interface FridaySecurityIdempotencyContract {
  /** Scope is (principalId, tenantId, operationId, key). Tenant-isolated. */
  readonly scope: "principal+tenant+operation+key";
  /** Keys expire after 24 hours. */
  readonly ttlHours: 24;
  /** Same payload hash returns the original response. */
  readonly replayBehavior: "same_payload_returns_original_response";
  /** Different payload hash returns 409. */
  readonly conflict: {
    readonly httpStatus: 409;
    readonly code: "SECURITY_IDEMPOTENCY_KEY_CONFLICT";
  };
}

// ═══════════════════════════════════════════════════════════════════════
// API SCOPE DISCRIMINATED UNIONS (SEC-FIX-R2-03)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Discriminated union for role assignment scopes at the API layer.
 *
 * Role assignments can target system, tenant, or workspace scope.
 * Invalid combinations (e.g., system scope with a workspaceId) are
 * unrepresentable by construction.
 */
export type FridayRoleAssignmentScopeDto =
  | { readonly scopeType: "system" }
  | { readonly scopeType: "tenant" }
  | { readonly scopeType: "workspace"; readonly workspaceId: UUID };

/**
 * Tenant-scoped role assignment scope DTO (SEC-FIX-R4-03).
 *
 * On tenant-scoped grant routes (`POST /api/security/tenants/:tenantId/role-assignments`),
 * only `tenant` and `workspace` scopes are valid. System-scope grants use a
 * separate system-level endpoint. This prevents accidental system-scope
 * assignments through tenant-scoped routes.
 */
export type FridayTenantScopedRoleAssignmentScopeDto =
  | { readonly scopeType: "tenant" }
  | { readonly scopeType: "workspace"; readonly workspaceId: UUID };

/**
 * Discriminated union for policy scopes at the API layer.
 *
 * Policies can target tenant or workspace scope (no system or resource).
 * Invalid combinations are unrepresentable by construction.
 */
export type FridayPolicyScopeDto =
  | { readonly scopeType: "tenant" }
  | { readonly scopeType: "workspace"; readonly workspaceId: UUID };

// ═══════════════════════════════════════════════════════════════════════
// DTO TYPES (API layer — no domain entity leakage)
// ═══════════════════════════════════════════════════════════════════════

// ─── Tenant DTOs ───

/** API DTO for a tenant. */
export interface FridayTenantDto {
  readonly id: UUID;
  readonly name: string;
  readonly slug: string;
  readonly status: FridayTenantStatus;
  readonly maxWorkspaces: number;
  readonly maxMembers: number;
  /** Maximum number of secrets per workspace. */
  readonly maxSecretsPerWorkspace: number;
  /** Audit log retention in days. */
  readonly auditRetentionDays: number;
  /** Feature flags (arbitrary key-value). */
  readonly featureFlags: Readonly<Record<string, boolean>>;
  readonly etag: string;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** Summary DTO for tenant list views. */
export interface FridayTenantSummaryDto {
  readonly id: UUID;
  readonly name: string;
  readonly slug: string;
  readonly status: FridayTenantStatus;
  readonly createdAt: ISODateTime;
}

// ─── Workspace DTOs ───

/** API DTO for a workspace. */
export interface FridayWorkspaceDto {
  readonly id: UUID;
  readonly tenantId: UUID;
  readonly name: string;
  readonly slug: string;
  readonly status: FridayWorkspaceStatus;
  readonly etag: string;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** Summary DTO for workspace list views. */
export interface FridayWorkspaceSummaryDto {
  readonly id: UUID;
  readonly tenantId: UUID;
  readonly name: string;
  readonly slug: string;
  readonly status: FridayWorkspaceStatus;
  readonly createdAt: ISODateTime;
}

// ─── Membership DTOs ───

/** API DTO for a workspace membership. */
export interface FridayWorkspaceMembershipDto {
  readonly id: UUID;
  readonly workspaceId: UUID;
  readonly tenantId: UUID;
  readonly principalId: string;
  readonly roleId: UUID;
  readonly roleName: string;
  readonly grantedBy: string;
  readonly grantedAt: ISODateTime;
  readonly expiresAt?: ISODateTime;
  readonly revokedAt?: ISODateTime;
}

// ─── Role DTOs ───

/** API DTO for a permission. */
export interface FridayPermissionDto {
  readonly id: UUID;
  readonly resource: FridaySecurityResourceType;
  readonly action: FridaySecurityActionType;
  readonly description: string;
}

/** API DTO for a role (response). */
export interface FridayRoleDto {
  readonly id: UUID;
  readonly tenantId: UUID | null;
  readonly name: string;
  readonly description?: string;
  readonly scopeType: FridayRoleScopeType;
  readonly isSystem: boolean;
  readonly permissions: readonly FridayPermissionDto[];
  readonly etag: string;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** Summary DTO for role list views. */
export interface FridayRoleSummaryDto {
  readonly id: UUID;
  readonly name: string;
  readonly scopeType: FridayRoleScopeType;
  readonly isSystem: boolean;
  readonly permissionCount: number;
  readonly createdAt: ISODateTime;
}

// ─── Role Assignment DTOs ───

/** API DTO for a role assignment (response). */
export interface FridayRoleAssignmentDto {
  readonly id: UUID;
  readonly tenantId: UUID | null;
  readonly principalId: string;
  readonly roleId: UUID;
  readonly roleName: string;
  /** Discriminated scope union (SEC-FIX-R2-03). */
  readonly scope: FridayRoleAssignmentScopeDto;
  readonly grantedBy: string;
  readonly grantedAt: ISODateTime;
  readonly expiresAt?: ISODateTime;
  readonly revokedAt?: ISODateTime;
}

// ─── Secret DTOs ───

// ─── Secret DTO Discriminated Union (SEC-FIX-R4-04, ADR-7) ───

/** Base fields shared by all secret DTO scope variants. */
interface FridaySecretDtoBase {
  readonly id: UUID;
  readonly tenantId: UUID;
  readonly name: string;
  readonly description?: string;
  readonly version: number;
  readonly rotationState: FridaySecretRotationState;
  readonly expiresAt?: ISODateTime;
  readonly rotatedAt?: ISODateTime;
  readonly etag: string;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** Tenant-scoped secret DTO. `workspaceId` and `resourceId` are absent. */
export interface FridaySecretDtoTenant extends FridaySecretDtoBase {
  readonly scopeType: "tenant";
  readonly workspaceId?: never;
  readonly resourceId?: never;
}

/** Workspace-scoped secret DTO. `resourceId` is absent. */
export interface FridaySecretDtoWorkspace extends FridaySecretDtoBase {
  readonly scopeType: "workspace";
  readonly workspaceId: UUID;
  readonly resourceId?: never;
}

/** Resource-scoped secret DTO. All scope fields are present. */
export interface FridaySecretDtoResource extends FridaySecretDtoBase {
  readonly scopeType: "resource";
  readonly workspaceId: UUID;
  readonly resourceId: string;
}

/**
 * API DTO for a secret entry (response).
 *
 * Scope-discriminated union (ADR-7): invalid field combinations are
 * unrepresentable by construction. `encryptedValue` is NEVER included
 * in API responses.
 */
export type FridaySecretDto =
  | FridaySecretDtoTenant
  | FridaySecretDtoWorkspace
  | FridaySecretDtoResource;

/** Summary DTO for secret list views. */
export interface FridaySecretSummaryDto {
  readonly id: UUID;
  readonly name: string;
  readonly scopeType: FridaySecretScopeType;
  readonly version: number;
  readonly rotationState: FridaySecretRotationState;
  readonly createdAt: ISODateTime;
}

/** API DTO for a secret rotation record. */
export interface FridaySecretRotationDto {
  readonly id: UUID;
  readonly secretId: UUID;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly initiatedBy: string;
  readonly state: FridaySecretRotationState;
  readonly gracePeriodSeconds: number;
  readonly errorMessage?: string;
  readonly startedAt: ISODateTime;
  readonly completedAt?: ISODateTime;
}

/** API DTO for a secret access log entry. */
export interface FridaySecretAccessLogDto {
  readonly id: UUID;
  readonly secretId: UUID;
  readonly principalId: string;
  readonly action: FridaySecretAccessAction;
  readonly granted: boolean;
  readonly policyEvaluationId?: UUID;
  readonly ipAddress?: string;
  readonly accessedAt: ISODateTime;
}

// ─── Policy DTOs ───

/** API DTO for a policy rule (response). */
export interface FridayPolicyRuleDto {
  readonly id: UUID;
  readonly name: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly resource: FridaySecurityResourceType;
  readonly action: FridaySecurityActionType;
  readonly conditions: FridayPolicyConditionGroup;
  readonly effect: FridayPolicyEffect;
  readonly message?: string;
  readonly priority: number;
}

/** API DTO for a security policy (response). */
export interface FridaySecurityPolicyDto {
  readonly id: UUID;
  readonly tenantId: UUID;
  readonly name: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly priority: number;
  /** Discriminated scope union (SEC-FIX-R2-03). */
  readonly scope: FridayPolicyScopeDto;
  readonly rules: readonly FridayPolicyRuleDto[];
  readonly version: number;
  readonly etag: string;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** Summary DTO for policy list views. */
export interface FridaySecurityPolicySummaryDto {
  readonly id: UUID;
  readonly name: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly ruleCount: number;
  readonly version: number;
  readonly createdAt: ISODateTime;
}

/** API DTO for a policy evaluation result. */
export interface FridayPolicyEvaluationDto {
  readonly evaluationId: UUID;
  readonly decision: FridayPolicyDecision;
  readonly matchedRuleCount: number;
  readonly message?: string;
  readonly durationMs: number;
  readonly allowed: boolean;
  readonly evaluatedAt: ISODateTime;
}

// ─── Audit DTOs ───

/** API DTO for a security audit entry. */
export interface FridaySecurityAuditEntryDto {
  readonly id: UUID;
  readonly tenantId: UUID | null;
  readonly principalId?: string;
  readonly action: string;
  readonly resourceType: FridaySecurityResourceType;
  readonly resourceId?: string;
  readonly decision: FridaySecurityAuditDecision;
  readonly reason?: string;
  readonly sessionId?: string;
  readonly createdAt: ISODateTime;
}

/** API DTO for a security violation. */
export interface FridaySecurityViolationDto {
  readonly id: UUID;
  readonly tenantId: UUID;
  readonly principalId: string;
  readonly violationType: FridaySecurityViolationType;
  readonly severity: FridaySecurityViolationSeverity;
  readonly description: string;
  readonly resourceType?: FridaySecurityResourceType;
  readonly resourceId?: string;
  readonly actionAttempted?: string;
  readonly resolved: boolean;
  readonly resolvedBy?: string;
  readonly resolvedAt?: ISODateTime;
  readonly createdAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// INPUT DTOS (SEC-FIX-06 — dedicated write contracts)
// ═══════════════════════════════════════════════════════════════════════

// ─── Role Input DTOs ───

/** Input DTO for creating a role. Uses permission IDs, not full permission objects. */
export interface FridayCreateRoleInput {
  readonly name: string;
  readonly description?: string;
  readonly scopeType: FridayRoleScopeType;
  /** Permission IDs to attach to this role. */
  readonly permissionIds: readonly string[];
}

/** Input DTO for updating a role. Uses permission IDs, not full permission objects. */
export interface FridayUpdateRoleInput {
  readonly name?: string;
  readonly description?: string;
  /** Permission IDs to set on this role (replaces existing). */
  readonly permissionIds?: readonly string[];
}

// ─── Policy Rule Input DTOs ───

/** Input DTO for creating a policy rule (no server-owned fields). */
export interface FridayCreatePolicyRuleInput {
  readonly name: string;
  readonly description?: string;
  readonly enabled?: boolean;
  readonly resource: FridaySecurityResourceType;
  readonly action: FridaySecurityActionType;
  readonly conditions: FridayPolicyConditionGroup;
  readonly effect: FridayPolicyEffect;
  readonly message?: string;
  /** @default 100 */
  readonly priority?: number;
}

/** Input DTO for updating a policy rule (no server-owned fields). */
export interface FridayUpdatePolicyRuleInput {
  readonly name?: string;
  readonly description?: string;
  readonly enabled?: boolean;
  readonly resource?: FridaySecurityResourceType;
  readonly action?: FridaySecurityActionType;
  readonly conditions?: FridayPolicyConditionGroup;
  readonly effect?: FridayPolicyEffect;
  readonly message?: string;
  readonly priority?: number;
}

// ─── Secret Input DTOs ───

/** Discriminated scope input for secret creation. */
export type FridayCreateSecretScopeInput =
  | { readonly scopeType: "tenant" }
  | { readonly scopeType: "workspace"; readonly workspaceId: UUID }
  | { readonly scopeType: "resource"; readonly workspaceId: UUID; readonly resourceId: string };

/** Input DTO for creating a secret. */
export interface FridayCreateSecretInput {
  readonly name: string;
  readonly description?: string;
  /** Plaintext secret value (encrypted before storage; never logged). */
  readonly value: string;
  /** Discriminated scope. */
  readonly scope: FridayCreateSecretScopeInput;
  readonly expiresAt?: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// TENANT CRUD
// ═══════════════════════════════════════════════════════════════════════

/** Request body for `POST /api/security/tenants`. */
export interface FridayCreateTenantRequest {
  readonly name: string;
  readonly slug: string;
  readonly maxWorkspaces?: number;
  readonly maxMembers?: number;
  readonly maxSecretsPerWorkspace?: number;
  readonly auditRetentionDays?: number;
  readonly featureFlags?: Readonly<Record<string, boolean>>;
  readonly idempotencyKey: string;
}

/** Response body for `POST /api/security/tenants`. */
export interface FridayCreateTenantResponse {
  readonly tenant: FridayTenantDto;
}

/** Query parameters for `GET /api/security/tenants`. */
export interface FridayListTenantsQuery extends FridaySecurityPaginationQuery {
  readonly status?: FridayTenantStatus;
  readonly sortBy?: "name" | "createdAt" | "updatedAt";
  readonly sortDir?: "asc" | "desc";
}

/** Response body for `GET /api/security/tenants`. */
export interface FridayListTenantsResponse extends FridaySecurityPage<FridayTenantSummaryDto> {}

/** Response body for `GET /api/security/tenants/:tenantId`. */
export interface FridayGetTenantResponse {
  readonly tenant: FridayTenantDto;
  readonly workspaceCount: number;
  readonly memberCount: number;
}

/** Request body for `PATCH /api/security/tenants/:tenantId`. */
export interface FridayUpdateTenantRequest {
  readonly name?: string;
  readonly status?: FridayTenantStatus;
  readonly maxWorkspaces?: number;
  readonly maxMembers?: number;
  readonly maxSecretsPerWorkspace?: number;
  readonly auditRetentionDays?: number;
  readonly featureFlags?: Readonly<Record<string, boolean>>;
  readonly etag: string;
  readonly idempotencyKey: string;
}

/** Response body for `PATCH /api/security/tenants/:tenantId`. */
export interface FridayUpdateTenantResponse {
  readonly tenant: FridayTenantDto;
}

/** Request body for `DELETE /api/security/tenants/:tenantId`. */
export interface FridayDeleteTenantRequest {
  readonly etag: string;
  readonly idempotencyKey: string;
}

/** Response body for `DELETE /api/security/tenants/:tenantId`. */
export interface FridayDeleteTenantResponse {
  readonly tenant: FridayTenantDto;
}

// ═══════════════════════════════════════════════════════════════════════
// WORKSPACE CRUD
// ═══════════════════════════════════════════════════════════════════════

/** Request body for `POST /api/security/tenants/:tenantId/workspaces`. */
export interface FridayCreateWorkspaceRequest {
  readonly name: string;
  readonly slug: string;
  readonly idempotencyKey: string;
}

/** Response body for `POST /api/security/tenants/:tenantId/workspaces`. */
export interface FridayCreateWorkspaceResponse {
  readonly workspace: FridayWorkspaceDto;
}

/** Query parameters for `GET /api/security/tenants/:tenantId/workspaces`. */
export interface FridayListWorkspacesQuery extends FridaySecurityPaginationQuery {
  readonly status?: FridayWorkspaceStatus;
  readonly sortBy?: "name" | "createdAt" | "updatedAt";
  readonly sortDir?: "asc" | "desc";
}

/** Response body for `GET /api/security/tenants/:tenantId/workspaces`. */
export interface FridayListWorkspacesResponse extends FridaySecurityPage<FridayWorkspaceSummaryDto> {}

/** Path parameters for `GET /api/security/tenants/:tenantId/workspaces/:workspaceId`. */
export interface FridayGetWorkspaceParams {
  readonly tenantId: UUID;
  readonly workspaceId: UUID;
}

/** Response body for `GET /api/security/tenants/:tenantId/workspaces/:workspaceId`. */
export interface FridayGetWorkspaceResponse {
  readonly workspace: FridayWorkspaceDto;
  readonly memberCount: number;
}

/** Path parameters for `PATCH /api/security/tenants/:tenantId/workspaces/:workspaceId`. */
export interface FridayUpdateWorkspaceParams {
  readonly tenantId: UUID;
  readonly workspaceId: UUID;
}

/** Request body for `PATCH /api/security/tenants/:tenantId/workspaces/:workspaceId`. */
export interface FridayUpdateWorkspaceRequest {
  readonly name?: string;
  readonly status?: FridayWorkspaceStatus;
  readonly etag: string;
  readonly idempotencyKey: string;
}

/** Response body for `PATCH /api/security/tenants/:tenantId/workspaces/:workspaceId`. */
export interface FridayUpdateWorkspaceResponse {
  readonly workspace: FridayWorkspaceDto;
}

/** Path parameters for `DELETE /api/security/tenants/:tenantId/workspaces/:workspaceId`. */
export interface FridayDeleteWorkspaceParams {
  readonly tenantId: UUID;
  readonly workspaceId: UUID;
}

/** Request body for `DELETE /api/security/tenants/:tenantId/workspaces/:workspaceId`. */
export interface FridayDeleteWorkspaceRequest {
  readonly etag: string;
  readonly idempotencyKey: string;
}

/** Response body for `DELETE /api/security/tenants/:tenantId/workspaces/:workspaceId`. */
export interface FridayDeleteWorkspaceResponse {
  readonly workspace: FridayWorkspaceDto;
}

// ═══════════════════════════════════════════════════════════════════════
// MEMBERSHIP MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════

/** Path parameters for `POST /api/security/tenants/:tenantId/workspaces/:workspaceId/members`. */
export interface FridayAddMemberParams {
  readonly tenantId: UUID;
  readonly workspaceId: UUID;
}

/** Request body for `POST /api/security/tenants/:tenantId/workspaces/:workspaceId/members`. */
export interface FridayAddMemberRequest {
  readonly principalId: string;
  readonly roleId: UUID;
  readonly expiresAt?: ISODateTime;
  readonly idempotencyKey: string;
}

/** Response body for `POST /api/security/tenants/:tenantId/workspaces/:workspaceId/members`. */
export interface FridayAddMemberResponse {
  readonly membership: FridayWorkspaceMembershipDto;
}

/** Path parameters for `GET /api/security/tenants/:tenantId/workspaces/:workspaceId/members`. */
export interface FridayListMembersParams {
  readonly tenantId: UUID;
  readonly workspaceId: UUID;
}

/** Query parameters for `GET /api/security/tenants/:tenantId/workspaces/:workspaceId/members`. */
export interface FridayListMembersQuery extends FridaySecurityPaginationQuery {
  readonly principalId?: string;
  readonly roleId?: UUID;
  readonly includeRevoked?: boolean;
}

/** Response body for `GET /api/security/tenants/:tenantId/workspaces/:workspaceId/members`. */
export interface FridayListMembersResponse extends FridaySecurityPage<FridayWorkspaceMembershipDto> {}

/** Path parameters for `DELETE /api/security/tenants/:tenantId/workspaces/:workspaceId/members/:membershipId`. */
export interface FridayRevokeMemberParams {
  readonly tenantId: UUID;
  readonly workspaceId: UUID;
  readonly membershipId: UUID;
}

/** Request body for `DELETE /api/security/tenants/:tenantId/workspaces/:workspaceId/members/:membershipId`. */
export interface FridayRevokeMemberRequest {
  readonly idempotencyKey: string;
}

/** Response body for `DELETE /api/security/tenants/:tenantId/workspaces/:workspaceId/members/:membershipId`. */
export interface FridayRevokeMemberResponse {
  readonly membership: FridayWorkspaceMembershipDto;
}

// ═══════════════════════════════════════════════════════════════════════
// ROLE MANAGEMENT (SEC-FIX-06: dedicated input DTOs)
// ═══════════════════════════════════════════════════════════════════════

/** Request body for `POST /api/security/tenants/:tenantId/roles`. */
export interface FridayCreateRoleRequest {
  readonly role: FridayCreateRoleInput;
  readonly idempotencyKey: string;
}

/** Response body for `POST /api/security/tenants/:tenantId/roles`. */
export interface FridayCreateRoleResponse {
  readonly role: FridayRoleDto;
}

/** Query parameters for `GET /api/security/tenants/:tenantId/roles`. */
export interface FridayListRolesQuery extends FridaySecurityPaginationQuery {
  readonly scopeType?: FridayRoleScopeType;
  readonly includeSystem?: boolean;
  readonly sortBy?: "name" | "createdAt";
  readonly sortDir?: "asc" | "desc";
}

/** Response body for `GET /api/security/tenants/:tenantId/roles`. */
export interface FridayListRolesResponse extends FridaySecurityPage<FridayRoleSummaryDto> {}

/** Path parameters for `GET /api/security/tenants/:tenantId/roles/:roleId`. */
export interface FridayGetRoleParams {
  readonly tenantId: UUID;
  readonly roleId: UUID;
}

/** Response body for `GET /api/security/tenants/:tenantId/roles/:roleId`. */
export interface FridayGetRoleResponse {
  readonly role: FridayRoleDto;
  readonly assignmentCount: number;
}

/** Path parameters for `PATCH /api/security/tenants/:tenantId/roles/:roleId`. */
export interface FridayUpdateRoleParams {
  readonly tenantId: UUID;
  readonly roleId: UUID;
}

/** Request body for `PATCH /api/security/tenants/:tenantId/roles/:roleId`. */
export interface FridayUpdateRoleRequest {
  readonly role: FridayUpdateRoleInput;
  readonly etag: string;
  readonly idempotencyKey: string;
}

/** Response body for `PATCH /api/security/tenants/:tenantId/roles/:roleId`. */
export interface FridayUpdateRoleResponse {
  readonly role: FridayRoleDto;
}

/** Path parameters for `DELETE /api/security/tenants/:tenantId/roles/:roleId`. */
export interface FridayDeleteRoleParams {
  readonly tenantId: UUID;
  readonly roleId: UUID;
}

/** Request body for `DELETE /api/security/tenants/:tenantId/roles/:roleId`. */
export interface FridayDeleteRoleRequest {
  readonly etag: string;
  readonly idempotencyKey: string;
}

/** Response body for `DELETE /api/security/tenants/:tenantId/roles/:roleId`. */
export interface FridayDeleteRoleResponse {
  readonly role: FridayRoleDto;
}

// ═══════════════════════════════════════════════════════════════════════
// PERMISSION GRANTS / REVOKES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/security/tenants/:tenantId/role-assignments`.
 *
 * Only tenant and workspace scopes are allowed on tenant-scoped grant routes
 * (SEC-FIX-R4-03). System-scope grants must use a system-level endpoint.
 */
export interface FridayGrantRoleRequest {
  readonly principalId: string;
  readonly roleId: UUID;
  /** Tenant-scoped discriminated scope union (SEC-FIX-R4-03). System scope forbidden. */
  readonly scope: FridayTenantScopedRoleAssignmentScopeDto;
  readonly expiresAt?: ISODateTime;
  readonly idempotencyKey: string;
}

/** Response body for `POST /api/security/tenants/:tenantId/role-assignments`. */
export interface FridayGrantRoleResponse {
  readonly assignment: FridayRoleAssignmentDto;
}

/** Query parameters for `GET /api/security/tenants/:tenantId/role-assignments`. */
export interface FridayListRoleAssignmentsQuery extends FridaySecurityPaginationQuery {
  readonly principalId?: string;
  readonly roleId?: UUID;
  /** Filter by scope type string (query param, not full discriminated union). */
  readonly scopeType?: FridayRoleAssignmentScope;
  readonly includeRevoked?: boolean;
}

/** Response body for `GET /api/security/tenants/:tenantId/role-assignments`. */
export interface FridayListRoleAssignmentsResponse extends FridaySecurityPage<FridayRoleAssignmentDto> {}

/** Path parameters for `DELETE /api/security/tenants/:tenantId/role-assignments/:assignmentId`. */
export interface FridayRevokeRoleParams {
  readonly tenantId: UUID;
  readonly assignmentId: UUID;
}

/** Request body for `DELETE /api/security/tenants/:tenantId/role-assignments/:assignmentId`. */
export interface FridayRevokeRoleRequest {
  readonly idempotencyKey: string;
}

/** Response body for `DELETE /api/security/tenants/:tenantId/role-assignments/:assignmentId`. */
export interface FridayRevokeRoleResponse {
  readonly assignment: FridayRoleAssignmentDto;
}

// ═══════════════════════════════════════════════════════════════════════
// SECRET CRUD (SEC-FIX-06: dedicated input DTO for create)
// ═══════════════════════════════════════════════════════════════════════

/** Request body for `POST /api/security/tenants/:tenantId/secrets`. */
export interface FridayCreateSecretRequest {
  readonly secret: FridayCreateSecretInput;
  readonly idempotencyKey: string;
}

/** Response body for `POST /api/security/tenants/:tenantId/secrets`. */
export interface FridayCreateSecretResponse {
  readonly secret: FridaySecretDto;
}

/** Query parameters for `GET /api/security/tenants/:tenantId/secrets`. */
export interface FridayListSecretsQuery extends FridaySecurityPaginationQuery {
  readonly workspaceId?: UUID;
  readonly scopeType?: FridaySecretScopeType;
  readonly rotationState?: FridaySecretRotationState;
  readonly sortBy?: "name" | "createdAt" | "updatedAt";
  readonly sortDir?: "asc" | "desc";
}

/** Response body for `GET /api/security/tenants/:tenantId/secrets`. */
export interface FridayListSecretsResponse extends FridaySecurityPage<FridaySecretSummaryDto> {}

/** Path parameters for `GET /api/security/tenants/:tenantId/secrets/:secretId`. */
export interface FridayGetSecretParams {
  readonly tenantId: UUID;
  readonly secretId: UUID;
}

/** Response body for `GET /api/security/tenants/:tenantId/secrets/:secretId`. */
export interface FridayGetSecretResponse {
  readonly secret: FridaySecretDto;
  readonly rotationHistory: readonly FridaySecretRotationDto[];
}

/** Path parameters for `PATCH /api/security/tenants/:tenantId/secrets/:secretId`. */
export interface FridayUpdateSecretParams {
  readonly tenantId: UUID;
  readonly secretId: UUID;
}

/** Request body for `PATCH /api/security/tenants/:tenantId/secrets/:secretId`. */
export interface FridayUpdateSecretRequest {
  readonly description?: string;
  /** New plaintext value (encrypted before storage). */
  readonly value?: string;
  readonly expiresAt?: ISODateTime;
  readonly etag: string;
  readonly idempotencyKey: string;
}

/** Response body for `PATCH /api/security/tenants/:tenantId/secrets/:secretId`. */
export interface FridayUpdateSecretResponse {
  readonly secret: FridaySecretDto;
}

/** Path parameters for `DELETE /api/security/tenants/:tenantId/secrets/:secretId`. */
export interface FridayDeleteSecretParams {
  readonly tenantId: UUID;
  readonly secretId: UUID;
}

/** Request body for `DELETE /api/security/tenants/:tenantId/secrets/:secretId`. */
export interface FridayDeleteSecretRequest {
  readonly etag: string;
  readonly idempotencyKey: string;
}

/** Response body for `DELETE /api/security/tenants/:tenantId/secrets/:secretId`. */
export interface FridayDeleteSecretResponse {
  readonly secret: FridaySecretDto;
}

/** Path parameters for `POST /api/security/tenants/:tenantId/secrets/:secretId/rotate`. */
export interface FridayRotateSecretParams {
  readonly tenantId: UUID;
  readonly secretId: UUID;
}

/** Request body for `POST /api/security/tenants/:tenantId/secrets/:secretId/rotate`. */
export interface FridayRotateSecretRequest {
  /** New plaintext value for the rotated secret (encrypted before storage). */
  readonly newValue: string;
  /** Grace period in seconds before old version is retired. @default 3600 */
  readonly gracePeriodSeconds?: number;
  readonly etag: string;
  readonly idempotencyKey: string;
}

/** Response body for `POST /api/security/tenants/:tenantId/secrets/:secretId/rotate`. */
export interface FridayRotateSecretResponse {
  readonly secret: FridaySecretDto;
  readonly rotation: FridaySecretRotationDto;
}

/** Path parameters for `GET /api/security/tenants/:tenantId/secrets/:secretId/access-log`. */
export interface FridayListSecretAccessLogParams {
  readonly tenantId: UUID;
  readonly secretId: UUID;
}

/** Query parameters for `GET /api/security/tenants/:tenantId/secrets/:secretId/access-log`. */
export interface FridayListSecretAccessLogQuery extends FridaySecurityPaginationQuery {
  readonly principalId?: string;
  readonly action?: FridaySecretAccessAction;
  readonly granted?: boolean;
  readonly after?: ISODateTime;
  readonly before?: ISODateTime;
}

/** Response body for `GET /api/security/tenants/:tenantId/secrets/:secretId/access-log`. */
export interface FridayListSecretAccessLogResponse extends FridaySecurityPage<FridaySecretAccessLogDto> {}

// ═══════════════════════════════════════════════════════════════════════
// POLICY CRUD + EVALUATION (SEC-FIX-06: dedicated input DTOs)
// ═══════════════════════════════════════════════════════════════════════

/** Request body for `POST /api/security/tenants/:tenantId/policies`. */
export interface FridayCreatePolicyRequest {
  readonly name: string;
  readonly description?: string;
  readonly priority?: number;
  /** Discriminated scope union (SEC-FIX-R2-03). Defaults to tenant scope. */
  readonly scope?: FridayPolicyScopeDto;
  readonly rules: readonly FridayCreatePolicyRuleInput[];
  readonly idempotencyKey: string;
}

/** Response body for `POST /api/security/tenants/:tenantId/policies`. */
export interface FridayCreatePolicyResponse {
  readonly policy: FridaySecurityPolicyDto;
}

/** Query parameters for `GET /api/security/tenants/:tenantId/policies`. */
export interface FridayListPoliciesQuery extends FridaySecurityPaginationQuery {
  readonly enabled?: boolean;
  readonly sortBy?: "name" | "priority" | "createdAt" | "updatedAt";
  readonly sortDir?: "asc" | "desc";
}

/** Response body for `GET /api/security/tenants/:tenantId/policies`. */
export interface FridayListPoliciesResponse extends FridaySecurityPage<FridaySecurityPolicySummaryDto> {}

/** Path parameters for `GET /api/security/tenants/:tenantId/policies/:policyId`. */
export interface FridayGetPolicyParams {
  readonly tenantId: UUID;
  readonly policyId: UUID;
}

/** Response body for `GET /api/security/tenants/:tenantId/policies/:policyId`. */
export interface FridayGetPolicyResponse {
  readonly policy: FridaySecurityPolicyDto;
}

/** Path parameters for `PATCH /api/security/tenants/:tenantId/policies/:policyId`. */
export interface FridayUpdatePolicyParams {
  readonly tenantId: UUID;
  readonly policyId: UUID;
}

/** Request body for `PATCH /api/security/tenants/:tenantId/policies/:policyId`. */
export interface FridayUpdatePolicyRequest {
  readonly name?: string;
  readonly description?: string;
  readonly enabled?: boolean;
  readonly priority?: number;
  readonly rules?: readonly FridayUpdatePolicyRuleInput[];
  readonly etag: string;
  readonly idempotencyKey: string;
}

/** Response body for `PATCH /api/security/tenants/:tenantId/policies/:policyId`. */
export interface FridayUpdatePolicyResponse {
  readonly policy: FridaySecurityPolicyDto;
}

/** Path parameters for `DELETE /api/security/tenants/:tenantId/policies/:policyId`. */
export interface FridayDeletePolicyParams {
  readonly tenantId: UUID;
  readonly policyId: UUID;
}

/** Request body for `DELETE /api/security/tenants/:tenantId/policies/:policyId`. */
export interface FridayDeletePolicyRequest {
  readonly etag: string;
  readonly idempotencyKey: string;
}

/** Response body for `DELETE /api/security/tenants/:tenantId/policies/:policyId`. */
export interface FridayDeletePolicyResponse {
  readonly policy: FridaySecurityPolicyDto;
}

/** Request body for `POST /api/security/tenants/:tenantId/policies/evaluate`. */
export interface FridayEvaluatePolicyRequest {
  readonly principalId: string;
  readonly resource: FridaySecurityResourceType;
  readonly action: FridaySecurityActionType;
  readonly resourceId?: string;
  readonly workspaceId?: UUID;
  readonly metadata?: Readonly<Record<string, string>>;
  /** Idempotency key (SEC-FIX-R4-02). Required because evaluate has audit write side effects. */
  readonly idempotencyKey: string;
}

/** Response body for `POST /api/security/tenants/:tenantId/policies/evaluate`. */
export interface FridayEvaluatePolicyResponse {
  readonly evaluation: FridayPolicyEvaluationDto;
}

// ═══════════════════════════════════════════════════════════════════════
// SECURITY AUDIT LOG QUERIES
// ═══════════════════════════════════════════════════════════════════════

/** Query parameters for `GET /api/security/tenants/:tenantId/audit-log`. */
export interface FridayListAuditLogQuery extends FridaySecurityPaginationQuery {
  readonly principalId?: string;
  readonly action?: string;
  readonly resourceType?: FridaySecurityResourceType;
  readonly decision?: FridaySecurityAuditDecision;
  readonly after?: ISODateTime;
  readonly before?: ISODateTime;
  readonly sortDir?: "asc" | "desc";
}

/** Response body for `GET /api/security/tenants/:tenantId/audit-log`. */
export interface FridayListAuditLogResponse extends FridaySecurityPage<FridaySecurityAuditEntryDto> {}

/** Query parameters for `GET /api/security/tenants/:tenantId/violations`. */
export interface FridayListViolationsQuery extends FridaySecurityPaginationQuery {
  readonly principalId?: string;
  readonly violationType?: FridaySecurityViolationType;
  readonly severity?: FridaySecurityViolationSeverity;
  readonly resolved?: boolean;
  readonly after?: ISODateTime;
  readonly before?: ISODateTime;
  readonly sortBy?: "severity" | "createdAt";
  readonly sortDir?: "asc" | "desc";
}

/** Response body for `GET /api/security/tenants/:tenantId/violations`. */
export interface FridayListViolationsResponse extends FridaySecurityPage<FridaySecurityViolationDto> {}

/** Path parameters for `POST /api/security/tenants/:tenantId/violations/:violationId/resolve`. */
export interface FridayResolveViolationParams {
  readonly tenantId: UUID;
  readonly violationId: UUID;
}

/** Request body for `POST /api/security/tenants/:tenantId/violations/:violationId/resolve`. */
export interface FridayResolveViolationRequest {
  readonly idempotencyKey: string;
}

/** Response body for `POST /api/security/tenants/:tenantId/violations/:violationId/resolve`. */
export interface FridayResolveViolationResponse {
  readonly violation: FridaySecurityViolationDto;
}

/**
 * Multi-Tenant Security and Permissions — Domain Model and Data Contract.
 *
 * Canonical types for the Friday Multi-Tenant Security system: tenants,
 * workspaces, RBAC roles/permissions, security policies, scoped secrets,
 * audit entries, violations, and persistence schema types.
 *
 * @module security/multi-tenant/model
 */

// ─── Foundational Value Types (local; mirrors rules/packaging pattern) ───

/** UUID string identifier. */
export type UUID = string;

/** ISO 8601 date-time string. */
export type ISODateTime = string;

/** JSON-safe primitive value. */
export type JsonPrimitive = string | number | boolean | null;

/** Recursive JSON-safe value. */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

/** JSON-safe object. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

// ═══════════════════════════════════════════════════════════════════════
// TENANT
// ═══════════════════════════════════════════════════════════════════════

/** Possible lifecycle states for a tenant. */
export const FRIDAY_TENANT_STATUSES = [
  "provisioning",
  "active",
  "suspended",
  "deactivated",
] as const;

/** Tenant lifecycle status. */
export type FridayTenantStatus = (typeof FRIDAY_TENANT_STATUSES)[number];

/** Tenant-level configuration limits and feature flags. */
export interface FridayTenantConfig {
  /** Maximum number of workspaces allowed. @default 50 */
  readonly maxWorkspaces: number;
  /** Maximum number of members across all workspaces. @default 500 */
  readonly maxMembers: number;
  /** Maximum number of secrets per workspace. @default 200 */
  readonly maxSecretsPerWorkspace: number;
  /** Audit log retention in days. @default 90 */
  readonly auditRetentionDays: number;
  /** Feature flags (arbitrary key-value). */
  readonly featureFlags: Readonly<Record<string, boolean>>;
}

/** Default tenant configuration values. */
export const FRIDAY_TENANT_CONFIG_DEFAULTS: FridayTenantConfig = {
  maxWorkspaces: 50,
  maxMembers: 500,
  maxSecretsPerWorkspace: 200,
  auditRetentionDays: 90,
  featureFlags: {},
} as const;

/** A tenant — the top-level isolation boundary. */
export interface FridayTenant {
  /** Unique tenant identifier. */
  readonly id: UUID;
  /** Human-readable display name. */
  readonly name: string;
  /** URL-safe unique slug. */
  readonly slug: string;
  /** Lifecycle status. */
  readonly status: FridayTenantStatus;
  /** Tenant configuration. */
  readonly config: FridayTenantConfig;
  /** Optimistic concurrency token. */
  readonly etag: string;
  /** When this tenant was created. */
  readonly createdAt: ISODateTime;
  /** When this tenant was last updated. */
  readonly updatedAt: ISODateTime;
  /** Soft-delete timestamp. */
  readonly deletedAt?: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// WORKSPACE
// ═══════════════════════════════════════════════════════════════════════

/** Possible lifecycle states for a workspace. */
export const FRIDAY_WORKSPACE_STATUSES = [
  "active",
  "archived",
  "suspended",
] as const;

/** Workspace lifecycle status. */
export type FridayWorkspaceStatus = (typeof FRIDAY_WORKSPACE_STATUSES)[number];

/** A workspace — a subdivision within a tenant for project/environment isolation. */
export interface FridayWorkspace {
  /** Unique workspace identifier. */
  readonly id: UUID;
  /** Parent tenant identifier. */
  readonly tenantId: UUID;
  /** Human-readable name. */
  readonly name: string;
  /** URL-safe slug, unique within the tenant. */
  readonly slug: string;
  /** Lifecycle status. */
  readonly status: FridayWorkspaceStatus;
  /** Workspace-specific configuration overrides (JSON blob). */
  readonly config: JsonObject;
  /** Optimistic concurrency token. */
  readonly etag: string;
  /** When this workspace was created. */
  readonly createdAt: ISODateTime;
  /** When this workspace was last updated. */
  readonly updatedAt: ISODateTime;
  /** Soft-delete timestamp. */
  readonly deletedAt?: ISODateTime;
}

/** A workspace membership — binds a principal to a workspace with a role. */
export interface FridayWorkspaceMembership {
  /** Unique membership record identifier. */
  readonly id: UUID;
  /** Workspace this membership belongs to. */
  readonly workspaceId: UUID;
  /** Tenant this membership belongs to (denormalized for query scoping). */
  readonly tenantId: UUID;
  /** Principal identifier (user, service account, agent). */
  readonly principalId: string;
  /** Role assigned to the principal in this workspace. */
  readonly roleId: UUID;
  /** Principal who granted this membership. */
  readonly grantedBy: string;
  /** When this membership was granted. */
  readonly grantedAt: ISODateTime;
  /** When this membership expires (null for no expiry). */
  readonly expiresAt?: ISODateTime;
  /** When this membership was revoked (null if active). */
  readonly revokedAt?: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// RBAC — ROLES, PERMISSIONS, SCOPES, ASSIGNMENTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Scope levels for fine-grained permissions.
 *
 * Uses `system` (not `global`) to match the RBAC hierarchy:
 * system → tenant → workspace → resource.
 */
export const FRIDAY_PERMISSION_SCOPE_TYPES = [
  "system",
  "tenant",
  "workspace",
  "resource",
] as const;

/** Permission scope level. */
export type FridayPermissionScope = (typeof FRIDAY_PERMISSION_SCOPE_TYPES)[number];

/**
 * Scope levels for role assignments.
 *
 * Role assignments use the RBAC hierarchy: system → tenant → workspace.
 * This is intentionally separate from `FridayPermissionScope` because
 * role assignments cannot be scoped to individual resources — they are
 * always at a hierarchy level.
 */
export const FRIDAY_ROLE_ASSIGNMENT_SCOPE_TYPES = [
  "system",
  "tenant",
  "workspace",
] as const;

/** Role assignment scope type union. */
export type FridayRoleAssignmentScope = (typeof FRIDAY_ROLE_ASSIGNMENT_SCOPE_TYPES)[number];

/** Security resource types that permissions can target. */
export const FRIDAY_SECURITY_RESOURCE_TYPES = [
  "tenant",
  "workspace",
  "secret",
  "role",
  "policy",
  "membership",
  "audit",
  "rule",
  "skill",
  "workflow",
  "agent",
  "package",
] as const;

/** Security resource type union. */
export type FridaySecurityResourceType = (typeof FRIDAY_SECURITY_RESOURCE_TYPES)[number];

/**
 * Canonical permission verb set (SEC-FIX-07).
 *
 * Aligned with `FridayScope` naming: `read`, `write`, `delete`, `admin`
 * as the core CRUD verbs, plus domain-specific actions for security operations.
 */
export const FRIDAY_SECURITY_ACTION_TYPES = [
  "read",
  "write",
  "delete",
  "admin",
  "list",
  "assign",
  "revoke",
  "rotate",
  "execute",
] as const;

/** Security action type union. */
export type FridaySecurityActionType = (typeof FRIDAY_SECURITY_ACTION_TYPES)[number];

/**
 * Mapping between security permission verbs and `FridayScope` tokens.
 *
 * Provides an explicit bridge between the multi-tenant permission model
 * and the existing `FridayScope`-based auth system in `src/api/model/`.
 *
 * Keys are `<resource>.<verb>` from the security model; values are the
 * corresponding `FridayScope` string (or `null` when no direct mapping exists).
 */
export interface FridaySecurityToScopeMapping {
  readonly resource: FridaySecurityResourceType;
  readonly action: FridaySecurityActionType;
  /** Corresponding `FridayScope` value, or `null` if no 1:1 mapping exists. */
  readonly fridayScope: string | null;
}

/**
 * Canonical mapping table from security permissions to `FridayScope`.
 *
 * Covers the primary resource/action pairs used at the API layer.
 */
export const FRIDAY_SECURITY_SCOPE_MAPPINGS: readonly FridaySecurityToScopeMapping[] = [
  // Secrets
  { resource: "secret", action: "read", fridayScope: "secrets.read" },
  { resource: "secret", action: "list", fridayScope: "secrets.read" },
  { resource: "secret", action: "write", fridayScope: "secrets.write" },
  { resource: "secret", action: "delete", fridayScope: "secrets.write" },
  { resource: "secret", action: "rotate", fridayScope: "secrets.write" },
  // Roles
  { resource: "role", action: "read", fridayScope: "security.read" },
  { resource: "role", action: "list", fridayScope: "security.read" },
  { resource: "role", action: "write", fridayScope: "security.write" },
  { resource: "role", action: "assign", fridayScope: "security.write" },
  { resource: "role", action: "revoke", fridayScope: "security.write" },
  // Policies
  { resource: "policy", action: "read", fridayScope: "security.read" },
  { resource: "policy", action: "list", fridayScope: "security.read" },
  { resource: "policy", action: "write", fridayScope: "security.write" },
  { resource: "policy", action: "execute", fridayScope: "security.write" },
  // Workspaces
  { resource: "workspace", action: "read", fridayScope: "security.read" },
  { resource: "workspace", action: "list", fridayScope: "security.read" },
  { resource: "workspace", action: "write", fridayScope: "security.write" },
  { resource: "workspace", action: "delete", fridayScope: "security.write" },
  // Tenants
  { resource: "tenant", action: "read", fridayScope: "security.read" },
  { resource: "tenant", action: "list", fridayScope: "security.read" },
  { resource: "tenant", action: "write", fridayScope: "security.write" },
  { resource: "tenant", action: "admin", fridayScope: "hub.tenantAdmin" },
  // Audit
  { resource: "audit", action: "read", fridayScope: "security.read" },
  { resource: "audit", action: "list", fridayScope: "security.read" },
  // Memberships
  { resource: "membership", action: "read", fridayScope: "security.read" },
  { resource: "membership", action: "list", fridayScope: "security.read" },
  { resource: "membership", action: "write", fridayScope: "security.write" },
  // Agents, Skills, Workflows, Packages — cross-domain mappings
  { resource: "agent", action: "read", fridayScope: "agent.read" },
  { resource: "agent", action: "write", fridayScope: "agent.write" },
  { resource: "agent", action: "execute", fridayScope: "agent.run" },
  { resource: "skill", action: "read", fridayScope: "skill.read" },
  { resource: "skill", action: "write", fridayScope: "skill.write" },
  { resource: "workflow", action: "read", fridayScope: "workflow.read" },
  { resource: "workflow", action: "write", fridayScope: "workflow.write" },
  { resource: "workflow", action: "execute", fridayScope: "workflow.run" },
  { resource: "rule", action: "read", fridayScope: "security.read" },
  { resource: "rule", action: "list", fridayScope: "security.read" },
  { resource: "rule", action: "write", fridayScope: "security.write" },
  { resource: "skill", action: "list", fridayScope: "security.read" },
  { resource: "workflow", action: "list", fridayScope: "security.read" },
  { resource: "agent", action: "list", fridayScope: "security.read" },
  { resource: "package", action: "read", fridayScope: "plugin.read" },
  { resource: "package", action: "list", fridayScope: "security.read" },
  { resource: "package", action: "write", fridayScope: "plugin.write" },
] as const;

/**
 * A permission — a fine-grained action on a resource type.
 *
 * Format: `<resource>:<action>` (e.g., `secret:read`, `workspace:write`).
 */
export interface FridayPermission {
  /** Unique permission identifier. */
  readonly id: UUID;
  /** Resource type this permission applies to. */
  readonly resource: FridaySecurityResourceType;
  /** Action this permission gates. */
  readonly action: FridaySecurityActionType;
  /** Human-readable description. */
  readonly description: string;
}

/** Role scope levels (which scope a role can be assigned at). */
export const FRIDAY_ROLE_SCOPE_TYPES = [
  "system",
  "tenant",
  "workspace",
] as const;

/** Role scope type union. */
export type FridayRoleScopeType = (typeof FRIDAY_ROLE_SCOPE_TYPES)[number];

/**
 * Canonical hierarchical RBAC role levels.
 *
 * Ordered from least to most privileged:
 * viewer < member < workspace_admin < tenant_admin < superadmin
 */
export const FRIDAY_ROLE_HIERARCHY = [
  "viewer",
  "member",
  "workspace_admin",
  "tenant_admin",
  "superadmin",
] as const;

/** Hierarchical RBAC role level union. */
export type FridayRoleHierarchyLevel = (typeof FRIDAY_ROLE_HIERARCHY)[number];

/**
 * Rank map for hierarchical RBAC role comparisons.
 *
 * Higher numbers indicate stronger privilege.
 */
export const FRIDAY_ROLE_HIERARCHY_RANK_MAP: Readonly<
  Record<FridayRoleHierarchyLevel, number>
> = {
  viewer: 0,
  member: 1,
  workspace_admin: 2,
  tenant_admin: 3,
  superadmin: 4,
} as const;

/** A role — a named collection of permissions assignable at a scope level. */
export interface FridayRole {
  /** Unique role identifier. */
  readonly id: UUID;
  /** Tenant this role belongs to (null for system roles). */
  readonly tenantId: UUID | null;
  /** Human-readable role name (e.g., `tenant:admin`, `workspace:viewer`). */
  readonly name: string;
  /** Optional description. */
  readonly description?: string;
  /** Scope level at which this role can be assigned. */
  readonly scopeType: FridayRoleScopeType;
  /** Whether this is a built-in system role. */
  readonly isSystem: boolean;
  /** Permissions granted by this role. */
  readonly permissions: readonly FridayPermission[];
  /** Optimistic concurrency token. */
  readonly etag: string;
  /** When this role was created. */
  readonly createdAt: ISODateTime;
  /** When this role was last updated. */
  readonly updatedAt: ISODateTime;
  /** Soft-delete timestamp. */
  readonly deletedAt?: ISODateTime;
}

// ─── Role Assignment Scope (discriminated union — SEC-FIX-04) ───

/** A role assignment scoped to the entire system. */
export interface FridayRoleAssignmentScopeSystem {
  readonly scopeType: "system";
}

/** A role assignment scoped to a specific tenant. */
export interface FridayRoleAssignmentScopeTenant {
  readonly scopeType: "tenant";
  readonly tenantId: UUID;
}

/** A role assignment scoped to a specific workspace within a tenant. */
export interface FridayRoleAssignmentScopeWorkspace {
  readonly scopeType: "workspace";
  readonly tenantId: UUID;
  readonly workspaceId: UUID;
}

/** Discriminated union of role assignment scopes. */
export type FridayRoleAssignmentScopeUnion =
  | FridayRoleAssignmentScopeSystem
  | FridayRoleAssignmentScopeTenant
  | FridayRoleAssignmentScopeWorkspace;

/** A role assignment — binds a principal to a role within a scope. */
export interface FridayRoleAssignment {
  /** Unique assignment identifier. */
  readonly id: UUID;
  /** Tenant context (null for system-scope assignments). */
  readonly tenantId: UUID | null;
  /** Principal this role is assigned to. */
  readonly principalId: string;
  /** Role being assigned. */
  readonly roleId: UUID;
  /** Scope of this assignment (discriminated union). */
  readonly scope: FridayRoleAssignmentScopeUnion;
  /** Principal who granted this assignment. */
  readonly grantedBy: string;
  /** When this assignment was granted. */
  readonly grantedAt: ISODateTime;
  /** When this assignment expires (null for no expiry). */
  readonly expiresAt?: ISODateTime;
  /** When this assignment was revoked (null if active). */
  readonly revokedAt?: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// SECURITY POLICIES
// ═══════════════════════════════════════════════════════════════════════

/** Policy effect — the outcome when a policy rule matches. */
export const FRIDAY_POLICY_EFFECTS = [
  "allow",
  "deny",
  "warn",
  "audit",
] as const;

/** Policy effect type union. */
export type FridayPolicyEffect = (typeof FRIDAY_POLICY_EFFECTS)[number];

// ─── Policy Conditions (mirroring Rules Engine discriminated pattern — SEC-FIX-05) ───

/**
 * Operators available for policy condition evaluation.
 * Mirrors `FridayRuleConditionOperator` from the Rules Engine.
 */
export type FridayPolicyConditionOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "matches"
  | "in"
  | "not_in"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "not_exists";

/** Operators that test for field presence only (no value needed). */
export type FridayPolicyPresenceOperator = "exists" | "not_exists";

/** Operators that compare a field against a value. */
export type FridayPolicyValueOperator = Exclude<FridayPolicyConditionOperator, FridayPolicyPresenceOperator>;

/** A condition that compares a field against a value (requires operator + value). */
export interface FridayPolicyValueCondition {
  /** Field path to evaluate (e.g., `principalRole`, `secretScope`, `workspaceId`). */
  readonly field: string;
  /** Comparison operator. */
  readonly operator: FridayPolicyValueOperator;
  /** Value to compare against. */
  readonly value: JsonValue;
}

/** A condition that checks field presence only (no value). */
export interface FridayPolicyPresenceCondition {
  /** Field path to check for presence. */
  readonly field: string;
  /** Presence operator. */
  readonly operator: FridayPolicyPresenceOperator;
  /** Never set for presence conditions. */
  readonly value?: never;
}

/**
 * A single condition within a policy rule.
 * Discriminated by operator type: presence conditions (exists/not_exists)
 * never have a value; value conditions always require one.
 */
export type FridayPolicyCondition = FridayPolicyValueCondition | FridayPolicyPresenceCondition;

/** Logical grouping of policy conditions. */
export interface FridayPolicyConditionGroup {
  /** All conditions must match (AND). */
  readonly all?: readonly FridayPolicyCondition[];
  /** At least one condition must match (OR). */
  readonly any?: readonly FridayPolicyCondition[];
  /** No condition may match (NOT ANY). */
  readonly none?: readonly FridayPolicyCondition[];
}

// ─── Policy Scope (discriminated union — SEC-FIX-04) ───

/** A policy scoped to a tenant. */
export interface FridayPolicyScopeTenant {
  readonly scopeType: "tenant";
  readonly tenantId: UUID;
}

/** A policy scoped to a specific workspace. */
export interface FridayPolicyScopeWorkspace {
  readonly scopeType: "workspace";
  readonly tenantId: UUID;
  readonly workspaceId: UUID;
}

/** Discriminated union of policy scopes. */
export type FridayPolicyScopeUnion =
  | FridayPolicyScopeTenant
  | FridayPolicyScopeWorkspace;

/** A single rule within a security policy. */
export interface FridayPolicyRule {
  /** Unique rule identifier within the policy. */
  readonly id: UUID;
  /** Human-readable rule name. */
  readonly name: string;
  /** Optional description. */
  readonly description?: string;
  /** Whether this rule is actively evaluated. */
  readonly enabled: boolean;
  /** Security resource type this rule applies to. */
  readonly resource: FridaySecurityResourceType;
  /** Security action this rule gates. */
  readonly action: FridaySecurityActionType;
  /** Conditions that must be met for this rule to match. */
  readonly conditions: FridayPolicyConditionGroup;
  /** Effect when the rule matches. */
  readonly effect: FridayPolicyEffect;
  /** Human-readable message included in the evaluation result. */
  readonly message?: string;
  /** Rule priority within its policy. Lower number = higher priority. @default 100 */
  readonly priority: number;
}

/** A security policy — a collection of rules governing access within a scope. */
export interface FridaySecurityPolicy {
  /** Unique policy identifier. */
  readonly id: UUID;
  /** Tenant this policy belongs to. */
  readonly tenantId: UUID;
  /** Human-readable policy name. */
  readonly name: string;
  /** Optional description. */
  readonly description?: string;
  /** Whether this policy is actively evaluated. */
  readonly enabled: boolean;
  /** Policy priority. Lower number = higher priority. @default 100 */
  readonly priority: number;
  /** Scope of this policy (discriminated union). */
  readonly scope: FridayPolicyScopeUnion;
  /** Rules within this policy. */
  readonly rules: readonly FridayPolicyRule[];
  /** Policy version (incremented on update). */
  readonly version: number;
  /** Optimistic concurrency token. */
  readonly etag: string;
  /** When this policy was created. */
  readonly createdAt: ISODateTime;
  /** When this policy was last updated. */
  readonly updatedAt: ISODateTime;
  /** Soft-delete timestamp. */
  readonly deletedAt?: ISODateTime;
}

/** The final decision of a policy evaluation. */
export const FRIDAY_POLICY_DECISIONS = [
  "allow",
  "deny",
] as const;

/** Policy decision type union. */
export type FridayPolicyDecision = (typeof FRIDAY_POLICY_DECISIONS)[number];

/** A matched policy rule reference within an evaluation result. */
export interface FridayMatchedPolicyRule {
  /** Rule identifier. */
  readonly ruleId: UUID;
  /** Rule name. */
  readonly ruleName: string;
  /** Policy identifier containing the rule. */
  readonly policyId: UUID;
  /** Effect from the matched rule. */
  readonly effect: FridayPolicyEffect;
  /** Message from the matched rule. */
  readonly message?: string;
  /** Rule priority. */
  readonly priority: number;
}

/** The result of evaluating a request against security policies. */
export interface FridayPolicyEvaluation {
  /** Unique evaluation identifier for audit correlation. */
  readonly evaluationId: UUID;
  /** Final decision (deny wins over allow). */
  readonly decision: FridayPolicyDecision;
  /** All rules that matched the evaluation context. */
  readonly matchedRules: readonly FridayMatchedPolicyRule[];
  /** Message from the highest-priority matched rule. */
  readonly message?: string;
  /** Evaluation duration in milliseconds. */
  readonly durationMs: number;
  /** Whether execution should proceed (true for allow, false for deny). */
  readonly allowed: boolean;
  /** Tenant context. */
  readonly tenantId: UUID;
  /** Principal context. */
  readonly principalId: string;
  /** Resource type being accessed. */
  readonly resource: FridaySecurityResourceType;
  /** Action being performed. */
  readonly action: FridaySecurityActionType;
  /** Timestamp of the evaluation. */
  readonly evaluatedAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// SECRETS
// ═══════════════════════════════════════════════════════════════════════

/** Scope levels for secret access. */
export const FRIDAY_SECRET_SCOPE_TYPES = [
  "tenant",
  "workspace",
  "resource",
] as const;

/** Secret scope type union (string literal, not the discriminated union). */
export type FridaySecretScopeType = (typeof FRIDAY_SECRET_SCOPE_TYPES)[number];

// ─── Secret Scope (discriminated union — SEC-FIX-04) ───

/** A secret scoped to the tenant level. */
export interface FridaySecretScopeTenant {
  readonly scopeType: "tenant";
  readonly tenantId: UUID;
}

/** A secret scoped to a workspace. */
export interface FridaySecretScopeWorkspace {
  readonly scopeType: "workspace";
  readonly tenantId: UUID;
  readonly workspaceId: UUID;
}

/** A secret scoped to a specific resource. */
export interface FridaySecretScopeResource {
  readonly scopeType: "resource";
  readonly tenantId: UUID;
  readonly workspaceId: UUID;
  readonly resourceId: string;
}

/** Discriminated union of secret scopes. */
export type FridaySecretScope =
  | FridaySecretScopeTenant
  | FridaySecretScopeWorkspace
  | FridaySecretScopeResource;

/** Secret rotation lifecycle states. */
export const FRIDAY_SECRET_ROTATION_STATES = [
  "pending_rotation",
  "pending",
  "active",
  "rotating",
  "rotated",
  "retired",
] as const;

/** Secret rotation state union. */
export type FridaySecretRotationState = (typeof FRIDAY_SECRET_ROTATION_STATES)[number];

/**
 * Valid state transitions for the secret rotation state machine.
 */
export const FRIDAY_SECRET_ROTATION_TRANSITIONS: Readonly<
  Record<FridaySecretRotationState, readonly FridaySecretRotationState[]>
> = {
  pending_rotation: ["active"],
  pending: ["active"],
  active: ["rotating"],
  rotating: ["rotated"],
  rotated: ["retired", "active"],
  retired: [],
} as const;

/** A secret entry — an encrypted credential stored in the scoped credential store. */
export interface FridaySecretEntry {
  /** Unique secret identifier. */
  readonly id: UUID;
  /** Scope of this secret (discriminated union). */
  readonly scope: FridaySecretScope;
  /** Human-readable secret name. */
  readonly name: string;
  /** Optional description. */
  readonly description?: string;
  /**
   * Encrypted secret value.
   * Format: `iv:ciphertext:authTag` (base64-encoded).
   * Never exposed in API responses — decryption happens in the secret store service.
   */
  readonly encryptedValue: string;
  /** Identifier of the encryption key used. */
  readonly encryptionKeyId: string;
  /** Secret version (incremented on rotation). */
  readonly version: number;
  /** Current rotation state. */
  readonly rotationState: FridaySecretRotationState;
  /** When this secret expires (null for no expiry). */
  readonly expiresAt?: ISODateTime;
  /** When this secret was last rotated. */
  readonly rotatedAt?: ISODateTime;
  /** Optimistic concurrency token. */
  readonly etag: string;
  /** When this secret was created. */
  readonly createdAt: ISODateTime;
  /** When this secret was last updated. */
  readonly updatedAt: ISODateTime;
  /** Soft-delete timestamp. */
  readonly deletedAt?: ISODateTime;
}

/** A rotation record for a secret. */
export interface FridaySecretRotation {
  /** Unique rotation record identifier. */
  readonly id: UUID;
  /** Secret being rotated. */
  readonly secretId: UUID;
  /** Tenant context. */
  readonly tenantId: UUID;
  /** Version rotated from. */
  readonly fromVersion: number;
  /** Version rotated to. */
  readonly toVersion: number;
  /** Principal who initiated the rotation. */
  readonly initiatedBy: string;
  /** Current rotation state. */
  readonly state: FridaySecretRotationState;
  /** Grace period in seconds before old version is retired. */
  readonly gracePeriodSeconds: number;
  /** Error message if rotation failed. */
  readonly errorMessage?: string;
  /** When rotation started. */
  readonly startedAt: ISODateTime;
  /** When rotation completed (or failed). */
  readonly completedAt?: ISODateTime;
}

/** Secret access actions. */
export const FRIDAY_SECRET_ACCESS_ACTIONS = [
  "read",
  "list",
  "write",
  "delete",
  "rotate",
] as const;

/** Secret access action type union. */
export type FridaySecretAccessAction = (typeof FRIDAY_SECRET_ACCESS_ACTIONS)[number];

/** An access log entry for a secret. */
export interface FridaySecretAccessLog {
  /** Unique log entry identifier. */
  readonly id: UUID;
  /** Secret that was accessed. */
  readonly secretId: UUID;
  /** Tenant context. */
  readonly tenantId: UUID;
  /** Principal who accessed the secret. */
  readonly principalId: string;
  /** Access action performed. */
  readonly action: FridaySecretAccessAction;
  /** Whether access was granted. */
  readonly granted: boolean;
  /** Correlation to the policy evaluation that authorized/denied access. */
  readonly policyEvaluationId?: UUID;
  /** IP address of the accessor. */
  readonly ipAddress?: string;
  /** User agent string. */
  readonly userAgent?: string;
  /** When the access occurred. */
  readonly accessedAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// AUDIT
// ═══════════════════════════════════════════════════════════════════════

/** Security audit decision values. */
export const FRIDAY_SECURITY_AUDIT_DECISIONS = [
  "allow",
  "deny",
  "warn",
  "error",
] as const;

/** Security audit decision type union. */
export type FridaySecurityAuditDecision = (typeof FRIDAY_SECURITY_AUDIT_DECISIONS)[number];

/** A structured audit entry for security events. */
export interface FridaySecurityAuditEntry {
  /** Unique audit entry identifier. */
  readonly id: UUID;
  /** Tenant context (null for system-scope events). */
  readonly tenantId: UUID | null;
  /** Principal who triggered the event. */
  readonly principalId?: string;
  /** Action that was audited. */
  readonly action: string;
  /** Resource type affected. */
  readonly resourceType: FridaySecurityResourceType;
  /** Specific resource identifier. */
  readonly resourceId?: string;
  /** Security decision. */
  readonly decision: FridaySecurityAuditDecision;
  /** Human-readable reason for the decision. */
  readonly reason?: string;
  /** IP address of the requestor. */
  readonly ipAddress?: string;
  /** User agent string. */
  readonly userAgent?: string;
  /** Session identifier for correlation. */
  readonly sessionId?: string;
  /** Additional structured metadata. */
  readonly metadata: JsonObject;
  /** When this audit entry was created. */
  readonly createdAt: ISODateTime;
}

/** Security violation severity levels. */
export const FRIDAY_SECURITY_VIOLATION_SEVERITIES = [
  "low",
  "medium",
  "high",
  "critical",
] as const;

/** Security violation severity type union. */
export type FridaySecurityViolationSeverity =
  (typeof FRIDAY_SECURITY_VIOLATION_SEVERITIES)[number];

/** Security violation type identifiers. */
export const FRIDAY_SECURITY_VIOLATION_TYPES = [
  "cross_tenant_access",
  "escalation_attempt",
  "unauthorized_secret_access",
  "policy_bypass_attempt",
  "invalid_scope_access",
  "expired_credential_use",
  "brute_force_detected",
  "anomalous_access_pattern",
] as const;

/** Security violation type union. */
export type FridaySecurityViolationType =
  (typeof FRIDAY_SECURITY_VIOLATION_TYPES)[number];

/** A security violation record. */
export interface FridaySecurityViolation {
  /** Unique violation identifier. */
  readonly id: UUID;
  /** Tenant context. */
  readonly tenantId: UUID;
  /** Principal involved in the violation. */
  readonly principalId: string;
  /** Type of violation. */
  readonly violationType: FridaySecurityViolationType;
  /** Severity level. */
  readonly severity: FridaySecurityViolationSeverity;
  /** Human-readable description. */
  readonly description: string;
  /** Resource type targeted. */
  readonly resourceType?: FridaySecurityResourceType;
  /** Resource identifier targeted. */
  readonly resourceId?: string;
  /** Action that was attempted. */
  readonly actionAttempted?: string;
  /** IP address of the violator. */
  readonly ipAddress?: string;
  /** Whether this violation has been resolved. */
  readonly resolved: boolean;
  /** Principal who resolved the violation. */
  readonly resolvedBy?: string;
  /** When the violation was resolved. */
  readonly resolvedAt?: ISODateTime;
  /** Additional structured metadata. */
  readonly metadata: JsonObject;
  /** When this violation was recorded. */
  readonly createdAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// PERSISTENCE ROW TYPES (SQLite)
// ═══════════════════════════════════════════════════════════════════════

/** SQLite row shape for the `security_tenants` table. */
export interface FridayTenantRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly config_json: string;
  readonly etag: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

/** SQLite row shape for the `security_workspaces` table. */
export interface FridayWorkspaceRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly config_json: string;
  readonly etag: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

/** SQLite row shape for the `security_workspace_memberships` table. */
export interface FridayWorkspaceMembershipRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly role_id: string;
  readonly granted_by: string;
  readonly granted_at: string;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
}

/** SQLite row shape for the `security_roles` table. */
export interface FridayRoleRow {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly scope_type: string;
  readonly is_system: number;
  readonly permissions_json: string;
  readonly etag: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

/** SQLite row shape for the `security_role_assignments` table. */
export interface FridayRoleAssignmentRow {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly principal_id: string;
  readonly role_id: string;
  readonly scope_type: string;
  readonly scope_id: string | null;
  readonly granted_by: string;
  readonly granted_at: string;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
}

/** SQLite row shape for the `security_policies` table. */
export interface FridaySecurityPolicyRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly enabled: number;
  readonly priority: number;
  readonly scope_type: string;
  readonly scope_id: string | null;
  readonly rules_json: string;
  readonly version: number;
  readonly etag: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

/** SQLite row shape for the `security_secrets` table. */
export interface FridaySecretEntryRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly workspace_id: string | null;
  readonly resource_id: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly encrypted_value: string;
  readonly encryption_key_id: string;
  readonly scope_type: string;
  readonly version: number;
  readonly rotation_state: string;
  readonly expires_at: string | null;
  readonly rotated_at: string | null;
  readonly etag: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

/** SQLite row shape for the `security_secret_access_log` table. */
export interface FridaySecretAccessLogRow {
  readonly id: string;
  readonly secret_id: string;
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly action: string;
  readonly granted: number;
  readonly policy_evaluation_id: string | null;
  readonly ip_address: string | null;
  readonly user_agent: string | null;
  readonly accessed_at: string;
}

/** SQLite row shape for the `security_audit_log` table. */
export interface FridaySecurityAuditEntryRow {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly principal_id: string | null;
  readonly action: string;
  readonly resource_type: string;
  readonly resource_id: string | null;
  readonly decision: string;
  readonly reason: string | null;
  readonly ip_address: string | null;
  readonly user_agent: string | null;
  readonly session_id: string | null;
  readonly metadata_json: string;
  readonly created_at: string;
}

/** SQLite row shape for the `security_violations` table. */
export interface FridaySecurityViolationRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly violation_type: string;
  readonly severity: string;
  readonly description: string;
  readonly resource_type: string | null;
  readonly resource_id: string | null;
  readonly action_attempted: string | null;
  readonly ip_address: string | null;
  readonly resolved: number;
  readonly resolved_by: string | null;
  readonly resolved_at: string | null;
  readonly metadata_json: string;
  readonly created_at: string;
}

// ═══════════════════════════════════════════════════════════════════════
// ROLE-SCOPE COMPATIBILITY ENFORCEMENT (SEC-FIX-R5-03)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Defines the set of assignment scopes that are valid for a given role scope.
 *
 * - Workspace-assignable roles (`scopeType: 'workspace'`) can only be assigned at workspace scope.
 * - Tenant-assignable roles (`scopeType: 'tenant'`) can only be assigned at tenant scope.
 * - System roles (`scopeType: 'system'`) can only be assigned at system scope via system-level endpoints.
 *
 * This mapping is the single source of truth for scope-role compatibility checks.
 */
export const FRIDAY_ROLE_SCOPE_COMPATIBLE_ASSIGNMENT_SCOPES: Readonly<
  Record<FridayRoleScopeType, readonly FridayRoleAssignmentScope[]>
> = {
  system: ["system"],
  tenant: ["tenant"],
  workspace: ["workspace"],
} as const;

/**
 * Describes a scope-role compatibility validation result.
 *
 * Used at role assignment boundaries to verify that the assignment scope
 * is compatible with the role's defined scope type before persisting.
 */
export interface FridayRoleScopeCompatibilityCheck {
  /** The role's declared assignable scope. */
  readonly roleScopeType: FridayRoleScopeType;
  /** The scope at which assignment is being attempted. */
  readonly assignmentScopeType: FridayRoleAssignmentScope;
  /** Whether the assignment scope is compatible with the role scope. */
  readonly compatible: boolean;
  /** Human-readable reason when incompatible. */
  readonly reason?: string;
}

/**
 * Validates that a role's scope type is compatible with the requested assignment scope.
 *
 * @returns A compatibility check result indicating whether the assignment is valid.
 */
export function validateRoleScopeCompatibility(
  roleScopeType: FridayRoleScopeType,
  assignmentScopeType: FridayRoleAssignmentScope,
): FridayRoleScopeCompatibilityCheck {
  const allowedScopes = FRIDAY_ROLE_SCOPE_COMPATIBLE_ASSIGNMENT_SCOPES[roleScopeType];
  const compatible = allowedScopes.includes(assignmentScopeType);
  return {
    roleScopeType,
    assignmentScopeType,
    compatible,
    reason: compatible
      ? undefined
      : `Role with scope '${roleScopeType}' cannot be assigned at '${assignmentScopeType}' scope. ` +
        `Allowed assignment scopes: [${allowedScopes.join(", ")}].`,
  };
}

// ─── Row-to-Entity Mapper Signature ───

/** Generic row-to-entity mapper function type. */
export type FridaySecurityRowMapper<TRow, TEntity> = (row: TRow) => TEntity;

// ─── Multi-Tenant Security and Permissions Domain Model ───

export {
  // Tenant
  FRIDAY_TENANT_STATUSES,
  FRIDAY_TENANT_CONFIG_DEFAULTS,

  // Workspace
  FRIDAY_WORKSPACE_STATUSES,

  // RBAC
  FRIDAY_PERMISSION_SCOPE_TYPES,
  FRIDAY_ROLE_ASSIGNMENT_SCOPE_TYPES,
  FRIDAY_SECURITY_RESOURCE_TYPES,
  FRIDAY_SECURITY_ACTION_TYPES,
  FRIDAY_SECURITY_SCOPE_MAPPINGS,
  FRIDAY_ROLE_SCOPE_TYPES,

  // Policy
  FRIDAY_POLICY_EFFECTS,
  FRIDAY_POLICY_DECISIONS,

  // Secrets
  FRIDAY_SECRET_SCOPE_TYPES,
  FRIDAY_SECRET_ROTATION_STATES,
  FRIDAY_SECRET_ROTATION_TRANSITIONS,
  FRIDAY_SECRET_ACCESS_ACTIONS,

  // Audit
  FRIDAY_SECURITY_AUDIT_DECISIONS,
  FRIDAY_SECURITY_VIOLATION_SEVERITIES,
  FRIDAY_SECURITY_VIOLATION_TYPES,
} from "./friday-multi-tenant-security.types.js";

export type {
  // Foundational value types
  UUID,
  ISODateTime,
  JsonPrimitive,
  JsonValue,
  JsonObject,

  // Tenant
  FridayTenantStatus,
  FridayTenantConfig,
  FridayTenant,

  // Workspace
  FridayWorkspaceStatus,
  FridayWorkspace,
  FridayWorkspaceMembership,

  // RBAC
  FridayPermissionScope,
  FridayRoleAssignmentScope,
  FridaySecurityResourceType,
  FridaySecurityActionType,
  FridaySecurityToScopeMapping,
  FridayPermission,
  FridayRoleScopeType,
  FridayRole,
  FridayRoleAssignmentScopeSystem,
  FridayRoleAssignmentScopeTenant,
  FridayRoleAssignmentScopeWorkspace,
  FridayRoleAssignmentScopeUnion,
  FridayRoleAssignment,

  // Policy
  FridayPolicyEffect,
  FridayPolicyConditionOperator,
  FridayPolicyPresenceOperator,
  FridayPolicyValueOperator,
  FridayPolicyValueCondition,
  FridayPolicyPresenceCondition,
  FridayPolicyCondition,
  FridayPolicyConditionGroup,
  FridayPolicyScopeTenant,
  FridayPolicyScopeWorkspace,
  FridayPolicyScopeUnion,
  FridayPolicyRule,
  FridaySecurityPolicy,
  FridayPolicyDecision,
  FridayMatchedPolicyRule,
  FridayPolicyEvaluation,

  // Secrets
  FridaySecretScopeType,
  FridaySecretScopeTenant,
  FridaySecretScopeWorkspace,
  FridaySecretScopeResource,
  FridaySecretScope,
  FridaySecretRotationState,
  FridaySecretEntry,
  FridaySecretRotation,
  FridaySecretAccessAction,
  FridaySecretAccessLog,

  // Audit
  FridaySecurityAuditDecision,
  FridaySecurityAuditEntry,
  FridaySecurityViolationSeverity,
  FridaySecurityViolationType,
  FridaySecurityViolation,

  // Persistence row types
  FridayTenantRow,
  FridayWorkspaceRow,
  FridayWorkspaceMembershipRow,
  FridayRoleRow,
  FridayRoleAssignmentRow,
  FridaySecurityPolicyRow,
  FridaySecretEntryRow,
  FridaySecretAccessLogRow,
  FridaySecurityAuditEntryRow,
  FridaySecurityViolationRow,
  FridaySecurityRowMapper,
} from "./friday-multi-tenant-security.types.js";

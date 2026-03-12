// ─── Multi-Tenant Security and Permissions API Contract ───

export {
  FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES,
  FRIDAY_SECURITY_IDEMPOTENCY_TTL_HOURS,
} from "./friday-multi-tenant-security-api.types.js";

export type {
  // Error codes
  FridayMultiTenantSecurityErrorCode,

  // Pagination
  FridaySecurityPaginationQuery,
  FridaySecurityPage,

  // Idempotency
  FridaySecurityIdempotencyContract,

  // ─── Tenant DTOs ───
  FridayTenantDto,
  FridayTenantSummaryDto,

  // ─── Workspace DTOs ───
  FridayWorkspaceDto,
  FridayWorkspaceSummaryDto,

  // ─── Membership DTOs ───
  FridayWorkspaceMembershipDto,

  // ─── Role DTOs ───
  FridayPermissionDto,
  FridayRoleDto,
  FridayRoleSummaryDto,

  // ─── Role Assignment DTOs ───
  FridayRoleAssignmentDto,

  // ─── Secret DTOs ───
  FridaySecretDto,
  FridaySecretSummaryDto,
  FridaySecretRotationDto,
  FridaySecretAccessLogDto,

  // ─── Policy DTOs ───
  FridayPolicyRuleDto,
  FridaySecurityPolicyDto,
  FridaySecurityPolicySummaryDto,
  FridayPolicyEvaluationDto,

  // ─── Audit DTOs ───
  FridaySecurityAuditEntryDto,
  FridaySecurityViolationDto,

  // ─── Input DTOs (SEC-FIX-06) ───
  FridayCreateRoleInput,
  FridayUpdateRoleInput,
  FridayCreatePolicyRuleInput,
  FridayUpdatePolicyRuleInput,
  FridayCreateSecretScopeInput,
  FridayCreateSecretInput,

  // ─── Tenant CRUD ───
  FridayCreateTenantRequest,
  FridayCreateTenantResponse,
  FridayListTenantsQuery,
  FridayListTenantsResponse,
  FridayGetTenantResponse,
  FridayUpdateTenantRequest,
  FridayUpdateTenantResponse,
  FridayDeleteTenantRequest,
  FridayDeleteTenantResponse,

  // ─── Workspace CRUD ───
  FridayCreateWorkspaceRequest,
  FridayCreateWorkspaceResponse,
  FridayListWorkspacesQuery,
  FridayListWorkspacesResponse,
  FridayGetWorkspaceResponse,
  FridayUpdateWorkspaceRequest,
  FridayUpdateWorkspaceResponse,
  FridayDeleteWorkspaceRequest,
  FridayDeleteWorkspaceResponse,

  // ─── Membership Management ───
  FridayAddMemberRequest,
  FridayAddMemberResponse,
  FridayListMembersQuery,
  FridayListMembersResponse,
  FridayRevokeMemberRequest,
  FridayRevokeMemberResponse,

  // ─── Role Management ───
  FridayCreateRoleRequest,
  FridayCreateRoleResponse,
  FridayListRolesQuery,
  FridayListRolesResponse,
  FridayGetRoleResponse,
  FridayUpdateRoleRequest,
  FridayUpdateRoleResponse,
  FridayDeleteRoleRequest,
  FridayDeleteRoleResponse,

  // ─── Permission Grants / Revokes ───
  FridayGrantRoleRequest,
  FridayGrantRoleResponse,
  FridayListRoleAssignmentsQuery,
  FridayListRoleAssignmentsResponse,
  FridayRevokeRoleRequest,
  FridayRevokeRoleResponse,

  // ─── Secret CRUD ───
  FridayCreateSecretRequest,
  FridayCreateSecretResponse,
  FridayListSecretsQuery,
  FridayListSecretsResponse,
  FridayGetSecretResponse,
  FridayUpdateSecretRequest,
  FridayUpdateSecretResponse,
  FridayDeleteSecretRequest,
  FridayDeleteSecretResponse,
  FridayRotateSecretRequest,
  FridayRotateSecretResponse,
  FridayListSecretAccessLogQuery,
  FridayListSecretAccessLogResponse,

  // ─── Policy CRUD + Evaluation ───
  FridayCreatePolicyRequest,
  FridayCreatePolicyResponse,
  FridayListPoliciesQuery,
  FridayListPoliciesResponse,
  FridayGetPolicyResponse,
  FridayUpdatePolicyRequest,
  FridayUpdatePolicyResponse,
  FridayDeletePolicyRequest,
  FridayDeletePolicyResponse,
  FridayEvaluatePolicyRequest,
  FridayEvaluatePolicyResponse,

  // ─── Audit Log Queries ───
  FridayListAuditLogQuery,
  FridayListAuditLogResponse,
  FridayListViolationsQuery,
  FridayListViolationsResponse,
  FridayResolveViolationRequest,
  FridayResolveViolationResponse,
} from "./friday-multi-tenant-security-api.types.js";

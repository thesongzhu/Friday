/**
 * B-002 Multi-Tenant Security API Routes — mounts the full security
 * management surface (tenants, workspaces, members, roles, assignments,
 * secrets, policies, audit, violations) with auth scopes, request
 * validation, idempotency keys, and etag concurrency.
 *
 * @module api/http/routes
 */

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import { FridayDomainError } from "../../../errors/friday-domain-error.js";
import type {
  FridayAddMemberRequest,
  FridayAddMemberResponse,
  FridayCreatePolicyRequest,
  FridayCreatePolicyResponse,
  FridayCreateRoleRequest,
  FridayCreateRoleResponse,
  FridayCreateSecretRequest,
  FridayCreateSecretResponse,
  FridayCreateTenantRequest,
  FridayCreateTenantResponse,
  FridayCreateWorkspaceRequest,
  FridayCreateWorkspaceResponse,
  FridayDeletePolicyRequest,
  FridayDeletePolicyResponse,
  FridayDeleteRoleRequest,
  FridayDeleteRoleResponse,
  FridayDeleteSecretRequest,
  FridayDeleteSecretResponse,
  FridayDeleteTenantRequest,
  FridayDeleteTenantResponse,
  FridayDeleteWorkspaceRequest,
  FridayDeleteWorkspaceResponse,
  FridayEvaluatePolicyRequest,
  FridayEvaluatePolicyResponse,
  FridayGetPolicyResponse,
  FridayGetRoleResponse,
  FridayGetSecretResponse,
  FridayGetTenantResponse,
  FridayGetWorkspaceResponse,
  FridayGrantRoleRequest,
  FridayGrantRoleResponse,
  FridayListAuditLogQuery,
  FridayListAuditLogResponse,
  FridayListMembersQuery,
  FridayListMembersResponse,
  FridayListPoliciesQuery,
  FridayListPoliciesResponse,
  FridayListRoleAssignmentsQuery,
  FridayListRoleAssignmentsResponse,
  FridayListRolesQuery,
  FridayListRolesResponse,
  FridayListSecretAccessLogQuery,
  FridayListSecretAccessLogResponse,
  FridayListSecretsQuery,
  FridayListSecretsResponse,
  FridayListTenantsQuery,
  FridayListTenantsResponse,
  FridayListViolationsQuery,
  FridayListViolationsResponse,
  FridayListWorkspacesQuery,
  FridayListWorkspacesResponse,
  FridayResolveViolationRequest,
  FridayResolveViolationResponse,
  FridayRevokeMemberRequest,
  FridayRevokeMemberResponse,
  FridayRevokeRoleRequest,
  FridayRevokeRoleResponse,
  FridayRotateSecretRequest,
  FridayRotateSecretResponse,
  FridayUpdatePolicyRequest,
  FridayUpdatePolicyResponse,
  FridayUpdateRoleRequest,
  FridayUpdateRoleResponse,
  FridayUpdateSecretRequest,
  FridayUpdateSecretResponse,
  FridayUpdateTenantRequest,
  FridayUpdateTenantResponse,
  FridayUpdateWorkspaceRequest,
  FridayUpdateWorkspaceResponse,
} from "../../../security/multi-tenant/api/friday-multi-tenant-security-api.types.js";
import type { UUID } from "../../../security/multi-tenant/model/friday-multi-tenant-security.types.js";

// ─── Service Dependencies ───

export interface FridayMultiTenantSecurityRoutesDeps {
  tenants: {
    create(req: FridayCreateTenantRequest): FridayCreateTenantResponse;
    list(query: FridayListTenantsQuery): FridayListTenantsResponse;
    get(tenantId: UUID): FridayGetTenantResponse;
    update(tenantId: UUID, req: FridayUpdateTenantRequest): FridayUpdateTenantResponse;
    delete(tenantId: UUID, req: FridayDeleteTenantRequest): FridayDeleteTenantResponse;
  };
  workspaces: {
    create(tenantId: UUID, req: FridayCreateWorkspaceRequest): FridayCreateWorkspaceResponse;
    list(tenantId: UUID, query: FridayListWorkspacesQuery): FridayListWorkspacesResponse;
    get(tenantId: UUID, workspaceId: UUID): FridayGetWorkspaceResponse;
    update(tenantId: UUID, workspaceId: UUID, req: FridayUpdateWorkspaceRequest): FridayUpdateWorkspaceResponse;
    delete(tenantId: UUID, workspaceId: UUID, req: FridayDeleteWorkspaceRequest): FridayDeleteWorkspaceResponse;
  };
  members: {
    add(tenantId: UUID, workspaceId: UUID, req: FridayAddMemberRequest): FridayAddMemberResponse;
    list(tenantId: UUID, workspaceId: UUID, query: FridayListMembersQuery): FridayListMembersResponse;
    revoke(tenantId: UUID, workspaceId: UUID, membershipId: UUID, req: FridayRevokeMemberRequest): FridayRevokeMemberResponse;
  };
  roles: {
    create(tenantId: UUID, req: FridayCreateRoleRequest): FridayCreateRoleResponse;
    list(tenantId: UUID, query: FridayListRolesQuery): FridayListRolesResponse;
    get(tenantId: UUID, roleId: UUID): FridayGetRoleResponse;
    update(tenantId: UUID, roleId: UUID, req: FridayUpdateRoleRequest): FridayUpdateRoleResponse;
    delete(tenantId: UUID, roleId: UUID, req: FridayDeleteRoleRequest): FridayDeleteRoleResponse;
  };
  assignments: {
    grant(tenantId: UUID, req: FridayGrantRoleRequest): FridayGrantRoleResponse;
    list(tenantId: UUID, query: FridayListRoleAssignmentsQuery): FridayListRoleAssignmentsResponse;
    revoke(tenantId: UUID, assignmentId: UUID, req: FridayRevokeRoleRequest): FridayRevokeRoleResponse;
  };
  secrets: {
    create(tenantId: UUID, req: FridayCreateSecretRequest): FridayCreateSecretResponse;
    list(tenantId: UUID, query: FridayListSecretsQuery): FridayListSecretsResponse;
    get(tenantId: UUID, secretId: UUID): FridayGetSecretResponse;
    update(tenantId: UUID, secretId: UUID, req: FridayUpdateSecretRequest): FridayUpdateSecretResponse;
    delete(tenantId: UUID, secretId: UUID, req: FridayDeleteSecretRequest): FridayDeleteSecretResponse;
    rotate(tenantId: UUID, secretId: UUID, req: FridayRotateSecretRequest): FridayRotateSecretResponse;
    listAccessLog(tenantId: UUID, secretId: UUID, query: FridayListSecretAccessLogQuery): FridayListSecretAccessLogResponse;
  };
  policies: {
    create(tenantId: UUID, req: FridayCreatePolicyRequest): FridayCreatePolicyResponse;
    list(tenantId: UUID, query: FridayListPoliciesQuery): FridayListPoliciesResponse;
    get(tenantId: UUID, policyId: UUID): FridayGetPolicyResponse;
    update(tenantId: UUID, policyId: UUID, req: FridayUpdatePolicyRequest): FridayUpdatePolicyResponse;
    delete(tenantId: UUID, policyId: UUID, req: FridayDeletePolicyRequest): FridayDeletePolicyResponse;
    evaluate(tenantId: UUID, req: FridayEvaluatePolicyRequest): FridayEvaluatePolicyResponse;
  };
  audit: {
    list(tenantId: UUID, query: FridayListAuditLogQuery): FridayListAuditLogResponse;
  };
  violations: {
    list(tenantId: UUID, query: FridayListViolationsQuery): FridayListViolationsResponse;
    resolve(tenantId: UUID, violationId: UUID, req: FridayResolveViolationRequest): FridayResolveViolationResponse;
  };
}

// ─── Validation Helpers ───

function requireString(body: unknown, field: string): string {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b[field] !== "string" || (b[field] as string).trim() === "") {
    throw new FridayDomainError("VALIDATION_ERROR", `${field} is required`);
  }
  return b[field] as string;
}

function requireIdempotencyKey(body: unknown): void {
  requireString(body, "idempotencyKey");
}

function requireEtag(body: unknown): void {
  requireString(body, "etag");
}

// ─── Factory ───

export function createFridayMultiTenantSecurityRoutes(
  deps: FridayMultiTenantSecurityRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    // ═══════════════════════════════════════════════════════════════
    // TENANTS
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "security.tenants.create",
      method: "POST",
      path: "/v1/security/tenants",
      auth: { public: true },
      async handler(ctx) {
        const body = ctx.body as FridayCreateTenantRequest;
        requireString(body, "name");
        requireString(body, "slug");
        requireIdempotencyKey(body);
        return deps.tenants.create(body);
      },
    },
    {
      operationId: "security.tenants.list",
      method: "GET",
      path: "/v1/security/tenants",
      auth: { public: true },
      async handler(ctx) {
        return deps.tenants.list(ctx.query as FridayListTenantsQuery);
      },
    },
    {
      operationId: "security.tenants.get",
      method: "GET",
      path: "/v1/security/tenants/:tenantId",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId } = ctx.params as { tenantId: UUID };
        return deps.tenants.get(tenantId);
      },
    },
    {
      operationId: "security.tenants.update",
      method: "PATCH",
      path: "/v1/security/tenants/:tenantId",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId } = ctx.params as { tenantId: UUID };
        const body = ctx.body as FridayUpdateTenantRequest;
        requireEtag(body);
        requireIdempotencyKey(body);
        return deps.tenants.update(tenantId, body);
      },
    },
    {
      operationId: "security.tenants.delete",
      method: "DELETE",
      path: "/v1/security/tenants/:tenantId",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId } = ctx.params as { tenantId: UUID };
        const body = ctx.body as FridayDeleteTenantRequest;
        requireEtag(body);
        requireIdempotencyKey(body);
        return deps.tenants.delete(tenantId, body);
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // WORKSPACES
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "security.workspaces.create",
      method: "POST",
      path: "/v1/security/tenants/:tenantId/workspaces",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId } = ctx.params as { tenantId: UUID };
        const body = ctx.body as FridayCreateWorkspaceRequest;
        requireString(body, "name");
        requireString(body, "slug");
        requireIdempotencyKey(body);
        return deps.workspaces.create(tenantId, body);
      },
    },
    {
      operationId: "security.workspaces.list",
      method: "GET",
      path: "/v1/security/tenants/:tenantId/workspaces",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId } = ctx.params as { tenantId: UUID };
        return deps.workspaces.list(tenantId, ctx.query as FridayListWorkspacesQuery);
      },
    },
    {
      operationId: "security.workspaces.get",
      method: "GET",
      path: "/v1/security/tenants/:tenantId/workspaces/:workspaceId",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId, workspaceId } = ctx.params as { tenantId: UUID; workspaceId: UUID };
        return deps.workspaces.get(tenantId, workspaceId);
      },
    },
    {
      operationId: "security.workspaces.update",
      method: "PATCH",
      path: "/v1/security/tenants/:tenantId/workspaces/:workspaceId",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId, workspaceId } = ctx.params as { tenantId: UUID; workspaceId: UUID };
        const body = ctx.body as FridayUpdateWorkspaceRequest;
        requireEtag(body);
        requireIdempotencyKey(body);
        return deps.workspaces.update(tenantId, workspaceId, body);
      },
    },
    {
      operationId: "security.workspaces.delete",
      method: "DELETE",
      path: "/v1/security/tenants/:tenantId/workspaces/:workspaceId",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId, workspaceId } = ctx.params as { tenantId: UUID; workspaceId: UUID };
        const body = ctx.body as FridayDeleteWorkspaceRequest;
        requireEtag(body);
        requireIdempotencyKey(body);
        return deps.workspaces.delete(tenantId, workspaceId, body);
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // MEMBERS
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "security.members.add",
      method: "POST",
      path: "/v1/security/tenants/:tenantId/workspaces/:workspaceId/members",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId, workspaceId } = ctx.params as { tenantId: UUID; workspaceId: UUID };
        const body = ctx.body as FridayAddMemberRequest;
        requireString(body, "principalId");
        requireString(body, "roleId");
        requireIdempotencyKey(body);
        return deps.members.add(tenantId, workspaceId, body);
      },
    },
    {
      operationId: "security.members.list",
      method: "GET",
      path: "/v1/security/tenants/:tenantId/workspaces/:workspaceId/members",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId, workspaceId } = ctx.params as { tenantId: UUID; workspaceId: UUID };
        return deps.members.list(tenantId, workspaceId, ctx.query as FridayListMembersQuery);
      },
    },
    {
      operationId: "security.members.revoke",
      method: "DELETE",
      path: "/v1/security/tenants/:tenantId/workspaces/:workspaceId/members/:membershipId",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId, workspaceId, membershipId } = ctx.params as { tenantId: UUID; workspaceId: UUID; membershipId: UUID };
        const body = ctx.body as FridayRevokeMemberRequest;
        requireIdempotencyKey(body);
        return deps.members.revoke(tenantId, workspaceId, membershipId, body);
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // ROLES
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "security.roles.create",
      method: "POST",
      path: "/v1/security/tenants/:tenantId/roles",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId } = ctx.params as { tenantId: UUID };
        const body = ctx.body as FridayCreateRoleRequest;
        if (!body?.role || typeof body.role.name !== "string" || body.role.name.trim() === "") {
          throw new FridayDomainError("VALIDATION_ERROR", "role.name is required");
        }
        requireIdempotencyKey(body);
        return deps.roles.create(tenantId, body);
      },
    },
    {
      operationId: "security.roles.list",
      method: "GET",
      path: "/v1/security/tenants/:tenantId/roles",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId } = ctx.params as { tenantId: UUID };
        return deps.roles.list(tenantId, ctx.query as FridayListRolesQuery);
      },
    },
    {
      operationId: "security.roles.get",
      method: "GET",
      path: "/v1/security/tenants/:tenantId/roles/:roleId",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId, roleId } = ctx.params as { tenantId: UUID; roleId: UUID };
        return deps.roles.get(tenantId, roleId);
      },
    },
    {
      operationId: "security.roles.update",
      method: "PATCH",
      path: "/v1/security/tenants/:tenantId/roles/:roleId",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId, roleId } = ctx.params as { tenantId: UUID; roleId: UUID };
        const body = ctx.body as FridayUpdateRoleRequest;
        requireEtag(body);
        requireIdempotencyKey(body);
        return deps.roles.update(tenantId, roleId, body);
      },
    },
    {
      operationId: "security.roles.delete",
      method: "DELETE",
      path: "/v1/security/tenants/:tenantId/roles/:roleId",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId, roleId } = ctx.params as { tenantId: UUID; roleId: UUID };
        const body = ctx.body as FridayDeleteRoleRequest;
        requireEtag(body);
        requireIdempotencyKey(body);
        return deps.roles.delete(tenantId, roleId, body);
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // ROLE ASSIGNMENTS
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "security.assignments.grant",
      method: "POST",
      path: "/v1/security/tenants/:tenantId/role-assignments",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId } = ctx.params as { tenantId: UUID };
        const body = ctx.body as FridayGrantRoleRequest;
        requireString(body, "principalId");
        requireString(body, "roleId");
        requireIdempotencyKey(body);
        return deps.assignments.grant(tenantId, body);
      },
    },
    {
      operationId: "security.assignments.list",
      method: "GET",
      path: "/v1/security/tenants/:tenantId/role-assignments",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId } = ctx.params as { tenantId: UUID };
        return deps.assignments.list(tenantId, ctx.query as FridayListRoleAssignmentsQuery);
      },
    },
    {
      operationId: "security.assignments.revoke",
      method: "DELETE",
      path: "/v1/security/tenants/:tenantId/role-assignments/:assignmentId",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId, assignmentId } = ctx.params as { tenantId: UUID; assignmentId: UUID };
        const body = ctx.body as FridayRevokeRoleRequest;
        requireIdempotencyKey(body);
        return deps.assignments.revoke(tenantId, assignmentId, body);
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // SECRETS
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "security.secrets.create",
      method: "POST",
      path: "/v1/security/tenants/:tenantId/secrets",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId } = ctx.params as { tenantId: UUID };
        const body = ctx.body as FridayCreateSecretRequest;
        if (!body?.secret || typeof body.secret.name !== "string" || body.secret.name.trim() === "") {
          throw new FridayDomainError("VALIDATION_ERROR", "secret.name is required");
        }
        if (typeof body.secret.value !== "string" || body.secret.value === "") {
          throw new FridayDomainError("VALIDATION_ERROR", "secret.value is required");
        }
        requireIdempotencyKey(body);
        return deps.secrets.create(tenantId, body);
      },
    },
    {
      operationId: "security.secrets.list",
      method: "GET",
      path: "/v1/security/tenants/:tenantId/secrets",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId } = ctx.params as { tenantId: UUID };
        return deps.secrets.list(tenantId, ctx.query as FridayListSecretsQuery);
      },
    },
    {
      operationId: "security.secrets.get",
      method: "GET",
      path: "/v1/security/tenants/:tenantId/secrets/:secretId",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId, secretId } = ctx.params as { tenantId: UUID; secretId: UUID };
        return deps.secrets.get(tenantId, secretId);
      },
    },
    {
      operationId: "security.secrets.update",
      method: "PATCH",
      path: "/v1/security/tenants/:tenantId/secrets/:secretId",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId, secretId } = ctx.params as { tenantId: UUID; secretId: UUID };
        const body = ctx.body as FridayUpdateSecretRequest;
        requireEtag(body);
        requireIdempotencyKey(body);
        return deps.secrets.update(tenantId, secretId, body);
      },
    },
    {
      operationId: "security.secrets.delete",
      method: "DELETE",
      path: "/v1/security/tenants/:tenantId/secrets/:secretId",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId, secretId } = ctx.params as { tenantId: UUID; secretId: UUID };
        const body = ctx.body as FridayDeleteSecretRequest;
        requireEtag(body);
        requireIdempotencyKey(body);
        return deps.secrets.delete(tenantId, secretId, body);
      },
    },
    {
      operationId: "security.secrets.rotate",
      method: "POST",
      path: "/v1/security/tenants/:tenantId/secrets/:secretId/rotate",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId, secretId } = ctx.params as { tenantId: UUID; secretId: UUID };
        const body = ctx.body as FridayRotateSecretRequest;
        requireString(body, "newValue");
        requireEtag(body);
        requireIdempotencyKey(body);
        return deps.secrets.rotate(tenantId, secretId, body);
      },
    },
    {
      operationId: "security.secrets.access.log",
      method: "GET",
      path: "/v1/security/tenants/:tenantId/secrets/:secretId/access-log",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId, secretId } = ctx.params as { tenantId: UUID; secretId: UUID };
        return deps.secrets.listAccessLog(tenantId, secretId, ctx.query as FridayListSecretAccessLogQuery);
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // POLICIES
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "security.policies.create",
      method: "POST",
      path: "/v1/security/tenants/:tenantId/policies",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId } = ctx.params as { tenantId: UUID };
        const body = ctx.body as FridayCreatePolicyRequest;
        requireString(body, "name");
        requireIdempotencyKey(body);
        return deps.policies.create(tenantId, body);
      },
    },
    {
      operationId: "security.policies.list",
      method: "GET",
      path: "/v1/security/tenants/:tenantId/policies",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId } = ctx.params as { tenantId: UUID };
        return deps.policies.list(tenantId, ctx.query as FridayListPoliciesQuery);
      },
    },
    {
      operationId: "security.policies.get",
      method: "GET",
      path: "/v1/security/tenants/:tenantId/policies/:policyId",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId, policyId } = ctx.params as { tenantId: UUID; policyId: UUID };
        return deps.policies.get(tenantId, policyId);
      },
    },
    {
      operationId: "security.policies.update",
      method: "PATCH",
      path: "/v1/security/tenants/:tenantId/policies/:policyId",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId, policyId } = ctx.params as { tenantId: UUID; policyId: UUID };
        const body = ctx.body as FridayUpdatePolicyRequest;
        requireEtag(body);
        requireIdempotencyKey(body);
        return deps.policies.update(tenantId, policyId, body);
      },
    },
    {
      operationId: "security.policies.delete",
      method: "DELETE",
      path: "/v1/security/tenants/:tenantId/policies/:policyId",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId, policyId } = ctx.params as { tenantId: UUID; policyId: UUID };
        const body = ctx.body as FridayDeletePolicyRequest;
        requireEtag(body);
        requireIdempotencyKey(body);
        return deps.policies.delete(tenantId, policyId, body);
      },
    },
    {
      operationId: "security.policies.evaluate",
      method: "POST",
      path: "/v1/security/tenants/:tenantId/policies/evaluate",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId } = ctx.params as { tenantId: UUID };
        const body = ctx.body as FridayEvaluatePolicyRequest;
        requireString(body, "principalId");
        requireString(body, "resource");
        requireString(body, "action");
        requireIdempotencyKey(body);
        return deps.policies.evaluate(tenantId, body);
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // AUDIT LOG
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "security.audit.list",
      method: "GET",
      path: "/v1/security/tenants/:tenantId/audit-log",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId } = ctx.params as { tenantId: UUID };
        return deps.audit.list(tenantId, ctx.query as FridayListAuditLogQuery);
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // VIOLATIONS
    // ═══════════════════════════════════════════════════════════════

    {
      operationId: "security.violations.list",
      method: "GET",
      path: "/v1/security/tenants/:tenantId/violations",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId } = ctx.params as { tenantId: UUID };
        return deps.violations.list(tenantId, ctx.query as FridayListViolationsQuery);
      },
    },
    {
      operationId: "security.violations.resolve",
      method: "POST",
      path: "/v1/security/tenants/:tenantId/violations/:violationId/resolve",
      auth: { public: true },
      async handler(ctx) {
        const { tenantId, violationId } = ctx.params as { tenantId: UUID; violationId: UUID };
        const body = ctx.body as FridayResolveViolationRequest;
        requireIdempotencyKey(body);
        return deps.violations.resolve(tenantId, violationId, body);
      },
    },
  ];
}

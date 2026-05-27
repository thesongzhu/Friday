# RFC: Multi-Tenant Security and Permissions

**Status:** Draft — SQLite-backed persistence for tenants, workspaces, role assignments, policies, secrets, audit log, violations, and tenant-scoped resource registry shipped via Phase 11 (PR #233, merged `a5239ac7` 2026-05-15). The current source tree includes deterministic env-gated proof for `module_18_cross_tenant_denial_rgg_assertion`: a tenant-scoped resource registered under tenant A cannot be read through tenant B, returns no existence-leaking object, and records a denial audit row. Surface remains gated behind `FRIDAY_MULTI_TENANT_ENABLED=true` (default-off) and a strict `FRIDAY_MASTER_KEY` resolution; the default-on flip, npm package truth, and production multi-tenant rollout are not done.
**Author:** Friday Platform Team
**Created:** 2026-02-23
**Last reconciled:** 2026-05-17 (Phase 15 docs-truth reconciliation; no code changes in this RFC update)
**Tickets:** FRI-PLAT-061, FRI-PLAT-062, FRI-PLAT-063

---

## 1. Summary

> _SQLite persistence and per-domain repository scoping for tenants, workspaces, role assignments, policies, secrets, audit log, violations, and tenant-scoped resource registry shipped under Phase 11 PR #233. The current source tree adds deterministic env-gated proof for `module_18` (cross-tenant denial assertion): cross-tenant resource lookup is denied without existence leak and writes denial audit evidence. Surface remains opt-in via `FRIDAY_MULTI_TENANT_ENABLED=true`, default-off. Friday's runtime product model remains self-hosted single-hub, single-tenant-at-runtime; this RFC does not authorize the default-on flip or claim npm package truth. `FRIDAY_MASTER_KEY` is an internal runtime secret generated and stored by the local or user-owned cloud runtime; ordinary user setup must not be told to paste it._

The Multi-Tenant Security and Permissions workstream introduces tenant isolation, workspace-scoped RBAC, a scoped credential store with encryption at rest, and policy-based permission evaluation to the Friday platform. It guarantees that all data access, secret retrieval, and agent execution respect tenant boundaries with zero cross-tenant leakage, least-privilege defaults, and full audit coverage of every permission-denied decision.

## 2. Motivation

Today, Friday operates as a single-tenant system. All rules, playbooks, packages, skills, and secrets live in a shared namespace. This creates several risks:

1. **No tenant isolation.** A single SQLite database serves all data. There is no mechanism to prevent one principal from accessing another tenant's rules, secrets, or workflow state.
2. **No workspace partitioning.** Users cannot create isolated workspaces within a tenant for different projects, environments, or teams.
3. **Coarse-grained authorization.** The existing `FridayScope`/`FridayRole` model on API routes provides endpoint-level gating but not resource-level or tenant-scoped permissions.
4. **Secrets in the clear.** Credentials stored for integrations (API keys, tokens) are not encrypted at rest, not scoped to tenants/workspaces, and have no rotation or access audit.
5. **No policy-based permission evaluation.** Permission decisions are hard-coded in route definitions rather than evaluated dynamically against a policy engine that can be configured per tenant.

The Multi-Tenant Security workstream addresses all five gaps:

- Introduce tenant and workspace entities with strict data partitioning.
- Implement hierarchical RBAC with tenant → workspace → resource scoping.
- Provide an encrypted credential store with per-secret scoping and rotation.
- Add a policy evaluation engine (integrated with the existing Rules Engine) for dynamic permission decisions.
- Guarantee 100% audit coverage of security events including denials, escalation attempts, and secret access.

## 3. Goals and Non-Goals

### Goals

- **Cross-tenant access violations: 0.** Every query is scoped by `tenant_id`; no API path can return data from another tenant.
- **Secret exposure incidents: 0.** All secrets encrypted at rest (AES-256-GCM); plaintext never written to disk or logs.
- **Permission-denied audit coverage: 100%.** Every denied permission evaluation produces a `FridaySecurityAuditEntry`.
- **Deny-by-default.** All permissions are denied unless explicitly granted by a policy or role assignment.
- **Least-privilege execution.** Agents, workflows, and API principals operate with the minimum permissions required.
- **Secret rotation with zero downtime.** Active sessions continue using the current secret version while rotation completes.
- **SQLite persistence** for all tenant, workspace, RBAC, policy, secret metadata, and audit data.
- **Integration with existing Rules Engine** for policy evaluation (reuse `FridayEvaluationContext` patterns).
- **Integration with existing auth system** (`FridayAuthPrincipal`, `FridayScope`, `FridayRole`).

### Non-Goals (Out of Scope)

- Multi-database tenant isolation (separate SQLite files per tenant) — future phase; v1 uses row-level partitioning.
- External identity provider integration (SAML, OIDC federation) — deferred.
- UI for tenant/workspace/RBAC management — frontend is a separate workstream.
- Cross-hub tenant federation — single-hub only for v1.
- Hardware Security Module (HSM) integration for key management — v1 uses software-based AES-256-GCM.
- Secret value storage implementation (encryption engine) — this phase defines the model; implementation is Phase 2.

## 4. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Friday Hub                                  │
│                                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │  Agent   │  │ Workflow │  │   API    │  │ Package  │           │
│  │ Runtime  │  │ Runtime  │  │ Routes   │  │ Engine   │           │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘           │
│       │              │              │              │                 │
│       └──────────────┴──────────────┴──────────────┘                 │
│                              │                                       │
│                   ┌──────────▼──────────┐                            │
│                   │  Security Layer     │                            │
│                   │                      │                            │
│                   │  ┌────────────────┐  │                            │
│                   │  │ Tenant Context │  │                            │
│                   │  │  Resolver      │  │                            │
│                   │  └───────┬────────┘  │                            │
│                   │          │           │                            │
│                   │  ┌───────▼────────┐  │                            │
│                   │  │  Policy        │  │                            │
│                   │  │  Evaluator     │──┼──→ Rules Engine            │
│                   │  └───────┬────────┘  │                            │
│                   │          │           │                            │
│                   │  ┌───────▼────────┐  │                            │
│                   │  │  RBAC          │  │                            │
│                   │  │  Resolver      │  │                            │
│                   │  └───────┬────────┘  │                            │
│                   │          │           │                            │
│                   │  ┌───────▼────────┐  │                            │
│                   │  │  Secret        │  │                            │
│                   │  │  Store         │  │                            │
│                   │  └───────┬────────┘  │                            │
│                   │          │           │                            │
│                   │  ┌───────▼────────┐  │                            │
│                   │  │  Audit         │  │                            │
│                   │  │  Writer        │  │                            │
│                   │  └────────────────┘  │                            │
│                   └──────────────────────┘                            │
│                              │                                       │
│                   ┌──────────▼──────────┐                            │
│                   │      SQLite         │                            │
│                   │  (Row-Level Tenant  │                            │
│                   │   Partitioning)     │                            │
│                   └─────────────────────┘                            │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.1. Request Flow

1. **Tenant Context Resolution.** Every incoming request (API, agent run, workflow step) resolves a `tenantId` and optional `workspaceId` from the authenticated principal.
2. **Query Scoping.** All database queries include `WHERE tenant_id = ?` (enforced at the repository layer). Cross-tenant queries are impossible by construction.
3. **Policy Evaluation.** Before accessing a resource, the Security Layer evaluates the request against active policies using the Policy Evaluator. The evaluator delegates to the Rules Engine for condition matching.
4. **RBAC Resolution.** The principal's effective permissions are computed from their role assignments (tenant-level and workspace-level), merged with explicit permission grants.
5. **Secret Access.** Secrets are retrieved through the Secret Store, which enforces scope checks (tenant, workspace, or resource-level) and logs every access.
6. **Audit.** Every security decision (allow, deny, escalation attempt) is written to the audit log.

## 5. Tenant and Workspace Isolation Model

### 5.1. Tenant

A **tenant** is the top-level isolation boundary. All data belongs to exactly one tenant. Tenants are identified by a UUID (`tenant_id`) that appears as a required column on every tenant-scoped table.

**Properties:**
- `id` (UUID): Unique tenant identifier.
- `name`: Human-readable display name.
- `slug`: URL-safe unique identifier.
- `status`: `active | suspended | provisioning | deactivated`.
- `config`: Tenant-level configuration (max workspaces, max members, feature flags).

**Isolation guarantees:**
- Row-level partitioning: every query includes `tenant_id` in the WHERE clause.
- No JOIN across tenants is possible in the query builder.
- Tenant context is injected at the repository layer, not at the application layer (defense in depth).
- **Composite unique keys and foreign keys enforce tenant isolation at the schema level** — cross-tenant row linkage is impossible even with direct SQL (SEC-FIX-01).

### 5.2. Workspace

A **workspace** is a subdivision within a tenant for project/environment isolation. Workspaces inherit the tenant's policies but may have additional restrictions.

**Properties:**
- `id` (UUID): Unique workspace identifier.
- `tenantId`: Parent tenant.
- `name`: Human-readable name.
- `slug`: Unique within the tenant.
- `status`: `active | archived | suspended`.
- `membership`: Users/principals assigned to this workspace with role bindings.

### 5.3. Cross-Tenant Boundaries

Cross-tenant data access is **never implicit**. The only mechanism for cross-tenant interaction is an **explicit sharing grant**, which:

1. Creates an audited `FridaySecurityAuditEntry` recording the grant.
2. Requires `tenant:admin` role on the granting tenant.
3. Creates a time-limited, scope-limited access token scoped to specific resources.
4. Is revocable at any time by either tenant's admin.

## 6. RBAC Model

### 6.1. Role Hierarchy

Roles are defined at three levels, using `system` as the canonical name for the top level (not `global`):

| Level          | Roles                                           | Description                                         |
|----------------|--------------------------------------------------|-----------------------------------------------------|
| **System**     | `system:owner`, `system:admin`                   | Platform-wide roles (Friday operator)                |
| **Tenant**     | `tenant:owner`, `tenant:admin`, `tenant:member`  | Tenant-scoped roles                                  |
| **Workspace**  | `workspace:admin`, `workspace:member`, `workspace:viewer` | Workspace-scoped roles                |

### 6.2. Permissions

Permissions are fine-grained actions on resources using a canonical verb set aligned with `FridayScope`:

```
<resource>:<action>
```

**Canonical verbs:** `read`, `write`, `delete`, `admin`, `list`, `assign`, `revoke`, `rotate`, `execute`.

Examples:
- `secret:read`, `secret:write`, `secret:rotate`
- `workspace:write`, `workspace:delete`
- `policy:execute`, `policy:write`
- `role:assign`, `role:revoke`
- `audit:read`

### 6.3. Permission-to-FridayScope Mapping

The security model defines an explicit mapping between multi-tenant permissions and the existing `FridayScope` token set (from `src/api/model/friday-api-auth.types.ts`). This enables the security layer to translate between the two systems:

| Security Permission     | FridayScope            |
|-------------------------|------------------------|
| `secret:read`           | `security.read`        |
| `secret:write`          | `security.write`       |
| `role:assign`           | `security.write`       |
| `workflow:execute`      | `workflow.run`         |
| `agent:execute`         | `agent.run`            |
| `tenant:admin`          | `hub.tenantAdmin`      |

The full mapping is maintained in `FRIDAY_SECURITY_SCOPE_MAPPINGS` in the model types.

> **Tenant Admin Isolation (SEC-FIX-R5-01).** The `tenant:admin` role maps to `hub.tenantAdmin`, NOT `hub.admin`. The `hub.admin` scope is reserved exclusively for system-level roles (`system:admin`, `system:owner`). This prevents tenant administrators from acquiring platform-wide admin privileges through role mapping. `hub.tenantAdmin` grants full administrative control within the tenant boundary but cannot modify system-level configuration, manage other tenants, or access platform-wide admin endpoints.

### 6.4. Permission Scopes

Every permission grant is scoped to one of:

| Scope         | Meaning                                      |
|---------------|----------------------------------------------|
| `system`      | Applies across all tenants (system roles)     |
| `tenant`      | Applies to all workspaces in the tenant       |
| `workspace`   | Applies to a specific workspace               |
| `resource`    | Applies to a specific resource instance        |

> **Note:** The scope model uses `system` (not `global`) as the canonical name for the top-level scope, consistent with the RBAC role hierarchy (SEC-FIX-03).

### 6.5. Role Assignment Scopes

Role assignments use a **dedicated scope type** (`FridayRoleAssignmentScope`) aligned to the RBAC hierarchy: `system → tenant → workspace`. This is intentionally separate from `FridayPermissionScope` because role assignments cannot target individual resources — they operate at hierarchy levels only (SEC-FIX-03).

Role assignment scopes are modeled as discriminated unions (SEC-FIX-04):

```typescript
type FridayRoleAssignmentScopeUnion =
  | { readonly scopeType: 'system' }
  | { readonly scopeType: 'tenant'; readonly tenantId: string }
  | { readonly scopeType: 'workspace'; readonly tenantId: string; readonly workspaceId: string }
```

### 6.6. Role Assignment

A `FridayRoleAssignment` binds a principal to a role within a scope:

```
(principalId, roleId, scope) → effective permissions
```

Effective permissions are computed as:
1. Collect all role assignments for the principal at the relevant scope levels.
2. Union all permissions from those roles.
3. Apply explicit grants and revocations (explicit deny overrides role-based allow).
4. Evaluate active policies (policy deny overrides everything).

### 6.7. Inheritance

- System roles inherit down to all tenants.
- Tenant roles inherit down to all workspaces within the tenant.
- Workspace roles do not inherit upward.
- Explicit revocations at a lower scope override inherited grants.

### 6.8. Role-Scope Compatibility Enforcement (SEC-FIX-R5-03)

Role assignments enforce strict scope compatibility at assignment boundaries:

| Role Scope Type | Allowed Assignment Scope | Endpoint                                              |
|-----------------|--------------------------|-------------------------------------------------------|
| `system`        | `system` only            | System-level endpoint (`POST /api/security/system/role-assignments`) |
| `tenant`        | `tenant` only            | Tenant-scoped endpoint (`POST /api/security/tenants/:tenantId/role-assignments`) |
| `workspace`     | `workspace` only         | Tenant-scoped endpoint with `workspaceId` in scope DTO |

**Enforcement layers:**

1. **Type-level:** `FRIDAY_ROLE_SCOPE_COMPATIBLE_ASSIGNMENT_SCOPES` defines the allowed mappings. The `validateRoleScopeCompatibility()` function checks compatibility before persisting.
2. **API-level:** Tenant-scoped grant routes use `FridayTenantScopedRoleAssignmentScopeDto` which excludes `system` scope by construction. Attempting to assign a system role through a tenant route returns `SECURITY_ASSIGNMENT_SCOPE_INCOMPATIBLE` (422).
3. **DB-level:** SQLite triggers (`validate_role_scope_compatibility`, `validate_role_scope_compatibility_update`) reject inserts/updates where the assignment `scope_type` does not match the role's declared `scope_type`.

This triple-layer enforcement ensures that:
- A workspace-scoped role (e.g., `workspace:admin`) cannot be assigned at tenant scope.
- A tenant-scoped role (e.g., `tenant:member`) cannot be assigned at workspace scope.
- A system role (e.g., `system:admin`) cannot be assigned through tenant-scoped endpoints.

## 7. Secret Management

### 7.1. Scoped Credential Store

Secrets are stored in the `security_secrets` table with discriminated scope unions (SEC-FIX-04):

| Scope       | `tenant_id` | `workspace_id` | `resource_id` | Access                              |
|-------------|-------------|-----------------|----------------|--------------------------------------|
| `tenant`    | ✓           | NULL            | NULL           | All workspace members in the tenant  |
| `workspace` | ✓           | ✓               | NULL           | Members of that workspace only       |
| `resource`  | ✓           | ✓               | ✓              | Specific resource (e.g., a skill)    |

Secret scope is modeled as a discriminated union:

```typescript
type FridaySecretScope =
  | { readonly scopeType: 'tenant'; readonly tenantId: string }
  | { readonly scopeType: 'workspace'; readonly tenantId: string; readonly workspaceId: string }
  | { readonly scopeType: 'resource'; readonly tenantId: string; readonly workspaceId: string; readonly resourceId: string }
```

**Secret name uniqueness** uses a scope-aware composite key (SEC-FIX-02):
`UNIQUE(tenant_id, scope_type, COALESCE(workspace_id, ''), COALESCE(resource_id, ''), name)`

This avoids NULL-induced uniqueness failures when `workspace_id` or `resource_id` are absent.

### 7.2. Encryption at Rest

- **Algorithm:** AES-256-GCM with random 96-bit IV per entry.
- **Key derivation:** Master key stored outside the database (environment variable or file with 0o400 permissions).
- **Storage:** `encrypted_value` column stores `iv:ciphertext:authTag` (base64-encoded).
- **Key rotation:** New master key encrypts new entries; existing entries re-encrypted lazily on next read or via bulk rotation job.

### 7.3. Secret Rotation

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ pending  │───→│ active   │───→│ rotating │───→│ rotated  │
│          │    │          │    │          │    │          │
└──────────┘    └──────┬───┘    └──────────┘    └──────────┘
                       │                              │
                       └──────────────────────────────┘
                         (active sessions continue
                          using previous version)
```

- Active sessions see the current version until their session ends.
- The `rotating` state maintains both old and new versions simultaneously.
- After rotation completes, the old version is marked `retired` and eventually purged.

### 7.4. Access Audit

Every secret access (read, list, rotate) produces a `FridaySecretAccessLog` entry:

- `secretId`, `principalId`, `action`, `accessedAt`, `ipAddress`
- `granted` (boolean): whether access was allowed
- `policyEvaluationId`: correlation to the policy evaluation that authorized it

## 8. Policy-Based Permissions

### 8.1. Integration with Rules Engine

The Security Policy Evaluator reuses the Rules Engine's evaluation pipeline. Security policies are modeled as a specialized policy bundle with:

- `resource` types extended to include `tenant`, `workspace`, `secret`, `role`, `policy`, `membership`.
- `action` types using the canonical verb set: `read`, `write`, `delete`, `admin`, `assign`, `revoke`, `rotate`, `execute`.
- Additional condition fields: `principalId`, `tenantId`, `workspaceId`, `roleId`, `secretScope`.

### 8.2. Policy Conditions (SEC-FIX-05)

Policy conditions mirror the Rules Engine's discriminated condition pattern, separating **presence conditions** (field existence checks, no value) from **value conditions** (comparison against a value):

```typescript
// Value condition — requires operator + value
interface FridayPolicyValueCondition {
  readonly field: string;
  readonly operator: FridayPolicyValueOperator;  // equals, not_equals, contains, matches, in, not_in, gt, gte, lt, lte
  readonly value: JsonValue;
}

// Presence condition — no value
interface FridayPolicyPresenceCondition {
  readonly field: string;
  readonly operator: FridayPolicyPresenceOperator;  // exists, not_exists
  readonly value?: never;
}

// Discriminated union
type FridayPolicyCondition = FridayPolicyValueCondition | FridayPolicyPresenceCondition;
```

### 8.3. Deny-by-Default

The security layer operates on a **deny-by-default** model:

1. If no policy matches, the decision is `deny`.
2. If any policy returns `deny`, the final decision is `deny` (deny wins).
3. Only explicit `allow` decisions from matching policies grant access.
4. `warn` decisions are treated as `allow` but generate an audit entry.

### 8.4. Policy Evaluation Flow

```
Request → Resolve Tenant Context
        → Resolve Principal Roles
        → Build FridayEvaluationContext (resource, action, args, principal, tenant, workspace)
        → Evaluate Security Policies (via Rules Engine)
        → If decision == deny → Audit + Reject
        → If decision == allow/warn → Proceed
        → Audit the decision regardless
```

### 8.5. Policy Rules

A `FridayPolicyRule` extends the Rules Engine condition model with security-specific fields:

```typescript
{
  resource: "secret",
  action: "read",
  conditions: {
    all: [
      { field: "principalRole", operator: "in", value: ["tenant:admin", "workspace:admin"] },
      { field: "secretScope", operator: "equals", value: "workspace" },
      { field: "workspaceId", operator: "equals", value: "${context.workspaceId}" }
    ]
  },
  effect: "allow"
}
```

## 9. API Write Contracts (SEC-FIX-06)

All write endpoints use **dedicated input DTOs** that accept only client-provided fields. Server-owned fields (`id`, `createdAt`, `updatedAt`, `etag`, etc.) are never accepted from the client.

### 9.1. Role Input DTOs

```typescript
// Create role — uses permission IDs, not full permission objects
interface FridayCreateRoleInput {
  readonly name: string;
  readonly description?: string;
  readonly scopeType: FridayRoleScopeType;
  readonly permissionIds: readonly string[];
}

// Update role — partial, uses permission IDs
interface FridayUpdateRoleInput {
  readonly name?: string;
  readonly description?: string;
  readonly permissionIds?: readonly string[];
}
```

### 9.2. Policy Rule Input DTOs

```typescript
// Create policy rule — no id, no timestamps
interface FridayCreatePolicyRuleInput {
  readonly name: string;
  readonly description?: string;
  readonly enabled?: boolean;
  readonly resource: FridaySecurityResourceType;
  readonly action: FridaySecurityActionType;
  readonly conditions: FridayPolicyConditionGroup;
  readonly effect: FridayPolicyEffect;
  readonly message?: string;
  readonly priority?: number;
}
```

### 9.3. Secret Input DTOs

```typescript
// Create secret — discriminated scope input
type FridayCreateSecretScopeInput =
  | { readonly scopeType: 'tenant' }
  | { readonly scopeType: 'workspace'; readonly workspaceId: UUID }
  | { readonly scopeType: 'resource'; readonly workspaceId: UUID; readonly resourceId: string };

interface FridayCreateSecretInput {
  readonly name: string;
  readonly description?: string;
  readonly value: string;
  readonly scope: FridayCreateSecretScopeInput;
  readonly expiresAt?: ISODateTime;
}
```

### 9.4. Tenant-Qualified API Routes (SEC-FIX-R4-01)

All tenant-scoped resources use fully tenant-qualified URL paths. No resource
endpoint accepts a bare ID without the owning `tenantId` in the path. This
enforces `(tenant_id, id)` composite lookups at the API layer:

```
GET    /api/security/tenants/:tenantId/workspaces/:workspaceId
PATCH  /api/security/tenants/:tenantId/workspaces/:workspaceId
DELETE /api/security/tenants/:tenantId/workspaces/:workspaceId
POST   /api/security/tenants/:tenantId/workspaces/:workspaceId/members
GET    /api/security/tenants/:tenantId/workspaces/:workspaceId/members
DELETE /api/security/tenants/:tenantId/workspaces/:workspaceId/members/:membershipId
GET    /api/security/tenants/:tenantId/roles/:roleId
PATCH  /api/security/tenants/:tenantId/roles/:roleId
DELETE /api/security/tenants/:tenantId/roles/:roleId
DELETE /api/security/tenants/:tenantId/role-assignments/:assignmentId
GET    /api/security/tenants/:tenantId/secrets/:secretId
PATCH  /api/security/tenants/:tenantId/secrets/:secretId
DELETE /api/security/tenants/:tenantId/secrets/:secretId
POST   /api/security/tenants/:tenantId/secrets/:secretId/rotate
GET    /api/security/tenants/:tenantId/secrets/:secretId/access-log
GET    /api/security/tenants/:tenantId/policies/:policyId
PATCH  /api/security/tenants/:tenantId/policies/:policyId
DELETE /api/security/tenants/:tenantId/policies/:policyId
POST   /api/security/tenants/:tenantId/violations/:violationId/resolve
```

Each endpoint has a corresponding typed `Params` interface (e.g., `FridayGetSecretParams`)
that enforces the `tenantId` + resource ID pair at compile time.

### 9.5. Idempotency on Side-Effecting Operations (SEC-FIX-R4-02)

All operations with write side effects require an `idempotencyKey` field in
the request body. This includes the policy evaluate endpoint
(`POST .../policies/evaluate`) because it writes audit log entries.

**Tenant-Isolated Idempotency (SEC-FIX-R5-02).** Idempotency keys are scoped to
`(principalId, tenantId, operationId, key)` — NOT just `(principalId, operationId)`.
This ensures that the same principal operating across multiple tenants cannot
experience cross-tenant idempotency key collisions. Without tenant isolation,
a principal reusing the same idempotency key on two different tenants would get
a false replay of the first tenant's response on the second tenant's request.

### 9.6. RBAC Scope Restrictions on Tenant Routes (SEC-FIX-R4-03)

The tenant-scoped role assignment grant endpoint (`POST /api/security/tenants/:tenantId/role-assignments`)
uses `FridayTenantScopedRoleAssignmentScopeDto` which only allows `tenant` and
`workspace` scope types. System-scope role grants must use a separate
system-level endpoint to prevent accidental system-scope escalation through
tenant-scoped routes.

## 10. Edge Cases

### 10.1. Tenant Migration

When a tenant's data must be migrated (e.g., to a different storage partition):

1. Tenant status transitions to `suspended` (no writes allowed).
2. A migration job copies all rows with `tenant_id = X` to the new partition.
3. Secret values are re-encrypted with the new partition's master key.
4. Role assignments and policies are validated for integrity.
5. Tenant status transitions back to `active`.
6. Full audit trail of the migration is recorded.

### 10.2. Cross-Tenant Sharing (Explicit Grants)

1. Granting tenant admin creates a `FridaySecurityPolicy` with `effect: allow` scoped to the specific resource.
2. The grant includes an `expiresAt` timestamp (mandatory, max 90 days).
3. The receiving tenant's principal is added with a temporary role assignment of type `cross-tenant-guest`.
4. Revocation is immediate and generates an audit entry.

### 10.3. Secret Rotation During Active Sessions

1. When rotation begins, the secret enters `rotating` state.
2. Both old and new versions are valid during rotation.
3. Active sessions resolve the secret version they were issued at session start.
4. New sessions always receive the latest version.
5. After a configurable grace period (default: 1 hour), the old version is retired.
6. Sessions still referencing the old version after grace period receive an error with `SECRET_VERSION_EXPIRED`.

### 10.4. Permission Escalation Attempts

1. Any attempt to assign a role with higher privileges than the principal's own role is blocked.
2. The attempt is logged as a `FridaySecurityViolation` with type `escalation_attempt`.
3. Repeated escalation attempts (≥ 3 within 5 minutes) trigger an alert.
4. The principal's role assignment is not modified.

### 10.5. Orphaned Resources

When a workspace is archived or a tenant is deactivated:

1. All active sessions in the scope are terminated gracefully.
2. Secrets are not deleted but marked as `scope_orphaned` in the access log.
3. Role assignments are soft-deleted but preserved for audit.
4. A cleanup job runs after a configurable retention period (default: 30 days) to hard-delete orphaned data.
5. Orphaned resource cleanup is fully audited.

## 11. Non-Functional Requirements

| NFR                                 | Target                                     | Measurement                                              |
|--------------------------------------|--------------------------------------------|----------------------------------------------------------|
| Cross-tenant access violations       | 0                                          | Integration tests + query-level enforcement validation    |
| Secret exposure incidents            | 0                                          | Static analysis: no plaintext in logs/DB; audit review    |
| Permission-denied audit coverage     | 100%                                       | Every deny decision produces an audit entry               |
| Policy evaluation latency (p95)      | < 10 ms                                    | Benchmark suite against 1000+ rules                      |
| Secret decryption latency (p95)      | < 5 ms                                     | Benchmark with AES-256-GCM                               |
| RBAC resolution latency (p95)        | < 15 ms                                    | Benchmark with 100+ role assignments per principal        |
| Audit log write latency (p95)        | < 2 ms                                     | Measured end-to-end including fsync                       |
| Tenant provisioning time             | < 500 ms                                   | From API call to active status                            |
| Secret rotation zero-downtime        | 100% of rotations                          | No failed requests during rotation window                 |
| Audit log retention                  | 90 days minimum                            | Configurable per tenant                                   |

## 12. Architecture Decision Records

### ADR-1: Row-Level Tenant Partitioning vs. Separate Databases

**Decision:** Row-level partitioning with `tenant_id` column on every table.

**Rationale:**
- SQLite is a single-file database; creating per-tenant files adds operational complexity (backup, migration, connection management).
- Row-level partitioning with indexed `tenant_id` provides sufficient isolation for v1 scale targets (< 1000 tenants).
- Defense-in-depth: query scoping is enforced at the repository layer, not application layer.
- Future migration to per-tenant databases is straightforward (extract rows by `tenant_id`).

**Consequences:**
- All queries must include `tenant_id` — enforced by the repository base class.
- Index on `tenant_id` is mandatory on every table for performance.
- Noisy-neighbor risk: a tenant with heavy workload can impact others. Mitigated by rate limiting per tenant.

### ADR-2: Deny-by-Default Permission Model

**Decision:** All permissions are denied unless explicitly granted by a role assignment or policy.

**Rationale:**
- Deny-by-default is the industry standard for security-sensitive systems (AWS IAM, Kubernetes RBAC).
- Explicit grants are auditable and reversible.
- Reduces the blast radius of misconfiguration — a missing policy results in denied access, not open access.

**Consequences:**
- Initial setup requires explicit role assignments for all principals.
- Onboarding flow must create default role assignments for new tenant members.
- System operations (migrations, health checks) use a `system:admin` role that bypasses tenant scoping.

### ADR-3: AES-256-GCM for Secret Encryption

**Decision:** Use AES-256-GCM with random 96-bit IV for encrypting secret values at rest.

**Rationale:**
- AES-256-GCM provides authenticated encryption (confidentiality + integrity).
- Widely supported in Node.js crypto module (no external dependencies).
- 96-bit random IV is the NIST recommendation for GCM.
- Auth tag prevents tampering with ciphertext.

**Consequences:**
- Master key must be stored securely outside the database (env var or file with restricted permissions).
- Key rotation requires re-encrypting all secrets (can be done lazily or in bulk).
- IV must never be reused with the same key — enforced by generating a fresh random IV per encryption.

### ADR-4: Policy Evaluation via Rules Engine

**Decision:** Security policies are evaluated using the existing Rules Engine evaluation pipeline.

**Rationale:**
- Avoids building a second policy evaluation engine.
- Rules Engine already supports conditions, decisions, priority ordering, and audit logging.
- Security policies are modeled as a specialized policy bundle with security-specific resource/action types.
- Consistent developer experience — one condition DSL for both safety rules and security policies.

**Consequences:**
- Security-specific resource and action types must be added to the Rules Engine's type system.
- Policy bundles for security must be clearly separated from safety policy bundles (via tags or source type).
- Performance: security policy evaluation adds latency to every request. Mitigated by caching effective permissions per (principal, tenant, workspace) tuple with TTL-based invalidation.

### ADR-5: Hierarchical RBAC with Explicit Override

**Decision:** Roles inherit downward (system → tenant → workspace) with explicit revocations at lower scopes.

**Rationale:**
- Hierarchical inheritance reduces configuration burden — a tenant admin doesn't need per-workspace assignments.
- Explicit revocations at lower scopes allow exceptions (e.g., a tenant member excluded from a specific workspace).
- This model is well-understood (GCP IAM, Azure RBAC).

**Consequences:**
- Effective permission computation requires traversing the scope hierarchy.
- Cache invalidation must propagate downward when a higher-scope role changes.
- Explicit revocations must be checked after inheritance merging.

### ADR-6: Composite Keys for Tenant Isolation (SEC-FIX-01)

**Decision:** All foreign keys that cross tables within the security schema use composite keys including `tenant_id`.

**Rationale:**
- Simple single-column foreign keys (e.g., `role_id REFERENCES security_roles(id)`) do not prevent cross-tenant row linkage. A membership in tenant A could reference a role belonging to tenant B.
- Composite foreign keys like `FOREIGN KEY (role_id, tenant_id) REFERENCES security_roles(id, tenant_id)` make cross-tenant linkage impossible at the database level.
- This is defense-in-depth: even if the application layer has a bug, the DB rejects invalid cross-tenant references.

**Consequences:**
- All referenced tables must have composite unique indexes on `(id, tenant_id)` to support composite foreign keys.
- Slightly more complex migration scripts.
- CHECK constraints enforce scope consistency (e.g., workspace-scoped secrets must have a non-NULL `workspace_id`).

**Scope-bound composite FKs (SEC-FIX-R6-01, SEC-FIX-R6-02):** The `scope_id` column in `security_role_assignments` and `security_policies` uses a composite FK `(scope_id, tenant_id) REFERENCES security_workspaces(id, tenant_id)` to prevent cross-tenant workspace linkage. Because the CHECK constraint forces `scope_id` to NULL for non-workspace scopes, SQLite's NULL semantics cause the FK to be silently skipped — providing conditional enforcement without triggers. **Migration validation:** When adding these FKs to an existing database, run the following before enabling `PRAGMA foreign_keys`:
```sql
-- Detect orphaned workspace-scoped role assignments
SELECT id FROM security_role_assignments
WHERE scope_type = 'workspace' AND NOT EXISTS (
  SELECT 1 FROM security_workspaces w
  WHERE w.id = security_role_assignments.scope_id
    AND w.tenant_id = security_role_assignments.tenant_id
);
-- Detect orphaned workspace-scoped policies
SELECT id FROM security_policies
WHERE scope_type = 'workspace' AND NOT EXISTS (
  SELECT 1 FROM security_workspaces w
  WHERE w.id = security_policies.scope_id
    AND w.tenant_id = security_policies.tenant_id
);
```
Any rows returned must be remediated (reassigned or deleted) before the migration proceeds.

### ADR-7: Discriminated Unions for Scope-Bound Entities (SEC-FIX-04)

**Decision:** All scope-bound entities (secrets, role assignments, policies) use TypeScript discriminated unions instead of optional ID fields.

**Rationale:**
- Optional fields (`workspaceId?: string`) allow invalid states (e.g., `scopeType: 'tenant'` with a `workspaceId` set).
- Discriminated unions make invalid states unrepresentable at the type level.
- This aligns with the pattern used in the Rules Engine for conditions.

**Consequences:**
- Domain entities use `scope: FridaySecretScope` (discriminated union) instead of flat optional fields.
- API DTOs use scope-discriminated unions with `never` on invalid fields (e.g., `FridaySecretDto` is a union of tenant/workspace/resource variants where inapplicable scope fields are typed as `never`).
- Mapper functions convert between the discriminated union (domain) and flat row (persistence).

## 13. Persistence Schema (SQLite)

### 13.1. Tenants

```sql
CREATE TABLE security_tenants (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'provisioning',
  config_json     TEXT NOT NULL DEFAULT '{}',
  etag            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);

CREATE INDEX idx_tenants_slug ON security_tenants(slug);
CREATE INDEX idx_tenants_status ON security_tenants(status);
```

### 13.2. Workspaces

```sql
CREATE TABLE security_workspaces (
  id              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL REFERENCES security_tenants(id),
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  config_json     TEXT NOT NULL DEFAULT '{}',
  etag            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT,
  PRIMARY KEY (id),
  UNIQUE(id, tenant_id),
  UNIQUE(tenant_id, slug)
);

CREATE INDEX idx_workspaces_tenant ON security_workspaces(tenant_id);
CREATE INDEX idx_workspaces_status ON security_workspaces(tenant_id, status);
```

### 13.3. Workspace Memberships

```sql
CREATE TABLE security_workspace_memberships (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  principal_id    TEXT NOT NULL,
  role_id         TEXT NOT NULL,
  granted_by      TEXT NOT NULL,
  granted_at      TEXT NOT NULL,
  expires_at      TEXT,
  revoked_at      TEXT,
  UNIQUE(workspace_id, tenant_id, principal_id, role_id),
  -- Composite FK: workspace must belong to the same tenant (SEC-FIX-01)
  FOREIGN KEY (workspace_id, tenant_id) REFERENCES security_workspaces(id, tenant_id),
  -- Composite FK: role must belong to the same tenant (or be a system role)
  FOREIGN KEY (role_id, tenant_id) REFERENCES security_roles(id, tenant_id)
);

CREATE INDEX idx_memberships_workspace ON security_workspace_memberships(workspace_id);
CREATE INDEX idx_memberships_principal ON security_workspace_memberships(tenant_id, principal_id);
```

### 13.4. Roles

```sql
CREATE TABLE security_roles (
  id              TEXT NOT NULL,
  tenant_id       TEXT REFERENCES security_tenants(id),
  name            TEXT NOT NULL,
  description     TEXT,
  scope_type      TEXT NOT NULL CHECK(scope_type IN ('system', 'tenant', 'workspace')),
  is_system       INTEGER NOT NULL DEFAULT 0,
  permissions_json TEXT NOT NULL DEFAULT '[]',
  etag            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT,
  PRIMARY KEY (id),
  UNIQUE(id, tenant_id),
  -- System roles must have NULL tenant_id; tenant/workspace roles must have non-NULL tenant_id
  CHECK(
    (scope_type = 'system' AND tenant_id IS NULL AND is_system = 1)
    OR (scope_type IN ('tenant', 'workspace') AND tenant_id IS NOT NULL)
  )
);

CREATE INDEX idx_roles_tenant ON security_roles(tenant_id);
CREATE INDEX idx_roles_scope ON security_roles(scope_type);
```

### 13.5. Role Assignments

```sql
CREATE TABLE security_role_assignments (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT REFERENCES security_tenants(id),
  principal_id    TEXT NOT NULL,
  role_id         TEXT NOT NULL,
  scope_type      TEXT NOT NULL CHECK(scope_type IN ('system', 'tenant', 'workspace')),
  scope_id        TEXT,
  granted_by      TEXT NOT NULL,
  granted_at      TEXT NOT NULL,
  expires_at      TEXT,
  revoked_at      TEXT,
  UNIQUE(COALESCE(tenant_id, ''), principal_id, role_id, scope_type, COALESCE(scope_id, '')),
  -- Composite FK: role must belong to the same tenant (SEC-FIX-01)
  -- NULL tenant_id for system-scope assignments bypasses this FK (SQLite NULL semantics)
  FOREIGN KEY (role_id, tenant_id) REFERENCES security_roles(id, tenant_id),
  -- Composite FK: workspace-scoped assignments must reference a workspace within the same
  -- tenant (SEC-FIX-R6-01). When scope_type != 'workspace', scope_id is NULL (enforced by
  -- CHECK below), so SQLite NULL semantics cause this FK to be silently skipped — giving us
  -- conditional enforcement without triggers.
  FOREIGN KEY (scope_id, tenant_id) REFERENCES security_workspaces(id, tenant_id),
  -- Scope consistency (SEC-FIX-R2-02): system roles have NULL tenant_id and NULL scope_id;
  -- tenant roles require tenant_id but no scope_id; workspace roles require both
  CHECK(
    (scope_type = 'system' AND tenant_id IS NULL AND scope_id IS NULL)
    OR (scope_type = 'tenant' AND tenant_id IS NOT NULL AND scope_id IS NULL)
    OR (scope_type = 'workspace' AND tenant_id IS NOT NULL AND scope_id IS NOT NULL)
  )
);

CREATE INDEX idx_role_assignments_principal ON security_role_assignments(tenant_id, principal_id);
CREATE INDEX idx_role_assignments_scope ON security_role_assignments(scope_type, scope_id);

-- System role assignment integrity (SEC-FIX-R3-03):
-- Ensures that system-scope assignments reference roles that are actual system roles
-- (i.e., roles with tenant_id IS NULL). The composite FK alone cannot enforce this
-- because SQLite NULL semantics cause the FK to be silently skipped when tenant_id
-- is NULL. This trigger provides defense-in-depth validation.
CREATE TRIGGER validate_system_role_assignment
  BEFORE INSERT ON security_role_assignments
  WHEN NEW.scope_type = 'system'
BEGIN
  SELECT RAISE(ABORT, 'system-scope assignment must reference a system role (tenant_id IS NULL)')
  WHERE NOT EXISTS (
    SELECT 1 FROM security_roles
    WHERE id = NEW.role_id AND tenant_id IS NULL
  );
END;

-- Mirror trigger for UPDATE: SQLite does not support BEFORE INSERT OR UPDATE,
-- so a separate trigger is required to prevent integrity bypass via UPDATE.
CREATE TRIGGER validate_system_role_assignment_update
  BEFORE UPDATE ON security_role_assignments
  WHEN NEW.scope_type = 'system'
BEGIN
  SELECT RAISE(ABORT, 'system-scope assignment must reference a system role (tenant_id IS NULL)')
  WHERE NOT EXISTS (
    SELECT 1 FROM security_roles
    WHERE id = NEW.role_id AND tenant_id IS NULL
  );
END;

-- Role-scope compatibility enforcement (SEC-FIX-R5-03):
-- Ensures that the assignment scope_type matches the role's declared scope_type.
-- Workspace-assignable roles can only be assigned at workspace scope,
-- tenant-assignable roles only at tenant scope, system roles only at system scope.
CREATE TRIGGER validate_role_scope_compatibility
  BEFORE INSERT ON security_role_assignments
BEGIN
  SELECT RAISE(ABORT, 'assignment scope_type must match the role scope_type')
  WHERE NOT EXISTS (
    SELECT 1 FROM security_roles
    WHERE id = NEW.role_id AND scope_type = NEW.scope_type
  );
END;

CREATE TRIGGER validate_role_scope_compatibility_update
  BEFORE UPDATE ON security_role_assignments
BEGIN
  SELECT RAISE(ABORT, 'assignment scope_type must match the role scope_type')
  WHERE NOT EXISTS (
    SELECT 1 FROM security_roles
    WHERE id = NEW.role_id AND scope_type = NEW.scope_type
  );
END;
```

### 13.6. Security Policies

```sql
CREATE TABLE security_policies (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES security_tenants(id),
  name            TEXT NOT NULL,
  description     TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  priority        INTEGER NOT NULL DEFAULT 100,
  scope_type      TEXT NOT NULL DEFAULT 'tenant' CHECK(scope_type IN ('tenant', 'workspace')),
  scope_id        TEXT,
  rules_json      TEXT NOT NULL DEFAULT '[]',
  version         INTEGER NOT NULL DEFAULT 1,
  etag            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT,
  UNIQUE(tenant_id, name),
  -- Composite FK: workspace-scoped policies must reference a workspace within the same
  -- tenant (SEC-FIX-R6-02). When scope_type = 'tenant', scope_id is NULL (enforced by
  -- CHECK below), so SQLite NULL semantics cause this FK to be silently skipped.
  FOREIGN KEY (scope_id, tenant_id) REFERENCES security_workspaces(id, tenant_id),
  -- Scope consistency: workspace-scoped policies must have a scope_id
  CHECK(
    (scope_type = 'workspace' AND scope_id IS NOT NULL)
    OR (scope_type = 'tenant' AND scope_id IS NULL)
  )
);

CREATE INDEX idx_policies_tenant ON security_policies(tenant_id);
CREATE INDEX idx_policies_enabled ON security_policies(tenant_id, enabled);
```

### 13.7. Secrets

```sql
CREATE TABLE security_secrets (
  id              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL REFERENCES security_tenants(id),
  workspace_id    TEXT,
  resource_id     TEXT,
  name            TEXT NOT NULL,
  description     TEXT,
  encrypted_value TEXT NOT NULL,
  encryption_key_id TEXT NOT NULL,
  scope_type      TEXT NOT NULL CHECK(scope_type IN ('tenant', 'workspace', 'resource')),
  version         INTEGER NOT NULL DEFAULT 1,
  rotation_state  TEXT NOT NULL DEFAULT 'active',
  expires_at      TEXT,
  rotated_at      TEXT,
  etag            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT,
  PRIMARY KEY (id),
  -- Composite unique key to support composite FK from access log (SEC-FIX-R2-01)
  UNIQUE(id, tenant_id),
  -- SEC-FIX-02: Scope-aware uniqueness that handles NULLs correctly
  UNIQUE(tenant_id, scope_type, COALESCE(workspace_id, ''), COALESCE(resource_id, ''), name),
  -- Composite FK: workspace must belong to the same tenant (SEC-FIX-01)
  FOREIGN KEY (workspace_id, tenant_id) REFERENCES security_workspaces(id, tenant_id),
  -- Scope consistency checks (SEC-FIX-04)
  CHECK(
    (scope_type = 'tenant'    AND workspace_id IS NULL AND resource_id IS NULL)
    OR (scope_type = 'workspace' AND workspace_id IS NOT NULL AND resource_id IS NULL)
    OR (scope_type = 'resource'  AND workspace_id IS NOT NULL AND resource_id IS NOT NULL)
  )
);

CREATE INDEX idx_secrets_tenant ON security_secrets(tenant_id);
CREATE INDEX idx_secrets_workspace ON security_secrets(tenant_id, workspace_id);
CREATE INDEX idx_secrets_scope ON security_secrets(scope_type);
CREATE INDEX idx_secrets_rotation ON security_secrets(rotation_state);
```

### 13.8. Secret Access Log

```sql
CREATE TABLE security_secret_access_log (
  id                  TEXT PRIMARY KEY,
  secret_id           TEXT NOT NULL,
  tenant_id           TEXT NOT NULL,
  principal_id        TEXT NOT NULL,
  action              TEXT NOT NULL,
  granted             INTEGER NOT NULL,
  policy_evaluation_id TEXT,
  ip_address          TEXT,
  user_agent          TEXT,
  accessed_at         TEXT NOT NULL,
  -- Composite FK: secret must belong to the same tenant (SEC-FIX-R2-01)
  FOREIGN KEY (secret_id, tenant_id) REFERENCES security_secrets(id, tenant_id)
);

CREATE INDEX idx_secret_access_log_secret ON security_secret_access_log(secret_id);
CREATE INDEX idx_secret_access_log_tenant ON security_secret_access_log(tenant_id);
CREATE INDEX idx_secret_access_log_principal ON security_secret_access_log(tenant_id, principal_id);
CREATE INDEX idx_secret_access_log_time ON security_secret_access_log(accessed_at);
```

### 13.9. Security Audit Log

```sql
CREATE TABLE security_audit_log (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  principal_id    TEXT,
  action          TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_id     TEXT,
  decision        TEXT NOT NULL,
  reason          TEXT,
  ip_address      TEXT,
  user_agent      TEXT,
  session_id      TEXT,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_audit_log_tenant ON security_audit_log(tenant_id);
CREATE INDEX idx_audit_log_principal ON security_audit_log(tenant_id, principal_id);
CREATE INDEX idx_audit_log_action ON security_audit_log(action);
CREATE INDEX idx_audit_log_decision ON security_audit_log(decision);
CREATE INDEX idx_audit_log_time ON security_audit_log(created_at);
```

### 13.10. Security Violations

```sql
CREATE TABLE security_violations (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  principal_id    TEXT NOT NULL,
  violation_type  TEXT NOT NULL,
  severity        TEXT NOT NULL,
  description     TEXT NOT NULL,
  resource_type   TEXT,
  resource_id     TEXT,
  action_attempted TEXT,
  ip_address      TEXT,
  resolved        INTEGER NOT NULL DEFAULT 0,
  resolved_by     TEXT,
  resolved_at     TEXT,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_violations_tenant ON security_violations(tenant_id);
CREATE INDEX idx_violations_principal ON security_violations(tenant_id, principal_id);
CREATE INDEX idx_violations_type ON security_violations(violation_type);
CREATE INDEX idx_violations_severity ON security_violations(severity);
CREATE INDEX idx_violations_unresolved ON security_violations(resolved) WHERE resolved = 0;
```

## 14. Error Codes

All multi-tenant security API errors use standardised codes defined in
`FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES`. Each code is prefixed with
`SECURITY_` and maps to an HTTP status code.

| Constant                        | Code Value                            | HTTP | Description                                                    |
|---------------------------------|---------------------------------------|------|----------------------------------------------------------------|
| `TENANT_NOT_FOUND`              | `SECURITY_TENANT_NOT_FOUND`           | 404  | The requested tenant does not exist or has been deleted.        |
| `TENANT_SLUG_CONFLICT`          | `SECURITY_TENANT_SLUG_CONFLICT`       | 409  | A tenant with this slug already exists.                        |
| `TENANT_INVALID_STATE`          | `SECURITY_TENANT_INVALID_STATE`       | 422  | The tenant is not in a valid state for this operation.          |
| `TENANT_LIMIT_EXCEEDED`         | `SECURITY_TENANT_LIMIT_EXCEEDED`      | 422  | Maximum number of tenants has been reached.                     |
| `WORKSPACE_NOT_FOUND`           | `SECURITY_WORKSPACE_NOT_FOUND`        | 404  | The requested workspace does not exist or has been deleted.     |
| `WORKSPACE_SLUG_CONFLICT`       | `SECURITY_WORKSPACE_SLUG_CONFLICT`    | 409  | A workspace with this slug already exists in the tenant.        |
| `WORKSPACE_INVALID_STATE`       | `SECURITY_WORKSPACE_INVALID_STATE`    | 422  | The workspace is not in a valid state for this operation.       |
| `WORKSPACE_LIMIT_EXCEEDED`      | `SECURITY_WORKSPACE_LIMIT_EXCEEDED`   | 422  | Maximum workspaces for this tenant has been reached.            |
| `MEMBERSHIP_NOT_FOUND`          | `SECURITY_MEMBERSHIP_NOT_FOUND`       | 404  | The requested membership does not exist.                       |
| `MEMBERSHIP_ALREADY_EXISTS`     | `SECURITY_MEMBERSHIP_ALREADY_EXISTS`  | 409  | The principal is already a member with this role.               |
| `MEMBERSHIP_LIMIT_EXCEEDED`     | `SECURITY_MEMBERSHIP_LIMIT_EXCEEDED`  | 422  | Maximum members for this tenant has been reached.               |
| `ROLE_NOT_FOUND`                | `SECURITY_ROLE_NOT_FOUND`             | 404  | The requested role does not exist or has been deleted.          |
| `ROLE_NAME_CONFLICT`            | `SECURITY_ROLE_NAME_CONFLICT`         | 409  | A role with this name already exists in the scope.              |
| `ROLE_SYSTEM_IMMUTABLE`         | `SECURITY_ROLE_SYSTEM_IMMUTABLE`      | 403  | Cannot modify a built-in system role.                          |
| `PERMISSION_NOT_FOUND`          | `SECURITY_PERMISSION_NOT_FOUND`       | 404  | The requested permission does not exist.                       |
| `PERMISSION_DENIED`             | `SECURITY_PERMISSION_DENIED`          | 403  | The principal does not have the required permission.            |
| `PERMISSION_ESCALATION`         | `SECURITY_PERMISSION_ESCALATION`      | 403  | Attempt to grant a permission the grantor does not hold.        |
| `ASSIGNMENT_NOT_FOUND`          | `SECURITY_ASSIGNMENT_NOT_FOUND`       | 404  | The requested role assignment does not exist.                  |
| `ASSIGNMENT_ALREADY_EXISTS`     | `SECURITY_ASSIGNMENT_ALREADY_EXISTS`  | 409  | This role assignment already exists.                           |
| `ASSIGNMENT_SCOPE_INCOMPATIBLE` | `SECURITY_ASSIGNMENT_SCOPE_INCOMPATIBLE` | 422 | Role scope is incompatible with the assignment scope.          |
| `SECRET_NOT_FOUND`              | `SECURITY_SECRET_NOT_FOUND`           | 404  | The requested secret does not exist or has been deleted.        |
| `SECRET_NAME_CONFLICT`          | `SECURITY_SECRET_NAME_CONFLICT`       | 409  | A secret with this name already exists in the scope.            |
| `SECRET_ROTATION_INVALID`       | `SECURITY_SECRET_ROTATION_INVALID`    | 422  | The secret is not in a valid state for rotation.               |
| `SECRET_VERSION_EXPIRED`        | `SECURITY_SECRET_VERSION_EXPIRED`     | 410  | The secret version has expired.                                |
| `SECRET_LIMIT_EXCEEDED`         | `SECURITY_SECRET_LIMIT_EXCEEDED`      | 422  | Maximum secrets for this workspace has been reached.            |
| `POLICY_NOT_FOUND`              | `SECURITY_POLICY_NOT_FOUND`           | 404  | The requested security policy does not exist or was deleted.    |
| `POLICY_EVALUATION_FAILED`      | `SECURITY_POLICY_EVALUATION_FAILED`   | 500  | Policy evaluation failed due to an internal error.             |
| `ETAG_MISMATCH`                 | `SECURITY_ETAG_MISMATCH`             | 412  | Optimistic concurrency conflict — the etag does not match.     |
| `VALIDATION_FAILED`             | `SECURITY_VALIDATION_FAILED`          | 400  | Validation failed on the request payload.                      |
| `IDEMPOTENCY_KEY_CONFLICT`      | `SECURITY_IDEMPOTENCY_KEY_CONFLICT`   | 409  | Idempotency key reused with a different payload.               |
| `INSUFFICIENT_SCOPE`            | `SECURITY_INSUFFICIENT_SCOPE`         | 403  | The principal lacks the required scope for this operation.      |
| `CROSS_TENANT_DENIED`           | `SECURITY_CROSS_TENANT_DENIED`        | 403  | Cross-tenant access attempted and denied.                      |

All error responses use the standard Friday error envelope:

```json
{
  "error": {
    "code": "SECURITY_TENANT_NOT_FOUND",
    "message": "Tenant abc-123 does not exist or has been deleted.",
    "status": 404
  }
}
```

## 15. Future Work

- **Phase 2:** Secret encryption engine implementation (AES-256-GCM encrypt/decrypt, key rotation job).
- **Phase 2:** Permission caching layer with TTL-based invalidation.
- **Phase 2:** Multi-database tenant isolation for high-scale deployments.
- **Phase 3:** External identity provider federation (SAML 2.0, OIDC).
- **Phase 3:** Cross-hub tenant federation for distributed deployments.
- **Phase 3:** Hardware Security Module (HSM) integration for master key management.
- **Phase 3:** Policy simulation endpoint ("what-if" analysis without enforcement).

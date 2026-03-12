/**
 * Multi-Tenant Security Core Runtime — Engine barrel export.
 *
 * Provides the in-memory implementation of the multi-tenant security system:
 * tenant management, RBAC, policy evaluation, secret management, audit logging,
 * and idempotency tracking.
 *
 * @module security/multi-tenant/engine
 */

// ─── Utilities ───
export { SecurityEngineError, generateId, generateEtag, now, cloneAndFreeze } from "./utils.js";

// ─── Audit Logger ───
export { AuditLogger } from "./audit-logger.js";
export type {
  CreateAuditEntryInput,
  CreateViolationInput,
  AuditLogQuery,
  ViolationQuery,
} from "./audit-logger.js";

// ─── Idempotency Manager ───
export { IdempotencyManager } from "./idempotency-manager.js";

// ─── Tenant Manager ───
export { TenantManager } from "./tenant-manager.js";
export type {
  CreateTenantInput,
  UpdateTenantInput,
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  AddMemberInput,
  TenantCrudActorContext,
} from "./tenant-manager.js";

// ─── RBAC Engine ───
export { RbacEngine } from "./rbac-engine.js";
export type {
  CreateRoleInput,
  UpdateRoleInput,
  GrantRoleInput,
  PermissionCheckContext,
  RoleThresholdCheckContext,
} from "./rbac-engine.js";

// ─── Policy Engine ───
export { PolicyEngine } from "./policy-engine.js";
export type {
  CreatePolicyInput,
  UpdatePolicyInput,
  PolicyEvaluationContext,
} from "./policy-engine.js";

// ─── Secret Manager ───
export { SecretManager } from "./secret-manager.js";
export type {
  CreateSecretInput as CreateSecretInputEngine,
  UpdateSecretInput as UpdateSecretInputEngine,
  RotateSecretInput,
  RedactedSecret,
  SecretRequestScopeContext,
} from "./secret-manager.js";

// ─── Routing Guard ───
export { assertTenantRouteBoundary } from "./routing-guard.js";
export type { RoutingAuthContext } from "./routing-guard.js";

// ─── Tenant-Scoped Secret Bridge ───
export { createTenantScopedSecretBridge } from "./friday-tenant-scoped-secret-bridge.js";
export type {
  TenantSecretRef,
  ResolvedTenantSecret,
  SecretAccessDecision,
  SecretAccessResult,
  TenantScopedSecretBridgeDeps,
  FridayTenantScopedSecretBridge,
  SecretAccessLogEntry,
} from "./friday-tenant-scoped-secret-bridge.js";

// ─── Tenant Isolation Middleware ───
export { createTenantIsolationMiddleware } from "./friday-tenant-isolation-middleware.js";
export type {
  TenantPrincipalContext,
  IsolationDecision,
  TenantIsolationResult,
  ScopeFixtures,
  TenantIsolationMiddlewareDeps,
  FridayTenantIsolationMiddleware,
} from "./friday-tenant-isolation-middleware.js";

// ─── Migration Manager ───
export { MigrationManager } from "./migration-manager.js";
export type {
  MigrationDryRunReport,
  MigrationUpReport,
  MigrationDownReport,
} from "./migration-manager.js";

// ─── Package Trust Policy (B-009) ───
export { createPackageTrustPolicy } from "./friday-package-trust-policy.js";
export type {
  TrustPolicyMode,
  TrustOutcome,
  TrustDecision,
  TrustStoreKey,
  PackageTrustInput,
  PluginTrustInput,
  TrustAuditEntry,
  PackageTrustPolicyDeps,
  FridayPackageTrustPolicy,
  TrustPolicyStats,
} from "./friday-package-trust-policy.js";

// ─── Security-Observability Convergence Bridge (B-010) ───
export { createSecurityObservabilityBridge } from "./friday-security-observability-bridge.js";
export type {
  BridgeFilterMode,
  BridgeViolationFilter,
  SecurityObservabilityBridgeConfig,
  ConvertedAuditEntry,
  BridgeStats,
  SecurityObservabilityBridgeDeps,
  FridaySecurityObservabilityBridge,
} from "./friday-security-observability-bridge.js";

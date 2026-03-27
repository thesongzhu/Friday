/**
 * Policy Engine — Policy CRUD and evaluation with tenant isolation.
 *
 * Evaluates security policies following deny-by-default semantics:
 * - No matching policy → deny
 * - Any deny match → deny (deny wins over allow)
 * - Only explicit allow → allow
 * - Warn is treated as allow but logged
 *
 * Policy conditions support the full operator set from the domain model,
 * including presence checks, string matching, and array operations.
 *
 * @module security/multi-tenant/engine/policy-engine
 */

import type {
  FridayMatchedPolicyRule,
  FridayPolicyCondition,
  FridayPolicyConditionGroup,
  FridayPolicyDecision,
  FridayPolicyEvaluation,
  FridayPolicyRule,
  FridayPolicyScopeUnion,
  FridaySecurityActionType,
  FridaySecurityPolicy,
  FridaySecurityResourceType,
  JsonValue,
  UUID,
} from "../model/friday-multi-tenant-security.types.js";

import { FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES } from "../api/friday-multi-tenant-security-api.types.js";

import type { FridayCreatePolicyRuleInput } from "../api/friday-multi-tenant-security-api.types.js";

import { cloneAndFreeze, generateEtag, generateId, now, SecurityEngineError } from "./utils.js";
import type { AuditLogger } from "./audit-logger.js";

// ─── Input Types ───

export interface CreatePolicyInput {
  readonly name: string;
  readonly description?: string;
  readonly priority?: number;
  readonly scope?: FridayPolicyScopeUnion;
  readonly rules: readonly FridayCreatePolicyRuleInput[];
}

export interface UpdatePolicyInput {
  readonly name?: string;
  readonly description?: string;
  readonly enabled?: boolean;
  readonly priority?: number;
  readonly rules?: readonly FridayCreatePolicyRuleInput[];
  readonly etag: string;
}

export interface PolicyEvaluationContext {
  readonly principalId: string;
  readonly resource: FridaySecurityResourceType;
  readonly action: FridaySecurityActionType;
  readonly resourceId?: string;
  readonly workspaceId?: UUID;
  /** Additional context fields for condition evaluation. */
  readonly attributes?: Readonly<Record<string, JsonValue>>;
}

// ─── Policy Engine ───

export class PolicyEngine {
  private readonly policies = new Map<UUID, FridaySecurityPolicy>();

  constructor(private readonly auditLogger: AuditLogger) {}

  // ═══════════════════════════════════════════════════════════════
  // POLICY CRUD
  // ═══════════════════════════════════════════════════════════════

  /** Create a security policy within a tenant. */
  createPolicy(tenantId: UUID, input: CreatePolicyInput): FridaySecurityPolicy {
    // Name uniqueness within tenant
    for (const p of this.policies.values()) {
      if (p.tenantId === tenantId && p.name === input.name && !p.deletedAt) {
        throw new SecurityEngineError(
          FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.POLICY_NAME_CONFLICT,
          `A policy named '${input.name}' already exists in tenant ${tenantId}.`,
        );
      }
    }

    const scope: FridayPolicyScopeUnion = input.scope ?? {
      scopeType: "tenant",
      tenantId,
    };

    // Validate scope tenant matches
    if (scope.tenantId !== tenantId) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.CROSS_TENANT_DENIED,
        "Policy scope tenantId does not match the target tenant.",
      );
    }

    const rules: FridayPolicyRule[] = input.rules.map((r) => ({
      id: generateId(),
      name: r.name,
      description: r.description,
      enabled: r.enabled ?? true,
      resource: r.resource,
      action: r.action,
      conditions: structuredClone(r.conditions),
      effect: r.effect,
      message: r.message,
      priority: r.priority ?? 100,
    }));

    const timestamp = now();
    const policy: FridaySecurityPolicy = {
      id: generateId(),
      tenantId,
      name: input.name,
      description: input.description,
      enabled: true,
      priority: input.priority ?? 100,
      scope,
      rules,
      version: 1,
      etag: generateEtag(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.policies.set(policy.id, policy);

    this.auditLogger.log({
      tenantId,
      action: "policy.create",
      resourceType: "policy",
      resourceId: policy.id,
      decision: "allow",
      reason: `Policy '${policy.name}' created.`,
    });

    return cloneAndFreeze(policy);
  }

  /** Get a policy by id, enforcing tenant isolation. */
  getPolicy(tenantId: UUID, policyId: UUID): FridaySecurityPolicy {
    const policy = this.policies.get(policyId);
    if (!policy || policy.tenantId !== tenantId || policy.deletedAt) {
      this.auditLogger.log({
        tenantId,
        action: "policy.get",
        resourceType: "policy",
        resourceId: policyId,
        decision: "deny",
        reason: `Policy ${policyId} not found in tenant ${tenantId}.`,
      });
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.POLICY_NOT_FOUND,
        `Policy ${policyId} not found in tenant ${tenantId}.`,
      );
    }
    return cloneAndFreeze(policy);
  }

  /** List policies within a tenant. */
  listPolicies(
    tenantId: UUID,
    options?: { enabled?: boolean },
  ): readonly FridaySecurityPolicy[] {
    const policies = Array.from(this.policies.values())
      .filter((p) => {
        if (p.tenantId !== tenantId || p.deletedAt) return false;
        if (options?.enabled !== undefined && p.enabled !== options.enabled) return false;
        return true;
      })
      .sort((a, b) => a.priority - b.priority);
    return cloneAndFreeze(policies);
  }

  /** Update a policy with optimistic concurrency and tenant isolation. */
  updatePolicy(tenantId: UUID, policyId: UUID, input: UpdatePolicyInput): FridaySecurityPolicy {
    const existing = this.getPolicy(tenantId, policyId);

    if (existing.etag !== input.etag) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ETAG_MISMATCH,
        `Etag mismatch for policy ${policyId}.`,
      );
    }

    // Check name uniqueness if changing
    if (input.name && input.name !== existing.name) {
      for (const p of this.policies.values()) {
        if (p.tenantId === tenantId && p.name === input.name && !p.deletedAt && p.id !== policyId) {
          throw new SecurityEngineError(
            FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.POLICY_NAME_CONFLICT,
            `A policy named '${input.name}' already exists in tenant ${tenantId}.`,
          );
        }
      }
    }

    const rules: readonly FridayPolicyRule[] = input.rules
      ? input.rules.map((r) => ({
          id: generateId(),
          name: r.name,
          description: r.description,
          enabled: r.enabled ?? true,
          resource: r.resource,
          action: r.action,
          conditions: structuredClone(r.conditions),
          effect: r.effect,
          message: r.message,
          priority: r.priority ?? 100,
        }))
      : existing.rules;

    const updated: FridaySecurityPolicy = {
      ...existing,
      name: input.name ?? existing.name,
      description: input.description !== undefined ? input.description : existing.description,
      enabled: input.enabled ?? existing.enabled,
      priority: input.priority ?? existing.priority,
      rules,
      version: existing.version + 1,
      etag: generateEtag(),
      updatedAt: now(),
    };

    this.policies.set(policyId, updated);

    this.auditLogger.log({
      tenantId,
      action: "policy.update",
      resourceType: "policy",
      resourceId: policyId,
      decision: "allow",
      reason: `Policy '${updated.name}' updated to version ${updated.version}.`,
    });

    return cloneAndFreeze(updated);
  }

  /** Soft-delete a policy with optimistic concurrency and tenant isolation. */
  deletePolicy(tenantId: UUID, policyId: UUID, etag: string): FridaySecurityPolicy {
    const existing = this.getPolicy(tenantId, policyId);

    if (existing.etag !== etag) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ETAG_MISMATCH,
        `Etag mismatch for policy ${policyId}.`,
      );
    }

    const deleted: FridaySecurityPolicy = {
      ...existing,
      enabled: false,
      etag: generateEtag(),
      updatedAt: now(),
      deletedAt: now(),
    };

    this.policies.set(policyId, deleted);

    this.auditLogger.log({
      tenantId,
      action: "policy.delete",
      resourceType: "policy",
      resourceId: policyId,
      decision: "allow",
      reason: `Policy '${existing.name}' soft-deleted.`,
    });

    return cloneAndFreeze(deleted);
  }

  // ═══════════════════════════════════════════════════════════════
  // POLICY EVALUATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Evaluate all active policies for a tenant against a request context.
   *
   * Deny-by-default semantics:
   * - No matching rules → deny
   * - Any deny match → deny (deny wins)
   * - Only allow/warn matches → allow
   */
  evaluate(tenantId: UUID, context: PolicyEvaluationContext): FridayPolicyEvaluation {
    const startTime = performance.now();
    try {
      this.assertRequiredString(tenantId, "tenantId");
      this.assertEvaluationContext(context);

      const policies = this.listPolicies(tenantId, { enabled: true });
      const matchedRules: FridayMatchedPolicyRule[] = [];

      for (const policy of policies) {
        // Check if policy scope matches the request context
        if (!this.policyScopeMatches(policy, context)) continue;

        for (const rule of policy.rules) {
          if (!rule.enabled) continue;
          if (rule.resource !== context.resource || rule.action !== context.action) continue;
          if (!this.evaluateConditionGroup(rule.conditions, tenantId, context)) continue;

          matchedRules.push({
            ruleId: rule.id,
            ruleName: rule.name,
            policyId: policy.id,
            effect: rule.effect,
            message: rule.message,
            priority: rule.priority,
          });
        }
      }

      // Sort by priority (lower = higher priority)
      matchedRules.sort((a, b) => a.priority - b.priority);

      // Determine decision: deny-by-default, deny wins
      let decision: FridayPolicyDecision = "deny";
      let message: string | undefined;

      const hasDeny = matchedRules.some((r) => r.effect === "deny");
      const hasAllow = matchedRules.some((r) => r.effect === "allow" || r.effect === "warn");

      if (hasDeny) {
        decision = "deny";
        const denyRule = matchedRules.find((r) => r.effect === "deny");
        message = denyRule?.message ?? "Access denied by policy.";
      } else if (hasAllow) {
        decision = "allow";
        const allowRule = matchedRules.find((r) => r.effect === "allow" || r.effect === "warn");
        message = allowRule?.message;
      } else {
        message = "No matching policy — denied by default.";
      }

      const durationMs = Math.round((performance.now() - startTime) * 100) / 100;

      const evaluation: FridayPolicyEvaluation = {
        evaluationId: generateId(),
        decision,
        matchedRules,
        message,
        durationMs,
        allowed: decision === "allow",
        tenantId,
        principalId: context.principalId,
        resource: context.resource,
        action: context.action,
        evaluatedAt: now(),
      };

      // Audit log the evaluation
      this.auditLogger.log({
        tenantId,
        principalId: context.principalId,
        action: `policy.evaluate:${context.resource}:${context.action}`,
        resourceType: context.resource,
        resourceId: context.resourceId,
        decision: decision === "allow" ? "allow" : "deny",
        reason: message,
        metadata: {
          evaluationId: evaluation.evaluationId,
          matchedRuleCount: matchedRules.length,
          durationMs,
        },
      });

      // Log warn effects as separate audit entries
      for (const rule of matchedRules) {
        if (rule.effect !== "warn") continue;
        this.auditLogger.log({
          tenantId,
          principalId: context.principalId,
          action: `policy.warn:${context.resource}:${context.action}`,
          resourceType: context.resource,
          resourceId: context.resourceId,
          decision: "warn",
          reason: rule.message ?? `Rule '${rule.ruleName}' triggered a warning.`,
        });
      }

      return cloneAndFreeze(evaluation);
    } catch (error) {
      const denyEvaluation = this.buildErrorDenyEvaluation(tenantId, context, startTime, error);
      this.auditLogger.log({
        tenantId,
        principalId: context?.principalId,
        action: `policy.evaluate.error:${context?.resource ?? "unknown"}:${context?.action ?? "unknown"}`,
        resourceType: context?.resource ?? "policy",
        resourceId: context?.resourceId,
        decision: "deny",
        reason: denyEvaluation.message,
        metadata: {
          evaluationId: denyEvaluation.evaluationId,
          failClosed: true,
        },
      });
      return cloneAndFreeze(denyEvaluation);
    }
  }

  // ─── Internal Helpers ───

  /** Build a fail-closed deny evaluation when policy evaluation throws. */
  private buildErrorDenyEvaluation(
    tenantId: UUID,
    context: PolicyEvaluationContext,
    startTimeMs: number,
    error: unknown,
  ): FridayPolicyEvaluation {
    const durationMs = Math.round((performance.now() - startTimeMs) * 100) / 100;
    const message = error instanceof Error
      ? `Policy evaluation failed closed: ${error.message}`
      : "Policy evaluation failed closed: unknown error.";
    return {
      evaluationId: generateId(),
      decision: "deny",
      matchedRules: [],
      message,
      durationMs,
      allowed: false,
      tenantId,
      principalId: context?.principalId ?? "unknown",
      resource: context?.resource ?? "policy",
      action: context?.action ?? "read",
      evaluatedAt: now(),
    };
  }

  /** Validate required string fields for public evaluation boundaries. */
  private assertRequiredString(value: unknown, fieldName: string): asserts value is string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.VALIDATION_FAILED,
        `Missing required parameter '${fieldName}'.`,
      );
    }
  }

  /** Validate evaluation context before policy execution. */
  private assertEvaluationContext(context: PolicyEvaluationContext): void {
    if (!context || typeof context !== "object") {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.VALIDATION_FAILED,
        "Missing required policy evaluation context.",
      );
    }
    this.assertRequiredString(context.principalId, "context.principalId");
    this.assertRequiredString(context.resource, "context.resource");
    this.assertRequiredString(context.action, "context.action");
  }

  /** Check if a policy's scope matches the evaluation context. */
  private policyScopeMatches(
    policy: FridaySecurityPolicy,
    context: PolicyEvaluationContext,
  ): boolean {
    if (policy.scope.scopeType === "tenant") {
      return true; // Tenant-scoped policies apply to all workspaces
    }
    if (policy.scope.scopeType === "workspace") {
      return context.workspaceId === policy.scope.workspaceId;
    }
    return false;
  }

  /** Evaluate a condition group (all/any/none logic). */
  private evaluateConditionGroup(
    group: FridayPolicyConditionGroup,
    tenantId: UUID,
    context: PolicyEvaluationContext,
  ): boolean {
    const contextMap = this.buildContextMap(tenantId, context);

    if (group.all && group.all.length > 0) {
      if (!group.all.every((c) => this.evaluateCondition(c, contextMap))) return false;
    }

    if (group.any && group.any.length > 0) {
      if (!group.any.some((c) => this.evaluateCondition(c, contextMap))) return false;
    }

    if (group.none && group.none.length > 0) {
      if (group.none.some((c) => this.evaluateCondition(c, contextMap))) return false;
    }

    return true;
  }

  /** Build a flat context map for condition evaluation. */
  private buildContextMap(
    tenantId: UUID,
    context: PolicyEvaluationContext,
  ): Map<string, JsonValue> {
    const map = new Map<string, JsonValue>();
    map.set("principalId", context.principalId);
    map.set("tenantId", tenantId);
    map.set("resource", context.resource);
    map.set("action", context.action);
    if (context.resourceId) map.set("resourceId", context.resourceId);
    if (context.workspaceId) map.set("workspaceId", context.workspaceId);
    if (context.attributes) {
      for (const [key, value] of Object.entries(context.attributes)) {
        map.set(key, value);
      }
    }
    return map;
  }

  /**
   * Evaluate a single condition against the context.
   *
   * Supports the full operator set:
   * - Value operators: equals, not_equals, contains, matches, in, not_in, gt, gte, lt, lte
   * - Presence operators: exists, not_exists
   */
  private evaluateCondition(
    condition: FridayPolicyCondition,
    contextMap: Map<string, JsonValue>,
  ): boolean {
    const fieldValue = contextMap.get(condition.field);

    // Presence operators
    if (condition.operator === "exists") {
      return fieldValue !== undefined && fieldValue !== null;
    }
    if (condition.operator === "not_exists") {
      return fieldValue === undefined || fieldValue === null;
    }

    // Value operators require both field and condition value
    if (fieldValue === undefined || fieldValue === null) return false;
    const condValue = condition.value;
    // Fail-closed: if condition value is missing, deny (never fail-open)
    if (condValue === undefined || condValue === null) return false;

    switch (condition.operator) {
      case "equals":
        return fieldValue === condValue;

      case "not_equals":
        return fieldValue !== condValue;

      case "contains":
        if (typeof fieldValue === "string" && typeof condValue === "string") {
          return fieldValue.includes(condValue);
        }
        if (Array.isArray(fieldValue) && condValue !== undefined) {
          return fieldValue.includes(condValue);
        }
        return false;

      case "matches":
        if (typeof fieldValue === "string" && typeof condValue === "string") {
          try {
            return new RegExp(condValue).test(fieldValue);
          } catch (err) {
            console.warn("[friday][policy-engine] regex match failed:", err instanceof Error ? err.message : String(err));
            return false;
          }
        }
        return false;

      case "in":
        if (Array.isArray(condValue)) {
          return condValue.includes(fieldValue);
        }
        return false;

      case "not_in":
        if (Array.isArray(condValue)) {
          return !condValue.includes(fieldValue);
        }
        return false;

      case "gt":
        return typeof fieldValue === "number" && typeof condValue === "number" && fieldValue > condValue;

      case "gte":
        return typeof fieldValue === "number" && typeof condValue === "number" && fieldValue >= condValue;

      case "lt":
        return typeof fieldValue === "number" && typeof condValue === "number" && fieldValue < condValue;

      case "lte":
        return typeof fieldValue === "number" && typeof condValue === "number" && fieldValue <= condValue;

      default:
        return false;
    }
  }
}

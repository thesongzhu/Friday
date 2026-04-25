import { describe, it, expect, beforeEach } from "vitest";
import { PolicyEngine } from "../../../../../src/security/multi-tenant/engine/policy-engine.js";
import { AuditLogger } from "../../../../../src/security/multi-tenant/engine/audit-logger.js";
import { SecurityEngineError } from "../../../../../src/security/multi-tenant/engine/utils.js";
import { FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES } from "../../../../../src/security/multi-tenant/api/friday-multi-tenant-security-api.types.js";

describe("PolicyEngine", () => {
  let auditLogger: AuditLogger;
  let engine: PolicyEngine;
  const tenantId = "tenant-1";

  beforeEach(() => {
    auditLogger = new AuditLogger();
    engine = new PolicyEngine(auditLogger);
  });

  // ═══════════════════════════════════════════════════════════════
  // POLICY CRUD
  // ═══════════════════════════════════════════════════════════════

  describe("createPolicy()", () => {
    it("creates a policy with rules", () => {
      const policy = engine.createPolicy(tenantId, {
        name: "Secret Read Policy",
        description: "Allow admins to read secrets",
        rules: [
          {
            name: "admin-secret-read",
            resource: "secret",
            action: "read",
            conditions: {
              all: [{ field: "principalRole", operator: "in", value: ["tenant:admin"] }],
            },
            effect: "allow",
            message: "Admin can read secrets.",
          },
        ],
      });

      expect(policy.id).toBeTypeOf("string");
      expect(policy.tenantId).toBe(tenantId);
      expect(policy.name).toBe("Secret Read Policy");
      expect(policy.enabled).toBe(true);
      expect(policy.version).toBe(1);
      expect(policy.rules).toHaveLength(1);
      expect(policy.rules[0].name).toBe("admin-secret-read");
      expect(policy.rules[0].effect).toBe("allow");
      expect(policy.scope.scopeType).toBe("tenant");
    });

    it("defaults scope to tenant scope", () => {
      const policy = engine.createPolicy(tenantId, {
        name: "Default Scope",
        rules: [],
      });
      expect(policy.scope.scopeType).toBe("tenant");
    });

    it("rejects cross-tenant scope", () => {
      expect(() =>
        engine.createPolicy(tenantId, {
          name: "Bad Scope",
          scope: { scopeType: "tenant", tenantId: "other-tenant" },
          rules: [],
        }),
      ).toThrow(SecurityEngineError);
    });

    it("rejects unsafe regex conditions before policy storage", () => {
      expect(() =>
        engine.createPolicy(tenantId, {
          name: "Unsafe Regex",
          rules: [{
            name: "redos",
            resource: "secret",
            action: "read",
            conditions: {
              all: [{ field: "resourceId", operator: "matches", value: "(a+)+$" }],
            },
            effect: "allow",
          }],
        }),
      ).toThrow(SecurityEngineError);

      try {
        engine.createPolicy(tenantId, {
          name: "Unsafe Regex",
          rules: [{
            name: "redos",
            resource: "secret",
            action: "read",
            conditions: {
              all: [{ field: "resourceId", operator: "matches", value: "(a+)+$" }],
            },
            effect: "allow",
          }],
        });
      } catch (err) {
        expect((err as SecurityEngineError).code).toBe(
          FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.VALIDATION_FAILED,
        );
      }
    });

    it("uses POLICY_NAME_CONFLICT for duplicate policy names", () => {
      engine.createPolicy(tenantId, { name: "Duplicate", rules: [] });

      expect(() =>
        engine.createPolicy(tenantId, { name: "Duplicate", rules: [] }),
      ).toThrow(SecurityEngineError);
      try {
        engine.createPolicy(tenantId, { name: "Duplicate", rules: [] });
      } catch (err) {
        expect((err as SecurityEngineError).code).toBe(
          FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.POLICY_NAME_CONFLICT,
        );
      }
    });
  });

  describe("getPolicy() — tenant isolation", () => {
    it("retrieves a policy within the correct tenant", () => {
      const policy = engine.createPolicy(tenantId, { name: "Test", rules: [] });
      const fetched = engine.getPolicy(tenantId, policy.id);
      expect(fetched.id).toBe(policy.id);
    });

    it("rejects cross-tenant policy access", () => {
      const policy = engine.createPolicy(tenantId, { name: "Test", rules: [] });
      expect(() => engine.getPolicy("other-tenant", policy.id)).toThrow(SecurityEngineError);
      const denies = auditLogger.queryAuditLog({
        tenantId: "other-tenant",
        action: "policy.get",
        decision: "deny",
      });
      expect(denies).toHaveLength(1);
    });

    it("returns immutable policy snapshots", () => {
      const policy = engine.createPolicy(tenantId, { name: "Immutable", rules: [] });
      const fetched = engine.getPolicy(tenantId, policy.id);

      expect(Object.isFrozen(fetched)).toBe(true);
      expect(() => {
        (fetched as { name: string }).name = "mutated";
      }).toThrow(TypeError);
    });
  });

  describe("updatePolicy()", () => {
    it("updates a policy and increments version", () => {
      const policy = engine.createPolicy(tenantId, {
        name: "Original",
        rules: [{ name: "r1", resource: "secret", action: "read", conditions: {}, effect: "allow" }],
      });

      const updated = engine.updatePolicy(tenantId, policy.id, {
        name: "Updated",
        enabled: false,
        etag: policy.etag,
      });

      expect(updated.name).toBe("Updated");
      expect(updated.enabled).toBe(false);
      expect(updated.version).toBe(2);
      expect(updated.etag).not.toBe(policy.etag);
    });

    it("rejects update with stale etag", () => {
      const policy = engine.createPolicy(tenantId, { name: "Test", rules: [] });

      expect(() =>
        engine.updatePolicy(tenantId, policy.id, { name: "New", etag: "stale" }),
      ).toThrow(SecurityEngineError);
    });

    it("replaces rules when provided", () => {
      const policy = engine.createPolicy(tenantId, {
        name: "Test",
        rules: [{ name: "r1", resource: "secret", action: "read", conditions: {}, effect: "allow" }],
      });

      const updated = engine.updatePolicy(tenantId, policy.id, {
        rules: [
          { name: "r2", resource: "workspace", action: "write", conditions: {}, effect: "deny" },
          { name: "r3", resource: "role", action: "assign", conditions: {}, effect: "allow" },
        ],
        etag: policy.etag,
      });

      expect(updated.rules).toHaveLength(2);
      expect(updated.rules[0].name).toBe("r2");
    });

    it("uses POLICY_NAME_CONFLICT when renaming to an existing policy name", () => {
      const first = engine.createPolicy(tenantId, { name: "First", rules: [] });
      const second = engine.createPolicy(tenantId, { name: "Second", rules: [] });

      expect(() =>
        engine.updatePolicy(tenantId, second.id, {
          name: "First",
          etag: second.etag,
        }),
      ).toThrow(SecurityEngineError);
      try {
        engine.updatePolicy(tenantId, second.id, {
          name: "First",
          etag: second.etag,
        });
      } catch (err) {
        expect((err as SecurityEngineError).code).toBe(
          FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.POLICY_NAME_CONFLICT,
        );
      }
      expect(engine.getPolicy(tenantId, first.id).name).toBe("First");
    });
  });

  describe("deletePolicy()", () => {
    it("soft-deletes a policy", () => {
      const policy = engine.createPolicy(tenantId, { name: "Del", rules: [] });
      const deleted = engine.deletePolicy(tenantId, policy.id, policy.etag);

      expect(deleted.deletedAt).toBeTypeOf("string");
      expect(deleted.enabled).toBe(false);
    });
  });

  describe("listPolicies()", () => {
    it("returns policies for a tenant sorted by priority", () => {
      engine.createPolicy(tenantId, { name: "Low", priority: 200, rules: [] });
      engine.createPolicy(tenantId, { name: "High", priority: 50, rules: [] });
      engine.createPolicy("other-tenant", { name: "Other", rules: [] });

      const policies = engine.listPolicies(tenantId);
      expect(policies).toHaveLength(2);
      expect(policies[0].name).toBe("High");
      expect(policies[1].name).toBe("Low");
    });

    it("filters by enabled status", () => {
      const p = engine.createPolicy(tenantId, { name: "Active", rules: [] });
      engine.createPolicy(tenantId, { name: "Disabled", rules: [] });
      engine.updatePolicy(tenantId, p.id, { enabled: false, etag: p.etag });

      const enabled = engine.listPolicies(tenantId, { enabled: true });
      expect(enabled).toHaveLength(1);
      expect(enabled[0].name).toBe("Disabled"); // The one not updated
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // POLICY EVALUATION
  // ═══════════════════════════════════════════════════════════════

  describe("evaluate() — deny-by-default", () => {
    it("denies when no policies exist", () => {
      const result = engine.evaluate(tenantId, {
        principalId: "user-1",
        resource: "secret",
        action: "read",
      });

      expect(result.decision).toBe("deny");
      expect(result.allowed).toBe(false);
      expect(result.matchedRules).toHaveLength(0);
    });

    it("denies when no rules match", () => {
      engine.createPolicy(tenantId, {
        name: "Unrelated",
        rules: [{
          name: "r1",
          resource: "workspace",
          action: "write",
          conditions: {},
          effect: "allow",
        }],
      });

      const result = engine.evaluate(tenantId, {
        principalId: "user-1",
        resource: "secret",
        action: "read",
      });

      expect(result.decision).toBe("deny");
      expect(result.allowed).toBe(false);
    });

    it("allows when a matching allow rule exists", () => {
      engine.createPolicy(tenantId, {
        name: "Allow Reads",
        rules: [{
          name: "allow-secret-read",
          resource: "secret",
          action: "read",
          conditions: {},
          effect: "allow",
          message: "Allowed.",
        }],
      });

      const result = engine.evaluate(tenantId, {
        principalId: "user-1",
        resource: "secret",
        action: "read",
      });

      expect(result.decision).toBe("allow");
      expect(result.allowed).toBe(true);
      expect(result.matchedRules).toHaveLength(1);
    });

    it("deny wins over allow", () => {
      engine.createPolicy(tenantId, {
        name: "Allow",
        priority: 100,
        rules: [{
          name: "allow-read",
          resource: "secret",
          action: "read",
          conditions: {},
          effect: "allow",
        }],
      });

      engine.createPolicy(tenantId, {
        name: "Deny",
        priority: 50,
        rules: [{
          name: "deny-read",
          resource: "secret",
          action: "read",
          conditions: {},
          effect: "deny",
          message: "Denied by policy.",
        }],
      });

      const result = engine.evaluate(tenantId, {
        principalId: "user-1",
        resource: "secret",
        action: "read",
      });

      expect(result.decision).toBe("deny");
      expect(result.allowed).toBe(false);
    });

    it("warn is treated as allow", () => {
      engine.createPolicy(tenantId, {
        name: "Warn",
        rules: [{
          name: "warn-read",
          resource: "secret",
          action: "read",
          conditions: {},
          effect: "warn",
          message: "Proceeding with warning.",
        }],
      });

      const result = engine.evaluate(tenantId, {
        principalId: "user-1",
        resource: "secret",
        action: "read",
      });

      expect(result.decision).toBe("allow");
      expect(result.allowed).toBe(true);
    });
  });

  describe("evaluate() — condition evaluation", () => {
    it("evaluates 'equals' condition", () => {
      engine.createPolicy(tenantId, {
        name: "Equals",
        rules: [{
          name: "r1",
          resource: "secret",
          action: "read",
          conditions: {
            all: [{ field: "principalId", operator: "equals", value: "admin" }],
          },
          effect: "allow",
        }],
      });

      const allowed = engine.evaluate(tenantId, { principalId: "admin", resource: "secret", action: "read" });
      expect(allowed.decision).toBe("allow");

      const denied = engine.evaluate(tenantId, { principalId: "user", resource: "secret", action: "read" });
      expect(denied.decision).toBe("deny");
    });

    it("evaluates 'in' condition", () => {
      engine.createPolicy(tenantId, {
        name: "In",
        rules: [{
          name: "r1",
          resource: "secret",
          action: "read",
          conditions: {
            all: [{ field: "principalId", operator: "in", value: ["admin", "superadmin"] }],
          },
          effect: "allow",
        }],
      });

      const result1 = engine.evaluate(tenantId, { principalId: "admin", resource: "secret", action: "read" });
      expect(result1.decision).toBe("allow");

      const result2 = engine.evaluate(tenantId, { principalId: "user", resource: "secret", action: "read" });
      expect(result2.decision).toBe("deny");
    });

    it("evaluates 'not_equals' condition", () => {
      engine.createPolicy(tenantId, {
        name: "NotEquals",
        rules: [{
          name: "r1",
          resource: "secret",
          action: "read",
          conditions: {
            all: [{ field: "principalId", operator: "not_equals", value: "blocked-user" }],
          },
          effect: "allow",
        }],
      });

      const allowed = engine.evaluate(tenantId, { principalId: "normal-user", resource: "secret", action: "read" });
      expect(allowed.decision).toBe("allow");

      const denied = engine.evaluate(tenantId, { principalId: "blocked-user", resource: "secret", action: "read" });
      expect(denied.decision).toBe("deny");
    });

    it("evaluates 'exists' presence condition", () => {
      engine.createPolicy(tenantId, {
        name: "Exists",
        rules: [{
          name: "r1",
          resource: "secret",
          action: "read",
          conditions: {
            all: [{ field: "workspaceId", operator: "exists" }],
          },
          effect: "allow",
        }],
      });

      const withWs = engine.evaluate(tenantId, {
        principalId: "user",
        resource: "secret",
        action: "read",
        workspaceId: "ws-1",
      });
      expect(withWs.decision).toBe("allow");

      const withoutWs = engine.evaluate(tenantId, {
        principalId: "user",
        resource: "secret",
        action: "read",
      });
      expect(withoutWs.decision).toBe("deny");
    });

    it("evaluates 'not_exists' presence condition", () => {
      engine.createPolicy(tenantId, {
        name: "NotExists",
        rules: [{
          name: "r1",
          resource: "tenant",
          action: "read",
          conditions: {
            all: [{ field: "workspaceId", operator: "not_exists" }],
          },
          effect: "allow",
        }],
      });

      const result = engine.evaluate(tenantId, {
        principalId: "user",
        resource: "tenant",
        action: "read",
      });
      expect(result.decision).toBe("allow");
    });

    it("evaluates 'any' condition group (OR logic)", () => {
      engine.createPolicy(tenantId, {
        name: "Any",
        rules: [{
          name: "r1",
          resource: "secret",
          action: "read",
          conditions: {
            any: [
              { field: "principalId", operator: "equals", value: "admin" },
              { field: "principalId", operator: "equals", value: "superadmin" },
            ],
          },
          effect: "allow",
        }],
      });

      const r1 = engine.evaluate(tenantId, { principalId: "admin", resource: "secret", action: "read" });
      expect(r1.decision).toBe("allow");

      const r2 = engine.evaluate(tenantId, { principalId: "superadmin", resource: "secret", action: "read" });
      expect(r2.decision).toBe("allow");

      const r3 = engine.evaluate(tenantId, { principalId: "user", resource: "secret", action: "read" });
      expect(r3.decision).toBe("deny");
    });

    it("evaluates 'none' condition group (NOT ANY)", () => {
      engine.createPolicy(tenantId, {
        name: "None",
        rules: [{
          name: "r1",
          resource: "secret",
          action: "read",
          conditions: {
            none: [
              { field: "principalId", operator: "equals", value: "blocked" },
            ],
          },
          effect: "allow",
        }],
      });

      const allowed = engine.evaluate(tenantId, { principalId: "user", resource: "secret", action: "read" });
      expect(allowed.decision).toBe("allow");

      const denied = engine.evaluate(tenantId, { principalId: "blocked", resource: "secret", action: "read" });
      expect(denied.decision).toBe("deny");
    });

    it("evaluates 'contains' condition on strings", () => {
      engine.createPolicy(tenantId, {
        name: "Contains",
        rules: [{
          name: "r1",
          resource: "secret",
          action: "read",
          conditions: {
            all: [{ field: "principalId", operator: "contains", value: "admin" }],
          },
          effect: "allow",
        }],
      });

      const r1 = engine.evaluate(tenantId, { principalId: "superadmin", resource: "secret", action: "read" });
      expect(r1.decision).toBe("allow");

      const r2 = engine.evaluate(tenantId, { principalId: "user", resource: "secret", action: "read" });
      expect(r2.decision).toBe("deny");
    });

    it("evaluates safe 'matches' conditions through the bounded regex compiler", () => {
      engine.createPolicy(tenantId, {
        name: "Matches",
        rules: [{
          name: "r1",
          resource: "secret",
          action: "read",
          conditions: {
            all: [{ field: "resourceId", operator: "matches", value: "^secret-[0-9]+$" }],
          },
          effect: "allow",
        }],
      });

      const allowed = engine.evaluate(tenantId, {
        principalId: "user",
        resource: "secret",
        action: "read",
        resourceId: "secret-123",
      });
      expect(allowed.decision).toBe("allow");

      const denied = engine.evaluate(tenantId, {
        principalId: "user",
        resource: "secret",
        action: "read",
        resourceId: "token-123",
      });
      expect(denied.decision).toBe("deny");
    });

    it("evaluates numeric comparisons (gt, gte, lt, lte)", () => {
      engine.createPolicy(tenantId, {
        name: "Numeric",
        rules: [{
          name: "r1",
          resource: "secret",
          action: "read",
          conditions: {
            all: [{ field: "priority", operator: "gte", value: 5 }],
          },
          effect: "allow",
        }],
      });

      const high = engine.evaluate(tenantId, {
        principalId: "user",
        resource: "secret",
        action: "read",
        attributes: { priority: 10 },
      });
      expect(high.decision).toBe("allow");

      const low = engine.evaluate(tenantId, {
        principalId: "user",
        resource: "secret",
        action: "read",
        attributes: { priority: 3 },
      });
      expect(low.decision).toBe("deny");
    });

    it("treats not_in with non-array condition value as false", () => {
      engine.createPolicy(tenantId, {
        name: "NotInValueType",
        rules: [{
          name: "r1",
          resource: "secret",
          action: "read",
          conditions: {
            all: [{ field: "principalId", operator: "not_in", value: "admin" }],
          },
          effect: "allow",
        }],
      });

      const result = engine.evaluate(tenantId, {
        principalId: "user",
        resource: "secret",
        action: "read",
      });
      expect(result.decision).toBe("deny");
    });
  });

  describe("evaluate() — workspace-scoped policies", () => {
    it("only applies to matching workspace", () => {
      engine.createPolicy(tenantId, {
        name: "WS Policy",
        scope: { scopeType: "workspace", tenantId, workspaceId: "ws-1" },
        rules: [{
          name: "r1",
          resource: "secret",
          action: "read",
          conditions: {},
          effect: "allow",
        }],
      });

      const inScope = engine.evaluate(tenantId, {
        principalId: "user",
        resource: "secret",
        action: "read",
        workspaceId: "ws-1",
      });
      expect(inScope.decision).toBe("allow");

      const outOfScope = engine.evaluate(tenantId, {
        principalId: "user",
        resource: "secret",
        action: "read",
        workspaceId: "ws-2",
      });
      expect(outOfScope.decision).toBe("deny");
    });
  });

  describe("evaluate() — audit integration", () => {
    it("generates audit entries for evaluations", () => {
      engine.createPolicy(tenantId, {
        name: "Audit Test",
        rules: [{
          name: "r1",
          resource: "secret",
          action: "read",
          conditions: {},
          effect: "allow",
        }],
      });

      engine.evaluate(tenantId, {
        principalId: "user-1",
        resource: "secret",
        action: "read",
      });

      const entries = auditLogger.queryAuditLog({
        tenantId,
        action: "policy.evaluate:secret:read",
      });
      expect(entries.length).toBeGreaterThanOrEqual(1);
    });

    it("includes evaluation metadata in audit", () => {
      engine.createPolicy(tenantId, {
        name: "Meta Test",
        rules: [{
          name: "r1",
          resource: "secret",
          action: "read",
          conditions: {},
          effect: "allow",
        }],
      });

      const result = engine.evaluate(tenantId, {
        principalId: "user-1",
        resource: "secret",
        action: "read",
      });

      expect(result.evaluationId).toBeTypeOf("string");
      expect(result.durationMs).toBeTypeOf("number");
      expect(result.evaluatedAt).toBeTypeOf("string");
    });

    it("emits audit on error fail-closed path", () => {
      engine.createPolicy(tenantId, {
        name: "Error Path",
        rules: [{
          name: "r1",
          resource: "secret",
          action: "read",
          conditions: {},
          effect: "allow",
        }],
      });

      Reflect.set(engine as object, "evaluateConditionGroup", () => {
        throw new Error("Injected condition error");
      });

      const result = engine.evaluate(tenantId, {
        principalId: "user-1",
        resource: "secret",
        action: "read",
      });

      expect(result.decision).toBe("deny");
      expect(result.allowed).toBe(false);
      expect(result.message).toContain("failed closed");

      const errorAudit = auditLogger.queryAuditLog({
        tenantId,
        action: "policy.evaluate.error:secret:read",
        decision: "deny",
      });
      expect(errorAudit).toHaveLength(1);
    });
  });

  describe("evaluate() — disabled rules/policies", () => {
    it("skips disabled rules", () => {
      engine.createPolicy(tenantId, {
        name: "Disabled Rule",
        rules: [{
          name: "r1",
          resource: "secret",
          action: "read",
          conditions: {},
          effect: "allow",
          enabled: false,
        }],
      });

      const result = engine.evaluate(tenantId, {
        principalId: "user",
        resource: "secret",
        action: "read",
      });
      expect(result.decision).toBe("deny");
    });

    it("skips disabled policies", () => {
      const policy = engine.createPolicy(tenantId, {
        name: "To Disable",
        rules: [{ name: "r1", resource: "secret", action: "read", conditions: {}, effect: "allow" }],
      });
      engine.updatePolicy(tenantId, policy.id, { enabled: false, etag: policy.etag });

      const result = engine.evaluate(tenantId, {
        principalId: "user",
        resource: "secret",
        action: "read",
      });
      expect(result.decision).toBe("deny");
    });
  });

  describe("evaluate() — fail-closed behavior", () => {
    it("returns deny when condition evaluation throws", () => {
      engine.createPolicy(tenantId, {
        name: "Fail Closed",
        rules: [{
          name: "allow-rule",
          resource: "secret",
          action: "read",
          conditions: {},
          effect: "allow",
        }],
      });

      Reflect.set(engine as object, "evaluateConditionGroup", () => {
        throw new Error("Condition eval exploded");
      });

      const result = engine.evaluate(tenantId, {
        principalId: "user",
        resource: "secret",
        action: "read",
      });

      expect(result.decision).toBe("deny");
      expect(result.allowed).toBe(false);
      expect(result.matchedRules).toHaveLength(0);
    });
  });
});

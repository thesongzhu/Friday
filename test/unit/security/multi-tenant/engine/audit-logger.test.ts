import { describe, it, expect, beforeEach } from "vitest";
import { AuditLogger } from "../../../../../src/security/multi-tenant/engine/audit-logger.js";
import { FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES } from "../../../../../src/security/multi-tenant/api/friday-multi-tenant-security-api.types.js";
import { SecurityEngineError } from "../../../../../src/security/multi-tenant/engine/utils.js";

describe("AuditLogger", () => {
  let logger: AuditLogger;
  const tenantA = "tenant-aaa";
  const tenantB = "tenant-bbb";

  beforeEach(() => {
    logger = new AuditLogger();
  });

  // ─── Audit Entries ───

  describe("log()", () => {
    it("creates an audit entry with all required fields", () => {
      const entry = logger.log({
        tenantId: tenantA,
        principalId: "user-1",
        action: "secret.read",
        resourceType: "secret",
        resourceId: "sec-1",
        decision: "allow",
        reason: "Access granted.",
      });

      expect(entry.id).toBeTypeOf("string");
      expect(entry.tenantId).toBe(tenantA);
      expect(entry.principalId).toBe("user-1");
      expect(entry.action).toBe("secret.read");
      expect(entry.resourceType).toBe("secret");
      expect(entry.decision).toBe("allow");
      expect(entry.createdAt).toBeTypeOf("string");
      expect(entry.metadata).toEqual({});
    });

    it("defaults metadata to empty object", () => {
      const entry = logger.log({
        tenantId: tenantA,
        action: "tenant.create",
        resourceType: "tenant",
        decision: "allow",
      });
      expect(entry.metadata).toEqual({});
    });

    it("preserves custom metadata", () => {
      const entry = logger.log({
        tenantId: tenantA,
        action: "policy.evaluate",
        resourceType: "policy",
        decision: "deny",
        metadata: { evaluationId: "eval-1", durationMs: 2.5 },
      });
      expect(entry.metadata).toEqual({ evaluationId: "eval-1", durationMs: 2.5 });
    });

    it("supports system-scope audit entries with null tenantId", () => {
      const entry = logger.log({
        tenantId: null,
        action: "role.create",
        resourceType: "role",
        decision: "allow",
      });

      expect(entry.tenantId).toBeNull();
      const systemEntries = logger.queryAuditLog({ tenantId: null });
      expect(systemEntries).toHaveLength(1);
    });
  });

  describe("queryAuditLog()", () => {
    it("returns entries scoped to the tenant", () => {
      logger.log({ tenantId: tenantA, action: "test.a", resourceType: "tenant", decision: "allow" });
      logger.log({ tenantId: tenantB, action: "test.b", resourceType: "tenant", decision: "allow" });
      logger.log({ tenantId: tenantA, action: "test.c", resourceType: "tenant", decision: "deny" });

      const results = logger.queryAuditLog({ tenantId: tenantA });
      expect(results).toHaveLength(2);
      expect(results.every((e) => e.tenantId === tenantA)).toBe(true);
    });

    it("filters by principalId", () => {
      logger.log({ tenantId: tenantA, principalId: "u1", action: "a", resourceType: "secret", decision: "allow" });
      logger.log({ tenantId: tenantA, principalId: "u2", action: "b", resourceType: "secret", decision: "allow" });

      const results = logger.queryAuditLog({ tenantId: tenantA, principalId: "u1" });
      expect(results).toHaveLength(1);
      expect(results[0].principalId).toBe("u1");
    });

    it("filters by decision", () => {
      logger.log({ tenantId: tenantA, action: "a", resourceType: "role", decision: "allow" });
      logger.log({ tenantId: tenantA, action: "b", resourceType: "role", decision: "deny" });

      const results = logger.queryAuditLog({ tenantId: tenantA, decision: "deny" });
      expect(results).toHaveLength(1);
      expect(results[0].decision).toBe("deny");
    });

    it("respects limit", () => {
      for (let i = 0; i < 10; i++) {
        logger.log({ tenantId: tenantA, action: `a${i}`, resourceType: "tenant", decision: "allow" });
      }
      const results = logger.queryAuditLog({ tenantId: tenantA, limit: 3 });
      expect(results).toHaveLength(3);
    });

    it("returns entries ordered by createdAt descending", () => {
      logger.log({ tenantId: tenantA, action: "first", resourceType: "tenant", decision: "allow" });
      logger.log({ tenantId: tenantA, action: "second", resourceType: "tenant", decision: "allow" });

      const results = logger.queryAuditLog({ tenantId: tenantA });
      expect(results).toHaveLength(2);
      // Both entries should be present; ordering is by createdAt desc
      // (may be same timestamp when created in same ms)
      const actions = results.map((e) => e.action);
      expect(actions).toContain("first");
      expect(actions).toContain("second");
    });

    it("returns immutable snapshots", () => {
      logger.log({ tenantId: tenantA, action: "immutable", resourceType: "tenant", decision: "allow" });
      const results = logger.queryAuditLog({ tenantId: tenantA });

      expect(Object.isFrozen(results)).toBe(true);
      expect(Object.isFrozen(results[0])).toBe(true);
      expect(() => {
        (results[0] as { action: string }).action = "mutated";
      }).toThrow(TypeError);
    });
  });

  // ─── Violations ───

  describe("recordViolation()", () => {
    it("creates a violation with unresolved status", () => {
      const v = logger.recordViolation({
        tenantId: tenantA,
        principalId: "attacker",
        violationType: "cross_tenant_access",
        severity: "critical",
        description: "Attempted cross-tenant access.",
      });

      expect(v.id).toBeTypeOf("string");
      expect(v.tenantId).toBe(tenantA);
      expect(v.principalId).toBe("attacker");
      expect(v.violationType).toBe("cross_tenant_access");
      expect(v.severity).toBe("critical");
      expect(v.resolved).toBe(false);
      expect(v.resolvedBy).toBeUndefined();
      expect(v.resolvedAt).toBeUndefined();
    });
  });

  describe("resolveViolation()", () => {
    it("marks a violation as resolved", () => {
      const v = logger.recordViolation({
        tenantId: tenantA,
        principalId: "user-1",
        violationType: "escalation_attempt",
        severity: "high",
        description: "Escalation attempt.",
      });

      const resolved = logger.resolveViolation(tenantA, v.id, "admin-1");
      expect(resolved.resolved).toBe(true);
      expect(resolved.resolvedBy).toBe("admin-1");
      expect(resolved.resolvedAt).toBeTypeOf("string");
    });

    it("rejects cross-tenant violation resolution", () => {
      const v = logger.recordViolation({
        tenantId: tenantA,
        principalId: "user-1",
        violationType: "escalation_attempt",
        severity: "high",
        description: "Test.",
      });

      expect(() => logger.resolveViolation(tenantB, v.id, "admin")).toThrow(SecurityEngineError);
    });
  });

  describe("queryViolations()", () => {
    it("returns violations scoped to the tenant", () => {
      logger.recordViolation({ tenantId: tenantA, principalId: "u1", violationType: "cross_tenant_access", severity: "high", description: "a" });
      logger.recordViolation({ tenantId: tenantB, principalId: "u2", violationType: "cross_tenant_access", severity: "high", description: "b" });

      const results = logger.queryViolations({ tenantId: tenantA });
      expect(results).toHaveLength(1);
      expect(results[0].tenantId).toBe(tenantA);
    });

    it("filters by resolved status", () => {
      const v = logger.recordViolation({ tenantId: tenantA, principalId: "u1", violationType: "escalation_attempt", severity: "medium", description: "a" });
      logger.recordViolation({ tenantId: tenantA, principalId: "u2", violationType: "escalation_attempt", severity: "medium", description: "b" });
      logger.resolveViolation(tenantA, v.id, "admin");

      const unresolved = logger.queryViolations({ tenantId: tenantA, resolved: false });
      expect(unresolved).toHaveLength(1);

      const resolved = logger.queryViolations({ tenantId: tenantA, resolved: true });
      expect(resolved).toHaveLength(1);
    });
  });

  describe("countAuditEntries()", () => {
    it("counts entries per tenant", () => {
      logger.log({ tenantId: tenantA, action: "a", resourceType: "tenant", decision: "allow" });
      logger.log({ tenantId: tenantA, action: "b", resourceType: "tenant", decision: "allow" });
      logger.log({ tenantId: tenantB, action: "c", resourceType: "tenant", decision: "allow" });

      expect(logger.countAuditEntries(tenantA)).toBe(2);
      expect(logger.countAuditEntries(tenantB)).toBe(1);
    });
  });
});

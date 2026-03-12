/**
 * B-010 Security-Observability Convergence Bridge — Unit Tests
 *
 * Validates security audit → observability mapping, violation forwarding,
 * trust decision forwarding, filtering, and statistics.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createSecurityObservabilityBridge,
  type FridaySecurityObservabilityBridge,
} from "../../../../../src/security/multi-tenant/engine/friday-security-observability-bridge.js";
import type {
  FridaySecurityAuditEntry,
  FridaySecurityViolation,
  ISODateTime,
  UUID,
} from "../../../../../src/security/multi-tenant/model/friday-multi-tenant-security.types.js";
import type { TrustDecision } from "../../../../../src/security/multi-tenant/engine/friday-package-trust-policy.js";

// ─── Helpers ───

const T0 = "2026-01-15T00:00:00.000Z" as ISODateTime;

function makeAuditEntry(overrides: Partial<FridaySecurityAuditEntry> = {}): FridaySecurityAuditEntry {
  return {
    id: "audit-1" as UUID,
    tenantId: "tenant-1" as UUID,
    principalId: "user-alice",
    action: "rbac.permission.check:secret:read",
    resourceType: "secret",
    resourceId: "secret-42",
    decision: "deny",
    reason: "Permission denied. No matching effective RBAC permission.",
    ipAddress: "192.168.1.100",
    userAgent: "FridayCLI/1.0",
    sessionId: "sess-abc",
    metadata: { effectivePermissionCount: 3 },
    createdAt: T0,
    ...overrides,
  };
}

function makeViolation(overrides: Partial<FridaySecurityViolation> = {}): FridaySecurityViolation {
  return {
    id: "viol-1" as UUID,
    tenantId: "tenant-1" as UUID,
    principalId: "user-eve",
    violationType: "cross_tenant_access",
    severity: "critical",
    description: "Attempted access to resource in tenant-2 from tenant-1 context.",
    resourceType: "secret",
    resourceId: "secret-99",
    actionAttempted: "secret.read",
    ipAddress: "10.0.0.5",
    resolved: false,
    metadata: {},
    createdAt: T0,
    ...overrides,
  };
}

function makeTrustDecision(overrides: Partial<TrustDecision> = {}): TrustDecision {
  return {
    allowed: false,
    outcome: "untrusted_key",
    reason: "Signing key \"k-unknown\" is not in the trust store",
    keyId: "k-unknown",
    policyMode: "strict",
    evaluatedAt: T0,
    subjectId: "@friday/bad-pkg",
    subjectVersion: "1.0.0",
    subjectType: "package",
    ...overrides,
  };
}

// ─── Tests ───

describe("B-010 FridaySecurityObservabilityBridge", () => {
  let bridge: FridaySecurityObservabilityBridge;

  beforeEach(() => {
    bridge = createSecurityObservabilityBridge();
  });

  // ═══════════════════════════════════════════════════════════════
  // SECURITY AUDIT ENTRY CONVERSION
  // ═══════════════════════════════════════════════════════════════

  describe("convertSecurityAuditEntry", () => {
    it("converts a deny entry with full field mapping", () => {
      const entry = makeAuditEntry();
      const converted = bridge.convertSecurityAuditEntry(entry)!;

      expect(converted).not.toBeNull();
      expect(converted.actor.type).toBe("user");
      expect(converted.actor.id).toBe("user-alice");
      expect(converted.actor.displayName).toBe("user-alice");
      expect(converted.actor.ip).toBe("192.168.1.100");
      expect(converted.actor.userAgent).toBe("FridayCLI/1.0");
      expect(converted.actionCategory).toBe("authorize");
      expect(converted.action).toBe("security.rbac.permission.check:secret:read");
      expect(converted.resource.type).toBe("credential");
      expect(converted.resource.id).toBe("secret-42");
      expect(converted.outcome).toBe("denied");
      expect(converted.description).toContain("Permission denied");
      expect(converted.module).toBe("auth");
      expect(converted.errorCode).toBe("SECURITY_DENY");
      expect(converted.errorMessage).toContain("Permission denied");
      expect(converted.traceId).toBe("sess-abc");
      expect(converted.metadata!.securityEntryId).toBe("audit-1");
      expect(converted.metadata!.securityDecision).toBe("deny");
      expect(converted.metadata!.tenantId).toBe("tenant-1");
    });

    it("converts error decisions", () => {
      const entry = makeAuditEntry({ decision: "error", reason: "Policy evaluation failed" });
      const converted = bridge.convertSecurityAuditEntry(entry)!;

      expect(converted.outcome).toBe("error");
      expect(converted.errorCode).toBe("SECURITY_ERROR");
    });

    it("filters out allow decisions in deny_only mode", () => {
      const entry = makeAuditEntry({ decision: "allow" });
      expect(bridge.convertSecurityAuditEntry(entry)).toBeNull();
    });

    it("filters out warn decisions in deny_only mode", () => {
      const entry = makeAuditEntry({ decision: "warn" });
      expect(bridge.convertSecurityAuditEntry(entry)).toBeNull();
    });

    it("infers actor type from principalId prefix", () => {
      // Workflow prefix
      const wf = bridge.convertSecurityAuditEntry(
        makeAuditEntry({ principalId: "wf-exec-123" }),
      )!;
      expect(wf.actor.type).toBe("workflow");

      // Agent prefix
      const agent = bridge.convertSecurityAuditEntry(
        makeAuditEntry({ principalId: "agent-runner" }),
      )!;
      expect(agent.actor.type).toBe("agent");

      // API key prefix
      const apiKey = bridge.convertSecurityAuditEntry(
        makeAuditEntry({ principalId: "ak-service-key" }),
      )!;
      expect(apiKey.actor.type).toBe("api_key");

      // System
      const sys = bridge.convertSecurityAuditEntry(
        makeAuditEntry({ principalId: "system" }),
      )!;
      expect(sys.actor.type).toBe("system");
    });

    it("uses system actor when principalId is missing", () => {
      const entry = makeAuditEntry({ principalId: undefined });
      const converted = bridge.convertSecurityAuditEntry(entry)!;
      expect(converted.actor.type).toBe("system");
      expect(converted.actor.id).toBe("system");
    });

    it("maps resource types correctly", () => {
      const secret = bridge.convertSecurityAuditEntry(makeAuditEntry({ resourceType: "secret" }))!;
      expect(secret.resource.type).toBe("credential");

      const policy = bridge.convertSecurityAuditEntry(makeAuditEntry({ resourceType: "policy" }))!;
      expect(policy.resource.type).toBe("policy");

      const role = bridge.convertSecurityAuditEntry(makeAuditEntry({ resourceType: "role" }))!;
      expect(role.resource.type).toBe("preference");

      const workflow = bridge.convertSecurityAuditEntry(makeAuditEntry({ resourceType: "workflow" }))!;
      expect(workflow.resource.type).toBe("workflow");
    });

    it("derives action category from action string", () => {
      const rbac = bridge.convertSecurityAuditEntry(
        makeAuditEntry({ action: "rbac.permission.check:secret:read" }),
      )!;
      expect(rbac.actionCategory).toBe("authorize");

      const policy = bridge.convertSecurityAuditEntry(
        makeAuditEntry({ action: "policy.evaluate:secret:read" }),
      )!;
      expect(policy.actionCategory).toBe("execute");

      const isolation = bridge.convertSecurityAuditEntry(
        makeAuditEntry({ action: "tenant.isolation.boundary" }),
      )!;
      expect(isolation.actionCategory).toBe("authorize");
    });

    it("includes metadata from original entry", () => {
      const entry = makeAuditEntry({ metadata: { durationMs: 42, matchedRuleCount: 2 } });
      const converted = bridge.convertSecurityAuditEntry(entry)!;
      expect(converted.metadata!.durationMs).toBe(42);
      expect(converted.metadata!.matchedRuleCount).toBe(2);
    });

    it("handles missing optional fields gracefully", () => {
      const entry = makeAuditEntry({
        resourceId: undefined,
        reason: undefined,
        ipAddress: undefined,
        userAgent: undefined,
        sessionId: undefined,
        tenantId: null,
      });
      const converted = bridge.convertSecurityAuditEntry(entry)!;
      expect(converted.resource.id).toBe("secret-unknown");
      expect(converted.description).toContain("deny");
      expect(converted.actor.ip).toBeUndefined();
      expect(converted.traceId).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SECURITY VIOLATION CONVERSION
  // ═══════════════════════════════════════════════════════════════

  describe("convertSecurityViolation", () => {
    it("converts a critical violation with full mapping", () => {
      const violation = makeViolation();
      const converted = bridge.convertSecurityViolation(violation)!;

      expect(converted).not.toBeNull();
      expect(converted.actor.id).toBe("user-eve");
      expect(converted.actionCategory).toBe("authorize");
      expect(converted.action).toBe("security.violation.cross_tenant_access");
      expect(converted.resource.type).toBe("credential");
      expect(converted.resource.id).toBe("secret-99");
      expect(converted.outcome).toBe("denied");
      expect(converted.errorCode).toBe("VIOLATION_CROSS_TENANT_ACCESS");
      expect(converted.errorMessage).toContain("CRITICAL");
      expect(converted.metadata!.violationId).toBe("viol-1");
      expect(converted.metadata!.violationType).toBe("cross_tenant_access");
      expect(converted.metadata!.severity).toBe("critical");
      expect(converted.metadata!.tenantId).toBe("tenant-1");
      expect(converted.metadata!.actionAttempted).toBe("secret.read");
    });

    it("handles violation without resource type", () => {
      const violation = makeViolation({ resourceType: undefined, resourceId: undefined });
      const converted = bridge.convertSecurityViolation(violation)!;
      expect(converted.resource.type).toBe("policy");
      expect(converted.resource.id).toBe("unknown");
      expect(converted.resource.displayName).toBe("security-boundary");
    });

    it("filters low-severity violations when minViolationSeverity is high", () => {
      bridge.updateConfig({ minViolationSeverity: "high" });

      const lowViol = makeViolation({ severity: "low" });
      expect(bridge.convertSecurityViolation(lowViol)).toBeNull();

      const medViol = makeViolation({ severity: "medium" });
      expect(bridge.convertSecurityViolation(medViol)).toBeNull();

      const highViol = makeViolation({ severity: "high" });
      expect(bridge.convertSecurityViolation(highViol)).not.toBeNull();

      const critViol = makeViolation({ severity: "critical" });
      expect(bridge.convertSecurityViolation(critViol)).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // TRUST DECISION CONVERSION
  // ═══════════════════════════════════════════════════════════════

  describe("convertTrustDecision", () => {
    it("converts a denied trust decision", () => {
      const decision = makeTrustDecision();
      const converted = bridge.convertTrustDecision(decision, "tenant-1")!;

      expect(converted).not.toBeNull();
      expect(converted.actor.type).toBe("system");
      expect(converted.actor.id).toBe("trust-policy-engine");
      expect(converted.actionCategory).toBe("authorize");
      expect(converted.action).toBe("security.trust.package.evaluate");
      expect(converted.resource.type).toBe("policy");
      expect(converted.resource.id).toBe("@friday/bad-pkg");
      expect(converted.resource.displayName).toContain("1.0.0");
      expect(converted.outcome).toBe("denied");
      expect(converted.errorCode).toBe("TRUST_UNTRUSTED_KEY");
      expect(converted.metadata!.trustOutcome).toBe("untrusted_key");
      expect(converted.metadata!.policyMode).toBe("strict");
      expect(converted.metadata!.tenantId).toBe("tenant-1");
    });

    it("filters allowed trust decisions in deny_only mode", () => {
      const decision = makeTrustDecision({ allowed: true, outcome: "trusted" });
      expect(bridge.convertTrustDecision(decision)).toBeNull();
    });

    it("returns null when trust forwarding is disabled", () => {
      bridge.updateConfig({ forwardTrustDecisions: false });
      const decision = makeTrustDecision();
      expect(bridge.convertTrustDecision(decision)).toBeNull();
    });

    it("converts plugin trust decision", () => {
      const decision = makeTrustDecision({
        subjectType: "plugin",
        subjectId: "plugin-weather",
        outcome: "signature_invalid",
        reason: "Marketplace plugin signature verification failed",
      });
      const converted = bridge.convertTrustDecision(decision)!;
      expect(converted.action).toBe("security.trust.plugin.evaluate");
      expect(converted.resource.displayName).toContain("plugin-weather");
    });

    it("includes keyId in metadata when present", () => {
      const decision = makeTrustDecision({ keyId: "k-123" });
      const converted = bridge.convertTrustDecision(decision)!;
      expect(converted.metadata!.keyId).toBe("k-123");
    });

    it("omits keyId from metadata when not present", () => {
      const decision = makeTrustDecision({ keyId: undefined });
      const converted = bridge.convertTrustDecision(decision)!;
      expect(converted.metadata!).not.toHaveProperty("keyId");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // FILTER MODES
  // ═══════════════════════════════════════════════════════════════

  describe("filter modes", () => {
    it("deny_only forwards deny and error, filters allow and warn", () => {
      bridge.updateConfig({ filterMode: "deny_only" });

      expect(bridge.convertSecurityAuditEntry(makeAuditEntry({ decision: "deny" }))).not.toBeNull();
      expect(bridge.convertSecurityAuditEntry(makeAuditEntry({ decision: "error" }))).not.toBeNull();
      expect(bridge.convertSecurityAuditEntry(makeAuditEntry({ decision: "allow" }))).toBeNull();
      expect(bridge.convertSecurityAuditEntry(makeAuditEntry({ decision: "warn" }))).toBeNull();
    });

    it("deny_and_warn forwards deny, warn, and error, filters allow", () => {
      bridge.updateConfig({ filterMode: "deny_and_warn" });

      expect(bridge.convertSecurityAuditEntry(makeAuditEntry({ decision: "deny" }))).not.toBeNull();
      expect(bridge.convertSecurityAuditEntry(makeAuditEntry({ decision: "warn" }))).not.toBeNull();
      expect(bridge.convertSecurityAuditEntry(makeAuditEntry({ decision: "error" }))).not.toBeNull();
      expect(bridge.convertSecurityAuditEntry(makeAuditEntry({ decision: "allow" }))).toBeNull();
    });

    it("all mode forwards everything", () => {
      bridge.updateConfig({ filterMode: "all" });

      expect(bridge.convertSecurityAuditEntry(makeAuditEntry({ decision: "deny" }))).not.toBeNull();
      expect(bridge.convertSecurityAuditEntry(makeAuditEntry({ decision: "warn" }))).not.toBeNull();
      expect(bridge.convertSecurityAuditEntry(makeAuditEntry({ decision: "error" }))).not.toBeNull();
      expect(bridge.convertSecurityAuditEntry(makeAuditEntry({ decision: "allow" }))).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ═══════════════════════════════════════════════════════════════

  describe("configuration", () => {
    it("has sensible defaults", () => {
      const cfg = bridge.getConfig();
      expect(cfg.filterMode).toBe("deny_only");
      expect(cfg.minViolationSeverity).toBe("low");
      expect(cfg.forwardTrustDecisions).toBe(true);
      expect(cfg.defaultActorType).toBe("user");
    });

    it("accepts initial config from deps", () => {
      const b = createSecurityObservabilityBridge({
        config: { filterMode: "all", minViolationSeverity: "high" },
      });
      const cfg = b.getConfig();
      expect(cfg.filterMode).toBe("all");
      expect(cfg.minViolationSeverity).toBe("high");
      expect(cfg.forwardTrustDecisions).toBe(true); // default preserved
    });

    it("can be updated at runtime", () => {
      bridge.updateConfig({ filterMode: "deny_and_warn" });
      expect(bridge.getConfig().filterMode).toBe("deny_and_warn");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // STATISTICS
  // ═══════════════════════════════════════════════════════════════

  describe("statistics", () => {
    it("tracks forwarded and filtered counts", () => {
      bridge.convertSecurityAuditEntry(makeAuditEntry({ decision: "deny" }));  // forwarded
      bridge.convertSecurityAuditEntry(makeAuditEntry({ decision: "allow" })); // filtered
      bridge.convertSecurityViolation(makeViolation());                          // forwarded
      bridge.convertTrustDecision(makeTrustDecision());                          // forwarded

      const stats = bridge.getStats();
      expect(stats.totalForwarded).toBe(3);
      expect(stats.totalFiltered).toBe(1);
      expect(stats.auditEntriesForwarded).toBe(1);
      expect(stats.violationsForwarded).toBe(1);
      expect(stats.trustDecisionsForwarded).toBe(1);
      expect(stats.byOutcome.denied).toBe(3);
      expect(stats.filterMode).toBe("deny_only");
    });

    it("resets statistics", () => {
      bridge.convertSecurityAuditEntry(makeAuditEntry());
      bridge.resetStats();

      const stats = bridge.getStats();
      expect(stats.totalForwarded).toBe(0);
      expect(stats.totalFiltered).toBe(0);
      expect(stats.byOutcome.denied).toBe(0);
    });

    it("tracks outcome breakdown correctly in all mode", () => {
      bridge.updateConfig({ filterMode: "all" });

      bridge.convertSecurityAuditEntry(makeAuditEntry({ decision: "allow" }));
      bridge.convertSecurityAuditEntry(makeAuditEntry({ decision: "deny" }));
      bridge.convertSecurityAuditEntry(makeAuditEntry({ decision: "error" }));

      const stats = bridge.getStats();
      expect(stats.byOutcome.success).toBe(1);
      expect(stats.byOutcome.denied).toBe(1);
      expect(stats.byOutcome.error).toBe(1);
    });
  });
});

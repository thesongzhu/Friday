/**
 * B-010 Security-Observability Convergence Bridge — Forwards security audit
 * entries and violations to the observability audit trail so that every
 * deny/warn/error decision is captured in the tamper-evident chain.
 *
 * Provides:
 * - Bidirectional mapping: security audit → observability audit entry
 * - Violation → high-severity observability audit entry with error codes
 * - Action category derivation from security action strings
 * - Resource type mapping (security domain → observability domain)
 * - Actor construction from principal context
 * - Trust policy decision forwarding
 * - Configurable filtering (deny-only, all decisions, specific severities)
 * - Bridge statistics and health reporting
 *
 * @module security/multi-tenant/engine
 */

import type {
  FridaySecurityAuditDecision,
  FridaySecurityAuditEntry,
  FridaySecurityResourceType,
  FridaySecurityViolation,
  FridaySecurityViolationSeverity,
  ISODateTime,
  JsonObject,
} from "../model/friday-multi-tenant-security.types.js";

import type {
  FridayAuditActionCategory,
  FridayAuditActorType,
  FridayAuditOutcome,
  FridayAuditResourceType,
  FridayObservabilityModule,
} from "../../../observability/model/friday-observability.types.js";

import type { TrustDecision } from "./friday-package-trust-policy.js";

// ─── Configuration ───

/** Which security decisions to forward. */
export type BridgeFilterMode = "deny_only" | "deny_and_warn" | "all";

/** Minimum violation severity to forward. */
export type BridgeViolationFilter = FridaySecurityViolationSeverity;

/** Bridge configuration. */
export interface SecurityObservabilityBridgeConfig {
  /** Which decisions to forward to observability. */
  readonly filterMode: BridgeFilterMode;
  /** Minimum violation severity to forward. */
  readonly minViolationSeverity: BridgeViolationFilter;
  /** Whether to forward trust policy decisions. */
  readonly forwardTrustDecisions: boolean;
  /** Default actor type when principal type is unknown. */
  readonly defaultActorType: FridayAuditActorType;
  /** Default actor display name when not available. */
  readonly defaultActorDisplayName: string;
}

// ─── Converted Entry (ready for observability audit trail append) ───

/** A converted entry ready for the observability audit trail. */
export interface ConvertedAuditEntry {
  readonly actor: {
    readonly type: FridayAuditActorType;
    readonly id: string;
    readonly displayName: string;
    readonly ip?: string;
    readonly userAgent?: string;
  };
  readonly actionCategory: FridayAuditActionCategory;
  readonly action: string;
  readonly resource: {
    readonly type: FridayAuditResourceType;
    readonly id: string;
    readonly displayName?: string;
  };
  readonly outcome: FridayAuditOutcome;
  readonly description: string;
  readonly module: FridayObservabilityModule;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly metadata?: JsonObject;
}

// ─── Bridge Statistics ───

/** Aggregate bridge statistics. */
export interface BridgeStats {
  /** Total entries forwarded. */
  readonly totalForwarded: number;
  /** Entries filtered out. */
  readonly totalFiltered: number;
  /** Entries from security audit log. */
  readonly auditEntriesForwarded: number;
  /** Entries from security violations. */
  readonly violationsForwarded: number;
  /** Entries from trust decisions. */
  readonly trustDecisionsForwarded: number;
  /** Breakdown by outcome. */
  readonly byOutcome: Readonly<Record<FridayAuditOutcome, number>>;
  /** Current filter mode. */
  readonly filterMode: BridgeFilterMode;
}

// ─── Dependencies ───

export interface SecurityObservabilityBridgeDeps {
  /** Clock function. */
  nowIso?: () => ISODateTime;
  /** Initial configuration. */
  config?: Partial<SecurityObservabilityBridgeConfig>;
}

// ─── Interface ───

export interface FridaySecurityObservabilityBridge {
  /** Convert a security audit entry to an observability audit entry. Returns null if filtered. */
  convertSecurityAuditEntry(entry: FridaySecurityAuditEntry): ConvertedAuditEntry | null;
  /** Convert a security violation to an observability audit entry. Returns null if filtered. */
  convertSecurityViolation(violation: FridaySecurityViolation): ConvertedAuditEntry | null;
  /** Convert a trust policy decision to an observability audit entry. Returns null if filtered or trust forwarding disabled. */
  convertTrustDecision(decision: TrustDecision, tenantId?: string): ConvertedAuditEntry | null;
  /** Get the current bridge configuration. */
  getConfig(): SecurityObservabilityBridgeConfig;
  /** Update bridge configuration. */
  updateConfig(patch: Partial<SecurityObservabilityBridgeConfig>): void;
  /** Get bridge statistics. */
  getStats(): BridgeStats;
  /** Reset statistics. */
  resetStats(): void;
}

// ─── Mapping Utilities ───

const SEVERITY_ORDER: Record<FridaySecurityViolationSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** Map security audit decision to observability outcome. */
function mapDecisionToOutcome(decision: FridaySecurityAuditDecision): FridayAuditOutcome {
  switch (decision) {
    case "allow": return "success";
    case "warn": return "success";
    case "deny": return "denied";
    case "error": return "error";
  }
}

/** Derive action category from a security action string. */
function deriveActionCategory(action: string): FridayAuditActionCategory {
  const lower = action.toLowerCase();
  if (lower.includes("authenticate") || lower.includes("login")) return "authenticate";
  if (lower.includes("authorize") || lower.includes("permission") || lower.includes("rbac")) return "authorize";
  if (lower.includes("create") || lower.includes("add") || lower.includes("publish")) return "create";
  if (lower.includes("update") || lower.includes("rotate") || lower.includes("configure")) return "update";
  if (lower.includes("delete") || lower.includes("revoke") || lower.includes("remove")) return "delete";
  if (lower.includes("evaluate") || lower.includes("execute") || lower.includes("run")) return "execute";
  if (lower.includes("read") || lower.includes("access") || lower.includes("check") || lower.includes("list")) return "access";
  if (lower.includes("isolation") || lower.includes("boundary") || lower.includes("tenant")) return "authorize";
  return "access";
}

/**
 * Map security resource type → observability audit resource type.
 * Falls back to "policy" for security-specific types that don't have
 * a 1:1 match in the observability domain.
 */
function mapResourceType(secType: FridaySecurityResourceType): FridayAuditResourceType {
  switch (secType) {
    case "secret": return "credential";
    case "policy": return "policy";
    case "role": return "preference";
    case "workflow": return "workflow";
    case "rule": return "rule";
    case "tenant": return "policy";
    case "workspace": return "policy";
    case "membership": return "preference";
    case "audit": return "policy";
    case "skill": return "node";
    case "agent": return "node";
    case "package": return "policy";
  }
}

/** Determine actor type from principal ID prefix. */
function inferActorType(principalId: string | undefined, defaultType: FridayAuditActorType): FridayAuditActorType {
  if (!principalId) return "system";
  if (principalId.startsWith("wf-") || principalId.startsWith("workflow-")) return "workflow";
  if (principalId.startsWith("agent-") || principalId.startsWith("ag-")) return "agent";
  if (principalId.startsWith("ak-") || principalId.startsWith("apikey-")) return "api_key";
  if (principalId.startsWith("sys-") || principalId === "system") return "system";
  return defaultType;
}

/** Check if a decision should be forwarded based on filter mode. */
function shouldForwardDecision(decision: FridaySecurityAuditDecision, filterMode: BridgeFilterMode): boolean {
  switch (filterMode) {
    case "all": return true;
    case "deny_and_warn": return decision === "deny" || decision === "warn" || decision === "error";
    case "deny_only": return decision === "deny" || decision === "error";
  }
}

/** Check if a violation severity meets the minimum threshold. */
function meetsMinSeverity(severity: FridaySecurityViolationSeverity, minSeverity: FridaySecurityViolationSeverity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[minSeverity];
}

// ─── Factory ───

const DEFAULT_CONFIG: SecurityObservabilityBridgeConfig = {
  filterMode: "deny_only",
  minViolationSeverity: "low",
  forwardTrustDecisions: true,
  defaultActorType: "user",
  defaultActorDisplayName: "Unknown Principal",
};

export function createSecurityObservabilityBridge(
  deps: SecurityObservabilityBridgeDeps = {},
): FridaySecurityObservabilityBridge {
  let config: SecurityObservabilityBridgeConfig = {
    ...DEFAULT_CONFIG,
    ...deps.config,
  };

  let totalForwarded = 0;
  let totalFiltered = 0;
  let auditEntriesForwarded = 0;
  let violationsForwarded = 0;
  let trustDecisionsForwarded = 0;
  const byOutcome: Record<FridayAuditOutcome, number> = {
    success: 0,
    failure: 0,
    denied: 0,
    error: 0,
  };

  function trackForwarded(outcome: FridayAuditOutcome, source: "audit" | "violation" | "trust"): void {
    totalForwarded++;
    byOutcome[outcome]++;
    if (source === "audit") auditEntriesForwarded++;
    else if (source === "violation") violationsForwarded++;
    else trustDecisionsForwarded++;
  }

  return {
    convertSecurityAuditEntry(entry) {
      if (!shouldForwardDecision(entry.decision, config.filterMode)) {
        totalFiltered++;
        return null;
      }

      const outcome = mapDecisionToOutcome(entry.decision);
      const actorType = inferActorType(entry.principalId, config.defaultActorType);

      const converted: ConvertedAuditEntry = {
        actor: {
          type: actorType,
          id: entry.principalId ?? "system",
          displayName: entry.principalId ?? config.defaultActorDisplayName,
          ip: entry.ipAddress,
          userAgent: entry.userAgent,
        },
        actionCategory: deriveActionCategory(entry.action),
        action: `security.${entry.action}`,
        resource: {
          type: mapResourceType(entry.resourceType),
          id: entry.resourceId ?? `${entry.resourceType}-unknown`,
          displayName: `${entry.resourceType}:${entry.resourceId ?? "unknown"}`,
        },
        outcome,
        description: entry.reason ?? `Security ${entry.decision}: ${entry.action}`,
        module: "auth" as FridayObservabilityModule,
        ...(outcome === "denied" || outcome === "error" ? {
          errorCode: `SECURITY_${entry.decision.toUpperCase()}`,
          errorMessage: entry.reason,
        } : {}),
        ...(entry.sessionId ? { traceId: entry.sessionId } : {}),
        metadata: {
          securityEntryId: entry.id,
          securityDecision: entry.decision,
          ...(entry.tenantId ? { tenantId: entry.tenantId } : {}),
          ...entry.metadata,
        } as JsonObject,
      };

      trackForwarded(outcome, "audit");
      return converted;
    },

    convertSecurityViolation(violation) {
      if (!meetsMinSeverity(violation.severity, config.minViolationSeverity)) {
        totalFiltered++;
        return null;
      }

      const actorType = inferActorType(violation.principalId, config.defaultActorType);

      const converted: ConvertedAuditEntry = {
        actor: {
          type: actorType,
          id: violation.principalId,
          displayName: violation.principalId,
          ip: violation.ipAddress,
        },
        actionCategory: "authorize",
        action: `security.violation.${violation.violationType}`,
        resource: {
          type: violation.resourceType ? mapResourceType(violation.resourceType) : "policy",
          id: violation.resourceId ?? "unknown",
          displayName: violation.resourceType
            ? `${violation.resourceType}:${violation.resourceId ?? "unknown"}`
            : "security-boundary",
        },
        outcome: "denied",
        description: violation.description,
        module: "auth" as FridayObservabilityModule,
        errorCode: `VIOLATION_${violation.violationType.toUpperCase()}`,
        errorMessage: `${violation.severity.toUpperCase()}: ${violation.description}`,
        metadata: {
          violationId: violation.id,
          violationType: violation.violationType,
          severity: violation.severity,
          tenantId: violation.tenantId,
          ...(violation.actionAttempted ? { actionAttempted: violation.actionAttempted } : {}),
          ...violation.metadata,
        } as JsonObject,
      };

      trackForwarded("denied", "violation");
      return converted;
    },

    convertTrustDecision(decision, tenantId?) {
      if (!config.forwardTrustDecisions) {
        totalFiltered++;
        return null;
      }

      // Map trust outcome to audit outcome
      let outcome: FridayAuditOutcome;
      if (decision.allowed) {
        outcome = "success";
      } else {
        outcome = "denied";
      }

      // Apply filter
      const pseudoDecision: FridaySecurityAuditDecision = decision.allowed ? "allow" : "deny";
      if (!shouldForwardDecision(pseudoDecision, config.filterMode)) {
        totalFiltered++;
        return null;
      }

      const converted: ConvertedAuditEntry = {
        actor: {
          type: "system",
          id: "trust-policy-engine",
          displayName: "Trust Policy Engine",
        },
        actionCategory: "authorize",
        action: `security.trust.${decision.subjectType}.evaluate`,
        resource: {
          type: "policy",
          id: decision.subjectId,
          displayName: `${decision.subjectType}:${decision.subjectId}@${decision.subjectVersion}`,
        },
        outcome,
        description: decision.reason,
        module: "auth" as FridayObservabilityModule,
        ...(!decision.allowed ? {
          errorCode: `TRUST_${decision.outcome.toUpperCase()}`,
          errorMessage: decision.reason,
        } : {}),
        metadata: {
          trustOutcome: decision.outcome,
          policyMode: decision.policyMode,
          subjectVersion: decision.subjectVersion,
          subjectType: decision.subjectType,
          ...(decision.keyId ? { keyId: decision.keyId } : {}),
          ...(tenantId ? { tenantId } : {}),
        } as JsonObject,
      };

      trackForwarded(outcome, "trust");
      return converted;
    },

    getConfig() {
      return { ...config };
    },

    updateConfig(patch) {
      config = { ...config, ...patch };
    },

    getStats(): BridgeStats {
      return {
        totalForwarded,
        totalFiltered,
        auditEntriesForwarded,
        violationsForwarded,
        trustDecisionsForwarded,
        byOutcome: { ...byOutcome },
        filterMode: config.filterMode,
      };
    },

    resetStats() {
      totalForwarded = 0;
      totalFiltered = 0;
      auditEntriesForwarded = 0;
      violationsForwarded = 0;
      trustDecisionsForwarded = 0;
      byOutcome.success = 0;
      byOutcome.failure = 0;
      byOutcome.denied = 0;
      byOutcome.error = 0;
    },
  };
}

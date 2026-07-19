/**
 * Structured audit logger for multi-tenant security operations.
 *
 * Records every security-relevant event (allow, deny, warn, error)
 * with tenant isolation. Provides query capabilities for audit log
 * and violation entries.
 *
 * @module security/multi-tenant/engine/audit-logger
 */

import type {
  FridaySecurityAuditDecision,
  FridaySecurityAuditEntry,
  FridaySecurityResourceType,
  FridaySecurityViolation,
  FridaySecurityViolationSeverity,
  FridaySecurityViolationType,
  JsonObject,
  UUID,
} from "../model/friday-multi-tenant-security.types.js";

import { cloneAndFreeze, generateId, now, SecurityEngineError } from "./utils.js";
import { FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES } from "../api/friday-multi-tenant-security-api.types.js";

// ─── Input Types ───

export interface CreateAuditEntryInput {
  readonly tenantId: UUID | null;
  readonly principalId?: string;
  readonly action: string;
  readonly resourceType: FridaySecurityResourceType;
  readonly resourceId?: string;
  readonly decision: FridaySecurityAuditDecision;
  readonly reason?: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly sessionId?: string;
  readonly metadata?: JsonObject;
}

export interface CreateViolationInput {
  readonly tenantId: UUID;
  readonly principalId: string;
  readonly violationType: FridaySecurityViolationType;
  readonly severity: FridaySecurityViolationSeverity;
  readonly description: string;
  readonly resourceType?: FridaySecurityResourceType;
  readonly resourceId?: string;
  readonly actionAttempted?: string;
  readonly ipAddress?: string;
  readonly metadata?: JsonObject;
}

export interface AuditLogQuery {
  readonly tenantId: UUID | null;
  readonly principalId?: string;
  readonly action?: string;
  readonly resourceType?: FridaySecurityResourceType;
  readonly decision?: FridaySecurityAuditDecision;
  readonly after?: string;
  readonly before?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ViolationQuery {
  readonly tenantId: UUID;
  readonly principalId?: string;
  readonly violationType?: FridaySecurityViolationType;
  readonly severity?: FridaySecurityViolationSeverity;
  readonly resolved?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

// ─── Audit Logger ───

/**
 * Optional persistence hook for audit entries and violations.  The hub
 * bootstrap supplies a SQLite-backed implementation; in-memory tests
 * leave this undefined.
 */
export interface AuditLoggerPersistence {
  hydrateAuditEntries(): Map<UUID, FridaySecurityAuditEntry>;
  hydrateViolations(): Map<UUID, FridaySecurityViolation>;
  saveAuditEntry(entry: FridaySecurityAuditEntry): void;
  saveViolation(violation: FridaySecurityViolation): void;
}

export class AuditLogger {
  private readonly auditEntries: Map<UUID, FridaySecurityAuditEntry>;
  private readonly violations: Map<UUID, FridaySecurityViolation>;
  private readonly persistence?: AuditLoggerPersistence;

  constructor(options?: { persistence?: AuditLoggerPersistence }) {
    this.persistence = options?.persistence;
    this.auditEntries = this.persistence?.hydrateAuditEntries() ?? new Map();
    this.violations = this.persistence?.hydrateViolations() ?? new Map();
  }

  /** Record a structured audit entry. */
  log(input: CreateAuditEntryInput): FridaySecurityAuditEntry {
    const entry: FridaySecurityAuditEntry = {
      id: generateId(),
      tenantId: input.tenantId,
      principalId: input.principalId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      decision: input.decision,
      reason: input.reason,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      sessionId: input.sessionId,
      metadata: input.metadata ?? {},
      createdAt: now(),
    };
    this.auditEntries.set(entry.id, entry);
    this.persistence?.saveAuditEntry(entry);
    return cloneAndFreeze(entry);
  }

  /**
   * Reflect an ALREADY-DURABLY-COMMITTED audit row into the in-memory projection
   * WITHOUT re-persisting it.
   *
   * This exists so a producer that appends to `security_audit_log` inside its OWN
   * write transaction (for atomic rollback-safety — no phantom in-memory entry if
   * that transaction rolls back) can, AFTER a successful commit, make the entry
   * visible through the live audit query projection (`queryAuditLog`/
   * `getAuditEntry`). Call it ONLY post-commit with the committed entry: it is a
   * pure in-memory upsert (no I/O, cannot fail), so it never reintroduces an
   * orphan/uncertain outcome, and it never double-writes persistence.
   */
  hydratePersistedEntry(entry: FridaySecurityAuditEntry): void {
    this.auditEntries.set(entry.id, entry);
  }

  /** Record a security violation. */
  recordViolation(input: CreateViolationInput): FridaySecurityViolation {
    const violation: FridaySecurityViolation = {
      id: generateId(),
      tenantId: input.tenantId,
      principalId: input.principalId,
      violationType: input.violationType,
      severity: input.severity,
      description: input.description,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      actionAttempted: input.actionAttempted,
      ipAddress: input.ipAddress,
      resolved: false,
      metadata: input.metadata ?? {},
      createdAt: now(),
    };
    this.violations.set(violation.id, violation);
    this.persistence?.saveViolation(violation);
    return cloneAndFreeze(violation);
  }

  /** Resolve a violation (mark as resolved by a principal). */
  resolveViolation(
    tenantId: UUID,
    violationId: UUID,
    resolvedBy: string,
  ): FridaySecurityViolation {
    const violation = this.violations.get(violationId);
    if (!violation || violation.tenantId !== tenantId) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.VALIDATION_FAILED,
        `Violation ${violationId} not found in tenant ${tenantId}.`,
      );
    }
    const resolved: FridaySecurityViolation = {
      ...violation,
      resolved: true,
      resolvedBy,
      resolvedAt: now(),
    };
    this.violations.set(violationId, resolved);
    this.persistence?.saveViolation(resolved);
    return cloneAndFreeze(resolved);
  }

  /** Query audit entries scoped to a tenant with optional filters. */
  queryAuditLog(query: AuditLogQuery): readonly FridaySecurityAuditEntry[] {
    const limit = query.limit ?? 50;
    let results = Array.from(this.auditEntries.values())
      .filter((e) => e.tenantId === query.tenantId);

    if (query.principalId) {
      results = results.filter((e) => e.principalId === query.principalId);
    }
    if (query.action) {
      results = results.filter((e) => e.action === query.action);
    }
    if (query.resourceType) {
      results = results.filter((e) => e.resourceType === query.resourceType);
    }
    if (query.decision) {
      results = results.filter((e) => e.decision === query.decision);
    }
    if (query.after) {
      results = results.filter((e) => e.createdAt > query.after!);
    }
    if (query.before) {
      results = results.filter((e) => e.createdAt < query.before!);
    }

    // Sort newest first
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    // Cursor-based pagination (cursor = last seen id)
    if (query.cursor) {
      const cursorIdx = results.findIndex((e) => e.id === query.cursor);
      if (cursorIdx >= 0) {
        results = results.slice(cursorIdx + 1);
      }
    }

    return cloneAndFreeze(results.slice(0, limit));
  }

  /** Query violations scoped to a tenant with optional filters. */
  queryViolations(query: ViolationQuery): readonly FridaySecurityViolation[] {
    const limit = query.limit ?? 50;
    let results = Array.from(this.violations.values())
      .filter((v) => v.tenantId === query.tenantId);

    if (query.principalId) {
      results = results.filter((v) => v.principalId === query.principalId);
    }
    if (query.violationType) {
      results = results.filter((v) => v.violationType === query.violationType);
    }
    if (query.severity) {
      results = results.filter((v) => v.severity === query.severity);
    }
    if (query.resolved !== undefined) {
      results = results.filter((v) => v.resolved === query.resolved);
    }

    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    if (query.cursor) {
      const cursorIdx = results.findIndex((v) => v.id === query.cursor);
      if (cursorIdx >= 0) {
        results = results.slice(cursorIdx + 1);
      }
    }

    return cloneAndFreeze(results.slice(0, limit));
  }

  /** Get a single audit entry by id (tenant-scoped). */
  getAuditEntry(tenantId: UUID | null, entryId: UUID): FridaySecurityAuditEntry | undefined {
    const entry = this.auditEntries.get(entryId);
    if (entry && entry.tenantId === tenantId) return cloneAndFreeze(entry);
    return undefined;
  }

  /** Get a single violation by id (tenant-scoped). */
  getViolation(tenantId: UUID, violationId: UUID): FridaySecurityViolation | undefined {
    const violation = this.violations.get(violationId);
    if (violation && violation.tenantId === tenantId) return cloneAndFreeze(violation);
    return undefined;
  }

  /** Count audit entries for a tenant. */
  countAuditEntries(tenantId: UUID | null): number {
    return Array.from(this.auditEntries.values())
      .filter((e) => e.tenantId === tenantId).length;
  }

  /** Count violations for a tenant (optionally only unresolved). */
  countViolations(tenantId: UUID, unresolvedOnly = false): number {
    return Array.from(this.violations.values())
      .filter((v) => v.tenantId === tenantId && (!unresolvedOnly || !v.resolved)).length;
  }
}

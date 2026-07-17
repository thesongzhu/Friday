import { FridayDomainError } from "#errors";
import type {
  CategoryRetention,
  FridayRetentionContentPolicy,
  FridayRetentionSettingsStore,
} from "#jobs";
import { FRIDAY_MAX_AFTER_DAYS, FRIDAY_MIN_AFTER_DAYS, isValidAfterDays } from "#jobs";
import type { FridaySqliteLayer } from "#state";
import type { FridayAuthPrincipal, FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { FridayDiskGrowthWarning } from "../../../learning/services/friday-disk-growth-evaluator.js";
import {
  assertBoundPrincipalAuthorityForOperation,
  isUnauthenticatedPublicPrincipal,
} from "../../../security/friday-owner-session-channel-capability.js";
import { createSqliteAuditPersistence } from "../../../security/multi-tenant/persistence/friday-multi-tenant-sqlite-store.js";
import type {
  FridaySecurityAuditEntry,
  JsonObject,
} from "../../../security/multi-tenant/model/friday-multi-tenant-security.types.js";
import { readIdempotencyKeyHeader } from "./friday-route-idempotency.js";

/**
 * Owner-bound retention-Settings HTTP surface (RETENTION-R3a).
 *
 *   GET /v1/uix/retention-policy  → the caller-owner's effective per-content-
 *     category policy (defaults every category to `{mode:"permanent"}`).
 *   PUT /v1/uix/retention-policy  → the caller-owner sets each content category
 *     to `{mode:"permanent"}` (clean "off" — the override is removed) or
 *     `{mode:"after_days",days:N}` (N an integer inside the canonical honored
 *     window `[FRIDAY_MIN_AFTER_DAYS, FRIDAY_MAX_AFTER_DAYS]`). Invalid or
 *     out-of-domain bodies are rejected with a typed 400 and NOTHING is persisted.
 *
 * Owner binding is CANONICAL-OWNER-scoped (SEC-NET-PRINCIPAL-001): the id comes
 * ONLY from the authenticated principal — never from the request body or params —
 * AND the authenticated principal's `userId` MUST MATCH the single canonical
 * owner the production reaper is bound to (`resolveCanonicalOwnerId`). Owner/admin
 * ROLE is a floor, not identity: a second, legitimately-authenticated admin is
 * refused 403 so a persisted opt-in can never diverge from what the reaper reads
 * (accept == honored). Both handlers scope every read/write to the resolved
 * canonical-owner id, and fail closed (403, zero effect) if it cannot be resolved.
 */

export interface FridayRetentionSettingsRoutesDeps {
  store: FridayRetentionSettingsStore;
  /**
   * Resolves the SINGLE canonical-owner identity that GOVERNS the reaper —
   * i.e. the exact id the production per-sweep policy loader is bound to
   * (`learningDefaultUserId` = `admin-001` in `friday-hub-bootstrap.ts`). Both
   * GET and PUT require the authenticated principal's `userId` to MATCH this
   * id (SEC-NET-PRINCIPAL-001): role/scope (owner/admin + hub.admin) is a floor,
   * NOT canonical-owner identity — the repo schema permits multiple users and
   * each role-derived `hub.admin` token would otherwise be accepted, persisting
   * an override the canonical-owner-bound reaper NEVER reads (DATA-RETENTION-001
   * truthfulness: accept must equal honored end-to-end).
   *
   * This is a PRODUCTION dependency threaded from the SAME source the reaper
   * consumes — never a per-request caller value and never a route-local literal.
   *
   * FAIL-CLOSED: if this returns null/undefined/empty (or throws), the route
   * denies (403, zero persistence, zero readback) rather than falling open to
   * "any admin".
   */
  resolveCanonicalOwnerId: () => string | null | undefined;
  /**
   * RETENTION-R3b: reads the latest REPORT-ONLY disk-growth warning snapshot (the
   * in-memory holder the system-health-monitor job updates each run). Optional:
   * when omitted (or it returns null), the owner-bound disk-usage readback returns
   * `{ diskUsage: null }` — still owner-gated, never dark-open. The reading is
   * DERIVED/observable and never persisted as canonical (DATA-RETENTION-001).
   */
  readDiskUsage?: () => FridayDiskGrowthWarning | null;
  /**
   * RETENTION-R3d: the write layer used to run the policy-apply AND the audit
   * append inside ONE write transaction. MUST be the SAME `FridaySqliteLayer`
   * instance (same writer connection) that backs both `store` and
   * `appendPolicyAudit`, so the two writes NEST and commit/roll back atomically —
   * an audit failure leaves the persisted policy byte-unchanged (no orphan write).
   */
  db: FridaySqliteLayer;
  /**
   * RETENTION-R3d: FAIL-CLOSED audit sink. Appends exactly ONE durable audit
   * entry (carrying the full receipt facts) for a successful retention-policy
   * mutation and returns the persisted `FridaySecurityAuditEntry`. Called INSIDE
   * the `db.withWriteTransaction` that applies the policy so both commit or both
   * roll back. THROWS (never fails open) on any persistence failure: the throw
   * aborts the enclosing transaction → the policy write rolls back → the PUT
   * handler surfaces 503 and NO mutation is left un-audited. The returned entry is
   * fed to `projectCommittedAudit` (below) AFTER commit so the LIVE audit
   * projection sees it. Build it with `createFridayRetentionPolicyAuditAppender`
   * (closing over the SAME layer).
   */
  appendPolicyAudit: (entry: FridayRetentionPolicyAuditEntry) => FridaySecurityAuditEntry;
  /**
   * RETENTION-R3d (P0 — audit-projection VISIBILITY). Optional post-commit hook
   * that reflects the committed audit entry into the product's LIVE audit
   * projection (the boot-hydrated `AuditLogger`), so the raw `security_audit_log`
   * insert is not invisible to `queryAuditLog`. Called ONLY after the write
   * transaction commits — a pure in-memory upsert (cannot fail), so it preserves
   * rollback-safety (no phantom on failure) AND visibility on success. Absent when
   * no in-memory projection is wired (the committed row is then the record).
   */
  projectCommittedAudit?: (entry: FridaySecurityAuditEntry) => void;
  /**
   * RETENTION-R3d (P0 — uncertain-outcome RECOVERY). Owner-bound lookup of a
   * durably-committed receipt by the client-known idempotency/operation key. Reads
   * the committed audit row (scoped to the canonical owner) and reconstructs the
   * exact receipt, so an interrupted PUT (mutation committed, HTTP response lost)
   * is recoverable through a product seam — never raw DB access, never blind
   * replay. Returns null when no receipt is bound to that key for this owner.
   */
  readReceiptByRecoveryKey?: (input: {
    ownerId: string;
    recoveryKey: string;
  }) => FridayRetentionPolicyUpdateReceipt | null;
  /**
   * Injected clock (RETENTION-R3d: no inline `Date.now()`). Drives the receipt
   * `runAt`. It is NOT the source of correlation/receipt UNIQUENESS — two writes
   * by the same owner in the same millisecond must not collide, so uniqueness
   * comes from `idGenerator` below, not the timestamp.
   */
  nowIso: () => string;
  /**
   * Injected collision-resistant id generator (RETENTION-R3d: no inline
   * `Math.random()`/`crypto`). Produces a UNIQUE operation id per PUT that seeds
   * BOTH the correlation id and the receipt id, so distinct same-owner/same-clock
   * writes carry distinct traceability identities. Independent of the audit-entry
   * id (which `appendPolicyAudit` generates from its own generator).
   */
  idGenerator: () => string;
}

/**
 * RETENTION-R3d: the audit record for one retention-policy mutation. It carries
 * ALL the durable receipt facts and is persisted INSIDE the write transaction, so
 * a committed policy effect ALWAYS has its receipt durably recorded on the same
 * committed audit row (no committed-but-unreceipted write). The after-state is the
 * authoritative applied-but-not-yet-committed state captured in-txn — exactly what
 * the commit persists — never a fallible post-commit read.
 */
export interface FridayRetentionPolicyAuditEntry {
  /** UNIQUE (id-generator-seeded) correlation id binding audit ⇄ receipt. */
  correlationId: string;
  /** UNIQUE (id-generator-seeded) receipt id — persisted for durable recovery. */
  receiptId: string;
  /** The RESOLVED canonical owner (never a caller-supplied id). */
  ownerId: string;
  /** ISO time the mutation was applied (injected clock). */
  occurredAt: string;
  /** Authoritative before-state read from the store (pre-apply). */
  before: FridayRetentionContentPolicy;
  /** Authoritative after-state captured IN-TXN (== what is committed). */
  after: FridayRetentionContentPolicy;
  /** The validated per-category updates that were applied. */
  appliedUpdates: Record<string, CategoryRetention>;
  /** Content categories whose EFFECTIVE policy changed (before ≠ after). */
  changedCategories: string[];
  /**
   * RETENTION-R3d (P0 — recovery): the CLIENT-KNOWN idempotency/operation key
   * (from the request `Idempotency-Key` header), persisted so the committed
   * receipt is retrievable via the owner-bound recovery seam. Absent when the
   * client supplied no key (the write is still fully audited + receipted).
   */
  recoveryKey?: string;
}

/**
 * RETENTION-R3d: the RECEIPT envelope returned by a successful PUT. Binds the
 * correlation id, the durable audit entry id, the authoritative before + after
 * states, and the changed categories. `deletedData` is always `false`: a settings
 * write never deletes stored data rows (opt-out only removes an override row).
 */
export interface FridayRetentionPolicyUpdateReceipt {
  receiptId: string;
  correlationId: string;
  /** The durable audit entry id this update is bound to. */
  auditId: string;
  status: "applied";
  runAt: string;
  /** The RESOLVED canonical owner (never a caller-supplied id). */
  requestedBy: string;
  rollbackClass: "reversible_local_settings";
  evidence: {
    before: FridayRetentionContentPolicy;
    after: FridayRetentionContentPolicy;
    changed: string[];
    deletedData: false;
  };
}

interface FridayRetentionPolicyResponse {
  policy: Record<string, CategoryRetention>;
}

interface FridayRetentionPolicyUpdateResponse {
  policy: Record<string, CategoryRetention>;
  receipt: FridayRetentionPolicyUpdateReceipt;
}

interface FridayRetentionReceiptRecoveryResponse {
  /** The durably-committed receipt for the recovery key, or null if none. */
  receipt: FridayRetentionPolicyUpdateReceipt | null;
}

interface FridayRetentionDiskUsageResponse {
  diskUsage: FridayDiskGrowthWarning | null;
}

function requireUserId(principal: { userId?: string } | null): string {
  if (isUnauthenticatedPublicPrincipal(principal as never) || !principal?.userId) {
    throw new FridayDomainError("UNAUTHORIZED", "A user-scoped assistant principal is required", {
      httpStatus: 401,
    });
  }
  return principal.userId;
}

/**
 * Retention config is CANONICAL-LOCAL-OWNER-only (SEC-NET-PRINCIPAL-001): it
 * governs global content deletion, so both READS and MUTATIONS require owner
 * authority — a non-owner (viewer / operator) or synthetic-public / release-
 * disabled-device principal must never read or activate it. Reuses the SAME
 * mechanism as the owner-only runtime.secret.* routes
 * (`assertBoundPrincipalAuthorityForOperation`): the synthetic-public / disabled-
 * device principal is refused 401 (bound-principal required) and a bound but
 * non-owner principal is refused 403 (owner/admin authority required). The
 * canonical owner authenticates as role owner/admin (which carries the hub.admin
 * scope) via the local passphrase → bearer flow.
 */
function assertRetentionOwner(
  principal: FridayAuthPrincipal | null,
  operation: "retention.policy.read" | "retention.policy.update",
): void {
  assertBoundPrincipalAuthorityForOperation(principal, operation, "api", {
    anyOfScopes: ["hub.admin"],
    anyOfRoles: ["owner", "admin"],
  });
}

/**
 * CANONICAL-OWNER binding (SEC-NET-PRINCIPAL-001 / DATA-RETENTION-001). Beyond
 * the bound-principal + owner/admin authority FLOOR (kept as defense in depth),
 * retention config is governed by a SINGLE canonical owner — the exact identity
 * the production reaper's policy loader is bound to. Role/scope alone is NOT
 * canonical-owner identity (the schema permits multiple hub.admin users), so the
 * authenticated principal's `userId` MUST MATCH the resolved canonical-owner id
 * on BOTH reads and mutations. Anything an owner/admin-authorized-but-non-
 * canonical principal (e.g. `admin-002`) submits would persist under an id the
 * canonical-owner-bound reaper never reads (accept ≠ honored) — so it is refused.
 *
 * Returns the resolved canonical-owner id (== the caller's userId) that every
 * read/write MUST be keyed to — never a caller-supplied value. FAIL-CLOSED: an
 * unresolvable canonical-owner id (null/undefined/blank, or the provider throws)
 * denies with a typed 403 and ZERO effect, rather than falling open to any admin.
 */
function assertCanonicalRetentionOwner(
  principal: FridayAuthPrincipal | null,
  operation: "retention.policy.read" | "retention.policy.update",
  resolveCanonicalOwnerId: () => string | null | undefined,
): string {
  // Floor first (defense in depth): synthetic-public / disabled-device → 401;
  // bound non-owner (viewer / operator) → 403.
  assertRetentionOwner(principal, operation);
  const userId = requireUserId(principal);

  // Resolve the canonical-owner id the reaper actually consumes. FAIL-CLOSED on
  // any resolution failure (throw or nullish/blank) — never fall open.
  let canonicalOwnerId: string | null | undefined;
  try {
    canonicalOwnerId = resolveCanonicalOwnerId();
  } catch {
    canonicalOwnerId = null;
  }
  if (typeof canonicalOwnerId !== "string" || canonicalOwnerId.trim().length === 0) {
    throw new FridayDomainError(
      "RETENTION_CANONICAL_OWNER_UNRESOLVED",
      "Retention policy is unavailable: the canonical owner identity could not be resolved.",
      { httpStatus: 403 },
    );
  }

  // The authenticated principal must BE the canonical owner (not merely hold
  // owner/admin authority). A second, legitimately-authenticated admin is denied.
  if (userId !== canonicalOwnerId) {
    throw new FridayDomainError(
      "RETENTION_NOT_CANONICAL_OWNER",
      "Retention policy is governed by the single canonical owner; this principal is not the canonical owner.",
      { httpStatus: 403 },
    );
  }

  return canonicalOwnerId;
}

/**
 * Strictly parse ONE per-category `CategoryRetention` value from an untrusted
 * request body. Rejects (typed 400) anything that is not exactly
 * `{mode:"permanent"}` or `{mode:"after_days",days:<N>}` where N is inside the
 * canonical honored window `[FRIDAY_MIN_AFTER_DAYS, FRIDAY_MAX_AFTER_DAYS]` — bad
 * mode, missing/non-integer/NaN/Infinity `days`, `days ≤ 0`, or an OUT-OF-RANGE
 * window the reaper would silently treat as permanent (accept ⊆ honored). The
 * caller MUST validate the WHOLE body before any persistence so an invalid entry
 * persists nothing.
 */
function parseCategoryRetention(category: string, raw: unknown): CategoryRetention {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FridayDomainError(
      "RETENTION_POLICY_VALIDATION_FAILED",
      `Invalid retention config for '${category}': expected an object with a 'mode'.`,
      { httpStatus: 400 },
    );
  }
  const mode = (raw as { mode?: unknown }).mode;
  if (mode === "permanent") {
    return { mode: "permanent" };
  }
  if (mode !== "after_days") {
    throw new FridayDomainError(
      "RETENTION_POLICY_VALIDATION_FAILED",
      `Invalid retention config for '${category}': mode must be 'permanent' or 'after_days'.`,
      { httpStatus: 400 },
    );
  }
  const days = (raw as { days?: unknown }).days;
  if (!isValidAfterDays(days)) {
    throw new FridayDomainError(
      "RETENTION_POLICY_VALIDATION_FAILED",
      `Invalid retention config for '${category}': 'after_days' requires an integer 'days' in [${FRIDAY_MIN_AFTER_DAYS}, ${FRIDAY_MAX_AFTER_DAYS}].`,
      { httpStatus: 400 },
    );
  }
  return { mode: "after_days", days };
}

/** True when two per-category retention values are effectively identical. */
function retentionEquals(a: CategoryRetention, b: CategoryRetention): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === "after_days" && b.mode === "after_days") return a.days === b.days;
  return true;
}

/**
 * RETENTION-R3d: the content categories whose EFFECTIVE policy differs between the
 * authoritative before- and after-states. Derived from the two authoritative
 * readbacks (never from the request), so the receipt reports what actually
 * changed. Sorted for a stable receipt/audit payload.
 */
function computeChangedCategories(
  before: FridayRetentionContentPolicy,
  after: FridayRetentionContentPolicy,
): string[] {
  const categories = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const category of categories) {
    const b = (before as Record<string, CategoryRetention>)[category];
    const a = (after as Record<string, CategoryRetention>)[category];
    if (!b || !a || !retentionEquals(b, a)) {
      changed.push(category);
    }
  }
  return changed.sort();
}

/**
 * RETENTION-R3d: build the FAIL-CLOSED retention-policy audit appender.
 *
 * It writes exactly ONE structured entry into the durable `security_audit_log`
 * chain — REUSING `createSqliteAuditPersistence` (NOT a new audit store), keyed as
 * resource `policy` / decision `allow` — and returns the entry id. It MUST close
 * over the SAME `FridaySqliteLayer` the retention store writes through, so the
 * INSERT NESTS inside the caller's write transaction (a SAVEPOINT on the one
 * writer connection) and commits/rolls back atomically with the policy write.
 *
 * FAIL-CLOSED: any persistence failure is re-thrown as a typed 503 (mirrors the
 * observability audit posture) so the enclosing transaction ABORTS and no policy
 * mutation is ever left un-audited. The SQLite write is the ONLY thing that
 * participates in the transaction (so a rollback can't leave a phantom in-memory
 * audit entry); making the committed entry visible in the LIVE audit projection is
 * done SEPARATELY, post-commit, via `projectCommittedAudit` — the returned
 * `FridaySecurityAuditEntry` is what the handler feeds to that hook.
 */
export function createFridayRetentionPolicyAuditAppender(deps: {
  sqlite: FridaySqliteLayer;
  idGenerator: () => string;
}): (entry: FridayRetentionPolicyAuditEntry) => FridaySecurityAuditEntry {
  const persistence = createSqliteAuditPersistence(deps.sqlite);
  return (entry) => {
    const auditId = deps.idGenerator();
    // Persist the FULL receipt facts on the committed audit row so a committed
    // policy effect is never left without a durably-recoverable receipt: the row
    // `id` is the auditId, and this metadata carries receiptId + correlationId +
    // before + after + changed + deletedData + the client recovery key (everything
    // needed to reconstruct + look up the exact receipt from committed state).
    const metadata = {
      receiptId: entry.receiptId,
      correlationId: entry.correlationId,
      changedCategories: entry.changedCategories,
      deletedData: false,
      before: entry.before,
      after: entry.after,
      appliedUpdates: entry.appliedUpdates,
      ...(entry.recoveryKey ? { recoveryKey: entry.recoveryKey } : {}),
    } as unknown as JsonObject;
    const securityEntry: FridaySecurityAuditEntry = {
      id: auditId,
      tenantId: null,
      principalId: entry.ownerId,
      action: "retention.policy.update",
      resourceType: "policy",
      resourceId: `retention-policy:${entry.ownerId}`,
      decision: "allow",
      reason: "canonical-owner retention policy update",
      sessionId: entry.correlationId,
      metadata,
      createdAt: entry.occurredAt,
    };
    try {
      persistence.saveAuditEntry(securityEntry);
    } catch (cause) {
      throw new FridayDomainError(
        "RETENTION_AUDIT_APPEND_FAILED",
        "Retention audit append failed; refusing to complete the retention-policy update",
        { httpStatus: 503, cause },
      );
    }
    return securityEntry;
  };
}

/** SQLite row shape for a `security_audit_log` row this domain reads back. */
interface RetentionAuditRow {
  id: string;
  principal_id: string;
  created_at: string;
  metadata_json: string;
}

/**
 * RETENTION-R3d (P0 — uncertain-outcome RECOVERY): build the owner-bound receipt
 * recovery reader. Given the canonical owner + the CLIENT-KNOWN recovery key, it
 * reads the durably-committed audit row (scoped to that owner's `principal_id`) and
 * reconstructs the EXACT receipt from its metadata — so an interrupted PUT whose
 * mutation committed but whose HTTP response was lost is recoverable through a
 * product seam after restart, WITHOUT raw DB access or blind replay. Owner scoping
 * is enforced in the query (a different principal's rows are never matched); the
 * route additionally denies non-canonical principals before this ever runs.
 */
export function createFridayRetentionReceiptRecovery(deps: {
  sqlite: FridaySqliteLayer;
}): (input: { ownerId: string; recoveryKey: string }) => FridayRetentionPolicyUpdateReceipt | null {
  return (input) => {
    const row = deps.sqlite.withReadConnection((db) =>
      db
        .prepare(
          `SELECT id, principal_id, created_at, metadata_json
             FROM security_audit_log
            WHERE principal_id = ?
              AND action = 'retention.policy.update'
              AND json_extract(metadata_json, '$.recoveryKey') = ?
            ORDER BY created_at DESC
            LIMIT 1`,
        )
        .get(input.ownerId, input.recoveryKey) as RetentionAuditRow | undefined,
    );
    if (!row) return null;
    let meta: {
      receiptId?: string;
      correlationId?: string;
      before?: FridayRetentionContentPolicy;
      after?: FridayRetentionContentPolicy;
      changedCategories?: string[];
    };
    try {
      meta = JSON.parse(row.metadata_json) as typeof meta;
    } catch {
      return null;
    }
    if (!meta.receiptId || !meta.correlationId || !meta.before || !meta.after) {
      return null;
    }
    return {
      receiptId: meta.receiptId,
      correlationId: meta.correlationId,
      auditId: row.id,
      status: "applied",
      runAt: row.created_at,
      requestedBy: row.principal_id,
      rollbackClass: "reversible_local_settings",
      evidence: {
        before: meta.before,
        after: meta.after,
        changed: meta.changedCategories ?? [],
        deletedData: false,
      },
    };
  };
}

export function createFridayRetentionSettingsRoutes(
  deps: FridayRetentionSettingsRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "uix.retention.policy.get",
      method: "GET",
      path: "/v1/uix/retention-policy",
      auth: { public: true },
      async handler(ctx): Promise<FridayRetentionPolicyResponse> {
        const ownerId = assertCanonicalRetentionOwner(
          ctx.principal ?? null,
          "retention.policy.read",
          deps.resolveCanonicalOwnerId,
        );
        return { policy: deps.store.readOwnerContentPolicy({ principalId: ownerId }) };
      },
    },
    {
      operationId: "uix.retention.policy.update",
      method: "PUT",
      path: "/v1/uix/retention-policy",
      auth: { public: true },
      async handler(ctx): Promise<FridayRetentionPolicyUpdateResponse> {
        // 1. AuthZ FIRST: canonical-owner binding. A non-canonical authenticated
        //    admin (admin-002) is refused 403 here, BEFORE any before-readback,
        //    audit, mutation, or receipt side effect.
        const ownerId = assertCanonicalRetentionOwner(
          ctx.principal ?? null,
          "retention.policy.update",
          deps.resolveCanonicalOwnerId,
        );

        const body = ctx.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new FridayDomainError(
            "RETENTION_POLICY_VALIDATION_FAILED",
            "Request body must be an object with a 'policy' map.",
            { httpStatus: 400 },
          );
        }
        const policyInput = (body as { policy?: unknown }).policy;
        if (!policyInput || typeof policyInput !== "object" || Array.isArray(policyInput)) {
          throw new FridayDomainError(
            "RETENTION_POLICY_VALIDATION_FAILED",
            "'policy' must be a map of content-category → retention config.",
            { httpStatus: 400 },
          );
        }

        // 2. Validate the WHOLE body FIRST (reject → 400, persist nothing / no
        //    audit / no receipt), THEN apply. The KNOWN content-category set is the
        //    invariant 7 categories — derived from a read of the current policy's
        //    KEYS only (values are irrelevant to validation), so unknown-key
        //    rejection stays fail-closed BEFORE any mutation. Authoritative
        //    before/after VALUES are read IN-TXN below (never from this snapshot).
        const known = new Set(Object.keys(deps.store.readOwnerContentPolicy({ principalId: ownerId })));
        const updates: Record<string, CategoryRetention> = {};
        for (const [category, raw] of Object.entries(policyInput as Record<string, unknown>)) {
          if (!known.has(category)) {
            throw new FridayDomainError(
              "RETENTION_POLICY_VALIDATION_FAILED",
              `Unknown retention content category: '${category}'.`,
              { httpStatus: 400 },
            );
          }
          updates[category] = parseCategoryRetention(category, raw);
        }

        // 3. UNIQUE operation identity (P0 — traceability). Uniqueness comes from
        //    the injected collision-resistant id generator, NOT the clock: two
        //    same-owner/same-millisecond writes get DISTINCT correlation AND receipt
        //    ids. The readable domain prefix is cosmetic. The CLIENT-KNOWN recovery
        //    key (Idempotency-Key header, optional) binds the durable receipt for
        //    owner-bound recovery of an interrupted request.
        const runAt = deps.nowIso();
        const operationId = deps.idGenerator();
        const correlationId = `retention-policy-update:${ownerId}:${operationId}`;
        const receiptId = `retention-receipt:${ownerId}:${operationId}`;
        const recoveryKey = readIdempotencyKeyHeader(
          ctx.headers as Record<string, string | undefined> | undefined,
        );

        // 4. ONE writer transaction carries the AUTHORITATIVE before-read, the
        //    apply, the AUTHORITATIVE after-read, the durable-receipt capture, and
        //    the audit — all on the SAME writer connection (P0 — concurrent
        //    readback + write-closure). Reading on the writer connection inside its
        //    own transaction SEES this txn's uncommitted apply AND reflects any
        //    disjoint write another connection committed before this txn opened, so
        //    `before`/`after` are the TRUE committed states — never a racy pre-txn
        //    read-pool snapshot (which `{...before,...updates}` synthesis would
        //    miss). If the audit append THROWS (fail-closed 503) the whole
        //    transaction rolls back → policy byte-unchanged, no audit row, no orphan;
        //    it is impossible to commit a policy effect without its receipt also
        //    durably committed on the same row, or to return 503 with a committed
        //    write.
        let before!: FridayRetentionContentPolicy;
        let after!: FridayRetentionContentPolicy;
        let changed: string[] = [];
        let auditEntry!: FridaySecurityAuditEntry;
        deps.db.withWriteTransaction((conn) => {
          before = deps.store.readOwnerContentPolicyOnConnection(conn, { principalId: ownerId });
          deps.store.applyOwnerContentPolicyOnConnection(conn, { principalId: ownerId, updates });
          after = deps.store.readOwnerContentPolicyOnConnection(conn, { principalId: ownerId });
          changed = computeChangedCategories(before, after);
          auditEntry = deps.appendPolicyAudit({
            correlationId,
            receiptId,
            ownerId,
            occurredAt: runAt,
            before,
            after,
            appliedUpdates: updates,
            changedCategories: changed,
            ...(recoveryKey ? { recoveryKey } : {}),
          });
        });

        // 5. Post-commit: make the committed audit entry VISIBLE in the LIVE audit
        //    projection (P0 — audit visibility). Pure in-memory upsert, cannot
        //    fail, runs ONLY after a successful commit → preserves rollback-safety
        //    AND live visibility. No fallible DB access after commit.
        deps.projectCommittedAudit?.(auditEntry);

        // 6. The response is a PURE serialization of already-durable in-memory
        //    facts (also recoverable from the committed audit row: id = auditId;
        //    metadata holds receiptId/correlationId/before/after/changed/recoveryKey).
        const receipt: FridayRetentionPolicyUpdateReceipt = {
          receiptId,
          correlationId,
          auditId: auditEntry.id,
          status: "applied",
          runAt,
          requestedBy: ownerId,
          rollbackClass: "reversible_local_settings",
          evidence: { before, after, changed, deletedData: false },
        };

        return { policy: after, receipt };
      },
    },
    {
      // RETENTION-R3d (P0 — uncertain-outcome RECOVERY): owner-bound receipt
      // recovery. An interrupted PUT can commit its mutation + durable receipt yet
      // lose its HTTP response; the client re-sends the SAME Idempotency-Key here to
      // retrieve the EXACT committed receipt from the durable audit row — a product
      // seam, not raw DB access. Canonical-owner-gated: a non-canonical principal
      // (admin-002) is refused 403 BEFORE any lookup (zero cross-principal
      // disclosure), and the query itself is scoped to the owner's principal_id.
      operationId: "uix.retention.policy.receipt.get",
      method: "GET",
      path: "/v1/uix/retention-policy/receipt",
      auth: { public: true },
      async handler(ctx): Promise<FridayRetentionReceiptRecoveryResponse> {
        const ownerId = assertCanonicalRetentionOwner(
          ctx.principal ?? null,
          "retention.policy.read",
          deps.resolveCanonicalOwnerId,
        );
        const recoveryKey =
          readIdempotencyKeyHeader(ctx.headers as Record<string, string | undefined> | undefined) ??
          (typeof (ctx.query as { key?: unknown } | undefined)?.key === "string"
            ? ((ctx.query as { key?: string }).key as string).trim() || undefined
            : undefined);
        if (!recoveryKey) {
          throw new FridayDomainError(
            "RETENTION_RECOVERY_KEY_REQUIRED",
            "An Idempotency-Key header (or ?key=) is required to recover a retention-policy receipt.",
            { httpStatus: 400 },
          );
        }
        const receipt = deps.readReceiptByRecoveryKey
          ? deps.readReceiptByRecoveryKey({ ownerId, recoveryKey })
          : null;
        return { receipt };
      },
    },
    {
      // RETENTION-R3b: owner-bound REPORT-ONLY disk-usage/alerts readback — the
      // "disk usage/alerts are visible" seam the Settings UI later consumes. It is
      // guarded by the SAME canonical-owner binding as GET/PUT above (owner/admin
      // ROLE is a floor; the authenticated principal's userId MUST match the single
      // canonical owner; fail-closed 403 if unresolvable). This is the ONLY read
      // surface for the disk-growth reading: it is NEVER published to any
      // /v1/observability/* or other public route (the #1606 SEC-NET-PRINCIPAL-001
      // lesson). Read-only: it never triggers any deletion.
      operationId: "uix.retention.policy.diskusage.get",
      method: "GET",
      path: "/v1/uix/retention-policy/disk-usage",
      auth: { public: true },
      async handler(ctx): Promise<FridayRetentionDiskUsageResponse> {
        assertCanonicalRetentionOwner(
          ctx.principal ?? null,
          "retention.policy.read",
          deps.resolveCanonicalOwnerId,
        );
        return { diskUsage: deps.readDiskUsage ? deps.readDiskUsage() : null };
      },
    },
  ];
}

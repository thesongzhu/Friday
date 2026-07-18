import type Database from "better-sqlite3";
import { FridayDomainError } from "#errors";

import type { CategoryRetention, FridayRetentionContentPolicy } from "./friday-retention.types.js";
import {
  isFridayRetentionContentCategory,
  isValidCategoryRetention,
  isValidFridayRetentionContentPolicy,
} from "./friday-retention.types.js";

/**
 * RETENTION-R3d round-8 (P1 fail-open fix): a TYPED storage-integrity failure for a
 * receipt row that MATCHES an owner + recovery-key-hash lookup but is malformed /
 * structurally-invalid. It exists so the PUT idempotency guard (and the recovery
 * seam) can DISTINGUISH a corrupt-but-matching binding from a genuinely ABSENT one:
 * a corrupt match must NEVER be decoded to `null` (which the guard reads as "key
 * unused" and re-executes the mutation — a fail-OPEN that also breaks same-key
 * immutability). Raised inside the write transaction, it aborts the txn (policy
 * byte-unchanged, no second receipt/audit row); on the recovery read it surfaces as
 * a fail-closed 500 rather than a silent null. HTTP 500-class: a corrupt persisted
 * receipt is a server-side data-integrity fault, not a client error.
 */
export class FridayRetentionReceiptIntegrityError extends FridayDomainError {
  override readonly name = "FridayRetentionReceiptIntegrityError";
  constructor(message: string, options?: { cause?: unknown; details?: Record<string, unknown> }) {
    super("RETENTION_RECEIPT_INTEGRITY_FAILURE", message, {
      httpStatus: 500,
      cause: options?.cause,
      details: options?.details,
    });
  }
}

/**
 * Owner-scoped persistence for retention-policy RECOVERY RECEIPTS (RETENTION-R3d).
 *
 * The dedicated, GOVERNED home for the FULL recovery-receipt facts (before/after
 * policy snapshots, changedCategories, appliedUpdates, payloadDigest, and the
 * non-reversible recovery-key hash). It replaces the earlier design that embedded
 * the whole receipt in `security_audit_log.metadata_json` — where the auditLogs
 * retention job never reached it, silently retaining the user's receipt past their
 * auditLogs deletion policy (an operator-locked U9/DATA-RETENTION-001 violation).
 *
 * Schema: migration v107 (`retention_recovery_receipts`). Every method is scoped
 * by `principal_id` (the resolved canonical owner); recovery lookups match the
 * NON-REVERSIBLE `recovery_key_hash` (the raw key is never stored). The store is
 * governed by the auditLogs content-retention category: default-PERMANENT, but the
 * reaper expires rows when auditLogs is opted into a finite window, and
 * `deleteAllForOwner` is the Delete-All purge seam (DATA-DELETE-ALL-001).
 */
export interface FridayRetentionReceiptRecord {
  /** UNIQUE receipt id (id-generator-seeded). Primary key. */
  readonly receiptId: string;
  /** The RESOLVED canonical owner (never a caller-supplied id). */
  readonly ownerId: string;
  /** The canonical owner's tenant namespace, or null. */
  readonly ownerTenantId: string | null;
  /** UNIQUE correlation id binding audit ⇄ receipt. */
  readonly correlationId: string;
  /** Linkage to the content-minimized `security_audit_log` anchor row id. */
  readonly auditId: string;
  /** Non-reversible sha256 of the client Idempotency-Key (raw key never stored). */
  readonly recoveryKeyHash: string | null;
  /** Digest of the normalized applied updates (immutable-binding conflict guard). */
  readonly payloadDigest: string | null;
  /** Authoritative before-state (pre-apply). */
  readonly before: FridayRetentionContentPolicy;
  /** Authoritative after-state (== what was committed). */
  readonly after: FridayRetentionContentPolicy;
  /** Content categories whose EFFECTIVE policy changed (before ≠ after). */
  readonly changedCategories: string[];
  /** The validated per-category updates that were applied. */
  readonly appliedUpdates: Record<string, CategoryRetention>;
  /** ISO time the mutation was applied. */
  readonly createdAt: string;
}

export interface FridayRetentionReceiptRepository {
  /**
   * Persist ONE receipt on a CALLER-SUPPLIED write connection (no transaction of
   * its own) — the caller's open write transaction provides atomicity so the
   * receipt commits or rolls back together with the policy apply + the
   * content-minimized audit anchor.
   */
  insert(db: Database.Database, record: FridayRetentionReceiptRecord): void;
  /**
   * Read the OLDEST owner-scoped receipt bound to `recoveryKeyHash`
   * (`created_at ASC`), so the FIRST committed receipt for a key is immutable
   * (never "latest wins"). Owner scoping is enforced in the query.
   *
   * Returns `null` EXCLUSIVELY for a genuinely ABSENT binding — no row matches
   * that (owner, key) at all (including after the auditLogs-category reaper has
   * EXPIRED and deleted the row: expiry → truly absent → null is correct). If a
   * row MATCHES but its persisted JSON is malformed or structurally invalid, this
   * FAILS CLOSED with a typed `FridayRetentionReceiptIntegrityError` — it does NOT
   * return null (RETENTION-R3d round-8 P1). A `null` from a corrupt-but-matching
   * row would let the PUT idempotency guard treat the key as unused and re-execute
   * the mutation (fail-open) — so a corrupt match is an integrity fault, never
   * "absent".
   */
  findOldestByRecoveryKey(
    db: Database.Database,
    input: { ownerId: string; recoveryKeyHash: string },
  ): FridayRetentionReceiptRecord | null;
  /**
   * RETENTION reaper seam (auditLogs category): delete receipts committed strictly
   * before an ISO cutoff. Called ONLY when the owner opted auditLogs into a finite
   * window (default-permanent otherwise). Returns the number of rows deleted.
   */
  deleteExpiredBefore(db: Database.Database, cutoffIso: string): number;
  /**
   * DATA-DELETE-ALL-001 seam: purge ALL of one owner's receipts (so a Delete-All
   * compresses this governed store rather than leaving an untracked data island).
   * Returns the number of rows deleted.
   */
  deleteAllForOwner(db: Database.Database, input: { ownerId: string }): number;
}

interface RetentionReceiptRow {
  receipt_id: string;
  principal_id: string;
  tenant_id: string | null;
  correlation_id: string;
  audit_id: string;
  recovery_key_hash: string | null;
  payload_digest: string | null;
  before_json: string;
  after_json: string;
  changed_categories_json: string;
  applied_updates_json: string;
  created_at: string;
}

/** Strict validator: `changedCategories` is an array of canonical category names. */
function isValidChangedCategories(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((c) => isFridayRetentionContentCategory(c));
}

/**
 * Strict validator: `appliedUpdates` is a plain object whose EVERY key is a
 * canonical content category and EVERY value a valid `CategoryRetention`. An empty
 * object is valid (a no-op / permanent-only update). Rejects arrays, unknown
 * category keys, and out-of-domain per-category values.
 */
function isValidAppliedUpdates(value: unknown): value is Record<string, CategoryRetention> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const [category, retention] of Object.entries(value as Record<string, unknown>)) {
    if (!isFridayRetentionContentCategory(category)) return false;
    if (!isValidCategoryRetention(retention)) return false;
  }
  return true;
}

/**
 * Decode + STRICTLY validate a MATCHING receipt row (RETENTION-R3d round-8).
 *
 * This is only ever called with a row the SQL query already MATCHED by
 * (`principal_id`, `recovery_key_hash`), so a malformed/invalid payload here is a
 * STORAGE-INTEGRITY failure on a REAL binding — NOT an absent one. It therefore
 * FAILS CLOSED with a typed `FridayRetentionReceiptIntegrityError` (never returns
 * null): undecodable JSON AND schema-valid-but-semantically-invalid shapes both
 * throw. Every decoded field is validated — `before`/`after` are full content
 * policies (exactly the seven categories, each a valid `CategoryRetention`),
 * `changedCategories` is an array of canonical category names, and `appliedUpdates`
 * is a `{category → CategoryRetention}` map — so a corrupted binding can never be
 * mistaken for an unused key (which would re-execute a PUT) or silently recovered.
 */
function decodeReceiptRow(row: RetentionReceiptRow): FridayRetentionReceiptRecord {
  let before: unknown;
  let after: unknown;
  let changedCategories: unknown;
  let appliedUpdates: unknown;
  try {
    before = JSON.parse(row.before_json);
    after = JSON.parse(row.after_json);
    changedCategories = JSON.parse(row.changed_categories_json);
    appliedUpdates = JSON.parse(row.applied_updates_json);
  } catch (cause) {
    throw new FridayRetentionReceiptIntegrityError(
      `Persisted retention recovery receipt '${row.receipt_id}' is corrupt: a stored JSON column is undecodable.`,
      { cause, details: { receiptId: row.receipt_id, reason: "undecodable_json" } },
    );
  }
  if (!isValidFridayRetentionContentPolicy(before)) {
    throw new FridayRetentionReceiptIntegrityError(
      `Persisted retention recovery receipt '${row.receipt_id}' is corrupt: 'before' is not a valid content policy.`,
      { details: { receiptId: row.receipt_id, reason: "invalid_before" } },
    );
  }
  if (!isValidFridayRetentionContentPolicy(after)) {
    throw new FridayRetentionReceiptIntegrityError(
      `Persisted retention recovery receipt '${row.receipt_id}' is corrupt: 'after' is not a valid content policy.`,
      { details: { receiptId: row.receipt_id, reason: "invalid_after" } },
    );
  }
  if (!isValidChangedCategories(changedCategories)) {
    throw new FridayRetentionReceiptIntegrityError(
      `Persisted retention recovery receipt '${row.receipt_id}' is corrupt: 'changedCategories' is not an array of valid category names.`,
      { details: { receiptId: row.receipt_id, reason: "invalid_changed_categories" } },
    );
  }
  if (!isValidAppliedUpdates(appliedUpdates)) {
    throw new FridayRetentionReceiptIntegrityError(
      `Persisted retention recovery receipt '${row.receipt_id}' is corrupt: 'appliedUpdates' is not a valid category→retention map.`,
      { details: { receiptId: row.receipt_id, reason: "invalid_applied_updates" } },
    );
  }
  return {
    receiptId: row.receipt_id,
    ownerId: row.principal_id,
    ownerTenantId: row.tenant_id,
    correlationId: row.correlation_id,
    auditId: row.audit_id,
    recoveryKeyHash: row.recovery_key_hash,
    payloadDigest: row.payload_digest,
    before,
    after,
    changedCategories,
    appliedUpdates,
    createdAt: row.created_at,
  };
}

export function createFridayRetentionReceiptRepository(): FridayRetentionReceiptRepository {
  return {
    insert(db, record) {
      db.prepare(
        `INSERT INTO retention_recovery_receipts (
           receipt_id, principal_id, tenant_id, correlation_id, audit_id,
           recovery_key_hash, payload_digest, before_json, after_json,
           changed_categories_json, applied_updates_json, created_at
         ) VALUES (
           @receipt_id, @principal_id, @tenant_id, @correlation_id, @audit_id,
           @recovery_key_hash, @payload_digest, @before_json, @after_json,
           @changed_categories_json, @applied_updates_json, @created_at
         )`,
      ).run({
        receipt_id: record.receiptId,
        principal_id: record.ownerId,
        tenant_id: record.ownerTenantId ?? null,
        correlation_id: record.correlationId,
        audit_id: record.auditId,
        recovery_key_hash: record.recoveryKeyHash ?? null,
        payload_digest: record.payloadDigest ?? null,
        before_json: JSON.stringify(record.before),
        after_json: JSON.stringify(record.after),
        changed_categories_json: JSON.stringify(record.changedCategories),
        applied_updates_json: JSON.stringify(record.appliedUpdates),
        created_at: record.createdAt,
      });
    },

    findOldestByRecoveryKey(db, input) {
      const row = db
        .prepare(
          `SELECT receipt_id, principal_id, tenant_id, correlation_id, audit_id,
                  recovery_key_hash, payload_digest, before_json, after_json,
                  changed_categories_json, applied_updates_json, created_at
             FROM retention_recovery_receipts
            WHERE principal_id = ?
              AND recovery_key_hash = ?
            ORDER BY created_at ASC, receipt_id ASC
            LIMIT 1`,
        )
        .get(input.ownerId, input.recoveryKeyHash) as RetentionReceiptRow | undefined;
      // NO matching row → genuinely absent → null (the ONLY null case). A MATCHING
      // row that is malformed/invalid throws a typed integrity error (fail-closed),
      // never null — so the PUT idempotency guard cannot re-execute on a corrupt
      // binding and recovery cannot silently return null.
      return row ? decodeReceiptRow(row) : null;
    },

    deleteExpiredBefore(db, cutoffIso) {
      return db
        .prepare(`DELETE FROM retention_recovery_receipts WHERE created_at < ?`)
        .run(cutoffIso).changes;
    },

    deleteAllForOwner(db, input) {
      return db
        .prepare(`DELETE FROM retention_recovery_receipts WHERE principal_id = ?`)
        .run(input.ownerId).changes;
    },
  };
}

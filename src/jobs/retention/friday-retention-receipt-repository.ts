import type Database from "better-sqlite3";

import type { CategoryRetention, FridayRetentionContentPolicy } from "./friday-retention.types.js";

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
   * (never "latest wins"). Owner scoping is enforced in the query. Returns null
   * when no receipt is bound to that (owner, key) or the stored row is malformed.
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

function rowToRecord(row: RetentionReceiptRow): FridayRetentionReceiptRecord | null {
  let before: FridayRetentionContentPolicy;
  let after: FridayRetentionContentPolicy;
  let changedCategories: string[];
  let appliedUpdates: Record<string, CategoryRetention>;
  try {
    before = JSON.parse(row.before_json) as FridayRetentionContentPolicy;
    after = JSON.parse(row.after_json) as FridayRetentionContentPolicy;
    changedCategories = JSON.parse(row.changed_categories_json) as string[];
    appliedUpdates = JSON.parse(row.applied_updates_json) as Record<string, CategoryRetention>;
  } catch {
    // A corrupt stored receipt is treated as unrecoverable (fail closed) rather
    // than surfacing a partially-decoded receipt.
    return null;
  }
  if (!before || !after) return null;
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
      return row ? rowToRecord(row) : null;
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

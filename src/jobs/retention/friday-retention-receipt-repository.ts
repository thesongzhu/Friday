import type Database from "better-sqlite3";
import { FridayDomainError } from "#errors";

// RETENTION-R3d round-9: recompute the receipt's derived facts with the EXACT
// canonical write-path functions (zero drift). `hashIdempotencyPayload` is the SAME
// pure digest the PUT handler uses to set `payloadDigest`; importing it directly
// mirrors the existing satellites→routes value import of the same function (no
// eslint import-boundary rule, and it pulls in only `node:crypto` + `#errors`).
import { hashIdempotencyPayload } from "../../api/http/routes/friday-route-idempotency.js";
import type { CategoryRetention, FridayRetentionContentPolicy } from "./friday-retention.types.js";
import {
  FRIDAY_RETENTION_CONTENT_CATEGORIES,
  isFridayRetentionContentCategory,
  isValidCategoryRetention,
  isValidFridayRetentionContentPolicy,
} from "./friday-retention.types.js";
import {
  applyContentPolicyOverlay,
  computeChangedCategories,
  retentionEquals,
} from "./friday-retention-receipt-coherence.js";

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
 * CANONICAL `created_at` SHAPE gate (SQL GLOB) — the STORAGE-boundary (v108 CHECK)
 * and REAPER-quarantine approximation of a canonical ISO-8601 UTC instant
 * `YYYY-MM-DDTHH:MM:SS.sssZ`. SQLite has no date type, so this is a shape mask with
 * tightened component ranges (month `[0-1]`, day `[0-3]`, hour `[0-2]`, min/sec
 * `[0-5]`) that accepts EVERY real `Date#toISOString()` yet rejects `"zzzz"`, the
 * empty string, a non-`Z` offset, AND the impossible `9999-99-99T99:99:99.999Z`.
 *
 * ONE source of truth: the v108 migration INLINES this exact literal (a migration
 * is a frozen artifact and must not interpolate a mutable constant) and a guard
 * test asserts agreement; the reaper's finite-sweep quarantine consumes THIS
 * constant, so the storage bound and the reap bound can never silently diverge.
 * NB: this is a SHAPE approximation only — the read/serve path additionally
 * enforces the EXACT instant via `isCanonicalReceiptCreatedAt` (round-trip).
 */
export const FRIDAY_RETENTION_RECEIPT_CREATED_AT_GLOB =
  "[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z";

/** Exact canonical-instant regex: `YYYY-MM-DDTHH:MM:SS.sssZ` (millis + literal Z). */
const CANONICAL_ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Non-reversible sha256 digest / key hash shape: exactly 64 lowercase hex chars. */
const SHA256_LOWER_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * STRICT canonical-instant gate for a persisted `created_at` (read/serve path).
 * Accepts EXACTLY what `new Date().toISOString()` emits and REJECTS anything that
 * does not round-trip: `"zzzz"`, empty/non-string, a non-`Z` offset, and any
 * far-past/far-future value that does not `new Date(s).toISOString() === s`. This
 * is the exact instant gate the GLOB only approximates.
 */
export function isCanonicalReceiptCreatedAt(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (!CANONICAL_ISO_INSTANT_RE.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/**
 * FRIDAY_RETENTION_RECEIPT_ROW_INVARIANT — the ONE canonical whole-row invariant
 * for a persisted `retention_recovery_receipts` row (RETENTION-R3d). It is enforced
 * by the SINGLE validator `assertReceiptRowIntegrity` at EVERY seam (write / insert,
 * read / decode, idempotent-replay, recovery, restart-readback) with ZERO drift; the
 * reaper boundary enforces the SAME canonical `created_at` shape via the shared
 * `FRIDAY_RETENTION_RECEIPT_CREATED_AT_GLOB`. Any violation throws a typed
 * `FridayRetentionReceiptIntegrityError` (code `RETENTION_RECEIPT_INTEGRITY_FAILURE`,
 * HTTP 500) with a DISTINCT `reason` per column/invariant. `null` from
 * `findOldestByRecoveryKey` is reserved EXCLUSIVELY for a genuinely ABSENT row (no
 * SQL match) — a matching-but-corrupt row NEVER decodes to null.
 *
 * EVERY persisted column + EVERY cross-column / cross-store invariant:
 *   - receipt_id       — non-empty; shape `retention-receipt:<principalId>:<opId>`
 *                        (prefix + principal segment == principal_id + non-empty opId).
 *   - principal_id     — non-empty; == the owner the row was looked up under.
 *   - tenant_id        — null OR a non-empty string.
 *   - correlation_id   — non-empty; shape `retention-policy-update:<principalId>:<opId>`
 *                        (prefix + principal segment == principal_id) AND its opId ==
 *                        the receipt_id opId (one-write linkage — catches a one-sided
 *                        correlation_id tamper even without the anchor).
 *   - audit_id         — non-empty string.
 *   - recovery_key_hash— null OR 64-char lowercase hex (sha256).
 *   - payload_digest   — 64-char lowercase hex AND == hashIdempotencyPayload(appliedUpdates)
 *                        (round-9 digest coherence).
 *   - created_at       — STRICT canonical ISO-8601 UTC instant that round-trips
 *                        (`isCanonicalReceiptCreatedAt`).
 *   - before/after/changedCategories/appliedUpdates — exact-shape + cross-field
 *                        coherence: after == overlay(before, appliedUpdates),
 *                        changedCategories == authoritative sorted diff, digest match
 *                        (INTERNAL to the receipt only — a legitimately STALE receipt
 *                        still decodes; never compared to the current policy).
 *   - ANCHOR cross-check (cross-store): the content-minimized `security_audit_log`
 *                        anchor row `id == audit_id` MUST exist and satisfy
 *                        metadata.receiptId == receipt_id, metadata.correlationId ==
 *                        correlation_id, metadata.payloadDigest == payload_digest,
 *                        principal_id == principal_id, tenant_id == tenant_id.
 *                        Absent/mismatch → fail closed (a one-sided linkage
 *                        corruption is never served as a valid correlated receipt).
 */
export const FRIDAY_RETENTION_RECEIPT_ROW_INVARIANT =
  "receipt_id/principal_id/tenant_id/correlation_id/audit_id/recovery_key_hash/" +
  "payload_digest/created_at + before/after/changedCategories/appliedUpdates coherence " +
  "+ security_audit_log anchor cross-check — one validator, every seam, zero drift";

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
   *
   * WHOLE-ROW INVARIANT: the compare is guarded by the canonical `created_at` shape
   * (`FRIDAY_RETENTION_RECEIPT_CREATED_AT_GLOB`) so ONLY reliably-datable rows are
   * expired by the lexicographic `created_at < cutoff` compare; a non-canonical
   * `created_at` (which sorts AFTER any ISO cutoff) is NOT silently retained here —
   * it is handled by `quarantineNonCanonicalCreatedAt` in the SAME finite sweep.
   */
  deleteExpiredBefore(db: Database.Database, cutoffIso: string): number;
  /**
   * RETENTION reaper seam (auditLogs category) — QUARANTINE the un-datable. Delete
   * every receipt row whose persisted `created_at` is NOT a STRICT canonical instant
   * (`isCanonicalReceiptCreatedAt` round-trip). Such a row cannot be reliably dated,
   * so a `created_at < cutoff` compare would let it SILENTLY SURVIVE a finite
   * retention window (DATA-RETENTION-001 truthfulness break). This covers BOTH
   * coarse-bad values that fail the shape GLOB (e.g. `"zzzz"`, a non-`Z` offset) AND
   * shaped-but-IMPOSSIBLE calendar values the coarse GLOB accepts (month 13-19, day
   * 32-39, hour 24-29, Feb-30, …) — the GLOB is a shape mask with no calendar
   * semantics, so the strict round-trip is the authoritative "non-canonical" gate.
   * A real `toISOString()` row ALWAYS round-trips → never quarantined (no
   * over-fail-close). ALSO quarantines a canonical-but-FUTURE-dated row
   * (`created_at > nowIso`, the sweep's current time): a receipt cannot legitimately
   * be created after the sweep's now (same-process clock, written earlier), so a
   * future timestamp is un-datable-as-a-past-instant and — passing the GLOB +
   * round-trip yet sorting after any cutoff — would otherwise SURVIVE a finite
   * window. Called ONLY inside the finite auditLogs sweep (default-permanent ⇒ never
   * called ⇒ 0), so the un-datable row is retained (never served) until the owner
   * opts in. Returns the number of rows quarantine-deleted. Does NOT abort the sweep
   * — one corrupt row must not block reaping valid rows.
   */
  quarantineNonCanonicalCreatedAt(db: Database.Database, nowIso: string): number;
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

/** The content-minimized `security_audit_log` anchor row read for the cross-check. */
interface RetentionReceiptAnchorRow {
  id: string;
  principal_id: string | null;
  tenant_id: string | null;
  metadata_json: string;
  created_at: string;
}

/**
 * CROSS-STORE anchor cross-check (RETENTION-R3d whole-row invariant, required
 * action #3). Before a receipt is REPLAYED or RECOVERED (served to the owner), it
 * is cross-checked against its content-minimized `security_audit_log` anchor — the
 * row the audit appender wrote in the SAME transaction with `id == audit_id`,
 * `principalId`, `tenantId`, and `metadata = {receiptId, correlationId,
 * payloadDigest}`. The anchor is the AUTHORITATIVE linkage: it is append-only /
 * default-permanent (no reaper or Delete-All path deletes `security_audit_log`), so
 * it strictly OUTLIVES the reap-able receipt — a LIVE receipt therefore ALWAYS has a
 * live anchor and this check NEVER over-fail-closes on a legitimately-reaped anchor.
 * An ABSENT anchor (tampered `audit_id`) or ANY field mismatch (a one-sided
 * `correlation_id` / linkage corruption) fails CLOSED — such a receipt is never
 * served as a valid correlated receipt.
 */
function assertReceiptAnchor(row: RetentionReceiptRow, db: Database.Database): void {
  const anchor = db
    .prepare(
      `SELECT id, principal_id, tenant_id, metadata_json, created_at
         FROM security_audit_log
        WHERE id = ?`,
    )
    .get(row.audit_id) as RetentionReceiptAnchorRow | undefined;
  if (!anchor) {
    throw new FridayRetentionReceiptIntegrityError(
      `Persisted retention recovery receipt '${row.receipt_id}' has no authentic-audit anchor (audit_id='${row.audit_id}').`,
      { details: { receiptId: row.receipt_id, reason: "anchor_absent", auditId: row.audit_id } },
    );
  }
  let metadata: Record<string, unknown>;
  try {
    const parsed = JSON.parse(anchor.metadata_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("anchor metadata is not a JSON object");
    }
    metadata = parsed as Record<string, unknown>;
  } catch (cause) {
    throw new FridayRetentionReceiptIntegrityError(
      `Persisted retention recovery receipt '${row.receipt_id}' has an unreadable audit-anchor metadata.`,
      { cause, details: { receiptId: row.receipt_id, reason: "anchor_metadata_unreadable", auditId: row.audit_id } },
    );
  }
  const checks: Array<readonly [string, boolean]> = [
    ["receiptId", metadata.receiptId === row.receipt_id],
    ["correlationId", metadata.correlationId === row.correlation_id],
    ["payloadDigest", metadata.payloadDigest === row.payload_digest],
    ["principalId", (anchor.principal_id ?? null) === row.principal_id],
    ["tenantId", (anchor.tenant_id ?? null) === (row.tenant_id ?? null)],
    // TIMESTAMP linkage (required_action #3): the anchor's own `created_at` and the
    // receipt's `created_at` are both stamped from the SAME write-path `runAt`
    // (byte-equal on a legit write — empirically verified), so a raw-DB `created_at`
    // tamper to a DIFFERENT canonical value is served with the wrong timestamp unless
    // cross-checked here.
    ["createdAt", anchor.created_at === row.created_at],
  ];
  for (const [field, ok] of checks) {
    if (!ok) {
      throw new FridayRetentionReceiptIntegrityError(
        `Persisted retention recovery receipt '${row.receipt_id}' diverges from its audit anchor on '${field}'.`,
        { details: { receiptId: row.receipt_id, reason: `anchor_mismatch:${field}`, auditId: row.audit_id } },
      );
    }
  }
}

/**
 * WHOLE-ROW INVARIANT — the SCALAR columns + cross-column linkage (RETENTION-R3d).
 * Extracted from `assertReceiptRowIntegrity` (single caller) so the one validator
 * stays cohesive without a monolithic complexity. Each violation throws a typed
 * `FridayRetentionReceiptIntegrityError` with a DISTINCT `reason`.
 */
function assertReceiptScalarColumns(row: RetentionReceiptRow, expectedOwnerId: string): void {
  const fail = (reason: string, detail: string, extra?: Record<string, unknown>): never => {
    throw new FridayRetentionReceiptIntegrityError(
      `Persisted retention recovery receipt '${row.receipt_id}' violates the row invariant: ${detail}.`,
      { details: { receiptId: row.receipt_id, reason, ...(extra ?? {}) } },
    );
  };

  // principal_id — non-empty AND exactly the owner the row was looked up under.
  if (typeof row.principal_id !== "string" || row.principal_id.length === 0) {
    fail("invalid_principal_id", "'principal_id' is empty");
  }
  if (row.principal_id !== expectedOwnerId) {
    fail("owner_mismatch", "'principal_id' is not the owner the row was looked up under", {
      expectedOwnerId,
    });
  }

  // receipt_id — shape `retention-receipt:<principalId>:<opId>` (non-empty opId).
  const receiptPrefix = `retention-receipt:${row.principal_id}:`;
  if (
    typeof row.receipt_id !== "string" ||
    !row.receipt_id.startsWith(receiptPrefix) ||
    row.receipt_id.length <= receiptPrefix.length
  ) {
    fail("invalid_receipt_id", "'receipt_id' does not match retention-receipt:<owner>:<op>");
  }
  const receiptOpId = row.receipt_id.slice(receiptPrefix.length);

  // correlation_id — shape `retention-policy-update:<principalId>:<opId>` AND its
  // opId == the receipt_id opId (single-write linkage: a one-sided correlation_id
  // tamper is caught HERE even before the anchor cross-check).
  const correlationPrefix = `retention-policy-update:${row.principal_id}:`;
  if (
    typeof row.correlation_id !== "string" ||
    !row.correlation_id.startsWith(correlationPrefix) ||
    row.correlation_id.length <= correlationPrefix.length
  ) {
    fail("invalid_correlation_id", "'correlation_id' does not match retention-policy-update:<owner>:<op>");
  }
  const correlationOpId = row.correlation_id.slice(correlationPrefix.length);
  if (correlationOpId !== receiptOpId) {
    fail("linkage_operation_mismatch", "'correlation_id' operation id does not match 'receipt_id'");
  }

  // tenant_id — null OR a non-empty string.
  if (row.tenant_id !== null && (typeof row.tenant_id !== "string" || row.tenant_id.length === 0)) {
    fail("invalid_tenant_id", "'tenant_id' is neither null nor a non-empty string");
  }

  // audit_id — non-empty string (the anchor linkage key).
  if (typeof row.audit_id !== "string" || row.audit_id.length === 0) {
    fail("invalid_audit_id", "'audit_id' is empty");
  }

  // recovery_key_hash — null OR 64-char lowercase hex (sha256).
  if (row.recovery_key_hash !== null && !SHA256_LOWER_HEX_RE.test(row.recovery_key_hash)) {
    fail("invalid_recovery_key_hash", "'recovery_key_hash' is neither null nor a 64-char lowercase hex");
  }

  // payload_digest — 64-char lowercase hex (its VALUE coherence was gated above).
  if (typeof row.payload_digest !== "string" || !SHA256_LOWER_HEX_RE.test(row.payload_digest)) {
    fail("invalid_payload_digest", "'payload_digest' is not a 64-char lowercase hex");
  }

  // created_at — STRICT canonical ISO-8601 UTC instant that round-trips (rejects the
  // `"zzzz"` retention-evasion the reaper's lexicographic compare could not sort).
  if (!isCanonicalReceiptCreatedAt(row.created_at)) {
    fail("invalid_created_at", "'created_at' is not a canonical round-trippable ISO-8601 UTC instant");
  }
}

/**
 * assertReceiptRowIntegrity — the ONE canonical WHOLE-ROW validator
 * (RETENTION-R3d). It is the SAME validator used at every seam: write (`insert`),
 * read / decode (`findOldestByRecoveryKey`), idempotent-replay, recovery, and
 * restart-readback (the reaper enforces the same `created_at` shape via the shared
 * GLOB). It replaces the earlier reactive field-by-field additions with a single
 * enforcement of `FRIDAY_RETENTION_RECEIPT_ROW_INVARIANT` — see that constant for
 * the complete per-column + cross-column + cross-store rule set.
 *
 * It is only ever called with a REAL binding (the SQL matched, or the write is
 * about to persist it), so ANY violation is a STORAGE-INTEGRITY failure — NOT an
 * absent one. It therefore FAILS CLOSED with a typed
 * `FridayRetentionReceiptIntegrityError` (never returns null) and a DISTINCT
 * `reason` per column/invariant. `null` from `findOldestByRecoveryKey` is reserved
 * EXCLUSIVELY for a genuinely ABSENT row.
 *
 * Ordering is deliberate: JSON decode → per-field shape → cross-field coherence →
 * scalar columns → cross-store anchor. Coherence is INTERNAL to the receipt only (a
 * legitimately STALE receipt still decodes); the anchor cross-check runs LAST so a
 * value tamper surfaces its precise coherence reason (e.g. `digest_mismatch`) rather
 * than a generic anchor mismatch.
 */
export function assertReceiptRowIntegrity(
  row: RetentionReceiptRow,
  opts: { expectedOwnerId: string; db: Database.Database },
): FridayRetentionReceiptRecord {
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

  // ── RETENTION-R3d round-9: CROSS-FIELD COHERENCE (P1 fail-open fix) ─────────
  // Every field is now individually well-shaped; verify they are MUTUALLY
  // coherent. Coherence is INTERNAL to the receipt ONLY — it is NEVER compared
  // against the current authoritative policy, so a legitimately STALE receipt
  // (its `after` differs from a now-current policy a later different-key write
  // changed) still decodes fine. Each recompute uses the SAME canonical write-path
  // function the PUT handler used, so there is zero drift. Any incoherence is a
  // storage-integrity fault → fail CLOSED with a distinct `reason` (never a null
  // that the idempotency guard would read as "unused key" and re-execute on).

  // (a) apply-coherence: the stored `after` must equal overlay(before,
  //     appliedUpdates) across all seven categories — the store's apply semantics.
  const expectedAfter = applyContentPolicyOverlay(before, appliedUpdates);
  for (const category of FRIDAY_RETENTION_CONTENT_CATEGORIES) {
    if (!retentionEquals(expectedAfter[category], after[category])) {
      throw new FridayRetentionReceiptIntegrityError(
        `Persisted retention recovery receipt '${row.receipt_id}' is incoherent: 'after' is not overlay(before, appliedUpdates).`,
        { details: { receiptId: row.receipt_id, reason: "apply_incoherent", category } },
      );
    }
  }

  // (b) changed-coherence: the stored `changedCategories` must be EXACTLY the
  //     authoritative sorted diff. Comparing the recomputed SORTED array to the
  //     stored array element-by-element rejects duplicates / missing / extra /
  //     wrong order in one check.
  const expectedChanged = computeChangedCategories(before, after);
  const changedCoherent =
    expectedChanged.length === changedCategories.length &&
    expectedChanged.every((category, index) => category === changedCategories[index]);
  if (!changedCoherent) {
    throw new FridayRetentionReceiptIntegrityError(
      `Persisted retention recovery receipt '${row.receipt_id}' is incoherent: 'changedCategories' is not the authoritative sorted diff.`,
      { details: { receiptId: row.receipt_id, reason: "changed_categories_incoherent" } },
    );
  }

  // (c) digest-coherence: `payloadDigest` must equal the canonical recompute over
  //     `appliedUpdates`. The write path ALWAYS sets it, so a null/absent stored
  //     digest against a non-null recompute is itself corrupt (`string !== null`).
  const expectedDigest = hashIdempotencyPayload(appliedUpdates);
  if (row.payload_digest !== expectedDigest) {
    throw new FridayRetentionReceiptIntegrityError(
      `Persisted retention recovery receipt '${row.receipt_id}' is incoherent: 'payloadDigest' does not match the canonical recompute of appliedUpdates.`,
      { details: { receiptId: row.receipt_id, reason: "digest_mismatch" } },
    );
  }

  // ── WHOLE-ROW INVARIANT: scalar columns + cross-column linkage, then the
  //    cross-store anchor. Every SCALAR column (previously returned unvalidated) is
  //    now checked; this closes the scalar-column fail-opens (a non-canonical
  //    `created_at` that evaded the reaper's string compare, and a one-sided
  //    `correlation_id`/`audit_id` linkage corruption served as a valid receipt).
  assertReceiptScalarColumns(row, opts.expectedOwnerId);
  assertReceiptAnchor(row, opts.db);

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
      const row: RetentionReceiptRow = {
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
      };
      // WHOLE-ROW INVARIANT at the WRITE seam (SAME validator as read/decode, zero
      // drift). The audit anchor is written earlier in this SAME transaction, so the
      // cross-store anchor check sees it and proves the receipt⇄anchor coupling at
      // write time; a receipt that would violate the invariant (or has no anchor)
      // throws INSIDE the txn → the whole PUT rolls back (no partial rows).
      assertReceiptRowIntegrity(row, { expectedOwnerId: record.ownerId, db });
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
      ).run(row);
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
      // row that violates the WHOLE-ROW INVARIANT throws a typed integrity error
      // (fail-closed), never null — so the PUT idempotency guard cannot re-execute on
      // a corrupt binding and recovery cannot silently return null. `expectedOwnerId`
      // is the owner the row was looked up under (the invariant re-asserts the match);
      // `db` lets the validator cross-check the receipt against its audit anchor.
      return row
        ? assertReceiptRowIntegrity(row, { expectedOwnerId: input.ownerId, db })
        : null;
    },

    deleteExpiredBefore(db, cutoffIso) {
      // Expire only reliably-datable rows: a CANONICAL `created_at` (shared GLOB)
      // strictly before the cutoff. A non-canonical `created_at` (which would sort
      // AFTER any ISO cutoff and silently survive) is NOT reached here — the finite
      // sweep quarantines it via `quarantineNonCanonicalCreatedAt`.
      return db
        .prepare(
          `DELETE FROM retention_recovery_receipts
            WHERE created_at < ?
              AND created_at GLOB ?`,
        )
        .run(cutoffIso, FRIDAY_RETENTION_RECEIPT_CREATED_AT_GLOB).changes;
    },

    quarantineNonCanonicalCreatedAt(db, nowIso) {
      // Delete rows whose `created_at` cannot be trusted as a PAST canonical instant —
      // retaining them under a finite window would break DATA-RETENTION truthfulness.
      // Called ONLY inside the finite auditLogs sweep.
      //
      // (1) Fast path: coarse-bad values that fail the shape GLOB (`"zzzz"`, empty, a
      //     non-`Z` offset) are deleted set-based in SQL.
      let removed = db
        .prepare(
          `DELETE FROM retention_recovery_receipts
            WHERE created_at NOT GLOB ?`,
        )
        .run(FRIDAY_RETENTION_RECEIPT_CREATED_AT_GLOB).changes;
      // (2) Shaped rows — re-check with the STRICT gate. Quarantine a shaped row when:
      //     (a) it is NOT a canonical round-trip instant (the GLOB is a shape mask
      //         with no calendar semantics, so it accepts impossible values like
      //         month 13-19, day 32-39, hour 24-29, Feb-30), OR
      //     (b) it is FUTURE-dated (`created_at > nowIso`): a receipt cannot be
      //         created after the sweep's now, and a future canonical value passes the
      //         GLOB + round-trip yet sorts after any cutoff → it would evade a finite
      //         window. A legit receipt's `created_at` is always ≤ the reaper's now
      //         (same-process clock, written earlier) → NEVER future → no
      //         over-fail-close. Lexicographic compare is correct for canonical ISO.
      //     The receipt store is small (one row per policy-update-per-key), so this
      //     scan is bounded.
      const shaped = db
        .prepare(
          `SELECT receipt_id, created_at
             FROM retention_recovery_receipts
            WHERE created_at GLOB ?`,
        )
        .all(FRIDAY_RETENTION_RECEIPT_CREATED_AT_GLOB) as Array<{
        receipt_id: string;
        created_at: string;
      }>;
      const deleteById = db.prepare(
        `DELETE FROM retention_recovery_receipts WHERE receipt_id = ?`,
      );
      for (const row of shaped) {
        if (!isCanonicalReceiptCreatedAt(row.created_at) || row.created_at > nowIso) {
          removed += deleteById.run(row.receipt_id).changes;
        }
      }
      return removed;
    },

    deleteAllForOwner(db, input) {
      return db
        .prepare(`DELETE FROM retention_recovery_receipts WHERE principal_id = ?`)
        .run(input.ownerId).changes;
    },
  };
}

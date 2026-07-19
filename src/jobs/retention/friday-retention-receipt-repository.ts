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
 * RAW-BYTES CANONICAL-JSON gate (RETENTION-R3d — JSON representation-attack class).
 * A stored JSON blob `s` is CANONICAL iff `JSON.stringify(JSON.parse(s)) === s`.
 *
 * WHY the parsed view is not enough: `JSON.parse` silently collapses a DUPLICATE
 * member name to its LAST value, so a parsed-object validator (`Object.keys`, field
 * equality, shape/coherence) is BLIND to attacker content hidden in a DISCARDED
 * earlier duplicate member — the raw stored bytes still carry it. In the append-only,
 * default-PERMANENT `security_audit_log` anchor that is a permanent content/secret
 * RETENTION ISLAND the parsed checks can never see (e.g. `metadata_json =
 * {"receiptId":"<secret>",...,"receiptId":"<correct>"}` parses to exactly the correct
 * 3-key object, passes the exact-key + linkage checks, and was SERVED — while the raw
 * bytes retain "<secret>" indefinitely).
 *
 * The canonical-bytes invariant REJECTS, in ONE check, the whole representation class
 * the parsed view cannot see: DUPLICATE member names (parse dedups → re-stringify is
 * shorter ≠ s), EXTRA whitespace / newlines (`JSON.stringify` emits none ≠ s), and
 * ESCAPED-EQUIVALENT member names (`receiptId` → parse → `receiptId` →
 * re-stringify unescaped ≠ s). Every LEGIT blob is written by `JSON.stringify`, so it
 * round-trips to itself and PASSES — empirically verified byte-for-byte against a real
 * single- AND multi-tenant PUT for the anchor `metadata_json` and all four receipt
 * JSON columns (`before_json`/`after_json`/`changed_categories_json`/
 * `applied_updates_json`) → NO over-fail-close.
 *
 * The reported message + `details` carry ONLY the reason + linkage ids — NEVER the raw
 * bytes — so a stuffed-secret duplicate value never egresses through the fail-closed
 * error. If `raw` is NOT decodable JSON at all (`JSON.parse` throws), this RETURNS
 * without throwing: an undecodable column is not a "non-canonical" fault — the caller's
 * own decode path reports it (`undecodable_json` for a receipt column; the anchor's
 * object-guard already surfaced `anchor_metadata_unreadable` before this runs).
 */
function assertCanonicalJsonBytes(
  raw: string,
  ctx: { reason: string; receiptId: string; auditId?: string },
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // undecodable → not a canonicality fault; the caller's decode path reports it
  }
  if (JSON.stringify(parsed) !== raw) {
    throw new FridayRetentionReceiptIntegrityError(
      `Persisted retention recovery receipt '${ctx.receiptId}' has a non-canonical stored JSON blob (raw-byte duplicate-member / escaped-name / whitespace representation attack).`,
      {
        details: {
          receiptId: ctx.receiptId,
          reason: ctx.reason,
          ...(ctx.auditId !== undefined ? { auditId: ctx.auditId } : {}),
        },
      },
    );
  }
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
 *                        anchor row `id == audit_id` MUST exist, carry EXACTLY the
 *                        allowed metadata keys {receiptId, correlationId,
 *                        payloadDigest} (no extra/missing key — closes the permanent-
 *                        anchor content-retention island), and satisfy the LINKAGE
 *                        (metadata.receiptId == receipt_id,
 *                        metadata.correlationId == correlation_id,
 *                        metadata.payloadDigest == payload_digest, principal_id ==
 *                        principal_id, tenant_id == tenant_id, created_at ==
 *                        created_at) AND the SEMANTIC ENVELOPE (action ==
 *                        "retention.policy.update", resource_type == "policy",
 *                        resource_id == "retention-policy:"+principal_id, decision ==
 *                        "allow", session_id == correlation_id, reason ==
 *                        "canonical-owner retention policy update"). Absent/mismatch →
 *                        fail closed (a one-sided linkage corruption, or an anchor
 *                        retargeted so it no longer records the claimed policy update,
 *                        is never served as a valid correlated receipt).
 */
export const FRIDAY_RETENTION_RECEIPT_ROW_INVARIANT =
  "receipt_id/principal_id/tenant_id/correlation_id/audit_id/recovery_key_hash/" +
  "payload_digest/created_at + before/after/changedCategories/appliedUpdates coherence " +
  "+ security_audit_log anchor cross-check (exact-key metadata {receiptId,correlationId," +
  "payloadDigest} + linkage + semantic envelope) — one validator, every seam, zero drift";

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

/**
 * Outcome of ONE `quarantineNonCanonicalCreatedAt` pass — separates the rows
 * DELETED as un-datable/one-sided-corrupt (`quarantined`) from the CLOCK-SKEWED
 * rows PRESERVED-and-flagged (`clockAnomalyPreserved`, anchor `created_at` agrees).
 */
export interface FridayRetentionReceiptQuarantineResult {
  /** Rows quarantine-DELETED this pass (non-canonical, or future + anchor mismatch). */
  readonly quarantined: number;
  /** Future-dated rows PRESERVED because the audit anchor carries the SAME created_at. */
  readonly clockAnomalyPreserved: number;
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
   * RETENTION reaper seam (auditLogs category) — QUARANTINE the un-datable,
   * CLOCK-REGRESSION-SAFE. Delete every receipt row whose persisted `created_at` is
   * NOT a STRICT canonical instant (`isCanonicalReceiptCreatedAt` round-trip). Such
   * a row cannot be reliably dated, so a `created_at < cutoff` compare would let it
   * SILENTLY SURVIVE a finite retention window (DATA-RETENTION-001 truthfulness
   * break). This covers BOTH coarse-bad values that fail the shape GLOB (e.g.
   * `"zzzz"`, a non-`Z` offset) AND shaped-but-IMPOSSIBLE calendar values the coarse
   * GLOB accepts (month 13-19, day 32-39, hour 24-29, Feb-30, …) — the GLOB is a
   * shape mask with no calendar semantics, so the strict round-trip is the
   * authoritative "non-canonical" gate. A real `toISOString()` row ALWAYS
   * round-trips → never quarantined on shape (no over-fail-close).
   *
   * FUTURE-dated rows use an ANCHOR-COMPARISON model (NOT the old blind
   * `created_at > nowIso ⇒ delete`, which DESTROYED legitimate data on a BACKWARD
   * wall-clock jump / NTP correction — a receipt written at a real instant that is
   * now "future" relative to a rolled-back `now`). For a canonical FUTURE-relative
   * row (`created_at > nowIso`) the audit anchor's own `created_at` is consulted:
   *   - anchor `created_at` === row `created_at` → a genuine CLOCK-SKEWED pair →
   *     PRESERVE it and count it in `clockAnomalyPreserved` (it is only ever deleted
   *     later, by `deleteExpiredBefore`, once it is DEMONSTRABLY older than cutoff);
   *   - anchor `created_at` MISMATCHES → one-sided timestamp corruption → quarantine;
   *   - anchor ABSENT → PRESERVE (fail-closed: never delete uncertain data; the read
   *     path already refuses to serve it as `anchor_absent`).
   * Base retention deletion stays `deleteExpiredBefore` (`created_at < cutoff`),
   * itself clock-regression-safe (a backward clock makes the cutoff EARLIER ⇒
   * deletes FEWER, never more). Called ONLY inside the finite auditLogs sweep
   * (default-permanent ⇒ never called ⇒ {0,0}). Does NOT abort the sweep — one
   * corrupt row must not block reaping valid rows.
   */
  quarantineNonCanonicalCreatedAt(
    db: Database.Database,
    nowIso: string,
  ): FridayRetentionReceiptQuarantineResult;
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
  action: string;
  resource_type: string;
  resource_id: string | null;
  decision: string;
  reason: string | null;
  session_id: string | null;
  metadata_json: string;
  created_at: string;
}

/**
 * The CANONICAL retention-policy audit SEMANTIC ENVELOPE — the exact
 * `security_audit_log` field values the write-path appender
 * (`createFridayRetentionPolicyAuditAppender`) stamps for EVERY retention-policy
 * update. Empirically verified byte-for-byte against a real single- AND
 * multi-tenant PUT (stored columns `action` / `resource_type` / `resource_id` /
 * `decision` / `reason` / `session_id`). The anchor cross-check asserts these so a
 * raw-DB `action` retarget (e.g. to `unrelated.action`) can no longer point a
 * live receipt at an anchor that does NOT record the claimed policy update. These
 * MUST stay in lock-step with the appender's literals; the green over-fail-close
 * control (a normal single+multi-tenant write recovers clean) guards against drift.
 */
const RETENTION_AUDIT_ANCHOR_ACTION = "retention.policy.update";
const RETENTION_AUDIT_ANCHOR_RESOURCE_TYPE = "policy";
const RETENTION_AUDIT_ANCHOR_DECISION = "allow";
const RETENTION_AUDIT_ANCHOR_REASON = "canonical-owner retention policy update";

/**
 * EXACT allowed-key set for the content-minimized anchor's `metadata_json`. The
 * write-path appender (`createFridayRetentionPolicyAuditAppender`) builds
 * `metadata = { receiptId, correlationId, ...(payloadDigest ? {payloadDigest} : {}) }`
 * and the PUT handler ALWAYS computes `payloadDigest = hashIdempotencyPayload(updates)`
 * (a non-empty hex string), so a real anchor's metadata is EXACTLY
 * `{receiptId, correlationId, payloadDigest}` — empirically verified byte-for-byte
 * against a real single- AND multi-tenant PUT (observed own-key set, order aside:
 * `["correlationId","payloadDigest","receiptId"]`). This EXACT set is enforced on the
 * read path so no EXTRA key can ride along in the PERMANENT anchor (see
 * `assertReceiptAnchor`).
 */
const ALLOWED_ANCHOR_METADATA_KEYS = ["receiptId", "correlationId", "payloadDigest"] as const;

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
 *
 * SEMANTIC ENVELOPE (P1 — the anchor must still RECORD the claimed update): beyond
 * the linkage metadata + owner/tenant + `created_at`, the cross-check now also
 * verifies the anchor's own audit fields — `action`, `resource_type`, `resource_id`,
 * `decision`, `session_id`, `reason` — against the canonical write-path values. A
 * raw-DB retarget of any of these (e.g. `action` → `unrelated.action`) previously
 * still served the receipt: `audit_id` could point at an anchor that no longer
 * records a retention-policy update. Each mismatch fails closed with
 * `anchor_mismatch:<column>` (`action` / `resource_type` / `resource_id` /
 * `decision` / `session_id` / `reason`).
 *
 * EXACT-KEY METADATA (P1 — permanent-anchor content-retention island): the anchor's
 * `metadata_json` is enforced to the EXACT allowed-key set
 * `{receiptId, correlationId, payloadDigest}` (`ALLOWED_ANCHOR_METADATA_KEYS`).
 * Because `security_audit_log` is PERMANENT (no reaper / `deleteAllForOwner` deletes
 * it), an EXTRA key would persist indefinitely and, before this check, the read path
 * still SERVED it (the linkage equalities ignored extra keys) — a content/secret
 * retention island. Now: any EXTRA key (incl. `before`/`after`/`recoveryKey`/unknown
 * ids/`__proto__`-as-own-key) → `anchor_metadata_unexpected_key`; any MISSING key →
 * `anchor_metadata_missing_key`; a wrong-TYPE / nested-value / non-hex-digest field →
 * `anchor_metadata_field_shape`; an array/non-object/undecodable metadata stays
 * `anchor_metadata_unreadable`.
 *
 * U9 / DELETE-ALL AUDIT of the PERMANENT anchor's RETAINED fields (required_action
 * #4). EVERY field this content-minimized anchor retains for a retention receipt is:
 *   - metadata {receiptId, correlationId, payloadDigest} — content-free LINKAGE ids +
 *     a NON-REVERSIBLE sha256 digest (never the raw applied-updates payload);
 *   - principal_id / tenant_id — the OWNER id an audit log inherently records;
 *   - action / resource_type / decision / reason — CONSTANTS (the canonical envelope);
 *   - resource_id — `retention-policy:<principal_id>` (owner id, a constant shape);
 *   - session_id — the correlation id (content-free linkage);
 *   - created_at — the mutation instant.
 * NONE of these carry before/after content, applied-update values, or a raw recovery
 * key — so the anchor is DATA-DELETE-ALL-001 content-free-checkpoint compliant, and
 * the exact-key metadata check PREVENTS any content from being introduced/served via
 * the read path. RESIDUAL, HONESTLY ISOLATED (NOT closed here): a COORDINATED tamper
 * that stuffs content into a permanent anchor ROW leaves that data in
 * `security_audit_log` un-reaped; the read path now fails CLOSED on such an anchor
 * (never serves it) but does NOT remove the row. Removing it is AUDIT-AUTHENTIC-
 * ANCHOR-001 / audit-store Delete-All — a SEPARATE, still-unclosed requirement.
 */
function assertReceiptAnchor(row: RetentionReceiptRow, db: Database.Database): void {
  const anchor = db
    .prepare(
      `SELECT id, principal_id, tenant_id, action, resource_type, resource_id,
              decision, reason, session_id, metadata_json, created_at
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
  // ── RAW-BYTES CANONICAL metadata (P1 — JSON duplicate-member content island) ────
  // `JSON.parse` above keeps only the LAST value of a duplicated member name, so the
  // parsed-object exact-key/linkage checks below are BLIND to attacker content stashed
  // in a DISCARDED earlier duplicate member (e.g. a first `"receiptId":"<secret>"`
  // shadowed by a correct trailing `"receiptId":"<real>"` — `Object.keys` still reports
  // exactly the 3 allowed keys and every equality passes, yet the raw bytes retain the
  // secret). Because `security_audit_log` is PERMANENT (no reaper / `deleteAllForOwner`
  // deletes it), those raw bytes are a permanent content/secret retention island the
  // parsed view cannot see. Require the RAW `metadata_json` to be CANONICAL
  // (`JSON.stringify(JSON.parse(s)) === s`) — this rejects, in one check, duplicate
  // member names AND escaped-equivalent member names AND extra whitespace. It runs
  // AFTER the object-guard (an array/string/number metadata stays
  // `anchor_metadata_unreadable`) and BEFORE the exact-key/linkage checks (so a
  // duplicate-member tamper surfaces the precise `anchor_metadata_noncanonical`, not a
  // coincidental linkage mismatch). This is IN ADDITION to — not a replacement for —
  // the exact-key/shape/linkage checks: the bytes must be canonical AND the parsed
  // fields must be exactly the 3 correct keys.
  assertCanonicalJsonBytes(anchor.metadata_json, {
    reason: "anchor_metadata_noncanonical",
    receiptId: row.receipt_id,
    auditId: row.audit_id,
  });
  // ── EXACT-SHAPE anchor metadata (P1 — content-retention-island fix) ────────────
  // The PERMANENT anchor row (`security_audit_log`) is EXCLUDED from the finite
  // receipt reaper AND from `deleteAllForOwner`, so ANY key that survives here
  // persists INDEFINITELY. A coordinated raw-DB tamper that stuffs a `before`/`after`
  // content key or a raw `recoveryKey` secret into an otherwise-coherent PERMANENT
  // anchor would therefore be a content/secret RETENTION ISLAND — and, before this
  // check, the read path still SERVED such a receipt (the linkage equality checks
  // ignored extra keys). Enforce the EXACT allowed-key set so the read path fails
  // CLOSED on any extra/missing key and never serves content/secret introduced via
  // the anchor metadata (defeating U9/DATA-RETENTION-001 / DATA-DELETE-ALL-001 /
  // AUDIT-AUTHENTIC-ANCHOR-001). `Object.keys` lists a JSON `"__proto__"` as an OWN
  // enumerable key (JSON.parse uses defineProperty semantics — empirically verified),
  // so a `__proto__`-as-own-key stuffing is rejected here as an unexpected key too.
  const metadataKeys = Object.keys(metadata);
  for (const key of metadataKeys) {
    if (!(ALLOWED_ANCHOR_METADATA_KEYS as readonly string[]).includes(key)) {
      throw new FridayRetentionReceiptIntegrityError(
        `Persisted retention recovery receipt '${row.receipt_id}' has an audit-anchor metadata with an unexpected key '${key}'.`,
        { details: { receiptId: row.receipt_id, reason: "anchor_metadata_unexpected_key", auditId: row.audit_id, key } },
      );
    }
  }
  for (const key of ALLOWED_ANCHOR_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(metadata, key)) {
      throw new FridayRetentionReceiptIntegrityError(
        `Persisted retention recovery receipt '${row.receipt_id}' has an audit-anchor metadata missing the required key '${key}'.`,
        { details: { receiptId: row.receipt_id, reason: "anchor_metadata_missing_key", auditId: row.audit_id, key } },
      );
    }
  }
  // Field TYPE + canonical shape (runs BEFORE the value-equality linkage checks so a
  // wrong-TYPE / nested-value / non-hex-digest surfaces the precise shape reason, not
  // a coincidental `anchor_mismatch`). receiptId/correlationId must be strings (their
  // exact VALUE == the receipt's is asserted by the linkage checks below, and the
  // receipt's own id shapes are validated in `assertReceiptScalarColumns`);
  // payloadDigest must be a 64-char lowercase-hex string.
  const payloadDigestValue = metadata.payloadDigest;
  const shapeChecks: Array<readonly [string, boolean]> = [
    ["receiptId", typeof metadata.receiptId === "string"],
    ["correlationId", typeof metadata.correlationId === "string"],
    [
      "payloadDigest",
      typeof payloadDigestValue === "string" && SHA256_LOWER_HEX_RE.test(payloadDigestValue),
    ],
  ];
  for (const [field, ok] of shapeChecks) {
    if (!ok) {
      throw new FridayRetentionReceiptIntegrityError(
        `Persisted retention recovery receipt '${row.receipt_id}' has an audit-anchor metadata field '${field}' of the wrong type/shape.`,
        { details: { receiptId: row.receipt_id, reason: "anchor_metadata_field_shape", auditId: row.audit_id, field } },
      );
    }
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
    // SEMANTIC ENVELOPE (P1): the anchor must still RECORD the claimed retention-
    // policy update. These use the STORED COLUMN names as the mismatch reason
    // (`anchor_mismatch:action`, …). They are APPENDED after the linkage checks so a
    // repointed-to-a-different-anchor tamper still surfaces the linkage reason
    // (`anchor_mismatch:receiptId`) first, not a coincidental envelope mismatch.
    ["action", anchor.action === RETENTION_AUDIT_ANCHOR_ACTION],
    ["resource_type", anchor.resource_type === RETENTION_AUDIT_ANCHOR_RESOURCE_TYPE],
    ["resource_id", anchor.resource_id === `retention-policy:${row.principal_id}`],
    ["decision", anchor.decision === RETENTION_AUDIT_ANCHOR_DECISION],
    ["session_id", anchor.session_id === row.correlation_id],
    ["reason", anchor.reason === RETENTION_AUDIT_ANCHOR_REASON],
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
  // ── RAW-BYTES CANONICAL columns (P1 — JSON duplicate-member content island) ─────
  // BEFORE the parsed-object shape/coherence validation below, require each stored
  // receipt JSON column to be CANONICAL (`JSON.stringify(JSON.parse(s)) === s`). The
  // parse below keeps only the LAST value of a duplicated member, so a served receipt
  // could otherwise carry hidden attacker content in a DISCARDED duplicate member (or
  // an escaped-equivalent member name / extra whitespace) that the shape + coherence
  // checks never see. Closing the representation class at EVERY read-back JSON seam
  // (not only the permanent anchor) is required so no served receipt ever carries a
  // hidden duplicate-key content island. An UNDECODABLE column is left to the
  // `undecodable_json` guard below — `assertCanonicalJsonBytes` returns without throwing
  // on unparseable input, so this does not change the undecodable posture.
  const canonicalColumns: Array<readonly [string, string]> = [
    ["before_json", row.before_json],
    ["after_json", row.after_json],
    ["changed_categories_json", row.changed_categories_json],
    ["applied_updates_json", row.applied_updates_json],
  ];
  for (const [column, raw] of canonicalColumns) {
    assertCanonicalJsonBytes(raw, {
      reason: `receipt_json_noncanonical:${column}`,
      receiptId: row.receipt_id,
    });
  }

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
      // Delete rows whose `created_at` cannot be trusted as a canonical instant —
      // retaining them under a finite window would break DATA-RETENTION truthfulness —
      // WITHOUT destroying legitimate clock-skewed data. Called ONLY inside the finite
      // auditLogs sweep.
      //
      // (1) Fast path: coarse-bad values that fail the shape GLOB (`"zzzz"`, empty, a
      //     non-`Z` offset) are deleted set-based in SQL. These are un-datable → quarantine.
      let removed = db
        .prepare(
          `DELETE FROM retention_recovery_receipts
            WHERE created_at NOT GLOB ?`,
        )
        .run(FRIDAY_RETENTION_RECEIPT_CREATED_AT_GLOB).changes;
      // (2) Shaped rows — re-check with the STRICT gate + the clock-regression-safe
      //     anchor comparison for future-dated rows. The receipt store is small (one
      //     row per policy-update-per-key), so this scan is bounded. Also pull `audit_id`
      //     so a future row can be compared against its anchor without a second query.
      const shaped = db
        .prepare(
          `SELECT receipt_id, audit_id, created_at
             FROM retention_recovery_receipts
            WHERE created_at GLOB ?`,
        )
        .all(FRIDAY_RETENTION_RECEIPT_CREATED_AT_GLOB) as Array<{
        receipt_id: string;
        audit_id: string;
        created_at: string;
      }>;
      const deleteById = db.prepare(
        `DELETE FROM retention_recovery_receipts WHERE receipt_id = ?`,
      );
      const anchorCreatedAt = db.prepare(
        `SELECT created_at FROM security_audit_log WHERE id = ?`,
      );
      let clockAnomalyPreserved = 0;
      for (const row of shaped) {
        // (a) Shape-passing but NOT a canonical round-trip instant (impossible calendar
        //     values like month 13-19, day 32-39, Feb-30) → un-datable → quarantine.
        if (!isCanonicalReceiptCreatedAt(row.created_at)) {
          removed += deleteById.run(row.receipt_id).changes;
          continue;
        }
        // (b) Canonical and NOT future-relative → a normal past instant; leave it to
        //     `deleteExpiredBefore` (`created_at < cutoff`). NEVER quarantined here.
        if (row.created_at <= nowIso) continue;
        // (c) Canonical and FUTURE-relative (`created_at > nowIso`) → clock-regression-
        //     safe anchor comparison. A backward wall-clock jump can make a legit
        //     receipt's `created_at` look "future"; if its authentic-audit anchor
        //     carries the SAME `created_at`, it is a genuine clock-skewed row → PRESERVE
        //     + flag (never destroy legit data on a clock rollback). A one-sided
        //     corruption (anchor `created_at` differs) → quarantine. An ABSENT anchor is
        //     uncertain → PRESERVE (fail-closed; the read path refuses to serve it).
        const anchor = anchorCreatedAt.get(row.audit_id) as
          | { created_at: string }
          | undefined;
        if (!anchor) continue; // absent anchor → preserve (do not delete uncertain data)
        if (anchor.created_at === row.created_at) {
          clockAnomalyPreserved += 1; // legit clock-skew → preserved + flagged
          continue;
        }
        removed += deleteById.run(row.receipt_id).changes; // one-sided corruption
      }
      return { quarantined: removed, clockAnomalyPreserved };
    },

    deleteAllForOwner(db, input) {
      return db
        .prepare(`DELETE FROM retention_recovery_receipts WHERE principal_id = ?`)
        .run(input.ownerId).changes;
    },
  };
}

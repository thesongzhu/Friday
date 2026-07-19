/**
 * Per-category retention configuration for a CONTENT category.
 *
 * DATA-RETENTION-001 / U9-DATA-RETENTION: local data is default-PERMANENT until
 * the user deletes it; automatic time-based cleanup is default-OFF and opt-in
 * per category. `permanent` (the default) means "never auto-delete". `after_days`
 * is the ONLY way to enable a time-based sweep for a content category, and the
 * evaluator (`resolveCutoff`) fails closed — treats any invalid config as
 * permanent — so a corrupt policy can never trigger a silent deletion.
 */
export type CategoryRetention =
  | { mode: "permanent" }
  | { mode: "after_days"; days: number };

/**
 * The ONE canonical valid `after_days` domain (RETENTION-R3a hardening).
 *
 * DATA-RETENTION-001 truthfulness invariant: the API must NEVER accept /
 * persist / report-active a window the production reaper won't honor. The reaper
 * evaluator (`resolveCutoff`) fails closed to PERMANENT for any window whose
 * cutoff date overflows JS `Date`'s ±8.64e15 ms range — i.e. `after_days` beyond
 * roughly 1e8 days. Rather than track that fragile, `now`-dependent internal
 * bound, we pin a SANE PRODUCT CEILING well inside it: `[1, 36500]` days
 * (36500 days ≈ 100 years). `resolveCutoff` returns a NON-null cutoff for every
 * value in this closed interval for any realistic `now` (≥ 1970), so the ACCEPTED
 * domain is a strict SUBSET of the HONORED domain (accept ⊆ honored). Every layer
 * — request parsing, the store read/write, the loader, and the DB `CHECK` — MUST
 * enforce exactly this interval; anything outside it is malformed ⇒ fail closed
 * to PERMANENT (delete nothing) and is never surfaced as an active policy.
 *
 * NB: the migration's `CHECK (after_days >= 1 AND after_days <= 36500)` inlines
 * these literals (a migration's SQL/checksum is a frozen historical artifact and
 * must not interpolate a mutable constant); a guard test asserts the CHECK bound
 * agrees with these constants.
 */
export const FRIDAY_MIN_AFTER_DAYS = 1;
export const FRIDAY_MAX_AFTER_DAYS = 36500;

/**
 * Canonical predicate for a valid `after_days` window: a positive integer inside
 * the honored `[FRIDAY_MIN_AFTER_DAYS, FRIDAY_MAX_AFTER_DAYS]` interval. Shared by
 * request parsing, the store, and the loader so the accepted domain is identical
 * everywhere (and ⊆ what `resolveCutoff` honors). Rejects NaN, Infinity,
 * non-integers, ≤ 0, and any out-of-range / overflowing window.
 */
export function isValidAfterDays(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= FRIDAY_MIN_AFTER_DAYS &&
    value <= FRIDAY_MAX_AFTER_DAYS
  );
}

/**
 * STRICT structural validator for ONE `CategoryRetention` value read back from an
 * untrusted / persisted source (RETENTION-R3d round-8, EXACT-SHAPE in round-9).
 * Accepts EXACTLY `{mode:"permanent"}` (one own-enumerable key) or
 * `{mode:"after_days",days:N}` (exactly two own-enumerable keys) with N inside the
 * canonical honored `[FRIDAY_MIN_AFTER_DAYS, FRIDAY_MAX_AFTER_DAYS]` window (via
 * `isValidAfterDays`). Rejects a non-object / null / array, an unknown `mode`, a
 * missing/non-integer/NaN/Infinity `days`, any OUT-OF-RANGE window, AND any object
 * that carries an UNKNOWN / EXTRA property (round-9 P1-B): a persisted
 * `CategoryRetention` with a stray key is a storage-integrity fault whose extra
 * property could otherwise egress through the owner-facing recovery response. So a
 * decode path fails CLOSED on a schema-valid-but-semantically-invalid value (a
 * reaper-unhonored day count OR an unexpected property), not merely on undecodable
 * JSON. This tightening also flows into `isValidFridayRetentionContentPolicy` and
 * `isValidAppliedUpdates`, whose per-category values pass through here.
 */
export function isValidCategoryRetention(value: unknown): value is CategoryRetention {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keyCount = Object.keys(value as Record<string, unknown>).length;
  const mode = (value as { mode?: unknown }).mode;
  if (mode === "permanent") {
    // EXACTLY one own-enumerable key: `mode`. Any extra property → invalid.
    return keyCount === 1;
  }
  if (mode !== "after_days") return false;
  // EXACTLY two own-enumerable keys: `mode`, `days`. Any extra property → invalid.
  if (keyCount !== 2) return false;
  return isValidAfterDays((value as { days?: unknown }).days);
}

export interface FridayRetentionPolicy {
  // ── CONTENT categories (canonical + derived-content) ──────────────────────
  // Default PERMANENT. Auto-deletion is opt-in per category via `after_days`;
  // any invalid config fails closed to permanent (see resolveCutoff).
  learningEvents: CategoryRetention;
  /** Derived telemetry; per operator, default no-delete until an authority exemption is proven. */
  heartbeats: CategoryRetention;
  skillRunTerminal: CategoryRetention;
  auditLogs: CategoryRetention;
  agentRuns: CategoryRetention;
  llmUsageRecords: CategoryRetention;
  errorIncidents: CategoryRetention;

  // ── SECURITY-LIFECYCLE terminal TTLs (EXEMPT from default-permanent) ───────
  // These are NOT canonical content-retention: each deletes a row only once it
  // is TERMINAL / state-invalidated, and the deletion is a security-hygiene /
  // anti-replay lifecycle (not content retention). They therefore remain plain
  // numeric day-windows and are intentionally left ON:
  //   - pairingRequestsDays: hard-delete of RESOLVED pairing-request rows.
  //   - outboxTerminalDays:  hard-delete of TERMINAL (acked/failed) outbox rows.
  //   - bootstrapNoncesConsumedDays: retention horizon for CONSUMED install
  //     nonces (an anti-replay / defence-in-depth record whose authoritative
  //     binding lives on users.password_hash). Expired UNCONSUMED nonces are
  //     always reaped (unusable) with no policy knob.
  pairingRequestsDays: number;
  outboxTerminalDays: number;
  /**
   * Retention horizon for CONSUMED setup-bootstrap install-nonce rows. Expired
   * UNCONSUMED nonces are always reaped once past `expires_at` (no policy knob —
   * they are unusable); this bounds how long a consumed nonce (an audit +
   * defence-in-depth record whose authoritative binding lives on
   * `users.password_hash`) is retained before reclamation. Generous by default.
   */
  bootstrapNoncesConsumedDays: number;
}

export const FRIDAY_DEFAULT_RETENTION_POLICY: FridayRetentionPolicy = {
  // Content categories: PERMANENT by default (DATA-RETENTION-001).
  learningEvents: { mode: "permanent" },
  heartbeats: { mode: "permanent" },
  skillRunTerminal: { mode: "permanent" },
  auditLogs: { mode: "permanent" },
  agentRuns: { mode: "permanent" },
  llmUsageRecords: { mode: "permanent" },
  errorIncidents: { mode: "permanent" },
  // Security-lifecycle terminal TTLs (unchanged; not content retention).
  pairingRequestsDays: 7,
  outboxTerminalDays: 14,
  bootstrapNoncesConsumedDays: 365,
};

/**
 * The user-configurable CONTENT categories (RETENTION-R3a).
 *
 * These are exactly the `CategoryRetention`-typed fields of
 * `FridayRetentionPolicy` — the ones that are default-PERMANENT and opt-in per
 * DATA-RETENTION-001. The SECURITY-LIFECYCLE terminal TTLs
 * (`pairingRequestsDays` / `outboxTerminalDays` / `bootstrapNoncesConsumedDays`)
 * are intentionally EXCLUDED: they are not content retention and are never
 * exposed on the owner-bound retention-Settings surface.
 */
export const FRIDAY_RETENTION_CONTENT_CATEGORIES = [
  "learningEvents",
  "heartbeats",
  "skillRunTerminal",
  "auditLogs",
  "agentRuns",
  "llmUsageRecords",
  "errorIncidents",
] as const;

/** One of the seven user-configurable CONTENT retention categories. */
export type FridayRetentionContentCategory =
  (typeof FRIDAY_RETENTION_CONTENT_CATEGORIES)[number];

/**
 * The effective per-content-category retention policy for a single owner:
 * every content category mapped to its `CategoryRetention` (default
 * `{mode:"permanent"}`). This is the shape the owner-bound retention-Settings
 * API returns and accepts (it never surfaces the security-lifecycle TTLs).
 */
export type FridayRetentionContentPolicy = Record<
  FridayRetentionContentCategory,
  CategoryRetention
>;

/** The canonical content-category name set (for O(1) membership checks). */
const FRIDAY_RETENTION_CONTENT_CATEGORY_SET: ReadonlySet<string> = new Set(
  FRIDAY_RETENTION_CONTENT_CATEGORIES,
);

/**
 * STRICT validator that a value is EXACTLY one of the seven canonical content
 * category NAMES (RETENTION-R3d round-8). Used by decode paths to reject an
 * unknown / malformed category name in a persisted receipt's `changedCategories`
 * or `appliedUpdates` keys.
 */
export function isFridayRetentionContentCategory(
  value: unknown,
): value is FridayRetentionContentCategory {
  return typeof value === "string" && FRIDAY_RETENTION_CONTENT_CATEGORY_SET.has(value);
}

/**
 * STRICT validator for a full `FridayRetentionContentPolicy` read back from an
 * untrusted / persisted source (RETENTION-R3d round-8). Requires a plain object
 * carrying EXACTLY the seven canonical content categories (no missing, no unknown
 * key), each mapped to a valid `CategoryRetention` (via `isValidCategoryRetention`).
 * This is the shape the store always produces (`allPermanentPolicy` seeds all seven),
 * so anything else — a truncated policy, an extra/renamed key, or an out-of-domain
 * per-category value — is a STORAGE-INTEGRITY failure and must fail CLOSED, never be
 * surfaced as a partially-decoded policy.
 */
export function isValidFridayRetentionContentPolicy(
  value: unknown,
): value is FridayRetentionContentPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  // EXACTLY the seven canonical categories: no unknown key, no missing key.
  if (Object.keys(record).length !== FRIDAY_RETENTION_CONTENT_CATEGORIES.length) return false;
  for (const category of FRIDAY_RETENTION_CONTENT_CATEGORIES) {
    if (!Object.prototype.hasOwnProperty.call(record, category)) return false;
    if (!isValidCategoryRetention(record[category])) return false;
  }
  return true;
}

/**
 * Max setup-bootstrap nonce rows deleted PER class (expired-unconsumed /
 * consumed-retired) per retention pass. Bounds the reaper's work so it cannot
 * hold a long write lock; any backlog drains across successive scheduled runs.
 */
export const FRIDAY_BOOTSTRAP_NONCE_SWEEP_BATCH_LIMIT = 1000;

export interface FridayRetentionJobResult {
  markedPairingExpired: number;
  deletedPairingRequests: number;
  deletedHeartbeats: number;
  markedOutboxExpired: number;
  deletedOutboxTerminal: number;
  deletedLearningEvents: number;
  deletedSkillRuns: number;
  deletedAuditLogs: number;
  /**
   * RETENTION-R3d: recovery-receipt rows (`retention_recovery_receipts`) expired
   * this pass. GOVERNED by the SAME `auditLogs` content-retention category as
   * `deletedAuditLogs`: default-permanent (0 while auditLogs is permanent), and >0
   * only once the owner opts auditLogs into a finite `after_days` window.
   */
  deletedRetentionReceipts: number;
  /**
   * RETENTION-R3d (whole-row receipt invariant): recovery-receipt rows QUARANTINE-
   * deleted this pass because their persisted `created_at` is NON-CANONICAL (fails
   * the canonical-ISO shape gate `FRIDAY_RETENTION_RECEIPT_CREATED_AT_GLOB`, e.g.
   * `"zzzz"`). Such a row cannot be reliably dated, so a lexicographic
   * `created_at < cutoff` compare would let it SILENTLY SURVIVE a finite-retention
   * sweep (a DATA-RETENTION-001 truthfulness break — "a successful zero-deletion
   * sweep silently surviving a finite retention policy"). Its content category is
   * opted into deletion, so the finite sweep DELETES it and surfaces this typed
   * integrity incident instead of a silent zero. GOVERNED by the SAME `auditLogs`
   * category as `deletedRetentionReceipts`: 0 while auditLogs is PERMANENT
   * (default-permanent + fail-closed is preserved — an un-datable row is retained,
   * never served, until the owner opts into a finite window). This is the
   * Advisor-authorized "documented safe quarantine strategy" for the ONE operator-
   * locked (DATA-RETENTION-001) design fork.
   */
  quarantinedIntegrityReceipts: number;
  /**
   * RETENTION-R3d (clock-regression-safe reaper): recovery-receipt rows that are
   * FUTURE-dated relative to the sweep's `now` but whose authentic-audit ANCHOR
   * carries the SAME `created_at` — a genuine CLOCK-SKEWED pair (e.g. a receipt
   * written before a BACKWARD wall-clock jump / NTP correction). These are NOT
   * corrupt: they are PRESERVED (never quarantine-deleted) and surfaced here as a
   * clock anomaly, then expired normally once they are DEMONSTRABLY older than the
   * retention cutoff (`deleteExpiredBefore`, `created_at < cutoff`). Replacing the
   * old blind `created_at > now ⇒ quarantine` rule with this anchor-comparison model
   * closes a DATA-RETENTION-001 over-fail-close that DESTROYED legitimate data on a
   * clock rollback. GOVERNED by the SAME `auditLogs` category as the other receipt
   * counters: 0 while auditLogs is PERMANENT (the finite sweep never runs). Only a
   * ONE-SIDED future corruption (anchor `created_at` MISMATCHES) is quarantined; an
   * ABSENT anchor is preserved (fail-closed — the read path refuses to serve it).
   */
  clockAnomalyRetentionReceipts: number;
  deletedAgentRuns: number;
  deletedLlmUsageRecords: number;
  deletedErrorIncidents: number;
  /** Expired UNCONSUMED setup-bootstrap install-nonces reaped this pass. */
  deletedExpiredBootstrapNonces: number;
  /** CONSUMED setup-bootstrap install-nonces past retention reaped this pass. */
  deletedConsumedBootstrapNonces: number;
}

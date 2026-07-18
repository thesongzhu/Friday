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
  deletedAgentRuns: number;
  deletedLlmUsageRecords: number;
  deletedErrorIncidents: number;
  /** Expired UNCONSUMED setup-bootstrap install-nonces reaped this pass. */
  deletedExpiredBootstrapNonces: number;
  /** CONSUMED setup-bootstrap install-nonces past retention reaped this pass. */
  deletedConsumedBootstrapNonces: number;
}

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
  deletedAgentRuns: number;
  deletedLlmUsageRecords: number;
  deletedErrorIncidents: number;
  /** Expired UNCONSUMED setup-bootstrap install-nonces reaped this pass. */
  deletedExpiredBootstrapNonces: number;
  /** CONSUMED setup-bootstrap install-nonces past retention reaped this pass. */
  deletedConsumedBootstrapNonces: number;
}

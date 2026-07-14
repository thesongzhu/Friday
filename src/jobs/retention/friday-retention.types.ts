export interface FridayRetentionPolicy {
  learningEventsDays: number;
  heartbeatsDays: number;
  pairingRequestsDays: number;
  outboxTerminalDays: number;
  skillRunTerminalDays: number;
  auditLogsDays: number;
  agentRunsDays: number;
  llmUsageRecordsDays: number;
  errorIncidentsDays: number;
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
  learningEventsDays: 90,
  heartbeatsDays: 7,
  pairingRequestsDays: 7,
  outboxTerminalDays: 14,
  skillRunTerminalDays: 30,
  auditLogsDays: 90,
  agentRunsDays: 90,
  llmUsageRecordsDays: 180,
  errorIncidentsDays: 90,
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

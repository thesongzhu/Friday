export interface FridayRetentionPolicy {
  learningEventsDays: number;
  heartbeatsDays: number;
  pairingRequestsDays: number;
  outboxTerminalDays: number;
  skillRunTerminalDays: number;
}

export const FRIDAY_DEFAULT_RETENTION_POLICY: FridayRetentionPolicy = {
  learningEventsDays: 90,
  heartbeatsDays: 7,
  pairingRequestsDays: 7,
  outboxTerminalDays: 14,
  skillRunTerminalDays: 30,
};

export interface FridayRetentionJobResult {
  markedPairingExpired: number;
  deletedPairingRequests: number;
  deletedHeartbeats: number;
  markedOutboxExpired: number;
  deletedOutboxTerminal: number;
  deletedLearningEvents: number;
  deletedSkillRuns: number;
}

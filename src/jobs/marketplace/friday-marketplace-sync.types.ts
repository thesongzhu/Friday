export interface FridayMarketplaceSyncJobConfig {
  intervalMs: number;
  jitterMs: number;
  maxBackoffMs: number;
}

export const FRIDAY_DEFAULT_SYNC_JOB_CONFIG: FridayMarketplaceSyncJobConfig = {
  intervalMs: 6 * 60 * 60 * 1000, // 6 hours
  jitterMs: 5 * 60 * 1000, // 5 minutes
  maxBackoffMs: 24 * 60 * 60 * 1000, // 24 hours
};

export interface FridayMarketplaceSyncJobResult {
  sourcesAttempted: number;
  sourcesSucceeded: number;
  totalSkillsSynced: number;
  totalVersionsSynced: number;
  errors: string[];
}

export interface FridayConsolidationResult {
  consolidatedCount: number;
  promotedMemories: Array<{
    sourceEpisodeIds: string[];
    targetMemoryId: string;
    memoryType: "procedure" | "preference";
    content: string;
    confidence: number;
  }>;
  archivedEpisodeIds: string[];
}

export interface FridayConsolidationConfig {
  /** Minimum episodes before consolidation triggers. Default: 5. */
  minEpisodes: number;
  /** Maximum age (days) for episodes to consolidate. Default: 30. */
  maxAgeDays: number;
  /** Minimum pattern confidence to promote. Default: 0.6. */
  minPromotionConfidence: number;
  /** Maximum consolidation batch size. Default: 100. */
  batchSize: number;
}

export const FRIDAY_CONSOLIDATION_DEFAULTS: FridayConsolidationConfig = {
  minEpisodes: 5,
  maxAgeDays: 30,
  minPromotionConfidence: 0.6,
  batchSize: 100,
};

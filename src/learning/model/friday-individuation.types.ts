/**
 * Digital Individuation Types — tracks a user's progression from
 * generic (collective) responses toward deeply personalised interaction.
 *
 * Inspired by Jung's individuation process: the progressive
 * differentiation of the psyche from collective patterns toward an
 * integrated, unique self.
 */

export type FridayIndividuationStage =
  | "stranger"
  | "acquaintance"
  | "familiar"
  | "companion"
  | "partner";

export interface FridayIndividuationStateRow {
  user_id: string;
  stage: string;
  fact_count: number;
  session_count: number;
  average_satisfaction: number;
  learned_persona_dimensions: number;
  stage_entered_at: string;
  previous_stage: string | null;
  computed_at: string;
  created_at: string;
  updated_at: string;
}

export interface FridayIndividuationStateEntity {
  userId: string;
  stage: FridayIndividuationStage;
  factCount: number;
  sessionCount: number;
  averageSatisfaction: number;
  learnedPersonaDimensions: number;
  totalPersonaDimensions: number; // always 9
  stageEnteredAt: string;
  previousStage?: FridayIndividuationStage;
  computedAt: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Thresholds for stage transitions:
 *   stranger    → < 3 facts
 *   acquaintance → 3–9 facts
 *   familiar    → 10–24 facts, satisfaction > -0.2
 *   companion   → 25+ facts, satisfaction > 0.1, 30+ sessions
 *   partner     → 50+ facts, satisfaction > 0.3, 100+ sessions, all persona learned
 */
export const FRIDAY_INDIVIDUATION_THRESHOLDS = {
  acquaintance: { minFacts: 3 },
  familiar: { minFacts: 10, minSatisfaction: -0.2 },
  companion: { minFacts: 25, minSatisfaction: 0.1, minSessions: 30 },
  partner: {
    minFacts: 50,
    minSatisfaction: 0.3,
    minSessions: 100,
    allPersonaLearned: true,
  },
} as const;

export const FRIDAY_TOTAL_PERSONA_DIMENSIONS = 9;

import type { FridaySqliteLayer } from "#state";
import type { FridayPreferenceFactService } from "./friday-preference-fact-service.js";
import type { FridayLearningPatternRecognitionService } from "./friday-learning-pattern-recognition-service.js";
import type { FridayLearningLifecycleService } from "./friday-learning-lifecycle-service.js";
import type {
  FridayLearningContext,
  JsonValue,
} from "../model/friday-learning.types.js";
import { FRIDAY_LEARNING_DEFAULTS } from "../model/friday-learning.types.js";
import {
  FRIDAY_LEARNED_FACT_CONTEXT_USE_BOUNDARY,
  readLearnedFactReviewBoundary,
} from "./friday-learned-fact-memory-view.js";

export interface FridayLearningContextEnrichmentService {
  buildContext(input: {
    userId: string;
    nowIso: string;
    maxFacts?: number;
  }): FridayLearningContext;

  enrichSkillPayload(input: {
    userId?: string;
    runId?: string;
    nodeId?: string;
    payload: Record<string, unknown>;
    nowIso: string;
  }): Record<string, unknown>;
}

export interface CreateContextEnrichmentServiceDeps {
  db: FridaySqliteLayer;
  factService: FridayPreferenceFactService;
  patternService: FridayLearningPatternRecognitionService;
  lifecycleService: FridayLearningLifecycleService;
  contextUseThreshold?: number;
  lookbackDays?: number;
}

export function createFridayLearningContextEnrichmentService(
  deps: CreateContextEnrichmentServiceDeps,
): FridayLearningContextEnrichmentService {
  const contextUseThreshold =
    deps.contextUseThreshold ?? FRIDAY_LEARNING_DEFAULTS.contextUseThreshold;
  const lookbackDays = deps.lookbackDays ?? 30;

  return {
    buildContext(input) {
      const { userId, nowIso, maxFacts = 50 } = input;

      const lifecycleState = deps.lifecycleService.getState(userId);

      const activeFacts = deps.factService.listActiveFacts({
        userId,
        minConfidence: contextUseThreshold,
        limit: maxFacts,
      });

      const preferences: Record<string, JsonValue> = {};
      const appliedFacts: FridayLearningContext["appliedFacts"] = [];

      for (const fact of activeFacts) {
        const reviewBoundary = readLearnedFactReviewBoundary(fact);
        preferences[fact.key] = fact.value;
        appliedFacts.push({
          factId: fact.factId,
          key: fact.key,
          confidence: fact.confidence,
          evidenceCount: fact.evidenceCount,
          lastConfirmedAt: fact.lastConfirmedAt,
          sourceEventIds: fact.sourceEventIds,
          reviewBoundary,
          contextUseBoundary: FRIDAY_LEARNED_FACT_CONTEXT_USE_BOUNDARY,
          provenance: {
            source: "preference_fact",
            reviewBoundary,
            reviewCenterCandidateId: typeof fact.metadata?.reviewCenterCandidateId === "string"
              ? fact.metadata.reviewCenterCandidateId
              : undefined,
            reviewCenterOrigin: typeof fact.metadata?.reviewCenterOrigin === "string"
              ? fact.metadata.reviewCenterOrigin
              : undefined,
          },
        });
      }

      const activePatterns = deps.patternService.detectUserPatterns({
        userId,
        nowIso,
        lookbackDays,
      });

      return {
        userId,
        lifecycleState,
        preferences,
        appliedFacts,
        activePatterns,
        generatedAt: nowIso,
      };
    },

    enrichSkillPayload(input) {
      const { userId, payload, nowIso } = input;

      // Skip enrichment when no resolvable userId
      if (!userId) {
        return { ...payload };
      }

      const context = this.buildContext({ userId, nowIso });

      // Do not mutate original payload object
      const enriched = { ...payload };

      // Add reserved envelope
      (enriched as Record<string, unknown>)["__fridayLearning"] = {
        lifecycleState: context.lifecycleState,
        preferences: context.preferences,
        appliedFacts: context.appliedFacts,
        activePatterns: context.activePatterns,
        generatedAt: context.generatedAt,
      };

      return enriched;
    },
  };
}

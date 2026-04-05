/**
 * Deep Pattern Extraction Service — discovers cross-session patterns
 * by correlating satisfaction scores, preference drift, and failure
 * clusters across the user's entire interaction history.
 */

import type { FridaySqliteLayer } from "#state";
import type { FridaySessionSatisfactionRepository } from "../persistence/friday-session-satisfaction-repository.js";
import type { FridayPreferenceFactRepository } from "../persistence/friday-preference-fact-repository.js";
import type { FridayLearningPattern } from "../model/friday-learning.types.js";

// ─── Public interface ───────────────────────────────────────────

export interface FridayDeepPatternExtractionService {
  extractDeepPatterns(input: {
    userId: string;
    nowIso: string;
    lookbackDays?: number;
  }): FridayLearningPattern[];
}

// ─── Deps ───────────────────────────────────────────────────────

export interface CreateDeepPatternExtractionServiceDeps {
  db: FridaySqliteLayer;
  satisfactionRepo: FridaySessionSatisfactionRepository;
  factRepo: FridayPreferenceFactRepository;
  idGenerator: () => string;
}

// ─── Internal types ─────────────────────────────────────────────

interface FailureClusterRow {
  signature: string;
  cnt: number;
  first_seen: string;
  last_seen: string;
}

// ─── Factory ────────────────────────────────────────────────────

export function createFridayDeepPatternExtractionService(
  deps: CreateDeepPatternExtractionServiceDeps,
): FridayDeepPatternExtractionService {
  return {
    extractDeepPatterns(input) {
      const lookbackDays = input.lookbackDays ?? 90;
      const cutoff = new Date(
        new Date(input.nowIso).getTime() - lookbackDays * 86_400_000,
      ).toISOString();
      const patterns: FridayLearningPattern[] = [];

      // 1. Cross-session failure clusters (≥3 across different sessions)
      const failureClusters = deps.db.withReadConnection((db) =>
        db
          .prepare(
            `SELECT signature, COUNT(*) as cnt,
                    MIN(created_at) as first_seen, MAX(created_at) as last_seen
             FROM error_incidents
             WHERE user_id = ? AND created_at >= ?
             GROUP BY signature
             HAVING cnt >= 3
             ORDER BY cnt DESC
             LIMIT 10`,
          )
          .all(input.userId, cutoff) as FailureClusterRow[],
      );

      for (const cluster of failureClusters) {
        const strength = Math.min(
          1,
          Math.max(0, Math.log2(1 + cluster.cnt) / 3),
        );
        patterns.push({
          patternId: deps.idGenerator(),
          userId: input.userId,
          kind: "recurring_incident_signature",
          key: `deep:failure_cluster:${cluster.signature}`,
          strength,
          occurrences: cluster.cnt,
          windowStart: cluster.first_seen,
          windowEnd: cluster.last_seen,
          evidence: {
            source: "deep_pattern_extraction",
            signature: cluster.signature,
            sessionSpanning: true,
          },
        });
      }

      // 2. Preference drift (facts corrected ≥2 times in lookback window)
      const facts = deps.db.withReadConnection((db) =>
        deps.factRepo.listByUser(db, input.userId, 0, 500),
      );

      const driftCandidates = facts.filter(
        (f) => f.evidenceCount >= 3 && f.emotionalValence !== undefined,
      );

      for (const fact of driftCandidates) {
        if (
          fact.emotionalValence !== undefined &&
          fact.emotionalValence < -0.2 &&
          fact.evidenceCount >= 4
        ) {
          patterns.push({
            patternId: deps.idGenerator(),
            userId: input.userId,
            kind: "drifting_preference_key",
            key: `deep:drift:${fact.key}`,
            strength: Math.min(1, 0.3 + fact.evidenceCount * 0.1),
            occurrences: fact.evidenceCount,
            windowStart: fact.createdAt,
            windowEnd: fact.updatedAt,
            evidence: {
              source: "deep_pattern_extraction",
              factKey: fact.key,
              avgValence: fact.emotionalValence,
              crossSession: true,
            },
          });
        }
      }

      // 3. Satisfaction-correlated stable preferences
      const stableFacts = facts.filter(
        (f) => f.confidence >= 0.75 && f.evidenceCount >= 4,
      );

      const avgSatisfaction = deps.db.withReadConnection((db) =>
        deps.satisfactionRepo.getAverageScore(
          db,
          input.userId,
          lookbackDays,
          input.nowIso,
        ),
      );

      if (avgSatisfaction !== null && avgSatisfaction > 0.2) {
        for (const fact of stableFacts.slice(0, 5)) {
          patterns.push({
            patternId: deps.idGenerator(),
            userId: input.userId,
            kind: "stable_preference_key",
            key: `deep:stable:${fact.key}`,
            strength: Math.min(1, fact.confidence * 0.8 + avgSatisfaction * 0.2),
            occurrences: fact.evidenceCount,
            windowStart: fact.createdAt,
            windowEnd: fact.updatedAt,
            evidence: {
              source: "deep_pattern_extraction",
              factKey: fact.key,
              correlatedSatisfaction: avgSatisfaction,
              crossSession: true,
            },
          });
        }
      }

      return patterns;
    },
  };
}

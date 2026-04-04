/**
 * Session Satisfaction Service — aggregates emotional valence signals
 * from a session into a single satisfaction score, and computes user
 * satisfaction trends over time.
 */

import type { FridaySqliteLayer } from "#state";
import type {
  FridaySessionSatisfactionEntity,
  FridaySessionSatisfactionRepository,
} from "../persistence/friday-session-satisfaction-repository.js";
import type { FridayPreferenceFactRepository } from "../persistence/friday-preference-fact-repository.js";

// ─── Public interface ───────────────────────────────────────────

export interface FridaySessionSatisfactionService {
  computeSessionScore(input: {
    sessionId: string;
    userId: string;
    valences: number[];
    nowIso: string;
  }): FridaySessionSatisfactionEntity;

  getUserSatisfactionTrend(input: {
    userId: string;
    lookbackDays: number;
    nowIso: string;
  }): {
    average: number;
    trend: "improving" | "declining" | "stable";
    recentSessions: number;
  };
}

// ─── Deps ───────────────────────────────────────────────────────

export interface CreateSessionSatisfactionServiceDeps {
  db: FridaySqliteLayer;
  satisfactionRepo: FridaySessionSatisfactionRepository;
}

// ─── Factory ────────────────────────────────────────────────────

export function createFridaySessionSatisfactionService(
  deps: CreateSessionSatisfactionServiceDeps,
): FridaySessionSatisfactionService {
  return {
    computeSessionScore(input) {
      const { valences } = input;

      if (valences.length === 0) {
        return deps.db.withWriteTransaction((db) =>
          deps.satisfactionRepo.upsert(db, {
            sessionId: input.sessionId,
            userId: input.userId,
            score: 0,
            signalCount: 0,
            positiveCount: 0,
            negativeCount: 0,
            neutralCount: 0,
            nowIso: input.nowIso,
          }),
        );
      }

      const sum = valences.reduce((a, b) => a + b, 0);
      const score = Math.min(1, Math.max(-1, sum / valences.length));

      const positiveCount = valences.filter((v) => v > 0.1).length;
      const negativeCount = valences.filter((v) => v < -0.1).length;
      const neutralCount = valences.length - positiveCount - negativeCount;

      return deps.db.withWriteTransaction((db) =>
        deps.satisfactionRepo.upsert(db, {
          sessionId: input.sessionId,
          userId: input.userId,
          score,
          signalCount: valences.length,
          positiveCount,
          negativeCount,
          neutralCount,
          nowIso: input.nowIso,
        }),
      );
    },

    getUserSatisfactionTrend(input) {
      const sessions = deps.db.withReadConnection((db) =>
        deps.satisfactionRepo.listByUser(db, input.userId, 20),
      );

      const cutoff = new Date(
        new Date(input.nowIso).getTime() - input.lookbackDays * 86_400_000,
      ).toISOString();

      const recent = sessions.filter((s) => s.computedAt >= cutoff);

      if (recent.length < 2) {
        const avg =
          recent.length === 1 ? recent[0]!.score : 0;
        return { average: avg, trend: "stable" as const, recentSessions: recent.length };
      }

      const average =
        recent.reduce((a, s) => a + s.score, 0) / recent.length;

      // Simple linear trend: compare first half vs second half averages
      const mid = Math.floor(recent.length / 2);
      const recentHalf = recent.slice(0, mid); // newer (sorted DESC)
      const olderHalf = recent.slice(mid);

      const recentAvg =
        recentHalf.reduce((a, s) => a + s.score, 0) / recentHalf.length;
      const olderAvg =
        olderHalf.reduce((a, s) => a + s.score, 0) / olderHalf.length;

      const diff = recentAvg - olderAvg;
      const trend: "improving" | "declining" | "stable" =
        diff > 0.1 ? "improving" : diff < -0.1 ? "declining" : "stable";

      return { average, trend, recentSessions: recent.length };
    },
  };
}

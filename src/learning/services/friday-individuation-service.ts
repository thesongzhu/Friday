/**
 * Individuation Service — computes the user's individuation stage
 * based on accumulated preference facts, session count, satisfaction,
 * and persona learning coverage.
 */

import type Database from "better-sqlite3";
import type { FridaySqliteLayer } from "#state";
import type { FridayPreferenceFactRepository } from "../persistence/friday-preference-fact-repository.js";
import type { FridaySessionSatisfactionRepository } from "../persistence/friday-session-satisfaction-repository.js";
import type {
  FridayIndividuationStage,
  FridayIndividuationStateEntity,
  FridayIndividuationStateRow,
} from "../model/friday-individuation.types.js";
import {
  FRIDAY_INDIVIDUATION_THRESHOLDS,
  FRIDAY_TOTAL_PERSONA_DIMENSIONS,
} from "../model/friday-individuation.types.js";

// ─── Public interface ───────────────────────────────────────────

export interface FridayIndividuationService {
  computeStage(input: {
    userId: string;
    nowIso: string;
  }): FridayIndividuationStateEntity;

  getStage(userId: string): FridayIndividuationStateEntity | null;
}

// ─── Deps ───────────────────────────────────────────────────────

export interface CreateIndividuationServiceDeps {
  db: FridaySqliteLayer;
  factRepo: FridayPreferenceFactRepository;
  satisfactionRepo: FridaySessionSatisfactionRepository;
}

// ─── Helpers ────────────────────────────────────────────────────

const PERSONA_KEY_PREFIX = "persona.";

function rowToEntity(row: FridayIndividuationStateRow): FridayIndividuationStateEntity {
  return {
    userId: row.user_id,
    stage: row.stage as FridayIndividuationStage,
    factCount: row.fact_count,
    sessionCount: row.session_count,
    averageSatisfaction: row.average_satisfaction,
    learnedPersonaDimensions: row.learned_persona_dimensions,
    totalPersonaDimensions: FRIDAY_TOTAL_PERSONA_DIMENSIONS,
    stageEnteredAt: row.stage_entered_at,
    previousStage: row.previous_stage
      ? (row.previous_stage as FridayIndividuationStage)
      : undefined,
    computedAt: row.computed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function determineStage(input: {
  factCount: number;
  sessionCount: number;
  averageSatisfaction: number;
  learnedPersonaDimensions: number;
}): FridayIndividuationStage {
  const t = FRIDAY_INDIVIDUATION_THRESHOLDS;

  if (
    input.factCount >= t.partner.minFacts &&
    input.averageSatisfaction >= t.partner.minSatisfaction &&
    input.sessionCount >= t.partner.minSessions &&
    input.learnedPersonaDimensions >= FRIDAY_TOTAL_PERSONA_DIMENSIONS
  ) {
    return "partner";
  }

  if (
    input.factCount >= t.companion.minFacts &&
    input.averageSatisfaction >= t.companion.minSatisfaction &&
    input.sessionCount >= t.companion.minSessions
  ) {
    return "companion";
  }

  if (
    input.factCount >= t.familiar.minFacts &&
    input.averageSatisfaction >= t.familiar.minSatisfaction
  ) {
    return "familiar";
  }

  if (input.factCount >= t.acquaintance.minFacts) {
    return "acquaintance";
  }

  return "stranger";
}

function countPersonaDimensions(
  db: Database.Database,
  factRepo: FridayPreferenceFactRepository,
  userId: string,
): number {
  const facts = factRepo.listByUser(db, userId, 0, 500);
  const personaKeys = new Set(
    facts
      .filter((f) => f.key.startsWith(PERSONA_KEY_PREFIX))
      .map((f) => f.key),
  );
  return Math.min(personaKeys.size, FRIDAY_TOTAL_PERSONA_DIMENSIONS);
}

// ─── Factory ────────────────────────────────────────────────────

export function createFridayIndividuationService(
  deps: CreateIndividuationServiceDeps,
): FridayIndividuationService {
  return {
    computeStage(input) {
      return deps.db.withWriteTransaction((db) => {
        // Gather metrics
        const facts = deps.factRepo.listByUser(db, input.userId, 0, 500);
        const factCount = facts.length;

        const sessions = deps.satisfactionRepo.listByUser(
          db,
          input.userId,
          1000,
        );
        const sessionCount = sessions.length;

        const avgSatisfaction =
          deps.satisfactionRepo.getAverageScore(
            db,
            input.userId,
            365,
            input.nowIso,
          ) ?? 0;

        const learnedPersonaDimensions = countPersonaDimensions(
          db,
          deps.factRepo,
          input.userId,
        );

        const newStage = determineStage({
          factCount,
          sessionCount,
          averageSatisfaction: avgSatisfaction,
          learnedPersonaDimensions,
        });

        // Read current state if exists
        const existingRow = db
          .prepare(
            "SELECT * FROM friday_individuation_state WHERE user_id = ?",
          )
          .get(input.userId) as FridayIndividuationStateRow | undefined;

        const previousStage = existingRow?.stage ?? null;
        const stageChanged = previousStage !== newStage;

        db.prepare(
          `INSERT INTO friday_individuation_state
           (user_id, stage, fact_count, session_count, average_satisfaction,
            learned_persona_dimensions, stage_entered_at, previous_stage,
            computed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             stage = excluded.stage,
             fact_count = excluded.fact_count,
             session_count = excluded.session_count,
             average_satisfaction = excluded.average_satisfaction,
             learned_persona_dimensions = excluded.learned_persona_dimensions,
             stage_entered_at = CASE WHEN excluded.stage != friday_individuation_state.stage
               THEN excluded.stage_entered_at ELSE friday_individuation_state.stage_entered_at END,
             previous_stage = CASE WHEN excluded.stage != friday_individuation_state.stage
               THEN friday_individuation_state.stage ELSE friday_individuation_state.previous_stage END,
             computed_at = excluded.computed_at,
             updated_at = excluded.updated_at`,
        ).run(
          input.userId,
          newStage,
          factCount,
          sessionCount,
          avgSatisfaction,
          learnedPersonaDimensions,
          stageChanged ? input.nowIso : (existingRow?.stage_entered_at ?? input.nowIso),
          previousStage,
          input.nowIso,
          input.nowIso,
          input.nowIso,
        );

        const row = db
          .prepare(
            "SELECT * FROM friday_individuation_state WHERE user_id = ?",
          )
          .get(input.userId) as FridayIndividuationStateRow;

        return rowToEntity(row);
      });
    },

    getStage(userId) {
      return deps.db.withReadConnection((db) => {
        const row = db
          .prepare(
            "SELECT * FROM friday_individuation_state WHERE user_id = ?",
          )
          .get(userId) as FridayIndividuationStateRow | undefined;
        return row ? rowToEntity(row) : null;
      });
    },
  };
}

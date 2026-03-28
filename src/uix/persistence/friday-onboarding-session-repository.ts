/**
 * P2-02: SQLite-backed onboarding session repository.
 * Persists onboarding progress so it survives process restarts.
 */

import type Database from "better-sqlite3";
import type { OnboardingSession, OnboardingStepProgress } from "../engine/onboarding-engine.js";

export interface FridayOnboardingSessionRepository {
  save(db: Database.Database, session: OnboardingSession): void;
  findByFlowAndPrincipal(db: Database.Database, flowId: string, principalId: string): OnboardingSession | null;
  listActive(db: Database.Database): OnboardingSession[];
  delete(db: Database.Database, sessionId: string): void;
}

export function createFridayOnboardingSessionRepository(): FridayOnboardingSessionRepository {
  return {
    save(db, session) {
      db.prepare(`
        INSERT OR REPLACE INTO uix_onboarding_sessions
          (id, flow_id, principal_id, status, step_progress, current_step_index, started_at, updated_at, finished_at)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        session.id,
        session.flowId,
        session.principalId,
        session.status,
        JSON.stringify(session.stepProgress),
        session.currentStepIndex,
        session.startedAt,
        session.updatedAt,
        session.finishedAt ?? null,
      );
    },

    findByFlowAndPrincipal(db, flowId, principalId) {
      const row = db.prepare(`
        SELECT * FROM uix_onboarding_sessions
        WHERE flow_id = ? AND principal_id = ?
        ORDER BY updated_at DESC LIMIT 1
      `).get(flowId, principalId) as Record<string, unknown> | undefined;
      return row ? rowToSession(row) : null;
    },

    listActive(db) {
      const rows = db.prepare(`
        SELECT * FROM uix_onboarding_sessions
        WHERE status IN ('not_started', 'in_progress')
        ORDER BY updated_at DESC
      `).all() as Array<Record<string, unknown>>;
      return rows.map(rowToSession);
    },

    delete(db, sessionId) {
      db.prepare("DELETE FROM uix_onboarding_sessions WHERE id = ?").run(sessionId);
    },
  };
}

function rowToSession(row: Record<string, unknown>): OnboardingSession {
  return {
    id: String(row.id),
    flowId: String(row.flow_id),
    principalId: String(row.principal_id),
    status: String(row.status) as OnboardingSession["status"],
    stepProgress: JSON.parse(String(row.step_progress ?? "[]")) as OnboardingStepProgress[],
    currentStepIndex: Number(row.current_step_index ?? 0),
    startedAt: String(row.started_at),
    updatedAt: String(row.updated_at),
    finishedAt: row.finished_at ? String(row.finished_at) : undefined,
  };
}

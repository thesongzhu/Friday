import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";
import type {
  FridayReflexOnboardingAnswer,
  FridayReflexOnboardingSession,
  FridayReflexOnboardingStatus,
  FridayReflexSurface,
} from "../model/friday-reflex.types.js";

interface SessionRow {
  id: string;
  user_id: string;
  status: string;
  active_question_id: string | null;
  primary_channel_kind: string | null;
  primary_channel_user_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  dismissed_at: string | null;
}

interface AnswerRow {
  id: string;
  session_id: string;
  user_id: string;
  question_id: string;
  status: string;
  answer_json: string;
  source_surface: string;
  created_at: string;
  updated_at: string;
}

export interface FridayReflexOnboardingRepository {
  getSessionByUser(db: Database.Database, userId: string): FridayReflexOnboardingSession | null;
  createSession(db: Database.Database, input: {
    id: string;
    userId: string;
    status?: FridayReflexOnboardingStatus;
    activeQuestionId: string | null;
    primaryChannelKind?: string;
    primaryChannelUserId?: string;
    nowIso: string;
  }): FridayReflexOnboardingSession;
  updateSession(db: Database.Database, input: {
    userId: string;
    status?: FridayReflexOnboardingStatus;
    activeQuestionId?: string | null;
    primaryChannelKind?: string;
    primaryChannelUserId?: string;
    nowIso: string;
  }): FridayReflexOnboardingSession | null;
  listAnswers(db: Database.Database, input: { sessionId: string }): FridayReflexOnboardingAnswer[];
  upsertAnswer(db: Database.Database, input: {
    id: string;
    sessionId: string;
    userId: string;
    questionId: string;
    status: "answered" | "skipped";
    answer: Record<string, unknown>;
    sourceSurface: FridayReflexSurface;
    nowIso: string;
  }): FridayReflexOnboardingAnswer;
}

function mapSession(row: SessionRow): FridayReflexOnboardingSession {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status as FridayReflexOnboardingSession["status"],
    ...(row.active_question_id ? { activeQuestionId: row.active_question_id } : {}),
    ...(row.primary_channel_kind ? { primaryChannelKind: row.primary_channel_kind } : {}),
    ...(row.primary_channel_user_id ? { primaryChannelUserId: row.primary_channel_user_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.dismissed_at ? { dismissedAt: row.dismissed_at } : {}),
  };
}

function mapAnswer(row: AnswerRow): FridayReflexOnboardingAnswer {
  const answer = safeJsonParse<Record<string, unknown>>(row.answer_json);
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    questionId: row.question_id,
    status: row.status as FridayReflexOnboardingAnswer["status"],
    answer: answer && typeof answer === "object" && !Array.isArray(answer)
      ? answer as FridayReflexOnboardingAnswer["answer"]
      : {},
    sourceSurface: row.source_surface as FridayReflexSurface,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayReflexOnboardingRepository(): FridayReflexOnboardingRepository {
  return {
    getSessionByUser(db, userId) {
      const row = db.prepare(
        `SELECT * FROM friday_reflex_onboarding_sessions WHERE user_id = ?`,
      ).get(userId) as SessionRow | undefined;
      return row ? mapSession(row) : null;
    },

    createSession(db, input) {
      const status = input.status ?? "active";
      db.prepare(
        `INSERT INTO friday_reflex_onboarding_sessions (
          id, user_id, status, active_question_id, primary_channel_kind,
          primary_channel_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.userId,
        status,
        input.activeQuestionId,
        input.primaryChannelKind ?? null,
        input.primaryChannelUserId ?? null,
        input.nowIso,
        input.nowIso,
      );
      return this.getSessionByUser(db, input.userId)!;
    },

    updateSession(db, input) {
      const current = this.getSessionByUser(db, input.userId);
      if (!current) return null;
      const status = input.status ?? current.status;
      const completedAt = status === "completed" ? input.nowIso : current.completedAt ?? null;
      const dismissedAt = status === "dismissed" ? input.nowIso : current.dismissedAt ?? null;
      db.prepare(
        `UPDATE friday_reflex_onboarding_sessions
         SET status = ?, active_question_id = ?, primary_channel_kind = ?,
             primary_channel_user_id = ?, updated_at = ?, completed_at = ?, dismissed_at = ?
         WHERE user_id = ?`,
      ).run(
        status,
        input.activeQuestionId !== undefined ? input.activeQuestionId : current.activeQuestionId ?? null,
        input.primaryChannelKind ?? current.primaryChannelKind ?? null,
        input.primaryChannelUserId ?? current.primaryChannelUserId ?? null,
        input.nowIso,
        completedAt,
        dismissedAt,
        input.userId,
      );
      return this.getSessionByUser(db, input.userId);
    },

    listAnswers(db, input) {
      const rows = db.prepare(
        `SELECT * FROM friday_reflex_onboarding_answers
         WHERE session_id = ?
         ORDER BY created_at ASC`,
      ).all(input.sessionId) as AnswerRow[];
      return rows.map(mapAnswer);
    },

    upsertAnswer(db, input) {
      const existing = db.prepare(
        `SELECT id, created_at FROM friday_reflex_onboarding_answers
         WHERE session_id = ? AND question_id = ?`,
      ).get(input.sessionId, input.questionId) as { id: string; created_at: string } | undefined;
      const id = existing?.id ?? input.id;
      db.prepare(
        `INSERT INTO friday_reflex_onboarding_answers (
          id, session_id, user_id, question_id, status, answer_json,
          source_surface, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, question_id) DO UPDATE SET
          status = excluded.status,
          answer_json = excluded.answer_json,
          source_surface = excluded.source_surface,
          updated_at = excluded.updated_at`,
      ).run(
        id,
        input.sessionId,
        input.userId,
        input.questionId,
        input.status,
        JSON.stringify(input.answer),
        input.sourceSurface,
        existing?.created_at ?? input.nowIso,
        input.nowIso,
      );
      const row = db.prepare(
        `SELECT * FROM friday_reflex_onboarding_answers WHERE id = ?`,
      ).get(id) as AnswerRow;
      return mapAnswer(row);
    },
  };
}

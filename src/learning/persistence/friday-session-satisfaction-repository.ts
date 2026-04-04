import type Database from "better-sqlite3";

export interface FridaySessionSatisfactionRow {
  session_id: string;
  user_id: string;
  score: number;
  signal_count: number;
  positive_count: number;
  negative_count: number;
  neutral_count: number;
  computed_at: string;
  created_at: string;
  updated_at: string;
}

export interface FridaySessionSatisfactionEntity {
  sessionId: string;
  userId: string;
  score: number;
  signalCount: number;
  positiveCount: number;
  negativeCount: number;
  neutralCount: number;
  computedAt: string;
  createdAt: string;
  updatedAt: string;
}

function rowToEntity(row: FridaySessionSatisfactionRow): FridaySessionSatisfactionEntity {
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    score: row.score,
    signalCount: row.signal_count,
    positiveCount: row.positive_count,
    negativeCount: row.negative_count,
    neutralCount: row.neutral_count,
    computedAt: row.computed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface FridaySessionSatisfactionRepository {
  upsert(
    db: Database.Database,
    input: {
      sessionId: string;
      userId: string;
      score: number;
      signalCount: number;
      positiveCount: number;
      negativeCount: number;
      neutralCount: number;
      nowIso: string;
    },
  ): FridaySessionSatisfactionEntity;

  getBySession(
    db: Database.Database,
    sessionId: string,
  ): FridaySessionSatisfactionEntity | null;

  listByUser(
    db: Database.Database,
    userId: string,
    limit?: number,
  ): FridaySessionSatisfactionEntity[];

  getAverageScore(
    db: Database.Database,
    userId: string,
    lookbackDays: number,
    nowIso: string,
  ): number | null;
}

export function createFridaySessionSatisfactionRepository(): FridaySessionSatisfactionRepository {
  return {
    upsert(db, input) {
      db.prepare(
        `INSERT INTO friday_session_satisfaction
         (session_id, user_id, score, signal_count, positive_count,
          negative_count, neutral_count, computed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           score = excluded.score,
           signal_count = excluded.signal_count,
           positive_count = excluded.positive_count,
           negative_count = excluded.negative_count,
           neutral_count = excluded.neutral_count,
           computed_at = excluded.computed_at,
           updated_at = excluded.updated_at`,
      ).run(
        input.sessionId,
        input.userId,
        input.score,
        input.signalCount,
        input.positiveCount,
        input.negativeCount,
        input.neutralCount,
        input.nowIso,
        input.nowIso,
        input.nowIso,
      );

      return this.getBySession(db, input.sessionId)!;
    },

    getBySession(db, sessionId) {
      const row = db
        .prepare("SELECT * FROM friday_session_satisfaction WHERE session_id = ?")
        .get(sessionId) as FridaySessionSatisfactionRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    listByUser(db, userId, limit = 20) {
      const rows = db
        .prepare(
          `SELECT * FROM friday_session_satisfaction
           WHERE user_id = ?
           ORDER BY computed_at DESC
           LIMIT ?`,
        )
        .all(userId, limit) as FridaySessionSatisfactionRow[];
      return rows.map(rowToEntity);
    },

    getAverageScore(db, userId, lookbackDays, nowIso) {
      const cutoff = new Date(
        new Date(nowIso).getTime() - lookbackDays * 86_400_000,
      ).toISOString();

      const row = db
        .prepare(
          `SELECT AVG(score) as avg_score
           FROM friday_session_satisfaction
           WHERE user_id = ? AND computed_at >= ?`,
        )
        .get(userId, cutoff) as { avg_score: number | null } | undefined;

      return row?.avg_score ?? null;
    },
  };
}

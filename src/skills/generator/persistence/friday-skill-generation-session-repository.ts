import type Database from "better-sqlite3";

import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import { safeJsonParse } from "#utilities";

import type {
  FridaySkillGenerationSession,
  FridaySkillGenerationTurn,
} from "../model/friday-skill-generator.types.js";

// ─── Namespaces ───

const SESSION_NAMESPACE = "skill-generator-session";
const TURN_NAMESPACE = "skill-generator-turn";

// ─── Row shapes ───

interface MemoryItemRow {
  id: string;
  namespace: string;
  key: string;
  value_json: string;
  tags_json: string;
  created_at: string;
  updated_at: string;
}

interface SkillGenerationValueRow {
  value_json: string;
}

interface SkillGenerationSessionRow extends SkillGenerationValueRow {
  session_id: string;
}

interface SkillGenerationTurnRow extends SkillGenerationValueRow {
  session_id: string;
  turn_id: string;
}

// ─── Repository interface ───

export interface FridaySkillGenerationSessionRepository {
  createSession(session: FridaySkillGenerationSession): void;
  getSession(sessionId: string): FridaySkillGenerationSession | null;
  updateSession(session: FridaySkillGenerationSession): void;
  addTurn(turn: FridaySkillGenerationTurn): void;
  getTurns(sessionId: string): FridaySkillGenerationTurn[];
  deleteSession(sessionId: string): void;
}

// ─── Deps ───

export interface CreateSessionRepositoryDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
}

// ─── Internal helpers ───

function upsertSkillGenerationSession(
  db: Database.Database,
  params: {
    session: FridaySkillGenerationSession;
    tags: string[];
  },
): void {
  db.prepare(
    `INSERT INTO skill_generation_sessions (
       session_id, user_id, channel, status, created_at, updated_at, value_json, tags_json
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       user_id = excluded.user_id,
       channel = excluded.channel,
       status = excluded.status,
       updated_at = excluded.updated_at,
       value_json = excluded.value_json,
       tags_json = excluded.tags_json`,
  ).run(
    params.session.sessionId,
    params.session.userId,
    params.session.channel,
    params.session.status,
    params.session.createdAt,
    params.session.updatedAt,
    JSON.stringify(params.session),
    JSON.stringify(params.tags),
  );
}

function getSkillGenerationSession(
  db: Database.Database,
  sessionId: string,
): SkillGenerationSessionRow | undefined {
  return db
    .prepare("SELECT session_id, value_json FROM skill_generation_sessions WHERE session_id = ?")
    .get(sessionId) as SkillGenerationSessionRow | undefined;
}

function upsertSkillGenerationTurn(
  db: Database.Database,
  params: {
    turn: FridaySkillGenerationTurn;
    tags: string[];
  },
): void {
  db.prepare(
    `INSERT INTO skill_generation_turns (
       session_id, turn_id, role, created_at, value_json, tags_json
     )
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, turn_id) DO UPDATE SET
       role = excluded.role,
       created_at = excluded.created_at,
       value_json = excluded.value_json,
       tags_json = excluded.tags_json`,
  ).run(
    params.turn.sessionId,
    params.turn.turnId,
    params.turn.role,
    params.turn.createdAt,
    JSON.stringify(params.turn),
    JSON.stringify(params.tags),
  );
}

function listSkillGenerationTurns(
  db: Database.Database,
  sessionId: string,
): SkillGenerationTurnRow[] {
  return db
    .prepare(
      `SELECT session_id, turn_id, value_json
       FROM skill_generation_turns
       WHERE session_id = ?
       ORDER BY created_at ASC`,
    )
    .all(sessionId) as SkillGenerationTurnRow[];
}

function getMemoryItem(
  db: Database.Database,
  namespace: string,
  key: string,
): MemoryItemRow | undefined {
  return db
    .prepare("SELECT * FROM memory_items WHERE namespace = ? AND key = ?")
    .get(namespace, key) as MemoryItemRow | undefined;
}

function listMemoryItemsByNamespacePrefix(
  db: Database.Database,
  namespace: string,
  keyPrefix: string,
): MemoryItemRow[] {
  return db
    .prepare(
      "SELECT * FROM memory_items WHERE namespace = ? AND key LIKE ? ORDER BY created_at ASC",
    )
    .all(namespace, `${keyPrefix}%`) as MemoryItemRow[];
}

function deleteSkillGenerationSession(
  db: Database.Database,
  sessionId: string,
): void {
  db.prepare("DELETE FROM skill_generation_sessions WHERE session_id = ?").run(
    sessionId,
  );
}

function deleteSkillGenerationTurns(
  db: Database.Database,
  sessionId: string,
): void {
  db.prepare("DELETE FROM skill_generation_turns WHERE session_id = ?").run(
    sessionId,
  );
}

// ─── Factory ───

export function createFridaySkillGenerationSessionRepository(
  deps: CreateSessionRepositoryDeps,
): FridaySkillGenerationSessionRepository {
  const { db } = deps;

  function sessionKey(sessionId: string): string {
    return sessionId;
  }

  function turnKey(sessionId: string, turnId: string): string {
    return `${sessionId}:${turnId}`;
  }

  function turnKeyPrefix(sessionId: string): string {
    return `${sessionId}:`;
  }

  return {
    createSession(session) {
      db.withWriteTransaction((writer) => {
        upsertSkillGenerationSession(writer, {
          session,
          tags: ["session", session.status],
        });
      });
    },

    getSession(sessionId) {
      return db.withReadConnection((reader) => {
        const row = getSkillGenerationSession(reader, sessionKey(sessionId))
          ?? getMemoryItem(
          reader,
          SESSION_NAMESPACE,
          sessionKey(sessionId),
        );
        if (!row) return null;
        return safeJsonParse<FridaySkillGenerationSession>(row.value_json) ?? null;
      });
    },

    updateSession(session) {
      db.withWriteTransaction((writer) => {
        const existing = getSkillGenerationSession(writer, sessionKey(session.sessionId))
          ?? getMemoryItem(
          writer,
          SESSION_NAMESPACE,
          sessionKey(session.sessionId),
        );
        if (!existing) {
          throw new FridayDomainError(
            "GENERATOR_SESSION_NOT_FOUND",
            `Session not found: ${session.sessionId}`,
            { httpStatus: 404 },
          );
        }
        upsertSkillGenerationSession(writer, {
          session,
          tags: ["session", session.status],
        });
      });
    },

    addTurn(turn) {
      db.withWriteTransaction((writer) => {
        upsertSkillGenerationTurn(writer, {
          turn,
          tags: ["turn", turn.role],
        });
      });
    },

    getTurns(sessionId) {
      return db.withReadConnection((reader) => {
        const dedicatedRows = listSkillGenerationTurns(reader, sessionId);
        const legacyRows = listMemoryItemsByNamespacePrefix(
          reader,
          TURN_NAMESPACE,
          turnKeyPrefix(sessionId),
        );
        const byTurnId = new Map<string, FridaySkillGenerationTurn>();
        for (const row of legacyRows) {
          const parsed = safeJsonParse<FridaySkillGenerationTurn>(row.value_json);
          if (parsed) byTurnId.set(parsed.turnId, parsed);
        }
        for (const row of dedicatedRows) {
          const parsed = safeJsonParse<FridaySkillGenerationTurn>(row.value_json);
          if (parsed) byTurnId.set(parsed.turnId, parsed);
        }
        return Array.from(byTurnId.values()).sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        );
      });
    },

    deleteSession(sessionId) {
      db.withWriteTransaction((writer) => {
        deleteSkillGenerationSession(writer, sessionKey(sessionId));
        deleteSkillGenerationTurns(writer, sessionKey(sessionId));
      });
    },
  };
}

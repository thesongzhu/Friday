import type Database from "better-sqlite3";

import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import { safeJsonParse } from "#utilities";

import type {
  FridayWorkflowGenerationSession,
  FridayWorkflowGenerationTurn,
} from "../model/friday-workflow-generator.types.js";

// ─── Namespaces ───

const SESSION_NAMESPACE = "workflow-generator-session";
const TURN_NAMESPACE = "workflow-generator-turn";

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

interface WorkflowGenerationValueRow {
  value_json: string;
}

interface WorkflowGenerationSessionRow extends WorkflowGenerationValueRow {
  session_id: string;
}

interface WorkflowGenerationTurnRow extends WorkflowGenerationValueRow {
  session_id: string;
  turn_id: string;
}

// ─── Repository interface ───

export interface FridayWorkflowGenerationSessionRepository {
  createSession(session: FridayWorkflowGenerationSession): void;
  getSession(sessionId: string): FridayWorkflowGenerationSession | null;
  updateSession(session: FridayWorkflowGenerationSession): void;
  addTurn(turn: FridayWorkflowGenerationTurn): void;
  getTurns(sessionId: string): FridayWorkflowGenerationTurn[];
  deleteSession(sessionId: string): void;
}

// ─── Deps ───

export interface CreateWorkflowGenerationSessionRepositoryDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
}

// ─── Internal helpers ───

function upsertWorkflowGenerationSession(
  db: Database.Database,
  params: {
    session: FridayWorkflowGenerationSession;
    tags: string[];
  },
): void {
  db.prepare(
    `INSERT INTO workflow_generation_sessions (
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

function getWorkflowGenerationSession(
  db: Database.Database,
  sessionId: string,
): WorkflowGenerationSessionRow | undefined {
  return db
    .prepare("SELECT session_id, value_json FROM workflow_generation_sessions WHERE session_id = ?")
    .get(sessionId) as WorkflowGenerationSessionRow | undefined;
}

function upsertWorkflowGenerationTurn(
  db: Database.Database,
  params: {
    turn: FridayWorkflowGenerationTurn;
    tags: string[];
  },
): void {
  db.prepare(
    `INSERT INTO workflow_generation_turns (
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

function listWorkflowGenerationTurns(
  db: Database.Database,
  sessionId: string,
): WorkflowGenerationTurnRow[] {
  return db
    .prepare(
      `SELECT session_id, turn_id, value_json
       FROM workflow_generation_turns
       WHERE session_id = ?
       ORDER BY created_at ASC`,
    )
    .all(sessionId) as WorkflowGenerationTurnRow[];
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

function deleteWorkflowGenerationSession(
  db: Database.Database,
  sessionId: string,
): void {
  db.prepare("DELETE FROM workflow_generation_sessions WHERE session_id = ?").run(
    sessionId,
  );
}

function deleteWorkflowGenerationTurns(
  db: Database.Database,
  sessionId: string,
): void {
  db.prepare("DELETE FROM workflow_generation_turns WHERE session_id = ?").run(
    sessionId,
  );
}

// ─── Factory ───

export function createFridayWorkflowGenerationSessionRepository(
  deps: CreateWorkflowGenerationSessionRepositoryDeps,
): FridayWorkflowGenerationSessionRepository {
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
        upsertWorkflowGenerationSession(writer, {
          session,
          tags: ["session", session.status],
        });
      });
    },

    getSession(sessionId) {
      return db.withReadConnection((reader) => {
        const row = getWorkflowGenerationSession(reader, sessionKey(sessionId))
          ?? getMemoryItem(
          reader,
          SESSION_NAMESPACE,
          sessionKey(sessionId),
        );
        if (!row) return null;
        return safeJsonParse<FridayWorkflowGenerationSession>(row.value_json) ?? null;
      });
    },

    updateSession(session) {
      db.withWriteTransaction((writer) => {
        const existing = getWorkflowGenerationSession(writer, sessionKey(session.sessionId))
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
        upsertWorkflowGenerationSession(writer, {
          session,
          tags: ["session", session.status],
        });
      });
    },

    addTurn(turn) {
      db.withWriteTransaction((writer) => {
        upsertWorkflowGenerationTurn(writer, {
          turn,
          tags: ["turn", turn.role],
        });
      });
    },

    getTurns(sessionId) {
      return db.withReadConnection((reader) => {
        const rows = listWorkflowGenerationTurns(reader, sessionId);
        if (rows.length === 0) {
          const legacyRows = listMemoryItemsByNamespacePrefix(
            reader,
            TURN_NAMESPACE,
            turnKeyPrefix(sessionId),
          );
          return legacyRows.map(
            (row) => safeJsonParse<FridayWorkflowGenerationTurn>(row.value_json)!,
          );
        }
        return rows.map(
          (row) => safeJsonParse<FridayWorkflowGenerationTurn>(row.value_json)!,
        );
      });
    },

    deleteSession(sessionId) {
      db.withWriteTransaction((writer) => {
        deleteWorkflowGenerationTurns(writer, sessionId);
        deleteWorkflowGenerationSession(writer, sessionId);
      });
    },
  };
}

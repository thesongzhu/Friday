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

// ─── Row shape from memory_items ───

interface MemoryItemRow {
  id: string;
  namespace: string;
  key: string;
  value_json: string;
  tags_json: string;
  created_at: string;
  updated_at: string;
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

function upsertMemoryItem(
  db: Database.Database,
  params: {
    id: string;
    namespace: string;
    key: string;
    value: unknown;
    tags: string[];
    nowIso: string;
  },
): void {
  db.prepare(
    `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(namespace, key) DO UPDATE SET
       value_json = excluded.value_json,
       tags_json = excluded.tags_json,
       updated_at = excluded.updated_at`,
  ).run(
    params.id,
    params.namespace,
    params.key,
    JSON.stringify(params.value),
    JSON.stringify(params.tags),
    params.nowIso,
    params.nowIso,
  );
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

function deleteMemoryItem(
  db: Database.Database,
  namespace: string,
  key: string,
): void {
  db.prepare("DELETE FROM memory_items WHERE namespace = ? AND key = ?").run(
    namespace,
    key,
  );
}

function deleteMemoryItemsByPrefix(
  db: Database.Database,
  namespace: string,
  keyPrefix: string,
): void {
  db.prepare(
    "DELETE FROM memory_items WHERE namespace = ? AND key LIKE ?",
  ).run(namespace, `${keyPrefix}%`);
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
        upsertMemoryItem(writer, {
          id: deps.idGenerator(),
          namespace: SESSION_NAMESPACE,
          key: sessionKey(session.sessionId),
          value: session,
          tags: ["session", session.status],
          nowIso: deps.nowIso(),
        });
      });
    },

    getSession(sessionId) {
      return db.withReadConnection((reader) => {
        const row = getMemoryItem(
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
        const existing = getMemoryItem(
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
        upsertMemoryItem(writer, {
          id: existing.id,
          namespace: SESSION_NAMESPACE,
          key: sessionKey(session.sessionId),
          value: session,
          tags: ["session", session.status],
          nowIso: deps.nowIso(),
        });
      });
    },

    addTurn(turn) {
      db.withWriteTransaction((writer) => {
        upsertMemoryItem(writer, {
          id: deps.idGenerator(),
          namespace: TURN_NAMESPACE,
          key: turnKey(turn.sessionId, turn.turnId),
          value: turn,
          tags: ["turn", turn.role],
          nowIso: deps.nowIso(),
        });
      });
    },

    getTurns(sessionId) {
      return db.withReadConnection((reader) => {
        const rows = listMemoryItemsByNamespacePrefix(
          reader,
          TURN_NAMESPACE,
          turnKeyPrefix(sessionId),
        );
        return rows.map(
          (row) => safeJsonParse<FridaySkillGenerationTurn>(row.value_json)!,
        );
      });
    },

    deleteSession(sessionId) {
      db.withWriteTransaction((writer) => {
        deleteMemoryItem(writer, SESSION_NAMESPACE, sessionKey(sessionId));
        deleteMemoryItemsByPrefix(
          writer,
          TURN_NAMESPACE,
          turnKeyPrefix(sessionId),
        );
      });
    },
  };
}

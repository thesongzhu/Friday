import type Database from "better-sqlite3";

import { FridayDomainError } from "#errors";

import { FRIDAY_SESSION_ERROR_CODES } from "../friday-session.constants.js";
import type {
  FridaySessionChatKind,
  FridaySessionCreateInput,
  FridaySessionListInput,
  FridaySessionRecord,
  FridaySessionSendPolicy,
  FridaySessionStatus,
} from "../model/friday-session.types.js";

// ─── Row shape from SQLite ───

interface FridaySessionRow {
  id: string;
  session_key: string;
  channel: string;
  account_id: string;
  chat_id: string;
  user_id: string | null;
  chat_kind: string;
  status: string;
  memory_namespace: string | null;
  parent_session_key: string | null;
  root_session_key: string | null;
  forked_from_message_id: string | null;
  send_policy: string | null;
  metadata_json: string | null;
  context_input_tokens: number;
  context_output_tokens: number;
  context_total_tokens: number;
  message_count: number;
  created_at: string;
  updated_at: string;
  last_activity_at: string | null;
  status_changed_at: string | null;
  idle_at: string | null;
  archived_at: string | null;
  pruned_at: string | null;
}

function rowToRecord(row: FridaySessionRow): FridaySessionRecord {
  return {
    id: row.id,
    key: row.session_key,
    channel: row.channel,
    accountId: row.account_id,
    chatId: row.chat_id,
    userId: row.user_id ?? undefined,
    chatKind: row.chat_kind as FridaySessionChatKind,
    status: row.status as FridaySessionStatus,
    memoryNamespace: row.memory_namespace ?? undefined,
    parentSessionKey: row.parent_session_key ?? undefined,
    rootSessionKey: row.root_session_key ?? undefined,
    forkedFromMessageId: row.forked_from_message_id ?? undefined,
    sendPolicy: row.send_policy as FridaySessionSendPolicy | undefined ?? undefined,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, unknown> : {},
    contextInputTokens: row.context_input_tokens,
    contextOutputTokens: row.context_output_tokens,
    contextTotalTokens: row.context_total_tokens,
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at ?? undefined,
    statusChangedAt: row.status_changed_at ?? undefined,
    idleAt: row.idle_at ?? undefined,
    archivedAt: row.archived_at ?? undefined,
    prunedAt: row.pruned_at ?? undefined,
  };
}

// ─── Repository interface ───

export interface FridaySessionRepository {
  insert(
    db: Database.Database,
    input: FridaySessionCreateInput & { key: string; nowIso: string; memoryNamespace?: string; idGenerator: () => string },
  ): FridaySessionRecord;

  getByKey(db: Database.Database, key: string): FridaySessionRecord | null;

  list(db: Database.Database, input: FridaySessionListInput): FridaySessionRecord[];

  updateStatus(
    db: Database.Database,
    input: { key: string; from?: FridaySessionStatus[]; to: FridaySessionStatus; nowIso: string },
  ): FridaySessionRecord | null;

  touchActivity(
    db: Database.Database,
    input: { key: string; nowIso: string; tokenDelta?: { input: number; output: number; total: number }; messageDelta?: number },
  ): FridaySessionRecord | null;

  markIdleCandidates(db: Database.Database, input: { idleBeforeIso: string; nowIso: string }): number;

  markArchivedCandidates(db: Database.Database, input: { archiveBeforeIso: string; nowIso: string }): number;

  markPrunedCandidates(db: Database.Database, input: { olderThanIso: string; nowIso: string }): string[];

  hardDeletePruned(db: Database.Database, input: { hardDeleteBeforeIso: string }): number;

  listByParentSessionKey(
    db: Database.Database,
    input: { parentSessionKey: string; statuses?: FridaySessionStatus[]; limit?: number },
  ): FridaySessionRecord[];

  setForkLineage(
    db: Database.Database,
    input: {
      key: string;
      parentSessionKey: string;
      rootSessionKey: string;
      forkedFromMessageId?: string;
      memoryNamespace?: string;
    },
  ): void;

  markForkArchivedCandidates(
    db: Database.Database,
    input: { forkTimeoutBeforeIso: string; nowIso: string },
  ): number;

  updateSendPolicy(
    db: Database.Database,
    input: { key: string; sendPolicy: string | null; nowIso: string },
  ): FridaySessionRecord | null;

  updateMetadata(
    db: Database.Database,
    input: { key: string; metadata: Record<string, unknown>; nowIso: string },
  ): FridaySessionRecord | null;
}

// ─── Factory ───

export function createFridaySessionRepository(): FridaySessionRepository {
  return {
    insert(db, input) {
      const id = input.idGenerator();
      const now = input.nowIso;
      const metadataJson = JSON.stringify(input.metadata ?? {});
      const chatKind = input.chatKind ?? "dm";
      const accountId = input.accountId ?? "default";

      try {
        db.prepare(
          `INSERT INTO sessions (
            id, session_key, agent_id, channel, chat_kind, status,
            account_id, chat_id, user_id, memory_namespace,
            root_session_key, send_policy, metadata_json,
            context_input_tokens, context_output_tokens, context_total_tokens,
            message_count, last_activity_at, status_changed_at,
            owner_lease_epoch,
            created_at, updated_at
          ) VALUES (
            ?, ?, 'friday', ?, ?, 'active',
            ?, ?, ?, ?,
            ?, ?, ?,
            0, 0, 0,
            0, ?, ?,
            0,
            ?, ?
          )`,
        ).run(
          id, input.key, input.channel, chatKind,
          accountId, input.chatId, input.userId ?? null, input.memoryNamespace ?? null,
          input.key, input.sendPolicy ?? null, metadataJson,
          now, now,
          now, now,
        );
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          error.message.includes("UNIQUE constraint failed: sessions.session_key")
        ) {
          throw new FridayDomainError(
            FRIDAY_SESSION_ERROR_CODES.ALREADY_EXISTS,
            `Session already exists for key '${input.key}'`,
            { httpStatus: 409 },
          );
        }
        throw error;
      }

      const row = db.prepare(
        "SELECT * FROM sessions WHERE id = ?",
      ).get(id) as FridaySessionRow | undefined;

      if (!row) {
        throw new FridayDomainError(
          FRIDAY_SESSION_ERROR_CODES.NOT_FOUND,
          "Session insert failed — row not found after insert",
          { httpStatus: 500 },
        );
      }

      return rowToRecord(row);
    },

    getByKey(db, key) {
      const row = db.prepare(
        "SELECT * FROM sessions WHERE session_key = ?",
      ).get(key) as FridaySessionRow | undefined;

      return row ? rowToRecord(row) : null;
    },

    list(db, input) {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (input.channel) {
        conditions.push("channel = ?");
        params.push(input.channel);
      }
      if (input.accountId) {
        conditions.push("account_id = ?");
        params.push(input.accountId);
      }
      if (input.userId) {
        conditions.push("user_id = ?");
        params.push(input.userId);
      }
      if (input.status) {
        conditions.push("status = ?");
        params.push(input.status);
      }
      if (input.cursor) {
        conditions.push("created_at < ?");
        params.push(input.cursor);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = Math.min(input.limit ?? 50, 500);
      params.push(limit);

      const rows = db.prepare(
        `SELECT * FROM sessions ${where} ORDER BY created_at DESC LIMIT ?`,
      ).all(...params) as FridaySessionRow[];

      return rows.map(rowToRecord);
    },

    updateStatus(db, input) {
      let fromClause = "";
      const params: unknown[] = [];

      if (input.from && input.from.length > 0) {
        const placeholders = input.from.map(() => "?").join(", ");
        fromClause = `AND status IN (${placeholders})`;
        params.push(...input.from);
      }

      const timestampColumn = getTimestampColumnForStatus(input.to);

      const sql = `UPDATE sessions
        SET status = ?,
            status_changed_at = ?,
            updated_at = ?
            ${timestampColumn ? `, ${timestampColumn} = ?` : ""}
        WHERE session_key = ? ${fromClause}`;

      const updateParams: unknown[] = [input.to, input.nowIso, input.nowIso];
      if (timestampColumn) {
        updateParams.push(input.nowIso);
      }
      updateParams.push(input.key, ...params);

      const result = db.prepare(sql).run(...updateParams);

      if (result.changes === 0) {
        return null;
      }

      return this.getByKey(db, input.key);
    },

    touchActivity(db, input) {
      const tokenParts: string[] = [];
      const params: unknown[] = [input.nowIso, input.nowIso];

      if (input.tokenDelta) {
        tokenParts.push(
          "context_input_tokens = context_input_tokens + ?",
          "context_output_tokens = context_output_tokens + ?",
          "context_total_tokens = context_total_tokens + ?",
        );
        params.push(input.tokenDelta.input, input.tokenDelta.output, input.tokenDelta.total);
      }

      if (input.messageDelta !== undefined) {
        tokenParts.push("message_count = message_count + ?");
        params.push(input.messageDelta);
      }

      const extraSets = tokenParts.length > 0 ? `, ${tokenParts.join(", ")}` : "";
      params.push(input.key);

      const result = db.prepare(
        `UPDATE sessions
         SET last_activity_at = ?, updated_at = ?${extraSets}
         WHERE session_key = ?`,
      ).run(...params);

      if (result.changes === 0) {
        return null;
      }

      return this.getByKey(db, input.key);
    },

    markIdleCandidates(db, input) {
      const result = db.prepare(
        `UPDATE sessions
         SET status = 'idle', idle_at = ?, status_changed_at = ?, updated_at = ?
         WHERE status = 'active'
           AND last_activity_at < ?`,
      ).run(input.nowIso, input.nowIso, input.nowIso, input.idleBeforeIso);

      return result.changes;
    },

    markArchivedCandidates(db, input) {
      const result = db.prepare(
        `UPDATE sessions
         SET status = 'archived', archived_at = ?, status_changed_at = ?, updated_at = ?
         WHERE status = 'idle'
           AND idle_at < ?`,
      ).run(input.nowIso, input.nowIso, input.nowIso, input.archiveBeforeIso);

      return result.changes;
    },

    markPrunedCandidates(db, input) {
      const rows = db.prepare(
        `SELECT session_key FROM sessions
         WHERE status = 'archived'
           AND archived_at < ?`,
      ).all(input.olderThanIso) as Array<{ session_key: string }>;

      const keys = rows.map((r) => r.session_key);

      if (keys.length > 0) {
        db.prepare(
          `UPDATE sessions
           SET status = 'pruned', pruned_at = ?, status_changed_at = ?, updated_at = ?
           WHERE status = 'archived'
             AND archived_at < ?`,
        ).run(input.nowIso, input.nowIso, input.nowIso, input.olderThanIso);
      }

      return keys;
    },

    hardDeletePruned(db, input) {
      const result = db.prepare(
        `DELETE FROM sessions
         WHERE status = 'pruned'
           AND pruned_at < ?`,
      ).run(input.hardDeleteBeforeIso);

      return result.changes;
    },

    listByParentSessionKey(db, input) {
      const conditions: string[] = ["parent_session_key = ?"];
      const params: unknown[] = [input.parentSessionKey];

      if (input.statuses && input.statuses.length > 0) {
        const placeholders = input.statuses.map(() => "?").join(", ");
        conditions.push(`status IN (${placeholders})`);
        params.push(...input.statuses);
      }

      const limit = Math.min(input.limit ?? 50, 500);
      params.push(limit);

      const rows = db.prepare(
        `SELECT * FROM sessions
         WHERE ${conditions.join(" AND ")}
         ORDER BY last_activity_at DESC
         LIMIT ?`,
      ).all(...params) as FridaySessionRow[];

      return rows.map(rowToRecord);
    },

    setForkLineage(db, input) {
      const updates: string[] = [
        "parent_session_key = ?",
        "root_session_key = ?",
      ];
      const params: unknown[] = [
        input.parentSessionKey,
        input.rootSessionKey,
      ];

      if (input.forkedFromMessageId !== undefined) {
        updates.push("forked_from_message_id = ?");
        params.push(input.forkedFromMessageId);
      }

      if (input.memoryNamespace !== undefined) {
        updates.push("memory_namespace = ?");
        params.push(input.memoryNamespace);
      }

      params.push(input.key);

      db.prepare(
        `UPDATE sessions SET ${updates.join(", ")} WHERE session_key = ?`,
      ).run(...params);
    },

    markForkArchivedCandidates(db, input) {
      const result = db.prepare(
        `UPDATE sessions
         SET status = 'archived', archived_at = ?, status_changed_at = ?, updated_at = ?
         WHERE parent_session_key IS NOT NULL
           AND status IN ('active', 'idle')
           AND last_activity_at < ?`,
      ).run(input.nowIso, input.nowIso, input.nowIso, input.forkTimeoutBeforeIso);

      return result.changes;
    },

    updateSendPolicy(db, input) {
      const result = db.prepare(
        `UPDATE sessions SET send_policy = ?, updated_at = ? WHERE session_key = ?`,
      ).run(input.sendPolicy, input.nowIso, input.key);

      if (result.changes === 0) {
        return null;
      }

      return this.getByKey(db, input.key);
    },

    updateMetadata(db, input) {
      const result = db.prepare(
        `UPDATE sessions SET metadata_json = ?, updated_at = ? WHERE session_key = ?`,
      ).run(JSON.stringify(input.metadata), input.nowIso, input.key);

      if (result.changes === 0) {
        return null;
      }

      return this.getByKey(db, input.key);
    },
  };
}

// ─── Helpers ───

function getTimestampColumnForStatus(status: FridaySessionStatus): string | null {
  switch (status) {
    case "idle":
      return "idle_at";
    case "archived":
      return "archived_at";
    case "pruned":
      return "pruned_at";
    default:
      return null;
  }
}

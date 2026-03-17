import type Database from "better-sqlite3";

import { FridayDomainError } from "#errors";

import { FRIDAY_SESSION_ERROR_CODES } from "../friday-session.constants.js";
import type {
  FridaySessionMessageRecord,
  FridaySessionRole,
} from "../model/friday-session.types.js";

// ─── Row shape from SQLite ───

interface FridaySessionMessageRow {
  id: string;
  session_id: string;
  session_key: string | null;
  sequence: number;
  role: string;
  content_json: string;
  content_text: string | null;
  tool_calls_json: string | null;
  token_count: number;
  idempotency_key: string | null;
  parent_message_id: string | null;
  metadata_json: string | null;
  memory_extract_status: string;
  memory_extracted_at: string | null;
  occurred_at: string | null;
  created_at: string;
  updated_at: string;
  is_inherited: number;
  inherited_from_session_key: string | null;
  inherited_from_message_id: string | null;
}

function rowToRecord(row: FridaySessionMessageRow): FridaySessionMessageRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    sessionKey: row.session_key ?? "",
    sequence: row.sequence,
    role: row.role as FridaySessionRole,
    content: JSON.parse(row.content_json) as unknown,
    contentText: row.content_text ?? "",
    toolCalls: row.tool_calls_json ? JSON.parse(row.tool_calls_json) as unknown[] : undefined,
    tokenCount: row.token_count,
    idempotencyKey: row.idempotency_key ?? undefined,
    parentMessageId: row.parent_message_id ?? undefined,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, unknown> : {},
    memoryExtractStatus: row.memory_extract_status as FridaySessionMessageRecord["memoryExtractStatus"],
    memoryExtractedAt: row.memory_extracted_at ?? undefined,
    occurredAt: row.occurred_at ?? row.created_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    inherited: row.is_inherited === 1 ? true : undefined,
    inheritedFromSessionKey: row.inherited_from_session_key ?? undefined,
    inheritedFromMessageId: row.inherited_from_message_id ?? undefined,
  };
}

// ─── Repository interface ───

export interface FridaySessionMessageAppendInput {
  sessionId: string;
  sessionKey: string;
  role: FridaySessionRole;
  contentJson: string;
  contentText: string;
  toolCallsJson?: string;
  tokenCount: number;
  idempotencyKey?: string;
  parentMessageId?: string;
  metadataJson: string;
  occurredAt: string;
  nowIso: string;
  idGenerator: () => string;
  isInherited?: boolean;
  inheritedFromSessionKey?: string;
  inheritedFromMessageId?: string;
  memoryExtractStatus?: "pending" | "extracted" | "skipped" | "failed";
}

export interface FridaySessionMessageAppendResult {
  record: FridaySessionMessageRecord;
  isNew: boolean;
}

export interface FridaySessionMessageRepository {
  append(db: Database.Database, input: FridaySessionMessageAppendInput): FridaySessionMessageAppendResult;

  findByIdempotency(
    db: Database.Database,
    input: { sessionKey: string; idempotencyKey: string },
  ): FridaySessionMessageRecord | null;

  listBySessionKey(
    db: Database.Database,
    input: { sessionKey: string; limit: number; before?: string },
  ): FridaySessionMessageRecord[];

  getBySessionAndId(
    db: Database.Database,
    input: { sessionKey: string; messageId: string },
  ): FridaySessionMessageRecord | null;

  updateMetadataByIdempotency(
    db: Database.Database,
    input: {
      sessionKey: string;
      idempotencyKey: string;
      metadataPatch: Record<string, unknown>;
      nowIso: string;
    },
  ): FridaySessionMessageRecord | null;

  listForkContextWindow(
    db: Database.Database,
    input: { sessionKey: string; limit: number; maxSequence?: number },
  ): FridaySessionMessageRecord[];
}

// ─── Factory ───

export function createFridaySessionMessageRepository(): FridaySessionMessageRepository {
  return {
    append(db, input) {
      // Check idempotency first
      if (input.idempotencyKey) {
        const existing = this.findByIdempotency(db, {
          sessionKey: input.sessionKey,
          idempotencyKey: input.idempotencyKey,
        });
        if (existing) {
          return { record: existing, isNew: false };
        }
      }

      const id = input.idGenerator();

      // Get next sequence number
      const seqRow = db.prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM session_messages WHERE session_id = ?",
      ).get(input.sessionId) as { next_seq: number };

      const sequence = seqRow.next_seq;

      const extractStatus = input.memoryExtractStatus ?? "pending";

      db.prepare(
        `INSERT INTO session_messages (
          id, session_id, session_key, sequence, role,
          content_json, content_text, tool_calls_json,
          token_count, idempotency_key, parent_message_id,
          metadata_json, memory_extract_status, occurred_at,
          is_inherited, inherited_from_session_key, inherited_from_message_id,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?
        )`,
      ).run(
        id, input.sessionId, input.sessionKey, sequence, input.role,
        input.contentJson, input.contentText, input.toolCallsJson ?? null,
        input.tokenCount, input.idempotencyKey ?? null, input.parentMessageId ?? null,
        input.metadataJson, extractStatus, input.occurredAt,
        input.isInherited ? 1 : 0, input.inheritedFromSessionKey ?? null, input.inheritedFromMessageId ?? null,
        input.nowIso, input.nowIso,
      );

      const row = db.prepare(
        "SELECT * FROM session_messages WHERE id = ?",
      ).get(id) as FridaySessionMessageRow | undefined;

      if (!row) {
        throw new FridayDomainError(
          FRIDAY_SESSION_ERROR_CODES.MESSAGE_VALIDATION_ERROR,
          "Message insert failed — row not found after insert",
          { httpStatus: 500 },
        );
      }

      return { record: rowToRecord(row), isNew: true };
    },

    findByIdempotency(db, input) {
      const row = db.prepare(
        "SELECT * FROM session_messages WHERE session_key = ? AND idempotency_key = ?",
      ).get(input.sessionKey, input.idempotencyKey) as FridaySessionMessageRow | undefined;

      return row ? rowToRecord(row) : null;
    },

    listBySessionKey(db, input) {
      const conditions = ["session_key = ?"];
      const params: unknown[] = [input.sessionKey];

      if (input.before) {
        conditions.push("occurred_at < ?");
        params.push(input.before);
      }

      params.push(input.limit);

      const rows = db.prepare(
        `SELECT * FROM session_messages
         WHERE ${conditions.join(" AND ")}
         ORDER BY sequence DESC
         LIMIT ?`,
      ).all(...params) as FridaySessionMessageRow[];

      // Reverse to return in chronological order
      return rows.reverse().map(rowToRecord);
    },

    getBySessionAndId(db, input) {
      const row = db.prepare(
        "SELECT * FROM session_messages WHERE session_key = ? AND id = ?",
      ).get(input.sessionKey, input.messageId) as FridaySessionMessageRow | undefined;

      return row ? rowToRecord(row) : null;
    },

    updateMetadataByIdempotency(db, input) {
      const existing = this.findByIdempotency(db, {
        sessionKey: input.sessionKey,
        idempotencyKey: input.idempotencyKey,
      });
      if (!existing) {
        return null;
      }

      const mergedMetadata = {
        ...(existing.metadata ?? {}),
        ...input.metadataPatch,
      };

      db.prepare(
        "UPDATE session_messages SET metadata_json = ?, updated_at = ? WHERE id = ?",
      ).run(
        JSON.stringify(mergedMetadata),
        input.nowIso,
        existing.id,
      );

      const row = db.prepare(
        "SELECT * FROM session_messages WHERE id = ?",
      ).get(existing.id) as FridaySessionMessageRow | undefined;

      return row ? rowToRecord(row) : null;
    },

    listForkContextWindow(db, input) {
      const conditions = ["session_key = ?", "is_inherited = 0"];
      const params: unknown[] = [input.sessionKey];

      if (input.maxSequence !== undefined) {
        conditions.push("sequence <= ?");
        params.push(input.maxSequence);
      }

      params.push(input.limit);

      const rows = db.prepare(
        `SELECT * FROM session_messages
         WHERE ${conditions.join(" AND ")}
         ORDER BY sequence DESC
         LIMIT ?`,
      ).all(...params) as FridaySessionMessageRow[];

      // Reverse to return in chronological order
      return rows.reverse().map(rowToRecord);
    },
  };
}

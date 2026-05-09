import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";
import type {
  FridayContextCompactionBlockSummary,
  FridayContextCompactionSummary,
} from "../../providers/model/friday-provider-context.types.js";

export type FridayAgentContextReplayKind = "compaction_summary";
export type FridayAgentContextReplayTrustLevel = "unconfirmed_summary";

export interface FridayAgentContextReplayRecord {
  entryId: string;
  sessionKey: string;
  runId: string;
  kind: FridayAgentContextReplayKind;
  trustLevel: FridayAgentContextReplayTrustLevel;
  source: string;
  summary: FridayContextCompactionSummary;
  blocks: FridayContextCompactionBlockSummary[];
  metadata: Record<string, unknown>;
  compactedAt: string;
  createdAt: string;
}

interface FridayAgentContextReplayRow {
  entry_id: string;
  session_key: string;
  run_id: string;
  kind: string;
  trust_level: string;
  source: string;
  summary_json: string;
  blocks_json: string;
  metadata_json: string;
  compacted_at: string;
  created_at: string;
}

function emptySummary(): FridayContextCompactionSummary {
  return {
    summaryText: "",
    decisions: [],
    todos: [],
    openQuestions: [],
    toolFailures: [],
    fileOperations: [],
  };
}

function rowToRecord(row: FridayAgentContextReplayRow): FridayAgentContextReplayRecord {
  return {
    entryId: row.entry_id,
    sessionKey: row.session_key,
    runId: row.run_id,
    kind: row.kind as FridayAgentContextReplayKind,
    trustLevel: row.trust_level as FridayAgentContextReplayTrustLevel,
    source: row.source,
    summary: safeJsonParse<FridayContextCompactionSummary>(row.summary_json) ?? emptySummary(),
    blocks: safeJsonParse<FridayContextCompactionBlockSummary[]>(row.blocks_json) ?? [],
    metadata: safeJsonParse<Record<string, unknown>>(row.metadata_json) ?? {},
    compactedAt: row.compacted_at,
    createdAt: row.created_at,
  };
}

export interface FridayAgentContextReplayRepository {
  appendCompactionSummary(
    db: Database.Database,
    input: {
      entryId: string;
      sessionKey: string;
      runId: string;
      summary: FridayContextCompactionSummary;
      blocks?: FridayContextCompactionBlockSummary[];
      metadata?: Record<string, unknown>;
      compactedAt: string;
      createdAt: string;
    },
  ): FridayAgentContextReplayRecord;

  listCompactionSummariesBySession(
    db: Database.Database,
    input: {
      sessionKey: string;
      limit?: number;
    },
  ): FridayAgentContextReplayRecord[];
}

export function createFridayAgentContextReplayRepository(): FridayAgentContextReplayRepository {
  return {
    appendCompactionSummary(db, input) {
      db.prepare(
        `INSERT INTO friday_agent_context_replay_entries (
           entry_id,
           session_key,
           run_id,
           kind,
           trust_level,
           source,
           summary_json,
           blocks_json,
           metadata_json,
           compacted_at,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.entryId,
        input.sessionKey,
        input.runId,
        "compaction_summary",
        "unconfirmed_summary",
        "context_replay",
        JSON.stringify(input.summary),
        JSON.stringify(input.blocks ?? []),
        JSON.stringify(input.metadata ?? {}),
        input.compactedAt,
        input.createdAt,
      );

      const row = db.prepare(
        `SELECT *
           FROM friday_agent_context_replay_entries
          WHERE entry_id = ?`,
      ).get(input.entryId) as FridayAgentContextReplayRow;
      return rowToRecord(row);
    },

    listCompactionSummariesBySession(db, input) {
      const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 40), 100));
      const rows = db.prepare(
        `SELECT *
           FROM friday_agent_context_replay_entries
          WHERE session_key = ?
            AND kind = 'compaction_summary'
          ORDER BY compacted_at DESC, created_at DESC
          LIMIT ?`,
      ).all(input.sessionKey, limit) as FridayAgentContextReplayRow[];
      return rows.map(rowToRecord);
    },
  };
}

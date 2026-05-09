/**
 * Compaction Context Loader: retrieves persisted context replay summaries for
 * the current session and formats them into an explicit prompt fragment.
 *
 * This is the readback half of the compaction loop: summaries written to
 * context replay can re-enter subsequent runs without piggybacking on durable
 * memory or learned-preference injection.
 */

import type { FridaySqliteLayer } from "#state";
import {
  createFridayAgentContextReplayRepository,
  type FridayAgentContextReplayRepository,
} from "../persistence/friday-agent-context-replay-repository.js";
import { formatCompactionContextForPrompt, groupCompactionContextReplayRecords } from "./friday-agent-compaction-context-formatter.js";

export interface FridayCompactionContextLoadResult {
  fragment: string;
  blockCount: number;
  sources: string[];
  sessionKey?: string;
  evidenceTier?: "audit_replay_evidence";
  trustLevel?: "unconfirmed_summary";
  source?: "context_replay";
  memoryBoundary?: "not_user_confirmed_memory";
  redactionApplied?: boolean;
  redactionCount?: number;
  replayEntryIds?: string[];
}

export interface FridayCompactionContextLoader {
  loadContext(input: { sessionKey?: string }): Promise<FridayCompactionContextLoadResult>;
}

export interface CreateFridayCompactionContextLoaderDeps {
  db: FridaySqliteLayer;
  repository?: FridayAgentContextReplayRepository;
}

export function createFridayCompactionContextLoader(
  deps: CreateFridayCompactionContextLoaderDeps,
): FridayCompactionContextLoader {
  const repository = deps.repository ?? createFridayAgentContextReplayRepository();

  return {
    async loadContext(input) {
      const sessionKey = input.sessionKey?.trim();
      if (!sessionKey) {
        return { fragment: "", blockCount: 0, sources: [] };
      }

      const records = deps.db.withReadConnection((db) =>
        repository.listCompactionSummariesBySession(db, { sessionKey, limit: 40 }));
      const blocks = groupCompactionContextReplayRecords(records);
      const fragment = formatCompactionContextForPrompt(blocks);
      const redactionCount = records.reduce((sum, record) => {
        const value = record.metadata.redactionCount;
        return sum + (typeof value === "number" && Number.isFinite(value) ? value : 0);
      }, 0);
      const redactionApplied = records.some((record) => record.metadata.redactionApplied === true) || redactionCount > 0;

      return {
        fragment,
        blockCount: blocks.length,
        sources: records.map((record) => `context_replay:${record.entryId}`),
        sessionKey,
        evidenceTier: "audit_replay_evidence",
        trustLevel: "unconfirmed_summary",
        source: "context_replay",
        memoryBoundary: "not_user_confirmed_memory",
        redactionApplied,
        redactionCount,
        replayEntryIds: records.map((record) => record.entryId),
      };
    },
  };
}

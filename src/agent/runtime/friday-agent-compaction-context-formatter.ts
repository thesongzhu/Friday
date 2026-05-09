/**
 * Compaction Context Formatter: formats persisted compaction summaries from
 * context replay into a prompt fragment for injection into a new session's
 * system prompt.
 *
 * These summaries are unconfirmed replay evidence, not user-confirmed memory.
 */

import type { FridayAgentContextReplayRecord } from "../persistence/friday-agent-context-replay-repository.js";

// ─── Types ───

export interface FridayCompactionContextBlock {
  entryId: string;
  sessionKey: string;
  runId: string;
  compactedAt: string;
  trustLevel: "unconfirmed_summary";
  source: "context_replay";
  summaryText: string;
  decisions: string[];
  todos: string[];
  openQuestions: string[];
  toolFailures: string[];
  fileOperations: string[];
}

// ─── Constants ───

/** Maximum number of compaction blocks to include in the prompt. */
const DEFAULT_MAX_BLOCKS = 3;

/** Maximum characters for the entire compaction context fragment. */
const DEFAULT_MAX_CHARS = 4_000;

// ─── Formatter ───

/**
 * Convert context replay records into structured blocks.
 */
export function groupCompactionContextReplayRecords(
  records: readonly FridayAgentContextReplayRecord[],
): FridayCompactionContextBlock[] {
  return [...records]
    .sort((a, b) => b.compactedAt.localeCompare(a.compactedAt) || b.createdAt.localeCompare(a.createdAt))
    .map((record) => ({
      entryId: record.entryId,
      sessionKey: record.sessionKey,
      runId: record.runId,
      compactedAt: record.compactedAt,
      trustLevel: record.trustLevel,
      source: "context_replay",
      summaryText: record.summary.summaryText,
      decisions: record.summary.decisions,
      todos: record.summary.todos,
      openQuestions: record.summary.openQuestions,
      toolFailures: record.summary.toolFailures,
      fileOperations: record.summary.fileOperations,
    }));
}

/**
 * Format compaction context blocks into a prompt fragment for injection
 * into the system prompt.
 */
export function formatCompactionContextForPrompt(
  blocks: readonly FridayCompactionContextBlock[],
  options?: { maxBlocks?: number; maxChars?: number },
): string {
  const maxBlocks = options?.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;

  const selected = blocks.slice(0, maxBlocks);
  if (selected.length === 0) return "";

  const parts: string[] = [];

  for (const block of selected) {
    const header = block.compactedAt
      ? `[Unconfirmed Context Replay — ${block.compactedAt}]`
      : "[Unconfirmed Context Replay]";
    const sectionParts: string[] = [
      header,
      "Boundary: this is a compressed prior-session summary, not user-confirmed memory. Verify before high-risk or mutating action.",
    ];

    if (block.summaryText) {
      sectionParts.push(`Summary: ${block.summaryText}`);
    }
    if (block.decisions.length > 0) {
      sectionParts.push(`Decisions: ${block.decisions.join("; ")}`);
    }
    if (block.todos.length > 0) {
      sectionParts.push(`TODOs: ${block.todos.join("; ")}`);
    }
    if (block.openQuestions.length > 0) {
      sectionParts.push(`Open questions: ${block.openQuestions.join("; ")}`);
    }
    if (block.toolFailures.length > 0) {
      sectionParts.push(`Tool failures: ${block.toolFailures.join("; ")}`);
    }
    if (block.fileOperations.length > 0) {
      sectionParts.push(`Files touched: ${block.fileOperations.join(", ")}`);
    }

    parts.push(sectionParts.join("\n"));
  }

  let result = parts.join("\n\n");
  if (result.length > maxChars) {
    result = `${result.slice(0, maxChars - 3)}...`;
  }
  return result;
}

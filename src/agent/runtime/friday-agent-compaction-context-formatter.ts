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
 * Select the prompt header and boundary text for a context-replay block based
 * on its persisted `trustLevel`. This makes `block.trustLevel` a load-bearing
 * input to the prompt-text path rather than only a telemetry tag, so the
 * structured marker the loader writes is actually consumed on the read side.
 *
 * Drift policy:
 *  - Compile-time drift must fail. If a future change adds a value to the
 *    `trustLevel` union without updating this switch, the `_exhaustive: never`
 *    assignment below stops compilation.
 *  - Runtime-invalid persisted data must NOT crash the run. If schema drift
 *    or a forward/back-compat mismatch ever surfaces a value outside the
 *    declared union at runtime, fall back to the unconfirmed replay
 *    boundary — that is the safest text the model can receive.
 */
function selectHeaderAndBoundary(
  trustLevel: FridayCompactionContextBlock["trustLevel"],
  compactedAt: string,
): { header: string; boundary: string } {
  const unconfirmedHeader = compactedAt
    ? `[Unconfirmed Context Replay — ${compactedAt}]`
    : "[Unconfirmed Context Replay]";
  const unconfirmedBoundary =
    "Boundary: this is a compressed prior-session summary, not user-confirmed memory. Verify before high-risk or mutating action.";

  switch (trustLevel) {
    case "unconfirmed_summary":
      return { header: unconfirmedHeader, boundary: unconfirmedBoundary };
  }

  // Compile-time exhaustive check: TypeScript narrows `trustLevel` to `never`
  // here only when every union value is handled above. Adding a new value
  // without a case branch breaks compilation and forces the reviewer to
  // decide the new branch's prompt text explicitly.
  const _exhaustive: never = trustLevel;
  void _exhaustive;

  // Runtime fail-closed fallback: persisted data may have a value outside the
  // declared union (schema drift). Emit the unconfirmed boundary rather than
  // throw, so the run continues with the safest possible warning to the model.
  return { header: unconfirmedHeader, boundary: unconfirmedBoundary };
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
    const { header, boundary } = selectHeaderAndBoundary(block.trustLevel, block.compactedAt);
    const sectionParts: string[] = [header, boundary];

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

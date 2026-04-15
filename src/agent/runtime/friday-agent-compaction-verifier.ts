/**
 * Compaction Verifier: validates that LLM-generated summaries accurately
 * reflect the source messages by checking entity recall.
 *
 * If verification fails, the caller should fall back to template-based
 * extraction (the `summarizeBlock()` function in the provider compactor).
 */

import type {
  FridayContextCompactionSummary,
  FridayProviderContextMessage,
} from "../../providers/model/friday-provider-context.types.js";

// ─── Result type ───

export interface FridayCompactionVerificationResult {
  /** Whether the summary passed all verification checks. */
  valid: boolean;
  /** Ratio of source entities found in the summary (0.0–1.0). */
  entityRecall: number;
  /** Entities present in source but missing from summary. */
  missingEntities: string[];
  /** Summary text length (for sanity checking). */
  summaryLength: number;
  /** Whether the summary has at least one non-empty structured field. */
  hasStructuredContent: boolean;
}

// ─── Verifier ───

const FILE_PATH_PATTERN = /(?:^|\s)(?:\.{0,2}\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?:\.[A-Za-z0-9._-]+)?/g;
const TOOL_NAME_PATTERN = /\b(?:exec|browser|web_(?:fetch|search)|read|write|append|memory_(?:store|search|list|delete)|desktop|canvas|skill_(?:generator|import|run)|subagent|cron|workflow)\b/gi;
const ERROR_CODE_PATTERN = /\b(?:ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT|ERR_\w+|E[A-Z]{3,})\b/g;

/**
 * Extract named entities from messages: file paths, tool names, error codes.
 */
function extractEntities(messages: readonly FridayProviderContextMessage[]): Set<string> {
  const entities = new Set<string>();
  for (const msg of messages) {
    const text = msg.content;

    // File paths
    const paths = text.match(FILE_PATH_PATTERN);
    if (paths) {
      for (const p of paths) {
        entities.add(p.trim().toLowerCase());
      }
    }

    // Tool names
    const tools = text.match(TOOL_NAME_PATTERN);
    if (tools) {
      for (const t of tools) {
        entities.add(t.toLowerCase());
      }
    }

    // Error codes
    const errors = text.match(ERROR_CODE_PATTERN);
    if (errors) {
      for (const e of errors) {
        entities.add(e.toLowerCase());
      }
    }

    // Tool name from metadata
    if (msg.toolName) {
      entities.add(msg.toolName.toLowerCase());
    }
  }
  return entities;
}

/**
 * Check how many source entities appear in the summary text.
 */
function computeEntityRecall(
  sourceEntities: ReadonlySet<string>,
  summaryText: string,
): { recall: number; missing: string[] } {
  if (sourceEntities.size === 0) {
    return { recall: 1.0, missing: [] };
  }

  const lowerSummary = summaryText.toLowerCase();
  const missing: string[] = [];
  let found = 0;

  for (const entity of sourceEntities) {
    if (lowerSummary.includes(entity)) {
      found++;
    } else {
      missing.push(entity);
    }
  }

  return {
    recall: found / sourceEntities.size,
    missing,
  };
}

/**
 * Verify that a compaction summary accurately reflects the source messages.
 *
 * @param params.originalMessages - Messages that were summarized
 * @param params.summary - The generated summary to verify
 * @param params.minEntityRecall - Minimum entity recall threshold (default 0.6)
 * @returns Verification result with recall score and missing entities
 */
export function verifyCompactionSummary(params: {
  originalMessages: readonly FridayProviderContextMessage[];
  summary: FridayContextCompactionSummary;
  minEntityRecall?: number;
}): FridayCompactionVerificationResult {
  const { originalMessages, summary, minEntityRecall = 0.6 } = params;

  // Combine all summary fields into one searchable string
  const allSummaryText = [
    summary.summaryText,
    ...summary.decisions,
    ...summary.todos,
    ...summary.openQuestions,
    ...summary.toolFailures,
    ...summary.fileOperations,
  ].join("\n");

  const summaryLength = allSummaryText.length;

  // Check structural completeness
  const hasStructuredContent =
    summary.decisions.length > 0 ||
    summary.todos.length > 0 ||
    summary.openQuestions.length > 0 ||
    summary.toolFailures.length > 0 ||
    summary.fileOperations.length > 0 ||
    summary.summaryText.length > 0;

  // Extract and check entities
  const sourceEntities = extractEntities(originalMessages);
  const { recall, missing } = computeEntityRecall(sourceEntities, allSummaryText);

  // A summary is valid if:
  // 1. Entity recall meets threshold (or source had no extractable entities)
  // 2. Summary has at least some structured content
  const valid = recall >= minEntityRecall && hasStructuredContent;

  return {
    valid,
    entityRecall: recall,
    missingEntities: missing.slice(0, 10), // Limit for readability
    summaryLength,
    hasStructuredContent,
  };
}

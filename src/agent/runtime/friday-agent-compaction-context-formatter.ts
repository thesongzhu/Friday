/**
 * Compaction Context Formatter: formats persisted compaction summaries from
 * memory into a prompt fragment for injection into a new session's system
 * prompt via the workspace context loader.
 *
 * This enables cross-session continuity: decisions, TODOs, and context from
 * Session A are automatically available in Session B.
 */

import type { FridayMemoryItem } from "../../memory/model/friday-memory.types.js";

// ─── Types ───

export interface FridayCompactionContextBlock {
  sessionKey: string;
  compactedAt: string;
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
 * Convert raw memory items from `compaction.*` namespaces into structured
 * blocks grouped by session/run.
 */
export function groupCompactionMemoryItems(
  items: readonly FridayMemoryItem[],
): FridayCompactionContextBlock[] {
  // Group items by their source (which encodes sessionKey + runId)
  const bySource = new Map<string, FridayMemoryItem[]>();
  for (const item of items) {
    const source = item.source ?? "unknown";
    const existing = bySource.get(source);
    if (existing) {
      existing.push(item);
    } else {
      bySource.set(source, [item]);
    }
  }

  const blocks: FridayCompactionContextBlock[] = [];
  for (const [source, groupItems] of bySource) {
    // Parse source format: "compaction:{sessionKey}:{runId}"
    const parts = source.split(":");
    const sessionKey = parts.length >= 2 ? parts[1] : "unknown";
    const compactedAt = groupItems[0]?.metadata?.compactedAt as string | undefined ?? "";

    const block: FridayCompactionContextBlock = {
      sessionKey,
      compactedAt,
      summaryText: "",
      decisions: [],
      todos: [],
      openQuestions: [],
      toolFailures: [],
      fileOperations: [],
    };

    for (const item of groupItems) {
      const ns = item.namespace ?? "";
      const lines = (item.content ?? "").split("\n").filter((l: string) => l.trim().length > 0);

      if (ns.endsWith(".decisions")) {
        block.decisions.push(...lines);
      } else if (ns.endsWith(".todos")) {
        block.todos.push(...lines);
      } else if (ns.endsWith(".questions")) {
        block.openQuestions.push(...lines);
      } else if (ns.endsWith(".failures")) {
        block.toolFailures.push(...lines);
      } else if (ns.endsWith(".files")) {
        block.fileOperations.push(...lines);
      } else if (ns.endsWith(".summary")) {
        block.summaryText = lines.join(" ");
      }
    }

    blocks.push(block);
  }

  // Sort by compactedAt descending (most recent first)
  blocks.sort((a, b) => b.compactedAt.localeCompare(a.compactedAt));
  return blocks;
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
      ? `[Previous Session Context — ${block.compactedAt}]`
      : "[Previous Session Context]";
    const sectionParts: string[] = [header];

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

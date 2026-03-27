import type { FridayAgentToolResult } from "../model/friday-agent.types.js";

// ─── Summary types ───

export type FridayToolCallOutputShape = "text" | "json" | "error" | "empty";
export type FridayToolCallCategory =
  | "read"
  | "write"
  | "query"
  | "mutate"
  | "navigate"
  | "other";

export interface FridayToolCallSummary {
  toolName: string;
  /** Top-level keys from tool args (no values — avoids leaking sensitive data). */
  argKeys: string[];
  resultIsError: boolean;
  resultLengthChars: number;
  outputShape: FridayToolCallOutputShape;
  toolCategory: FridayToolCallCategory;
  turnIndex: number;
  toolIndex: number;
}

// ─── Category classification ───

const READ_TOOLS = new Set(["read", "glob", "grep", "web_fetch", "web_search", "skills_list"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const QUERY_TOOLS = new Set(["system", "todo_read"]);
const NAVIGATE_TOOLS = new Set(["browser", "canvas", "desktop"]);
const MUTATE_TOOLS = new Set(["exec", "shell", "skill_run", "workflow_run", "todo_write"]);

function classifyToolCategory(toolName: string): FridayToolCallCategory {
  if (READ_TOOLS.has(toolName)) return "read";
  if (WRITE_TOOLS.has(toolName)) return "write";
  if (QUERY_TOOLS.has(toolName)) return "query";
  if (NAVIGATE_TOOLS.has(toolName)) return "navigate";
  if (MUTATE_TOOLS.has(toolName)) return "mutate";
  return "other";
}

// ─── Output shape detection ───

function detectOutputShape(result: FridayAgentToolResult): FridayToolCallOutputShape {
  if (result.isError) return "error";
  const content = result.content;
  if (!content || content.trim().length === 0) return "empty";
  const trimmed = content.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return "json";
  }
  return "text";
}

// ─── Public API ───

/**
 * Produces a lightweight, privacy-safe summary of a tool call.
 * Pure function — no I/O, no side effects, < 0.1ms.
 */
export function summarizeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  result: FridayAgentToolResult,
  turnIndex: number,
  toolIndex: number,
): FridayToolCallSummary {
  return {
    toolName,
    argKeys: Object.keys(args),
    resultIsError: result.isError ?? false,
    resultLengthChars: result.content.length,
    outputShape: detectOutputShape(result),
    toolCategory: classifyToolCategory(toolName),
    turnIndex,
    toolIndex,
  };
}

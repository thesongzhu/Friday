/**
 * Tool Batch Executor — Initiative B.1
 *
 * When the LLM returns multiple tool_use blocks in a single turn,
 * this module classifies dependencies between them and executes
 * independent tools in parallel via Promise.allSettled().
 *
 * Dependency rules:
 * - Two tools touching the same file path → sequential
 * - A mutating tool after a read on the same path → sequential
 * - All other combinations → parallel
 *
 * This is purely additive — the existing sequential loop remains
 * the default. The batch executor is an opt-in enhancement.
 */

import { normalize } from "node:path";

import { isMutatingToolCall } from "./friday-agent-tool-mutation.js";

// ─── Types ───

export interface FridayToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface FridayToolCallResult {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: {
    content: string;
    isError?: boolean;
    metadata?: Record<string, unknown>;
  };
  durationMs: number;
  startedAt: string;
}

export type ToolCallExecutor = (toolUse: FridayToolUseBlock) => Promise<FridayToolCallResult>;

/** A group of tools that can execute in parallel. */
export interface FridayToolBatchGroup {
  /** Tools in this group are independent of each other. */
  tools: FridayToolUseBlock[];
}

function redactCanonicalApprovalForBatchRecord(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  const approval = value as {
    decision?: unknown;
    approvalId?: unknown;
    actionDigest?: unknown;
    issuer?: unknown;
  };
  return {
    redacted: true,
    decision: approval.decision,
    approvalId: approval.approvalId,
    actionDigest: approval.actionDigest,
    issuer: approval.issuer,
  };
}

function redactToolArgsForBatchRecord(args: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(args, "canonicalApproval")) {
    return args;
  }

  return {
    ...args,
    canonicalApproval: redactCanonicalApprovalForBatchRecord(args.canonicalApproval),
  };
}

function redactToolCallResultForBatchRecord(result: FridayToolCallResult): FridayToolCallResult {
  return {
    ...result,
    args: redactToolArgsForBatchRecord(result.args),
  };
}

// ─── Path extraction ───

/**
 * Extract file paths referenced by a tool call.
 * Used to detect dependencies between tools.
 */
export function extractFilePaths(toolName: string, args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  // Direct file path parameters
  for (const key of ["path", "file_path", "filePath", "file", "target"]) {
    const val = args[key];
    if (typeof val === "string" && val.length > 0) {
      paths.push(val);
    }
  }
  // exec tool — working directory is a dependency
  if (toolName === "exec" && typeof args.cwd === "string") {
    paths.push(args.cwd);
  }
  return paths;
}

// ─── Conflict-key canonicalization ───

/**
 * Canonicalize a file path for use as a CONFLICT-DETECTION KEY only.
 *
 * Two same-turn mutating tools can target the SAME underlying file via
 * different path spellings (`/tmp/a.txt` vs `/tmp/./a.txt`, trailing slash,
 * `..` segments, and — on macOS — case variants). If the conflict graph keys
 * on the raw string, those spellings hash to distinct keys, the tools are
 * judged non-conflicting, and they run concurrently — corrupting the file
 * with a lost/interleaved write.
 *
 * This function collapses those spellings so equivalent paths share a key:
 * - `normalize(p)` folds `.`, `..`, and duplicate separators.
 * - a trailing separator is stripped (except a bare root) so `/d/` == `/d`.
 * - on darwin only, the key is lowercased because the filesystem is
 *   case-insensitive there; on Linux the FS is case-sensitive so distinct-case
 *   paths intentionally remain distinct.
 *
 * IMPORTANT: this affects ONLY the conflict key. The literal path passed to
 * the tool executor is never rewritten. Canonicalization can only make MORE
 * paths compare equal, so it can only ADD serialization — it never removes a
 * real conflict and never wrongly parallelizes two genuinely-different files.
 */
export function canonicalizeConflictKey(p: string): string {
  let key = normalize(p);
  // Strip a trailing separator (but keep a bare root like "/").
  if (key.length > 1 && (key.endsWith("/") || key.endsWith("\\"))) {
    key = key.slice(0, -1);
  }
  if (process.platform === "darwin") {
    key = key.toLowerCase();
  }
  return key;
}

// ─── Dependency classification ───

/**
 * Classify a batch of tool_use blocks into sequential groups.
 * Tools within a group can run in parallel; groups must run sequentially.
 *
 * Algorithm:
 * 1. For each tool, extract its file paths and mutation status.
 * 2. Walk the list in order. If a tool shares a path with any
 *    tool already in the current group AND at least one is mutating,
 *    start a new group.
 * 3. Otherwise, add to current group.
 */
export function classifyToolBatchDependencies(
  toolUses: FridayToolUseBlock[],
): FridayToolBatchGroup[] {
  if (toolUses.length <= 1) {
    return [{ tools: toolUses }];
  }

  const groups: FridayToolBatchGroup[] = [];
  let currentGroup: FridayToolUseBlock[] = [];
  /** Paths touched by tools in the current group, with mutation flag. */
  let groupPaths = new Map<string, boolean>(); // path → isMutating

  for (const toolUse of toolUses) {
    const paths = extractFilePaths(toolUse.name, toolUse.input);
    const isMutating = isMutatingToolCall(toolUse.name, toolUse.input);

    // Check for conflicts with current group
    let hasConflict = false;
    for (const p of paths) {
      const existingMutating = groupPaths.get(canonicalizeConflictKey(p));
      if (existingMutating !== undefined) {
        // Path overlap — conflict if either side is mutating
        if (existingMutating || isMutating) {
          hasConflict = true;
          break;
        }
      }
    }

    if (hasConflict && currentGroup.length > 0) {
      // Flush current group and start new one
      groups.push({ tools: currentGroup });
      currentGroup = [];
      groupPaths = new Map();
    }

    currentGroup.push(toolUse);
    for (const p of paths) {
      // Mark as mutating if this tool or a previous tool on same path is mutating.
      // Key on the canonicalized path so different spellings of the same file
      // (`./`, `..`, trailing slash, darwin case) share one conflict entry.
      const key = canonicalizeConflictKey(p);
      groupPaths.set(key, (groupPaths.get(key) ?? false) || isMutating);
    }
  }

  if (currentGroup.length > 0) {
    groups.push({ tools: currentGroup });
  }

  return groups;
}

// ─── Batch execution ───

/**
 * Execute a batch of tool groups. Tools within each group run in
 * parallel; groups run sequentially in order.
 *
 * Returns results in the same order as the original toolUses.
 */
export async function executeToolBatch(
  groups: FridayToolBatchGroup[],
  executor: ToolCallExecutor,
): Promise<FridayToolCallResult[]> {
  const results: FridayToolCallResult[] = [];

  for (const group of groups) {
    if (group.tools.length === 1) {
      // Single tool — no need for Promise.allSettled overhead
      const result = await executor(group.tools[0]!);
      results.push(redactToolCallResultForBatchRecord(result));
    } else {
      // Parallel execution within group
      const settled = await Promise.allSettled(
        group.tools.map((toolUse) => executor(toolUse)),
      );

      for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i]!;
        const toolUse = group.tools[i]!;
        if (outcome.status === "fulfilled") {
          results.push(redactToolCallResultForBatchRecord(outcome.value));
        } else {
          // Rejected — synthesize error result
          results.push({
            toolCallId: toolUse.id,
            toolName: toolUse.name,
            args: redactToolArgsForBatchRecord(toolUse.input),
            result: {
              content: `Tool execution failed: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
              isError: true,
            },
            durationMs: 0,
            startedAt: new Date().toISOString(),
          });
        }
      }
    }
  }

  return results;
}

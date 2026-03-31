// ─── Timeouts ───

/** Maximum duration for a full agent run (5 minutes). */
export const FRIDAY_AGENT_RUN_TIMEOUT_MS = 300_000;

/** Maximum duration for a single tool call (1 minute). */
export const FRIDAY_AGENT_TOOL_TIMEOUT_MS = 60_000;

/** Maximum duration for a shell command (30 seconds). */
export const FRIDAY_AGENT_EXEC_TIMEOUT_MS = 30_000;

// ─── Limits ───

/** Maximum retry attempts for self-fix loop (including initial run). */
export const FRIDAY_AGENT_MAX_ATTEMPTS = 3;

/** Maximum output size from exec tool (100 KB). */
export const FRIDAY_AGENT_EXEC_MAX_OUTPUT_BYTES = 100 * 1024;

/** Maximum file read size (50 KB). */
export const FRIDAY_AGENT_READ_MAX_BYTES = 50 * 1024;

/** Maximum web fetch response size (100 KB). */
export const FRIDAY_AGENT_WEB_FETCH_MAX_BYTES = 100 * 1024;

/** Maximum LLM loop iterations to prevent infinite loops. */
export const FRIDAY_AGENT_MAX_LOOP_ITERATIONS = 100;

/** Maximum total tool calls per run (across all loop iterations). */
export const FRIDAY_AGENT_MAX_TOOL_CALLS = 200;

/** OC-007: Maximum tool result content length in characters before truncation. */
export const FRIDAY_AGENT_TOOL_RESULT_MAX_CHARS = 50_000;

/** Per-tool-type result caps — override the global default for specific tools. */
export const FRIDAY_AGENT_TOOL_RESULT_CAPS: Record<string, number> = {
  exec: 10_000,
  web_fetch: 15_000,
  browser: 15_000,
  canvas: 15_000,
  web_search: 20_000,
  read: 50_000,
};

/** Context compaction: max messages before triggering layered retention. */
export const FRIDAY_AGENT_COMPACTION_THRESHOLD = 40;

/** Context compaction: number of recent messages to keep in full. */
export const FRIDAY_AGENT_COMPACTION_KEEP_RECENT = 8;

/** Active run statuses that should be failed on boot recovery. */
export const FRIDAY_AGENT_ACTIVE_STATUSES = [
  "pending",
  "planning",
  "executing",
  "testing",
  "fixing",
] as const;

// ─── Error codes ───

export const FRIDAY_AGENT_ERROR_CODES = {
  NOT_FOUND: "AGENT_RUN_NOT_FOUND",
  TIMEOUT: "AGENT_RUN_TIMEOUT",
  CANCELLED: "AGENT_RUN_CANCELLED",
  TOOL_ERROR: "AGENT_TOOL_ERROR",
  LLM_ERROR: "AGENT_LLM_ERROR",
  LOOP_LIMIT: "AGENT_LOOP_LIMIT",
  TOOL_CALL_LIMIT: "AGENT_TOOL_CALL_LIMIT",
  VALIDATION_ERROR: "AGENT_VALIDATION_ERROR",
  INTERRUPTED: "AGENT_RUN_INTERRUPTED",
  OUTPUT_CLOSURE_ERROR: "AGENT_OUTPUT_CLOSURE_ERROR",
} as const;

// ─── Session key prefix ───

export const FRIDAY_AGENT_SESSION_KEY_PREFIX = "agent:run:";

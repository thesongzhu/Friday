/** Maximum nesting depth for sub-agents. Depth 0 = top-level run. */
export const FRIDAY_SUBAGENT_MAX_DEPTH = 3;

/** Maximum concurrent sub-agents per parent run. */
export const FRIDAY_SUBAGENT_MAX_CONCURRENT = 5;

/** Default timeout for a sub-agent run (3 minutes). */
export const FRIDAY_SUBAGENT_DEFAULT_TIMEOUT_MS = 180_000;

/** Session key separator for sub-agent nesting. */
export const FRIDAY_SUBAGENT_SESSION_KEY_SEPARATOR = ":sub:";

export const FRIDAY_SUBAGENT_ERROR_CODES = {
  MAX_DEPTH_EXCEEDED: "SUBAGENT_MAX_DEPTH_EXCEEDED",
  MAX_CONCURRENT_EXCEEDED: "SUBAGENT_MAX_CONCURRENT_EXCEEDED",
  SPAWN_FAILED: "SUBAGENT_SPAWN_FAILED",
  NOT_FOUND: "SUBAGENT_NOT_FOUND",
} as const;

// ─── Operational mode system ───
//
// Defines the three core operational modes for Friday agent runs:
// - plan: read-only analysis and planning, no mutations
// - execute: full tool access (default behavior)
// - restricted: auto-set during degradation, read-only with reduced tools

export type FridayOperationalMode = "plan" | "execute" | "restricted";

export type FridayToolCategory =
  | "read"
  | "write"
  | "exec"
  | "network"
  | "skill"
  | "workflow"
  | "browser"
  | "system";

export interface FridayModeConfig {
  readOnly: boolean;
  enabledToolCategories: FridayToolCategory[];
  systemPromptSuffix: string;
}

export const FRIDAY_MODE_CONFIGS: Record<FridayOperationalMode, FridayModeConfig> = {
  plan: {
    readOnly: true,
    enabledToolCategories: ["read"],
    systemPromptSuffix:
      "You are in plan mode. Analyze and plan only — do not execute changes. " +
      "Submit your plan for user approval when ready.",
  },
  execute: {
    readOnly: false,
    enabledToolCategories: ["read", "write", "exec", "network", "skill", "workflow", "browser", "system"],
    systemPromptSuffix: "",
  },
  restricted: {
    readOnly: true,
    enabledToolCategories: ["read"],
    systemPromptSuffix:
      "The system is in restricted mode. Some tools are temporarily unavailable. " +
      "You can only provide analysis and suggestions.",
  },
};

// ─── Tool → category mapping ───

const TOOL_CATEGORY_MAP: Record<string, FridayToolCategory> = {
  // read
  read: "read",
  file_read: "read",
  file_list: "read",
  web_fetch: "read",
  web_search: "read",
  memory_search: "read",
  memory_query: "read",
  memory_get: "read",
  skills_list: "read",
  agents_list: "read",
  capabilities: "read",
  task_status: "read",
  image_analysis: "read",
  // write
  write: "write",
  edit: "write",
  file_write: "write",
  file_delete: "write",
  memory_store: "write",
  memory_extract: "write",
  // exec
  exec: "exec",
  // network
  message: "network",
  gateway: "network",
  mcp: "network",
  // skill
  skill_run: "skill",
  skill_generate: "skill",
  skill_import: "skill",
  // workflow
  workflow_run: "workflow",
  workflow_generate: "workflow",
  // browser
  browser: "browser",
  canvas: "browser",
  xhs: "browser",
  // system
  desktop: "system",
  system: "system",
  cron: "system",
  nodes: "system",
  tts: "system",
  provider: "system",
  sessions: "system",
  autonomous: "exec",
  setup: "system",
  setup_assistant: "system",
  feedback: "read",
  spawn_subagent: "system",
  get_subagent: "system",
  list_subagents: "system",
};

/**
 * Resolve the tool category for a given tool name.
 * Unknown tools default to "system" (most restrictive).
 */
export function resolveToolCategory(toolName: string): FridayToolCategory {
  return TOOL_CATEGORY_MAP[toolName] ?? "system";
}

/**
 * Filter tools by operational mode, keeping only those whose category
 * is allowed by the mode config.
 */
export function filterToolsByMode<T extends { name: string }>(
  tools: T[],
  mode: FridayOperationalMode,
): T[] {
  const config = FRIDAY_MODE_CONFIGS[mode];
  const allowedCategories = new Set(config.enabledToolCategories);
  return tools.filter((tool) => allowedCategories.has(resolveToolCategory(tool.name)));
}

/**
 * Validate that a mode transition is allowed.
 * Returns the target mode, or throws if invalid.
 */
export function validateModeTransition(
  current: FridayOperationalMode,
  target: FridayOperationalMode,
): FridayOperationalMode {
  // All transitions are currently allowed
  if (current === target) return target;
  return target;
}

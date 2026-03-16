// ─── Tool mutation classifier ───
// Determines whether a tool call is considered mutating (write-side-effect).
// Used to enforce readOnly constraints on agent runs.

// Tools that are always mutating
const MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "exec",
  "memory_store",
  "workflow_run",
]);

// Tools that are mutating only for certain actions/sub-operations
const CONDITIONAL_MUTATING_TOOLS: Record<string, (args: Record<string, unknown>) => boolean> = {
  system: (args) => {
    const action = typeof args.action === "string" ? args.action : "";
    const readOnlyActions = new Set([
      "snapshot",
      "read_notification",
      "notification_list",
      "search_file",
      "clipboard_read",
    ]);
    return !readOnlyActions.has(action);
  },
  browser: (args) => {
    // browser actions that mutate state
    let action = typeof args.action === "string" ? args.action : "";
    const mutatingActions = new Set([
      "open",
      "navigate",
      "click", "type", "fill", "select", "press", "drag",
      "upload", "evaluate",
    ]);
    // OC-008: When action is "act", inspect the nested act sub-action
    if (action === "act" && typeof args.act === "string") {
      action = args.act;
    }
    return mutatingActions.has(action);
  },
  xhs: (args) => {
    // XHS actions that create/modify content
    const action = typeof args.action === "string" ? args.action : "";
    const mutatingActions = new Set([
      "publish_note", "comment", "like", "follow", "collect",
    ]);
    return mutatingActions.has(action);
  },
  gateway: (args) => {
    const action = typeof args.action === "string" ? args.action : "";
    return action !== "status" && action !== "config_get";
  },
  skill_run: (args) => {
    const skillId = typeof args.skillId === "string" ? args.skillId : "";
    const readOnlySkills = new Set([
      "repo-health-check",
      "workspace-change-risk-review",
      "release-readiness-check",
      "log-error-triage",
      "local-service-diagnose",
      "incident-brief-generator",
      "system-health-snapshot",
      "review-open-issues",
      "autofix-readiness-review",
      "failed-deploy-recovery-brief",
    ]);
    return !readOnlySkills.has(skillId);
  },
};

// Tools that are always read-only
const READ_ONLY_TOOLS = new Set([
  "read",
  "file_read",
  "file_list",
  "web_fetch",
  "web_search",
  "memory_search",
  "memory_query",
  "memory_get",
  "echo",
  "spawn_subagent",
  "get_subagent",
  "list_subagents",
  "agents_list",
  "skills_list",
  "capabilities",
  "task_status",
  "image_analysis",
]);

/**
 * Returns true if the given tool call is considered mutating.
 * A mutating tool has write side-effects (files, network, state).
 */
export function isMutatingToolCall(
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  // Explicitly read-only tools
  if (READ_ONLY_TOOLS.has(toolName)) return false;

  // Explicitly mutating tools
  if (MUTATING_TOOLS.has(toolName)) return true;

  // Conditionally mutating
  const check = CONDITIONAL_MUTATING_TOOLS[toolName];
  if (check) return check(args);

  // Unknown tools — treat as mutating for safety
  return true;
}

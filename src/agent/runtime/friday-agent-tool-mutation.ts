// ─── Tool mutation classifier ───
// Determines whether a tool call is considered mutating (write-side-effect).
// Used to enforce readOnly constraints on agent runs.

import {
  getApprovalRequiredReasonForExecCommand,
  unwrapCommand,
} from "./friday-agent-tool-risk.js";

// Tools that are always mutating
const MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "memory_store",
  "workflow_run",
]);

// Shell commands that are read-only (inspection, listing, searching)
const READ_ONLY_SHELL_COMMANDS = /^\s*(ls|find|cat|head|tail|wc|grep|rg|awk|sed\s+-n|sort|uniq|diff|file|stat|which|where|type|echo|pwd|date|uname|whoami|id|env|printenv|df|du|free|top\s+-bn|uptime|hostname|nproc|test\s|[\[]\s)/;

// Tools that are mutating only for certain actions/sub-operations
const CONDITIONAL_MUTATING_TOOLS: Record<string, (args: Record<string, unknown>) => boolean> = {
  exec: (args) => {
    // Shell commands: read-only commands (ls, find, cat, grep, etc.) are not mutating.
    // Align with the exec risk gate's unwrapCommand so a read-only program name at the START
    // of the command cannot mask a mutating INNER command (`env FOO=x rm -rf …`) or dangerous
    // flags (`find … -delete`, `bash -c …`). Without this, readOnly enforcement under-counts
    // such calls as non-mutating even though the action writes/destroys state.
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) return true; // empty command → treat as mutating for safety
    // 1) Anything the exec risk gate would force approval on (destructive program, dangerous
    //    flags, opaque `sh -c …`, env-wrapped destructive) is mutating.
    if (getApprovalRequiredReasonForExecCommand(command)) return true;
    // 2) Otherwise classify on the UNWRAPPED inner command (strip env/sudo/nice/timeout wrappers
    //    + inline VAR=value assignments) so wrapped mutating commands don't masquerade as read-only.
    const unwrapped = unwrapCommand(command.split(/\s+/));
    if (unwrapped.approve) return true; // opaque/unverifiable wrapper → mutating (fail safe)
    return !READ_ONLY_SHELL_COMMANDS.test(unwrapped.inner.join(" "));
  },
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
  desktop: (args) => {
    const action = typeof args.action === "string" ? args.action : "";
    const readOnlyActions = new Set([
      "screenshot",
      "inspect_element",
      "search_elements",
      "check_permissions",
      "session_info",
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
    // XHS is C1-descope and default-unregistered. Keep the classifier
    // fail-safe for test-only/future re-enable paths that still construct it.
    const action = typeof args.action === "string" ? args.action : "";
    const mutatingActions = new Set([
      "login", "post", "publish", "publish_note", "comment", "comments", "like", "follow", "collect",
    ]);
    return mutatingActions.has(action);
  },
  gateway: (args) => {
    const action = typeof args.action === "string" ? args.action : "";
    return action !== "status" && action !== "config_get";
  },
  mcp: (args) => {
    const action = typeof args.action === "string" ? args.action : "";
    if (!action) {
      return false;
    }
    const readOnlyActions = new Set([
      "list_servers",
      "list_server_states",
      "list_tools",
      "search_tools",
      "list_resources",
      "read_resource",
      "list_prompts",
      "get_prompt",
    ]);
    return !readOnlyActions.has(action);
  },
  guide_lens: (args) => {
    const action = typeof args.action === "string" ? args.action : "";
    return action === "update_preferences" || action === "update_avatar";
  },
  // skill_run is now in READ_ONLY_TOOLS — skills run in their own sandbox
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
  "workflow_list",
  "spawn_subagent",
  "get_subagent",
  "list_subagents",
  "agents_list",
  "skills_list",
  "skill_run",   // Skills execute in their own sandbox; agent readOnly shouldn't block them
  "capabilities",
  "task_status",
  "request_tool_pack",
  "tool_search",
  "image_analysis",
  "pdf_parse",
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

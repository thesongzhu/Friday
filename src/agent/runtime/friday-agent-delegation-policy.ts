import type { FridayAgentConversationContext } from "./friday-agent-runtime.types.js";

const DIRECT_STATUS_HINTS =
  /\b(status|progress|eta|done yet|finished yet|what are you doing|what's happening|what are you working on)\b/i;
const DIRECT_CAPABILITY_HINTS =
  /\b(what can you do|which capabilities|capabilities|what's enabled|is mcp enabled|is discord enabled|read.?only)\b/i;
const ACTION_HINTS =
  /\b(open|run|check|inspect|review|analyze|diagnose|debug|fix|search|look up|browse|navigate|read|write|edit|update|create|generate|deploy|export|build|test|lint|typecheck|configure|switch|set|use|send|install|triage|summarize|investigate)\b/i;
const TOOL_DOMAIN_HINTS =
  /\b(browser|chrome|desktop|system|provider|oauth|model|workflow|skill|repo|repository|file|files|code|shell|command|discord|slack|telegram|memory|session|subagent|agent|log|logs|service|port|process|database|api)\b/i;

export interface FridayAgentDelegationPolicyInput {
  task: string;
  conversationContext?: FridayAgentConversationContext;
}

export function shouldDelegateFridayAgentTask(
  input: FridayAgentDelegationPolicyInput,
): boolean {
  const task = input.task.trim();
  if (task.length === 0) {
    return false;
  }

  const turnKind = input.conversationContext?.turnKind;
  if (turnKind === "status_check" || turnKind === "clarification") {
    return false;
  }

  if (DIRECT_STATUS_HINTS.test(task) || DIRECT_CAPABILITY_HINTS.test(task)) {
    return false;
  }

  if (turnKind === "continue_active_task") {
    return true;
  }

  if (ACTION_HINTS.test(task) || TOOL_DOMAIN_HINTS.test(task)) {
    return true;
  }

  const normalized = task.toLowerCase();
  const shortQuestion =
    task.length <= 120
    && normalized.includes("?")
    && !/[/:\\]/.test(task)
    && !/\bhttps?:\/\//i.test(task);
  if (shortQuestion) {
    return false;
  }

  return task.length > 180;
}

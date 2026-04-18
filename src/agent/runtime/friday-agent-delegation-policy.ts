import type { FridayAgentConversationContext } from "./friday-agent-runtime.types.js";

const DIRECT_STATUS_HINTS =
  /\b(status|progress|eta|done yet|finished yet|what are you doing|what's happening|what are you working on)\b/i;
const DIRECT_CAPABILITY_HINTS =
  /\b(what can you do|which capabilities|capabilities|what's enabled|is mcp enabled|is discord enabled|read.?only)\b/i;
const DIRECT_AUTONOMOUS_HINTS =
  /\b(autonomous|execute_goal|resume_goal|get_goal|list_goals|cancel_goal)\b/i;
const DIRECT_SUBAGENT_TOOL_HINTS =
  /\b(spawn_subagent|get_subagent|list_subagents|wait=true|wait=false)\b/i;
const ACTION_HINTS =
  /\b(open|run|check|inspect|review|analyze|diagnose|debug|fix|search|look up|browse|navigate|read|write|edit|update|create|generate|deploy|export|build|test|lint|typecheck|configure|switch|set|use|send|install|triage|summarize|investigate)\b/i;
const SYNTHESIS_HINTS =
  /\b(summari[sz]e|summary|recap|answer|explain|clarify)\b/i;
const TOOL_DOMAIN_HINTS =
  /\b(browser|chrome|desktop|system|provider|oauth|model|workflow|skill|repo|repository|file|files|code|shell|command|discord|slack|telegram|memory|session|subagent|agent|log|logs|service|port|process|database|api)\b/i;
const LIGHTWEIGHT_FOLLOW_UP_HINTS =
  /\b(acknowledge|remember|recall|keep .* available|available for later recall|earlier facts?|previous facts?|what did i tell you)\b/i;

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

  if (
    DIRECT_STATUS_HINTS.test(task)
    || DIRECT_CAPABILITY_HINTS.test(task)
    || DIRECT_AUTONOMOUS_HINTS.test(task)
    || DIRECT_SUBAGENT_TOOL_HINTS.test(task)
  ) {
    return false;
  }

  const hasActionHints = ACTION_HINTS.test(task);
  const hasToolDomainHints = TOOL_DOMAIN_HINTS.test(task);

  if (turnKind === "continue_active_task") {
    return hasActionHints;
  }

  if (
    turnKind === "follow_up"
    && SYNTHESIS_HINTS.test(task)
    && !hasToolDomainHints
  ) {
    return false;
  }

  if (
    turnKind === "follow_up"
    && LIGHTWEIGHT_FOLLOW_UP_HINTS.test(task)
  ) {
    return false;
  }

  if (hasActionHints) {
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

  return false;
}

import type { FridayProviderTenantContext } from "#providers";
import type { FridayAgentConversationContext } from "./friday-agent-runtime.types.js";

export interface FridayAgentToolExecutionContext {
  runId: string;
  sessionKey: string;
  readOnly: boolean;
  operationalMode?: "plan" | "execute" | "restricted";
  timezone?: string;
  taskPrompt?: string;
  conversationContext?: FridayAgentConversationContext;
  principalId?: string;
  tenantContext?: FridayProviderTenantContext;
}

const FRIDAY_AGENT_TOOL_EXECUTION_CONTEXT = Symbol.for("friday.agent.toolExecutionContext");

export function attachFridayAgentToolExecutionContext(
  signal: AbortSignal,
  context: FridayAgentToolExecutionContext,
): AbortSignal {
  Object.defineProperty(signal, FRIDAY_AGENT_TOOL_EXECUTION_CONTEXT, {
    value: context,
    enumerable: false,
    configurable: true,
  });
  return signal;
}

export function getFridayAgentToolExecutionContext(
  signal: AbortSignal,
): FridayAgentToolExecutionContext | null {
  const context = (signal as unknown as Record<PropertyKey, unknown>)[FRIDAY_AGENT_TOOL_EXECUTION_CONTEXT];
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return null;
  }
  const candidate = context as Partial<FridayAgentToolExecutionContext>;
  if (
    typeof candidate.runId !== "string"
    || typeof candidate.sessionKey !== "string"
    || typeof candidate.readOnly !== "boolean"
    || (candidate.operationalMode !== undefined && typeof candidate.operationalMode !== "string")
    || (candidate.timezone !== undefined && typeof candidate.timezone !== "string")
    || (candidate.taskPrompt !== undefined && typeof candidate.taskPrompt !== "string")
    || (candidate.principalId !== undefined && typeof candidate.principalId !== "string")
    || (
      candidate.conversationContext !== undefined
      && (typeof candidate.conversationContext !== "object" || candidate.conversationContext === null || Array.isArray(candidate.conversationContext))
    )
    || (
      candidate.tenantContext !== undefined
      && (typeof candidate.tenantContext !== "object" || candidate.tenantContext === null || Array.isArray(candidate.tenantContext))
    )
  ) {
    return null;
  }
  return {
    runId: candidate.runId,
    sessionKey: candidate.sessionKey,
    readOnly: candidate.readOnly,
    operationalMode: candidate.operationalMode as FridayAgentToolExecutionContext["operationalMode"],
    timezone: candidate.timezone,
    taskPrompt: candidate.taskPrompt,
    conversationContext: candidate.conversationContext as FridayAgentConversationContext | undefined,
    principalId: candidate.principalId,
    tenantContext: candidate.tenantContext as FridayProviderTenantContext | undefined,
  };
}

export interface FridayAgentToolExecutionContext {
  runId: string;
  sessionKey: string;
  readOnly: boolean;
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
  ) {
    return null;
  }
  return {
    runId: candidate.runId,
    sessionKey: candidate.sessionKey,
    readOnly: candidate.readOnly,
  };
}

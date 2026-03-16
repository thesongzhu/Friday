import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import { getFridayAgentToolExecutionContext } from "../runtime/friday-agent-tool-execution-context.js";
import { jsonResult } from "./friday-agent-tool-helpers.js";

export interface FridayAgentTaskStatusSubagentSnapshot {
  id: string;
  childRunId: string;
  childSessionKey: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  task: string;
  label?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface FridayAgentTaskStatusSnapshot {
  readOnly: boolean;
  sessionKey?: string;
  trackedRunId?: string;
  task?: string;
  runStatus?: string;
  phase?: string;
  elapsedMs?: number;
  latestTool?: string;
  activeSubagents: FridayAgentTaskStatusSubagentSnapshot[];
  blockers: string[];
  pendingPlanRunId?: string;
  terminalOutcome?: {
    status: "completed" | "failed" | "cancelled";
    summary?: string;
    responseText?: string;
  };
}

export interface CreateFridayAgentTaskStatusToolOptions {
  getSnapshot: (input: {
    runId?: string;
    sessionKey?: string;
    readOnly: boolean;
  }) => Promise<FridayAgentTaskStatusSnapshot> | FridayAgentTaskStatusSnapshot;
}

export function createFridayAgentTaskStatusTool(
  options: CreateFridayAgentTaskStatusToolOptions,
): FridayAgentToolDefinition {
  return {
    name: "task_status",
    description:
      "Return deterministic status for the current session or run, including active delegated sub-agents, elapsed time, " +
      "latest tool, current phase, blockers, and terminal outcome. Use this before answering questions like what Friday " +
      "is doing right now, whether a delegated task is still running, or what the latest result is.",
    parameters: {
      properties: {},
      required: [],
    },
    async execute(_args: Record<string, unknown>, signal: AbortSignal): Promise<FridayAgentToolResult> {
      const context = getFridayAgentToolExecutionContext(signal);
      const snapshot = await options.getSnapshot({
        runId: context?.runId,
        sessionKey: context?.sessionKey,
        readOnly: context?.readOnly ?? false,
      });
      return jsonResult(snapshot);
    },
  };
}

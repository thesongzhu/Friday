/**
 * Agent Autonomous Tool — Exposes goal-driven autonomous execution to the agent runtime.
 *
 * Actions: execute_goal, cancel_goal, get_goal, list_goals.
 *
 * This tool enables the agent to autonomously complete complex tasks by
 * controlling the desktop and browser with a perception-action loop.
 *
 * @module agent/tools/friday-agent-autonomous-tool
 */

import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import type { FridayAutonomousEngine, FridayAutonomousGoalListFilters } from "../autonomous/friday-autonomous.types.js";
import { getFridayAgentToolExecutionContext } from "../runtime/friday-agent-tool-execution-context.js";
import {
  errorResult,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

// ─── Types ───

export interface CreateFridayAgentAutonomousToolOptions {
  autonomousEngine: FridayAutonomousEngine;
}

type AutonomousAction = "execute_goal" | "cancel_goal" | "get_goal" | "list_goals";

const VALID_ACTIONS = new Set<AutonomousAction>([
  "execute_goal",
  "cancel_goal",
  "get_goal",
  "list_goals",
]);

// ─── Factory ───

export function createFridayAgentAutonomousTool(
  options: CreateFridayAgentAutonomousToolOptions,
): FridayAgentToolDefinition {
  const { autonomousEngine } = options;

  return {
    name: "autonomous",
    description:
      "Goal-driven autonomous computer control. " +
      "Actions: execute_goal (autonomously complete a task using desktop/browser control with perception-action loop), " +
      "cancel_goal (cancel a running autonomous goal), " +
      "get_goal (check status of an autonomous goal), " +
      "list_goals (list recent autonomous goals). " +
      "Use this for complex tasks that require multiple steps of computer interaction " +
      "(e.g., setting up accounts, configuring services, installing software).",
    parameters: {
      properties: {
        action: {
          type: "string",
          enum: ["execute_goal", "cancel_goal", "get_goal", "list_goals"],
          description: "Autonomous action to perform.",
        },
        // ─── execute_goal params ───
        description: {
          type: "string",
          description: "Goal description — what should be achieved (for execute_goal).",
        },
        priority: {
          type: "string",
          enum: ["low", "normal", "high", "critical"],
          description: "Goal priority (default: normal).",
        },
        maxIterations: {
          type: "number",
          description: "Maximum perception-action iterations (default: 50).",
        },
        timeoutMs: {
          type: "number",
          description: "Maximum time in milliseconds (default: 300000 = 5 minutes).",
        },
        // ─── cancel_goal / get_goal params ───
        goalId: {
          type: "string",
          description: "Goal ID (for cancel_goal, get_goal).",
        },
        // ─── list_goals params ───
        status: {
          type: "string",
          enum: ["pending", "planning", "executing", "verifying", "completed", "failed", "cancelled"],
          description: "Filter by status (for list_goals).",
        },
        limit: {
          type: "number",
          description: "Max results to return (for list_goals).",
        },
      },
      required: ["action"],
    },

    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const action = readStringParam(args, "action", { required: true }) as AutonomousAction;

      if (!VALID_ACTIONS.has(action)) {
        return errorResult(
          `Invalid action "${action}". Valid actions: ${Array.from(VALID_ACTIONS).join(", ")}`,
        );
      }

      try {
        switch (action) {
          case "execute_goal":
            return await handleExecuteGoal(args, signal);
          case "cancel_goal":
            return handleCancelGoal(args);
          case "get_goal":
            return handleGetGoal(args);
          case "list_goals":
            return handleListGoals(args);
          default:
            return errorResult(`Unknown action: ${action as string}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("aborted") || message.includes("abort")) {
          return errorResult("Autonomous action aborted.");
        }
        return errorResult(message);
      }
    },
  };

  // ─── Action handlers ───

  async function handleExecuteGoal(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const description = readStringParam(args, "description", { required: true });
    const priority = readStringParam(args, "priority") as "low" | "normal" | "high" | "critical" | undefined;
    const maxIterations = readNumberParam(args, "maxIterations", { integer: true });
    const timeoutMs = readNumberParam(args, "timeoutMs", { integer: true });
    const executionContext = getFridayAgentToolExecutionContext(signal);

    const result = await autonomousEngine.executeGoal({
      description,
      priority,
      config: {
        ...(maxIterations != null ? { maxIterationsPerGoal: maxIterations } : {}),
        ...(timeoutMs != null ? { maxTimePerGoalMs: timeoutMs } : {}),
      },
      timezone: executionContext?.timezone,
      principalId: executionContext?.principalId,
      tenantContext: executionContext?.tenantContext,
      signal,
    });

    return jsonResult({
      goalId: result.goalId,
      status: result.status,
      summary: result.summary,
      failureReason: result.failureReason,
      iterationCount: result.iterationCount,
      durationMs: result.durationMs,
      extractedOutputs: result.extractedOutputs,
    });
  }

  function handleCancelGoal(args: Record<string, unknown>): FridayAgentToolResult {
    const goalId = readStringParam(args, "goalId", { required: true });
    autonomousEngine.cancelGoal(goalId);
    return jsonResult({ goalId, cancelled: true });
  }

  function handleGetGoal(args: Record<string, unknown>): FridayAgentToolResult {
    const goalId = readStringParam(args, "goalId", { required: true });
    const goal = autonomousEngine.getGoal(goalId);
    if (!goal) {
      return errorResult(`Goal "${goalId}" not found.`);
    }
    return jsonResult({
      id: goal.id,
      status: goal.status,
      description: goal.description,
      iterationCount: goal.iterationCount,
      currentStepIndex: goal.currentStepIndex,
      totalSteps: goal.stepIds.length,
      createdAt: goal.createdAt,
      startedAt: goal.startedAt,
      completedAt: goal.completedAt,
      failureReason: goal.failureReason,
    });
  }

  function handleListGoals(args: Record<string, unknown>): FridayAgentToolResult {
    const status = readStringParam(args, "status") as FridayAutonomousGoalListFilters["status"];
    const limit = readNumberParam(args, "limit", { integer: true });

    const goalList = autonomousEngine.listGoals({ status, limit: limit ?? 20 });
    return jsonResult({
      count: goalList.length,
      goals: goalList.map((g) => ({
        id: g.id,
        status: g.status,
        description: g.description.slice(0, 200),
        iterationCount: g.iterationCount,
        createdAt: g.createdAt,
      })),
    });
  }
}

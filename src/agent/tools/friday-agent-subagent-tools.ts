import { FridayDomainError } from "#errors";

import type { FridayAgentToolDefinition } from "../model/friday-agent.types.js";
import type {
  FridaySubagentContext,
  FridaySubagentRegistry,
  FridaySubagentRunStatus,
  FridaySubagentSpawnMode,
} from "../subagent/friday-subagent.types.js";
import type { FridaySubagentProfileId } from "../subagent/friday-subagent-profile.js";
import { getFridayAgentToolExecutionContext } from "../runtime/friday-agent-tool-execution-context.js";
import {
  errorResult,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

// ─── Deps ───

export interface CreateFridayAgentSubagentToolsDeps {
  registry: FridaySubagentRegistry;
  subagentContext: FridaySubagentContext;
  forkModeEnabled?: boolean;
}

// ─── Factory ───

export function createFridayAgentSubagentTools(
  deps: CreateFridayAgentSubagentToolsDeps,
): FridayAgentToolDefinition[] {
  return [
    createSpawnSubagentTool(deps),
    createListSubagentsTool(deps),
    createGetSubagentTool(deps),
  ];
}

function resolveSubagentContext(
  fallback: FridaySubagentContext,
  signal: AbortSignal,
): FridaySubagentContext {
  const executionContext = getFridayAgentToolExecutionContext(signal);
  if (!executionContext) {
    return fallback;
  }

  return {
    depth: fallback.depth,
    parentRunId: executionContext.runId,
    parentSessionKey: executionContext.sessionKey,
    rootRunId: fallback.depth === 0 ? executionContext.runId : fallback.rootRunId,
    timezone: executionContext.timezone ?? fallback.timezone,
  };
}

// ─── spawn_subagent ───

function createSpawnSubagentTool(
  deps: CreateFridayAgentSubagentToolsDeps,
): FridayAgentToolDefinition {
  return {
    name: "spawn_subagent",
    description:
      "Spawn an isolated sub-agent to handle a focused task. " +
      "The sub-agent runs asynchronously in the background. " +
      "Returns a delegated status snapshot plus a subagentId that can be used to check status. " +
      "Use list_subagents or get_subagent to poll for completion.",
    parameters: {
      properties: {
        task: {
          type: "string",
          description: "The task for the sub-agent to complete. Be specific and self-contained.",
        },
        label: {
          type: "string",
          description: "Optional human-readable label for tracking (e.g., 'Research API docs').",
        },
        model: {
          type: "string",
          description: "Optional model override for the sub-agent (defaults to parent's model).",
        },
        profile: {
          type: "string",
          enum: ["explore", "plan", "debug", "review"],
          description: "Optional built-in sub-agent profile. Defaults to heuristic routing based on the task.",
        },
        timeoutMs: {
          type: "number",
          description: "Optional timeout in milliseconds (default: 180000 = 3 minutes).",
        },
        wait: {
          type: "boolean",
          description: "If true, block until sub-agent completes (legacy behavior). Default: false.",
        },
        ...(deps.forkModeEnabled
          ? {
              mode: {
                type: "string",
                enum: ["fresh", "fork"],
                description: "Optional spawn mode. Use fork to inherit parent session context from a fork point.",
              },
              inheritMessageCount: {
                type: "number",
                description: "Optional number of recent parent messages to inherit when mode=fork.",
              },
              forkFromMessageId: {
                type: "string",
                description: "Optional parent message ID to use as the fork point when mode=fork.",
              },
            }
          : {}),
      },
      required: ["task"],
    },
    async execute(args, signal) {
      const subagentContext = resolveSubagentContext(deps.subagentContext, signal);
      const task = readStringParam(args, "task", { required: true });
      const label = readStringParam(args, "label");
      const model = readStringParam(args, "model");
      const profile = readStringParam(args, "profile") as FridaySubagentProfileId | undefined;
      const timeoutMs = readNumberParam(args, "timeoutMs", { integer: true });
      const wait = args.wait === true;
      const mode = (readStringParam(args, "mode") as FridaySubagentSpawnMode | undefined) ?? "fresh";
      const inheritMessageCount = readNumberParam(args, "inheritMessageCount", { integer: true });
      const forkFromMessageId = readStringParam(args, "forkFromMessageId");
      const toolExecutionContext = getFridayAgentToolExecutionContext(signal);

      if (!deps.forkModeEnabled && (args.mode !== undefined || args.inheritMessageCount !== undefined || args.forkFromMessageId !== undefined)) {
        return errorResult("Sub-agent fork mode is not enabled in this deployment.");
      }
      if (mode !== "fresh" && mode !== "fork") {
        return errorResult("spawn_subagent mode must be either 'fresh' or 'fork'.");
      }

      try {
        const spawnInput = {
          task,
          label,
          model,
          profile,
          timezone: subagentContext.timezone,
          timeoutMs,
          mode,
          inheritMessageCount,
          forkFromMessageId,
          conversationContext: toolExecutionContext?.conversationContext,
          parentRunId: subagentContext.parentRunId,
          parentSessionKey: subagentContext.parentSessionKey,
          depth: subagentContext.depth,
          rootRunId: subagentContext.rootRunId,
          constraints: (toolExecutionContext?.readOnly || toolExecutionContext?.operationalMode)
            ? {
                ...(toolExecutionContext.readOnly ? { readOnly: true } : {}),
                ...(toolExecutionContext.operationalMode ? { operationalMode: toolExecutionContext.operationalMode } : {}),
              }
            : undefined,
          principalId: toolExecutionContext?.principalId,
          tenantContext: toolExecutionContext?.tenantContext,
          signal,
        };

        if (wait) {
          // Legacy blocking behavior
          const outcome = await deps.registry.spawn(spawnInput);

          if (outcome.status === "completed") {
            return jsonResult({
              status: "completed",
              mode,
              response: outcome.response,
              stats: {
                toolCallCount: outcome.toolCallCount,
                durationMs: outcome.durationMs,
                usageInput: outcome.usageInput,
                usageOutput: outcome.usageOutput,
              },
            });
          }

          return errorResult(
            `Sub-agent ${outcome.status}: ${outcome.response}\n` +
            `(duration: ${String(outcome.durationMs)}ms, tools: ${String(outcome.toolCallCount)})`,
          );
        }

        // Non-blocking (detached) mode — default
        const detached = await deps.registry.spawnDetached(spawnInput);
        const latestRecord = deps.registry.getById(detached.subagentId);
        const statusSnapshot = latestRecord?.status ?? detached.statusSnapshot;
        const outcome = statusSnapshot === "completed" || statusSnapshot === "failed" || statusSnapshot === "cancelled"
          ? latestRecord?.outcome ?? detached.outcome
          : undefined;
        const message = outcome
          ? "Sub-agent delegation resolved before the detached hand-off returned. This payload is a completion snapshot."
          : "Sub-agent delegated. This payload is a status snapshot at hand-off time, not a guaranteed final result. Use get_subagent or list_subagents to check the terminal state, or rerun with wait=true if you need the final result now.";

        return jsonResult({
          status: "accepted",
          detached: true,
          awaited: false,
          subagentId: detached.subagentId,
          childRunId: detached.childRunId,
          childSessionKey: detached.childSessionKey,
          ...(profile ? { profile } : {}),
          mode: detached.mode,
          ...(detached.forkedFromMessageId ? { forkedFromMessageId: detached.forkedFromMessageId } : {}),
          ...(typeof detached.inheritedMessageCount === "number"
            ? { inheritedMessageCount: detached.inheritedMessageCount }
            : {}),
          statusSnapshot,
          ...(outcome ? { outcome } : {}),
          message,
        });
      } catch (error) {
        if (error instanceof FridayDomainError) {
          return errorResult(error.message);
        }
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(`Sub-agent spawn failed: ${message}`);
      }
    },
  };
}

// ─── list_subagents ───

function createListSubagentsTool(
  deps: CreateFridayAgentSubagentToolsDeps,
): FridayAgentToolDefinition {
  return {
    name: "list_subagents",
    description:
      "List sub-agents spawned by the current run. " +
      "Shows status, task, and outcome for each sub-agent.",
    parameters: {
      properties: {
        status: {
          type: "string",
          description: "Filter by status: pending, running, completed, failed, cancelled.",
        },
      },
    },
    async execute(args, signal) {
      const subagentContext = resolveSubagentContext(deps.subagentContext, signal);
      const status = readStringParam(args, "status") as FridaySubagentRunStatus | undefined;
      const records = deps.registry.listByParentRunId(subagentContext.parentRunId);
      const filtered = status ? records.filter((r) => r.status === status) : records;

      return jsonResult({
        count: filtered.length,
        subagents: filtered.map((r) => ({
          id: r.id,
          childRunId: r.childRunId,
        task: r.task,
        label: r.label,
        mode: r.mode,
        forkedFromMessageId: r.forkedFromMessageId,
        inheritedMessageCount: r.inheritedMessageCount,
        status: r.status,
        depth: r.depth,
          durationMs: r.durationMs,
          outcome: r.outcome
            ? {
                status: r.outcome.status,
                response: r.outcome.response.slice(0, 500),
                toolCallCount: r.outcome.toolCallCount,
              }
            : undefined,
          createdAt: r.createdAt,
        })),
      });
    },
  };
}

// ─── get_subagent ───

function createGetSubagentTool(
  deps: CreateFridayAgentSubagentToolsDeps,
): FridayAgentToolDefinition {
  return {
    name: "get_subagent",
    description:
      "Get the status and result of a specific sub-agent by ID. " +
      "Use after spawn_subagent to check if the sub-agent has completed.",
    parameters: {
      properties: {
        subagentId: {
          type: "string",
          description: "The sub-agent ID returned by spawn_subagent.",
        },
      },
      required: ["subagentId"],
    },
    async execute(args, signal) {
      const subagentContext = resolveSubagentContext(deps.subagentContext, signal);
      const subagentId = readStringParam(args, "subagentId", { required: true });

      const record = deps.registry.getById(subagentId);
      if (!record) {
        return errorResult(`Sub-agent '${subagentId}' not found.`);
      }

      // Authorize: only allow access to subagents owned by this run/session
      if (
        record.parentRunId !== subagentContext.parentRunId &&
        record.parentSessionKey !== subagentContext.parentSessionKey &&
        record.rootRunId !== subagentContext.rootRunId
      ) {
        return errorResult(`Sub-agent '${subagentId}' not found.`);
      }

      return jsonResult({
        id: record.id,
        childRunId: record.childRunId,
        task: record.task,
        label: record.label,
        status: record.status,
        mode: record.mode,
        forkedFromMessageId: record.forkedFromMessageId,
        inheritedMessageCount: record.inheritedMessageCount,
        depth: record.depth,
        durationMs: record.durationMs,
        childSessionKey: record.childSessionKey,
        outcome: record.outcome
          ? {
              status: record.outcome.status,
              response: record.outcome.response,
              toolCallCount: record.outcome.toolCallCount,
              durationMs: record.outcome.durationMs,
              usageInput: record.outcome.usageInput,
              usageOutput: record.outcome.usageOutput,
            }
          : undefined,
        createdAt: record.createdAt,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
      });
    },
  };
}

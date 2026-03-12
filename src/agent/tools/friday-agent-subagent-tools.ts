import { FridayDomainError } from "#errors";

import type { FridayAgentToolDefinition } from "../model/friday-agent.types.js";
import type {
  FridaySubagentContext,
  FridaySubagentRegistry,
  FridaySubagentRunStatus,
} from "../subagent/friday-subagent.types.js";
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

// ─── spawn_subagent ───

function createSpawnSubagentTool(
  deps: CreateFridayAgentSubagentToolsDeps,
): FridayAgentToolDefinition {
  return {
    name: "spawn_subagent",
    description:
      "Spawn an isolated sub-agent to handle a focused task. " +
      "The sub-agent runs asynchronously in the background. " +
      "Returns immediately with a subagentId that can be used to check status. " +
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
        timeoutMs: {
          type: "number",
          description: "Optional timeout in milliseconds (default: 180000 = 3 minutes).",
        },
        wait: {
          type: "boolean",
          description: "If true, block until sub-agent completes (legacy behavior). Default: false.",
        },
      },
      required: ["task"],
    },
    async execute(args, signal) {
      const task = readStringParam(args, "task", { required: true });
      const label = readStringParam(args, "label");
      const model = readStringParam(args, "model");
      const timeoutMs = readNumberParam(args, "timeoutMs", { integer: true });
      const wait = args.wait === true;

      try {
        const spawnInput = {
          task,
          label,
          model,
          timeoutMs,
          parentRunId: deps.subagentContext.parentRunId,
          parentSessionKey: deps.subagentContext.parentSessionKey,
          depth: deps.subagentContext.depth,
          rootRunId: deps.subagentContext.rootRunId,
          signal,
        };

        if (wait) {
          // Legacy blocking behavior
          const outcome = await deps.registry.spawn(spawnInput);

          if (outcome.status === "completed") {
            return jsonResult({
              status: "completed",
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
        const detached = deps.registry.spawnDetached(spawnInput);

        return jsonResult({
          status: "accepted",
          subagentId: detached.subagentId,
          childSessionKey: detached.childSessionKey,
          message: "Sub-agent spawned. Use get_subagent or list_subagents to check status.",
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
    async execute(args) {
      const status = readStringParam(args, "status") as FridaySubagentRunStatus | undefined;

      const records = deps.registry.listByParentRunId(deps.subagentContext.parentRunId);
      const filtered = status ? records.filter((r) => r.status === status) : records;

      return jsonResult({
        count: filtered.length,
        subagents: filtered.map((r) => ({
          id: r.id,
          task: r.task,
          label: r.label,
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
    async execute(args) {
      const subagentId = readStringParam(args, "subagentId", { required: true });

      const record = deps.registry.getById(subagentId);
      if (!record) {
        return errorResult(`Sub-agent '${subagentId}' not found.`);
      }

      // Authorize: only allow access to subagents owned by this run/session
      if (
        record.parentRunId !== deps.subagentContext.parentRunId &&
        record.parentSessionKey !== deps.subagentContext.parentSessionKey
      ) {
        return errorResult(`Sub-agent '${subagentId}' not found.`);
      }

      return jsonResult({
        id: record.id,
        task: record.task,
        label: record.label,
        status: record.status,
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

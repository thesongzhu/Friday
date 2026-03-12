import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import type { FridaySubagentRegistry } from "../subagent/friday-subagent.types.js";
import {
  errorResult,
  jsonResult,
  readBooleanParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

// ─── Types ───

export interface CreateFridayAgentAgentsListToolDeps {
  subagentRegistry: FridaySubagentRegistry;
}

// ─── Factory ───

export function createFridayAgentAgentsListTool(
  deps: CreateFridayAgentAgentsListToolDeps,
): FridayAgentToolDefinition {
  const { subagentRegistry } = deps;

  return {
    name: "agents_list",
    description:
      "List available sub-agent runs. Optionally filter by query string. " +
      "Use includeMeta=true to get detailed metadata for each agent entry.",
    parameters: {
      properties: {
        query: {
          type: "string",
          description: "Optional search query to filter agents by task, label, or ID.",
        },
        includeMeta: {
          type: "boolean",
          description: "If true, include detailed metadata (status, outcome, timing). Default: false.",
        },
      },
    },

    async execute(
      args: Record<string, unknown>,
      _signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      try {
        const query = readStringParam(args, "query");
        const includeMeta = readBooleanParam(args, "includeMeta") ?? false;

        // List all subagent records
        const records = subagentRegistry.list();

        // Filter by query if provided
        let filtered = records;
        if (query) {
          const lowerQuery = query.toLowerCase();
          filtered = records.filter((r) => {
            const searchable = [
              r.id,
              r.task,
              r.label ?? "",
              r.model ?? "",
              r.status,
              r.parentSessionKey,
              r.childSessionKey,
            ].join(" ").toLowerCase();
            return searchable.includes(lowerQuery);
          });
        }

        // Sort by creation time (newest first)
        filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

        if (includeMeta) {
          return jsonResult({
            count: filtered.length,
            agents: filtered.map((r) => ({
              id: r.id,
              task: r.task,
              label: r.label,
              model: r.model,
              status: r.status,
              depth: r.depth,
              parentRunId: r.parentRunId,
              parentSessionKey: r.parentSessionKey,
              childSessionKey: r.childSessionKey,
              durationMs: r.durationMs,
              outcome: r.outcome
                ? {
                    status: r.outcome.status,
                    response: r.outcome.response.slice(0, 500),
                    toolCallCount: r.outcome.toolCallCount,
                    durationMs: r.outcome.durationMs,
                    usageInput: r.outcome.usageInput,
                    usageOutput: r.outcome.usageOutput,
                  }
                : undefined,
              createdAt: r.createdAt,
              startedAt: r.startedAt,
              completedAt: r.completedAt,
            })),
          });
        }

        // Compact output
        return jsonResult({
          count: filtered.length,
          agents: filtered.map((r) => ({
            id: r.id,
            task: r.task.slice(0, 120),
            label: r.label,
            status: r.status,
            depth: r.depth,
            createdAt: r.createdAt,
          })),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(`Failed to list agents: ${message}`);
      }
    },
  };
}

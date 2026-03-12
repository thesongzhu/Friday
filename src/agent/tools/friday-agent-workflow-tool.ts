import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import type { FridayWorkflowExecutionService, JsonObject } from "#workflows";
import {
  errorResult,
  jsonResult,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

// ─── Options ───

export interface CreateFridayAgentWorkflowToolDeps {
  workflowExecutionService: FridayWorkflowExecutionService;
}

// ─── Factory ───

export function createFridayAgentWorkflowTool(
  deps: CreateFridayAgentWorkflowToolDeps,
): FridayAgentToolDefinition {
  return {
    name: "workflow_run",
    description:
      "Start a Friday workflow run with given input. Returns the run ID and status.",
    parameters: {
      properties: {
        workflowId: { type: "string", description: "Workflow ID to execute" },
        versionId: { type: "string", description: "Specific workflow version (defaults to published)" },
        input: { type: "object", description: "Input parameters (passed as trigger payload)" },
      },
      required: ["workflowId"],
    },
    async execute(
      args: Record<string, unknown>,
      _signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const workflowId = readStringParam(args, "workflowId", { required: true });
      const versionId = readStringParam(args, "versionId");

      const rawInput = args["input"];
      const triggerPayload: JsonObject | undefined =
        rawInput !== null && typeof rawInput === "object" && !Array.isArray(rawInput)
          ? (rawInput as JsonObject)
          : undefined;

      try {
        const run = await deps.workflowExecutionService.startRun({
          workflowId,
          workflowVersionId: versionId,
          triggerType: "agent",
          triggerPayload,
          context: triggerPayload,
        });

        return jsonResult({
          runId: run.id,
          status: run.status,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Workflow '${workflowId}' failed to start: ${message}`);
      }
    },
  };
}

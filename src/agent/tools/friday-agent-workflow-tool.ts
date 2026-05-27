import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import type {
  FridayWorkflowCrudService,
  FridayWorkflowExecutionService,
  FridayWorkflowListInput,
  JsonObject,
} from "#workflows";
import {
  errorResult,
  jsonResult,
  readBooleanParam,
  readNumberParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

// ─── Options ───

export interface CreateFridayAgentWorkflowToolDeps {
  workflowExecutionService: FridayWorkflowExecutionService;
}

export interface CreateFridayAgentWorkflowListToolDeps {
  workflowCrudService: FridayWorkflowCrudService;
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

export function createFridayAgentWorkflowListTool(
  deps: CreateFridayAgentWorkflowListToolDeps,
): FridayAgentToolDefinition {
  return {
    name: "workflow_list",
    description:
      "List available Friday workflows by ID, name, tags, and published status. Read-only; does not start a workflow.",
    parameters: {
      properties: {
        tag: { type: "string", description: "Optional workflow tag to filter by" },
        cursor: { type: "string", description: "Optional pagination cursor/offset" },
        limit: { type: "number", description: "Maximum workflows to return (default 10, max 25)" },
        includeArchived: { type: "boolean", description: "Include archived workflows (default false)" },
        publishedOnly: { type: "boolean", description: "Only return workflows with a published version (default true)" },
      },
    },
    async execute(
      args: Record<string, unknown>,
      _signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const rawLimit = readNumberParam(args, "limit", { integer: true }) ?? 10;
      const limit = Math.max(1, Math.min(25, rawLimit));
      const includeArchived = readBooleanParam(args, "includeArchived") ?? false;
      const publishedOnly = readBooleanParam(args, "publishedOnly") ?? true;
      const tag = readStringParam(args, "tag");
      const cursor = readStringParam(args, "cursor");

      const input: FridayWorkflowListInput = {
        limit: publishedOnly ? Math.min(50, limit * 3) : limit,
        archived: includeArchived ? undefined : false,
        ...(tag ? { tag } : {}),
        ...(cursor ? { cursor } : {}),
      };

      try {
        const workflows = deps.workflowCrudService
          .listWorkflows(input)
          .filter((workflow) =>
            !publishedOnly || typeof workflow.publishedVersionNumber === "number")
          .slice(0, limit)
          .map((workflow) => ({
            id: workflow.id,
            slug: workflow.slug,
            name: workflow.name,
            description: workflow.description,
            tags: workflow.tags,
            latestVersionNumber: workflow.latestVersionNumber,
            publishedVersionNumber: workflow.publishedVersionNumber,
            isArchived: workflow.isArchived,
            compatibilityStatus: workflow.compatibilityStatus,
            promotionChannel: workflow.promotionChannel,
            updatedAt: workflow.updatedAt,
          }));

        return jsonResult({
          count: workflows.length,
          workflows,
          filters: {
            tag,
            cursor,
            limit,
            includeArchived,
            publishedOnly,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Workflow list failed: ${message}`);
      }
    },
  };
}

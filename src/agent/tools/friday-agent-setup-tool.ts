/**
 * Agent Setup Tool — Exposes the setup recipe system to the agent runtime.
 *
 * Actions: list_recipes, check_prerequisites, execute_recipe, get_execution,
 *          scan_environment.
 *
 * Enables the agent to automatically configure services for the user:
 * messaging platforms (Discord, Telegram, Slack), LLM providers (OpenAI, Anthropic),
 * and system prerequisites (Node.js).
 *
 * @module agent/tools/friday-agent-setup-tool
 */

import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import type {
  FridayEnvironmentScanner,
  FridaySetupRecipeCategory,
  FridaySetupRecipeExecutor,
  FridaySetupRecipeRegistry,
} from "../../setup/friday-setup.types.js";
import {
  errorResult,
  jsonResult,
  readBooleanParam,
  readNumberParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

// ─── Types ───

export interface CreateFridayAgentSetupToolOptions {
  recipeRegistry: FridaySetupRecipeRegistry;
  recipeExecutor: FridaySetupRecipeExecutor;
  environmentScanner: FridayEnvironmentScanner;
}

type SetupAction =
  | "list_recipes"
  | "check_prerequisites"
  | "execute_recipe"
  | "get_execution"
  | "scan_environment";

const VALID_ACTIONS = new Set<SetupAction>([
  "list_recipes",
  "check_prerequisites",
  "execute_recipe",
  "get_execution",
  "scan_environment",
]);

// ─── Factory ───

export function createFridayAgentSetupTool(
  options: CreateFridayAgentSetupToolOptions,
): FridayAgentToolDefinition {
  const { recipeRegistry, recipeExecutor, environmentScanner } = options;

  return {
    name: "setup",
    description:
      "Automated service setup and configuration. " +
      "Actions: list_recipes (show available setup recipes for Discord/Telegram/Slack/OpenAI/Anthropic/etc.), " +
      "check_prerequisites (check if system meets requirements for a recipe), " +
      "execute_recipe (automatically configure a service using browser/desktop automation), " +
      "get_execution (check status of a running setup), " +
      "scan_environment (detect installed software and system capabilities). " +
      "Use this to help users set up services without technical knowledge.",
    parameters: {
      properties: {
        action: {
          type: "string",
          enum: ["list_recipes", "check_prerequisites", "execute_recipe", "get_execution", "scan_environment"],
          description: "Setup action to perform.",
        },
        recipeId: {
          type: "string",
          description: "Recipe ID (for check_prerequisites, execute_recipe).",
        },
        category: {
          type: "string",
          enum: ["provider", "channel", "integration", "environment", "security"],
          description: "Filter by category (for list_recipes).",
        },
        targetService: {
          type: "string",
          description: "Filter by target service name (for list_recipes).",
        },
        executionId: {
          type: "string",
          description: "Execution ID (for get_execution).",
        },
        skipPrerequisites: {
          type: "boolean",
          description: "Skip prerequisite checks (for execute_recipe).",
        },
      },
      required: ["action"],
    },

    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const action = readStringParam(args, "action", { required: true }) as SetupAction;

      if (!VALID_ACTIONS.has(action)) {
        return errorResult(
          `Invalid action "${action}". Valid actions: ${Array.from(VALID_ACTIONS).join(", ")}`,
        );
      }

      try {
        switch (action) {
          case "list_recipes":
            return handleListRecipes(args);
          case "check_prerequisites":
            return await handleCheckPrerequisites(args);
          case "execute_recipe":
            return await handleExecuteRecipe(args, signal);
          case "get_execution":
            return handleGetExecution(args);
          case "scan_environment":
            return await handleScanEnvironment();
          default:
            return errorResult(`Unknown action: ${action as string}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(message);
      }
    },
  };

  // ─── Action handlers ───

  function handleListRecipes(args: Record<string, unknown>): FridayAgentToolResult {
    const category = readStringParam(args, "category") as FridaySetupRecipeCategory | undefined;
    const targetService = readStringParam(args, "targetService");

    const recipes = recipeRegistry.list({ category, targetService });
    return jsonResult({
      count: recipes.length,
      recipes: recipes.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        category: r.category,
        targetService: r.targetService,
        stepCount: r.steps.length,
        outputs: r.outputs.map((o) => o.label),
      })),
    });
  }

  async function handleCheckPrerequisites(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const recipeId = readStringParam(args, "recipeId", { required: true });
    const results = await recipeExecutor.checkPrerequisites(recipeId);
    const allMet = results.every((r) => r.met);

    return jsonResult({
      recipeId,
      allMet,
      results: results.map((r) => ({
        type: r.type,
        target: r.target,
        met: r.met,
        actual: r.actual,
        fixInstruction: r.fixInstruction,
      })),
    });
  }

  async function handleExecuteRecipe(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const recipeId = readStringParam(args, "recipeId", { required: true });
    const skipPrerequisites = readBooleanParam(args, "skipPrerequisites");

    const execution = await recipeExecutor.execute({
      recipeId,
      skipPrerequisites: skipPrerequisites ?? false,
      signal,
    });

    return jsonResult({
      executionId: execution.id,
      recipeId: execution.recipeId,
      status: execution.status,
      currentStepIndex: execution.currentStepIndex,
      stepCount: execution.stepResults.length,
      outputs: Object.fromEntries(
        Object.entries(execution.outputs).map(([k, v]) => [k, v.length > 8 ? `${v.slice(0, 4)}...${v.slice(-4)}` : v]),
      ),
      failureReason: execution.failureReason,
      approvalInstruction: execution.stepResults.find((step) => step.status === "paused_for_approval")?.approvalInstruction,
    });
  }

  function handleGetExecution(args: Record<string, unknown>): FridayAgentToolResult {
    const executionId = readStringParam(args, "executionId", { required: true });
    const execution = recipeExecutor.getExecution(executionId);
    if (!execution) {
      return errorResult(`Execution "${executionId}" not found.`);
    }

    return jsonResult({
      executionId: execution.id,
      recipeId: execution.recipeId,
      status: execution.status,
      currentStepIndex: execution.currentStepIndex,
      stepResults: execution.stepResults.map((s) => ({
        stepId: s.stepId,
        status: s.status,
        approachIndex: s.approachIndex,
        failureReason: s.failureReason,
        approvalInstruction: s.approvalInstruction,
      })),
      failureReason: execution.failureReason,
      createdAt: execution.createdAt,
      completedAt: execution.completedAt,
    });
  }

  async function handleScanEnvironment(): Promise<FridayAgentToolResult> {
    const scan = await environmentScanner.scan();
    return jsonResult({
      os: scan.os,
      arch: scan.arch,
      nodeVersion: scan.nodeVersion,
      npmVersion: scan.npmVersion,
      pythonVersion: scan.pythonVersion,
      gitVersion: scan.gitVersion,
      dockerVersion: scan.dockerVersion,
      installedBrowsers: scan.installedBrowsers,
      networkConnectivity: scan.networkConnectivity,
    });
  }
}

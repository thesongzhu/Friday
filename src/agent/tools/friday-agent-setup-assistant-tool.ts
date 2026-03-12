/**
 * Setup Assistant Agent Tool — Exposes the setup assistant to the agent runtime.
 *
 * Actions: plan_setup, execute_setup, get_progress, cancel_setup.
 *
 * Enables the agent to orchestrate the full zero-config onboarding experience:
 * scan environment → install prerequisites → execute recipes → verify results.
 *
 * @module agent/tools
 */

import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import type { FridaySetupAssistant } from "../../setup/friday-setup-assistant.js";
import {
  errorResult,
  jsonResult,
  readBooleanParam,
  readStringArrayParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

// ─── Types ───

export interface CreateFridayAgentSetupAssistantToolOptions {
  setupAssistant: FridaySetupAssistant;
}

type SetupAssistantAction =
  | "plan_setup"
  | "execute_setup"
  | "get_progress"
  | "cancel_setup";

const VALID_ACTIONS = new Set<SetupAssistantAction>([
  "plan_setup",
  "execute_setup",
  "get_progress",
  "cancel_setup",
]);

// ─── Factory ───

export function createFridayAgentSetupAssistantTool(
  options: CreateFridayAgentSetupAssistantToolOptions,
): FridayAgentToolDefinition {
  const { setupAssistant } = options;

  return {
    name: "setup_assistant",
    description:
      "Zero-config setup assistant for automated onboarding. " +
      "Actions: plan_setup (scan environment and plan which services to configure), " +
      "execute_setup (run the full auto-setup flow: scan → install prerequisites → configure services → verify), " +
      "get_progress (check current setup progress), " +
      "cancel_setup (cancel an active setup). " +
      "Use this as the primary entry point for helping users set up Friday from scratch.",
    parameters: {
      properties: {
        action: {
          type: "string",
          enum: ["plan_setup", "execute_setup", "get_progress", "cancel_setup"],
          description: "Setup assistant action to perform.",
        },
        categories: {
          type: "array",
          items: { type: "string" },
          description: "Filter by recipe categories (for plan_setup).",
        },
        services: {
          type: "array",
          items: { type: "string" },
          description: "Filter by target services (for plan_setup).",
        },
        recipeIds: {
          type: "array",
          items: { type: "string" },
          description: "Specific recipe IDs to execute (for execute_setup). If omitted, runs all planned recipes.",
        },
        skipPrerequisites: {
          type: "boolean",
          description: "Skip prerequisite installation (for execute_setup).",
        },
        principalId: {
          type: "string",
          description: "User principal ID for onboarding tracking (for execute_setup).",
        },
      },
      required: ["action"],
    },

    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const action = readStringParam(args, "action", { required: true }) as SetupAssistantAction;

      if (!VALID_ACTIONS.has(action)) {
        return errorResult(
          `Invalid action "${action}". Valid actions: ${Array.from(VALID_ACTIONS).join(", ")}`,
        );
      }

      try {
        switch (action) {
          case "plan_setup":
            return await handlePlanSetup(args);
          case "execute_setup":
            return await handleExecuteSetup(args, signal);
          case "get_progress":
            return handleGetProgress();
          case "cancel_setup":
            return handleCancelSetup();
          default:
            return errorResult(`Unknown action: ${action as string}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(message);
      }
    },
  };

  // ─── Action Handlers ───

  async function handlePlanSetup(args: Record<string, unknown>): Promise<FridayAgentToolResult> {
    const categories = readStringArrayParam(args, "categories");
    const services = readStringArrayParam(args, "services");

    const plan = await setupAssistant.planSetup({
      categories,
      services,
    });

    return jsonResult({
      totalRecipes: plan.length,
      readyRecipes: plan.filter((p) => p.prerequisitesMet).length,
      needsPrerequisites: plan.filter((p) => !p.prerequisitesMet).length,
      plan: plan.map((p) => ({
        recipeId: p.recipeId,
        recipeName: p.recipeName,
        category: p.category,
        targetService: p.targetService,
        prerequisitesMet: p.prerequisitesMet,
        missingPrerequisites: p.missingPrerequisites,
        enabled: p.enabled,
      })),
    });
  }

  async function handleExecuteSetup(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const recipeIds = readStringArrayParam(args, "recipeIds");
    const skipPrerequisites = readBooleanParam(args, "skipPrerequisites");
    const principalId = readStringParam(args, "principalId");

    const result = await setupAssistant.executeSetup({
      recipeIds: recipeIds ?? undefined,
      skipPrerequisites: skipPrerequisites ?? false,
      principalId: principalId ?? undefined,
      signal,
    });

    return jsonResult({
      phase: result.phase,
      totalRecipes: result.totalRecipes,
      completedRecipes: result.completedRecipes,
      failedRecipes: result.failedRecipes,
      skippedRecipes: result.skippedRecipes,
      durationMs: result.durationMs,
      results: result.results.map((r) => ({
        recipeId: r.recipeId,
        recipeName: r.recipeName,
        status: r.status,
        failureReason: r.failureReason,
        // Mask sensitive outputs
        outputs: Object.fromEntries(
          Object.entries(r.outputs).map(([k, v]) => [
            k,
            v.length > 8 ? `${v.slice(0, 4)}...${v.slice(-4)}` : v,
          ]),
        ),
      })),
    });
  }

  function handleGetProgress(): FridayAgentToolResult {
    const progress = setupAssistant.getProgress();

    return jsonResult({
      phase: progress.phase,
      totalRecipes: progress.totalRecipes,
      completedRecipes: progress.completedRecipes,
      failedRecipes: progress.failedRecipes,
      currentRecipeId: progress.currentRecipeId,
      currentRecipeName: progress.currentRecipeName,
      percentComplete: progress.percentComplete,
      onboardingProgress: progress.onboardingProgress,
      checklist: progress.onboardingChecklist,
    });
  }

  function handleCancelSetup(): FridayAgentToolResult {
    setupAssistant.cancel();
    return jsonResult({ cancelled: true });
  }
}

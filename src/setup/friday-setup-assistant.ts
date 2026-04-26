/**
 * Setup Assistant — Zero-config onboarding orchestrator.
 *
 * Integrates the autonomous engine, setup recipes, environment scanner,
 * cross-tool coordinator, and prerequisite installer into a unified
 * "setup assistant" experience that bridges the onboarding engine.
 *
 * This is Phase 5: the final integration layer that ties everything together
 * so a beginner can go from zero to fully configured with a single action.
 *
 * @module setup
 */

import type {
  OnboardingChecklistItem,
  OnboardingEngine,
  OnboardingFlowDefinition,
  OnboardingProgress,
  OnboardingStepDefinition,
} from "../uix/engine/onboarding-engine.js";
import type {
  FridayEnvironmentScanner,
  FridaySetupRecipe,
  FridaySetupRecipeExecutor,
  FridaySetupRecipeRegistry,
  FridaySetupStepDomain,
} from "./friday-setup.types.js";
import type {
  FridaySetupCoordinator,
  FridaySetupToolDomain,
} from "./friday-setup-coordinator.types.js";
import type { FridayPrerequisiteInstaller } from "./friday-setup-prerequisite-installer.js";

// ─── Types ───

export type FridaySetupAssistantPhase =
  | "idle"
  | "scanning"
  | "planning"
  | "installing_prerequisites"
  | "executing_recipes"
  | "verifying"
  | "completed"
  | "failed";

/**
 * Describes an item in the setup assistant's plan.
 */
export interface FridaySetupAssistantPlanItem {
  readonly recipeId: string;
  readonly recipeName: string;
  readonly category: string;
  readonly targetService: string;
  readonly prerequisitesMet: boolean;
  readonly missingPrerequisites: readonly string[];
  /** Whether the user wants this recipe executed. */
  readonly enabled: boolean;
}

/**
 * Progress snapshot for display.
 */
export interface FridaySetupAssistantProgress {
  readonly phase: FridaySetupAssistantPhase;
  readonly totalRecipes: number;
  readonly completedRecipes: number;
  readonly failedRecipes: number;
  readonly pausedRecipes: number;
  readonly currentRecipeId: string | null;
  readonly currentRecipeName: string | null;
  readonly percentComplete: number;
  readonly onboardingProgress: OnboardingProgress | undefined;
  readonly onboardingChecklist: readonly OnboardingChecklistItem[];
}

/**
 * Result of the full setup assistant run.
 */
export interface FridaySetupAssistantResult {
  readonly phase: FridaySetupAssistantPhase;
  readonly totalRecipes: number;
  readonly completedRecipes: number;
  readonly failedRecipes: number;
  readonly pausedRecipes: number;
  readonly skippedRecipes: number;
  readonly results: readonly FridaySetupAssistantRecipeResult[];
  readonly durationMs: number;
}

export interface FridaySetupAssistantRecipeResult {
  readonly recipeId: string;
  readonly recipeName: string;
  readonly status: "completed" | "failed" | "skipped" | "paused_for_approval";
  readonly outputs: Readonly<Record<string, string>>;
  readonly failureReason?: string;
}

/**
 * The setup assistant interface — the highest-level API for end-to-end setup.
 */
export interface FridaySetupAssistant {
  /**
   * Scan the environment and plan which recipes to run.
   */
  planSetup(
    options?: FridaySetupAssistantPlanOptions,
  ): Promise<readonly FridaySetupAssistantPlanItem[]>;

  /**
   * Execute the full setup flow.
   *
   * This orchestrates:
   * 1. Environment scanning
   * 2. Prerequisite installation
   * 3. Recipe execution (with cross-tool coordination)
   * 4. Progress tracking via onboarding engine
   * 5. Companion overlay updates
   */
  executeSetup(
    options: FridaySetupAssistantExecuteOptions,
  ): Promise<FridaySetupAssistantResult>;

  /**
   * Get current progress during an active setup.
   */
  getProgress(): FridaySetupAssistantProgress;

  /**
   * Cancel an active setup.
   */
  cancel(): void;
}

export interface FridaySetupAssistantPlanOptions {
  /** Only plan for specific categories (e.g., "channel", "provider"). */
  readonly categories?: readonly string[];
  /** Only plan for specific services (e.g., "discord", "openai"). */
  readonly services?: readonly string[];
}

export interface FridaySetupAssistantExecuteOptions {
  /** Recipe IDs to execute. If empty, runs all planned recipes. */
  readonly recipeIds?: readonly string[];
  /** Whether to skip prerequisite installation. */
  readonly skipPrerequisites?: boolean;
  /** Principal ID for onboarding session tracking. */
  readonly principalId?: string;
  /** Abort signal. */
  readonly signal: AbortSignal;
}

// ─── Dependencies ───

export interface CreateFridaySetupAssistantDeps {
  readonly onboardingEngine: OnboardingEngine;
  readonly recipeRegistry: FridaySetupRecipeRegistry;
  readonly recipeExecutor: FridaySetupRecipeExecutor;
  readonly environmentScanner: FridayEnvironmentScanner;
  readonly coordinator: FridaySetupCoordinator;
  readonly prerequisiteInstaller: FridayPrerequisiteInstaller;

  /** Optional companion bridge for overlay progress display. */
  readonly companionBridge?: {
    setOverlayVisible(visible: boolean): Promise<{ visible: boolean; changedAt: string }>;
  };

  /** Optional event emitter for observability. */
  readonly eventEmitter?: {
    emit(event: string, payload: Record<string, unknown>): void;
  };

  readonly idGenerator: () => string;
  readonly nowIso: () => string;
}

// ─── Onboarding Flow Constants ───

const SETUP_FLOW_ID = "friday-auto-setup";
const SETUP_FLOW_VERSION = 1;

function mapSetupDomainToCoordinationDomain(
  domain: FridaySetupStepDomain,
): FridaySetupToolDomain | null {
  switch (domain) {
    case "browser":
    case "desktop":
    case "file":
      return domain;
    case "cli":
      return "exec";
    case "api":
      return "system";
    case "manual":
      return null;
  }
}

// ─── Factory ───

export function createFridaySetupAssistant(
  deps: CreateFridaySetupAssistantDeps,
): FridaySetupAssistant {
  const {
    onboardingEngine,
    recipeRegistry,
    recipeExecutor,
    environmentScanner,
    coordinator,
    prerequisiteInstaller,
    companionBridge,
    eventEmitter,
    idGenerator,
    nowIso,
  } = deps;

  // ─── Internal State ───

  let currentPhase: FridaySetupAssistantPhase = "idle";
  let currentRecipeId: string | null = null;
  let currentRecipeName: string | null = null;
  let completedRecipes = 0;
  let failedRecipes = 0;
  let pausedRecipes = 0;
  let totalRecipes = 0;
  let onboardingSessionId: string | null = null;
  let abortController: AbortController | null = null;
  const recipeResults: FridaySetupAssistantRecipeResult[] = [];

  function emit(event: string, payload: Record<string, unknown>): void {
    eventEmitter?.emit(event, payload);
  }

  /**
   * Build an onboarding flow from a list of recipes.
   */
  function buildOnboardingFlow(recipes: readonly FridaySetupRecipe[]): OnboardingFlowDefinition {
    const steps: OnboardingStepDefinition[] = [];

    // Environment scan step
    steps.push({
      id: "env-scan",
      title: "Environment Scan",
      description: "Detecting installed software and system capabilities",
      actionLabel: "Scanning...",
      icon: "search",
      sortOrder: 0,
      skippable: false,
    });

    // Prerequisite installation step
    steps.push({
      id: "prereq-install",
      title: "Install Prerequisites",
      description: "Installing missing software requirements",
      actionLabel: "Installing...",
      icon: "download",
      sortOrder: 1,
      skippable: true,
    });

    // One step per recipe
    for (let i = 0; i < recipes.length; i++) {
      const recipe = recipes[i];
      steps.push({
        id: `recipe-${recipe.id}`,
        title: recipe.name,
        description: recipe.description,
        actionLabel: `Configure ${recipe.targetService}`,
        icon: recipe.category === "channel" ? "message" : "settings",
        sortOrder: i + 2,
        skippable: true,
      });
    }

    // Verification step
    steps.push({
      id: "verify",
      title: "Verify Configuration",
      description: "Checking that all services are properly configured",
      actionLabel: "Verifying...",
      icon: "check",
      sortOrder: recipes.length + 2,
      skippable: false,
    });

    return {
      id: SETUP_FLOW_ID,
      name: "Friday Auto-Setup",
      description: "Automatically configure all required services",
      steps,
      enabled: true,
      version: SETUP_FLOW_VERSION,
    };
  }

  return {
    async planSetup(options) {
      const allRecipes = recipeRegistry.list({
        category: options?.categories?.[0] as FridaySetupRecipe["category"] | undefined,
        targetService: options?.services?.[0],
      });

      const planItems: FridaySetupAssistantPlanItem[] = [];

      for (const recipe of allRecipes) {
        // Check prerequisites
        const prereqResults = await recipeExecutor.checkPrerequisites(recipe.id);
        const missingPrereqs = prereqResults
          .filter((r) => !r.met)
          .map((r) => r.target);

        planItems.push({
          recipeId: recipe.id,
          recipeName: recipe.name,
          category: recipe.category,
          targetService: recipe.targetService,
          prerequisitesMet: missingPrereqs.length === 0,
          missingPrerequisites: missingPrereqs,
          enabled: true,
        });
      }

      return planItems;
    },

    async executeSetup(options) {
      const startTime = Date.now();
      abortController = new AbortController();
      const signal = options.signal;
      recipeResults.length = 0;
      completedRecipes = 0;
      failedRecipes = 0;
      pausedRecipes = 0;

      // Link external signal to internal controller
      signal.addEventListener("abort", () => abortController?.abort(), { once: true });

      try {
        // ─── Phase 1: Scanning ───
        currentPhase = "scanning";
        emit("setup.assistant.phase_changed", { phase: currentPhase });

        if (companionBridge) {
          await companionBridge.setOverlayVisible(true).catch(() => {});
        }

        const scanResult = await environmentScanner.scan();
        emit("setup.assistant.scan_completed", {
          os: scanResult.os,
          nodeVersion: scanResult.nodeVersion,
        });

        // ─── Phase 2: Planning ───
        currentPhase = "planning";
        emit("setup.assistant.phase_changed", { phase: currentPhase });

        // Determine which recipes to run
        let recipesToRun: FridaySetupRecipe[];
        if (options.recipeIds && options.recipeIds.length > 0) {
          recipesToRun = options.recipeIds
            .map((id) => recipeRegistry.list({}).find((r) => r.id === id))
            .filter((r): r is FridaySetupRecipe => r !== undefined);
        } else {
          recipesToRun = [...recipeRegistry.list({})];
        }

        totalRecipes = recipesToRun.length;

        // Build and register onboarding flow
        const flow = buildOnboardingFlow(recipesToRun);
        onboardingEngine.registerFlow(flow);

        const principalId = options.principalId ?? "default-user";
        const session = onboardingEngine.startSession(SETUP_FLOW_ID, principalId);
        onboardingSessionId = session?.id ?? null;

        if (!session) {
          currentPhase = "failed";
          return {
            phase: "failed" as const,
            totalRecipes,
            completedRecipes: 0,
            failedRecipes: 0,
            pausedRecipes: 0,
            skippedRecipes: totalRecipes,
            results: [],
            durationMs: Date.now() - startTime,
          };
        }

        // Complete the scan step
        onboardingEngine.completeStep(session.id, "env-scan", {
          os: scanResult.os,
          arch: scanResult.arch,
          nodeVersion: scanResult.nodeVersion ?? "",
        });

        // ─── Phase 3: Prerequisites ───
        if (!options.skipPrerequisites) {
          currentPhase = "installing_prerequisites";
          emit("setup.assistant.phase_changed", { phase: currentPhase });

          // Gather all prerequisite software needed
          const allPrereqs = new Set<string>();
          for (const recipe of recipesToRun) {
            for (const prereq of recipe.prerequisites) {
              if (prereq.type === "software_installed") {
                allPrereqs.add(prereq.target);
              }
            }
          }

          if (allPrereqs.size > 0) {
            const installResults = await prerequisiteInstaller.installAll(
              [...allPrereqs],
              abortController.signal,
            );

            emit("setup.assistant.prerequisites_completed", {
              results: installResults.map((r) => ({
                software: r.software,
                status: r.status,
              })),
            });
          }

          onboardingEngine.completeStep(session.id, "prereq-install", {
            prerequisitesChecked: "true",
          });
        } else {
          // Skip prerequisite step
          onboardingEngine.skipStep(session.id, "prereq-install");
        }

        // ─── Phase 4: Execute Recipes ───
        currentPhase = "executing_recipes";
        emit("setup.assistant.phase_changed", { phase: currentPhase });

        // Create a coordination session for the entire setup
        const coordSession = coordinator.createSession(
          SETUP_FLOW_ID,
          session.id,
        );

        for (const recipe of recipesToRun) {
          if (abortController.signal.aborted) {
            recipeResults.push({
              recipeId: recipe.id,
              recipeName: recipe.name,
              status: "skipped",
              outputs: {},
            });
            onboardingEngine.skipStep(session.id, `recipe-${recipe.id}`);
            continue;
          }

          currentRecipeId = recipe.id;
          currentRecipeName = recipe.name;

          emit("setup.assistant.recipe_started", {
            recipeId: recipe.id,
            recipeName: recipe.name,
          });

          try {
            // Determine initial coordination domain from the first executable step.
            const initialDomain = recipe.steps
              .map((step) => mapSetupDomainToCoordinationDomain(step.domain))
              .find((domain): domain is FridaySetupToolDomain => domain !== null);
            if (initialDomain) {
              coordinator.acquireDomain(coordSession.id, initialDomain, `Starting ${recipe.name}`);
            }

            // Execute the recipe
            const execution = await recipeExecutor.execute({
              recipeId: recipe.id,
              skipPrerequisites: true, // Already checked in phase 3
              signal: abortController.signal,
            });

            if (execution.status === "completed") {
              completedRecipes++;
              recipeResults.push({
                recipeId: recipe.id,
                recipeName: recipe.name,
                status: "completed",
                outputs: execution.outputs,
              });
              onboardingEngine.completeStep(session.id, `recipe-${recipe.id}`, {
                executionId: execution.id,
                status: "completed",
              });
            } else if (execution.status === "paused_for_approval") {
              pausedRecipes++;
              recipeResults.push({
                recipeId: recipe.id,
                recipeName: recipe.name,
                status: "paused_for_approval",
                outputs: execution.outputs,
                failureReason: execution.failureReason,
              });
              onboardingEngine.skipStep(session.id, `recipe-${recipe.id}`);
            } else {
              failedRecipes++;
              recipeResults.push({
                recipeId: recipe.id,
                recipeName: recipe.name,
                status: "failed",
                outputs: execution.outputs,
                failureReason: execution.failureReason,
              });
              // Skip the step since it failed (the recipe is skippable)
              onboardingEngine.skipStep(session.id, `recipe-${recipe.id}`);
            }

            emit("setup.assistant.recipe_completed", {
              recipeId: recipe.id,
              status: execution.status,
            });
          } catch (error) {
            failedRecipes++;
            const message = error instanceof Error ? error.message : String(error);
            recipeResults.push({
              recipeId: recipe.id,
              recipeName: recipe.name,
              status: "failed",
              outputs: {},
              failureReason: message,
            });
            onboardingEngine.skipStep(session.id, `recipe-${recipe.id}`);

            emit("setup.assistant.recipe_failed", {
              recipeId: recipe.id,
              error: message,
            });
          } finally {
            coordinator.releaseDomain(coordSession.id);
          }
        }

        // ─── Phase 5: Verification ───
        currentPhase = "verifying";
        emit("setup.assistant.phase_changed", { phase: currentPhase });

        onboardingEngine.completeStep(session.id, "verify", {
          completedRecipes: String(completedRecipes),
          failedRecipes: String(failedRecipes),
        });

        // Close the coordination session
        coordinator.closeSession(coordSession.id);

        // ─── Done ───
        const skippedRecipes = totalRecipes - completedRecipes - failedRecipes - pausedRecipes;
        currentPhase = failedRecipes === totalRecipes ? "failed" : "completed";
        currentRecipeId = null;
        currentRecipeName = null;

        emit("setup.assistant.completed", {
          phase: currentPhase,
          completedRecipes,
          failedRecipes,
          pausedRecipes,
          skippedRecipes,
        });

        if (companionBridge) {
          await companionBridge.setOverlayVisible(false).catch(() => {});
        }

        return {
          phase: currentPhase,
          totalRecipes,
          completedRecipes,
          failedRecipes,
          pausedRecipes,
          skippedRecipes,
          results: recipeResults,
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        currentPhase = "failed";
        const message = error instanceof Error ? error.message : String(error);
        emit("setup.assistant.failed", { error: message });

        if (companionBridge) {
          await companionBridge.setOverlayVisible(false).catch(() => {});
        }

        return {
          phase: "failed" as const,
          totalRecipes,
          completedRecipes,
          failedRecipes,
          pausedRecipes,
          skippedRecipes: totalRecipes - completedRecipes - failedRecipes - pausedRecipes,
          results: recipeResults,
          durationMs: Date.now() - startTime,
        };
      }
    },

    getProgress() {
      let onboardingProgress: OnboardingProgress | undefined;
      let onboardingChecklist: readonly OnboardingChecklistItem[] = [];

      if (onboardingSessionId) {
        onboardingProgress = onboardingEngine.getProgress(onboardingSessionId) ?? undefined;
        onboardingChecklist = onboardingEngine.getChecklist(onboardingSessionId);
      }

      const percent = totalRecipes > 0
        ? Math.round(((completedRecipes + failedRecipes + pausedRecipes) / totalRecipes) * 100)
        : 0;

      return {
        phase: currentPhase,
        totalRecipes,
        completedRecipes,
        failedRecipes,
        pausedRecipes,
        currentRecipeId,
        currentRecipeName,
        percentComplete: percent,
        onboardingProgress,
        onboardingChecklist,
      };
    },

    cancel() {
      abortController?.abort();
      currentPhase = "failed";
      emit("setup.assistant.cancelled", {});
    },
  };
}

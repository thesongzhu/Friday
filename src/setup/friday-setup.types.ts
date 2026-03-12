/**
 * Setup Recipe Framework — Domain Model and Data Contract.
 *
 * Declarative recipes that describe how to configure external services
 * (messaging platforms, LLM providers, etc.) using the autonomous engine.
 *
 * A recipe is a sequence of steps with prerequisites, verification checks,
 * and error recovery paths. The executor bridges recipes to the autonomous
 * perception-action loop for end-to-end automated configuration.
 *
 * @module setup
 */

// ─── Foundational Value Types ───

/** UUID string identifier. */
export type UUID = string;

/** ISO 8601 date-time string. */
export type ISODateTime = string;

// ═══════════════════════════════════════════════════════════════════════
// RECIPE MODEL
// ═══════════════════════════════════════════════════════════════════════

/**
 * Categories of setup recipes.
 */
export type FridaySetupRecipeCategory =
  | "provider"
  | "channel"
  | "integration"
  | "environment"
  | "security";

/**
 * How a recipe step interacts with the user's system.
 */
export type FridaySetupStepDomain =
  | "browser"
  | "desktop"
  | "cli"
  | "api"
  | "file"
  | "manual";

/**
 * Risk level of a recipe step.
 */
export type FridaySetupStepRisk = "low" | "medium" | "high" | "critical";

/**
 * A declarative setup recipe describing how to configure a service.
 *
 * Recipes are registered in the SetupRecipeRegistry and executed by
 * the SetupRecipeExecutor, which bridges to the autonomous engine.
 */
export interface FridaySetupRecipe {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: FridaySetupRecipeCategory;

  /** Version of this recipe (semver). */
  readonly version: string;

  /** What this recipe configures (e.g., "discord", "openai", "node"). */
  readonly targetService: string;

  /** Optional icon/emoji for UI display. */
  readonly icon?: string;

  /** Prerequisites that must be met before running this recipe. */
  readonly prerequisites: readonly FridaySetupPrerequisite[];

  /** Ordered steps to execute. */
  readonly steps: readonly FridaySetupRecipeStep[];

  /** Outputs this recipe produces (e.g., API keys, tokens). */
  readonly outputs: readonly FridaySetupRecipeOutput[];

  /** Estimated time in seconds (for UI display only). */
  readonly estimatedTimeSeconds?: number;

  /** URLs with documentation / help for manual fallback. */
  readonly helpUrls?: readonly string[];
}

// ═══════════════════════════════════════════════════════════════════════
// PREREQUISITES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Type of prerequisite check.
 */
export type FridaySetupPrerequisiteType =
  | "software_installed"
  | "software_version"
  | "network_reachable"
  | "file_exists"
  | "env_var_set"
  | "os_matches"
  | "recipe_completed";

/**
 * A prerequisite that must be met before executing a recipe.
 */
export interface FridaySetupPrerequisite {
  readonly type: FridaySetupPrerequisiteType;
  readonly description: string;

  /** What to check (command name, URL, file path, env var, OS, recipe ID). */
  readonly target: string;

  /** Expected value (version range, "true", OS name). */
  readonly expected?: string;

  /** Whether this prerequisite is hard (blocks) or soft (warns). */
  readonly blocking: boolean;

  /** Instruction for how to satisfy this prerequisite if not met. */
  readonly fixInstruction?: string;

  /** Recipe ID that can auto-fix this prerequisite. */
  readonly autoFixRecipeId?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// RECIPE STEPS
// ═══════════════════════════════════════════════════════════════════════

/**
 * A single step in a setup recipe.
 */
export interface FridaySetupRecipeStep {
  readonly id: string;
  readonly index: number;
  readonly domain: FridaySetupStepDomain;
  readonly risk: FridaySetupStepRisk;

  /** Human-readable instruction for this step. */
  readonly instruction: string;

  /** Detailed guidance for the autonomous engine. */
  readonly guidance: string;

  /** Whether this step requires user approval before execution. */
  readonly requiresApproval: boolean;

  /** How to verify this step succeeded. */
  readonly verification?: FridaySetupStepVerification;

  /** Alternative approaches if the primary approach fails. */
  readonly alternatives?: readonly FridaySetupRecipeStepAlternative[];

  /** Maximum retries for this step (default: 2). */
  readonly maxRetries: number;

  /** Output keys this step produces (matched to recipe outputs). */
  readonly outputKeys?: readonly string[];

  /** Input keys this step needs from previous steps. */
  readonly inputKeys?: readonly string[];
}

/**
 * Verification for a recipe step.
 */
export interface FridaySetupStepVerification {
  /** How to verify: screenshot analysis, element check, CLI output, API call. */
  readonly method: "visual" | "element" | "cli_output" | "api_call" | "file_content";
  /** What to check for. */
  readonly expected: string;
  /** Description of what successful verification looks like. */
  readonly description: string;
}

/**
 * Alternative approach for a step (used when primary fails).
 */
export interface FridaySetupRecipeStepAlternative {
  readonly domain: FridaySetupStepDomain;
  readonly instruction: string;
  readonly guidance: string;
  readonly verification?: FridaySetupStepVerification;
}

// ═══════════════════════════════════════════════════════════════════════
// RECIPE OUTPUTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * An output produced by a recipe (e.g., API key, token, config path).
 */
export interface FridaySetupRecipeOutput {
  /** Key name for referencing this output. */
  readonly key: string;
  /** Human-readable label. */
  readonly label: string;
  /** Whether this is a secret (should be stored encrypted). */
  readonly sensitive: boolean;
  /** Target config path where this value should be written. */
  readonly configPath?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// EXECUTION MODEL
// ═══════════════════════════════════════════════════════════════════════

/**
 * Execution status of a recipe run.
 */
export type FridaySetupExecutionStatus =
  | "pending"
  | "checking_prerequisites"
  | "executing"
  | "paused_for_approval"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * A single recipe execution record.
 */
export interface FridaySetupExecution {
  readonly id: UUID;
  readonly recipeId: string;
  readonly status: FridaySetupExecutionStatus;

  /** Which step is currently being executed (index). */
  readonly currentStepIndex: number;

  /** Per-step execution results. */
  readonly stepResults: readonly FridaySetupStepResult[];

  /** Extracted outputs from completed steps. */
  readonly outputs: Readonly<Record<string, string>>;

  /** Prerequisite check results. */
  readonly prerequisiteResults: readonly FridaySetupPrerequisiteResult[];

  readonly createdAt: ISODateTime;
  readonly startedAt?: ISODateTime;
  readonly completedAt?: ISODateTime;
  readonly failureReason?: string;

  /** ID of the autonomous goal driving this execution. */
  readonly autonomousGoalId?: UUID;
}

/**
 * Result of a single step execution.
 */
export interface FridaySetupStepResult {
  readonly stepId: string;
  readonly status: "pending" | "executing" | "completed" | "failed" | "skipped";
  readonly outputs: Readonly<Record<string, string>>;
  readonly startedAt?: ISODateTime;
  readonly completedAt?: ISODateTime;
  readonly failureReason?: string;
  /** Which approach was used (0 = primary, 1+ = alternative). */
  readonly approachIndex: number;
}

/**
 * Result of a prerequisite check.
 */
export interface FridaySetupPrerequisiteResult {
  readonly type: FridaySetupPrerequisite["type"];
  readonly target: string;
  readonly met: boolean;
  readonly actual?: string;
  readonly fixInstruction?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// REGISTRY INTERFACE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Registry of available setup recipes.
 */
export interface FridaySetupRecipeRegistry {
  /** Register a new recipe. */
  register(recipe: FridaySetupRecipe): void;
  /** Get a recipe by ID. */
  get(recipeId: string): FridaySetupRecipe | null;
  /** List all recipes, optionally filtered. */
  list(filters?: FridaySetupRecipeListFilters): readonly FridaySetupRecipe[];
  /** Get recipes for a specific target service. */
  getByTarget(targetService: string): FridaySetupRecipe | null;
}

/** Filters for listing recipes. */
export interface FridaySetupRecipeListFilters {
  readonly category?: FridaySetupRecipeCategory;
  readonly targetService?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// EXECUTOR INTERFACE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Executes setup recipes using the autonomous engine.
 */
export interface FridaySetupRecipeExecutor {
  /**
   * Execute a recipe by ID.
   * Returns the execution result with extracted outputs.
   */
  execute(params: FridaySetupExecuteParams): Promise<FridaySetupExecution>;

  /** Check prerequisites for a recipe without executing it. */
  checkPrerequisites(recipeId: string): Promise<readonly FridaySetupPrerequisiteResult[]>;

  /** Get status of a running execution. */
  getExecution(executionId: UUID): FridaySetupExecution | null;

  /** Cancel a running execution. */
  cancelExecution(executionId: UUID): void;

  /** List recent executions. */
  listExecutions(filters?: FridaySetupExecutionListFilters): readonly FridaySetupExecution[];
}

/** Parameters for executing a recipe. */
export interface FridaySetupExecuteParams {
  readonly recipeId: string;
  /** Pre-supplied input values (e.g., email, API key the user already has). */
  readonly inputs?: Readonly<Record<string, string>>;
  /** Whether to skip prerequisite checks. */
  readonly skipPrerequisites?: boolean;
  /** Abort signal. */
  readonly signal?: AbortSignal;
}

/** Filters for listing executions. */
export interface FridaySetupExecutionListFilters {
  readonly recipeId?: string;
  readonly status?: FridaySetupExecutionStatus;
  readonly limit?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// ENVIRONMENT SCANNER
// ═══════════════════════════════════════════════════════════════════════

/**
 * Scans the local environment for installed software, versions, and configuration.
 */
export interface FridayEnvironmentScanner {
  /** Check if a command/software is installed. */
  isInstalled(command: string): Promise<boolean>;
  /** Get the version of installed software. */
  getVersion(command: string): Promise<string | null>;
  /** Check if a URL is reachable. */
  isReachable(url: string, timeoutMs?: number): Promise<boolean>;
  /** Check if a file exists. */
  fileExists(path: string): Promise<boolean>;
  /** Get the value of an environment variable. */
  getEnvVar(name: string): string | undefined;
  /** Get the current OS. */
  getOs(): string;
  /** Run a full environment scan and return results. */
  scan(): Promise<FridayEnvironmentScanResult>;
}

/**
 * Result of a full environment scan.
 */
export interface FridayEnvironmentScanResult {
  readonly os: string;
  readonly arch: string;
  readonly nodeVersion: string | null;
  readonly npmVersion: string | null;
  readonly pythonVersion: string | null;
  readonly gitVersion: string | null;
  readonly dockerVersion: string | null;
  readonly installedBrowsers: readonly string[];
  readonly networkConnectivity: boolean;
}

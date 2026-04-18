/**
 * Autonomous Perception-Action Loop — Domain Model and Data Contract.
 *
 * Canonical types for Friday's goal-driven autonomous execution engine.
 * Enables the agent to observe the environment (screenshots + accessibility),
 * reason about what to do next, execute actions, and verify outcomes —
 * looping until the goal is achieved or the attempt budget is exhausted.
 *
 * This is the "conductor" layer that composes desktop, browser, and
 * system tool primitives into end-to-end autonomous task completion.
 *
 * @module agent/autonomous
 */

// ─── Foundational Value Types ───

/** UUID string identifier. */
export type UUID = string;

/** ISO 8601 date-time string. */
export type ISODateTime = string;

// ═══════════════════════════════════════════════════════════════════════
// GOAL MODEL
// ═══════════════════════════════════════════════════════════════════════

/**
 * Goal lifecycle states.
 *
 * ```
 * pending → planning → executing → verifying ─┬→ completed
 *                  ↑              │             ├→ failed
 *                  └──────────────┘ (retry)     ├→ interrupted_recoverable → resumed → planning
 *                                               ├→ interrupted_nonrecoverable
 *                                               └→ cancelled
 * ```
 */
export type FridayAutonomousGoalStatus =
  | "pending"
  | "planning"
  | "executing"
  | "verifying"
  | "interrupted_recoverable"
  | "interrupted_nonrecoverable"
  | "resumed"
  | "completed"
  | "failed"
  | "cancelled";

/** How urgently the goal should be pursued. */
export type FridayAutonomousGoalPriority = "low" | "normal" | "high" | "critical";

/** Where the goal was triggered from. */
export type FridayAutonomousGoalSource = "user" | "assistant" | "recipe" | "self_heal" | "schedule";

/**
 * A high-level goal that the autonomous agent should achieve.
 *
 * Goals are decomposed into steps by the planning phase, then executed
 * one step at a time with perception verification after each step.
 */
export interface FridayAutonomousGoal {
  readonly id: UUID;
  readonly status: FridayAutonomousGoalStatus;
  readonly priority: FridayAutonomousGoalPriority;
  readonly source: FridayAutonomousGoalSource;

  /** Human-readable description of what should be achieved. */
  readonly description: string;

  /** Optional structured success criteria for verification. */
  readonly successCriteria?: readonly FridayAutonomousVerificationCheck[];

  /** Maximum number of perception-action iterations before giving up. */
  readonly maxIterations: number;

  /** Maximum wall-clock time in milliseconds. */
  readonly timeoutMs: number;

  /** Current iteration count. */
  readonly iterationCount: number;

  /** IDs of steps produced by the planning phase. */
  readonly stepIds: readonly UUID[];

  /** Index into stepIds — which step is currently active. */
  readonly currentStepIndex: number;

  /** Optional parent goal ID (for sub-goal decomposition). */
  readonly parentGoalId?: UUID;

  readonly createdAt: ISODateTime;
  readonly startedAt?: ISODateTime;
  readonly completedAt?: ISODateTime;
  readonly failureReason?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// STEP MODEL
// ═══════════════════════════════════════════════════════════════════════

/** Step lifecycle mirrors goal lifecycle at a finer grain. */
export type FridayAutonomousStepStatus =
  | "pending"
  | "executing"
  | "verifying"
  | "interrupted_recoverable"
  | "interrupted_nonrecoverable"
  | "resumed"
  | "completed"
  | "failed"
  | "skipped";

/**
 * Which tool domain a step targets.
 *
 * The autonomous loop uses this to route perception and action
 * to the correct subsystem (desktop accessibility, browser DOM, or shell).
 */
export type FridayAutonomousStepDomain =
  | "desktop"
  | "browser"
  | "exec"
  | "file"
  | "composite";

/** Which verification path ultimately produced the current step verdict. */
export type FridayAutonomousVerificationMethod =
  | "deterministic_file"
  | "deterministic_browser"
  | "llm_text"
  | "llm_vision";

/** Which deterministic file-phrase family matched, when applicable. */
export type FridayAutonomousVerificationPatternFamily =
  | "exact_text"
  | "contains_text"
  | "with_content"
  | "contains_content"
  | "exact_content"
  | "content_is"
  | "contents_are"
  | "content_colon"
  | "contents_colon";

/**
 * A single actionable step within an autonomous goal.
 *
 * Steps are ordered and executed sequentially. Each step has its own
 * perception → action → verification micro-loop.
 */
export interface FridayAutonomousStep {
  readonly id: UUID;
  readonly goalId: UUID;
  readonly index: number;
  readonly status: FridayAutonomousStepStatus;
  readonly domain: FridayAutonomousStepDomain;

  /** Human-readable instruction for this step. */
  readonly instruction: string;

  /** Tool name + arguments the agent intends to use. */
  readonly plannedAction?: FridayAutonomousPlannedAction;

  /** How to verify this step succeeded. */
  readonly verification?: FridayAutonomousVerificationCheck;

  /** Which verification path produced the latest verdict for this step. */
  readonly verificationMethod?: FridayAutonomousVerificationMethod;

  /** Latest verification readback captured for the step. */
  readonly verificationActual?: string;

  /** Which deterministic phrase family matched, when applicable. */
  readonly verificationPatternFamily?: FridayAutonomousVerificationPatternFamily;

  /** Number of retry attempts allowed for this step. */
  readonly maxRetries: number;

  /** Current retry count. */
  readonly retryCount: number;

  /** Observations collected during this step's execution. */
  readonly observations: readonly FridayAutonomousObservation[];

  readonly startedAt?: ISODateTime;
  readonly completedAt?: ISODateTime;
  readonly failureReason?: string;
}

/**
 * A planned tool invocation.
 */
export interface FridayAutonomousPlannedAction {
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** Optional natural-language rationale for why this action was chosen. */
  readonly rationale?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// PERCEPTION MODEL
// ═══════════════════════════════════════════════════════════════════════

/**
 * Observation source — what kind of perception produced this observation.
 */
export type FridayAutonomousObservationSource =
  | "screenshot"
  | "accessibility_tree"
  | "dom_snapshot"
  | "tool_result"
  | "error";

/**
 * A single observation from the environment.
 *
 * Observations are the input to the VLM/LLM reasoning step.
 * They can be visual (screenshots), structural (accessibility trees),
 * or textual (tool results, errors).
 */
export interface FridayAutonomousObservation {
  readonly id: UUID;
  readonly stepId: UUID;
  readonly source: FridayAutonomousObservationSource;
  readonly timestamp: ISODateTime;

  /** Base64-encoded screenshot (when source is "screenshot"). */
  readonly screenshotBase64?: string;

  /** Structured accessibility/DOM data (when source is "accessibility_tree" or "dom_snapshot"). */
  readonly structuredData?: string;

  /** Text content (when source is "tool_result" or "error"). */
  readonly textContent?: string;

  /** Optional analysis from the VLM about what this observation shows. */
  readonly vlmAnalysis?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// VERIFICATION MODEL
// ═══════════════════════════════════════════════════════════════════════

/**
 * How to verify that a step or goal succeeded.
 */
export type FridayAutonomousVerificationType =
  | "visual"
  | "element_exists"
  | "element_text"
  | "url_matches"
  | "file_exists"
  | "command_output"
  | "llm_judge";

/**
 * A single verification check.
 */
export interface FridayAutonomousVerificationCheck {
  readonly type: FridayAutonomousVerificationType;
  /** Human-readable description of what is being checked. */
  readonly description: string;

  /** Expected value / pattern / element selector depending on type. */
  readonly expected?: string;

  /** Whether this check passed. Set after execution. */
  readonly passed?: boolean;

  /** Actual observed value. Set after execution. */
  readonly actual?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// LOOP ITERATION MODEL
// ═══════════════════════════════════════════════════════════════════════

/**
 * Decision the LLM makes at each iteration of the perception-action loop.
 */
export type FridayAutonomousDecision =
  | { readonly kind: "act"; readonly action: FridayAutonomousPlannedAction }
  | { readonly kind: "verify"; readonly checks: readonly FridayAutonomousVerificationCheck[] }
  | { readonly kind: "replan"; readonly reason: string; readonly newSteps: readonly string[] }
  | { readonly kind: "delegate"; readonly subGoalDescription: string }
  | { readonly kind: "ask_user"; readonly question: string }
  | { readonly kind: "abort"; readonly reason: string }
  | { readonly kind: "complete"; readonly summary: string };

/**
 * A single iteration of the autonomous perception-action loop.
 */
export interface FridayAutonomousIteration {
  readonly id: UUID;
  readonly goalId: UUID;
  readonly stepId: UUID;
  readonly index: number;
  readonly timestamp: ISODateTime;

  /** Observations gathered before deciding. */
  readonly observations: readonly FridayAutonomousObservation[];

  /** The LLM's reasoning about the current state. */
  readonly reasoning: string;

  /** The decision made based on observations and reasoning. */
  readonly decision: FridayAutonomousDecision;

  /** Result of executing the decision. */
  readonly result?: FridayAutonomousActionResult;

  /** Duration of this iteration in milliseconds. */
  readonly durationMs: number;

  /** Token usage for LLM calls in this iteration. */
  readonly usageInput?: number;
  readonly usageOutput?: number;
}

/**
 * Result of executing an action within the loop.
 */
export interface FridayAutonomousActionResult {
  readonly success: boolean;
  readonly toolName: string;
  readonly output: string;
  readonly errorMessage?: string;
  /** Screenshot taken after the action (for visual verification). */
  readonly screenshotAfter?: string;
  /** Browser title captured immediately after a browser action. */
  readonly browserTitle?: string;
  /** Browser URL captured immediately after a browser action. */
  readonly browserUrl?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// ENGINE CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Configuration for the autonomous perception-action loop engine.
 */
export interface FridayAutonomousEngineConfig {
  /** Maximum iterations per goal (default: 50). */
  readonly maxIterationsPerGoal: number;

  /** Maximum time per goal in ms (default: 300_000 = 5 minutes). */
  readonly maxTimePerGoalMs: number;

  /** Maximum retries per step (default: 3). */
  readonly maxRetriesPerStep: number;

  /** Whether to take a screenshot before each decision (default: true). */
  readonly screenshotBeforeDecision: boolean;

  /** Whether to capture accessibility/DOM snapshots before each decision (default: true). */
  readonly structuredSnapshotBeforeDecision: boolean;

  /** Delay between iterations in ms to avoid overwhelming the system (default: 500). */
  readonly iterationDelayMs: number;

  /** Whether user approval is required before executing high-risk actions (default: true). */
  readonly requireApprovalForHighRisk: boolean;

  /** VLM model to use for screenshot analysis (uses default vision model if unset). */
  readonly vlmModel?: string;

  /** Planning LLM model (uses default model if unset). */
  readonly planningModel?: string;
}

/** Sensible defaults for autonomous engine configuration. */
export const FRIDAY_AUTONOMOUS_DEFAULT_CONFIG: Readonly<FridayAutonomousEngineConfig> = {
  maxIterationsPerGoal: 50,
  maxTimePerGoalMs: 300_000,
  maxRetriesPerStep: 3,
  screenshotBeforeDecision: true,
  structuredSnapshotBeforeDecision: true,
  iterationDelayMs: 500,
  requireApprovalForHighRisk: true,
};

// ═══════════════════════════════════════════════════════════════════════
// ENGINE INTERFACE
// ═══════════════════════════════════════════════════════════════════════

/** Events emitted during autonomous goal execution. */
export type FridayAutonomousEventName =
  | "autonomous.goal.created"
  | "autonomous.goal.started"
  | "autonomous.goal.completed"
  | "autonomous.goal.failed"
  | "autonomous.goal.cancelled"
  | "autonomous.step.started"
  | "autonomous.step.completed"
  | "autonomous.step.failed"
  | "autonomous.step.skipped"
  | "autonomous.iteration.started"
  | "autonomous.iteration.completed"
  | "autonomous.observation.captured"
  | "autonomous.decision.made"
  | "autonomous.action.executed"
  | "autonomous.verification.completed"
  | "autonomous.approval.requested"
  | "autonomous.approval.received";

/**
 * Autonomous engine — the public interface for goal-driven execution.
 *
 * Callers submit a goal description and get back a result.
 * The engine handles planning, perception, action, and verification internally.
 */
export interface FridayAutonomousEngine {
  /**
   * Execute an autonomous goal.
   *
   * This is the main entry point. The engine will:
   * 1. Plan: decompose the goal into steps
   * 2. For each step: observe → reason → act → verify
   * 3. Return the final result
  */
  executeGoal(params: FridayAutonomousGoalParams): Promise<FridayAutonomousGoalResult>;

  /**
   * Resume an existing goal from durable state when the interruption is known
   * to be safe to resume from a checkpoint or to rebuild the plan safely.
   */
  resumeGoal(params: FridayAutonomousResumeGoalParams): Promise<FridayAutonomousGoalResult>;

  /** Cancel a running goal by ID. */
  cancelGoal(goalId: UUID): void;

  /** Get the current status of a goal. */
  getGoal(goalId: UUID): FridayAutonomousGoal | null;

  /** List recent goals. */
  listGoals(filters?: FridayAutonomousGoalListFilters): readonly FridayAutonomousGoal[];

  /** Get iterations for a goal (for observability). */
  getIterations(goalId: UUID): readonly FridayAutonomousIteration[];
}

/**
 * Parameters for starting an autonomous goal.
 */
export interface FridayAutonomousGoalParams {
  /** What to achieve (natural language). */
  readonly description: string;
  /** Optional structured success criteria. */
  readonly successCriteria?: readonly FridayAutonomousVerificationCheck[];
  /** Optional priority (default: "normal"). */
  readonly priority?: FridayAutonomousGoalPriority;
  /** Optional source (default: "user"). */
  readonly source?: FridayAutonomousGoalSource;
  /** Optional config overrides. */
  readonly config?: Partial<FridayAutonomousEngineConfig>;
  /** Optional abort signal. */
  readonly signal?: AbortSignal;
  /** Optional timezone for time-sensitive internal runs. */
  readonly timezone?: string;
  /** Optional principal for policy, memory, and tenant scoping. */
  readonly principalId?: string;
  /** Optional tenant routing context for provider resolution. */
  readonly tenantContext?: FridayProviderTenantContext;
  /** Optional provider pin inherited from the parent agent run. */
  readonly providerId?: string;
  /** Optional model pin inherited from the parent agent run. */
  readonly model?: string;
  /** Optional parent goal ID for sub-goal decomposition. */
  readonly parentGoalId?: UUID;
  /** Optional context from a setup recipe. */
  readonly recipeContext?: FridayAutonomousRecipeContext;
}

/**
 * Parameters for resuming an existing autonomous goal.
 */
export interface FridayAutonomousResumeGoalParams {
  /** Goal ID to resume. */
  readonly goalId: UUID;
  /** Optional abort signal. */
  readonly signal?: AbortSignal;
  /** Optional timezone for time-sensitive internal runs. */
  readonly timezone?: string;
  /** Optional principal for policy, memory, and tenant scoping. */
  readonly principalId?: string;
  /** Optional tenant routing context for provider resolution. */
  readonly tenantContext?: FridayProviderTenantContext;
  /** Optional provider pin inherited from the parent agent run. */
  readonly providerId?: string;
  /** Optional model pin inherited from the parent agent run. */
  readonly model?: string;
}

/**
 * Context passed from a setup recipe to guide the autonomous loop.
 */
export interface FridayAutonomousRecipeContext {
  /** Recipe ID being executed. */
  readonly recipeId: string;
  /** Current recipe step index. */
  readonly recipeStepIndex: number;
  /** Hints about what tools/domains to use. */
  readonly domainHints: readonly FridayAutonomousStepDomain[];
  /** Pre-computed step instructions from the recipe. */
  readonly stepHints?: readonly string[];
}

/**
 * Result of an autonomous goal execution.
 */
export interface FridayAutonomousGoalResult {
  readonly goalId: UUID;
  readonly status: "completed" | "failed" | "cancelled";
  /** Human-readable summary of what was accomplished. */
  readonly summary: string;
  /** Detailed failure reason (when status is "failed"). */
  readonly failureReason?: string;
  /** Total number of perception-action iterations used. */
  readonly iterationCount: number;
  /** Total wall-clock duration in ms. */
  readonly durationMs: number;
  /** Total LLM token usage. */
  readonly usageInput: number;
  readonly usageOutput: number;
  /** Extracted outputs (e.g., API keys, tokens, URLs found during execution). */
  readonly extractedOutputs?: Readonly<Record<string, string>>;
}

/** Filters for listing goals. */
export interface FridayAutonomousGoalListFilters {
  readonly status?: FridayAutonomousGoalStatus;
  readonly source?: FridayAutonomousGoalSource;
  readonly parentGoalId?: UUID;
  readonly limit?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// FACTORY DEPENDENCIES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Dependencies injected into the autonomous engine factory.
 *
 * Following the same pattern as CreateFridayAgentRuntimeDeps.
 */
export interface CreateFridayAutonomousEngineDeps {
  /** Agent runtime for executing tool calls. */
  readonly agentRuntime: {
    executeRun(params: {
      task: string;
      images?: string[];
      sessionKey?: string;
      runId?: string;
      providerId?: string;
      model?: string;
      timezone?: string;
      principalId?: string;
      tenantContext?: FridayProviderTenantContext;
      executionContext?: {
        surface?: string;
      };
      constraints?: {
        readOnly?: boolean;
        operationalMode?: "plan" | "execute" | "restricted";
      };
      timeoutMs?: number;
      signal?: AbortSignal;
    }): Promise<{ runId: string; status: string; response: string; usageInput: number; usageOutput: number }>;
  };

  /** Optional direct tool executor that bypasses an extra agent run for known tool calls. */
  readonly toolExecutor?: (
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<{
    content: string;
    isError?: boolean;
    metadata?: Record<string, unknown>;
  }>;

  /** Image analysis function for VLM perception. */
  readonly analyzeImages: (
    request: {
      prompt: string;
      images: readonly { type: "base64" | "url"; data?: string; url?: string; mimeType?: string }[];
      providerId?: string;
      model?: string;
      detail: "low" | "high" | "auto";
      maxTokens?: number;
    },
    signal: AbortSignal,
  ) => Promise<{ text: string; model: string; inputTokens?: number; outputTokens?: number }>;

  /** Desktop session manager for desktop perception/actions. */
  readonly desktopSessionManager?: {
    isConnected(): boolean;
    executeAction(action: Record<string, unknown>): Promise<{
      id: string;
      action: { type: string };
      status: string;
      durationMs: number;
      errorMessage?: string;
      screenshotBase64?: string;
      elementData?: unknown;
      clipboardContent?: string;
    }>;
    searchElements(query: string, appBundleId?: string): Promise<unknown[]>;
  };

  /** Browser manager for web perception/actions. */
  readonly browserManager?: {
    launch?(sessionId: string): Promise<void>;
    close?(sessionId: string): Promise<void>;
    screenshot(sessionId: string): Promise<{ base64: string }>;
    snapshot(sessionId: string): Promise<{ content: string }>;
    title?(sessionId: string): Promise<{ title: string }>;
    url?(sessionId: string): Promise<{ url: string }>;
    act(sessionId: string, action: string, args: Record<string, unknown>): Promise<unknown>;
    navigate(sessionId: string, url: string): Promise<void>;
  };

  /** ID generator. */
  readonly idGenerator: () => UUID;

  /** ISO timestamp factory. */
  readonly nowIso: () => ISODateTime;

  /** Optional event emitter for observability. */
  readonly eventEmitter?: {
    emit(event: FridayAutonomousEventName, payload: Record<string, unknown>): void;
  };

  /** Engine configuration overrides. */
  readonly config?: Partial<FridayAutonomousEngineConfig>;

  /** Optional SQLite persistence for goal/step/iteration state. When provided, enables write-through to survive restarts. */
  readonly persistence?: {
    readonly sqlite: {
      withWriteTransaction<T>(fn: (db: Database.Database) => T): T;
      withReadConnection<T>(fn: (db: Database.Database) => T): T;
    };
    readonly repository: FridayAutonomousRepository;
  };
}
import type { FridayProviderTenantContext } from "#providers";
import type Database from "better-sqlite3";
import type { FridayAutonomousRepository } from "./friday-autonomous-repository.js";

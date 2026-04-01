/**
 * Unified Orchestration Engine contract — Initiative A.
 *
 * Formalises the implicit unification that already exists in
 * `executeAgentRunWithSessionContext()` into explicit, typed interfaces.
 *
 * All entry points (API, channel, CLI, automation) construct a
 * `FridayEngineRunInput` and receive a `FridayEngineRunResult`.
 */

import type { FridayAgentContextCostSummary, FridayAgentConversationContext, FridayAgentExecutionContext } from "../agent/runtime/friday-agent-runtime.types.js";
import type { FridayAgentTaskProfileInput, FridayResolvedAgentTaskProfile } from "../agent/runtime/friday-agent-task-profile.js";
import type { FridayAgentRunConstraints } from "../agent/model/friday-agent.types.js";
import type { FridayConversationTurnKind } from "../sessions/model/friday-session.types.js";
import type { FridayProviderTenantContext } from "#providers";

// ─── Engine input ───

/** Unified input accepted by every entry adapter. */
export interface FridayEngineRunInput {
  /** The user task / message text. */
  task: string;
  /** Caller-supplied or auto-generated run identifier. */
  runId: string;
  /** Session to operate within (determines history / focus). */
  sessionKey?: string;
  /** Preferred LLM provider. */
  providerId?: string;
  /** Tenant/user/channel context for provider credential routing. */
  tenantContext?: FridayProviderTenantContext;
  /** Preferred model override. */
  model?: string;
  /** If the message is a reply, the referenced message id. */
  replyToMessageId?: string;
  /** IANA timezone of the caller. */
  timezone?: string;
  /** Hard timeout for the entire run (ms). */
  timeoutMs?: number;
  /** Cooperative cancellation signal. */
  signal?: AbortSignal;
  /** Whether this run requires plan review before execution. */
  reviewRequired?: boolean;
  /** Per-run execution constraints (e.g. readOnly). */
  constraints?: FridayAgentRunConstraints;
  /** Principal id for policy evaluation and audit. */
  principalId?: string;
  /** Authorization scopes for policy evaluation. */
  scopes?: string[];
  /** Per-run hard blocklist of tool names. */
  disabledToolNames?: string[];
  /** Surface / runtime context for tool routing. */
  executionContext?: FridayAgentExecutionContext;
  /** Model-routing / temperature profile. */
  taskProfile?: FridayAgentTaskProfileInput;
  /** Optional image URLs to include as inline vision content. */
  images?: string[];
  /**
   * When true the session store already contains the user message —
   * the engine must not persist it again.
   */
  taskAlreadyInHistory?: boolean;
  /** Idempotency prefix for dedup of session messages. */
  idempotencyPrefix?: string;
}

// ─── Terminal status & error taxonomy ───

/**
 * Terminal status — every engine run ends in one of these.
 *
 * Maps from the broader `FridayAgentRunStatus` union, collapsing
 * transient states (pending, planning, executing, testing, fixing)
 * into the terminal outcomes only.
 */
export type FridayRunTerminalStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "awaiting_clarification"
  | "awaiting_plan_approval"
  | "failed_tests"
  | "timeout";

/** Error classification for observability and caller recovery logic. */
export type FridayRunErrorCategory =
  | "model_unavailable"
  | "budget_exceeded"
  | "timeout"
  | "approval_rejected"
  | "constraint_violation"
  | "internal_error"
  | "task_error";

export interface FridayRunError {
  category: FridayRunErrorCategory;
  message: string;
  /** Whether the caller may retry the same input with a reasonable chance of success. */
  retryable: boolean;
}

// ─── Engine output ───

/** Unified result returned from every engine run. */
export interface FridayEngineRunResult {
  runId: string;
  status: FridayRunTerminalStatus;
  /** Final natural-language response (may be absent on hard failures). */
  response?: string;
  /** Total tool calls executed during the run. */
  toolCallCount: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Routing metadata for observability. */
  route?: {
    providerId: string;
    model: string;
    /** Number of LLM round-trips (tool loop iterations). */
    attempts: number;
  };
  /** Classified conversation turn kind (populated after turn preparation). */
  turnKind?: FridayConversationTurnKind;
  /** Structured error (present when status is failed/cancelled/timeout). */
  error?: FridayRunError;
  /** Image file paths extracted from tool call results. */
  images?: string[];
  /** Token usage counters. */
  usageInput?: number;
  usageOutput?: number;
  /** Prompt-context cost attribution for the run. */
  contextCostSummary?: FridayAgentContextCostSummary;
  /** Resolved task profile applied to the run. */
  taskProfile?: FridayResolvedAgentTaskProfile;
}

// ─── Engine interface ───

/**
 * The unified orchestration engine.
 *
 * All entry adapters (API, channel, CLI) call exactly this interface.
 * Internally it delegates to the turn preparer, execution classifier,
 * deterministic dispatch, and the agent runtime tool loop.
 */
export interface FridayOrchestrationEngine {
  /** Execute a new run from scratch. */
  executeRun(input: FridayEngineRunInput): Promise<FridayEngineRunResult>;

  /**
   * Resume a previously suspended run (e.g. after plan approval
   * or clarification answer).
   */
  resumeRun(runId: string, patch?: Partial<FridayEngineRunInput>): Promise<FridayEngineRunResult>;

  /** Cancel a running or suspended run. */
  cancelRun(runId: string): Promise<void>;

  /**
   * Mark any runs still in an active status as failed.
   * Called once at boot to recover from unclean shutdown.
   * Returns the number of runs marked failed.
   */
  resumeStaleRunsOnBoot(): number;
}

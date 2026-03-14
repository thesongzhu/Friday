import type { FridaySqliteLayer } from "#state";
import type { FridayEvaluationContext, FridayEvaluationResult } from "#rules";

import type {
  FridayAgentMessage,
  FridayAgentRunConstraints,
  FridayAgentTestResult,
  FridayAgentToolCallRecord,
  FridayAgentToolDefinition,
} from "../model/friday-agent.types.js";
import type { FridayAgentSelfTestService } from "../testing/friday-agent-self-test-service.types.js";
import type { FridayAgentRunEventRepository } from "../persistence/friday-agent-run-event-repository.js";
import type { FridayAgentArtifactWriter } from "../services/friday-agent-artifact-writer.js";
import type { FridayAgentEventEmitter } from "./friday-agent-event-emitter.js";
import type { FridayAgentLlmClient } from "./friday-agent-llm-client.types.js";
import type { FridayAgentReviewGate } from "./friday-agent-review-gate.js";

export interface FridayAgentExecutionContext {
  surface?: string;
  interactive?: boolean;
  browserPresentationMode?: "auto" | "headless" | "host_chrome_visible";
}

export interface FridayAgentSystemPromptContext {
  toolNames: string[];
  nowIso: string;
  timezone: string;
  localDate: string;
}

// ─── Runtime interface ───

export interface FridayAgentRuntime {
  executeRun(params: {
    task: string;
    /** Optional image URLs to include as inline vision content. */
    images?: string[];
    /** Optional prior conversation history to prepend before the new task. */
    historyMessages?: FridayAgentMessage[];
    sessionKey?: string;
    runId?: string;
    providerId?: string;
    model?: string;
    timezone?: string;
    maxAttempts?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Whether this run requires plan review before execution. */
    reviewRequired?: boolean;
    /** Per-run execution constraints (e.g. readOnly). */
    constraints?: FridayAgentRunConstraints;
    /** Optional principal ID for policy evaluation and audit traceability. */
    principalId?: string;
    /** Optional authorization scopes for policy evaluation. */
    scopes?: string[];
    /** Optional per-run hard blocklist of tool names. */
    disabledToolNames?: string[];
    /** Optional surface/runtime context for tool routing decisions. */
    executionContext?: FridayAgentExecutionContext;
  }): Promise<FridayAgentRuntimeResult>;

  /**
   * Dynamically register a tool after runtime construction.
   * Updates both the internal tool map (for execution) and the tools
   * list (for LLM schema). Useful for late-bound tools whose
   * dependencies aren't available at construction time.
   */
  registerTool(tool: FridayAgentToolDefinition): void;

  /**
   * Mark any agent runs still in an active status (pending/planning/executing/
   * testing/fixing) as failed. Call once at boot to recover from unclean shutdown.
   * Returns the number of runs that were marked failed.
   */
  resumeStaleRunsOnBoot(): number;
}

export interface FridayAgentRuntimeResult {
  runId: string;
  status: "completed" | "failed" | "cancelled";
  response: string;
  toolCallCount: number;
  durationMs: number;
  usageInput: number;
  usageOutput: number;
  /** Image file paths extracted from tool call results (e.g. browser screenshots). */
  images?: string[];
}

export interface FridayAgentUsageTurn {
  providerId: string;
  model: string;
  providerApi: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

// ─── Factory deps ───

export interface CreateFridayAgentRuntimeDeps {
  db: FridaySqliteLayer;
  llmClient: FridayAgentLlmClient;
  model: string;
  providerId: string;
  /**
   * Static system prompt string.  Used directly when provided (e.g. sub-agent
   * runs).  Mutually exclusive with `systemPromptBuilder` — if both are
   * given, `systemPromptBuilder` takes precedence so the prompt always
   * reflects the current tool set.
   */
  systemPrompt?: string;
  /**
   * Dynamic prompt builder invoked at each `executeRun()` call with the
   * current tool names.  Ensures the system prompt always lists exactly
   * the tools registered at run time — no stale tool lists.
   */
  systemPromptBuilder?: (context: FridayAgentSystemPromptContext) => string | Promise<string>;
  tools: FridayAgentToolDefinition[];
  eventEmitter: FridayAgentEventEmitter;
  idGenerator: () => string;
  nowIso: () => string;
  /** Optional review gate for plan approval. */
  reviewGate?: FridayAgentReviewGate;
  /** Optional durable run event repository. */
  runEventRepository?: FridayAgentRunEventRepository;
  /** Optional self-test service for validation gate (IMPL-5). */
  selfTestService?: FridayAgentSelfTestService;
  /** Runtime working directory for self-tests. */
  workdir?: string;
  /** Optional callback to mirror final response into session store. */
  sessionMirror?: (sessionKey: string, message: {
    role: "assistant";
    content: string;
    contentText: string;
    idempotencyKey: string;
    toolCalls?: FridayAgentToolCallRecord[];
  }) => Promise<void>;
  /** Optional callback to record per-turn provider usage/cost metrics. */
  usageRecorder?: (usage: FridayAgentUsageTurn) => Promise<void>;
  /** Optional artifact writer for disk persistence (IMPL-7). */
  artifactWriter?: FridayAgentArtifactWriter;
  /** Optional global rules evaluator used to gate run/tool execution. */
  evaluateRules?: (context: FridayEvaluationContext, signal?: AbortSignal) => Promise<FridayEvaluationResult>;
  /** Optional callback that returns learned user preferences to inject into the system prompt. */
  learningContextBuilder?: (input: { userId: string; nowIso: string }) => { preferences: Record<string, unknown> };
  /** Optional callback that returns a communication persona prompt fragment for the current user. */
  communicationPromptBuilder?: (input: { userId: string; nowIso: string }) => string | null;
}

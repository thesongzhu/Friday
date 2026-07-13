import type { FridaySqliteLayer } from "#state";
import type { FridayEvaluationContext, FridayEvaluationResult } from "#rules";
import type { FridayConversationBlock, FridayConversationTurnFrame } from "#sessions";
import type { FridayProviderTenantContext } from "#providers";
import type { FridayWorkspaceContext } from "./friday-agent-workspace-context.js";

import type {
  FridayAgentApiRequestMetadata,
  FridayAgentMessage,
  FridayAgentPlanReviewPayload,
  FridayAgentRunConstraints,
  FridayAgentRunStatus,
  FridayAgentTestResult,
  FridayAgentToolCallRecord,
  FridayAgentToolDefinition,
} from "../model/friday-agent.types.js";
import type { FridayAgentSelfTestService } from "../testing/friday-agent-self-test-service.types.js";
import type { FridayAgentSelfFixService } from "../testing/friday-agent-self-fix-service.js";
import type { FridayAgentRunEventRepository } from "../persistence/friday-agent-run-event-repository.js";
import type { FridayAgentArtifactWriter } from "../services/friday-agent-artifact-writer.js";
import type { FridayAgentEventEmitter } from "./friday-agent-event-emitter.js";
import type { FridayDecisionEngine } from "./friday-agent-decision-engine.types.js";
import type { FridayWorldStateManager } from "./friday-agent-world-state-manager.js";
import type { FridayAgentLlmClient } from "./friday-agent-llm-client.types.js";
import type { FridayAgentReviewGate } from "./friday-agent-review-gate.js";
import type {
  FridayAgentTaskProfileInput,
  FridayResolvedAgentTaskProfile,
} from "./friday-agent-task-profile.js";
import type { FridayAgentStarterSkillRoutingConfig } from "./friday-agent-starter-skill-routing.js";
import type { FridayAgentCompactionBridge } from "./friday-agent-compaction-bridge.js";
import type { FridayCompactionContextReplaySink } from "./friday-agent-compaction-context-replay-sink.js";
import type {
  FridayAgentPromptProfile,
  FridayAgentToolRoutingDecision,
} from "./friday-agent-tool-routing.js";
import type { FridayMutatingActionRisk } from "../../security/friday-mutating-action-gate.js";

export interface FridayAgentExecutionContext {
  surface?: string;
  interactive?: boolean;
  browserPresentationMode?: "auto" | "headless" | "host_chrome_visible";
  packId?: string;
  /** Automation run evidence for replay/oracle checks. */
  automationId?: string;
  automationSessionTargetType?: "isolated" | "named" | "current";
  automationSessionTargetSource?: "saved" | "run_override";
  automationSessionKey?: string;
  automationSourceRunId?: string;
  /** Channel kind when the run enters through a connected chat channel. */
  channelKind?: string;
  /** Channel chat shape for private-memory defaults. */
  channelChatType?: "direct" | "group" | "channel" | "thread" | "dm" | "private";
  /** Explicit route marker for channel runs that enter the full agent/orchestration path. */
  channelControlRoute?: "full_agent";
  /** Per-channel persona/role instruction injected by the channel entry adapter. */
  channelPersona?: string;
}

export interface FridayAgentConversationContext {
  turnKind?: "new_topic" | "follow_up" | "clarification" | "status_check" | "continue_active_task";
  turnFrame?: FridayConversationTurnFrame;
  previousTopicSummary?: string;
  currentTopicSummary?: string;
  selectedBlocks?: FridayConversationBlock[];
  selectionReasons?: string[];
  replyToMessageId?: string;
}

export interface FridayContextEngineResolveInput {
  task?: string;
  conversationContext?: FridayAgentConversationContext;
}

export interface FridayContextEngineResolveResult {
  workspaceContext?: FridayWorkspaceContext;
  promptFragment?: string;
}

export interface FridayContextEngineAfterTurnInput {
  runId: string;
  userId?: string;
  sessionKey: string;
  task: string;
  response: string;
  status: FridayAgentRunStatus;
  summary?: string;
  artifactDir?: string;
  conversationContext?: FridayAgentConversationContext;
}

export interface FridayContextEngine {
  ingest?: (input: FridayContextEngineResolveInput) => void | Promise<void>;
  assemble?: (
    input: FridayContextEngineResolveInput,
  ) => FridayContextEngineResolveResult | null | undefined | Promise<FridayContextEngineResolveResult | null | undefined>;
  compact?: (
    input: FridayContextEngineResolveInput & {
      assembled: FridayContextEngineResolveResult;
    },
  ) => FridayContextEngineResolveResult | null | undefined | Promise<FridayContextEngineResolveResult | null | undefined>;
  afterTurn?: (input: FridayContextEngineAfterTurnInput) => void | Promise<void>;
}

export interface FridayAgentDelegationRequest {
  runId: string;
  sessionKey: string;
  task: string;
  taskPrompt?: string;
  providerId?: string;
  tenantContext?: FridayProviderTenantContext;
  model?: string;
  timezone?: string;
  timeoutMs: number;
  signal: AbortSignal;
  constraints?: FridayAgentRunConstraints;
  disabledToolNames?: string[];
  principalId?: string;
  conversationContext?: FridayAgentConversationContext;
  taskProfile?: FridayAgentTaskProfileInput;
}

export interface FridayAgentDelegationResult {
  delegated: true;
  subagentId: string;
  childRunId: string;
  childSessionKey: string;
  statusSnapshot: "pending" | "running" | "completed" | "failed" | "cancelled";
  outcome: {
    status: "completed" | "failed" | "cancelled";
    response: string;
    toolCallCount: number;
    durationMs: number;
    usageInput: number;
    usageOutput: number;
    images?: string[];
  };
}

export interface FridayAgentSystemPromptContext {
  userId?: string;
  toolNames: string[];
  nowIso: string;
  timezone: string;
  localDate: string;
  task?: string;
  executionContext?: FridayAgentExecutionContext;
  conversationContext?: FridayAgentConversationContext;
  promptProfile?: FridayAgentPromptProfile;
  contextPolicy?: {
    workspaceContext?: "auto" | "skip";
  };
  toolRouting?: FridayAgentToolRoutingDecision;
  deferredToolHints?: Array<{ name: string; description: string }>;
}

export interface FridayAgentContextCostComponent {
  kind: "workspace_context" | "starter_skills" | "mcp" | "subagents" | "tool_routing" | "context_replay";
  estimatedChars: number;
  estimatedInputTokens: number;
  count?: number;
  metadata?: Record<string, unknown>;
}

export interface FridayAgentContextCostSummary {
  totalEstimatedChars: number;
  totalEstimatedInputTokens: number;
  components: FridayAgentContextCostComponent[];
}

export interface FridayAgentSystemPromptBuildResult {
  prompt: string;
  contextCostSummary?: FridayAgentContextCostSummary;
}

export interface FridayAgentCompactionContextBuildResult {
  fragment: string;
  blockCount?: number;
  sources?: string[];
  sessionKey?: string;
  evidenceTier?: "audit_replay_evidence";
  trustLevel?: "unconfirmed_summary";
  source?: "context_replay";
  memoryBoundary?: "not_user_confirmed_memory";
  redactionApplied?: boolean;
  redactionCount?: number;
  replayEntryIds?: string[];
}

// ─── Runtime interface ───

export interface FridayAgentRuntime {
  executeRun(params: {
    task: string;
    /** Optional image URLs to include as inline vision content. */
    images?: string[];
    /** Optional prior conversation history to prepend before the new task. */
    historyMessages?: FridayAgentMessage[];
    /** Optional prompt variant for the current turn. Stored task stays unchanged. */
    taskPrompt?: string;
    /** Optional current-turn metadata for answer alignment and context gating. */
    conversationContext?: FridayAgentConversationContext;
    sessionKey?: string;
    runId?: string;
    providerId?: string;
    tenantContext?: FridayProviderTenantContext;
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
    /** Optional API request idempotency metadata for transport-level replay. */
    apiRequestIdempotency?: FridayAgentApiRequestMetadata;
    /** Optional model-routing/temperature profile for the run. */
    taskProfile?: FridayAgentTaskProfileInput;
    /** Internal-only override used when a child runtime inherits its parent model. */
    modelSelectionSourceOverride?: "inherited";
    /** Resume an existing awaiting-plan run instead of creating a new record. */
    resumeExistingRun?: boolean;
    /** Skip re-entering the planning review gate because the plan was already approved. */
    skipPlanningReview?: boolean;
    /** Optional precomputed/updated plan review payload to persist before execution resumes. */
    planReviewOverride?: FridayAgentPlanReviewPayload;
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

  /**
   * Rollback file changes made during a specific run.
   * Returns null if no checkpoint exists for the run.
   */
  rollbackRun(runId: string): { restoredCount: number; errors: Array<{ filePath: string; error: string }> } | null;

  /**
   * Returns true when the run still has a rollback checkpoint available,
   * including checkpoints recovered after process restart.
   */
  hasRollbackCheckpoint(runId: string): boolean;

  /**
   * Persist an event to the run event repository and emit it on the event bus.
   * Useful for bridging events from subsystems (e.g. autonomous engine) that
   * need their events to appear in the agent run SSE stream.
   */
  emitRunEvent(eventName: string, payload: Record<string, unknown>, runId: string): void;
}

export interface FridayAgentRuntimeResult {
  runId: string;
  status: FridayAgentRunStatus;
  response: string;
  toolCallCount: number;
  durationMs: number;
  usageInput: number;
  usageOutput: number;
  /** Image file paths extracted from tool call results (e.g. browser screenshots). */
  images?: string[];
  /** Final answer after any alignment retry/correction. */
  finalResponse?: string;
  /** Optional prompt-context cost attribution for the final run. */
  contextCostSummary?: FridayAgentContextCostSummary;
  /** Resolved task profile applied to the run. */
  taskProfile?: FridayResolvedAgentTaskProfile;
}

export interface FridayAgentUsageTurn {
  providerId: string;
  model: string;
  providerApi: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  /**
   * The provider's own request identifier for this turn, when the completed
   * provider response surfaced one. Threaded into recordUsage so the write is
   * idempotent on it and binds a durable receipt. Absent/null when no request-id
   * was surfaced — recorded without a receipt, as before (back-compat).
   */
  requestId?: string | null;
  /** Anthropic prompt cache: tokens read from cache. */
  cacheReadInputTokens?: number;
  /** Anthropic prompt cache: tokens written to cache. */
  cacheCreationInputTokens?: number;
}

export interface FridayAgentResumeRunParams {
  runId: string;
  task?: string;
  taskPrompt?: string;
  sessionKey?: string;
  providerId?: string;
  tenantContext?: FridayProviderTenantContext;
  model?: string;
  timezone?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  constraints?: FridayAgentRunConstraints;
  principalId?: string;
  scopes?: string[];
  disabledToolNames?: string[];
  executionContext?: FridayAgentExecutionContext;
  historyMessages?: FridayAgentMessage[];
  conversationContext?: FridayAgentConversationContext;
  planReviewOverride?: FridayAgentPlanReviewPayload;
  taskProfile?: FridayAgentTaskProfileInput;
  modelSelectionSourceOverride?: "inherited";
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
  systemPromptBuilder?: (
    context: FridayAgentSystemPromptContext,
  ) => string | FridayAgentSystemPromptBuildResult | Promise<string | FridayAgentSystemPromptBuildResult>;
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
  /** Optional self-fix service that turns failed validation into a bounded retry loop. */
  selfFixService?: FridayAgentSelfFixService;
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
  /** Optional callback that returns learned user preferences for non-prompt runtime context such as timezone resolution. */
  learningContextBuilder?: (input: { userId: string; nowIso: string }) => { preferences: Record<string, unknown> };
  /** Optional callback that returns persisted compaction context for the current session. */
  compactionContextBuilder?: (input: {
    userId?: string;
    sessionKey?: string;
    nowIso: string;
  }) =>
    | string
    | FridayAgentCompactionContextBuildResult
    | null
    | Promise<string | FridayAgentCompactionContextBuildResult | null>;
  /** Optional callback that returns a communication persona prompt fragment for the current user. */
  communicationPromptBuilder?: (input: { userId: string; nowIso: string }) => string | null | Promise<string | null>;
  /** Optional deterministic delegation hook for top-level coordinator runs. */
  delegationHandler?: (input: FridayAgentDelegationRequest) =>
    Promise<FridayAgentDelegationResult | null>;
  /** Optional preview context engine hooks. Must remain additive to the default prompt path. */
  contextEngine?: FridayContextEngine;
  /**
   * Optional semantic compaction bridge.  When provided, the agent loop uses
   * block-level scoring, structured extraction (decisions/TODOs/failures) and
   * optional LLM summarization instead of the legacy one-line text compaction.
   * Falls back to the legacy path on error.
   */
  compactionBridge?: FridayAgentCompactionBridge;
  /**
   * Optional context replay sink for persisting compaction summaries.
   * When provided, structured summaries are written as unconfirmed replay
   * evidence outside durable memory. Calls are non-blocking.
   */
  compactionContextReplaySink?: FridayCompactionContextReplaySink;
  /** Optional pluggable decision engine for world-model-ready action selection. */
  decisionEngine?: FridayDecisionEngine;
  /** Optional world state manager for loading user context into decision engine. */
  worldStateManager?: FridayWorldStateManager;
  /** Optional one-shot enforcement for installed starter-skill discovery on matching operational requests. */
  starterSkillRouting?: FridayAgentStarterSkillRoutingConfig;
  /** Optional callback that returns recent learned lessons for system prompt injection. */
  learnedLessons?: () => Array<{ title: string; cause: string; fix: string }>;

  /**
   * Optional resolver that pauses execution when a tool call requires user approval.
   * Returns `{ approved: true }` to proceed, `{ approved: false }` to block.
   * When absent, risky tool calls are blocked immediately (existing behaviour).
   */
  toolApprovalResolver?: (prompt: {
    runId: string;
    sessionKey?: string;
    principalId?: string;
    scopes?: string[];
    surface?: string;
    grantId: string;
    expiresAt: string;
    toolName: string;
    toolCallId: string;
    params: Record<string, unknown>;
    reason: string;
    canonicalActionDigest?: string;
    canonicalAction?: string;
    canonicalRisk?: FridayMutatingActionRisk;
    canonicalMutating?: boolean;
    canonicalResourceType?: string;
    canonicalResourceId?: string;
  }) => Promise<{
    approved: boolean;
    reason?: string;
    decidedByPrincipalId?: string;
    decidedByPrincipalType?: string;
    approvalSurface?: string;
  }>;
  /**
   * Test-oracle ONLY. When not explicitly `true`, the agent run loop
   * `executeRun` method fails closed at the METHOD boundary (not just the HTTP
   * agent-run / session-run routes), so every non-route caller — heartbeat
   * runner, channel entry adapter, cron dynamic-job runner, autonomous engine,
   * planning gate, subagent child runtime, and any future autonomous caller — is
   * fenced out of the TypeScript agent runtime while runtime ownership is moved
   * to Rust. Production hub bootstrap leaves this unset → fail-closed. Mirrors
   * the route-level `allowTestOnlyAgentRunStartExecution` /
   * `allowTestOnlySessionRunExecution` guards so the method honors the same
   * test-oracle contract. NEVER default this on in production.
   */
  allowTestOnlyAgentRunExecution?: boolean;
  /** Enforce the canonical mutating action gate for tool calls before side effects. */
  canonicalMutatingActionGate?: boolean;
  /** Server-owned secret used to sign canonical approvals passed to downstream runtimes. */
  canonicalApprovalSecret?: string;
  /** Optional policy extensions evaluated before tool execution. Extensions can only deny, never allow what core denied. */
  policyExtensions?: Array<{ name: string; evaluate: (context: { principalId: string; resource: string; action: string; resourceId?: string }) => "pass" | "deny" | "abstain" }>;
}

// ─── Agent run status ───

export type FridayAgentRunStatus =
  | "pending"
  | "planning"
  | "executing"
  | "testing"
  | "fixing"
  | "completed"
  | "failed"
  | "failed_tests"
  | "cancelled";

// ─── Tool definition & result ───

export interface FridayAgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<FridayAgentToolResult>;
}

/**
 * A single content block within a structured tool result.
 */
export interface FridayAgentToolResultTextBlock {
  type: "text";
  text: string;
}

export interface FridayAgentToolResultImageBlock {
  type: "image";
  mimeType: string;
  /** Base64-encoded image data. */
  data: string;
}

export interface FridayAgentToolResultFileBlock {
  type: "file";
  mimeType: string;
  /** File path on disk. */
  path: string;
  /** Optional base64-encoded content (for inline delivery). */
  data?: string;
}

export type FridayAgentToolResultContentBlock =
  | FridayAgentToolResultTextBlock
  | FridayAgentToolResultImageBlock
  | FridayAgentToolResultFileBlock;

export interface FridayAgentToolResult {
  /** String content (backward-compatible — always present). */
  content: string;
  isError?: boolean;
  /** Optional structured metadata emitted by tools for UI/event consumers. */
  metadata?: Record<string, unknown>;
  /** Optional structured error code for observability and recovery logic. */
  errorCode?: string;
  /** Optional route id emitted by underlying tool subsystem. */
  routeId?: string;
  /** Optional correlation id emitted by underlying tool subsystem. */
  correlationId?: string;
  /**
   * Structured content blocks for rich results (images, files).
   * When present, `content` is the text-only fallback.
   */
  blocks?: FridayAgentToolResultContentBlock[];
}

// ─── LLM message types (Anthropic Messages API format) ───

export interface FridayAgentTextBlock {
  type: "text";
  text: string;
}

export interface FridayAgentToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface FridayAgentToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface FridayAgentImageBlock {
  type: "image";
  source:
    | { type: "url"; url: string }
    | { type: "base64"; media_type: string; data: string };
}

export type FridayAgentContentBlock =
  | FridayAgentTextBlock
  | FridayAgentImageBlock
  | FridayAgentToolUseBlock
  | FridayAgentToolResultBlock;

export interface FridayAgentMessage {
  role: "user" | "assistant";
  content: string | FridayAgentContentBlock[];
}

// ─── Tool call record (for debugging) ───

export interface FridayAgentToolCallRecord {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: FridayAgentToolResult;
  durationMs: number;
  startedAt: string;
}

// ─── Agent run record (persisted) ───

export interface FridayAgentRunRecord {
  id: string;
  task: string;
  status: FridayAgentRunStatus;
  sessionKey: string;
  providerId?: string;
  model?: string;
  attempt: number;
  maxAttempts: number;
  artifacts?: FridayAgentArtifact[];
  testResults?: FridayAgentTestResult[];
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  usageInput?: number;
  usageOutput?: number;
  costUsd?: number;
  /** Persisted plan + review decision (IMPL-1). */
  planReview?: FridayAgentPlanReviewPayload;
  /** Actual routed provider/model/cost data (IMPL-2). */
  actualExecution?: FridayAgentActualExecution;
  /** Per-run execution constraints (IMPL-4). */
  constraints?: FridayAgentRunConstraints;
  /** Persisted final response text (IMPL-6). */
  responseText?: string;
  /** Summary derived from response (IMPL-6). */
  summary?: string;
  /** Artifact directory path on disk (IMPL-7). */
  artifactDir?: string;
}

// ─── Plan review payload (IMPL-1) ───

export interface FridayAgentPlanReviewPayload {
  plan: {
    task: string;
    stepCount: number;
    description: string;
  };
  decision?: {
    approved: boolean;
    mode: string;
    reason?: string;
    reviewedAt: string;
  };
}

// ─── Actual execution metadata (IMPL-2) ───

export interface FridayAgentActualExecution {
  actualProviderId?: string;
  actualModel?: string;
  actualProviderKind?: string;
  actualProviderApi?: string;
  totalCostUsd?: number;
  turns: FridayAgentActualTurn[];
}

export interface FridayAgentActualTurn {
  providerId?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

// ─── Run constraints (IMPL-4) ───

export interface FridayAgentRunConstraints {
  readOnly?: boolean;
}

// ─── Artifact ───

export interface FridayAgentArtifact {
  type: string;
  path?: string;
  skillId?: string;
  workflowId?: string;
}

// ─── Test result ───

export interface FridayAgentTestResult {
  strategy: "syntax" | "execute" | "manifest" | "compile" | "llm_eval";
  passed: boolean;
  errors: FridayAgentTestError[];
  durationMs: number;
}

export interface FridayAgentTestError {
  message: string;
  file?: string;
  line?: number;
  severity: "error" | "warning";
}

// ─── Event payloads ───

export interface FridayAgentRunStartedPayload {
  runId: string;
  task: string;
  model: string;
  providerId: string;
}

export interface FridayAgentRunPlanningPayload {
  runId: string;
  message: string;
}

export interface FridayAgentRunExecutingPayload {
  runId: string;
  step: number;
  totalSteps?: number;
  description: string;
}

export interface FridayAgentToolStartPayload {
  runId: string;
  toolName: string;
  toolCallId: string;
  params: Record<string, unknown>;
}

export interface FridayAgentToolEndPayload {
  runId: string;
  toolName: string;
  toolCallId: string;
  durationMs: number;
  isError: boolean;
  summary?: string;
  presentationMode?: "headless" | "host_chrome_visible";
  targetBrowser?: string;
  browserTarget?: string;
  sessionId?: string;
  tabId?: string;
  fallbackReason?: string;
  errorCode?: string;
  routeId?: string;
  correlationId?: string;
}

export interface FridayAgentRunCompletedPayload {
  runId: string;
  durationMs: number;
  toolCallCount: number;
  testsPassed: boolean;
  artifacts: Array<{ type: string; path?: string }>;
}

export interface FridayAgentRunFailedPayload {
  runId: string;
  error: { code: string; message: string };
  durationMs: number;
  routeId?: string;
  correlationId?: string;
  toolName?: string;
}

export interface FridayAgentTextDeltaPayload {
  runId: string;
  delta: string;
}

export interface FridayAgentRunCancelledPayload {
  runId: string;
  reason?: string;
}

// ─── Sub-agent event payloads ───

export interface FridaySubagentSpawnedPayload {
  subagentId: string;
  parentRunId: string;
  task: string;
  label?: string;
  depth: number;
}

export interface FridaySubagentCompletedPayload {
  subagentId: string;
  parentRunId: string;
  childRunId: string;
  outcome: {
    status: "completed" | "failed" | "cancelled";
    response: string;
    toolCallCount: number;
    durationMs: number;
    usageInput: number;
    usageOutput: number;
  };
}

// ─── Event map ───

export interface FridayAgentEventMap {
  "agent.run.started": FridayAgentRunStartedPayload;
  "agent.run.planning": FridayAgentRunPlanningPayload;
  "agent.run.executing": FridayAgentRunExecutingPayload;
  "agent.run.tool_start": FridayAgentToolStartPayload;
  "agent.run.tool_end": FridayAgentToolEndPayload;
  "agent.run.completed": FridayAgentRunCompletedPayload;
  "agent.run.failed": FridayAgentRunFailedPayload;
  "agent.run.text_delta": FridayAgentTextDeltaPayload;
  "agent.run.cancelled": FridayAgentRunCancelledPayload;
  "agent.subagent.spawned": FridaySubagentSpawnedPayload;
  "agent.subagent.completed": FridaySubagentCompletedPayload;
}

export type FridayAgentEventName = keyof FridayAgentEventMap;

// (Canonical execute run params/result types live in runtime/friday-agent-runtime.types.ts)

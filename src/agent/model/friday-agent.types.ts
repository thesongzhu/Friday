import type { FridayResolvedAgentTaskProfile } from "../runtime/friday-agent-task-profile.js";
import type { FridayAgentContextCostSummary } from "../runtime/friday-agent-runtime.types.js";
import type {
  FridayAgentRunContextSummarySnapshot,
  FridayAgentRunHealthSnapshot,
} from "../runtime/friday-agent-run-presentation.js";
import type { FridayToolCallSummary } from "../services/friday-tool-call-summary.js";
import type {
  FridayProviderAttempt,
  FridayProviderBackendKind,
  FridayProviderRoutingDecisionTrace,
} from "#providers";

// ─── Agent run status ───

export type FridayAgentRunStatus =
  | "pending"
  | "planning"
  | "awaiting_clarification"
  | "awaiting_plan_approval"
  // Non-terminal: a run paused for the OWNER's explicit approval to continue
  // (projected from loopStatus "Paused"). Resumable, never a terminal failure.
  | "awaiting_approval"
  | "executing"
  | "testing"
  | "fixing"
  | "completed"
  | "failed"
  | "failed_tests"
  | "cancelled";

// ─── Tool definition & result ───

export const FRIDAY_AGENT_TOOL_GUARDRAIL_SCHEMA_VERSION = "friday.agent.tool_guardrail.v1";

export type FridayAgentToolGuardrailRiskLevel = "low" | "medium" | "high" | "critical";

export interface FridayAgentToolPreGuardrailEvidence {
  schemaVersion: typeof FRIDAY_AGENT_TOOL_GUARDRAIL_SCHEMA_VERSION;
  phase: "pre";
  decision: "allow" | "block" | "requires_approval";
  toolCallId: string;
  toolName: string;
  mutating: boolean;
  readOnly: boolean;
  operationalMode?: "plan" | "execute" | "restricted";
  approvalRequired: boolean;
  riskLevel: FridayAgentToolGuardrailRiskLevel;
  routeId: string;
  correlationId: string;
  checks: string[];
  inputKeys: string[];
  evidenceBoundary: string;
}

export interface FridayAgentToolPostGuardrailEvidence {
  schemaVersion: typeof FRIDAY_AGENT_TOOL_GUARDRAIL_SCHEMA_VERSION;
  phase: "post";
  status: "completed" | "failed" | "blocked";
  toolCallId: string;
  toolName: string;
  isError: boolean;
  durationMs: number;
  routeId: string;
  correlationId: string;
  evidenceCaptured: true;
  outputPointerKind: "agent_tool_output_event";
  summaryAvailable: boolean;
  errorCode?: string;
  evidenceBoundary: string;
}

export interface FridayAgentToolGuardrailReceipt {
  pre: FridayAgentToolPreGuardrailEvidence;
  post?: FridayAgentToolPostGuardrailEvidence;
}

export interface FridayAgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  timeoutMs?: number | ((args: Record<string, unknown>) => number | undefined);
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
  guardrail?: FridayAgentToolGuardrailReceipt;
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
  /** Prompt-context attribution persisted for UI/observability drill-down. */
  contextCostSummary?: FridayAgentContextCostSummary;
  /** Resolved task profile actually applied to this run. */
  taskProfile?: FridayResolvedAgentTaskProfile;
  /** Machine-readable run metadata for UI/session affinity and future attribution. */
  metadata?: FridayAgentRunMetadata;
  /** True only for runs stamped from verified operator-signature organic provenance. */
  organic?: boolean;
  organicPrincipal?: string;
  organicSource?: "operator_signature" | string;
  organicAttestationRef?: string;
  /** Derived UI health classification for a run. */
  health?: FridayAgentRunHealthSnapshot;
  /** Derived context summary for UI explanation layers. */
  contextSummary?: FridayAgentRunContextSummarySnapshot;
  /** Whether a file rollback checkpoint is still available for this run. */
  rollbackAvailable?: boolean;
}

export interface FridayAgentPackContextMetadata {
  packId: string;
  surface?: string;
  updatedAt: string;
}

export interface FridayAgentApiRequestMetadata {
  operationId: string;
  idempotencyKey: string;
  payloadHash: string;
  receivedAt: string;
  principalId?: string;
}

export interface FridayAgentRunMetadata {
  surface?: string;
  packContext?: FridayAgentPackContextMetadata;
  apiRequest?: FridayAgentApiRequestMetadata;
  organicProvenance?: {
    principal: string;
    source: "operator_signature" | string;
    attestationRef: string;
    publicKeyId?: string;
    taskSha256: string;
    issuedAt: string;
    route: string;
  };
  executionBoundary?: {
    disabledToolNames?: string[];
  };
}

// ─── Plan review payload (IMPL-1) ───

export interface FridayAgentPlanReviewPayload {
  plan: {
    task: string;
    stepCount: number;
    description: string;
  };
  gate?: {
    kind:
      | "generate_skill"
      | "generate_workflow"
      | "deploy_workflow"
      | "export_workflow_bundle"
      | "major_decision";
    state:
      | "awaiting_clarification"
      | "awaiting_plan_approval"
      | "approved"
      | "rejected"
      | "bypassed";
    clarificationQuestions?: string[];
    answers?: Array<{
      question?: string;
      answer: string;
    }>;
    planMarkdown?: string;
    planSummary?: string;
    approvalPrompt?: string;
    approvalUpdatedAt?: string;
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
  requestedProviderId?: string;
  requestedModel?: string;
  taskProfileId?: string;
  taskProfileModel?: string;
  modelSelectionSource?: "provider+model" | "model" | "task_profile" | "route_default" | "inherited";
  actualProviderId?: string;
  actualModel?: string;
  actualProviderKind?: string;
  actualProviderApi?: string;
  backendKind?: FridayProviderBackendKind;
  totalCostUsd?: number;
  fallbackAttempts?: FridayProviderAttempt[];
  routingDecisionReason?: string;
  learningAdjusted?: boolean;
  routeDecisionTrace?: FridayProviderRoutingDecisionTrace;
  blockedTools?: Array<{
    toolName: string;
    reason: string;
    routeId?: string;
  }>;
  finalFailureReason?: string;
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
  /** Operational mode override for this run. */
  operationalMode?: "plan" | "execute" | "restricted";
  /** Data handling requirement used by provider routing. */
  dataSensitivity?: "public" | "internal" | "confidential" | "secret";
  /** Maximum acceptable provider routing latency budget in milliseconds. */
  latencyBudgetMs?: number;
  /** Hard upper context window requirement for provider routing. */
  contextWindowTokens?: number;
  /** Force local/self-hosted provider routing. */
  localOnly?: boolean;
  /** Disallow hosted provider egress. */
  noEgress?: boolean;
  /** Whether satellite/local execution capacity is currently available. */
  satelliteAvailable?: boolean;
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
  taskProfile?: {
    id: string;
    model?: string;
    modelSelectionSource?:
      | "provider+model"
      | "model"
      | "task_profile"
      | "route_default"
      | "inherited";
  };
  contextSelection?: {
    turnKind?: string;
    selectedBlocks: Array<{
      id: string;
      source: string;
      summary: string;
      score: number;
      reason: string;
      messageIds?: string[];
    }>;
    selectionReasons?: string[];
  };
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

export type FridayAgentEtaConfidence = "low" | "medium" | "high" | "unavailable";

export interface FridayAgentRunProgressPayload {
  runId: string;
  phase: FridayAgentRunStatus;
  elapsedMs: number;
  activeTool?: string;
  subagentCount: number;
  latestSubagentId?: string;
  activeSubagentIds?: string[];
  eta?: number;
  etaConfidence: FridayAgentEtaConfidence;
}

export interface FridayAgentRunAwaitingClarificationPayload {
  runId: string;
  status: "awaiting_clarification";
  message: string;
  questions: string[];
  planKind?:
    | "generate_skill"
    | "generate_workflow"
    | "deploy_workflow"
    | "export_workflow_bundle"
    | "major_decision";
}

export interface FridayAgentRunPlanReadyPayload {
  runId: string;
  planMarkdown: string;
  planSummary: string;
  planKind?:
    | "generate_skill"
    | "generate_workflow"
    | "deploy_workflow"
    | "export_workflow_bundle"
    | "major_decision";
}

export interface FridayAgentRunAwaitingPlanApprovalPayload {
  runId: string;
  status: "awaiting_plan_approval";
  message: string;
  planMarkdown: string;
  planSummary: string;
  planKind?:
    | "generate_skill"
    | "generate_workflow"
    | "deploy_workflow"
    | "export_workflow_bundle"
    | "major_decision";
}

export interface FridayAgentRunPlanApprovedPayload {
  runId: string;
  approvedAt: string;
  approvalMode: string;
  planKind?:
    | "generate_skill"
    | "generate_workflow"
    | "deploy_workflow"
    | "export_workflow_bundle"
    | "major_decision";
  approverPrincipalId?: string;
  scopes?: string[];
  surface?: string;
}

export interface FridayAgentRunPlanRejectedPayload {
  runId: string;
  rejectedAt: string;
  rejectionMode: string;
  planKind?:
    | "generate_skill"
    | "generate_workflow"
    | "deploy_workflow"
    | "export_workflow_bundle"
    | "major_decision";
  approverPrincipalId?: string;
  scopes?: string[];
  surface?: string;
}

export interface FridayAgentRunAwaitingToolApprovalPayload {
  runId: string;
  status: "awaiting_tool_approval";
  grantId: string;
  toolName: string;
  toolCallId: string;
  params: Record<string, unknown>;
  reason: string;
  expiresAt: string;
  principalId?: string;
  scopes?: string[];
  sessionKey?: string;
  surface?: string;
  riskLevel?: "safe" | "guarded" | "destructive" | "blocked";
}

export interface FridayAgentCapabilityGrantIssuedPayload {
  runId: string;
  grantId: string;
  toolCallId: string;
  toolName: string;
  reason: string;
  approvalProvenance: "user_approval";
  expiresAt: string;
  principalId?: string;
  scopes?: string[];
  sessionKey?: string;
  surface?: string;
}

export interface FridayAgentCapabilityGrantDeniedPayload {
  runId: string;
  grantId: string;
  toolCallId: string;
  toolName: string;
  reason: string;
  denialReason?: string;
  principalId?: string;
  scopes?: string[];
  sessionKey?: string;
  surface?: string;
}

export interface FridayAgentCapabilityGrantUsedPayload {
  runId: string;
  grantId: string;
  toolCallId: string;
  toolName: string;
  principalId?: string;
  scopes?: string[];
  sessionKey?: string;
  surface?: string;
}

export interface FridayAgentCapabilityGrantRevokedPayload {
  runId?: string;
  grantId: string;
  toolName?: string;
  revokedBy: "manual" | "expiration" | "policy";
  reason?: string;
  principalId?: string;
  sessionKey?: string;
  surface?: string;
}

export interface FridayAgentToolStartPayload {
  runId: string;
  toolName: string;
  toolCallId: string;
  params: Record<string, unknown>;
  guardrail?: FridayAgentToolPreGuardrailEvidence;
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
  /** Lightweight tool call classification for execution trace data collection. */
  toolCallSummary?: FridayToolCallSummary;
  guardrail?: FridayAgentToolPostGuardrailEvidence;
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

export interface FridayAgentRunDegradedPayload {
  runId: string;
  level: "nominal" | "degraded" | "minimal" | "conversational";
  unavailableTools: string[];
  reason: string;
}

export interface FridayAgentModeChangedPayload {
  runId: string;
  previousMode: "plan" | "execute" | "restricted";
  newMode: "plan" | "execute" | "restricted";
  reason: string;
}

export interface FridayAgentRouteSelectedPayload {
  runId: string;
  requestedProviderId?: string;
  requestedModel?: string;
  taskProfileId?: string;
  taskProfileModel?: string;
  modelSelectionSource?: FridayAgentActualExecution["modelSelectionSource"];
  actualProviderId?: string;
  actualModel?: string;
  actualProviderKind?: string;
  actualProviderApi?: string;
  backendKind?: FridayProviderBackendKind;
  routingDecisionReason?: string;
  learningAdjusted?: boolean;
  routeDecisionTrace?: FridayProviderRoutingDecisionTrace;
}

export interface FridayAgentRouteFallbackPayload {
  runId: string;
  requestedProviderId?: string;
  requestedModel?: string;
  actualProviderId?: string;
  actualModel?: string;
  attempts: FridayProviderAttempt[];
  fallbackCount: number;
}

export interface FridayAgentRouteMismatchPayload {
  runId: string;
  requestedProviderId?: string;
  requestedModel?: string;
  intendedModel: string;
  actualModel: string;
  actualProviderId?: string;
  backendKind?: FridayProviderBackendKind;
  taskProfileModel?: string;
  reason:
    | "explicit_fallback"
    | "provider_unsupported"
    | "policy_downgrade"
    | "backend_capability_gating"
    | "operator_override"
    | "historical_bias";
}

// ─── Autonomous event payloads ───

export interface FridayAutonomousGoalCreatedPayload {
  runId: string;
  goalId: string;
  description: string;
}

export interface FridayAutonomousGoalStartedPayload {
  runId: string;
  goalId: string;
}

export interface FridayAutonomousStepStartedPayload {
  runId: string;
  goalId: string;
  stepId: string;
  instruction: string;
  index: number;
  total: number;
}

export interface FridayAutonomousStepCompletedPayload {
  runId: string;
  goalId: string;
  stepId: string;
}

export interface FridayAutonomousStepFailedPayload {
  runId: string;
  goalId: string;
  stepId: string;
  reason?: string;
}

export interface FridayAutonomousGoalCompletedPayload {
  runId: string;
  goalId: string;
}

export interface FridayAutonomousGoalFailedPayload {
  runId: string;
  goalId: string;
  reason?: string;
}

// ─── Sub-agent event payloads ───

export interface FridaySubagentSpawnedPayload {
  subagentId: string;
  childRunId: string;
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
  "agent.run.route_selected": FridayAgentRouteSelectedPayload;
  "agent.run.route_fallback": FridayAgentRouteFallbackPayload;
  "agent.run.route_mismatch": FridayAgentRouteMismatchPayload;
  "agent.run.awaiting_clarification": FridayAgentRunAwaitingClarificationPayload;
  "agent.run.plan_ready": FridayAgentRunPlanReadyPayload;
  "agent.run.awaiting_plan_approval": FridayAgentRunAwaitingPlanApprovalPayload;
  "agent.run.plan_approved": FridayAgentRunPlanApprovedPayload;
  "agent.run.plan_rejected": FridayAgentRunPlanRejectedPayload;
  "agent.run.awaiting_tool_approval": FridayAgentRunAwaitingToolApprovalPayload;
  "agent.run.capability_grant_issued": FridayAgentCapabilityGrantIssuedPayload;
  "agent.run.capability_grant_denied": FridayAgentCapabilityGrantDeniedPayload;
  "agent.run.capability_grant_used": FridayAgentCapabilityGrantUsedPayload;
  "agent.run.capability_grant_revoked": FridayAgentCapabilityGrantRevokedPayload;
  "agent.run.executing": FridayAgentRunExecutingPayload;
  "agent.run.progress": FridayAgentRunProgressPayload;
  "agent.run.tool_start": FridayAgentToolStartPayload;
  "agent.run.tool_end": FridayAgentToolEndPayload;
  "agent.run.completed": FridayAgentRunCompletedPayload;
  "agent.run.failed": FridayAgentRunFailedPayload;
  "agent.run.text_delta": FridayAgentTextDeltaPayload;
  "agent.run.cancelled": FridayAgentRunCancelledPayload;
  "agent.run.degraded": FridayAgentRunDegradedPayload;
  "agent.run.mode_changed": FridayAgentModeChangedPayload;
  "agent.subagent.spawned": FridaySubagentSpawnedPayload;
  "agent.subagent.completed": FridaySubagentCompletedPayload;
  "autonomous.goal.created": FridayAutonomousGoalCreatedPayload;
  "autonomous.goal.started": FridayAutonomousGoalStartedPayload;
  "autonomous.step.started": FridayAutonomousStepStartedPayload;
  "autonomous.step.completed": FridayAutonomousStepCompletedPayload;
  "autonomous.step.failed": FridayAutonomousStepFailedPayload;
  "autonomous.goal.completed": FridayAutonomousGoalCompletedPayload;
  "autonomous.goal.failed": FridayAutonomousGoalFailedPayload;
}

export type FridayAgentEventName = keyof FridayAgentEventMap;

// (Canonical execute run params/result types live in runtime/friday-agent-runtime.types.ts)

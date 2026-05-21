// ─── Constants ───

export {
  FRIDAY_AGENT_RUN_TIMEOUT_MS,
  FRIDAY_AGENT_TOOL_TIMEOUT_MS,
  FRIDAY_AGENT_EXEC_TIMEOUT_MS,
  FRIDAY_AGENT_MAX_ATTEMPTS,
  FRIDAY_AGENT_EXEC_MAX_OUTPUT_BYTES,
  FRIDAY_AGENT_READ_MAX_BYTES,
  FRIDAY_AGENT_WEB_FETCH_MAX_BYTES,
  FRIDAY_AGENT_MAX_LOOP_ITERATIONS,
  FRIDAY_AGENT_TOOL_RESULT_MAX_CHARS,
  FRIDAY_AGENT_TOOL_RESULT_CAPS,
  FRIDAY_AGENT_COMPACTION_THRESHOLD,
  FRIDAY_AGENT_COMPACTION_KEEP_RECENT,
  FRIDAY_AGENT_COMPACTION_USE_PROVIDER,
  FRIDAY_AGENT_ERROR_CODES,
  FRIDAY_AGENT_SESSION_KEY_PREFIX,
} from "./friday-agent.constants.js";

// ─── Compaction pipeline ───

export type { FridayAgentCompactionBridge, FridayAgentCompactionBridgeResult } from "./runtime/friday-agent-compaction-bridge.js";
export { createFridayAgentCompactionBridge } from "./runtime/friday-agent-compaction-bridge.js";
export type { FridayCompactionContextReplaySink } from "./runtime/friday-agent-compaction-context-replay-sink.js";
export { createFridayCompactionContextReplaySink } from "./runtime/friday-agent-compaction-context-replay-sink.js";
export type {
  FridayCompactionContextLoader,
  FridayCompactionContextLoadResult,
} from "./runtime/friday-agent-compaction-context-loader.js";
export { createFridayCompactionContextLoader } from "./runtime/friday-agent-compaction-context-loader.js";
export { verifyCompactionSummary } from "./runtime/friday-agent-compaction-verifier.js";
export { groupCompactionContextReplayRecords, formatCompactionContextForPrompt } from "./runtime/friday-agent-compaction-context-formatter.js";
export type {
  FridayAgentContextReplayKind,
  FridayAgentContextReplayRecord,
  FridayAgentContextReplayRepository,
  FridayAgentContextReplayTrustLevel,
} from "./persistence/friday-agent-context-replay-repository.js";
export { createFridayAgentContextReplayRepository } from "./persistence/friday-agent-context-replay-repository.js";
export type { FridayPreferenceInjector } from "./runtime/friday-agent-preference-injector.js";
export { createFridayPreferenceInjector } from "./runtime/friday-agent-preference-injector.js";

// ─── Model types ───

export type {
  FridayAgentRunStatus,
  FridayAgentToolGuardrailRiskLevel,
  FridayAgentToolPreGuardrailEvidence,
  FridayAgentToolPostGuardrailEvidence,
  FridayAgentToolGuardrailReceipt,
  FridayAgentToolDefinition,
  FridayAgentToolResult,
  FridayAgentToolResultTextBlock,
  FridayAgentToolResultImageBlock,
  FridayAgentToolResultFileBlock,
  FridayAgentToolResultContentBlock,
  FridayAgentTextBlock,
  FridayAgentImageBlock,
  FridayAgentToolUseBlock,
  FridayAgentToolResultBlock,
  FridayAgentContentBlock,
  FridayAgentMessage,
  FridayAgentToolCallRecord,
  FridayAgentRunRecord,
  FridayAgentRunMetadata,
  FridayAgentPackContextMetadata,
  FridayAgentArtifact,
  FridayAgentTestResult,
  FridayAgentTestError,
  FridayAgentPlanReviewPayload,
  FridayAgentActualExecution,
  FridayAgentActualTurn,
  FridayAgentRunConstraints,
  FridayAgentEventMap,
  FridayAgentEventName,
  FridayAgentRunStartedPayload,
  FridayAgentRunPlanningPayload,
  FridayAgentRunExecutingPayload,
  FridayAgentEtaConfidence,
  FridayAgentRunProgressPayload,
  FridayAgentRunAwaitingClarificationPayload,
  FridayAgentRunPlanReadyPayload,
  FridayAgentRunAwaitingPlanApprovalPayload,
  FridayAgentRunAwaitingToolApprovalPayload,
  FridayAgentToolStartPayload,
  FridayAgentToolEndPayload,
  FridayAgentRunCompletedPayload,
  FridayAgentRunFailedPayload,
  FridayAgentTextDeltaPayload,
  FridayAgentRunCancelledPayload,
  FridaySubagentSpawnedPayload,
  FridaySubagentCompletedPayload,
  FridayAgentRunDegradedPayload,
  FridayAgentModeChangedPayload,
  FridayAgentCapabilityGrantIssuedPayload,
  FridayAgentCapabilityGrantDeniedPayload,
  FridayAgentCapabilityGrantUsedPayload,
  FridayAgentCapabilityGrantRevokedPayload,
} from "./model/friday-agent.types.js";
export { FRIDAY_AGENT_TOOL_GUARDRAIL_SCHEMA_VERSION } from "./model/friday-agent.types.js";

// ─── Runtime ───

export type {
  FridayAgentRuntime,
  FridayAgentRuntimeResult,
  FridayAgentConversationContext,
  FridayContextEngineResolveInput,
  FridayContextEngineResolveResult,
  FridayContextEngineAfterTurnInput,
  FridayContextEngine,
  FridayAgentDelegationRequest,
  FridayAgentDelegationResult,
  FridayAgentContextCostComponent,
  FridayAgentContextCostSummary,
  FridayAgentSystemPromptContext,
  FridayAgentSystemPromptBuildResult,
  FridayAgentResumeRunParams,
  FridayAgentExecutionContext,
  CreateFridayAgentRuntimeDeps,
} from "./runtime/friday-agent-runtime.types.js";
export { createFridayAgentRuntime } from "./runtime/friday-agent-runtime.js";
export type {
  FridayAgentRunHealthState,
  FridayAgentRunHealthSnapshot,
  FridayAgentRunContextSummarySnapshot,
} from "./runtime/friday-agent-run-presentation.js";
export {
  buildFridayAgentRunHealthSnapshot,
  buildFridayAgentRunContextSummarySnapshot,
} from "./runtime/friday-agent-run-presentation.js";
export type {
  FridayAgentStarterSkillDescriptor,
  FridayAgentStarterSkillRoutingConfig,
} from "./runtime/friday-agent-starter-skill-routing.js";
export {
  buildFridayStarterSkillRoutingRetryPrompt,
  findFridayStarterSkillRoutingCandidate,
  hasFridayStarterSkillRoutingEvidence,
  shouldBypassFridayStarterSkillRouting,
} from "./runtime/friday-agent-starter-skill-routing.js";
export {
  createFridayWorkspaceContextEngine,
  notifyFridayContextEngineAfterTurn,
  resolveFridayContextEnginePromptFragment,
} from "./runtime/friday-agent-context-engine.js";
export { resolveFridayPublicRunUrl } from "./runtime/friday-public-run-url.js";
export { shouldDelegateFridayAgentTask } from "./runtime/friday-agent-delegation-policy.js";
export type {
  FridayAgentPlanningGateDecision,
  FridayAgentPlanningGateService,
  FridayPlanningKind,
} from "./runtime/friday-agent-planning-gate.js";
export { createFridayAgentPlanningGateService } from "./runtime/friday-agent-planning-gate.js";

// ─── System prompt builder ───

export type { BuildFridayAgentSystemPromptParams } from "./runtime/friday-agent-system-prompt-builder.js";
export { buildFridayAgentSystemPrompt } from "./runtime/friday-agent-system-prompt-builder.js";
export {
  createFridayAgentToolPackRequestTool,
  getFridayAgentToolPackNames,
  resolveFridayAgentToolNamesForPacks,
  resolveFridayAgentToolRouting,
} from "./runtime/friday-agent-tool-routing.js";
export type {
  FridayAgentPromptProfile,
  FridayAgentToolPackRequest,
  FridayAgentToolRoutingDecision,
  FridayAgentToolRoutingProfile,
} from "./runtime/friday-agent-tool-routing.js";
export {
  evaluateFridayExecutionVoiceResponse,
  FRIDAY_EXECUTION_VOICE_SAMPLE_SCENARIOS,
} from "./runtime/friday-agent-execution-voice-eval.js";
export type {
  FridayExecutionVoiceEvalFailure,
  FridayExecutionVoiceEvalResult,
  FridayExecutionVoiceScenario,
  FridayExecutionVoiceScenarioId,
} from "./runtime/friday-agent-execution-voice-eval.js";
export type { FridayWorkspaceContext, FridayWorkspaceContextFile } from "./runtime/friday-agent-workspace-context.js";
export { loadFridayWorkspaceContext } from "./runtime/friday-agent-workspace-context.js";
export type { FridayAgentAutomationSessionTarget } from "./services/friday-agent-automation-service.types.js";
export type {
  FridayToolUseBlock,
  FridayToolCallResult,
  FridayToolBatchGroup,
  ToolCallExecutor,
} from "./runtime/friday-agent-tool-batch-executor.js";
export {
  classifyToolBatchDependencies,
  executeToolBatch,
  extractFilePaths,
} from "./runtime/friday-agent-tool-batch-executor.js";
export type {
  FridayFileSnapshot,
  FridayFileConflictResult,
  FridayFileVersionTracker,
} from "./runtime/friday-agent-file-version-tracker.js";
export { createFridayFileVersionTracker } from "./runtime/friday-agent-file-version-tracker.js";
export {
  buildFridayAgentToolPostGuardrailEvidence,
  buildFridayAgentToolPreGuardrailEvidence,
} from "./runtime/friday-agent-tool-guardrail.js";

// ─── LLM client ───

export type {
  FridayAgentLlmClient,
  FridayAgentLlmStreamParams,
  FridayAgentLlmStreamEvent,
  FridayAgentLlmTextDeltaEvent,
  FridayAgentLlmToolUseEvent,
  FridayAgentLlmMessageEndEvent,
  CreateFridayAgentLlmClientDeps,
} from "./runtime/friday-agent-llm-client.types.js";
export { createFridayAgentLlmClient } from "./runtime/friday-agent-llm-client.js";
export type {
  FridayAgentTaskProfileId,
  FridayAgentTaskProfileEffort,
  FridayAgentTaskProfileInput,
  FridayResolvedAgentTaskProfile,
} from "./runtime/friday-agent-task-profile.js";
export { resolveFridayAgentTaskProfile } from "./runtime/friday-agent-task-profile.js";
export type {
  FridayAgentPreprocessorKind,
  FridayAgentPreprocessorInput,
  FridayAgentPreprocessorResult,
} from "./runtime/friday-agent-preprocessors.js";
export { preprocessFridayAgentContent } from "./runtime/friday-agent-preprocessors.js";

// ─── Event emitter ───

export type {
  FridayAgentEventEmitter,
  FridayAgentEventListener,
} from "./runtime/friday-agent-event-emitter.js";
export { createFridayAgentEventEmitter } from "./runtime/friday-agent-event-emitter.js";

// ─── Learning bridge ───

export type { FridayAgentLearningBridge, CreateFridayAgentLearningBridgeDeps } from "./runtime/friday-agent-learning-bridge.js";
export { createFridayAgentLearningBridge } from "./runtime/friday-agent-learning-bridge.js";

// ─── Decision engine (world model readiness) ───

export type { FridayDecisionEngine, FridayDecisionContext, FridayLocalDecision, FridayOutcomePrediction } from "./runtime/friday-agent-decision-engine.types.js";
export { createDefaultFridayDecisionEngine } from "./runtime/friday-agent-decision-engine.js";

// ─── World state manager (world model readiness) ───

export type { FridayWorldStateManager, CreateFridayWorldStateManagerDeps } from "./runtime/friday-agent-world-state-manager.js";
export { createFridayWorldStateManager } from "./runtime/friday-agent-world-state-manager.js";

// ─── World model types (world model readiness) ───

export type {
  FridayEpisode,
  FridayEpisodeStep,
  FridayEpisodeOutcome,
  FridayEpisodeStepCategory,
  FridayWorldState,
  FridayWorldEntity,
  FridayWorldEntityType,
  FridayLearnedPattern,
  FridayLearnedPatternKind,
} from "./model/friday-agent-world-state.types.js";

// ─── Tool registry ───

export type { CreateFridayAgentToolRegistryOptions, FridayAgentToolRegistryPartitioned } from "./tools/friday-agent-tool-registry.js";
export { createFridayAgentToolRegistry, partitionFridayAgentTools } from "./tools/friday-agent-tool-registry.js";

// ─── Tools ───

export type { CreateFridayAgentExecToolOptions } from "./tools/friday-agent-exec-tool.js";
export { createFridayAgentExecTool } from "./tools/friday-agent-exec-tool.js";
export type { CreateFridayAgentFeedbackToolDeps } from "./tools/friday-agent-feedback-tool.js";
export { createFridayAgentFeedbackTool } from "./tools/friday-agent-feedback-tool.js";
export { createFridayAgentFileTools } from "./tools/friday-agent-file-tools.js";
export type { CreateFridayAgentWebFetchToolOptions } from "./tools/friday-agent-web-fetch-tool.js";
export { createFridayAgentWebFetchTool, rewriteUrl } from "./tools/friday-agent-web-fetch-tool.js";
export type { CreateFridayAgentWebSearchToolOptions } from "./tools/friday-agent-web-search-tool.js";
export { createFridayAgentWebSearchTool } from "./tools/friday-agent-web-search-tool.js";
export type { CreateFridayAgentSkillToolDeps } from "./tools/friday-agent-skill-tool.js";
export { createFridayAgentSkillTool } from "./tools/friday-agent-skill-tool.js";
export type { CreateFridayAgentSkillsListToolDeps } from "./tools/friday-agent-skills-list-tool.js";
export { createFridayAgentSkillsListTool } from "./tools/friday-agent-skills-list-tool.js";
export type { CreateFridayAgentSkillGeneratorToolDeps } from "./tools/friday-agent-skill-generator-tool.js";
export { createFridayAgentSkillGeneratorTool } from "./tools/friday-agent-skill-generator-tool.js";
export type { CreateFridayAgentSkillImportToolDeps } from "./tools/friday-agent-skill-import-tool.js";
export { createFridayAgentSkillImportTool } from "./tools/friday-agent-skill-import-tool.js";
export type { CreateFridayAgentWorkflowToolDeps } from "./tools/friday-agent-workflow-tool.js";
export { createFridayAgentWorkflowTool } from "./tools/friday-agent-workflow-tool.js";
export type { CreateFridayAgentWorkflowGeneratorToolDeps } from "./tools/friday-agent-workflow-generator-tool.js";
export { createFridayAgentWorkflowGeneratorTool } from "./tools/friday-agent-workflow-generator-tool.js";
export type { CreateFridayAgentMemoryToolsDeps } from "./tools/friday-agent-memory-tools.js";
export { createFridayAgentMemoryTools } from "./tools/friday-agent-memory-tools.js";

// ─── Browser tool ───

export type { CreateFridayAgentBrowserToolOptions } from "./tools/friday-agent-browser-tool.js";
export { createFridayAgentBrowserTool } from "./tools/friday-agent-browser-tool.js";

// ─── XHS tool ───

export type { CreateFridayAgentXhsToolOptions } from "./tools/friday-agent-xhs-tool.js";
export { createFridayAgentXhsTool } from "./tools/friday-agent-xhs-tool.js";

// ─── Sub-agent tools ───

export type { CreateFridayAgentSubagentToolsDeps } from "./tools/friday-agent-subagent-tools.js";
export { createFridayAgentSubagentTools } from "./tools/friday-agent-subagent-tools.js";

// ─── Image analysis tool ───

export type { CreateFridayAgentImageAnalysisToolOptions, FridayImageAnalysisFn, FridayImageAnalysisRequest, FridayImageAnalysisResult, FridayImageAnalysisInput } from "./tools/friday-agent-image-analysis-tool.js";
export { createFridayAgentImageAnalysisTool } from "./tools/friday-agent-image-analysis-tool.js";

// ─── TTS tool ───

export type { CreateFridayAgentTtsToolOptions } from "./tools/friday-agent-tts-tool.js";
export { createFridayAgentTtsTool } from "./tools/friday-agent-tts-tool.js";

// ─── PDF parsing tool ───

export type { CreateFridayAgentPdfParseToolOptions } from "./tools/friday-agent-pdf-parse-tool.js";
export { createFridayAgentPdfParseTool } from "./tools/friday-agent-pdf-parse-tool.js";

// ─── Canvas tool ───

export type { CreateFridayAgentCanvasToolOptions } from "./tools/friday-agent-canvas-tool.js";
export { createFridayAgentCanvasTool } from "./tools/friday-agent-canvas-tool.js";

// ─── Nodes tool ───

export type { CreateFridayAgentNodesToolOptions } from "./tools/friday-agent-nodes-tool.js";
export { createFridayAgentNodesTool } from "./tools/friday-agent-nodes-tool.js";

// ─── Gateway tool ───

export type { CreateFridayAgentGatewayToolOptions } from "./tools/friday-agent-gateway-tool.js";
export { createFridayAgentGatewayTool } from "./tools/friday-agent-gateway-tool.js";

// ─── Cron tool ───

export type { CreateFridayAgentCronToolDeps } from "./tools/friday-agent-cron-tool.js";
export { createFridayAgentCronTool } from "./tools/friday-agent-cron-tool.js";

// ─── Message tool ───

export type { CreateFridayAgentMessageToolDeps } from "./tools/friday-agent-message-tool.js";
export { createFridayAgentMessageTool } from "./tools/friday-agent-message-tool.js";

// ─── Agents list tool ───

export type { CreateFridayAgentAgentsListToolDeps } from "./tools/friday-agent-agents-list-tool.js";
export { createFridayAgentAgentsListTool } from "./tools/friday-agent-agents-list-tool.js";

// ─── Sessions tool ───

export type { CreateFridayAgentSessionsToolDeps } from "./tools/friday-agent-sessions-tool.js";
export { createFridayAgentSessionsTool } from "./tools/friday-agent-sessions-tool.js";

// ─── Memory extract tool (OC-013) ───

export type { CreateFridayAgentMemoryExtractToolOptions } from "./tools/friday-agent-memory-extract-tool.js";
export { createFridayAgentMemoryExtractTool } from "./tools/friday-agent-memory-extract-tool.js";

// ─── MCP tool ───

export type {
  CreateFridayAgentMcpToolOptions,
  FridayMcpServerAvailability,
  FridayMcpServerAvailabilityResolver,
} from "./tools/friday-agent-mcp-tool.js";
export { createFridayAgentMcpTool } from "./tools/friday-agent-mcp-tool.js";

// ─── System tool ───

export type { CreateFridayAgentSystemToolOptions } from "./tools/friday-agent-system-tool.js";
export { createFridayAgentSystemTool } from "./tools/friday-agent-system-tool.js";

// ─── Guide Lens tool ───

export type { CreateFridayAgentGuideLensToolOptions } from "./tools/friday-agent-guide-lens-tool.js";
export { createFridayAgentGuideLensTool } from "./tools/friday-agent-guide-lens-tool.js";

// ─── Capabilities tool ───

export type {
  CreateFridayAgentCapabilitiesToolOptions,
  FridayAgentCapabilitiesSnapshot,
} from "./tools/friday-agent-capabilities-tool.js";
export { createFridayAgentCapabilitiesTool } from "./tools/friday-agent-capabilities-tool.js";

// ─── Controlled autonomy tool ───

export type { CreateFridayAgentControlledAutonomyToolDeps } from "./tools/friday-agent-controlled-autonomy-tool.js";
export { createFridayAgentControlledAutonomyTool } from "./tools/friday-agent-controlled-autonomy-tool.js";

// ─── Task status tool ───

export type {
  CreateFridayAgentTaskStatusToolOptions,
  FridayAgentTaskStatusSnapshot,
  FridayAgentTaskStatusSubagentSnapshot,
} from "./tools/friday-agent-task-status-tool.js";
export { createFridayAgentTaskStatusTool } from "./tools/friday-agent-task-status-tool.js";

// ─── Reflex tools ───

export type { CreateFridayAgentReflexToolsOptions } from "./tools/friday-agent-reflex-tools.js";
export { createFridayAgentReflexTools } from "./tools/friday-agent-reflex-tools.js";

// ─── Evidence block selector ───

export type { BuildFridayEvidenceBlocksInput } from "./runtime/friday-agent-evidence-blocks.js";
export { buildFridayEvidenceBlocks } from "./runtime/friday-agent-evidence-blocks.js";

// ─── MCP adapter ───

export type {
  FridayMcpServerConfig,
  FridayMcpServerState,
  FridayMcpToolDescriptor,
  FridayMcpCallToolInput,
  FridayMcpCallToolResult,
  FridayMcpResourceDescriptor,
  FridayMcpPromptDescriptor,
  FridayMcpDiscoveryState,
  FridayMcpTransport,
  FridayMcpServerPolicy,
  FridayMcpAdapter,
} from "./mcp/friday-mcp-adapter.types.js";
export {
  FRIDAY_MCP_ADAPTER_ERROR_CODES,
  createFridayMcpAdapter,
  isFridayMcpAdapterError,
  isForbiddenEnvVar,
  isSecretShapedEnvKey,
  parseFridayMcpServersFromEnv,
} from "./mcp/friday-mcp-adapter.js";
export { createFridayMcpConfigStore } from "./mcp/friday-mcp-config-store.js";
export type { FridayMcpConfigStore } from "./mcp/friday-mcp-config-store.js";
export type {
  FridayMcpServerReadiness,
  FridaySkillMcpReadiness,
} from "./mcp/friday-mcp-readiness.js";
export {
  evaluateFridaySkillMcpReadiness,
  listFridayMcpServerReadiness,
} from "./mcp/friday-mcp-readiness.js";
export type {
  FridayIntegrationRecommendation,
  FridayIntegrationRecommendationInput,
  FridayIntegrationRecommendationResult,
} from "./mcp/friday-mcp-cli-recommendation.js";
export { recommendFridayIntegrationMode } from "./mcp/friday-mcp-cli-recommendation.js";

// ─── Tool helpers ───

export {
  FridayAgentToolInputError,
  readStringParam,
  readNumberParam,
  readBooleanParam,
  readRecordParam,
  readStringOrNumberParam,
  readStringArrayParam,
  jsonResult,
  textResult,
  errorResult,
  imageResult,
  imageResultFromFile,
  fileResult,
  mixedResult,
  truncateOutput,
} from "./tools/friday-agent-tool-helpers.js";

// ─── Gateway validation ───

export type {
  GatewayValidationOptions,
  GatewayValidationResult,
} from "./tools/friday-agent-gateway-validation.js";
export {
  validateGatewayUrl,
  parseGatewayUrl,
  normalizeGatewayOptions,
} from "./tools/friday-agent-gateway-validation.js";

// ─── Persistence ───

export type { FridayAgentRunRepository } from "./persistence/friday-agent-run-repository.js";
export { createFridayAgentRunRepository } from "./persistence/friday-agent-run-repository.js";

export type { FridayAgentRunEventRepository, FridayAgentRunEventRecord } from "./persistence/friday-agent-run-event-repository.js";
export { createFridayAgentRunEventRepository } from "./persistence/friday-agent-run-event-repository.js";

export type { FridayAgentAutomationRepository } from "./services/friday-agent-automation-service.types.js";
export { createFridayAgentAutomationRepository } from "./persistence/friday-agent-automation-repository.js";

// ─── Automation service ───

export type {
  FridayAgentAutomationService,
  FridayAgentAutomationSchedule,
  FridayAgentAutomationSchedulerBridge,
  FridayAgentAutomationRecord,
  FridayAgentAutomationSaveInput,
  FridayAgentAutomationListFilters,
  FridayAgentAutomationUpdateInput,
  FridayAgentAutomationRunInput,
  CreateFridayAgentAutomationServiceDeps,
} from "./services/friday-agent-automation-service.types.js";
export { createFridayAgentAutomationService } from "./services/friday-agent-automation-service.js";

// ─── Sub-agent ───

export type {
  FridaySubagentRunStatus,
  FridaySubagentSpawnMode,
  FridaySubagentOutcome,
  FridaySubagentSpawnInput,
  FridaySubagentRunRecord,
  FridaySubagentContext,
  FridaySubagentRegistry,
  FridaySubagentRegistrySpawnInput,
  FridaySubagentDetachedResult,
  FridaySubagentListFilters,
  CreateFridaySubagentRegistryDeps,
  CreateChildRuntimeParams,
} from "./subagent/friday-subagent.types.js";

export {
  FRIDAY_SUBAGENT_MAX_DEPTH,
  FRIDAY_SUBAGENT_MAX_CONCURRENT,
  FRIDAY_SUBAGENT_DEFAULT_TIMEOUT_MS,
  FRIDAY_SUBAGENT_SESSION_KEY_SEPARATOR,
  FRIDAY_SUBAGENT_ERROR_CODES,
} from "./subagent/friday-subagent-constants.js";

export { buildFridaySubagentSystemPrompt } from "./subagent/friday-subagent-system-prompt.js";
export type { BuildSubagentSystemPromptParams } from "./subagent/friday-subagent-system-prompt.js";
export type {
  FridaySubagentProfileId,
  FridaySubagentProfileInput,
  FridayResolvedSubagentProfile,
} from "./subagent/friday-subagent-profile.js";
export {
  inferFridaySubagentProfile,
  resolveFridaySubagentProfile,
  taskLikelyNeedsWriteAccessForSubagent,
} from "./subagent/friday-subagent-profile.js";

export { createFridaySubagentRegistry } from "./subagent/friday-subagent-registry.js";

export type { FridaySubagentRunRepository } from "./persistence/friday-subagent-run-repository.js";
export { createFridaySubagentRunRepository } from "./persistence/friday-subagent-run-repository.js";

// ─── Review gate ───

export type { FridayAgentReviewGate, FridayAgentReviewMode, FridayAgentReviewDecision, FridayAgentPlanReview, FridayAgentPlanSummary } from "./runtime/friday-agent-review-gate.js";
export { createFridayAgentReviewGate } from "./runtime/friday-agent-review-gate.js";

// ─── Tool mutation ───

export { isMutatingToolCall } from "./runtime/friday-agent-tool-mutation.js";

// ─── Operational mode ───

export type { FridayOperationalMode, FridayToolCategory, FridayModeConfig } from "./runtime/friday-agent-operational-mode.js";
export { FRIDAY_MODE_CONFIGS, filterToolsByMode, resolveToolCategory, validateModeTransition } from "./runtime/friday-agent-operational-mode.js";

// ─── Degradation handler ───

export type { FridayDegradationLevel } from "./runtime/friday-agent-degradation-handler.js";
export { assessDegradation, getDegradationSystemPrompt } from "./runtime/friday-agent-degradation-handler.js";

// ─── SSRF guard ───

export type { FridayAgentSsrfGuard, FridaySsrfPolicy, PinnedHostname, LookupFn } from "./security/friday-agent-ssrf-guard.js";
export { createFridayAgentSsrfGuard, isPrivateIpv4, isPrivateIpv6, isPrivateIp, FridaySsrfBlockedError, resolvePinnedHostname, createPinnedLookup } from "./security/friday-agent-ssrf-guard.js";

// ─── SSRF-guarded fetch ───

export type { FridayAgentFetchGuardOptions, FridayGuardedFetchParams } from "./security/friday-agent-fetch-guard.js";
export { fetchWithFridayAgentSsrfGuard } from "./security/friday-agent-fetch-guard.js";

// ─── Artifact writer ───

export type {
  FridayAgentEvidenceReceiptCounts,
  FridayAgentEvidenceReceiptFile,
  FridayAgentEvidenceReceiptStatus,
  FridayAgentReplayableEvidenceReceipt,
} from "./services/friday-agent-evidence-receipt.js";
export {
  buildFridayAgentReplayableEvidenceReceipt,
  FRIDAY_AGENT_EVIDENCE_RECEIPT_SCHEMA_VERSION,
  renderFridayAgentEvidenceReceiptMarkdown,
} from "./services/friday-agent-evidence-receipt.js";
export type {
  BuildFridayAgentUnifiedTaskStateInput,
  FridayAgentUnifiedTaskRequiredAction,
  FridayAgentUnifiedTaskState,
  FridayAgentUnifiedTaskStatePointer,
  FridayAgentUnifiedTaskStateSnapshot,
} from "./services/friday-agent-unified-task-state.js";
export {
  buildFridayAgentUnifiedTaskState,
  FRIDAY_AGENT_UNIFIED_TASK_STATE_SCHEMA_VERSION,
} from "./services/friday-agent-unified-task-state.js";
export type { FridayAgentArtifactWriter, FridayAgentArtifactWriterParams, FridayAgentArtifactWriterResult } from "./services/friday-agent-artifact-writer.js";
export { createFridayAgentArtifactWriter } from "./services/friday-agent-artifact-writer.js";

// ─── Testing ───

export type {
  FridayAgentSelfTestService,
  FridayAgentSelfTestParams,
  FridayAgentArtifactKind,
  CreateFridayAgentSelfTestServiceDeps,
  FridayAgentExecOutput,
} from "./testing/friday-agent-self-test-service.types.js";
export { createFridayAgentSelfTestService } from "./testing/friday-agent-self-test-service.js";

export type {
  FridayAgentSelfFixService,
  FridayAgentSelfFixParams,
  FridayAgentSelfFixResult,
} from "./testing/friday-agent-self-fix-service.js";
export { createFridayAgentSelfFixService } from "./testing/friday-agent-self-fix-service.js";

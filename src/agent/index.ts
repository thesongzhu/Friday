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
  FRIDAY_AGENT_ERROR_CODES,
  FRIDAY_AGENT_SESSION_KEY_PREFIX,
} from "./friday-agent.constants.js";

// ─── Model types ───

export type {
  FridayAgentRunStatus,
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
  FridayAgentToolStartPayload,
  FridayAgentToolEndPayload,
  FridayAgentRunCompletedPayload,
  FridayAgentRunFailedPayload,
  FridayAgentTextDeltaPayload,
  FridayAgentRunCancelledPayload,
  FridaySubagentSpawnedPayload,
  FridaySubagentCompletedPayload,
} from "./model/friday-agent.types.js";

// ─── Runtime ───

export type {
  FridayAgentRuntime,
  FridayAgentRuntimeResult,
  FridayAgentConversationContext,
  FridayAgentExecutionContext,
  CreateFridayAgentRuntimeDeps,
} from "./runtime/friday-agent-runtime.types.js";
export { createFridayAgentRuntime } from "./runtime/friday-agent-runtime.js";
export { resolveFridayPublicRunUrl } from "./runtime/friday-public-run-url.js";

// ─── System prompt builder ───

export type { BuildFridayAgentSystemPromptParams } from "./runtime/friday-agent-system-prompt-builder.js";
export { buildFridayAgentSystemPrompt } from "./runtime/friday-agent-system-prompt-builder.js";
export type { FridayWorkspaceContext, FridayWorkspaceContextFile } from "./runtime/friday-agent-workspace-context.js";
export { loadFridayWorkspaceContext } from "./runtime/friday-agent-workspace-context.js";

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

// ─── Event emitter ───

export type {
  FridayAgentEventEmitter,
  FridayAgentEventListener,
} from "./runtime/friday-agent-event-emitter.js";
export { createFridayAgentEventEmitter } from "./runtime/friday-agent-event-emitter.js";

// ─── Learning bridge ───

export type { FridayAgentLearningBridge, CreateFridayAgentLearningBridgeDeps } from "./runtime/friday-agent-learning-bridge.js";
export { createFridayAgentLearningBridge } from "./runtime/friday-agent-learning-bridge.js";

// ─── Tool registry ───

export type { CreateFridayAgentToolRegistryOptions } from "./tools/friday-agent-tool-registry.js";
export { createFridayAgentToolRegistry } from "./tools/friday-agent-tool-registry.js";

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

export type { CreateFridayAgentMcpToolOptions } from "./tools/friday-agent-mcp-tool.js";
export { createFridayAgentMcpTool } from "./tools/friday-agent-mcp-tool.js";

// ─── System tool ───

export type { CreateFridayAgentSystemToolOptions } from "./tools/friday-agent-system-tool.js";
export { createFridayAgentSystemTool } from "./tools/friday-agent-system-tool.js";

// ─── Capabilities tool ───

export type {
  CreateFridayAgentCapabilitiesToolOptions,
  FridayAgentCapabilitiesSnapshot,
} from "./tools/friday-agent-capabilities-tool.js";
export { createFridayAgentCapabilitiesTool } from "./tools/friday-agent-capabilities-tool.js";

// ─── MCP adapter ───

export type {
  FridayMcpServerConfig,
  FridayMcpToolDescriptor,
  FridayMcpCallToolInput,
  FridayMcpCallToolResult,
  FridayMcpResourceDescriptor,
  FridayMcpPromptDescriptor,
  FridayMcpTransport,
  FridayMcpServerPolicy,
  FridayMcpAdapter,
} from "./mcp/friday-mcp-adapter.types.js";
export {
  FRIDAY_MCP_ADAPTER_ERROR_CODES,
  createFridayMcpAdapter,
  isFridayMcpAdapterError,
  parseFridayMcpServersFromEnv,
} from "./mcp/friday-mcp-adapter.js";

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

export { createFridaySubagentRegistry } from "./subagent/friday-subagent-registry.js";

export type { FridaySubagentRunRepository } from "./persistence/friday-subagent-run-repository.js";
export { createFridaySubagentRunRepository } from "./persistence/friday-subagent-run-repository.js";

// ─── Review gate ───

export type { FridayAgentReviewGate, FridayAgentReviewMode, FridayAgentReviewDecision, FridayAgentPlanReview, FridayAgentPlanSummary } from "./runtime/friday-agent-review-gate.js";
export { createFridayAgentReviewGate } from "./runtime/friday-agent-review-gate.js";

// ─── Tool mutation ───

export { isMutatingToolCall } from "./runtime/friday-agent-tool-mutation.js";

// ─── SSRF guard ───

export type { FridayAgentSsrfGuard, FridaySsrfPolicy, PinnedHostname, LookupFn } from "./security/friday-agent-ssrf-guard.js";
export { createFridayAgentSsrfGuard, isPrivateIpv4, isPrivateIpv6, isPrivateIp, FridaySsrfBlockedError, resolvePinnedHostname, createPinnedLookup } from "./security/friday-agent-ssrf-guard.js";

// ─── SSRF-guarded fetch ───

export type { FridayAgentFetchGuardOptions, FridayGuardedFetchParams } from "./security/friday-agent-fetch-guard.js";
export { fetchWithFridayAgentSsrfGuard } from "./security/friday-agent-fetch-guard.js";

// ─── Artifact writer ───

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

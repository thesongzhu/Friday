/**
 * Phase C — Hub Bootstrap (composition root).
 *
 * Wires state, skills, executor, workflow runtime, API runtime, and
 * optional runtimes into a single `FridayHub` handle that the CLI
 * can start/stop.
 *
 * Helper functions, type definitions, and stub services live in
 * `./bootstrap/hub-helpers.ts` to keep this composition root focused.
 */

import { exec as execCb, execFile as execFileCb } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { FRIDAY_VERSION } from "../lib/version.js";
import { createFridayAutonomousEngine } from "../agent/autonomous/friday-autonomous-engine.js";
import { createFridayAutonomousRepository } from "../agent/autonomous/friday-autonomous-repository.js";
import type { FridayAutonomousEngine } from "../agent/autonomous/friday-autonomous.types.js";
import { createFridayAgentAutonomousTool } from "../agent/tools/friday-agent-autonomous-tool.js";
import { createFridayAgentControlledAutonomyTool } from "../agent/tools/friday-agent-controlled-autonomy-tool.js";
import { createFridayAgentSetupAssistantTool } from "../agent/tools/friday-agent-setup-assistant-tool.js";
import { createFridayAgentSetupTool } from "../agent/tools/friday-agent-setup-tool.js";
import {
  createFridayEnvironmentScanner,
  createFridayPrerequisiteInstaller,
  createFridaySetupAssistant,
  createFridaySetupCoordinator,
  createFridaySetupRecipeExecutor,
  createFridaySetupRecipeRegistry,
  FRIDAY_BUILTIN_RECIPES,
} from "../setup/index.js";
import { createOnboardingEngine } from "../uix/engine/index.js";
import {
  createFridayCrossBorderPackService,
  type FridayCrossBorderPackService,
} from "../packs/cross-border/friday-cross-border-pack-service.js";
import {
  buildFridayCustomPackPromptFragment,
  findFridayCustomPackById,
} from "../packs/custom/friday-custom-pack-context.js";
import { FridayDomainError } from "#errors";
import { buildOpenBrowserUrlCommand, isFridayTestSecurityWarningSuppressed, safeJsonParse } from "#utilities";
import { initializeFridayState } from "#state";
import type { FridayStateRuntime } from "#state";
import { createFridayLocalDaemonService } from "#daemon";
import { createFridayMutatingActionGate } from "../security/friday-mutating-action-gate.js";
import {
  buildFridayRuntimeCapabilityMatrix,
  createFridayProviderCostCalculator,
  createFridayProviderPricingCatalog,
  createFridayProviderService,
  createFridaySecretAdminService,
  createFridaySecretRepository,
  decryptSecretWithMigration,
  fridaySecretAadContext,
  getFridayProviderPreset,
  getStrictMasterKey,
  normalizeFridayProviderSupportedModels,
  resolveFridayRoutingStabilityWarning,
} from "#providers";
import type { FridayEncryptedEnvelope, FridayProviderApi, FridayProviderKind, FridayProviderProfile, FridayProviderService } from "#providers";
import { createFridayProviderContextCompactor, createFridayProviderContextPruner, createFridayProviderTokenEstimator } from "#providers";
import {
  createFridayManagedSkillsCatalogBackend,
  createFridaySkillInstallationRepository,
  createFridaySkillInstallationService,
  createFridaySkillLifecycleService,
  createFridaySkillPackageInstaller,
  createFridaySkillPermissionCheckService,
  createFridaySkillRepository,
  createFridaySkillSignatureVerifier,
  createFridaySkillTrustScoringService,
  createFridaySkillVersionRepository,
  createFridaySkillVersionResolutionService,
  FridaySkillRegistryImpl,
  safeParseFridaySkillManifestV2,
} from "#skills";
import type { SkillLifecycleStatus, SkillOrigin, SkillSource } from "#skills";
import { createFridaySkillExecutor } from "#skills";
import { createFridaySkillGeneratorService } from "#skills/generator";
import { createFridayWorkflowGeneratorService } from "#workflows";
import type { FridayWorkflowGeneratorService } from "#workflows";
import {
  createDarwinProgramScanner,
  createFridayProgramDiscoveryService,
  createFridaySkillConverterRegistry,
  createFridaySkillConverterService,
  createFridaySkillImportInstaller,
  createFridaySkillPackageArchiver,
  createLinuxProgramScanner,
  createWin32ProgramScanner,
  FRIDAY_DEFAULT_CONVERTER_FACTORIES,
  type FridaySkillInstallTarget,
  type FridaySkillSourceFormat,
  redactFridaySkillSourceText,
} from "#skills/converter";
import { createFridaySkillRunStore } from "#ledger";
import type { FridayLearningEventAppendInput } from "#ledger";
import {
  createFridayWorkflowBuilderRuntime,
  createFridayWorkflowCompiler,
  createFridayWorkflowProductService,
  createFridayWorkflowRuntime,
  createFridayWorkflowSatelliteDispatchService,
  type JsonValue,
  resolveFridayPipelineRuntimeConfig,
} from "#workflows";
import { createFridayWorkflowTriggerRepository } from "#workflows";
import {
  createFridayApiRuntime,
  createFridayDeterministicPipelineRuntime,
  createFridayMissionAutoDispatchDriver,
  createFridayReflexRoutes,
  createFridayRustHubSystemIntentService,
  getChannelPersona,
  hydrateChannelPersonaStore,
  RUST_ROUTE_CLAUDE_MODEL,
  RUST_ROUTE_CLAUDE_PROVIDER_ID,
  RUST_ROUTE_CODEX_MODEL,
  RUST_ROUTE_CODEX_PROVIDER_ID,
  RUST_ROUTE_DEEPSEEK_FLASH_MODEL,
  RUST_ROUTE_DEEPSEEK_PROVIDER_ID,
} from "#api";
import type { MissionAutoDispatchStartRun } from "#api";
import {
  createFridayMediaUnderstandingService,
  createFridayOpenAiVisionProvider,
  DEFAULT_OPENAI_VISION_MODEL,
} from "#media-understanding";
import { createFridaySocialImportService } from "#skills/social-import";
import { parseFridaySecretInput, resolveFridaySecretInput } from "../security/friday-secret-ref.js";
import { createFridayRustHubWorkbenchProjectionService } from "../api/mission-spine/friday-rust-hub-workbench-projection-service.js";
import {
  createFridayMissionSpineDispatchAdapter,
  readMissionSpineRustWsPort,
} from "../api/mission-spine/friday-mission-spine-dispatch-adapter.js";
import {
  createFridayMemorySpineDispatchAdapter,
  readMemorySpineRustWsPort,
} from "../api/mission-spine/friday-memory-spine-dispatch-adapter.js";
import {
  createFridayRunOutcomeLearningDispatchAdapter,
  readRunOutcomeLearningRustWsPort,
} from "../api/mission-spine/friday-run-outcome-learning-dispatch-adapter.js";
import { resolveRustAgentRunWsClientX25519Secret } from "../api/mission-spine/friday-rust-hub-agent-run-ws-client-x25519-secret.js";
import { createFridayRustHubSessionLifecycleDispatchAdapter } from "../api/mission-spine/friday-rust-hub-session-lifecycle-dispatch-adapter.js";
import type { FridayChannelPersonaConfig, FridayGuideLensRoutesDeps, FridaySystemRoutesDeps } from "#api";
import type { FridayPackagingRoutesDeps } from "../api/http/routes/friday-packaging-routes.js";
import {
  createSqlitePackageInstaller,
  createSqliteRegistryManager,
  createSqliteTrustedKeyStore,
} from "../packaging/persistence/friday-package-sqlite-store.js";
import {
  createFridayPackagingApiHandlers,
} from "../packaging/api/index.js";
import { decodeFridayPackageArchiveEnvelope } from "../packaging/engine/package-archive-envelope.js";
import { verifySignatureLogical } from "../packaging/engine/package-validator.js";
import {
  createFridayRulesRepository,
  FridayRuleEngine,
} from "#rules";
import type {
  FridayEvaluationContext,
  FridayEvaluationResult,
} from "#rules";
import {
  createFridayPluginDependencyResolver,
  createFridayPluginLoader,
  createFridayPluginManifestLoader,
  createFridayPluginRegistryService,
  createFridayPluginRepository,
  createFridayPluginService,
  createFridayPluginSignatureVerifier,
} from "#plugins";
import type { FridayPluginService } from "#plugins";
import { createFridayEpisodeExtractor, createFridayMemoryFileSyncRepository, createFridayMemoryFileSyncService, createFridayMemoryGuardServiceFactory, createFridayMemoryService, createFridayPatternExtractor } from "#memory";
import {
  createFridaySessionMemoryExtractionService,
  finalizeFridayConversationFocus,
  prepareFridayConversationTurn,
} from "#sessions";
import type { FridayConversationBlock } from "#sessions";
import type { FridayMemoryFileSyncService, FridayMemoryGuardServiceFactory, FridayMemoryService } from "#memory";
import {
  buildFridayAgentRunContextSummarySnapshot,
  buildFridayAgentRunHealthSnapshot,
  buildFridayAgentSystemPrompt,
  buildFridayEvidenceBlocks,
  createDefaultFridayDecisionEngine,
  createFridayAgentAgentsListTool,
  createFridayAgentArtifactWriter,
  createFridayAgentAutomationRepository,
  createFridayAgentCompactionBridge,
  createFridayAgentCronTool,
  createFridayAgentEventEmitter,
  createFridayAgentFeedbackTool,
  createFridayAgentGatewayTool,
  createFridayAgentImageAnalysisTool,
  createFridayAgentLearningBridge,
  createFridayAgentLlmClient,
  createFridayAgentMemoryExtractTool,
  createFridayAgentMessageTool,
  createFridayAgentNodesTool,
  createFridayAgentPlanningGateService,
  createFridayAgentReviewGate,
  createFridayAgentRunEventRepository,
  createFridayAgentRunRepository,
  createFridayAgentRuntime,
  createFridayAgentSelfFixService,
  createFridayAgentSelfTestService,
  createFridayAgentSkillGeneratorTool,
  createFridayAgentSkillImportTool,
  createFridayAgentSsrfGuard,
  createFridayAgentSubagentTools,
  createFridayAgentToolRegistry,
  createFridayAgentWorkflowGeneratorTool,
  createFridayCompactionContextLoader,
  createFridayCompactionContextReplaySink,
  createFridayMcpAdapter,
  createFridayMcpConfigStore,
  createFridaySubagentRegistry,
  createFridayWorkspaceContextEngine,
  createFridayWorldStateManager,
  fetchWithFridayAgentSsrfGuard,
  inferFridaySubagentProfile,
  listFridayMcpServerReadiness,
  loadFridayWorkspaceContext,
  parseFridayMcpServersFromEnv,
  resolveFridayAgentTaskProfile,
  resolveFridayContextEnginePromptFragment,
  taskLikelyNeedsWriteAccessForSubagent,
} from "#agent";
import type { FridayAgentModeChangedPayload, FridayAgentRunDegradedPayload } from "#agent";
import { buildMcpServerToolFilter } from "./friday-mcp-safe-catalog.js";

import { classifyFridayExecution } from "../sessions/services/friday-execution-classifier.js";
import { dispatchDeterministic } from "../sessions/services/friday-deterministic-dispatch.js";
import type { FridayDeterministicDispatchDeps } from "../sessions/services/friday-deterministic-dispatch.js";
import { dispatchManagedAsync } from "../sessions/services/friday-managed-async-dispatch.js";
import type { FridayManagedAsyncDispatchDeps } from "../sessions/services/friday-managed-async-dispatch.js";
import { createFridayChannelEntryAdapter, createFridayOrchestrationEngine } from "#engine";
import { createFridayImmediateRunPersistence } from "#engine";
import type { CreateFridayEngineRunExecutorDeps, CreateFridayEngineTurnPreparerDeps } from "#engine";
import type { FridayImageAnalysisFn } from "#agent";
import type {
  FridayAgentCapabilitiesSnapshot,
  FridayAgentLlmClient,
  FridayAgentLlmStreamEvent,
  FridayAgentMessage,
  FridayAgentReviewMode,
  FridayAgentRunRecord,
  FridayAgentRunStatus,
  FridayAgentRuntime,
  FridayAgentStarterSkillDescriptor,
  FridayAgentTaskStatusSnapshot,
  FridayContextEngineAfterTurnInput,
} from "#agent";
import {
  createDiscordGatewayService,
  createDiscordRestService,
  createFridayChannelLoader,
  createFridayChannelRegistry,
  createFridayDiscordChannel,
  createFridayIrcChannel,
  createFridayLarkChannel,
  createFridayLineChannel,
  createFridayQqChannel,
  createFridaySignalChannel,
  createFridaySlackChannel,
  createFridayTelegramChannel,
  createFridayWebchatChannel,
  createFridayWhatsappChannel,
  createIrcConnectionService,
  createLarkWebhookRelayService,
  createLineApiService,
  createLineWebhookListenerService,
  createSignalRpcService,
  createSignalSseService,
  createSlackHttpEventService,
  createSlackSocketService,
  createSlackWebApiService,
  createTelegramApiService,
  createTelegramPollingService,
  createTelegramWebhookService,
  createWebchatWsService,
  createWhatsappApiService,
  createWhatsappWebhookService,
  FRIDAY_CHANNEL_SECRET_SCOPE,
  FRIDAY_SUPPORTED_CHANNEL_KINDS,
  FridaySqliteTelegramInboxStore,
  isControlCapableChannelKind,
  isFridayChannelKindSupported,
  isFridayChannelModeSupported,
  parseFridayChannelsConfig,
  resolveFridayChannelSecretPolicy,
} from "#channels";
import type {
  FridayChannelMessage,
  FridayChannelMessageHandler,
  FridayChannelRegistry,
} from "#channels";
import { createFridayChannelInboundDebouncer, createFridayChannelTypingController, sanitizeChannelInput } from "#channels";
import { createFridayChannelSlowTaskNotifier } from "../channels/friday-channel-slow-task-notifier.js";
import { resolveFridayPublicRunUrl } from "../agent/runtime/friday-public-run-url.js";
import {
  createFridaySatelliteRepository,
  createFridaySatelliteRuntime,
} from "#satellites";
import { createFridaySatelliteNodesService } from "../nodes/friday-satellite-nodes-service.js";
import { createFridayAutonomySubjectUpgradeStateRepository } from "../autonomy/persistence/friday-autonomy-subject-upgrade-state-repository.js";
import {
  createFridayAgentLoopRepository,
  createFridayAgentLoopService,
  createFridayApprovalRequestRepository,
  createFridayAutoFixActionRepository,
  createFridayDiagnosisRecordRepository,
  createFridayErrorIncidentRepository,
  createFridayLearnedLessonRepository,
  createFridayPreferenceFactRepository,
  createFridaySelfHealingApiService,
  createFridaySelfLearningRuntime,
  type FridayExtractedSignal,
} from "#learning";
import {
  createFridayDiskGrowthHolder,
  type FridayDiskGrowthHolder,
  type FridayDiskGrowthWarning,
} from "../learning/services/friday-disk-growth-evaluator.js";
import {
  createFridayObservabilityApiService,
} from "../observability/services/friday-observability-api-service.js";
import { createFridaySatelliteRuntimeRoutes } from "../api/http/routes/friday-satellite-runtime-routes.js";
import { scanLocalSkills } from "../skills/converter/discovery/friday-local-skill-scanner.js";
import { getCommunitySkillCatalog } from "../skills/converter/discovery/friday-community-skill-catalog.js";
import { createFridayScanMigrateRoutes } from "../api/http/routes/friday-scan-migrate-routes.js";
import { createFridaySessionService } from "#sessions";
import {
  computeNextRunAtMs,
  createFridayApprovalExpiryJob,
  createFridayJobSchedulerRepository,
  createFridayJobSchedulerService,
  createFridayLearningMetricsJob,
  createFridayRetentionPolicyLoader,
  createFridayRetentionSettingsRepository,
  createFridayRetentionSettingsStore,
  createFridaySessionMemoryExtractionWorkerJob,
  createFridayWorkflowCronTriggerJob,
  createFridayWorkflowTimeoutJob,
} from "#jobs";
import type {
  FridayJobSchedulerRepository,
  FridayJobSchedulerService,
  FridayScheduledJobDefinition,
} from "#jobs";
import { createFridayBrowserManager, FRIDAY_BROWSER_ALLOW_ANY_ORIGIN, type FridayBrowserManager } from "#browser";
import { createXhsPageInteractions, createXhsSessionManager } from "#xhs";
import {
  createFridayHeartbeatJob,
  createFridayHeartbeatRunner,
  createFridayHeartbeatStateRepository,
} from "../heartbeat/index.js";
import {
  checkAdapterHealth,
  createDesktopSessionManager,
  createPlatformAdapter,
} from "../desktop/engine/index.js";
import type { DesktopSessionManager } from "../desktop/engine/session-manager.js";
import {
  createFridaySystemLocalCompanionBridge,
  createFridaySystemNamedPipeBridge,
  createFridaySystemService,
  createFridaySystemUnavailableCompanionBridge,
  createFridaySystemUnixSocketBridge,
  createFridaySystemUnixSocketCompanionServer,
  resolveFridaySystemCompanionAuthToken,
  resolveFridaySystemCompanionPipeName,
  resolveFridaySystemCompanionServerMode,
} from "../system/index.js";
import type { FridaySystemRemoteMode, FridaySystemService } from "../system/index.js";
import { createFridayGuideLensHttpParserAdapter, createFridayGuideLensService } from "../guide-lens/index.js";
import type { FridayGuideLensPreferences } from "../guide-lens/index.js";
import { buildFridayCommunicationPromptFragment, resolveFridayCommunicationPersona } from "../uix/services/friday-communication-persona.js";
import { buildFridayUserConstitutionPreferencePromptFragment } from "../reflex/services/friday-user-constitution.js";
import { createFridayUixGuidedContextRepository } from "../uix/persistence/friday-uix-guided-context-repository.js";
import { createFridayUixUserPreferenceRepository } from "../uix/persistence/friday-uix-user-preference-repository.js";
import { createFridayOnboardingSessionRepository } from "../uix/persistence/friday-onboarding-session-repository.js";
import { createFridayUixSurfaceService } from "../uix/services/friday-uix-surface-service.js";
import {
  createFridayReflexCandidateRepository,
  createFridayReflexOnboardingRepository,
  createFridayReflexService,
  type FridayReflexService,
  parseFridayReflexExplicitPreferenceMessage,
} from "../reflex/index.js";
import { appendFridayAuditLog, resolveFridayAuditLogPath } from "./services/friday-hub-audit-log-writer.js";
import { createFridayGatewayService } from "./services/friday-gateway-service.js";
import { createFridayProviderBackedTtsService } from "../media/friday-provider-backed-tts-service.js";
import { createFridayChannelNaturalTriggerResolver } from "./bootstrap/friday-channel-natural-trigger-resolver.js";
// F1.5 — Headless Rust-route self-probe diagnostic (DARK, DEFAULT-OFF). The `mintDiagnosticAdminBearer`
// self-mint is intentionally module-scoped (NOT re-exported from a barrel) to avoid re-creating the
// rejected H-a "assert admin without a token" trust surface; only this wiring + its test import it.
import {
  createRustRouteLoopbackTransport,
  createRustRouteProbeOutcomeHolder,
  maybeBuildRustRouteSelfProbeJob,
  resolveRustRouteDiagnosticConfig,
  RUST_ROUTE_DIAGNOSTIC_JOB_ID,
  type RustRouteProbeOutcomeHolder,
} from "../diagnostics/friday-rust-route-self-probe.js";

// ─── Extracted helpers, types, and stubs ───

import {
  buildFridayChannelDeliveryFailureText,
  buildFridayChannelMessageTooLongText,
  canResolveFridayChannelApprovalFromMessage,
  createDurableMemoryState,
  createFridayChannelToolApprovalShortId,
  createFridayHubAutoFixExecutionSupport,
  createPersistentConfigManager,
  createStubMemoryState,
  evaluateFridayChannelApprovalExpiry,
  loadChannelsConfigFromSetupState,
  mapPolicyBundleRow,
  mapRuleRow,
  mapSessionMessageToAgentMessage,
  normalizeScopeList,
  parseDesktopSandboxAllowedRoots,
  parseFridayChannelIdentityMap,
  resolveBrowserHostConfigFromEnv,
  resolveBrowserPresentationModeFromEnv,
  resolveChannelInitConfigWithSecretPolicy,
  resolveFridayChannelApprovalPrincipalId,
  resolveFridayChannelDisabledToolNames,
  resolveFridayChannelSessionKey,
  resolveFridayChannelTerminalText,
  resolveTokenSecret,
  sanitizeFridayChannelVisibleReply,
  stripFridayUiActionHints,
} from "./bootstrap/hub-helpers.js";
import { resolveFridayCapabilityGates } from "./bootstrap/friday-capability-gates.js";

// Re-export public API for backward compatibility with `#hub` barrel.
export {
  canResolveFridayChannelApprovalFromMessage,
  createFridayChannelToolApprovalShortId,
  evaluateFridayChannelApprovalExpiry,
  parseFridayChannelIdentityMap,
  resolveFridayChannelApprovalPrincipalId,
  resolveFridayChannelDisabledToolNames,
  resolveFridayChannelSessionKey,
  sanitizeFridayChannelVisibleReply,
  resolveTokenSecret,
} from "./bootstrap/hub-helpers.js";
export { createFridayChannelNaturalTriggerResolver } from "./bootstrap/friday-channel-natural-trigger-resolver.js";

type FridayWarnSink = (message: string) => void;

// P2-06: Module-level Set avoids WeakMap edge cases with replaced warn sinks.
const warnedMessages = new Set<string>();

function warnOnce(warn: FridayWarnSink, message: string): void {
  if (warnedMessages.has(message)) return;
  if (warnedMessages.size > 500) warnedMessages.clear();
  warnedMessages.add(message);
  warn(message);
}

function warnHubBootstrapOnce(message: string): void {
  warnOnce(console.warn as FridayWarnSink, message);
}

function warnHubBootstrapOperationFailureOnce(error: unknown): void {
  warnHubBootstrapOnce(
    `[friday][hub-bootstrap] operation failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function isExpectedProviderNoRouting(error: unknown): boolean {
  return error instanceof FridayDomainError
    && error.code === "PROVIDER_NO_ROUTING";
}

export type {
  FridayHub,
  FridayHubConfig,
  FridayHubStatus,
  FridayResolvedHubConfig,
  FridayTokenSecretResult,
} from "./bootstrap/hub-helpers.js";

import type {
  FridayHub,
  FridayHubConfig,
  FridayHubStatus,
  FridayResolvedHubConfig,
  FridayTokenSecretResult,
} from "./bootstrap/hub-helpers.js";

// ─── Constants ───

/**
 * B3 / FRI-AUD-005 fail-closed error builders for desktop policy + permission
 * decision deps. Desktop policy persistence is `proof_pending` in this
 * release (no durable storage, no policy evaluator, no audit/rollback wiring).
 * Routes stay registered for contract stability but live calls must surface a
 * typed 503 so callers (UI/agents) can render the truthful state instead of
 * accepting a synthetic-echo response as enforced.
 *
 * See POST_RELEASE_DEFAULT_DECISIONS.md B3:
 *   "Desktop policy routes must either persist/enforce real policy with audit
 *    and rollback, or be hidden/gated/labeled proof_pending. Synthetic IDs,
 *    echoed policy, empty reads, or no-op permissions must not look enforced."
 */
function createDesktopPolicyNotPersistedError(operation: string): FridayDomainError {
  return new FridayDomainError(
    "DESKTOP_POLICY_NOT_PERSISTED",
    `Desktop policy "${operation}" is proof_pending in this release: no durable storage, evaluator, or audit/rollback wiring exists. Routes remain registered for contract stability but no policy is persisted or enforced. See release notes.`,
    { httpStatus: 503, details: { operation, status: "proof_pending" } },
  );
}

function createDesktopPermissionDecisionNotPersistedError(operation: string): FridayDomainError {
  return new FridayDomainError(
    "DESKTOP_PERMISSION_DECISION_NOT_PERSISTED",
    `Desktop permission decision "${operation}" is proof_pending in this release: prompt decisions are not durably stored and a decisions log is not yet wired. permissions.list (OS capability check) remains live. See release notes.`,
    { httpStatus: 503, details: { operation, status: "proof_pending" } },
  );
}

/** Default server version reported by the API runtime. */
const FRIDAY_HUB_DEFAULT_SERVER_VERSION = FRIDAY_VERSION;
const FRIDAY_AGENT_ROUTE_DEFAULT_MODEL = "default";
const FRIDAY_HUB_SKILL_COMPAT_VERSION = "1.0.0";

const FRIDAY_CHANNEL_MAX_MESSAGE_LENGTH = 4000;
const FRIDAY_CHANNEL_CONTEXT_HISTORY_LIMIT = Number(process.env.FRIDAY_SESSION_HISTORY_LIMIT) || 24;
const FRIDAY_WORKFLOW_WEBHOOK_SECRET_SCOPES = ["workflow-webhook", "workflow"] as const;
const FRIDAY_CANONICAL_GATE_TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const FRIDAY_CANONICAL_GATE_FALSE_VALUES = new Set(["0", "false", "no", "off", "disabled"]);

function createDiscoveryScannerForPlatform(platform: NodeJS.Platform) {
  switch (platform) {
    case "darwin":
      return createDarwinProgramScanner();
    case "linux":
      return createLinuxProgramScanner();
    case "win32":
      return createWin32ProgramScanner();
    default:
      return undefined;
  }
}

// ─── Auto-detect providers from environment variables ───

const ENV_PROVIDER_MAP: ReadonlyArray<{
  envVar: string;
  kind: FridayProviderKind;
  defaultModel: string;
  supportedModels?: string[];
}> = [
  { envVar: "FRIDAY_ANTHROPIC_API_KEY", kind: "anthropic", defaultModel: "claude-sonnet-4-6" },
  { envVar: "ANTHROPIC_API_KEY", kind: "anthropic", defaultModel: "claude-sonnet-4-6" },
  { envVar: "OPENAI_API_KEY", kind: "openai", defaultModel: "gpt-4o-mini", supportedModels: ["gpt-4o-mini", "gpt-4o"] },
  { envVar: "DEEPSEEK_API_KEY", kind: "deepseek", defaultModel: "deepseek-v4-pro", supportedModels: ["deepseek-v4-pro", "deepseek-v4-flash"] },
  { envVar: "FRIDAY_DEEPSEEK_API_KEY", kind: "deepseek", defaultModel: "deepseek-v4-pro", supportedModels: ["deepseek-v4-pro", "deepseek-v4-flash"] },
  { envVar: "GOOGLE_API_KEY", kind: "google", defaultModel: "gemini-2.0-flash" },
  { envVar: "OPENROUTER_API_KEY", kind: "openrouter", defaultModel: "anthropic/claude-sonnet-4" },
  { envVar: "GROQ_API_KEY", kind: "groq", defaultModel: "llama-3.3-70b-versatile" },
  { envVar: "MISTRAL_API_KEY", kind: "mistral", defaultModel: "mistral-large-latest" },
  { envVar: "XAI_API_KEY", kind: "xai", defaultModel: "grok-3-mini" },
];

const STABLE_OPENAI_DEFAULT_MODEL = "gpt-4o-mini";
const STABLE_OPENAI_SUPPORTED_MODELS = [STABLE_OPENAI_DEFAULT_MODEL, "gpt-4o"] as const;
const OPENAI_PROVIDER_NAME = "OpenAI Provider";
const MISNAMED_OPENAI_PROVIDER_PATTERN = /(?:moonshot|kimi|月之暗面)/i;

function isLegacyAutoDetectedOpenAiProvider(provider: FridayProviderProfile): boolean {
  if (provider.kind !== "openai") {
    return false;
  }
  if (provider.name !== "openai (auto-detected)") {
    return false;
  }
  if (provider.config.keySource.kind !== "env-ref" || provider.config.keySource.envVar !== "OPENAI_API_KEY") {
    return false;
  }

  const supportedModels = normalizeFridayProviderSupportedModels(provider.config.supportedModels);
  return provider.defaultModel === "gpt-4o" && supportedModels.length === 1 && supportedModels[0] === "gpt-4o";
}

async function repairLegacyAutoDetectedOpenAiProviders(
  providerService: FridayProviderService,
): Promise<string[]> {
  const [providers, routing] = await Promise.all([
    providerService.listProviders(),
    providerService.getRoutingConfig(),
  ]);
  const legacyProviders = providers.filter(isLegacyAutoDetectedOpenAiProvider);

  if (legacyProviders.length === 0) {
    return [];
  }

  const repairedProviderIds: string[] = [];
  for (const provider of legacyProviders) {
    await providerService.updateProvider(provider.id, {
      supportedModels: [...STABLE_OPENAI_SUPPORTED_MODELS],
      defaultModel: STABLE_OPENAI_DEFAULT_MODEL,
      validateOnSave: false,
    });
    repairedProviderIds.push(provider.id);
  }

  if (
    repairedProviderIds.includes(routing.defaultProviderId) &&
    routing.defaultModel === "gpt-4o"
  ) {
    await providerService.setRoutingConfig({
      ...routing,
      defaultModel: STABLE_OPENAI_DEFAULT_MODEL,
    });
  }

  return repairedProviderIds;
}

async function repairMisnamedOpenAiSetupProviders(
  providerService: FridayProviderService,
): Promise<string[]> {
  const providers = await providerService.listProviders();
  const misnamedProviders = providers.filter((provider) =>
    provider.kind === "openai" &&
    MISNAMED_OPENAI_PROVIDER_PATTERN.test(provider.name) &&
    /api\.openai\.com/i.test(provider.baseUrl),
  );

  if (misnamedProviders.length === 0) {
    return [];
  }

  const repairedProviderIds: string[] = [];
  for (const provider of misnamedProviders) {
    await providerService.updateProvider(provider.id, {
      name: OPENAI_PROVIDER_NAME,
      validateOnSave: false,
    });
    repairedProviderIds.push(provider.id);
  }

  return repairedProviderIds;
}

async function autoDetectProvidersFromEnv(
  providerService: FridayProviderService,
): Promise<Array<{ kind: FridayProviderKind; id: string }>> {
  const detected: Array<{ kind: FridayProviderKind; id: string }> = [];

  // Check which env vars are set
  const available = ENV_PROVIDER_MAP.filter((entry) => {
    const val = process.env[entry.envVar];
    return typeof val === "string" && val.length > 0;
  });
  if (available.length === 0) return detected;

  // Get existing providers to avoid duplicates
  const existing = await providerService.listProviders();
  const existingKinds = new Set(existing.map((p) => p.kind));

  for (const entry of available) {
    if (existingKinds.has(entry.kind)) continue;

    const preset = getFridayProviderPreset(entry.kind);
    try {
      const profile = await providerService.createProvider({
        kind: entry.kind,
        name: `${entry.kind} (auto-detected)`,
        baseUrl: preset.baseUrl,
        api: preset.api,
        authMode: preset.authMode,
        apiKey: `$${entry.envVar}`,
        supportedModels: entry.supportedModels ?? [entry.defaultModel],
        defaultModel: entry.defaultModel,
        validateOnSave: false,
        preserveEnvRef: true,
      });
      detected.push({ kind: entry.kind, id: profile.id });
      existingKinds.add(entry.kind);
    } catch (err) {
      console.warn(
        `[friday] Auto-detect: failed to register ${entry.kind} from $${entry.envVar}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Auto-detect Ollama from OLLAMA_BASE_URL (no API key needed)
  const ollamaUrl = process.env.OLLAMA_BASE_URL;
  if (ollamaUrl && !existingKinds.has("ollama") && !detected.some((d) => d.kind === "ollama")) {
    const preset = getFridayProviderPreset("ollama", ollamaUrl);
    try {
      const profile = await providerService.createProvider({
        kind: "ollama",
        name: "ollama (auto-detected)",
        baseUrl: preset.baseUrl,
        api: preset.api,
        authMode: preset.authMode,
        apiKey: "",
        supportedModels: ["llama3.2", "qwen2.5", "gemma2"],
        defaultModel: "llama3.2",
        validateOnSave: false,
      });
      detected.push({ kind: "ollama", id: profile.id });
    } catch (err) {
      console.warn(
        "[friday] Auto-detect: failed to register ollama from $OLLAMA_BASE_URL:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Set default routing if none configured — use newly detected or existing providers
  const routing = await providerService.getRoutingConfig();
  if (!routing.defaultProviderId) {
    // Collect candidates from both newly detected and already-persisted enabled
    // providers. Mixed state (e.g. existing OpenAI plus newly detected DeepSeek)
    // still means multiple provider kinds are available and must require an
    // explicit user choice; do not silently pick the newly detected provider.
    const candidates = [
      ...detected,
      ...existing
        .filter((p) => p.enabled)
        .map((p) => ({ kind: p.kind as FridayProviderKind, id: p.id })),
    ];

    const distinctKinds = new Set(candidates.map((c) => c.kind));

    const setDefaultRoute = async (chosen: { kind: FridayProviderKind; id: string }): Promise<void> => {
      const chosenEntry = ENV_PROVIDER_MAP.find((e) => e.kind === chosen.kind);
      const defaultModel = chosenEntry?.defaultModel ?? (chosen.kind === "ollama" ? "llama3.2" : "default");
      try {
        await providerService.setRoutingConfig({
          defaultProviderId: chosen.id,
          defaultModel,
          fallbackProviderIds: [],
        });
      } catch (err) {
        console.warn(
          "[friday] Auto-detect: failed to set default routing:",
          err instanceof Error ? err.message : String(err),
        );
      }
    };

    // 1) Honor an explicit provider choice recorded by setup (e.g. the CLI
    // wizard writes FRIDAY_SETUP_DEFAULT_PROVIDER). This is a user choice, so
    // route to it even when multiple provider keys are present — it is not a
    // hidden auto-pick.
    const intendedKind = (process.env.FRIDAY_SETUP_DEFAULT_PROVIDER ?? "").trim().toLowerCase();
    const intendedCandidate = intendedKind
      ? candidates.find((c) => c.kind === intendedKind)
      : undefined;

    if (intendedCandidate) {
      await setDefaultRoute(intendedCandidate);
    } else if (candidates.length > 0 && distinctKinds.size <= 1) {
      // Exactly one provider kind is available and the user has not chosen a
      // route. Auto-selecting the sole available provider does not usurp a user
      // choice, so default to it with NO auto-added fallback providers.
      await setDefaultRoute(candidates[0]!);
    } else if (distinctKinds.size > 1) {
      // Multiple provider kinds are available but the user has not chosen a
      // route. Locked provider policy: never auto-pick a provider (no hidden
      // OpenAI / DeepSeek default) and never auto-add fallback providers behind
      // the user's back. Leave routing unset so the request-time
      // PROVIDER_NO_ROUTING path surfaces an explicit-choice (action-required)
      // prompt and the user makes the call.
      console.warn(
        `[friday] Auto-detect: ${String(distinctKinds.size)} provider kinds detected `
          + `(${[...distinctKinds].sort().join(", ")}) but no default route is configured. `
          + "Not auto-selecting a provider — explicit user choice required.",
      );
    }
  }

  return detected;
}

function fridayMessagesContainImageContent(messages: readonly FridayAgentMessage[]): boolean {
  return messages.some((message) =>
    Array.isArray(message.content)
    && message.content.some((block) => block.type === "image"),
  );
}

function fridayMessagesContainOcrIntent(messages: readonly FridayAgentMessage[]): boolean {
  const text = messages
    .map((message) => {
      if (typeof message.content === "string") {
        return message.content;
      }
      return message.content
        .map((block) => {
          if (block.type === "text") {
            return block.text;
          }
          if (block.type === "tool_result") {
            return block.content;
          }
          return "";
        })
        .join(" ");
    })
    .join(" ")
    .toLowerCase();
  return /\b(ocr|read\s+text|extract\s+text|text\s+from\s+(?:image|screenshot|photo|scan)|scan(?:ned)?\s+document)\b/.test(text)
    || /(识别文字|提取文字|图片文字|截图文字|扫描件文字|读图中文字)/u.test(text);
}

// ─── Resolved Hub Config ───

export function resolveFridayHubConfig(
  input: FridayHubConfig,
  env: NodeJS.ProcessEnv = process.env,
): FridayResolvedHubConfig {
  const port =
    normalizeFridayHubPort(input.port) ??
    parseFridayHubPort(env.FRIDAY_PORT) ??
    3141;

  const stateDir = input.stateDir ?? env.FRIDAY_STATE_DIR ?? undefined;
  const workspaceRoot = input.workspaceRoot ?? env.FRIDAY_WORKSPACE_ROOT ?? undefined;

  let skillDirs: string[];
  if (input.skillDirs.length > 0) {
    skillDirs = input.skillDirs;
  } else if (env.FRIDAY_SKILLS_DIR) {
    skillDirs = env.FRIDAY_SKILLS_DIR.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    skillDirs = ["skills", "managed-skills"];
  }

  const tokenSecretResult = resolveTokenSecret(input.tokenSecret, env);
  const tokenSecret = tokenSecretResult.secret;

  const serverVersion = input.serverVersion ?? FRIDAY_HUB_DEFAULT_SERVER_VERSION;

  let corsOrigins: string[];
  if (input.corsOrigins !== undefined) {
    corsOrigins = input.corsOrigins;
  } else if (env.FRIDAY_CORS_ORIGINS) {
    corsOrigins = env.FRIDAY_CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    corsOrigins = [];
  }

  let logRequests: boolean;
  if (input.logRequests !== undefined) {
    logRequests = input.logRequests;
  } else if (env.FRIDAY_LOG_REQUESTS !== undefined) {
    logRequests = env.FRIDAY_LOG_REQUESTS !== "false";
  } else {
    logRequests = true;
  }

  const allowTestOnlyPluginExecution = resolveTestOnlyFlagFromEnv(
    input.allowTestOnlyPluginExecution,
    env.FRIDAY_ALLOW_TEST_ONLY_PLUGIN_EXECUTION,
  );
  const allowTestOnlyAutonomyLifecycleExecution = resolveTestOnlyFlagFromEnv(
    input.allowTestOnlyAutonomyLifecycleExecution,
    env.FRIDAY_ALLOW_TEST_ONLY_AUTONOMY_LIFECYCLE_EXECUTION,
  );
  const pluginRuntimeModeRaw = input.pluginRuntimeMode ?? env.FRIDAY_PLUGIN_RUNTIME_MODE ?? "stub";
  const pluginRuntimeMode = pluginRuntimeModeRaw === "full"
    && (allowTestOnlyPluginExecution === true || allowTestOnlyAutonomyLifecycleExecution === true)
    ? "full"
    : "stub";
  const pipelineRuntimeConfig = resolveFridayPipelineRuntimeConfig(env);
  const canonicalMutatingActionGate = resolveFridayCanonicalMutatingActionGate(env);

  // Private-network access must be explicitly enabled. Local/self-hosted
  // deployments that need loopback providers such as Ollama should opt in via
  // FRIDAY_ALLOW_PRIVATE_NETWORK=true or input.ssrfPolicy.allowPrivateNetwork.
  let allowPrivateNetwork: boolean;
  const envAllowPrivate = (env.FRIDAY_ALLOW_PRIVATE_NETWORK ?? "").trim().toLowerCase();
  if (envAllowPrivate) {
    allowPrivateNetwork = ["1", "true", "yes", "on"].includes(envAllowPrivate);
  } else if (input.ssrfPolicy?.allowPrivateNetwork !== undefined) {
    allowPrivateNetwork = input.ssrfPolicy.allowPrivateNetwork;
  } else {
    allowPrivateNetwork = false;
  }

  return {
    stateDir,
    workspaceRoot,
    skillDirs,
    port,
    tokenSecret,
    tokenSecretSource: tokenSecretResult.source,
    serverVersion,
    corsOrigins,
    logRequests,
    allowTestOnlyAutonomyLifecycleExecution,
    allowTestOnlyPluginExecution,
    pluginRuntimeMode,
    pipelineEnabled: pipelineRuntimeConfig.enabled,
    pipelineMode: pipelineRuntimeConfig.mode,
    canonicalMutatingActionGate,
    ssrfPolicy: { allowPrivateNetwork },
  };
}

function isFridayCanonicalGateProtectedProfile(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV?.trim().toLowerCase() === "production"
    || Boolean(env.FRIDAY_RELEASE_TAG?.trim());
}

function resolveTestOnlyFlagFromEnv(
  configValue: boolean | undefined,
  envValue: string | undefined,
): boolean | undefined {
  if (typeof configValue === "boolean") {
    return configValue;
  }
  const raw = (envValue ?? "").trim().toLowerCase();
  if (raw === "") {
    return undefined;
  }
  return raw === "1" || raw === "true";
}

export function resolveFridayCanonicalMutatingActionGate(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const explicit = env.FRIDAY_CANONICAL_GATE?.trim().toLowerCase();
  const protectedProfile = isFridayCanonicalGateProtectedProfile(env);
  if (explicit) {
    if (FRIDAY_CANONICAL_GATE_TRUE_VALUES.has(explicit)) {
      return true;
    }
    if (FRIDAY_CANONICAL_GATE_FALSE_VALUES.has(explicit)) {
      if (protectedProfile) {
        throw new Error(
          "[friday] FRIDAY_CANONICAL_GATE cannot be disabled in production/release profiles. " +
            "Use a development or test profile for mock lanes.",
        );
      }
      return false;
    }
    throw new Error(
      `[friday] Invalid FRIDAY_CANONICAL_GATE value "${env.FRIDAY_CANONICAL_GATE}". ` +
        "Use true or false.",
    );
  }
  return protectedProfile;
}

/**
 * execrun-replacement slice 4 (DARK): single source of truth resolving the per-run
 * `routeAgentRunViaRust` flag from (1) an EXPLICIT {@link FridayHubConfig.routeAgentRunViaRust}
 * and, only as a fallback, (2) the `FRIDAY_ROUTE_AGENT_RUN_VIA_RUST` env var — the operator
 * knob that lets the Rust read-only execrun route be flipped WITHOUT a source edit.
 *
 * PRECEDENCE: an explicit config boolean (true OR false) ALWAYS wins; the env is consulted
 * ONLY when config does not specify (the previously-unsettable gap). This preserves the
 * prior `config.routeAgentRunViaRust` precedence exactly.
 *
 * PARSE (fail-safe OFF): case-insensitive, trimmed `"1"` or `"true"` ⇒ true; ABSENT, `""`,
 * `"0"`, `"false"`, or ANY other value ⇒ false. DEFAULT (env unset, config unset) ⇒ false,
 * so the downstream `deps.routeAgentRunViaRust === true` gate stays off → byte-identical to
 * today's fail-closed 503. Intentionally NARROWER than the canonical-gate true-set
 * (no yes/on/enabled) so any ambiguity resolves OFF.
 *
 * The sibling `FRIDAY_HUB_AGENT_RUN_*` knobs (WS host/port, DB path) are read and documented
 * at the deps/runtime construction point in `friday-api-runtime.ts`; this flag's resolve +
 * precedence live here, at the bootstrap point where the value flows into the runtime deps.
 */
export function resolveRouteAgentRunViaRust(
  configValue: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Config explicit (true OR false) wins — env is the fallback for the unset gap only.
  if (typeof configValue === "boolean") {
    return configValue;
  }
  const raw = (env.FRIDAY_ROUTE_AGENT_RUN_VIA_RUST ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * (CORE-RUNNABLE-001 / CORE-A CR-3) Single source of truth resolving the `routeSessionsViaRust`
 * flag from (1) an EXPLICIT {@link FridayHubConfig.routeSessionsViaRust} and, only as a fallback,
 * (2) the `FRIDAY_ROUTE_SESSIONS_VIA_RUST` env var — the operator knob that lets the Rust session
 * run route be flipped WITHOUT a source edit.
 *
 * PRECEDENCE + PARSE MIRROR {@link resolveRouteAgentRunViaRust} EXACTLY: an explicit config boolean
 * (true OR false) ALWAYS wins; the env is consulted ONLY when config does not specify. Case-
 * insensitive, trimmed `"1"` or `"true"` ⇒ true; ABSENT / `""` / `"0"` / `"false"` / ANY other
 * value ⇒ false. DEFAULT (both unset) ⇒ false, so the runtime threads NO `rustSessionLifecycleBridge`
 * and the session routes stay byte-identical to today's fail-closed 503. Intentionally NARROWER than
 * the canonical-gate true-set so any ambiguity resolves OFF.
 */
export function resolveRouteSessionsViaRust(
  configValue: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Config explicit (true OR false) wins — env is the fallback for the unset gap only.
  if (typeof configValue === "boolean") {
    return configValue;
  }
  const raw = (env.FRIDAY_ROUTE_SESSIONS_VIA_RUST ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * GATE-AGENT-REPLACE A3 courier (DARK): single source of truth resolving the
 * `agentRunControlViaRust` flag from (1) an EXPLICIT {@link FridayHubConfig.agentRunControlViaRust}
 * and, only as a fallback, (2) the `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST` env var — the operator knob
 * that arms the pause/resume PRODUCT TRANSPORT (the sealed WS courier's `AgentRunPaused` inbound +
 * `resumeWithApproval` relay) WITHOUT a source edit.
 *
 * It deliberately reuses the SAME env var name as the Phase-2 Rust server's default-off flag so the
 * TS courier and the Rust server are armed by ONE operator knob — but it is consulted ONLY for the
 * TS courier's client-side behavior; it grants NO mutating run (the read-only qualifier stays hard;
 * relaxing it is a SEPARATE later PR).
 *
 * PRECEDENCE + PARSE mirror {@link resolveRouteAgentRunViaRust} EXACTLY: an explicit config boolean
 * (true OR false) ALWAYS wins; the env is consulted ONLY when config does not specify. Case-
 * insensitive, trimmed `"1"` or `"true"` ⇒ true; ABSENT / `""` / `"0"` / `"false"` / ANY other
 * value ⇒ false. DEFAULT (both unset) ⇒ false, so the courier's paused/resume behavior stays inert
 * and the compose path is byte-identical to today.
 */
export function resolveAgentRunControlViaRust(
  configValue: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Config explicit (true OR false) wins — env is the fallback for the unset gap only.
  if (typeof configValue === "boolean") {
    return configValue;
  }
  const raw = (env.FRIDAY_AGENT_RUN_CONTROL_VIA_RUST ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * D20 W2 signed-batch worktree product entrypoint (DARK): single source of truth resolving the
 * TS route flag from explicit config, else `FRIDAY_D20_SIGNED_BATCH_WORKTREE_VIA_RUST`.
 * The route is still verify-only: Hub receives an operator-signed artifact and an exact action
 * JSON, while Rust owns Ed25519 verification, replay consumption, worktree scope, and audit.
 */
export function resolveD20SignedBatchWorktreeViaRust(
  configValue: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof configValue === "boolean") {
    return configValue;
  }
  const raw = (env.FRIDAY_D20_SIGNED_BATCH_WORKTREE_VIA_RUST ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * B3 system-intent Rust product courier (DARK): single source of truth resolving
 * the TS system-intent route cutover from explicit config, else
 * `FRIDAY_SYSTEM_INTENT_RUST_ENTRYPOINT`. The Rust side remains refs-only and
 * dry-run/unavailable: no host OS action is completed or actuated.
 */
export function resolveSystemIntentViaRust(
  configValue: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof configValue === "boolean") {
    return configValue;
  }
  const raw = (env.FRIDAY_SYSTEM_INTENT_RUST_ENTRYPOINT ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * providers-bridge cut-over (DARK): single source of truth resolving the
 * `routeProvidersViaRust` flag from (1) an EXPLICIT
 * {@link FridayHubConfig.routeProvidersViaRust} and, only as a fallback, (2) the
 * `FRIDAY_ROUTE_PROVIDERS_VIA_RUST` env var — the operator knob that flips the retired
 * Tier-2 PROVIDER surfaces (`providers.detect` / `providers.doctor` /
 * `providers.validate` / `capabilities.doctor`) from fail-closed (503) to bridging the
 * merged Rust `hub_providers_detect` / `hub_capability_doctor` bins, WITHOUT a source
 * edit.
 *
 * PRECEDENCE + PARSE mirror {@link resolveRouteAgentRunViaRust} exactly: an explicit
 * config boolean (true OR false) ALWAYS wins; the env is consulted only for the unset
 * gap. Case-insensitive, trimmed `"1"` or `"true"` ⇒ true; ABSENT / `""` / `"0"` /
 * `"false"` / ANY other value ⇒ false. DEFAULT (env unset, config unset) ⇒ false, so
 * the routes stay byte-identical to today's fail-closed 503.
 */
export function resolveRouteProvidersViaRust(
  configValue: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof configValue === "boolean") {
    return configValue;
  }
  const raw = (env.FRIDAY_ROUTE_PROVIDERS_VIA_RUST ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * Tier-2 WORKFLOW catalog-mutation route bridge (DARK): single source of truth resolving the
 * `routeWorkflowsViaRust` flag from (1) an EXPLICIT {@link FridayHubConfig.routeWorkflowsViaRust}
 * and, only as a fallback, (2) the `FRIDAY_ROUTE_WORKFLOWS_VIA_RUST` env var — the operator knob
 * that flips the Rust-owned workflow catalog-mutation route (`create/update/archive/publish/
 * deploy` → the `hub_workflow_catalog` bin, #657) WITHOUT a source edit.
 *
 * MIRRORS {@link resolveRouteAgentRunViaRust} exactly: an explicit config boolean (true OR false)
 * ALWAYS wins; the env is consulted ONLY when config does not specify. PARSE (fail-safe OFF):
 * case-insensitive, trimmed `"1"` or `"true"` ⇒ true; ABSENT, `""`, `"0"`, `"false"`, or ANY
 * other value ⇒ false. DEFAULT (both unset) ⇒ false, so the downstream
 * `deps.routeWorkflowsViaRust === true` gate stays off and the catalog-mutation routes stay
 * byte-identical to today's fail-closed `TS_RUNTIME_WORKFLOW_CATALOG_MUTATION_RETIRED` 503.
 *
 * The sibling `FRIDAY_HUB_WORKFLOW_CATALOG_*` knobs (bin path, DEV DB path, timeout) are read +
 * documented at the bridge construction point in `friday-rust-hub-workflow-catalog-bridge-service.ts`.
 */
export function resolveRouteWorkflowsViaRust(
  configValue: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Config explicit (true OR false) wins — env is the fallback for the unset gap only.
  if (typeof configValue === "boolean") {
    return configValue;
  }
  const raw = (env.FRIDAY_ROUTE_WORKFLOWS_VIA_RUST ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * Tier-2 WORKFLOW-RUN route bridge (DARK): single source of truth resolving the
 * `routeWorkflowRunsViaRust` flag from explicit config or
 * `FRIDAY_ROUTE_WORKFLOW_RUNS_VIA_RUST`. DEFAULT-FALSE so run start/read keep
 * today's fail-closed TS-retirement behavior unless the operator opts in.
 */
export function resolveRouteWorkflowRunsViaRust(
  configValue: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof configValue === "boolean") {
    return configValue;
  }
  const raw = (env.FRIDAY_ROUTE_WORKFLOW_RUNS_VIA_RUST ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * (Lane B-2) ORGANIC mission-spine POST routes bridge (DARK): single source of truth resolving the
 * `routeMissionSpineViaRust` flag from (1) an EXPLICIT {@link FridayHubConfig.routeMissionSpineViaRust}
 * and, only as a fallback, (2) the `FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST` env var — the operator knob
 * that flips the three organic POST routes (`/v1/mission-spine/intake|lifecycle|work-item-status`)
 * from PERMANENTLY fail-closed (503 `MISSION_SPINE_DISPATCH_UNAVAILABLE`, because `missionSpine.dispatch`
 * is never injected) to LIVE — by wiring a real dispatch adapter over the sealed-WS client.
 *
 * PRECEDENCE + PARSE mirror {@link resolveRouteAgentRunViaRust} exactly: an explicit config boolean
 * (true OR false) ALWAYS wins; the env is consulted ONLY when config does not specify. Case-insensitive,
 * trimmed `"1"` or `"true"` ⇒ true; ABSENT / `""` / `"0"` / `"false"` / ANY other value ⇒ false.
 * DEFAULT (both unset) ⇒ false, so `missionSpine.dispatch` stays unset (null) and the POST routes are
 * byte-identical to today's fail-closed 503.
 *
 * NOTE: the env var name deliberately deviates from the `FRIDAY_ROUTE_*_VIA_RUST` sibling convention
 * (it is `FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST`) to read clearly as "the mission-spine ROUTES knob".
 * End-to-end Loop1 closure ALSO needs the SERVER flags (`FRIDAY_MISSION_INTAKE` for intake,
 * `FRIDAY_MISSION_SPINE_DISPATCH` for lifecycle/work-item) + a deploy + a real mission (operator-gated);
 * this client-side knob only makes the TS routes CALLABLE.
 */
export function resolveRouteMissionSpineViaRust(
  configValue: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Config explicit (true OR false) wins — env is the fallback for the unset gap only.
  if (typeof configValue === "boolean") {
    return configValue;
  }
  const raw = (env.FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * (Lane M) ORGANIC memory-confirmation POST route bridge (DARK): single source of truth resolving the
 * `routeMemorySpineViaRust` flag from (1) an EXPLICIT {@link FridayHubConfig.routeMemorySpineViaRust}
 * and, only as a fallback, (2) the `FRIDAY_MEMORY_SPINE_ROUTES_VIA_RUST` env var — the operator knob
 * that flips the organic POST route (`/v1/memory-spine/decide`) from PERMANENTLY fail-closed (503
 * `MEMORY_SPINE_DISPATCH_UNAVAILABLE`, because `memorySpine.dispatch` is never injected) to LIVE — by
 * wiring a real dispatch adapter over the sealed-WS client.
 *
 * PRECEDENCE + PARSE mirror {@link resolveRouteMissionSpineViaRust} exactly: an explicit config boolean
 * (true OR false) ALWAYS wins; the env is consulted ONLY when config does not specify. Case-insensitive,
 * trimmed `"1"` or `"true"` ⇒ true; ABSENT / `""` / `"0"` / `"false"` / ANY other value ⇒ false.
 * DEFAULT (both unset) ⇒ false, so `memorySpine.dispatch` stays unset (null) and the POST route is
 * byte-identical to today's fail-closed 503.
 *
 * NOTE: the env var name deliberately mirrors the mission-spine `FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST`
 * sibling (it is `FRIDAY_MEMORY_SPINE_ROUTES_VIA_RUST`) to read clearly as "the memory-spine ROUTES
 * knob". End-to-end memory-confirmation closure ALSO needs the SERVER flags (`FRIDAY_MEMORY_CONFIRM`,
 * `FRIDAY_RUN_LOOP_MEMORY_EXTRACTION`) + a deploy (operator-gated); this client-side knob only makes
 * the TS route CALLABLE.
 */
export function resolveRouteMemorySpineViaRust(
  configValue: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Config explicit (true OR false) wins — env is the fallback for the unset gap only.
  if (typeof configValue === "boolean") {
    return configValue;
  }
  const raw = (env.FRIDAY_MEMORY_SPINE_ROUTES_VIA_RUST ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export function resolveRouteRunOutcomeLearningViaRust(
  configValue: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof configValue === "boolean") {
    return configValue;
  }
  const raw = (env.FRIDAY_RUN_OUTCOME_LEARNING_ROUTES_VIA_RUST ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * (Organic mission→run binding PRODUCER — DARK): single source of truth resolving the
 * `missionAutoDispatch` flag from (1) an EXPLICIT {@link FridayHubConfig.missionAutoDispatch} and,
 * only as a fallback, (2) the `FRIDAY_MISSION_AUTO_DISPATCH` env var — the operator knob that lets a
 * fresh-Ready `/v1/mission-spine/intake` immediately fire a READ-ONLY bound agent-run carrying the
 * server-produced mission handle (closing the #1 organic-driver gap: nothing originates a
 * `mission_context` handle on a live run today).
 *
 * PRECEDENCE + PARSE mirror {@link resolveRouteMissionSpineViaRust} exactly: an explicit config
 * boolean (true OR false) ALWAYS wins; the env is consulted ONLY when config does not specify.
 * Case-insensitive, trimmed `"1"` or `"true"` ⇒ true; ABSENT / `""` / `"0"` / `"false"` / ANY other
 * value ⇒ false. DEFAULT (both unset) ⇒ false, so the auto-dispatch driver is NEVER constructed, the
 * dispatch adapter's `autoDispatchDriver` option is omitted, `intakeMission` is byte-identical, and
 * no organic run is produced.
 *
 * NOTE: the driver is wired ONLY when BOTH this AND `resolveRouteMissionSpineViaRust` resolve true
 * (the auto-dispatch road piggybacks the already-callable mission-spine dispatch adapter). End-to-end
 * joined proof ALSO needs the Rust read-only route flag (`FRIDAY_ROUTE_AGENT_RUN_VIA_RUST`), the
 * SERVER `FRIDAY_MISSION_INTAKE`/`FRIDAY_MISSION_SPINE_DISPATCH` flags, a deploy, and the SecureStore
 * + launchd provisioning (operator-gated). This client-side knob only PRODUCES the bound run.
 */
export function resolveMissionAutoDispatch(
  configValue: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Config explicit (true OR false) wins — env is the fallback for the unset gap only.
  if (typeof configValue === "boolean") {
    return configValue;
  }
  const raw = (env.FRIDAY_MISSION_AUTO_DISPATCH ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * Barrier 5 (companion hardening): gate the live system companion bridge for
 * AGENT-REACHABLE consumers behind the SAME test-only flag that fences
 * `friday-system-service.executeIntent` (the `TS_RUNTIME_SYSTEM_INTENT_RETIRED`
 * guard at `friday-system-service.ts`, opened only by
 * `allowTestOnlySystemIntentExecution === true`).
 *
 * The `guide_lens` agent tool and the setup assistant reach the live Swift
 * companion daemon via `companionBridge` WITHOUT passing through that
 * `executeIntent` retirement guard, so on the default/production path they were a
 * bypass: an agent run could drive overlay draws and a `captureSnapshot`
 * screen-read at the daemon even though the executeIntent route is 503.
 *
 * This helper SEVERS that bypass by default: unless the explicit test-only flag is
 * set, agent-reachable consumers receive `undefined` instead of the live bridge.
 * Both consumers already null-check `companionBridge` (`friday-guide-lens-service.ts`
 * `showNativeOverlay`/`clearNativeOverlay`/`captureSnapshot`;
 * `friday-setup-assistant.ts` `setOverlayVisible`), so an absent bridge degrades
 * them to fail-closed no-ops — no daemon call, no overlay, no screen read. NEVER
 * default the flag on in production; the flag is the test-oracle escape hatch only.
 *
 * NOTE: the `systemService` consumer is NOT routed through this helper — it keeps
 * the live bridge (it threads the same flag through `createFridaySystemService`),
 * but is fenced at TWO distinct sinks inside the service, NOT only by
 * `executeIntent`'s guard:
 *   1. `executeIntent`'s method guard fails ALL intent-execution callers closed
 *      (the route is also retired). This covers the WRITE/mutating companion
 *      calls (overlay/launch/focus/openUrl/arrangeWindows) reached via intents.
 *   2. The `captureSnapshot` screen-read sink inside `buildSnapshot` is gated by
 *      the SAME flag. This is REQUIRED because `getState()` is read-classified
 *      and reaches `buildSnapshot` WITHOUT passing through the executeIntent
 *      guard — so executeIntent alone does NOT fence the agent `guide_lens` tool
 *      / skill `system.getSnapshot` node screen-read (a prior comment here
 *      claimed it did; that was false). When the flag is off, getState returns an
 *      empty companion snapshot (apps/windows/notifications) while all other
 *      getState reads (health/permissions/lease/approvals/remote) stay live.
 * Severing the agent-reachable bypasses here mirrors that method-level
 * fail-closed posture for the two consumers (guide_lens overlay, setup assistant)
 * that reach the bridge directly without either service-internal fence.
 */
function resolveAgentReachableCompanionBridge<TBridge>(
  liveBridge: TBridge,
  allowTestOnlySystemIntentExecution: boolean | undefined,
): TBridge | undefined {
  return allowTestOnlySystemIntentExecution === true ? liveBridge : undefined;
}

function normalizeFridayHubPort(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    return undefined;
  }
  return value;
}

function parseFridayHubPort(raw: string | undefined): number | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) return undefined;
  return normalizeFridayHubPort(Number.parseInt(trimmed, 10));
}

async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  const safeLimit = Math.max(0, Math.floor(maxBytes));
  if (safeLimit === 0) {
    await response.body?.cancel();
    return "";
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      const remaining = safeLimit - bytesRead;
      if (remaining <= 0) {
        await reader.cancel();
        break;
      }

      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(decoder.decode(chunk, { stream: true }));
      bytesRead += chunk.byteLength;

      if (bytesRead >= safeLimit) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  chunks.push(decoder.decode());
  return chunks.join("");
}

function resolveImportedSkillSource(uri?: string): SkillSource {
  const trimmed = uri?.trim() ?? "";
  if (/^(git\+)?https?:\/\/[^/]*github\.com\//i.test(trimmed) || /^git@github\.com:/i.test(trimmed) || /\.git(?:[#?]|$)/i.test(trimmed)) {
    return "git";
  }
  return "local";
}

function resolveImportedSkillOrigin(target: FridaySkillInstallTarget): SkillOrigin {
  if (target === "workspace") {
    return "workspace";
  }
  if (target === "managed") {
    return "managed";
  }
  return "extra";
}

const FRIDAY_WORKSPACE_CONTEXT_FAIL_CLOSED_PROFILES = new Set([
  "autonomy",
  "browser",
  "code",
  "general",
  "media",
  "memory",
  "skill",
  "system",
  "workflow",
]);

export function shouldFailClosedForFridayWorkspaceContext(input: {
  promptProfile?: "standard" | "minimal";
  contextPolicy?: { workspaceContext?: "auto" | "skip" };
  toolRouting?: { profile?: string };
}): boolean {
  if (input.promptProfile === "minimal" || input.contextPolicy?.workspaceContext === "skip") {
    return false;
  }
  return FRIDAY_WORKSPACE_CONTEXT_FAIL_CLOSED_PROFILES.has(input.toolRouting?.profile ?? "");
}

// ─── Factory ───

export async function createFridayHub(
  config: FridayHubConfig,
): Promise<FridayHub> {
  let hubState: "starting" | "running" | "stopping" | "stopped" = "stopped";
  let upSince: string | null = null;
  let stateRuntime: FridayStateRuntime | null = null;

  // 1. Initialize state (SQLite + config)
  const stateOpts = config.stateDir
    ? { env: { ...process.env, FRIDAY_STATE_DIR: config.stateDir } as NodeJS.ProcessEnv }
    : undefined;
  stateRuntime = initializeFridayState(stateOpts);

  // P0-001: Wrap remaining bootstrap in try/catch to ensure SQLite cleanup on partial failure
  try {
  const workspaceRoot = config.workspaceRoot ?? process.env.FRIDAY_WORKSPACE_ROOT ?? config.stateDir ?? ".";

  const daemonService = createFridayLocalDaemonService({
    moduleUrl: import.meta.url,
    stateDir: stateRuntime.stateDir,
    version: config.serverVersion ?? FRIDAY_HUB_DEFAULT_SERVER_VERSION,
  });

  // 1b. Seed default admin user if users table is empty
  {
    const userCount = stateRuntime.sqlite.withReadConnection((db) => {
      const row = db.prepare("SELECT COUNT(*) AS cnt FROM users").get() as { cnt: number };
      return row.cnt;
    });
    if (userCount === 0) {
      const nowIso = new Date().toISOString();
      stateRuntime.sqlite.withWriteTransaction((db) => {
        db.prepare(
          `INSERT INTO users (id, email, display_name, role, password_hash, is_local_only, last_login_at, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, NULL, 1, NULL, ?, ?, NULL)`,
        ).run("admin-001", "admin@friday.dev", "Admin", "admin", nowIso, nowIso);
      });
      // Always warn when creating a bootstrap-required admin (password_hash = NULL).
      console.warn(
        "[friday][SECURITY] Created default admin user (admin@friday.dev) with localhost-only local sign-in enabled; do not expose this instance without network or upstream auth controls.",
      );
    }
  }

  // 1c. OC-003: Config hash computation and drift detection
  {
    const rawText = stateRuntime.config.rawText;
    if (rawText) {
      const configHash = crypto.createHash("sha256").update(rawText).digest("hex");
      const storedRow = stateRuntime.sqlite.withReadConnection((db) => {
        return db
          .prepare("SELECT config_hash FROM friday_setup_state WHERE id = 'singleton'")
          .get() as { config_hash: string | null } | undefined;
      });
      const storedHash = storedRow?.config_hash ?? null;

      if (storedHash && storedHash !== configHash) {
        console.warn(
          `[friday] Config drift detected: file hash (${configHash.slice(0, 12)}...) differs from stored hash (${storedHash.slice(0, 12)}...). File config is authoritative; updating stored hash.`,
        );
      }

      stateRuntime.sqlite.withWriteTransaction((db) => {
        db.prepare(
          "UPDATE friday_setup_state SET config_hash = ?, config_revision = config_revision + 1 WHERE id = 'singleton'",
        ).run(configHash);
      });
    }
  }

  // 2. Create hub adapter services for standalone operation.
  //
  // B9 / FRI-AUD-021 truth-label (2026-05-26):
  //   - configManager (now `createPersistentConfigManager`) persists
  //     snapshots/revisions in SQLite via `hub_settings`; `/v1/config/*`
  //     HTTP routes are wired into the API runtime; mutations are NOT
  //     silently dropped.
  //   - memoryState (`createDurableMemoryState`, audit E3): EXPLICIT skill
  //     lifecycle transitions (`updateSkillStatus`: install / disable /
  //     enable / regenerate / not_installed) are now PERSISTED to the `skills`
  //     table, so a self-heal disable survives a hub restart and the execution
  //     safety gate (which reads that table) keeps blocking it. Discovery
  //     (`upsertDiscoveredSkills`) + `listSkillStatuses` stay in-memory ON
  //     PURPOSE — discovery must not write the table or its auto-installed
  //     status would clobber the converter's `not_installed`. Audit-log writes
  //     to disk; the 4 session/memory-item methods remain no-ops and have
  //     ZERO production consumers (carry-forward; see B5_B6_B8_VERIFIED.md
  //     §"FRI-AUD-022").
  // Use env vars and `friday.config.yaml` for first-boot configuration;
  // `/v1/config/*` for live mutations.
  const configManager = createPersistentConfigManager({ ...config, workspaceRoot }, stateRuntime);
  const auditLogPath = resolveFridayAuditLogPath(stateRuntime.stateDir);
  const memoryState = createDurableMemoryState({
    db: stateRuntime.sqlite,
    skillRepository: createFridaySkillRepository(),
    nowIso: () => new Date().toISOString(),
    auditLogPath,
  });

  // 3. Create skill registry
  const registry = new FridaySkillRegistryImpl({
    workspaceDir: workspaceRoot,
    hubVersion: FRIDAY_HUB_SKILL_COMPAT_VERSION,
    supportedApiVersions: ["1"],
    configManager,
    memoryStateService: memoryState,
  });

  // ─── Shared utility functions ───

  const idGenerator = () => crypto.randomUUID();
  const nowIso = () => new Date().toISOString();
  const tokenSecretResult = resolveTokenSecret(config.tokenSecret);
  const tokenSecret = tokenSecretResult.secret;
  const canonicalMutatingActionGateEnabled = resolveFridayCanonicalMutatingActionGate(process.env);

  const pipelineRuntimeConfig = resolveFridayPipelineRuntimeConfig(process.env);
  const capabilityGates = resolveFridayCapabilityGates(process.env);
  const crossChannelIdentityEnabled = process.env.FRIDAY_CROSS_CHANNEL_IDENTITY_ENABLED === "true";
  const crossChannelIdentityMap = parseFridayChannelIdentityMap(process.env.FRIDAY_CHANNEL_IDENTITY_MAP);
  const configuredAllowTestOnlyPluginExecution = resolveTestOnlyFlagFromEnv(
    config.allowTestOnlyPluginExecution,
    process.env.FRIDAY_ALLOW_TEST_ONLY_PLUGIN_EXECUTION,
  );
  const configuredAllowTestOnlyAutonomyLifecycleExecution = resolveTestOnlyFlagFromEnv(
    config.allowTestOnlyAutonomyLifecycleExecution,
    process.env.FRIDAY_ALLOW_TEST_ONLY_AUTONOMY_LIFECYCLE_EXECUTION,
  );
  const configuredPluginRuntimeModeRaw = (
    config.pluginRuntimeMode ??
    process.env.FRIDAY_PLUGIN_RUNTIME_MODE ??
    "stub"
  );
  const configuredPluginRuntimeMode = configuredPluginRuntimeModeRaw === "full"
    && (
      configuredAllowTestOnlyPluginExecution === true
      || configuredAllowTestOnlyAutonomyLifecycleExecution === true
    )
    ? "full"
    : "stub";

  const computeChecksum = (content: string): string => {
    return crypto.createHash("sha256").update(content).digest("hex");
  };

  console.log(
    `[friday] Deterministic pipeline mode: ${
      pipelineRuntimeConfig.enabled ? pipelineRuntimeConfig.mode : "disabled"
    }`,
  );

  // 4. Create run store
  const runStore = createFridaySkillRunStore({ db: stateRuntime.sqlite });

  // 5. Create provider service (BYOK)
  const providerService = createFridayProviderService({
    db: stateRuntime.sqlite,
    idGenerator,
    nowIso,
    allowImplicitProviderStateMutation: !canonicalMutatingActionGateEnabled,
  });

  let browserManager: FridayBrowserManager | undefined;
  const channelRegistry: FridayChannelRegistry = createFridayChannelRegistry();
  const skillRunCanonicalMutationGate = createFridayMutatingActionGate({
    nowIso,
    ticketIdGenerator: () => idGenerator(),
    approvalSignatureSecret: tokenSecret,
    requireApprovalSignature: true,
  });

  // 7. Create executor with providerService injected for ai-inference BYOK path
  const executor = createFridaySkillExecutor({
    db: stateRuntime.sqlite,
    registry,
    runStore,
    idGenerator,
    nowIso,
    providerService,
    getSystemService: () => systemService,
    getSelfHealingService: () => selfHealingApiService,
    getBrowserManager: () => browserManager,
    getChannelRegistry: () => channelRegistry,
    canonicalMutationGate: skillRunCanonicalMutationGate,
    allowTestOnlyNonDarwinShellSandboxExecution: config.allowTestOnlyNonDarwinShellSandboxExecution,
  });

  const rulesRepository = createFridayRulesRepository();
  const rulesEngine = new FridayRuleEngine({
    auditLogSink: (entry) => {
      try {
        stateRuntime!.sqlite.withWriteTransaction((db) => {
          rulesRepository.insertEvaluationLog(db, {
            id: idGenerator(),
            rule_id: entry.matchedRules[0]?.ruleId ?? null,
            policy_bundle_id: entry.matchedRules[0]?.policyBundleId ?? null,
            decision: entry.decision,
            resource: entry.resource,
            action: entry.action,
            context_redacted_json: JSON.stringify(entry.contextRedacted.redacted),
            redaction_applied: entry.contextRedacted.redactionApplied ? 1 : 0,
            redacted_fields_json: JSON.stringify(entry.contextRedacted.redactedFields),
            matched_rules_json: JSON.stringify(entry.matchedRules),
            duration_ms: entry.durationMs,
            run_id: entry.runId ?? null,
            workflow_id: entry.workflowId ?? null,
            principal_id: entry.principalId ?? null,
            created_at: entry.evaluatedAt,
          });
        });
      } catch (err) {
      warnHubBootstrapOperationFailureOnce(err);
        // Keep runtime fail-open if audit persistence fails.
      }
    },
  });

  try {
    stateRuntime.sqlite.withReadConnection((db) => {
      const bundles = rulesRepository.listPolicyBundles(db, {
        enabledOnly: false,
        limit: 10_000,
        offset: 0,
      });
      for (const bundleRow of bundles) {
        const bundle = mapPolicyBundleRow(bundleRow);
        const rules = rulesRepository
          .listRulesByBundleId(db, bundle.id, { enabledOnly: false })
          .map((ruleRow) => mapRuleRow(ruleRow));
        rulesEngine.loadDomainBundle(bundle, rules);
      }
    });
  } catch (err) {
    // Older installs may not have rules tables; keep hub bootable.
    // Log unexpected errors so genuine database failures are visible.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no such table") || msg.includes("no such column")) {
      console.warn("[friday] Rules tables not found (older install) — rules engine will start empty");
    } else {
      console.error("[friday] Unexpected error loading rules — rules engine will start empty:", msg);
    }
  }

  const evaluateRules = async (
    context: FridayEvaluationContext,
    _signal?: AbortSignal,
  ): Promise<FridayEvaluationResult> => {
    const result = rulesEngine.evaluate(
      {
        ...context,
        scopes: normalizeScopeList(context.scopes),
      },
      { includeTransitionTrace: true },
    );
    if (pipelineRuntimeConfig.enabled && pipelineRuntimeConfig.mode === "enforce") {
      return result;
    }
    if (!result.allowed) {
      return {
        ...result,
        decision: "warn",
        allowed: true,
        message: result.message
          ? `[${pipelineRuntimeConfig.mode}] ${result.message}`
          : `[${pipelineRuntimeConfig.mode}] policy denied but enforcement is relaxed`,
      };
    }
    return result;
  };

  const invokeSkillForWorkflow = async (
    skillId: string,
    runId: string,
    nodeId: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> => {
    const persistedStatus = getPersistedSkillLifecycleStatus(skillId);
    if (persistedStatus && persistedStatus !== "installed") {
      throw new FridayDomainError(
        "SKILL_NOT_AVAILABLE",
        `Skill "${skillId}" is not available until it is installed and promoted.`,
        {
          httpStatus: 409,
          details: {
            skillId,
            status: persistedStatus,
            runId,
            nodeId,
          },
        },
      );
    }
    const policy = await evaluateRules({
      resource: "skill",
      action: "execute",
      args: {
        skillId,
        ...payload,
      },
      source: "workflow",
      principalId: "system",
      runId,
      workflowRunId: runId,
      nodeId,
      sessionId: `workflow-run:${runId}`,
    });
    if (!policy.allowed) {
      throw new FridayDomainError(
        "RULE_POLICY_DENIED",
        policy.message ?? `Skill '${skillId}' blocked by policy`,
        {
          httpStatus: 403,
          details: { skillId, runId, nodeId, decision: policy.decision },
        },
      );
    }

    // ─── TS Runtime Retirement — OF6 method-level fail-closed guard ───
    // `invokeSkillForWorkflow` is a NON-route caller that reaches the shared
    // `executor.execute` arbitrary-code sink (shell/python/node) keyed by an
    // ARBITRARY workflow-supplied skillId. Fail closed unless the test oracle
    // (or a future Rust-owned entrypoint) opts in via the SAME skill-run
    // retirement flag the route + agent tool use (default-undefined → OFF →
    // skill runs fail closed in production). EXEMPT `ai-inference`: that fixed
    // (non-arbitrary) skillId short-circuits to the provider service inside the
    // executor (friday-skill-executor.ts ai-inference shortcut) and returns
    // BEFORE any code sink — it is the live BYOK path for the workflow AI node
    // (workflow-ai-adapter.ts invokes "ai-inference" through this same fn), so
    // guarding it would wrongly retire provider inference for workflows.
    if (
      skillId !== "ai-inference"
      && config.allowTestOnlySkillRunExecution !== true
    ) {
      throw new FridayDomainError(
        "TS_RUNTIME_SKILL_RUNS_RETIRED",
        "Skill run execution is fail-closed while runtime ownership is being moved out of TypeScript.",
        {
          httpStatus: 503,
          details: {
            classification: "fail_closed",
            replacement: "rust_owned_skill_run_entrypoint_required",
          },
        },
      );
    }

    const handle = executor.execute({
      skillId,
      input: payload,
      sessionId: `workflow-run:${runId}`,
      userId: "system",
      channel: "workflow",
    });
    const result = await handle.result;
    if (result.status === "failed") {
      throw new FridayDomainError("HUB_SKILL_INVOCATION_FAILED", result.stderr ?? "Skill execution failed", {
        httpStatus: 502,
        details: { skillId, runId, nodeId },
      });
    }
    return result.output;
  };
  type FridayUserRulesPromptSurface =
    | "skill_generator"
    | "workflow_generator"
    | "workflow_ai_node"
    | "subagent";
  const buildFridayUserRulesPromptContext = async (input: {
    task: string;
    surface: FridayUserRulesPromptSurface;
  }): Promise<string | null> => {
    const ctx = await loadFridayWorkspaceContext(workspaceRoot, { task: input.task });
    if (ctx.summary.loadErrors.length > 0) {
      throw new FridayDomainError(
        "WORKSPACE_CONTEXT_UNAVAILABLE",
        `Friday user/project rules could not be loaded for ${input.surface}: ${ctx.summary.loadErrors.map((err) => err.name).join(", ")}`,
        {
          httpStatus: 503,
          details: {
            surface: input.surface,
            loadErrors: ctx.summary.loadErrors.map((err) => ({
              name: err.name,
              code: err.code,
              message: err.message,
            })),
          },
        },
      );
    }
    const fragment = ctx.promptFragment.trim();
    if (!fragment) {
      return null;
    }
    return [
      `<friday-user-project-rules surface="${input.surface}" enforcement="prompt-guidance-only">`,
      fragment,
      `</friday-user-project-rules>`,
    ].join("\n");
  };

  // 8. Create AI skill generator service
  const skillGenerator = createFridaySkillGeneratorService({
    db: stateRuntime.sqlite,
    providerService,
    registry,
    configManager,
    memoryStateService: memoryState,
    idGenerator,
    nowIso,
    userRulesContextProvider: (input) =>
      buildFridayUserRulesPromptContext({
        task: input.task,
        surface: input.surface,
      }),
    // TS Runtime Retirement — GAP G2 (DEFAULT-OFF): production leaves this unset
    // so the skill-generator session mutators behave exactly as today (the
    // UIX-driven `generate-skill` flow + agent skill-generator tool keep
    // working). Flip true only when the operator decides to Rust-own skill
    // generation (R11) — then the mutators fail closed.
    enforceUixSkillExecRetirement: config.enforceUixSkillExecRetirement,
  });

  // 9. Create converter service
  const converterRegistry = createFridaySkillConverterRegistry();
  for (const factory of FRIDAY_DEFAULT_CONVERTER_FACTORIES) {
    converterRegistry.register(factory());
  }

  const converterInstaller = createFridaySkillImportInstaller();
  const converterArchiver = createFridaySkillPackageArchiver();
  const converterSkillRepo = createFridaySkillRepository();
  const skillVersionRepo = createFridaySkillVersionRepository();
  const skillInstallationRepo = createFridaySkillInstallationRepository();
  const managedSkillsDir = config.skillDirs[1] ?? "managed-skills";
  const skillSignatureVerifier = createFridaySkillSignatureVerifier();
  const skillTrustScoring = createFridaySkillTrustScoringService();
  const skillPackageInstaller = createFridaySkillPackageInstaller({
    managedSkillsDir,
    archiver: converterArchiver,
  });
  const skillVersionResolver = createFridaySkillVersionResolutionService({
    db: stateRuntime.sqlite,
    versionRepo: skillVersionRepo,
    installationRepo: skillInstallationRepo,
  });
  const skillPermissionCheck = createFridaySkillPermissionCheckService();
  const skillInstallationService = createFridaySkillInstallationService({
    db: stateRuntime.sqlite,
    skillRepo: converterSkillRepo,
    installationRepo: skillInstallationRepo,
    versionResolver: skillVersionResolver,
    signatureVerifier: skillSignatureVerifier,
    trustScoring: skillTrustScoring,
    permissionCheck: skillPermissionCheck,
    packageInstaller: skillPackageInstaller,
    idGenerator,
    nowIso,
  });
  const getPersistedSkillLifecycleStatus = (skillId: string): SkillLifecycleStatus | undefined =>
    stateRuntime.sqlite.withReadConnection((db) =>
      converterSkillRepo.getSkillById(db, skillId)?.status,
    );
  const resolveWorkflowSkill = (skillId: string) => {
    const persistedStatus = getPersistedSkillLifecycleStatus(skillId);
    if (persistedStatus && persistedStatus !== "installed") {
      return null;
    }
    const skill = registry.get(skillId);
    if (!skill || skill.status !== "installed") {
      return null;
    }
    return skill;
  };

  const converterService = createFridaySkillConverterService({
    registry: converterRegistry,
    installer: converterInstaller,
    archiver: converterArchiver,
    context: {
      workspaceDir: stateRuntime.stateDir,
      managedSkillsDir,
      nowIso,
    },
    hubVersion: FRIDAY_HUB_SKILL_COMPAT_VERSION,
    supportedApiVersions: ["1"],
    onSkillImported: async ({ draft, source, target }) => {
      const manifest = draft.manifest;
      const persistedAt = nowIso();
      stateRuntime.sqlite.withWriteTransaction((conn) => {
        converterSkillRepo.upsertSkillFromCatalog(conn, {
          id: manifest.id,
          name: manifest.name,
          source: resolveImportedSkillSource(source.uri),
          origin: resolveImportedSkillOrigin(target),
          latestVersion: manifest.version,
          status: "installed",
          currentManifest: manifest,
          nowIso: persistedAt,
        });
        converterSkillRepo.setInstalledVersion(conn, manifest.id, manifest.version, manifest, persistedAt);
      });
    },
    onSkillCandidateStaged: async ({ candidate, draft }) => {
      const manifest = draft.manifest;
      const persistedAt = candidate.stagedAt;
      stateRuntime.sqlite.withWriteTransaction((conn) => {
        converterSkillRepo.upsertSkillFromCatalog(conn, {
          id: manifest.id,
          name: manifest.name,
          source: resolveImportedSkillSource(candidate.sourceProvenance.redactedUri),
          origin: "managed",
          latestVersion: manifest.version,
          status: "not_installed",
          currentManifest: manifest,
          nowIso: persistedAt,
        });
      });
      await memoryState.updateSkillStatus(manifest.id, "not_installed");
    },
    onRegistryRefresh: async () => {
      await registry.refresh();
    },
  });

  // ─── Memory service (optional — only if state is ready) ───

  let memoryService: FridayMemoryService | undefined;
  if (stateRuntime) {
    memoryService = createFridayMemoryService({
      db: stateRuntime.sqlite,
      providerService,
      idGenerator,
      nowIso,
      tsMemoryWritesEnabled: config.allowTestOnlyTsMemoryWrites === true,
    });
  }
  const memoryGuardFactory: FridayMemoryGuardServiceFactory | undefined = stateRuntime && memoryService
    ? createFridayMemoryGuardServiceFactory({
      core: memoryService,
      db: stateRuntime.sqlite,
      nowIso,
      nowMs: () => new Date(nowIso()).getTime(),
      tsMemoryWritesEnabled: config.allowTestOnlyTsMemoryWrites === true,
    })
    : undefined;

  // ─── Workflow runtime ───

  const triggerRepo = createFridayWorkflowTriggerRepository({ db: stateRuntime!.sqlite });
  // P2-03: Bounded event buffers prevent OOM if publisher init is delayed.
  const FRIDAY_EVENT_BUFFER_MAX = 10_000;
  const workflowRealtimeEventBuffer: Array<{ streamId: string; event: string; payload: Record<string, unknown> }> = [];
  // Default learning user for runtime-originated remediation and feedback events.
  const learningDefaultUserId = "admin-001";
  let reflexService: FridayReflexService | undefined;
  let reflexCuratorInterval: ReturnType<typeof setInterval> | undefined;
  let workflowRealtimeEventPublisher:
    | {
      publish(streamId: string, event: string, payload: Record<string, unknown>): void;
    }
    | undefined;
  let selfHealingApiServiceRef: ReturnType<typeof createFridaySelfHealingApiService> | null = null;
  let workflowRuntimeRef: ReturnType<typeof createFridayWorkflowRuntime> | null = null;

  const publishWorkflowRealtimeEvent = async (event: string, payload: unknown): Promise<void> => {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return;
    }

    const record = payload as Record<string, unknown>;
    const runId = typeof record.runId === "string" && record.runId.trim().length > 0
      ? record.runId.trim()
      : undefined;
    const workflowId = typeof record.workflowId === "string" && record.workflowId.trim().length > 0
      ? record.workflowId.trim()
      : undefined;
    const streamId = runId
      ? `run:${runId}`
      : workflowId
        ? `workflow:${workflowId}`
        : null;

    if (!streamId || !event.startsWith("workflow.")) {
      return;
    }

    if (workflowRealtimeEventPublisher) {
      workflowRealtimeEventPublisher.publish(streamId, event, record);
    } else {
      if (workflowRealtimeEventBuffer.length >= FRIDAY_EVENT_BUFFER_MAX) {
        workflowRealtimeEventBuffer.shift();
        warnHubBootstrapOnce("[friday] workflow realtime event buffer overflow — oldest event dropped");
      }
      workflowRealtimeEventBuffer.push({ streamId, event, payload: record });
    }
  };

  const reportWorkflowRunFailureToSelfHealing = async (input: {
    runId: string;
    workflowId: string;
    workflowVersionId: string;
    failedNodes: number;
    sourceEvent: string;
  }): Promise<void> => {
    const workflowRuntime = workflowRuntimeRef;
    const selfHealingApiService = selfHealingApiServiceRef;
    if (!workflowRuntime || !selfHealingApiService) {
      return;
    }

    try {
      const run = workflowRuntime.execution.getRun(input.runId);
      if (!run || run.status !== "failed") {
        return;
      }

      const runNodes = workflowRuntime.execution.getRunNodes(input.runId);
      const failedRunNodes = runNodes.filter((node) => node.status === "failed");
      const latestFailedNode = failedRunNodes
        .slice()
        .sort((left, right) => {
          if (left.updatedAt !== right.updatedAt) {
            return right.updatedAt.localeCompare(left.updatedAt);
          }
          return right.attempt - left.attempt;
        })[0];
      const userId = typeof run.startedByUserId === "string" && run.startedByUserId.trim().length > 0
        ? run.startedByUserId.trim()
        : learningDefaultUserId;

      const existingOpenIncident = selfHealingApiService.listIncidents({
        userId,
        status: "open",
        limit: 100,
      }).find((details) =>
        details.incident.category === "workflow"
          && details.incident.runId === input.runId
          && (details.incident.nodeId ?? null) === (latestFailedNode?.nodeId ?? null));

      if (existingOpenIncident) {
        return;
      }

      selfHealingApiService.reportStructuredFailure({
        userId,
        runId: input.runId,
        nodeId: latestFailedNode?.nodeId,
        category: "workflow",
        severity: "medium",
        message: run.failure?.message ?? `${input.failedNodes} workflow node(s) failed`,
        correlationId: `workflow:${input.sourceEvent}:${input.runId}`,
        context: {
          workflowId: input.workflowId,
          workflowVersionId: input.workflowVersionId,
          failedNodeCount: input.failedNodes,
          source: "workflow_runtime",
          sourceEvent: input.sourceEvent,
          ...(typeof run.failure?.code === "string" ? { failureCode: run.failure.code } : {}),
          ...(typeof run.failure?.message === "string" ? { failureMessage: run.failure.message } : {}),
          ...(latestFailedNode
            ? {
                failedNodeId: latestFailedNode.nodeId,
                failedNodeAttempt: latestFailedNode.attempt,
                failedNodeStatus: latestFailedNode.status,
                ...(typeof latestFailedNode.error?.retryable === "boolean"
                  ? { failedNodeRetryable: latestFailedNode.error.retryable }
                  : {}),
                ...(typeof latestFailedNode.error?.code === "string" ? { failedNodeErrorCode: latestFailedNode.error.code } : {}),
                ...(typeof latestFailedNode.error?.message === "string" ? { failedNodeErrorMessage: latestFailedNode.error.message } : {}),
              }
            : {}),
        },
      });
    } catch (error) {
      warnHubBootstrapOperationFailureOnce(error);
    }
  };

  let crossBorderPackServiceRef: FridayCrossBorderPackService | null = null;
  const workflowWebhookSecretRepository = createFridaySecretRepository();
  const resolveWorkflowWebhookSecretRef = (refKey: string): string | null => {
    try {
      for (const scope of FRIDAY_WORKFLOW_WEBHOOK_SECRET_SCOPES) {
        const entity = stateRuntime!.sqlite.withReadConnection((db) =>
          workflowWebhookSecretRepository.getByRef(db, scope, refKey),
        );
        if (!entity) continue;
        const envelope = JSON.parse(entity.encryptedValue) as FridayEncryptedEnvelope;
        const { plaintext, rewrapped } = decryptSecretWithMigration(
          envelope,
          getStrictMasterKey(),
          fridaySecretAadContext(entity),
        );
        if (rewrapped) {
          // Read-repair (SEC-SECRET-AAD-001): persist v2 re-wrap; best-effort.
          try {
            stateRuntime!.sqlite.withWriteTransaction((db) => {
              workflowWebhookSecretRepository.updateById(db, {
                secretId: entity.id,
                encryptedValue: JSON.stringify(rewrapped),
                keyId: "master-v1",
                nowIso: new Date().toISOString(),
              });
            });
          } catch {
            // Non-fatal: the read already succeeded.
          }
        }
        return plaintext;
      }
      return null;
    } catch (error) {
      warnHubBootstrapOperationFailureOnce(error);
      return null;
    }
  };
  const workflowRuntime = createFridayWorkflowRuntime({
    db: stateRuntime!.sqlite,
    idGenerator,
    nowIso,
    computeChecksum,
    resolveSkill: resolveWorkflowSkill,
    // Audit C Stage 2A: anchor the filesystem-write verifier's scope containment
    // to the same workspace root the skill registry resolves skill dirs against.
    workspaceDir: workspaceRoot,
    invokeSkill: invokeSkillForWorkflow,
    userRulesContextProvider: (input) =>
      buildFridayUserRulesPromptContext({
        task: input.task,
        surface: input.surface,
      }),
    publishEvent: publishWorkflowRealtimeEvent,
    triggerRepo,
    resolveWebhookSecretRef: resolveWorkflowWebhookSecretRef,
    // TS Runtime Retirement (§1 method-level guard): production leaves this unset
    // (config flag undefined) so the workflow execution `startRun` method is
    // fail-closed for the scheduler/cron/webhook/event trigger paths, not just the
    // HTTP route. Test-oracle hub configs set it true to exercise legacy execution.
    allowTestOnlyWorkflowRunExecution: config.allowTestOnlyWorkflowRunExecution,
    onRunIntake: async (input) => {
      const workflow = workflowRuntimeRef?.crud.getWorkflow(input.workflowId) ?? null;
      if (!workflow?.ownerUserId || !crossBorderPackServiceRef) {
        return undefined;
      }
      const contextPatch = crossBorderPackServiceRef.buildWorkflowInputContext({
        userId: workflow.ownerUserId,
        managedWorkflowId: input.workflowId,
      });
      return contextPatch ? { contextPatch } : undefined;
    },
    onRunCompleted: async (input) => {
      if (input.status !== "failed") {
        return;
      }
      await reportWorkflowRunFailureToSelfHealing({
        runId: input.runId,
        workflowId: input.workflowId,
        workflowVersionId: input.workflowVersionId,
        failedNodes: input.failedNodes,
        sourceEvent: "workflow.run.completed",
      });
    },
  });
  const workflowBuilderRuntime = createFridayWorkflowBuilderRuntime({
    db: stateRuntime!.sqlite,
    crudService: workflowRuntime.crud,
    skillRegistry: registry,
    skillRepo: converterSkillRepo,
    idGenerator,
    nowIso,
    computeChecksum,
  });
  workflowRuntimeRef = workflowRuntime;

  // ─── Workflow generator service ───

  let workflowGenerator: FridayWorkflowGeneratorService;

  // ─── Agent runtime ───

  const agentEventEmitter = createFridayAgentEventEmitter();

  // IMPL-1: Review gate (mode from env, default "off")
  const agentReviewMode = (process.env.FRIDAY_AGENT_REVIEW_MODE ?? "off") as FridayAgentReviewMode;
  const agentReviewGate = createFridayAgentReviewGate(agentReviewMode);

  // IMPL-3: Durable run event repository
  const agentRunEventRepository = createFridayAgentRunEventRepository();
  const agentRunRepo = createFridayAgentRunRepository();
  const agentAutomationRepo = createFridayAgentAutomationRepository();

  // IMPL-4: SSRF guard
  const agentSsrfGuard = createFridayAgentSsrfGuard(config.ssrfPolicy);

  // IMPL-7: Artifact writer
  const agentArtifactWriter = createFridayAgentArtifactWriter(workspaceRoot);
  const ttsService = createFridayProviderBackedTtsService({
    providerService,
    artifactDir: path.join(workspaceRoot, ".friday", "artifacts", "tts"),
    defaultModel: process.env.FRIDAY_TTS_MODEL,
    defaultVoice: process.env.FRIDAY_TTS_VOICE,
  });

  // Cost calculator for enriching message_end events
  const pricingCatalog = createFridayProviderPricingCatalog();
  const costCalculator = createFridayProviderCostCalculator({ pricingCatalog });

  // Create a lazy LLM client that resolves provider credentials on each call.
  // This bridges the BYOK provider system to the agent's Anthropic LLM client.
  // IMPL-2: Enriches message_end events with actual route/provider metadata.
  const agentLlmClient: FridayAgentLlmClient = {
    async *stream(params): AsyncIterable<FridayAgentLlmStreamEvent> {
      // Resolve credentials AND make the LLM call inside runWithFallback so
      // that transient LLM errors (429, 503, timeouts) trigger provider
      // cooldown and automatic failover to the next candidate.
      const resolvedModel = params.model === FRIDAY_AGENT_ROUTE_DEFAULT_MODEL
        ? undefined
        : params.model;
      const requiredCapabilities = new Set(params.routingContext?.requiredCapabilities ?? []);
      requiredCapabilities.add("text");
      if (fridayMessagesContainImageContent(params.messages)) {
        requiredCapabilities.add("vision");
        if (fridayMessagesContainOcrIntent(params.messages)) {
          requiredCapabilities.add("ocr");
        }
      }
      const routingContext = requiredCapabilities.size > 0
        ? {
            estimatedInputTokens: params.routingContext?.estimatedInputTokens ?? 0,
            complexity: params.routingContext?.complexity ?? "medium" as const,
            ...params.routingContext,
            requiredCapabilities: [...requiredCapabilities],
          }
        : params.routingContext;
      const { result: events, route, attempts, routingDecision } = await providerService.runWithFallback({
        requestedModel: resolvedModel,
        requestedProviderId: params.providerId,
        tenantContext: params.tenantContext,
        routingContext,
        run: async (_route, credential) => {
          const innerClient = createFridayAgentLlmClient({
            baseUrl: _route.provider.baseUrl,
            apiKey: credential ?? "",
            api: _route.provider.config.api,
            backendKind: _route.provider.config.backendKind,
            cliConfig: _route.provider.config.cliConfig,
            authMode: _route.provider.config.authMode,
            allowPrivateNetwork: config.ssrfPolicy?.allowPrivateNetwork,
          });

          // Collect all stream events so the fallback can detect errors
          // before we yield. This trades streaming-first-token latency for
          // reliable failover — acceptable because agent runs are async.
          const collected: FridayAgentLlmStreamEvent[] = [];
          for await (const event of innerClient.stream({
            ...params,
            model: _route.model,
          })) {
            collected.push(event);
          }
          return collected;
        },
      });

      // Re-yield the collected events, enriching message_end with route metadata + cost
      for (const event of events) {
        if (event.type === "message_end" && route) {
          const cacheRead = event.cacheReadInputTokens ?? 0;
          const cacheWrite = event.cacheCreationInputTokens ?? 0;
          const costUsd = costCalculator.calculate({
            providerKind: route.provider.kind,
            model: route.model,
            usage: {
              input: event.inputTokens,
              output: event.outputTokens,
              cacheRead,
              cacheWrite,
              total: event.inputTokens + event.outputTokens,
            },
          });
          yield {
            ...event,
            actualProviderId: route.provider.id,
            actualModel: route.model,
            actualProviderKind: route.provider.kind,
            actualProviderApi: route.provider.config.api,
            backendKind: route.provider.config.backendKind ?? "http",
            costUsd,
            attempts,
            routingDecisionReason: routingDecision.reason,
            learningAdjusted: routingDecision.learningAdjusted,
            routeDecisionTrace: routingDecision.routeDecisionTrace,
          };
        } else {
          yield event;
        }
      }
    },
  };

  // Build browser + XHS runtime deps
  const browserHostConfig = resolveBrowserHostConfigFromEnv(process.env);
  const browserPresentationMode = resolveBrowserPresentationModeFromEnv(process.env);
  // B4 default-deny migration: the underlying `matchesOrigin` flipped from
  // default-allow to default-deny so the library is safe-by-default. To
  // preserve current deployment behavior while a follow-up slice plumbs
  // `allowedOrigins` through `friday.config.yaml`, the hub bootstrap
  // explicitly opts into allow-any here. The library will emit a startup
  // warning when an explicit allowlist is not configured. Future slice:
  // remove this explicit `[FRIDAY_BROWSER_ALLOW_ANY_ORIGIN]` and source the
  // list from config (Carry-forward Row I in B4 closure).
  browserManager = createFridayBrowserManager({
    workspaceRoot,
    presentationMode: browserPresentationMode,
    hostBrowser: browserHostConfig,
    allowedOrigins: [FRIDAY_BROWSER_ALLOW_ANY_ORIGIN],
  });
  const xhsSessionManager = createXhsSessionManager({
    sqlite: stateRuntime!.sqlite,
    nowIso,
  });
  const xhsPageInteractions = createXhsPageInteractions({
    browserManager,
    sessionManager: xhsSessionManager,
    artifactDir: path.join(workspaceRoot, ".friday", "artifacts", "xhs"),
  });
  const uixUserPreferenceRepository = createFridayUixUserPreferenceRepository();
  const guideLensPreferencePrincipalId = process.env.FRIDAY_GUIDE_LENS_PRINCIPAL_ID?.trim() || "local-guide-lens";
  const guideLensPreferenceKey = "guide_lens.preferences";
  const isGuideLensPreferencePatch = (value: unknown): value is Partial<FridayGuideLensPreferences> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  // Optional desktop runtime (opt-in)
  const desktopEnabled = capabilityGates.desktopEnabled;
  let desktopSessionManager: DesktopSessionManager | undefined;
  if (desktopEnabled) {
    desktopSessionManager = createDesktopSessionManager({
      generateId: idGenerator,
      nowIso,
      principalId: process.env.FRIDAY_DESKTOP_PRINCIPAL_ID ?? "friday-desktop",
      sandboxAllowedRoots: parseDesktopSandboxAllowedRoots(
        process.env.FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS,
        workspaceRoot,
      ),
      // TS Runtime Retirement: method-head fail-closed guard for the desktop OS
      // actuator. This flag defaults unset so executeAction / cancelAction /
      // getActionLog fail closed for ALL off-route callers (agent desktop tool,
      // autonomy engine, skill desktop helper) — the route fence alone left them
      // reachable. Threaded from the same config knob the route deps use, so the
      // method + route fences stay in lockstep.
      allowTestOnlyDesktopActionExecution: config.allowTestOnlyDesktopActionExecution,
      // TS Runtime Retirement (A3 HOLE 1): method-head fail-closed guard for the
      // desktop RECORDING lifecycle + replay. Defaults unset so startRecording /
      // stopRecording / pauseRecording / resumeRecording / deleteRecording /
      // replayRecording fail closed for the off-route caller (agent desktop tool).
      // SEPARATE retired family from the action actuator; threaded from the same
      // recording config knob the route deps use so the method + route fences stay
      // in lockstep.
      allowTestOnlyDesktopRecordingExecution: config.allowTestOnlyDesktopRecordingExecution,
    });

    desktopSessionManager.connect();
    const detectedPlatform = desktopSessionManager.getAdapterManager().getDetectedPlatform();
    if (detectedPlatform) {
      try {
        const adapter = await createPlatformAdapter(detectedPlatform, {
          generateId: idGenerator,
          nowIso,
        });
        desktopSessionManager.registerAdapter(adapter);
        const health = await checkAdapterHealth(adapter, {
          generateId: idGenerator,
          nowIso,
        });
        console.log(
          `[friday] Desktop runtime enabled (${detectedPlatform}) — ${health.statusMessage}`,
        );
      } catch (error) {
        console.error(
          `[friday] Desktop runtime adapter init failed (${detectedPlatform}):`,
          error instanceof Error ? error.message : String(error),
        );
      }
    } else {
      console.warn("[friday] Desktop runtime enabled but no supported platform was detected.");
    }
  }

  const systemEnabled = capabilityGates.systemEnabled;
  let systemService: FridaySystemService | undefined;
  let systemRouteDeps: FridaySystemRoutesDeps | undefined;
  let guideLensService: ReturnType<typeof createFridayGuideLensService> | undefined;
  let guideLensRouteDeps: FridayGuideLensRoutesDeps | undefined;
  let systemCompanionServer:
    | ReturnType<typeof createFridaySystemUnixSocketCompanionServer>
    | undefined;
  let systemCompanionBridge:
    | ReturnType<typeof createFridaySystemLocalCompanionBridge>
    | ReturnType<typeof createFridaySystemUnixSocketBridge>
    | undefined;
  if (systemEnabled) {
    const detectedSystemPlatform = desktopSessionManager?.getAdapterManager().getDetectedPlatform()
      ?? (process.platform === "darwin" || process.platform === "linux" || process.platform === "win32"
        ? process.platform
        : "unknown");
    const systemRemoteMode: FridaySystemRemoteMode =
      process.env.FRIDAY_SYSTEM_REMOTE_MODE === "trusted_private_network"
        ? "trusted_private_network"
        : "disabled";
    const systemCloudPlanningMode = process.env.FRIDAY_SYSTEM_CLOUD_PLANNING === "local_only"
      ? "local_only"
      : process.env.FRIDAY_SYSTEM_CLOUD_PLANNING === "hybrid"
        ? "hybrid"
        : "opt_in";
    const resolvedPort = config.port
      ?? parseFridayHubPort(process.env.FRIDAY_PORT)
      ?? 3141;
    const systemRemoteAuthRpName = process.env.FRIDAY_SYSTEM_REMOTE_AUTH_RP_NAME ?? "Friday Agent OS";
    const systemRemoteAuthOrigin = process.env.FRIDAY_SYSTEM_REMOTE_AUTH_ORIGIN
      ?? `http://localhost:${String(resolvedPort)}`;
    const systemRemoteAuthRpId = process.env.FRIDAY_SYSTEM_REMOTE_AUTH_RP_ID;
    const systemRemoteAuthChallengeTtlMs = process.env.FRIDAY_SYSTEM_REMOTE_AUTH_CHALLENGE_TTL_MS
      ? Number.parseInt(process.env.FRIDAY_SYSTEM_REMOTE_AUTH_CHALLENGE_TTL_MS, 10)
      : undefined;
    const systemRemoteAuthAssertionTtlMs = process.env.FRIDAY_SYSTEM_REMOTE_AUTH_ASSERTION_TTL_MS
      ? Number.parseInt(process.env.FRIDAY_SYSTEM_REMOTE_AUTH_ASSERTION_TTL_MS, 10)
      : undefined;
    const companionId = process.env.FRIDAY_SYSTEM_COMPANION_ID ?? "friday-system-companion";
    const panicHotkey = process.env.FRIDAY_SYSTEM_PANIC_HOTKEY ?? "cmd+shift+escape";
    const socketPath = process.env.FRIDAY_SYSTEM_COMPANION_SOCKET_PATH
      ? path.resolve(process.env.FRIDAY_SYSTEM_COMPANION_SOCKET_PATH)
      : path.join(workspaceRoot, ".friday", "run", "system-companion.sock");
    const pipeName = resolveFridaySystemCompanionPipeName(
      workspaceRoot,
      process.env.FRIDAY_SYSTEM_COMPANION_PIPE_NAME,
    );
    const launchAtLoginEnabled = process.env.FRIDAY_SYSTEM_LAUNCH_AT_LOGIN !== "false";
    const transportMode = process.env.FRIDAY_SYSTEM_COMPANION_TRANSPORT === "in_process"
      ? "in_process"
      : process.env.FRIDAY_SYSTEM_COMPANION_TRANSPORT === "named_pipe"
        ? "named_pipe"
        : process.platform === "win32"
          ? "named_pipe"
          : "unix_socket";
    const nativeCompanionMode = process.env.FRIDAY_SYSTEM_NATIVE_COMPANION_MODE === "node"
      ? "node"
      : process.env.FRIDAY_SYSTEM_NATIVE_COMPANION_MODE === "dotnet"
        ? "dotnet"
        : process.env.FRIDAY_SYSTEM_NATIVE_COMPANION_MODE === "rust"
          ? "rust"
      : process.env.FRIDAY_SYSTEM_NATIVE_COMPANION_MODE === "swift"
        ? "swift"
        : "auto";
    const companionServerMode = resolveFridaySystemCompanionServerMode({
      platform: process.platform,
      transportMode,
      explicitServerMode: process.env.FRIDAY_SYSTEM_COMPANION_SERVER_MODE,
      nativeCompanionMode,
    });
    const configuredExternalCompanionRuntimeKind = process.env.FRIDAY_SYSTEM_COMPANION_RUNTIME_KIND === "swift_app"
      ? "swift_app"
      : process.env.FRIDAY_SYSTEM_COMPANION_RUNTIME_KIND === "dotnet_winui_app"
        ? "dotnet_winui_app"
        : process.env.FRIDAY_SYSTEM_COMPANION_RUNTIME_KIND === "rust_gtk_app"
          ? "rust_gtk_app"
      : nativeCompanionMode === "node"
        ? "node_daemon"
        : nativeCompanionMode === "dotnet"
          ? "dotnet_winui_app"
          : nativeCompanionMode === "rust"
            ? "rust_gtk_app"
        : "swift_binary";
    const configuredCompanionRuntimeKind = transportMode === "in_process"
      ? "embedded"
      : companionServerMode === "embedded"
        ? "embedded"
        : configuredExternalCompanionRuntimeKind;
    const permissionCollector = async () => {
      if (!desktopSessionManager?.isConnected()) {
        return [];
      }
      const permissions = await desktopSessionManager.checkPermissions().catch(() => []);
      return permissions.map((permission) => ({
        id: idGenerator(),
        permission: permission.permissionType,
        status: permission.status,
        grantInstructions: permission.grantInstructions,
      }));
    };

    try {
      const { token: companionAuthToken } = await resolveFridaySystemCompanionAuthToken({
        workspaceRoot,
        explicitToken: process.env.FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN,
        explicitTokenFilePath: process.env.FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN_FILE,
        forceRotate: process.env.FRIDAY_SYSTEM_COMPANION_ROTATE_TOKEN === "true",
      });

      if (transportMode === "unix_socket") {
        if (companionServerMode === "embedded") {
          systemCompanionServer = createFridaySystemUnixSocketCompanionServer({
            id: companionId,
            platform: detectedSystemPlatform,
            nowIso,
            runtimeKind: configuredCompanionRuntimeKind,
            launchAtLoginEnabled,
            panicHotkey,
            socketPath,
            authToken: companionAuthToken,
            menuBarEnabled: true,
            overlayEnabled: true,
            permissionCollector,
          });
          await systemCompanionServer.start();
        }
        systemCompanionBridge = createFridaySystemUnixSocketBridge({
          id: companionId,
          platform: detectedSystemPlatform,
          nowIso,
          runtimeKind: configuredCompanionRuntimeKind,
          launchAtLoginEnabled,
          panicHotkey,
          socketPath,
          authToken: companionAuthToken,
          menuBarEnabled: true,
          overlayEnabled: true,
          permissionCollector,
        });
      } else if (transportMode === "named_pipe") {
        systemCompanionBridge = createFridaySystemNamedPipeBridge({
          id: companionId,
          platform: detectedSystemPlatform,
          nowIso,
          runtimeKind: configuredCompanionRuntimeKind,
          launchAtLoginEnabled,
          panicHotkey,
          pipeName,
          authToken: companionAuthToken,
          menuBarEnabled: true,
          overlayEnabled: true,
          permissionCollector,
        });
      } else {
        systemCompanionBridge = createFridaySystemLocalCompanionBridge({
          id: companionId,
          platform: detectedSystemPlatform,
          nowIso,
          runtimeKind: configuredCompanionRuntimeKind,
          launchAtLoginEnabled,
          panicHotkey,
          socketPath,
          menuBarEnabled: true,
          overlayEnabled: true,
          permissionCollector,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[friday] Agent OS system companion unavailable during startup setup; continuing with unavailable runtime: ${message}`);
      systemCompanionServer = undefined;
      systemCompanionBridge = createFridaySystemUnavailableCompanionBridge({
        id: companionId,
        platform: detectedSystemPlatform,
        nowIso,
        runtimeKind: configuredCompanionRuntimeKind,
        launchAtLoginEnabled,
        panicHotkey,
        socketPath,
        menuBarEnabled: true,
        overlayEnabled: true,
        permissionCollector,
        unavailableReason: message,
      });
    }

    systemService = await createFridaySystemService({
      db: stateRuntime!.sqlite,
      idGenerator,
      nowIso,
      workspaceRoot,
      companionBridge: systemCompanionBridge,
      desktopSessionManager,
      getBrowserDiagnostics: () => {
        const diagnostics = browserManager.getDiagnostics();
        return {
          ...diagnostics,
          browserTarget: diagnostics.targetBrowser,
        };
	      },
	      mode: "agent_os",
	      remoteMode: systemRemoteMode,
	      canonicalMutationGate: canonicalMutatingActionGateEnabled,
	      canonicalApprovalSecret: tokenSecret,
	      cloudPlanningMode: systemCloudPlanningMode,
      // TS Runtime Retirement (§1 method-level guard): production leaves this
      // unset (config flag undefined) so the `executeIntent` method is
      // fail-closed for the agent system tool path, not just the HTTP route
      // (whose own flag is never threaded in hub bootstrap). Test-oracle hub
      // configs set it true to exercise legacy intent execution.
      allowTestOnlySystemIntentExecution: config.allowTestOnlySystemIntentExecution,
      remoteAuth: {
        rpName: systemRemoteAuthRpName,
        rpId: systemRemoteAuthRpId,
        origin: systemRemoteAuthOrigin,
        challengeTtlMs: Number.isFinite(systemRemoteAuthChallengeTtlMs)
          ? systemRemoteAuthChallengeTtlMs
          : undefined,
        assertionTtlMs: Number.isFinite(systemRemoteAuthAssertionTtlMs)
          ? systemRemoteAuthAssertionTtlMs
          : undefined,
      },
    });

    systemRouteDeps = {
      session: {
        get: async () => ({
          session: await systemService!.getSession(),
        }),
      },
      state: {
        get: async () => ({
          snapshot: await systemService!.getState(),
        }),
      },
      intents: {
        execute: async (req) => ({
          result: await systemService!.executeIntent(req),
        }),
      },
      systemIntentViaRust: resolveSystemIntentViaRust(config.systemIntentViaRust),
      executeSystemIntentViaRust: createFridayRustHubSystemIntentService().execute,
      approvals: {
        list: (query) => {
          const items = systemService!.listApprovalRules({
            action: query.action,
            appIdentifier: query.appIdentifier,
            decision: query.decision,
            limit: typeof query.limit === "number" ? query.limit : undefined,
            cursor: query.cursor,
          });
          return {
            items,
            nextCursor: items.length > 0 ? items[items.length - 1]!.updatedAt : undefined,
          };
        },
        update: (_approvalId, _req) => {
          throw new FridayDomainError(
            "SYSTEM_CANONICAL_APPROVAL_REQUIRED",
            "System approval rule mutations must go through the canonical approval gate.",
            { httpStatus: 403 },
          );
        },
      },
      events: {
        list: (query) => {
          const items = systemService!.listEvents({
            afterSeq: typeof query.afterSeq === "number" ? query.afterSeq : undefined,
            limit: typeof query.limit === "number" ? query.limit : undefined,
          });
          return {
            items,
            nextAfterSeq: items.length > 0 ? items[items.length - 1]!.seq : undefined,
          };
        },
        subscribe: (listener) => systemService!.subscribe(listener),
      },
      remote: {
        list: () => ({
          items: systemService!.listRemoteDevices(),
        }),
        register: (req) => ({
          device: systemService!.registerRemoteDevice({
            label: req.label,
            fingerprint: req.fingerprint,
            platform: req.platform,
            credentialId: req.credentialId,
          }),
        }),
        revoke: (deviceId) => ({
          revoked: systemService!.revokeRemoteDevice(deviceId) !== null,
          deviceId,
        }),
        clearPasskey: async (deviceId) => ({
          cleared: true,
          deviceId,
          device: await systemService!.clearRemoteDevicePasskey(deviceId),
        }),
        listSessions: (query) => ({
          items: systemService!.listRemoteSessions({
            deviceId: query.deviceId,
            status: query.status,
            limit: typeof query.limit === "number" ? query.limit : undefined,
          }),
        }),
        openSession: async (req, meta) => ({
          session: await systemService!.openRemoteSession({
            deviceId: req.deviceId,
            assertionToken: req.assertionToken,
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          }),
        }),
        heartbeatSession: async (sessionId, _req, meta) => ({
          session: await systemService!.touchRemoteSession(sessionId, {
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          }),
        }),
        closeSession: async (sessionId) => ({
          closed: (await systemService!.closeRemoteSession(sessionId, "closed_by_request")) !== null,
          sessionId,
        }),
      },
      remoteAuth: {
        beginRegistration: async (req, meta) => ({
          ...(await systemService!.beginRemotePasskeyRegistration({
            deviceId: req.deviceId,
            origin: meta.origin,
          })),
        }),
        verifyRegistration: async (req, meta) => ({
          ...(await systemService!.verifyRemotePasskeyRegistration({
            deviceId: req.deviceId,
            challengeId: req.challengeId,
            response: req.response,
            origin: meta.origin,
          })),
        }),
        beginAssertion: async (req, meta) => ({
          ...(await systemService!.beginRemotePasskeyAssertion({
            deviceId: req.deviceId,
            origin: meta.origin,
          })),
        }),
        verifyAssertion: async (req, meta) => ({
          ...(await systemService!.verifyRemotePasskeyAssertion({
            deviceId: req.deviceId,
            challengeId: req.challengeId,
            response: req.response,
            origin: meta.origin,
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          })),
        }),
      },
    };

    const guideLensParserProvider = (
      process.env.FRIDAY_GUIDE_LENS_PARSER_PROVIDER === "omniparser"
      || process.env.FRIDAY_GUIDE_LENS_PARSER_PROVIDER === "midscene"
      || process.env.FRIDAY_GUIDE_LENS_PARSER_PROVIDER === "custom"
    )
      ? process.env.FRIDAY_GUIDE_LENS_PARSER_PROVIDER
      : "custom";
    const guideLensParserEndpoint = process.env.FRIDAY_GUIDE_LENS_PARSER_URL?.trim();
    const guideLensParserAdapter = guideLensParserEndpoint
      ? createFridayGuideLensHttpParserAdapter({
        endpointUrl: guideLensParserEndpoint,
        provider: guideLensParserProvider,
      })
      : undefined;
    const guideLensParserPreference: FridayGuideLensPreferences["parserProvider"] = guideLensParserAdapter
      ? guideLensParserProvider
      : "local_none";

    guideLensService = createFridayGuideLensService({
      idGenerator,
      nowIso,
      systemService,
      // Barrier 5: the guide_lens agent tool bypasses the executeIntent retirement
      // guard, so on the default/prod path it must NOT receive the live companion
      // bridge (it would let an agent drive overlay draws + a captureSnapshot
      // screen-read at the daemon). Fail closed to `undefined` unless the same
      // test-only flag that opens executeIntent is set; the service null-checks the
      // bridge and degrades overlay/snapshot to no-ops when absent.
      companionBridge: resolveAgentReachableCompanionBridge(
        systemCompanionBridge,
        config.allowTestOnlySystemIntentExecution,
      ),
      parserAdapter: guideLensParserAdapter,
      defaultPreferences: {
        defaultSurface: "native_desktop",
        parserProvider: guideLensParserPreference,
        avatar: {
          kind: "default_f",
          initials: "F",
          sizePx: 56,
        },
      },
      preferenceStore: {
        load: () => {
          const persisted = stateRuntime!.sqlite.withReadConnection((db) =>
            uixUserPreferenceRepository.listByPrincipal(db, {
              principalId: guideLensPreferencePrincipalId,
              category: "uix",
            }).find((preference) => preference.key === guideLensPreferenceKey));
          return isGuideLensPreferencePatch(persisted?.value) ? persisted.value : undefined;
        },
        save: (preferences) => {
          stateRuntime!.sqlite.withWriteTransaction((db) => {
            uixUserPreferenceRepository.upsert(db, {
              id: idGenerator(),
              principalId: guideLensPreferencePrincipalId,
              category: "uix",
              key: guideLensPreferenceKey,
              value: JSON.parse(JSON.stringify(preferences)),
              source: "explicit",
              confidence: 1,
              nowIso: nowIso(),
            });
          });
        },
      },
    });
    guideLensRouteDeps = {
      service: guideLensService,
      allowTestOnlyGuideLensExecution: config.allowTestOnlyGuideLensExecution,
    };

    console.log(
      `[friday] Agent OS system runtime enabled (remote=${systemRemoteMode}, cloud=${systemCloudPlanningMode}, companion=${transportMode}/${transportMode === "unix_socket" ? companionServerMode : "local"})`,
    );
  } else {
    console.log("[friday] Agent OS system runtime disabled");
  }

  // ─── Session service for agent session mirror ───
  // (created before tool registry so it can be wired into sessions tool)
  const hubSessionService = createFridaySessionService({
    db: stateRuntime!.sqlite,
    idGenerator,
    nowIso,
    // TS Runtime Retirement (TS-R4/G3 method-level guard): production leaves
    // this unset (config flag undefined) so `sweepLifecycle` is fail-closed for
    // the `session-lifecycle-sweep` scheduler job (which bypasses the HTTP route
    // guard), not just the route. This same instance is also passed to the API
    // runtime, so the route guard and the method guard stay consistent.
    // Test-oracle hub configs set it true to exercise the legacy sweep.
    allowTestOnlySessionExecution: config.allowTestOnlySessionExecution,
  });

  // Build agent tool registry (exec, read, write, edit, web_fetch, browser, xhs, + new tools)
  // IMPL-4: Pass SSRF guard to tool registry
  // Lazy getter for agentRuntime — runtime is created after tool list, so sessions tool
  // receives a deferred reference that resolves once runtime is wired up.
  let _agentRuntimeRef: FridayAgentRuntime | undefined;
  const agentRuntimeGetter = () => _agentRuntimeRef;
  let subagentRegistry!: ReturnType<typeof createFridaySubagentRegistry>;

  // Optional MCP adapter (JSON config from FRIDAY_MCP_SERVERS + persisted mcp-servers.json).
  // Env config takes precedence on ID collision.
  const mcpConfigStore = config.stateDir ? createFridayMcpConfigStore(config.stateDir) : undefined;
  const envMcpServers = parseFridayMcpServersFromEnv(process.env);
  const persistedMcpServers = mcpConfigStore?.load() ?? [];
  const envServerIds = new Set(envMcpServers.map((s) => s.id));
  const mergedMcpServers = [
    ...envMcpServers,
    ...persistedMcpServers.filter((s) => !envServerIds.has(s.id)),
  ];
  const mcpAdapter = mergedMcpServers.length > 0
    ? createFridayMcpAdapter({ servers: mergedMcpServers })
    : undefined;
  if (mcpAdapter) {
    console.log(`[friday] MCP adapter enabled with ${String(mergedMcpServers.length)} server(s) (${String(envMcpServers.length)} env, ${String(persistedMcpServers.filter((s) => !envServerIds.has(s.id)).length)} persisted)`);
  }
  const mcpServerUpgradeStateRepoForAgent = createFridayAutonomySubjectUpgradeStateRepository();
  const getMcpServerAvailability = (serverId: string) => {
    const state = stateRuntime!.sqlite.withReadConnection((db) =>
      mcpServerUpgradeStateRepoForAgent.get(db, "mcp_server", serverId));
    const available = state?.promotionChannel === "active" && state.compatibilityStatus === "compatible";
    return {
      available,
      promotionChannel: state?.promotionChannel ?? "none",
      compatibilityStatus: state?.compatibilityStatus ?? "unknown",
      reason: available ? undefined : "MCP server must complete lifecycle promote before agent use.",
    };
  };
  const listAgentAvailableMcpServers = () =>
    (mcpAdapter?.listServers() ?? []).filter((server) => getMcpServerAvailability(server.id).available);
  const listAgentAvailableMcpServerStates = () => {
    const availableIds = new Set(listAgentAvailableMcpServers().map((server) => server.id));
    return (mcpAdapter?.listServerStates() ?? []).filter((state) => availableIds.has(state.serverId));
  };
  const explicitSearchProvider = process.env.FRIDAY_SEARCH_PROVIDER?.trim().toLowerCase();
  const inferredSearchProvider = explicitSearchProvider && explicitSearchProvider !== "auto"
    ? explicitSearchProvider
    : process.env.FRIDAY_SERPER_API_KEY?.trim()
      ? "serper"
      : process.env.FRIDAY_TAVILY_API_KEY?.trim()
        ? "tavily"
        : explicitSearchProvider;
  const configuredSearchProvider = inferredSearchProvider;
  const configuredSearchApiKey = configuredSearchProvider === "serper"
    ? process.env.FRIDAY_SERPER_API_KEY
    : configuredSearchProvider === "tavily"
      ? process.env.FRIDAY_TAVILY_API_KEY
      : undefined;
  const hasConfiguredSearchKey = Boolean(configuredSearchApiKey?.trim());
  const publicSearchProvider = !configuredSearchProvider || configuredSearchProvider === "auto"
    ? "google_news_rss+duckduckgo_html"
    : configuredSearchProvider === "duckduckgo"
      ? "duckduckgo_html"
      : configuredSearchProvider;
  const searchWarning = configuredSearchProvider === "serper" && !process.env.FRIDAY_SERPER_API_KEY?.trim()
    ? 'Configured search provider "serper" is missing FRIDAY_SERPER_API_KEY; time-sensitive news lookup is unverified.'
    : configuredSearchProvider === "tavily" && !process.env.FRIDAY_TAVILY_API_KEY?.trim()
      ? 'Configured search provider "tavily" is missing FRIDAY_TAVILY_API_KEY; time-sensitive news lookup is unverified.'
      : configuredSearchProvider === "duckduckgo"
        ? 'Configured search provider "duckduckgo" does not verify publication dates for time-sensitive news lookup.'
    : (!configuredSearchProvider || configuredSearchProvider === "auto")
      ? "Default search uses Google News RSS plus DuckDuckGo HTML; general-result recency is unverified without Serper or Tavily."
        : !hasConfiguredSearchKey && (configuredSearchProvider === "serper" || configuredSearchProvider === "tavily")
          ? `Search provider "${configuredSearchProvider}" has no API key configured; time-sensitive news lookup is unverified.`
          : undefined;
  if (process.env.NODE_ENV !== "test") {
    if (searchWarning) {
      console.warn(`[friday] ${searchWarning}`);
    }
  }
  type WebSearchHealth = {
    provider: string;
    latestness: "provider_backed" | "unverified";
    warning?: string;
  };
  const WEB_SEARCH_HEALTH_CACHE_MS = 5 * 60 * 1000;
  let webSearchHealthCache: { checkedAtMs: number; value: WebSearchHealth } | undefined;
  const staticWebSearchHealth = (warning?: string): WebSearchHealth => ({
    provider: publicSearchProvider,
    latestness: warning ? "unverified" as const : "provider_backed" as const,
    ...(warning ? { warning } : {}),
  });
  const probeConfiguredWebSearchProvider = async (): Promise<WebSearchHealth> => {
    if (searchWarning || (configuredSearchProvider !== "serper" && configuredSearchProvider !== "tavily")) {
      return staticWebSearchHealth(searchWarning);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const key = configuredSearchApiKey?.trim();
      if (!key) {
        return staticWebSearchHealth(`Search provider "${configuredSearchProvider}" has no API key configured.`);
      }
      const response = configuredSearchProvider === "serper"
        ? await fetch("https://google.serper.dev/search", {
            method: "POST",
            headers: {
              "X-API-KEY": key,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ q: "Friday capability probe", num: 1 }),
            signal: controller.signal,
          })
        : await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              api_key: key,
              query: "Friday capability probe",
              max_results: 1,
              search_depth: "basic",
            }),
            signal: controller.signal,
          });
      return response.ok
        ? staticWebSearchHealth()
        : staticWebSearchHealth(`Search provider "${configuredSearchProvider}" failed live verification with HTTP ${String(response.status)}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return staticWebSearchHealth(`Search provider "${configuredSearchProvider}" failed live verification: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  };
  const resolveWebSearchHealth = async (): Promise<WebSearchHealth> => {
    const nowMs = Date.now();
    if (webSearchHealthCache && nowMs - webSearchHealthCache.checkedAtMs < WEB_SEARCH_HEALTH_CACHE_MS) {
      return webSearchHealthCache.value;
    }
    const value = await probeConfiguredWebSearchProvider();
    webSearchHealthCache = { checkedAtMs: nowMs, value };
    return value;
  };
  const starterSkillRoutingEnforced = process.env.FRIDAY_AGENT_ENFORCE_STARTER_SKILL_ROUTING === "true";
  const subagentForkModeEnabled = process.env.FRIDAY_SUBAGENT_FORK_MODE_ENABLED === "true";

  const listInstalledStarterSkills = (): FridayAgentStarterSkillDescriptor[] =>
    registry.list()
      .filter((skill) =>
        skill.status === "installed"
        && (skill.manifest.tags ?? []).includes("starter"))
      .sort((left, right) => {
        const leftPriority =
          (left.manifest.tags ?? []).includes("starter.recovery")
            ? 0
            : (left.manifest.tags ?? []).includes("starter.diagnosis")
              ? 1
              : 2;
        const rightPriority =
          (right.manifest.tags ?? []).includes("starter.recovery")
            ? 0
            : (right.manifest.tags ?? []).includes("starter.diagnosis")
              ? 1
              : 2;
        if (leftPriority !== rightPriority) {
          return leftPriority - rightPriority;
        }
        return left.manifest.name.localeCompare(right.manifest.name);
      })
      .map((skill) => ({
        skillId: skill.manifest.id,
        purpose: skill.manifest.description,
        triggerPhrases: skill.manifest.triggers.phrases ?? [],
        intents: skill.manifest.triggers.intents ?? [],
        tags: skill.manifest.tags ?? [],
      }));

  const getAgentCapabilitySnapshot = async (input: { readOnly: boolean }): Promise<FridayAgentCapabilitiesSnapshot> => {
    const messagingKinds = typeof channelRegistry !== "undefined"
      ? channelRegistry.list().filter((kind) => channelRegistry.status(kind) === "connected")
      : [];
    const mcpServers = listFridayMcpServerReadiness({
      servers: listAgentAvailableMcpServers(),
      serverStates: listAgentAvailableMcpServerStates(),
    });
    const verifiedMcpServerCount = mcpServers.filter((server) => server.connected).length;
    const providers = await providerService.listProviders()
      .catch(() => []);
    const providerCount = providers.length;
    const browserDiagnostics = browserManager?.getDiagnostics();
    // Keep deterministic capability responses fast. A full system snapshot can
    // fan out into companion status and desktop probes that are appropriate for
    // operator pages, but too expensive for sync-immediate dispatch.
    const desktopConnected = desktopSessionManager?.isConnected() ?? false;
    const companionConnected = systemCompanionBridge?.isConnected() ?? false;

    return {
      readOnly: input.readOnly,
      messaging: {
        enabled: messagingKinds.length > 0,
        kinds: messagingKinds,
      },
      mcp: {
        enabled: verifiedMcpServerCount > 0,
        serverCount: verifiedMcpServerCount,
        servers: mcpServers.map((server) => ({
          name: server.name,
          connected: server.connected,
          authenticated: server.authenticated,
        })),
      },
      provider: {
        available: providerCount > 0,
        configuredCount: providerCount,
        mutationBlockedByReadOnly: input.readOnly,
      },
      browser: {
        activeMode: browserDiagnostics?.activeMode,
        targetBrowser: browserDiagnostics?.targetBrowser,
      },
      system: {
        enabled: !!systemService,
      },
      desktop: {
        connected: desktopConnected,
      },
      companion: {
        connected: companionConnected,
      },
      reflex: {
        onboardingEnabled: true,
        candidatesEnabled: true,
        curatorEnabled: true,
        liveLlmTestsEnabled: process.env.FRIDAY_LIVE_LLM_REFLEX_TESTS === "1",
      },
      runtime: buildFridayRuntimeCapabilityMatrix({
        nowIso: nowIso(),
        readOnly: input.readOnly,
        providers,
        webSearch: await resolveWebSearchHealth(),
        pdfParseEnabled: true,
        browserEnabled: Boolean(browserManager),
        browserVerified: Boolean(browserDiagnostics?.sessionId),
        browserDetail: browserDiagnostics?.sessionId
          ? undefined
          : "Browser runtime is configured; run a browser open/status action to verify Playwright or host Chrome launches on this machine.",
        mcpServerCount: mcpServers.length,
        mcpVerifiedServerCount: verifiedMcpServerCount,
        skillCount: registry.list().filter((skill) => skill.status === "installed").length,
        ttsEnabled: false,
      }),
    };
  };

  const getAgentTaskStatusSnapshot = async (input: {
    runId?: string;
    sessionKey?: string;
    readOnly: boolean;
  }): Promise<FridayAgentTaskStatusSnapshot> => {
    const focusState = input.sessionKey
      ? await hubSessionService.getConversationFocus(input.sessionKey).catch(() => null)
      : null;

    const resolveExistingRunId = (...candidates: Array<string | undefined>): string | undefined => {
      for (const candidate of candidates) {
        if (!candidate) {
          continue;
        }
        const existing = stateRuntime!.sqlite.withReadConnection((reader) => agentRunRepo.getById(reader, candidate));
        if (existing) {
          return candidate;
        }
      }
      return undefined;
    };

    const collectSubagentTree = (parentRunId: string): ReturnType<typeof subagentRegistry.listByParentRunId> => {
      const queue = [parentRunId];
      const seen = new Set<string>();
      const records: ReturnType<typeof subagentRegistry.listByParentRunId> = [];
      while (queue.length > 0) {
        const currentParentRunId = queue.shift();
        if (!currentParentRunId) {
          continue;
        }
        for (const record of subagentRegistry.listByParentRunId(currentParentRunId)) {
          if (seen.has(record.id)) {
            continue;
          }
          seen.add(record.id);
          records.push(record);
          queue.push(record.childRunId);
        }
      }
      return records;
    };

    const trackedRunId = resolveExistingRunId(
      focusState?.activeRunId,
      focusState?.pendingPlanRunId,
      focusState?.lastRunId,
      input.runId,
    );
    const trackedRun = trackedRunId
      ? stateRuntime!.sqlite.withReadConnection((reader) => agentRunRepo.getById(reader, trackedRunId))
      : null;
    const trackedEvents = trackedRunId
      ? stateRuntime!.sqlite.withReadConnection((reader) => agentRunEventRepository.list(reader, trackedRunId))
      : [];
    const firstNonEmpty = (...values: Array<string | undefined>): string | undefined => {
      for (const value of values) {
        const normalized = value?.trim();
        if (normalized && normalized.length > 0) {
          return normalized;
        }
      }
      return undefined;
    };
    const latestCancellationReason = firstNonEmpty(
      ...[...trackedEvents]
        .reverse()
        .map((event) =>
          event.eventName === "agent.run.cancelled" && typeof event.payload.reason === "string"
            ? event.payload.reason
            : undefined),
    );

    let latestPhase: string | undefined;
    let latestTool: string | undefined;
    for (const event of trackedEvents) {
      if (event.eventName === "agent.run.progress" && typeof event.payload.phase === "string") {
        latestPhase = event.payload.phase;
      }
      if (event.eventName === "agent.run.tool_start" && typeof event.payload.toolName === "string") {
        latestTool = event.payload.toolName;
      }
      if (
        event.eventName === "agent.run.tool_end"
        && typeof event.payload.toolName === "string"
        && event.payload.toolName === latestTool
      ) {
        latestTool = undefined;
      }
    }

    const subagentRecords = trackedRunId ? collectSubagentTree(trackedRunId) : [];
    const activeSubagents = subagentRecords
      .filter((record) => record.status === "pending" || record.status === "running")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((record) => ({
        id: record.id,
        childRunId: record.childRunId,
        childSessionKey: record.childSessionKey,
        mode: record.mode,
        forkedFromMessageId: record.forkedFromMessageId,
        inheritedMessageCount: record.inheritedMessageCount,
        status: record.status,
        task: record.task,
        label: record.label,
        createdAt: record.createdAt,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        durationMs: record.durationMs,
        outcomeStatus: record.outcome?.status,
        outcomeResponse: record.outcome?.response,
      }));

    const recentCompletedSubagents = subagentRecords
      .filter((record) => record.status === "completed" || record.status === "failed" || record.status === "cancelled")
      .sort((left, right) => {
        const leftTime = left.completedAt ?? left.createdAt;
        const rightTime = right.completedAt ?? right.createdAt;
        return rightTime.localeCompare(leftTime);
      })
      .map((record) => ({
        id: record.id,
        childRunId: record.childRunId,
        childSessionKey: record.childSessionKey,
        mode: record.mode,
        forkedFromMessageId: record.forkedFromMessageId,
        inheritedMessageCount: record.inheritedMessageCount,
        status: record.status,
        task: record.task,
        label: record.label,
        createdAt: record.createdAt,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        durationMs: record.durationMs,
        outcomeStatus: record.outcome?.status,
        outcomeResponse: record.outcome?.response,
      }));

    const blockers: string[] = [];
    if (trackedRun?.status === "failed" && trackedRun.errorMessage) {
      blockers.push(trackedRun.errorMessage);
    }
    if (focusState?.pendingPlanRunId) {
      if (trackedRun?.status === "awaiting_clarification") {
        blockers.push(`Awaiting clarification for run ${focusState.pendingPlanRunId}.`);
      } else if (trackedRun?.status === "awaiting_plan_approval") {
        blockers.push(`Awaiting plan approval for run ${focusState.pendingPlanRunId}.`);
      } else {
        blockers.push(`Pending planning gate for run ${focusState.pendingPlanRunId}.`);
      }
    }

    const elapsedMs = trackedRun?.startedAt
      ? Math.max(0, Date.now() - new Date(trackedRun.startedAt).getTime())
      : undefined;

    const latestCompletedSubagent = recentCompletedSubagents[0];
    const trackedRunCompletedAt = trackedRun?.completedAt;
    const latestSubagentCompletedAfterTrackedRun = Boolean(
      latestCompletedSubagent?.completedAt
        && trackedRunCompletedAt
        && latestCompletedSubagent.completedAt > trackedRunCompletedAt,
    );
    const trackedRunLooksStale = Boolean(
      trackedRun?.responseText
      && /still running|currently executing|accepted|delegated snapshot/i.test(trackedRun.responseText),
    );
    const terminalOutcome = trackedRun && (
      trackedRun.status === "completed"
      || trackedRun.status === "failed"
      || trackedRun.status === "cancelled"
    )
      ? (
          latestCompletedSubagent?.outcomeStatus
            && latestCompletedSubagent.outcomeResponse
            && (latestSubagentCompletedAfterTrackedRun || trackedRunLooksStale)
        )
          ? {
              status: latestCompletedSubagent.outcomeStatus,
              summary: latestCompletedSubagent.outcomeResponse,
              responseText: latestCompletedSubagent.outcomeResponse,
            }
          : {
              status: trackedRun.status,
              summary: trackedRun.status === "cancelled"
                ? firstNonEmpty(trackedRun.summary, latestCancellationReason, "Cancelled before completion.")
                : trackedRun.summary,
              responseText: trackedRun.status === "cancelled"
                ? firstNonEmpty(trackedRun.responseText, latestCancellationReason, "Cancelled before completion.")
                : trackedRun.responseText,
            }
      : undefined;

    return {
      readOnly: input.readOnly,
      sessionKey: input.sessionKey,
      trackedRunId: trackedRun?.id,
      task: trackedRun?.task,
      runStatus: trackedRun?.status,
      phase: latestPhase ?? trackedRun?.status,
      elapsedMs,
      latestTool,
      activeSubagents,
      recentCompletedSubagents: recentCompletedSubagents.slice(0, 3),
      blockers,
      pendingPlanRunId: focusState?.pendingPlanRunId,
      terminalOutcome,
    };
  };

  const getPublicSystemHealth: () => Promise<{
    enabled: boolean;
    remoteMode: "trusted_private_network" | "disabled" | "unavailable";
    healthStatus?: "healthy" | "degraded" | "safe_mode" | "unavailable";
    companionConnected?: boolean;
    companionReadiness?: "ready" | "degraded" | "unavailable";
    reasons?: string[];
    warning?: string;
  }> = async () => {
    const remoteMode: "trusted_private_network" | "disabled" | "unavailable" = systemEnabled
      ? (process.env.FRIDAY_SYSTEM_REMOTE_MODE === "trusted_private_network" ? "trusted_private_network" : "disabled")
      : "unavailable";
    if (!systemEnabled) {
      return {
        enabled: false,
        remoteMode,
        companionReadiness: "unavailable" as const,
      };
    }

    if (!systemService) {
      return {
        enabled: true,
        remoteMode,
        healthStatus: "unavailable" as const,
        companionConnected: false,
        companionReadiness: "unavailable" as const,
        reasons: ["system_service_unavailable"],
        warning: "Agent OS is enabled, but the system runtime is unavailable in this process.",
      };
    }

    const session = await systemService.getSession().catch(() => undefined);
    if (!session) {
      return {
        enabled: true,
        remoteMode,
        healthStatus: "unavailable" as const,
        companionConnected: false,
        companionReadiness: "unavailable" as const,
        reasons: ["system_session_unavailable"],
        warning: "Agent OS is enabled, but the current system session could not be inspected.",
      };
    }

    const companionReadiness: "ready" | "degraded" | "unavailable" = !session.health.companionConnected
      ? "degraded"
      : session.health.status === "healthy"
        ? "ready"
        : session.health.status === "unavailable"
          ? "unavailable"
          : "degraded";
    const warning = !session.health.companionConnected
      ? "System companion unavailable; Friday is continuing in degraded mode for local device actions."
      : session.health.status !== "healthy"
        ? `System runtime is not fully ready: ${session.health.reasons.join(", ")}`
        : undefined;

    return {
      enabled: true,
      remoteMode,
      healthStatus: session.health.status,
      companionConnected: session.health.companionConnected,
      companionReadiness,
      reasons: [...session.health.reasons],
      ...(warning ? { warning } : {}),
    };
  };

  const agentTools = createFridayAgentToolRegistry({
    workdir: workspaceRoot,
    skillExecutor: executor,
    skillRegistry: registry,
    getSkillLifecycleStatus: getPersistedSkillLifecycleStatus,
    // OF6: fence the agent skill_run tool's arbitrary-code sink with the same
    // skill-run retirement flag the route uses (default-off → fail-closed).
    allowTestOnlySkillRunExecution: config.allowTestOnlySkillRunExecution,
    // Route-only-guard defect: fence the agent provider tool's `validate` action
    // (live billable probe) with the same probe retirement flag the route uses
    // (default-off → fail-closed). The shared auto-validate routing path is
    // NOT touched.
    allowTestOnlyProviderProbeExecution: config.allowTestOnlyProviderProbeExecution,
    workflowCrudService: workflowRuntime.crud,
    workflowExecutionService: workflowRuntime.execution,
    memoryService,
    memoryGuardFactory,
    listLearnedFacts: (input) =>
      selfLearningRuntime.facts
        .listActiveFacts({ userId: input.userId, minConfidence: 0, limit: input.limit })
        .map((f) => ({
          key: f.key,
          value: f.value,
          confidence: f.confidence,
          evidenceCount: f.evidenceCount,
          lastConfirmedAt: f.lastConfirmedAt,
        })),
    learningEventWriter: (events) => {
      selfLearningRuntime.pipeline.processBatch(events);
    },
    idGenerator,
    nowIso,
    browserManager,
    xhsPageInteractions,
    xhsSessionManager,
    desktopSessionManager,
    systemService,
    guideLensService,
    ssrfGuard: agentSsrfGuard,
    sessionService: hubSessionService,
    agentRuntimeGetter,
    mcpAdapter,
    getMcpServerAvailability,
    providerService,
    ttsService,
    webSearchProvider: configuredSearchProvider,
    webSearchApiKey: configuredSearchApiKey,
    capabilitySnapshotGetter: getAgentCapabilitySnapshot,
    taskStatusSnapshotGetter: getAgentTaskStatusSnapshot,
    reflexServiceGetter: () => reflexService,
    defaultReflexUserId: learningDefaultUserId,
    subagentForkModeEnabled,
  });

  const mcpServer = (() => {
    if (!capabilityGates.mcpServerEnabled) {
      return undefined;
    }

    const envAllowlist = (process.env.FRIDAY_MCP_SERVER_TOOL_ALLOWLIST ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const { isToolAllowed } = buildMcpServerToolFilter(envAllowlist);
    const listAllowedTools = () => agentTools.filter((tool) => isToolAllowed(tool.name));
    const appendMcpServerAudit = (entry: {
      action: string;
      resourceType: string;
      resourceId: string;
      result: "success" | "denied" | "error";
      routeId: string;
      correlationId: string;
      requestId?: string;
      errorCode?: string;
      errorMessage?: string;
      details?: Record<string, unknown>;
    }) => {
      void memoryState.appendAuditLog({
        id: idGenerator(),
        ts: nowIso(),
        actorType: "service",
        actorId: "mcp-server",
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        requestId: entry.requestId,
        result: entry.result,
        ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
        ...(entry.errorMessage ? { errorMessage: entry.errorMessage } : {}),
        caller: entry.routeId,
        details: {
          routeId: entry.routeId,
          correlationId: entry.correlationId,
          ...(entry.details ?? {}),
        },
      }).catch((err: unknown) => warnHubBootstrapOnce(`[friday] audit-append: ${err instanceof Error ? err.message : String(err)}`));
    };

    const appendMcpServerToolAudit = (entry: {
      toolName: string;
      result: "success" | "denied" | "error";
      routeId: string;
      correlationId: string;
      requestId?: string;
      errorCode?: string;
      errorMessage?: string;
    }) => {
      appendMcpServerAudit({
        action: "mcp.server.tool.call",
        resourceType: "mcp_tool",
        resourceId: entry.toolName,
        result: entry.result,
        routeId: entry.routeId,
        correlationId: entry.correlationId,
        requestId: entry.requestId,
        errorCode: entry.errorCode,
        errorMessage: entry.errorMessage,
        details: {
          toolName: entry.toolName,
        },
      });
    };

    console.log(
      `[friday] MCP server enabled with ${String(listAllowedTools().length)} tool(s)` +
      (envAllowlist.length > 0 ? " (allowlist mode)" : " (safe catalog)"),
    );

    return {
      serverInfo: {
        name: "friday",
        version: FRIDAY_VERSION,
        instructions: "Friday MCP server bridge for internal tools/resources/prompts.",
      },
      listTools: () => {
        return listAllowedTools().map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: (
            tool.parameters &&
            typeof tool.parameters === "object" &&
            !Array.isArray(tool.parameters)
          )
            ? tool.parameters as Record<string, unknown>
            : { type: "object", properties: {} },
        }));
      },
      callTool: async (input: {
        name: string;
        args?: Record<string, unknown>;
        signal?: AbortSignal;
        routeId?: string;
        correlationId?: string;
        requestId?: string;
      }) => {
        const routeId = input.routeId ?? "mcp.server.rpc";
        const correlationId = input.correlationId ?? `mcp.server:${input.name}:${Date.now().toString(36)}`;
        const tool = listAllowedTools().find((candidate) => candidate.name === input.name);
        if (!tool) {
          appendMcpServerToolAudit({
            toolName: input.name,
            result: "denied",
            routeId,
            correlationId,
            requestId: input.requestId,
            errorCode: "MCP_SERVER_TOOL_NOT_EXPOSED",
            errorMessage: `Tool '${input.name}' is not exposed by Friday MCP server`,
          });
          return {
            content: `Tool '${input.name}' is not exposed by Friday MCP server`,
            isError: true,
            errorCode: "MCP_SERVER_TOOL_NOT_EXPOSED",
            routeId,
            correlationId,
            raw: {
              errorCode: "MCP_SERVER_TOOL_NOT_EXPOSED",
              routeId,
              correlationId,
            },
          };
        }

        const signal = input.signal ?? new AbortController().signal;
        try {
          const result = await tool.execute(input.args ?? {}, signal);
          if (result.isError === true) {
            appendMcpServerToolAudit({
              toolName: input.name,
              result: "error",
              routeId: result.routeId ?? routeId,
              correlationId: result.correlationId ?? correlationId,
              requestId: input.requestId,
              errorCode: result.errorCode ?? "MCP_SERVER_TOOL_RETURNED_ERROR",
              errorMessage: result.content,
            });
          } else {
            appendMcpServerToolAudit({
              toolName: input.name,
              result: "success",
              routeId: result.routeId ?? routeId,
              correlationId: result.correlationId ?? correlationId,
              requestId: input.requestId,
            });
          }
          return {
            content: result.content,
            isError: result.isError === true,
            errorCode: result.errorCode,
            routeId: result.routeId ?? routeId,
            correlationId: result.correlationId ?? correlationId,
            raw: {
              blocks: result.blocks ?? [],
              ...(result.errorCode ? { errorCode: result.errorCode } : {}),
              ...(result.routeId ? { routeId: result.routeId } : { routeId }),
              ...(result.correlationId ? { correlationId: result.correlationId } : { correlationId }),
            },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          appendMcpServerToolAudit({
            toolName: input.name,
            result: "error",
            routeId,
            correlationId,
            requestId: input.requestId,
            errorCode: "MCP_SERVER_TOOL_EXECUTION_FAILED",
            errorMessage: message,
          });
          return {
            content: message,
            isError: true,
            errorCode: "MCP_SERVER_TOOL_EXECUTION_FAILED",
            routeId,
            correlationId,
            raw: {
              errorCode: "MCP_SERVER_TOOL_EXECUTION_FAILED",
              routeId,
              correlationId,
            },
          };
        }
      },
      listResources: (input?: {
        routeId?: string;
        correlationId?: string;
        requestId?: string;
      }) => {
        const routeId = input?.routeId ?? "mcp.server.rpc";
        const correlationId = input?.correlationId
          ?? `mcp.server:resources/list:${Date.now().toString(36)}`;
        appendMcpServerAudit({
          action: "mcp.server.resource.list",
          resourceType: "mcp_resource",
          resourceId: "catalog",
          result: "success",
          routeId,
          correlationId,
          requestId: input?.requestId,
          details: {
            resourceCount: 2,
          },
        });
        return [
          {
            uri: "friday://tools",
            name: "Friday Tool Catalog",
            description: "Current MCP-exposed tool list from Friday runtime.",
            mimeType: "application/json",
          },
          {
            uri: "friday://status",
            name: "Friday Runtime Status",
            description: "Runtime capability and version metadata.",
            mimeType: "application/json",
          },
        ];
      },
      readResource: async (input: {
        uri: string;
        routeId?: string;
        correlationId?: string;
        requestId?: string;
      }) => {
        const routeId = input.routeId ?? "mcp.server.rpc";
        const correlationId = input.correlationId
          ?? `mcp.server:resources/read:${Date.now().toString(36)}`;
        if (input.uri === "friday://tools") {
          appendMcpServerAudit({
            action: "mcp.server.resource.read",
            resourceType: "mcp_resource",
            resourceId: input.uri,
            result: "success",
            routeId,
            correlationId,
            requestId: input.requestId,
          });
          return {
            contents: [
              {
                uri: input.uri,
                mimeType: "application/json",
                text: JSON.stringify({
                  generatedAt: nowIso(),
                  toolCount: listAllowedTools().length,
                  tools: listAllowedTools().map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                  })),
                }, null, 2),
              },
            ],
          };
        }
        if (input.uri === "friday://status") {
          appendMcpServerAudit({
            action: "mcp.server.resource.read",
            resourceType: "mcp_resource",
            resourceId: input.uri,
            result: "success",
            routeId,
            correlationId,
            requestId: input.requestId,
          });
          return {
            contents: [
              {
                uri: input.uri,
                mimeType: "application/json",
                text: JSON.stringify({
                  version: FRIDAY_VERSION,
                  mcpServerEnabled: true,
                  mcpServerToolCount: listAllowedTools().length,
                }, null, 2),
              },
            ],
          };
        }
        appendMcpServerAudit({
          action: "mcp.server.resource.read",
          resourceType: "mcp_resource",
          resourceId: input.uri,
          result: "denied",
          routeId,
          correlationId,
          requestId: input.requestId,
          errorCode: "MCP_SERVER_RESOURCE_NOT_FOUND",
          errorMessage: `Unknown resource: ${input.uri}`,
        });
        return {
          contents: [
            {
              uri: input.uri,
              mimeType: "text/plain",
              text: `Unknown resource: ${input.uri}`,
            },
          ],
        };
      },
      listPrompts: (input?: {
        routeId?: string;
        correlationId?: string;
        requestId?: string;
      }) => {
        const routeId = input?.routeId ?? "mcp.server.rpc";
        const correlationId = input?.correlationId
          ?? `mcp.server:prompts/list:${Date.now().toString(36)}`;
        appendMcpServerAudit({
          action: "mcp.server.prompt.list",
          resourceType: "mcp_prompt",
          resourceId: "catalog",
          result: "success",
          routeId,
          correlationId,
          requestId: input?.requestId,
          details: {
            promptCount: 1,
          },
        });
        return [
          {
            name: "friday_tool_call",
            description: "Prompt template for invoking Friday-exposed tools via MCP.",
          },
        ];
      },
      getPrompt: async (input: {
        name: string;
        args?: Record<string, unknown>;
        routeId?: string;
        correlationId?: string;
        requestId?: string;
      }) => {
        const routeId = input.routeId ?? "mcp.server.rpc";
        const correlationId = input.correlationId
          ?? `mcp.server:prompts/get:${Date.now().toString(36)}`;
        if (input.name !== "friday_tool_call") {
          appendMcpServerAudit({
            action: "mcp.server.prompt.get",
            resourceType: "mcp_prompt",
            resourceId: input.name,
            result: "denied",
            routeId,
            correlationId,
            requestId: input.requestId,
            errorCode: "MCP_SERVER_PROMPT_NOT_FOUND",
            errorMessage: `Unknown prompt: ${input.name}`,
          });
          return {
            description: "Prompt not found",
            messages: [
              {
                role: "system" as const,
                content: [{ type: "text" as const, text: `Unknown prompt: ${input.name}` }],
              },
            ],
          };
        }

        const requestedTool = typeof input.args?.toolName === "string"
          ? input.args.toolName
          : "<tool-name>";
        appendMcpServerAudit({
          action: "mcp.server.prompt.get",
          resourceType: "mcp_prompt",
          resourceId: input.name,
          result: "success",
          routeId,
          correlationId,
          requestId: input.requestId,
          details: {
            requestedTool,
          },
        });
        return {
          description: "Use this prompt to call a Friday MCP tool safely.",
          messages: [
            {
              role: "system" as const,
              content: [
                {
                  type: "text" as const,
                  text:
                    "You are interacting with Friday MCP server. Validate args against inputSchema before tools/call.",
                },
              ],
            },
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: `Call tool '${requestedTool}' with minimal required arguments and summarize result.`,
                },
              ],
            },
          ],
        };
      },
    };
  })();

  // ─── Self-test service ───
  const workflowCompiler = createFridayWorkflowCompiler({ computeChecksum, idGenerator });
  const agentSelfTestService = createFridayAgentSelfTestService({
    safeParseFridaySkillManifestV2: safeParseFridaySkillManifestV2 as (input: unknown) => { success: boolean; error?: { issues: Array<{ message: string; path: Array<string | number> }> } },
    workflowCompiler,
    readFile: (filePath: string) => fs.promises.readFile(filePath, "utf8"),
    execCommand: async (command: string, cwd?: string) => {
      return new Promise((resolve) => {
        execCb(command, { cwd: cwd ?? workspaceRoot }, (error, stdout, stderr) => {
          const exitCode =
            typeof (error as { code?: number | string } | null)?.code === "number"
              ? (error as { code: number }).code
              : error
                ? 1
                : 0;
          resolve({ exitCode, stdout: stdout ?? "", stderr: stderr ?? "" });
        });
      });
    },
  });
  const agentSelfFixService = createFridayAgentSelfFixService();

  // Resolve the default model/provider for agent runtime
  // This is a best-effort resolution at boot time; individual runs can override.
  const agentDefaultModel = FRIDAY_AGENT_ROUTE_DEFAULT_MODEL;
  const agentDefaultProviderId = "default";

  // ─── Resolve provider identity at boot for system prompt ───
  let agentModelIdentity = "an AI model";
  try {
    const defaultRoute = await providerService.resolveRoute(undefined, undefined, {
      autoValidate: false,
    });
    const providerKind = defaultRoute.provider.kind; // e.g. "anthropic"
    const modelName = defaultRoute.model;            // e.g. "claude-opus-4-5-20251101"
    agentModelIdentity = `${modelName} (provider: ${providerKind})`;
  } catch (err) {
    if (!isExpectedProviderNoRouting(err)) {
      warnHubBootstrapOperationFailureOnce(err);
    }
    // No provider configured yet — use generic identity.
  }
  try {
    const [routing, providers] = await Promise.all([
      providerService.getRoutingConfig(),
      providerService.listProviders(),
    ]);
    const routingWarning = resolveFridayRoutingStabilityWarning({ routing, providers });
    if (routingWarning && providers.length > 0) {
      warnHubBootstrapOnce(`[friday][W-PROVIDER-ROUTING-001] ${routingWarning}`);
      // Auto-configure fallback providers if none are set
      if (
        !canonicalMutatingActionGateEnabled &&
        routing.defaultProviderId &&
        (!routing.fallbackProviderIds || routing.fallbackProviderIds.length === 0)
      ) {
        const validatedAlternatives = providers
          .filter((p) => p.enabled && p.id !== routing.defaultProviderId)
          .slice(0, 3)
          .map((p) => p.id);
        if (validatedAlternatives.length > 0) {
          try {
            await providerService.setRoutingConfig({
              ...routing,
              fallbackProviderIds: validatedAlternatives,
            });
            console.log(`[friday] Auto-configured ${validatedAlternatives.length} fallback provider(s) for routing resilience.`);
          } catch {
            // Non-fatal: fallback auto-config failure should not block startup.
          }
        }
      }
    }
  } catch (err) {
    if (!isExpectedProviderNoRouting(err)) {
      warnHubBootstrapOperationFailureOnce(err);
    }
    // Non-fatal: provider routing diagnostics should not block startup.
  }

  // ── Media Understanding pipeline (Phase 02a) ──
  //
  // Always construct the mediaUnderstanding deps slot for createFridayApiRuntime;
  // disabled state is represented by null fields plus a structured
  // disabledReason so the routes are always registered and return
  // `503 MEDIA_UNDERSTANDING_DISABLED` (never 404) when disabled. We never echo
  // any env value or credential into the disabledReason.
  const mediaUnderstandingDeps: Parameters<typeof createFridayApiRuntime>[0]["mediaUnderstanding"] =
    await (async () => {
      if (process.env.FRIDAY_MEDIA_UNDERSTANDING_ENABLED !== "true") {
        return {
          service: null,
          doctorProvider: null,
          disabledReason: "FRIDAY_MEDIA_UNDERSTANDING_ENABLED is not set to true",
        };
      }
      const parsed = parseFridaySecretInput("env:OPENAI_API_KEY");
      const resolved = await resolveFridaySecretInput(parsed);
      if (!resolved.ok) {
        // Use only the blocker.code (structured non-secret enum); never include
        // blocker.details which can carry the env var name and value shape.
        return {
          service: null,
          doctorProvider: null,
          disabledReason: `media understanding credential resolution failed: ${resolved.blocker.code}`,
        };
      }
      const apiKey = resolved.value;
      const model = process.env.FRIDAY_MEDIA_UNDERSTANDING_MODEL ?? DEFAULT_OPENAI_VISION_MODEL;
      const provider = createFridayOpenAiVisionProvider({ apiKey, model });
      const service = createFridayMediaUnderstandingService({
        providers: [provider],
        // Phase 02a analyze route only accepts http(s):// sourceUrls (the route
        // boundary at parseAnalyzeAttachment rejects other schemes). data:
        // URLs are NOT supported by the production fetchContent — the doctor
        // probe never routes through this closure (it supplies its own inline
        // buffer via the helper in friday-media-doctor.ts).
        fetchContent: async (attachment) => {
          const response = await fetchWithFridayAgentSsrfGuard({
            url: attachment.sourceUrl,
            guard: agentSsrfGuard,
            init: {
              headers: { "User-Agent": "Friday/1.0" },
              signal: AbortSignal.timeout(30_000),
            },
            options: { maxRedirects: 3 },
          });
          if (!response.ok) {
            throw new Error(
              `Failed to fetch attachment ${attachment.id}: HTTP ${response.status}`,
            );
          }
          const arrayBuf = await response.arrayBuffer();
          return Buffer.from(arrayBuf);
        },
      });
      return {
        service,
        doctorProvider: provider,
        disabledReason: null,
      };
    })();

  if (mediaUnderstandingDeps.service === null) {
    console.warn(
      `[friday][W-MEDIA-001] Media understanding disabled: ${mediaUnderstandingDeps.disabledReason}; /v1/media-understanding/* will return 503 MEDIA_UNDERSTANDING_DISABLED`,
    );
  }

  // ── Phase 02b Social Import (partial slice) ──
  // The social-import service exposes the partial first-half of module_01:
  // XHS real-browser extraction + provenance + social-aware planDigest. The
  // route itself drives the canonical mutation gate and the converter import
  // for candidate staging. Autonomy shadow/canary/promote/rollback + verify
  // + learning emit remain operator-driven via existing routes.
  const socialImportService =
    xhsPageInteractions !== undefined && xhsSessionManager !== undefined
      ? createFridaySocialImportService({
          xhsPageInteractions,
          xhsSessionManager,
        })
      : null;
  const socialImportDeps: NonNullable<
    Parameters<typeof createFridayApiRuntime>[0]["socialImport"]
  > = socialImportService
    ? { service: socialImportService, disabledReason: null }
    : {
        service: null,
        disabledReason: "XHS browser deps not initialised in this runtime",
      };
  if (socialImportDeps.service === null) {
    console.warn(
      `[friday][W-SOCIAL-IMPORT-001] Social-import disabled: ${socialImportDeps.disabledReason}; POST /v1/skills/social-import will return 503 SOCIAL_IMPORT_DISABLED`,
    );
  }

  // ── Phase 13.5A Task Workflow Policy ──
  //
  // Construct the additive task-workflow service. The service is always
  // available when the database layer is present; it only writes additive
  // task workflow tables and never mutates /v1/agent/runs state. Routes
  // are always registered; when the service slot is null the handlers
  // return `503 TASK_WORKFLOWS_DISABLED` (never 404).
  //
  // Phase 13.5C live binding: the service receives a bounded CLI backend
  // adapter whose text completion shim resolves the backendId to a
  // minimal FridayProviderCliConfig and delegates to the existing
  // `runFridayCliBackendTextCompletion` primitive. The adapter never
  // copies repo source into prompts, never satisfies a verified claim,
  // and fails closed on CLI unavailability / auth missing / timeout /
  // repair exhaustion; persisted handoffs always carry verified=false.
  const taskWorkflowDeps: NonNullable<
    Parameters<typeof createFridayApiRuntime>[0]["taskWorkflows"]
  > = await (async () => {
    const {
      createFridayTaskWorkflowCliAdapter,
      createFridayTaskWorkflowRepository,
      createFridayTaskWorkflowService,
    } = await import("../task-workflows/index.js");
    const { runFridayCliBackendTextCompletion } = await import(
      "../providers/cli/friday-provider-cli-backend.js"
    );
    const repository = createFridayTaskWorkflowRepository();
    const cliAdapter = createFridayTaskWorkflowCliAdapter({
      cliTextCompletion: async (input) => {
        return runFridayCliBackendTextCompletion({
          cliConfig: { backendId: input.backendId },
          systemPrompt: input.systemPrompt,
          conversation: input.conversation,
          model: input.model,
        });
      },
      nowIso,
    });
    const service = createFridayTaskWorkflowService({
      db: stateRuntime!.sqlite,
      repository,
      idGenerator,
      nowIso,
      cliAdapter,
      // Phase 14.5C: bridge upstream workflow-run evidence persistence health
      // into the task workflow service. The runtime tracks per-run status;
      // verifyClaim and the new closeout gate consult this callback so the
      // task workflow service can refuse a proof claim that references a
      // degraded or unavailable workflow run, without mocking the evidence
      // repository or pretending unknown runs were healthy.
      getWorkflowRunEvidenceStatus: (runId) =>
        workflowRuntime.evidence.getRunEvidenceStatus(runId),
      // Audit C: bridge the runtime's ORTHOGONAL run-level
      // completion-verification truth (a side-effect node lacking
      // deterministic evidence → `proof_pending`). verifyClaim refuses a proof
      // claim backed by a non-verified run for a reason DISTINCT from
      // persistence durability. Wiring it here makes the run-level enforcement
      // live in production (the verifier is fail-closed once wired).
      getWorkflowRunCompletionVerification: (runId) =>
        workflowRuntime.evidence.getRunCompletionVerification(runId),
    });
    return { service, disabledReason: null };
  })();

  // ── Link Understanding pipeline ──
  // Wire the full auto-detect-links service for session message enrichment.
  {
    const { createFridayLinkUnderstandingService, createFridayLinkCacheRepository } = await import("#link-understanding");
    const linkCacheRepo = createFridayLinkCacheRepository();
    const linkService = createFridayLinkUnderstandingService({
      fetchFn: async (url, options) => {
        const response = await fetchWithFridayAgentSsrfGuard({
          url,
          guard: agentSsrfGuard,
          init: {
            headers: { "User-Agent": "Friday/1.0" },
            signal: AbortSignal.timeout(options.timeoutMs),
          },
          options: { maxRedirects: options.maxRedirects },
        });
        return {
          statusCode: response.status,
          contentType: response.headers.get("content-type"),
          body: await readResponseTextWithLimit(response, options.maxResponseSizeBytes),
        };
      },
      cache: linkCacheRepo,
      nowIso,
    });
    // linkService is available for session message enrichment
    void linkService;
  }

  // ── World Model Readiness layer ──
  const worldModelEpisodeExtractor = createFridayEpisodeExtractor({
    db: stateRuntime!.sqlite,
    idGenerator,
    nowIso,
    tsMemoryWritesEnabled: config.allowTestOnlyTsMemoryWrites === true,
  });
  const worldModelStateManager = createFridayWorldStateManager({
    db: stateRuntime!.sqlite,
    idGenerator,
    nowIso,
  });
  const worldModelDecisionEngine = createDefaultFridayDecisionEngine();
  const worldModelPatternExtractor = createFridayPatternExtractor({
    db: stateRuntime!.sqlite,
    tsMemoryWritesEnabled: config.allowTestOnlyTsMemoryWrites === true,
  });

  const workspaceContextEngine = createFridayWorkspaceContextEngine({
    workspaceDir: workspaceRoot,
  });

  const agentContextEngine = {
    ...workspaceContextEngine,
    async afterTurn(input: FridayContextEngineAfterTurnInput) {
      try {
        const session = await hubSessionService.getSession(input.sessionKey).catch(() => null);
        const userId = input.userId
          ?? session?.userId
          ?? (session?.chatKind === "dm" ? session.chatId : undefined);
        if (!userId) {
          console.warn(
            `[friday][world-model] afterTurn skipped: no userId for session ${input.sessionKey}`,
          );
          return;
        }
        const episode = await worldModelEpisodeExtractor.extractFromRun(input.runId, userId);
        if (episode) {
          await worldModelStateManager.updateFromEpisode(userId, episode);
          console.info(
            `[friday][marker] world_model_episode_extracted runId=${input.runId} userId=${userId} steps=${String(episode.steps.length)}`,
          );
          console.info(
            `[friday][marker] world_model_snapshot_saved runId=${input.runId} userId=${userId}`,
          );
        }
        // Pattern extraction — analyze episodes for recurring tool sequences, failures, and temporal patterns
        const patterns = await worldModelPatternExtractor.extractPatterns(userId);
        if (patterns.length > 0) {
          console.info(
            `[friday][marker] world_model_pattern_upserted runId=${input.runId} userId=${userId} count=${String(patterns.length)}`,
          );
        }
        if (reflexService) {
          const events = stateRuntime!.sqlite.withReadConnection((reader) =>
            agentRunEventRepository.list(reader, input.runId));
          const toolEndEvents = events.filter((event) => event.eventName === "agent.run.tool_end");
          const toolSequence = toolEndEvents
            .map((event) => typeof event.payload.toolName === "string" ? event.payload.toolName : undefined)
            .filter((toolName): toolName is string => !!toolName);
          const toolFailures = toolEndEvents
            .filter((event) => event.payload.isError === true)
            .map((event) => ({
              toolName: typeof event.payload.toolName === "string" ? event.payload.toolName : "unknown",
              message: typeof event.payload.summary === "string" ? event.payload.summary : undefined,
              code: typeof event.payload.errorCode === "string" ? event.payload.errorCode : undefined,
            }));
          await reflexService.processRunCompletion({
            userId,
            runId: input.runId,
            sessionKey: input.sessionKey,
            task: input.task,
            outcome: input.status === "completed"
              ? "success"
              : input.status === "failed"
                ? "failure"
                : input.status === "cancelled"
                  ? "cancelled"
                  : "unknown",
            toolSequence,
            toolFailures,
          });
        }
      } catch (err) {
        console.warn("[friday][world-model] afterTurn episode extraction failed:", err instanceof Error ? err.message : String(err));
      }
    },
  };

  // Dynamic system prompt builder — invoked at each executeRun() with the
  // current set of registered tool names, so the prompt is always accurate.
  // Loads Friday runtime user context files (context/AGENTS.md, context/USER.md,
  // context/MEMORY.md, context/BELIEFS.md, context/SOUL.md, .friday/rules/**)
  // fresh on each run so edits take effect immediately.
  const shouldFailClosedForWorkspaceContext = shouldFailClosedForFridayWorkspaceContext;
  const agentSystemPromptBuilder = async (input: {
    userId?: string;
    toolNames: string[];
    nowIso: string;
    timezone: string;
    localDate: string;
    task?: string;
    executionContext?: {
      packId?: string;
    };
    promptProfile?: "standard" | "minimal";
    contextPolicy?: { workspaceContext?: "auto" | "skip" };
    conversationContext?: {
      selectedBlocks?: FridayConversationBlock[];
    };
    toolRouting?: {
      profile: string;
      promptProfile: string;
      workspaceContextPolicy: string;
      selectedToolNames: string[];
      deferredToolNames: string[];
      selectedToolPacks: string[];
      reason: string;
    };
    deferredToolHints?: Array<{ name: string; description: string }>;
  }) => {
    let workspaceContext: string | undefined;
    let workspaceContextSummary:
      | Awaited<ReturnType<typeof loadFridayWorkspaceContext>>["summary"]
      | undefined;
    const skipWorkspaceContext = input.promptProfile === "minimal"
      || input.contextPolicy?.workspaceContext === "skip";
    if (!skipWorkspaceContext) {
      try {
        const ctx = await resolveFridayContextEnginePromptFragment(agentContextEngine, {
          task: input.task,
          conversationContext: input.conversationContext,
        });
        if (ctx.promptFragment) {
          workspaceContext = ctx.promptFragment;
        }
        workspaceContextSummary = ctx.workspaceContext?.summary;
        if (
          workspaceContextSummary?.loadErrors.length
          && shouldFailClosedForWorkspaceContext(input)
        ) {
          throw new FridayDomainError(
            "WORKSPACE_CONTEXT_UNAVAILABLE",
            `Friday user/project rules could not be loaded: ${workspaceContextSummary.loadErrors.map((err) => err.name).join(", ")}`,
            {
              httpStatus: 503,
              details: {
                loadErrors: workspaceContextSummary.loadErrors.map((err) => ({
                  name: err.name,
                  code: err.code,
                  message: err.message,
                })),
              },
            },
          );
        }
        if (workspaceContextSummary?.loadErrors.length) {
          const warningLines = workspaceContextSummary.loadErrors.map((err) =>
            `- ${err.name}${err.code ? ` (${err.code})` : ""}: ${err.message}`
          );
          workspaceContext = [
            workspaceContext ?? "",
            "<workspace-context-warning>",
            "Some Friday user/project rules could not be loaded. Continue only for low-risk chat or status tasks; do not perform mutation, generation, installation, promotion, or execution from this run.",
            ...warningLines,
            "</workspace-context-warning>",
          ].filter((line) => line.length > 0).join("\n");
        }
      } catch (err) {
        if (shouldFailClosedForWorkspaceContext(input)) {
          throw err;
        }
        warnHubBootstrapOperationFailureOnce(err);
        // Non-fatal for low-risk chat/status runs only.
      }
    }

    // ── World model context injection (C4) ──
    // Load recent interactions so the agent has access to learned knowledge.
    if (input.userId && !skipWorkspaceContext) {
      try {
        const recentInteractionsRequested = typeof input.task === "string"
          && /\brecent(?:[-\s])interactions\b/i.test(input.task);
        const recentEpisodes = recentInteractionsRequested
          ? await worldModelStateManager.getRecentEpisodes(input.userId, 5)
          : [];
        if (recentEpisodes.length > 0) {
          const lines = recentEpisodes.map(
            (ep) => `- ${ep.taskIntent} → ${ep.outcome}`,
          );
          const worldFragment =
            "\n\n<recent-interactions>\n" +
            lines.join("\n") +
            "\n</recent-interactions>";
          workspaceContext = (workspaceContext ?? "") + worldFragment;
        }
      } catch (err) {
        warnHubBootstrapOperationFailureOnce(err);
        // Non-fatal: world state loading failure should not block agent runs.
      }

      // ── Learned patterns injection ──
      // Load patterns discovered from past episodes so the agent can leverage them.
      try {
        const patterns = await worldModelPatternExtractor.extractPatterns(input.userId, 50);
        if (patterns.length > 0) {
          const demotionFacts = stateRuntime.sqlite.withReadConnection((db) =>
            db.prepare(
              `SELECT key, value_json
               FROM preference_facts
               WHERE user_id = ?
                 AND key LIKE 'pattern_demotion:%'
               ORDER BY updated_at DESC
               LIMIT 200`,
            ).all(input.userId) as Array<{ key: string; value_json: string }>,
          );
          const effectivePatterns = patterns
            .map((pattern) => {
              const demotion = demotionFacts.find((fact) => fact.key === `pattern_demotion:${pattern.id}`);
              if (!demotion) {
                return { pattern, factor: 1 };
              }
              const value = safeJsonParse<Record<string, unknown>>(demotion.value_json);
              const factor =
                typeof value?.factor === "number" && Number.isFinite(value.factor)
                  ? Math.max(0, Math.min(1, value.factor))
                  : 0.5;
              return { pattern, factor };
            })
            .filter((entry) => entry.factor > 0)
            .sort((left, right) =>
              (right.pattern.confidence * right.factor) - (left.pattern.confidence * left.factor)
            );
          const patternLines = effectivePatterns.map(
            ({ pattern, factor }) => `- [${pattern.kind}] ${pattern.description} (confidence: ${((pattern.confidence * factor) * 100).toFixed(0)}%)`,
          );
          if (patternLines.length > 0) {
            const patternFragment =
            "\n\n<learned-patterns>\n" +
            patternLines.join("\n") +
            "\n</learned-patterns>";
            workspaceContext = (workspaceContext ?? "") + patternFragment;
          }
        }
      } catch (err) {
        warnHubBootstrapOperationFailureOnce(err);
        // Non-fatal: pattern loading failure should not block agent runs.
      }

      try {
        const packId = input.executionContext?.packId?.trim();
        if (packId && packId.startsWith("custom-")) {
          const customPackContext = stateRuntime.sqlite.withReadConnection((db) => {
            const persistedPackPreference = uixUserPreferenceRepository
              .listByPrincipal(db, {
                principalId: input.userId!,
                category: "uix",
              })
              .find((preference) => preference.key === "packs.customInputs");
            if (!persistedPackPreference) {
              return null;
            }

            const resolvedPack = findFridayCustomPackById(persistedPackPreference.value, packId);
            if (!resolvedPack) {
              return null;
            }

            const recentRuns = agentRunRepo
              .list(db, { limit: 120 })
              .filter((run) =>
                run.metadata?.packContext?.packId === packId
                && run.metadata?.apiRequest?.principalId === input.userId,
              )
              .slice(0, 3);

            return {
              resolvedPack,
              recentRuns,
            };
          });

          if (customPackContext) {
            const customPackFragment = buildFridayCustomPackPromptFragment({
              packId,
              pack: customPackContext.resolvedPack,
              recentRuns: customPackContext.recentRuns,
            });
            workspaceContext = (workspaceContext ?? "") + `\n\n${customPackFragment}`;
          }
        }
      } catch (err) {
        warnHubBootstrapOperationFailureOnce(err);
        // Non-fatal: custom-pack context loading failure should not block agent runs.
      }
    }
    const starterSkills = input.promptProfile === "minimal"
      ? []
      : listInstalledStarterSkills().slice(0, 8);
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: input.toolNames,
      modelIdentity: agentModelIdentity,
      version: FRIDAY_VERSION,
      workspaceContext,
      starterSkills,
      enforceStarterSkillRouting: starterSkillRoutingEnforced,
      subagentForkModeEnabled,
      promptProfile: input.promptProfile,
      deferredToolHints: input.deferredToolHints,
      currentTime: {
        nowIso: input.nowIso,
        timezone: input.timezone,
        localDate: input.localDate,
      },
      runtimeCapabilities: {
        messagingEnabled: input.toolNames.includes("message")
          && typeof channelRegistry !== "undefined"
          && channelRegistry.list().some((kind) => channelRegistry.status(kind) === "connected"),
        messagingKinds: typeof channelRegistry !== "undefined"
          ? channelRegistry.list().filter((kind) => channelRegistry.status(kind) === "connected")
          : [],
        mcpEnabled: input.toolNames.includes("mcp")
          && listAgentAvailableMcpServers().length > 0,
        mcpServerCount: listAgentAvailableMcpServers().length,
        cronEnabled: input.toolNames.includes("cron") && !!jobScheduler && !!schedulerRepo,
        subagentsEnabled: input.toolNames.includes("spawn_subagent"),
        selfLearningEnabled: input.toolNames.includes("feedback"),
      },
    });
    const starterSkillChars = starterSkills.reduce((sum, skill) =>
      sum
      + skill.skillId.length
      + skill.purpose.length
      + skill.triggerPhrases.join(", ").length
      + (skill.tags ?? []).join(", ").length,
    0);
    const estimateContextInputTokens = (estimatedChars: number) =>
      Math.max(0, Math.ceil(Math.max(0, estimatedChars) / 4));
    const mcpStates = mcpAdapter?.listServerStates() ?? [];
    const rawComponents = [
      workspaceContextSummary && (
        workspaceContextSummary.promptChars > 0
        || workspaceContextSummary.loadErrors.length > 0
      )
        ? {
            kind: "workspace_context" as const,
            estimatedChars: workspaceContextSummary.promptChars,
            count: workspaceContextSummary.selectedFileCount,
            metadata: {
              pathRuleCount: workspaceContextSummary.selectedPathRuleCount,
              loadErrorCount: workspaceContextSummary.loadErrors.length,
              candidatePaths: workspaceContextSummary.candidatePaths,
              selectedSourceNames: workspaceContextSummary.selectedSourceNames,
              sourceSummaries: workspaceContextSummary.sourceSummaries,
              loadErrors: workspaceContextSummary.loadErrors.map((err) => ({
                name: err.name,
                code: err.code,
                message: err.message,
              })),
            },
          }
        : null,
      starterSkills.length > 0
        ? {
            kind: "starter_skills" as const,
            estimatedChars: starterSkillChars,
            count: starterSkills.length,
          }
        : null,
      mcpStates.length > 0
        ? {
            kind: "mcp" as const,
            estimatedChars: JSON.stringify(mcpStates.map((state) => ({
              serverId: state.serverId,
              state: state.state,
              toolCount: state.toolCount,
            }))).length,
            count: mcpStates.length,
            metadata: {
              states: mcpStates.reduce<Record<string, number>>((acc, state) => {
                acc[state.state] = (acc[state.state] ?? 0) + 1;
                return acc;
              }, {}),
            },
          }
        : null,
      input.toolNames.includes("spawn_subagent")
        ? {
            kind: "subagents" as const,
            estimatedChars: 96,
            count: 1,
            metadata: { enabled: true },
          }
        : null,
      input.toolRouting
        ? {
            kind: "tool_routing" as const,
            estimatedChars: input.toolNames.join(",").length,
            count: input.toolNames.length,
            metadata: {
              profile: input.toolRouting.profile,
              selectedToolPacks: input.toolRouting.selectedToolPacks,
              deferredToolCount: input.toolRouting.deferredToolNames.length,
              workspaceContextPolicy: input.toolRouting.workspaceContextPolicy,
              reason: input.toolRouting.reason,
            },
          }
        : null,
    ].filter((component): component is NonNullable<typeof component> => component !== null);
    const components = rawComponents.map((component) => ({
      ...component,
      estimatedInputTokens: estimateContextInputTokens(component.estimatedChars),
    }));
    return {
      prompt,
      contextCostSummary: {
        totalEstimatedChars: components.reduce((sum, component) => sum + component.estimatedChars, 0),
        totalEstimatedInputTokens: components.reduce((sum, component) => sum + component.estimatedInputTokens, 0),
        components,
      },
    };
  };

  // ─── Self-learning runtime (created early to avoid race with agentRuntime) ───
  const hubAutoFixSupport = createFridayHubAutoFixExecutionSupport({
    registry,
    memoryState,
    configManager,
    providerService,
    workflowRuntime,
    skillGenerator,
    nowIso,
    // Durable persistence of self-heal skill-status is provided by createDurableMemoryState
    // (audit E3, PR #406) via its updateSkillStatus wrapper — no second persist path is wired here.
  });

  const selfLearningRuntime = createFridaySelfLearningRuntime({
    db: stateRuntime.sqlite,
    idGenerator,
    nowIso,
    stepExecutors: hubAutoFixSupport.stepExecutors,
    stepVerifiers: hubAutoFixSupport.stepVerifiers,
    // Lets the auto-fix planner capture the prior skill status at plan-build time for the
    // regenerate_skill rollback (restore-not-enable).
    getSkillLifecycleStatus: getPersistedSkillLifecycleStatus,
    // TS Runtime Retirement (G1): forwards the same test-oracle flag the autofix
    // ROUTE uses (config.allowTestOnlyAutoFixExecution) into the execution
    // service's METHOD-level guard, so the live non-route self-healing path
    // (reportStructuredFailure → agent-loop executeRun → execute()) fails closed
    // in default/live runtime and stays exercised under the test/mock/real-env
    // harnesses that opt in.
    allowTestOnlyAutoFixExecution: config.allowTestOnlyAutoFixExecution,
  });

  // P1-01: Assign immediately so learningContextBuilder and communicationPromptBuilder
  // always have access to learned preferences — no startup window gap.
  const _learningContextRef = selfLearningRuntime.context;
  const uixGuidedContextRepository = createFridayUixGuidedContextRepository();
  const buildMergedPreferenceContext = (input: { userId: string; nowIso: string }) => {
    const learned = _learningContextRef?.buildContext(input) ?? { preferences: {} };
    const explicitPreferences = stateRuntime.sqlite.withReadConnection((db) =>
      uixUserPreferenceRepository.listByPrincipal(db, { principalId: input.userId }));
    const preferences: Record<string, unknown> = { ...learned.preferences };
    for (const preference of explicitPreferences) {
      preferences[`explicit:${preference.category}/${preference.key}`] = preference.value;
      if (preference.category === "reflex") {
        preferences[`reflex:${preference.key}`] = preference.value;
      }
    }
    return { ...learned, preferences };
  };
  const buildReflexPreferencePromptFragment = (userId: string): string | null => {
    const preferences = stateRuntime.sqlite.withReadConnection((db) =>
      uixUserPreferenceRepository.listByPrincipal(db, {
        principalId: userId,
        category: "reflex",
      }));
    if (preferences.length === 0) return null;
    const fragments: string[] = [];
    const constitutionFragment = buildFridayUserConstitutionPreferencePromptFragment(preferences);
    if (constitutionFragment) {
      fragments.push(constitutionFragment);
    }
    const lines = preferences
      .slice(0, 32)
      .map((preference) => `- ${preference.key}: ${JSON.stringify(preference.value)}`);
    fragments.push(`Friday Reflex preferences:\n${lines.join("\n")}`);
    return fragments.join("\n\n");
  };
  const buildWorkflowGeneratorPromptContext = async (input: {
    task: string;
    userId?: string;
    channel?: string;
  }): Promise<string | null> => {
    const fragments: string[] = [];
    const userRulesFragment = await buildFridayUserRulesPromptContext({
      task: input.task,
      surface: "workflow_generator",
    });
    if (userRulesFragment) {
      fragments.push(userRulesFragment);
    }
    const userId = input.userId;
    if (userId) {
      const explicitPreferences = stateRuntime.sqlite.withReadConnection((db) =>
        uixUserPreferenceRepository.listByPrincipal(db, {
          principalId: userId,
          category: "communication",
        }));
      const learnedPreferences = _learningContextRef?.buildContext({
        userId,
        nowIso: nowIso(),
      }).preferences ?? {};
      const persona = resolveFridayCommunicationPersona({
        explicitPreferences,
        learnedPreferences,
      });
      const personaFragment = buildFridayCommunicationPromptFragment(persona);
      if (personaFragment.trim().length > 0) {
        fragments.push(personaFragment.trim());
      }
      const reflexFragment = buildReflexPreferencePromptFragment(userId);
      if (reflexFragment) {
        fragments.push(reflexFragment);
      }
    }
    return fragments.length > 0 ? fragments.join("\n\n") : null;
  };

  workflowGenerator = createFridayWorkflowGeneratorService({
    db: stateRuntime!.sqlite,
    providerService,
    workflowCrud: workflowRuntime.crud,
    skillRegistry: registry,
    getSkillLifecycleStatus: getPersistedSkillLifecycleStatus,
    idGenerator,
    nowIso,
    computeChecksum,
    userRulesContextProvider: buildWorkflowGeneratorPromptContext,
    // TS Runtime Retirement (§1 method-level guard): production leaves this
    // unset (config flag undefined) so startSession/generateDraft/approveAndSave
    // are fail-closed for the agent tool, UIX assistant, and reflex candidate
    // paths, not just the HTTP routes. Test-oracle hub configs set it true to
    // exercise legacy generation.
    allowTestOnlyWorkflowGeneratorExecution: config.allowTestOnlyWorkflowGeneratorExecution,
  });

  // ─── Tool approval gates (GAP 2) ───
  // Shared promise map for tool-level approval flow.
  // The agent runtime awaits the resolver; the API routes resolve/reject the promise.
  const toolApprovalGates = new Map<string, Map<string, {
    resolve: (v: {
      approved: boolean;
      reason?: string;
      decidedByPrincipalId?: string;
      decidedByPrincipalType?: string;
      approvalSurface?: string;
    }) => void;
    prompt: {
      grantId: string;
      expiresAt: string;
      toolName: string;
      toolCallId: string;
      reason: string;
	      principalId?: string;
	      scopes?: string[];
	      sessionKey?: string;
	      surface?: string;
	      canonicalActionDigest?: string;
	      canonicalAction?: string;
	      canonicalRisk?: string;
	      canonicalMutating?: boolean;
	      canonicalResourceType?: string;
	      canonicalResourceId?: string;
	    };
	  }>>();

  type FridayChannelApprovalRoute = {
    channelKind: string;
    chatId: string;
    chatType: "direct" | "group";
    senderId: string;
    messageId: string;
    sessionKey: string;
  };
  type FridayChannelToolApprovalCommand = {
    approved: boolean;
    shortId?: string;
    reason?: string;
  };
  type FridayChannelReflexCandidateCommand = {
    action: "test" | "approve" | "reject" | "dismiss";
    candidateId: string;
    reason?: string;
  };
  type FridayPendingChannelToolApproval = {
    runId: string;
    sessionKey: string;
    grantId: string;
    toolCallId: string;
    toolName: string;
    shortId: string;
    reason: string;
	    expiresAt: string;
	    params: Record<string, unknown>;
	    route: FridayChannelApprovalRoute;
	    canonicalActionDigest?: string;
	    canonicalAction?: string;
	    canonicalRisk?: string;
	  };
  type FridayRestartedChannelToolApproval = Omit<FridayPendingChannelToolApproval, "params" | "route">;
  type FridayAgentRunEventSqlRow = {
    run_id: string;
    seq: number;
    event_name: string;
    payload_json: string;
    emitted_at: string;
  };
  const channelApprovalRoutesBySession = new Map<string, FridayChannelApprovalRoute>();
  const channelApprovalRoutesByRun = new Map<string, FridayChannelApprovalRoute>();
  const channelApprovalRoutesBySessionPrincipal = new Map<string, FridayChannelApprovalRoute>();
  const channelToolApprovalSessions = new Map<string, FridayPendingChannelToolApproval>();
  const sensitiveApprovalParamKeyPattern =
    /(api[-_ ]?key|authorization|cookie|credential|password|secret|token)/i;

  const normalizeChannelToolApprovalShortId = (shortId: string | undefined): string | undefined => {
    const normalized = shortId?.replace(/[^a-z0-9]/gi, "").toUpperCase();
    return normalized && normalized.length > 0 ? normalized : undefined;
  };

  const channelToolApprovalKey = (sessionKey: string, shortId: string): string =>
    `${sessionKey}:${shortId.toLowerCase()}`;

  const channelApprovalSessionPrincipalKey = (sessionKey: string, principalId: string): string =>
    `${sessionKey}:${principalId}`;

  const parseChannelToolApprovalCommand = (text: string): FridayChannelToolApprovalCommand | null => {
    const trimmed = text.trim();
    const approveMatch = /^(?:approve|approved|yes|y|批准|同意|确认|通过)(?:\s+([a-z0-9_-]{2,32}))?\s*$/i.exec(trimmed);
    if (approveMatch) {
      const shortId = normalizeChannelToolApprovalShortId(approveMatch[1]);
      return {
        approved: true,
        ...(shortId ? { shortId } : {}),
      };
    }
    const rejectMatch = /^(?:reject|rejected|deny|denied|no|n|cancel|stop|拒绝|不同意|驳回|取消|停止)(?:\s+([a-z0-9_-]{2,32}))?(?:\s+(.+))?\s*$/i.exec(trimmed);
    if (!rejectMatch) return null;
    const shortId = normalizeChannelToolApprovalShortId(rejectMatch[1]);
    const reason = rejectMatch[2]?.trim();
    return {
      approved: false,
      ...(shortId ? { shortId } : {}),
      ...(reason ? { reason } : {}),
    };
  };

  const normalizeReflexCandidateAction = (
    raw: string | undefined,
  ): FridayChannelReflexCandidateCommand["action"] | null => {
    const action = raw?.trim().toLowerCase();
    if (!action) return null;
    if (["test", "测试", "自测"].includes(action)) return "test";
    if (["approve", "approved", "批准", "同意", "通过"].includes(action)) return "approve";
    if (["reject", "rejected", "deny", "denied", "拒绝", "驳回"].includes(action)) return "reject";
    if (["dismiss", "ignore", "忽略", "跳过", "先不处理"].includes(action)) return "dismiss";
    return null;
  };

  const parseReflexCandidateDecisionCommand = (text: string): FridayChannelReflexCandidateCommand | null => {
    const trimmed = text.trim();
    const actionFirst =
      /^(test|测试|自测|approve|approved|批准|同意|通过|reject|rejected|deny|denied|拒绝|驳回|dismiss|ignore|忽略|跳过|先不处理)\s+(?:reflex|candidate|候选|候选项)\s+([a-z0-9_-]{3,128})(?:\s+(.+))?$/iu.exec(trimmed);
    if (actionFirst) {
      const action = normalizeReflexCandidateAction(actionFirst[1]);
      if (!action) return null;
      return {
        action,
        candidateId: actionFirst[2],
        ...(actionFirst[3]?.trim() ? { reason: actionFirst[3].trim() } : {}),
      };
    }
    const prefixFirst =
      /^(?:reflex|candidate|候选|候选项)\s+(test|测试|自测|approve|approved|批准|同意|通过|reject|rejected|deny|denied|拒绝|驳回|dismiss|ignore|忽略|跳过|先不处理)\s+([a-z0-9_-]{3,128})(?:\s+(.+))?$/iu.exec(trimmed);
    if (!prefixFirst) return null;
    const action = normalizeReflexCandidateAction(prefixFirst[1]);
    if (!action) return null;
    return {
      action,
      candidateId: prefixFirst[2],
      ...(prefixFirst[3]?.trim() ? { reason: prefixFirst[3].trim() } : {}),
    };
  };

  const applyChannelReflexExplicitPreferences = (input: {
    userId: string;
    text: string;
  }): { applied: number; pendingConfirmation: number } => {
    if (!reflexService) return { applied: 0, pendingConfirmation: 0 };
    const writes = parseFridayReflexExplicitPreferenceMessage(input.text);
    let applied = 0;
    let pendingConfirmation = 0;
    for (const write of writes) {
      const result = reflexService.requestPreferenceUpdate({
        userId: input.userId,
        category: write.category,
        key: write.key,
        value: write.value,
        sourceSurface: "channel",
      });
      if (result.requiresConfirmation) {
        pendingConfirmation += 1;
      } else {
        applied += 1;
      }
    }
    return { applied, pendingConfirmation };
  };

  const listPendingChannelToolApprovalsForSession = (
    sessionKey: string,
  ): FridayPendingChannelToolApproval[] =>
    [...channelToolApprovalSessions.values()].filter((pending) => pending.sessionKey === sessionKey);

  const listRestartedChannelToolApprovalsForSession = (
    sessionKey: string,
  ): FridayRestartedChannelToolApproval[] => {
    const decisionEventNames = new Set([
      "agent.run.capability_grant_issued",
      "agent.run.capability_grant_denied",
      "agent.run.capability_grant_used",
    ]);
    const pendingByKey = new Map<string, FridayRestartedChannelToolApproval>();
    try {
      const rows = stateRuntime!.sqlite.withReadConnection((db) =>
        db.prepare(
          `SELECT run_id, seq, event_name, payload_json, emitted_at
             FROM friday_agent_run_events
            WHERE event_name IN (
              'agent.run.awaiting_tool_approval',
              'agent.run.capability_grant_issued',
              'agent.run.capability_grant_denied',
              'agent.run.capability_grant_used'
            )
              AND json_extract(payload_json, '$.sessionKey') = ?
            ORDER BY emitted_at ASC, seq ASC
            LIMIT 1000`,
        ).all(sessionKey) as FridayAgentRunEventSqlRow[],
      );
      for (const row of rows) {
        const payload = safeJsonParse<Record<string, unknown>>(row.payload_json) ?? {};
        const runId = typeof payload.runId === "string" ? payload.runId : row.run_id;
        const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
        if (!toolCallId) continue;
        const key = `${runId}:${toolCallId}`;
        if (decisionEventNames.has(row.event_name)) {
          pendingByKey.delete(key);
          continue;
        }
        if (
          row.event_name !== "agent.run.awaiting_tool_approval"
          || payload.surface !== "channel"
          || payload.sessionKey !== sessionKey
        ) {
          continue;
        }
        const grantId = typeof payload.grantId === "string" ? payload.grantId : undefined;
        const toolName = typeof payload.toolName === "string" ? payload.toolName : undefined;
        const reason = typeof payload.reason === "string" ? payload.reason : undefined;
        const expiresAt = typeof payload.expiresAt === "string" ? payload.expiresAt : undefined;
        if (!grantId || !toolName || !reason || !expiresAt) continue;
        pendingByKey.set(key, {
          runId,
          sessionKey,
          grantId,
          toolCallId,
          toolName,
          shortId: createFridayChannelToolApprovalShortId(runId, toolCallId),
          reason,
          expiresAt,
          ...(typeof payload.actionDigest === "string" ? { canonicalActionDigest: payload.actionDigest } : {}),
          ...(typeof payload.canonicalAction === "string" ? { canonicalAction: payload.canonicalAction } : {}),
          ...(typeof payload.riskLevel === "string" ? { canonicalRisk: payload.riskLevel } : {}),
        });
      }
    } catch (err) {
      warnHubBootstrapOnce(`[friday] channel-tool-approval-restart-scan: ${err instanceof Error ? err.message : String(err)}`);
    }
    return [...pendingByKey.values()];
  };

  const deleteChannelToolApprovalSessionsForRun = (runId: string, toolCallId?: string): void => {
    for (const [key, pending] of channelToolApprovalSessions) {
      if (pending.runId === runId && (!toolCallId || pending.toolCallId === toolCallId)) {
        channelToolApprovalSessions.delete(key);
      }
    }
  };

  const stringifyChannelToolApprovalParam = (paramName: string, value: unknown): string => {
    if (sensitiveApprovalParamKeyPattern.test(paramName)) return "[redacted]";
    try {
      const rawSerialized = typeof value === "string"
        ? value
        : JSON.stringify(value, (key, nestedValue) => (
          sensitiveApprovalParamKeyPattern.test(key) ? "[redacted]" : nestedValue
        ));
      const serialized = rawSerialized ?? String(value);
      return serialized.length > 240 ? `${serialized.slice(0, 240)}...` : serialized;
    } catch {
      const fallback = String(value);
      return fallback.length > 240 ? `${fallback.slice(0, 240)}...` : fallback;
    }
  };

  const buildChannelToolApprovalParamsPreview = (params: Record<string, unknown>): string | undefined => {
    const entries = Object.entries(params);
    if (entries.length === 0) return undefined;
    const preview = entries
      .slice(0, 5)
      .map(([key, value]) => `${key}: ${stringifyChannelToolApprovalParam(key, value)}`);
    if (entries.length > preview.length) {
      preview.push(`... ${String(entries.length - preview.length)} more parameter(s)`);
    }
    return preview.join("\n");
  };

  const buildChannelToolApprovalPrompt = (pending: FridayPendingChannelToolApproval): string => {
    const paramsPreview = buildChannelToolApprovalParamsPreview(pending.params);
    return [
	      `需要确认敏感操作 ${pending.shortId}`,
	      `工具: ${pending.toolName}`,
	      pending.canonicalAction ? `动作: ${pending.canonicalAction}` : undefined,
	      pending.canonicalRisk ? `风险: ${pending.canonicalRisk}` : undefined,
	      `原因: ${pending.reason}`,
	      paramsPreview ? `参数:\n${paramsPreview}` : undefined,
      `回复「批准 ${pending.shortId}」继续，或「拒绝 ${pending.shortId}」停止。`,
      `过期时间: ${pending.expiresAt}`,
    ].filter((line): line is string => typeof line === "string" && line.length > 0).join("\n");
  };

	  const notifyChannelToolApprovalRequest = (prompt: {
	    runId: string;
	    sessionKey?: string;
	    principalId?: string;
	    grantId: string;
    expiresAt: string;
    toolName: string;
    toolCallId: string;
	    params: Record<string, unknown>;
	    reason: string;
	    surface?: string;
	    canonicalActionDigest?: string;
	    canonicalAction?: string;
	    canonicalRisk?: string;
	  }): void => {
    if (prompt.surface !== "channel" || !prompt.sessionKey) return;
    const route = channelApprovalRoutesByRun.get(prompt.runId)
      ?? (prompt.principalId
        ? channelApprovalRoutesBySessionPrincipal.get(
            channelApprovalSessionPrincipalKey(prompt.sessionKey, prompt.principalId),
          )
        : undefined);
    if (!route) return;
    const shortId = createFridayChannelToolApprovalShortId(prompt.runId, prompt.toolCallId);
    const approvalSessionKey = route.sessionKey;
    const pending: FridayPendingChannelToolApproval = {
      runId: prompt.runId,
      sessionKey: approvalSessionKey,
      grantId: prompt.grantId,
      toolCallId: prompt.toolCallId,
      toolName: prompt.toolName,
      shortId,
      reason: prompt.reason,
	      expiresAt: prompt.expiresAt,
	      params: prompt.params,
	      route,
	      canonicalActionDigest: prompt.canonicalActionDigest,
	      canonicalAction: prompt.canonicalAction,
	      canonicalRisk: prompt.canonicalRisk,
	    };
    channelToolApprovalSessions.set(channelToolApprovalKey(approvalSessionKey, shortId), pending);
    const paramsPreview = buildChannelToolApprovalParamsPreview(pending.params);
    channelRegistry.send(route.channelKind, {
      chatId: route.chatId,
      text: buildChannelToolApprovalPrompt(pending),
      approval: {
        shortId: pending.shortId,
        toolName: pending.toolName,
        reason: pending.reason,
	        expiresAt: pending.expiresAt,
	        chatType: pending.route.chatType,
	        ...(pending.canonicalActionDigest ? { actionDigest: pending.canonicalActionDigest } : {}),
	        ...(pending.canonicalAction ? { canonicalAction: pending.canonicalAction } : {}),
	        ...(pending.canonicalRisk ? { canonicalRisk: pending.canonicalRisk } : {}),
	        ...(paramsPreview ? { paramsPreview } : {}),
	      },
      replyTo: route.messageId,
    }).catch((err) => {
      warnHubBootstrapOnce(`[friday] channel-tool-approval-notify: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  const appendAgentRunEventOutsideRuntime = (
    runId: string,
    eventName: "agent.run.capability_grant_issued" | "agent.run.capability_grant_denied",
    payload: Record<string, unknown>,
  ): void => {
    const emittedAt = nowIso();
    try {
      const seq = stateRuntime.sqlite.withReadConnection((db) =>
        (agentRunEventRepository.list(db, runId).at(-1)?.seq ?? 0) + 1,
      );
      stateRuntime.sqlite.withWriteTransaction((db) => {
        agentRunEventRepository.append(db, {
          eventId: idGenerator(),
          runId,
          seq,
          eventName,
          payload,
          emittedAt,
          createdAt: emittedAt,
        });
      });
    } catch (err) {
      warnHubBootstrapOperationFailureOnce(err);
    }
    agentEventEmitter.emit(eventName as never, payload as never);
  };

  const appendCapabilityGrantAudit = (input: {
    runId: string;
    grantId: string;
    toolCallId: string;
    toolName: string;
    decision: "issued" | "denied";
    reason: string;
    denialReason?: string;
    principalId?: string;
    approvedByPrincipalId?: string;
    approvedByPrincipalType?: string;
    approvalSurface?: string;
	    scopes?: string[];
	    sessionKey?: string;
	    surface?: string;
	    canonicalActionDigest?: string;
	    canonicalAction?: string;
	    canonicalRisk?: string;
	    canonicalMutating?: boolean;
	    canonicalResourceType?: string;
	    canonicalResourceId?: string;
	    expiresAt?: string;
	  }): void => {
    appendFridayAuditLog(auditLogPath, {
      id: idGenerator(),
      ts: nowIso(),
      actorType: input.approvedByPrincipalId ? "user" : input.principalId ? "user" : "service",
      ...(input.approvedByPrincipalId
        ? { actorId: input.approvedByPrincipalId }
        : input.principalId
          ? { actorId: input.principalId }
          : {}),
      action: input.decision === "issued"
        ? "agent.capability_grant.issue"
        : "agent.capability_grant.deny",
      resourceType: "agent-capability-grant",
      resourceId: input.grantId,
      result: input.decision === "issued" ? "success" : "denied",
      ...(input.decision === "denied" ? { errorCode: "CAPABILITY_GRANT_DENIED" } : {}),
      ...(input.decision === "denied" && input.denialReason
        ? { errorMessage: input.denialReason }
        : {}),
      caller: "hub.tool-approval",
      details: {
        runId: input.runId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
	        approvalReason: input.reason,
	        denialReason: input.denialReason,
	        runPrincipalId: input.principalId,
	        approvedByPrincipalId: input.approvedByPrincipalId,
	        approvedByPrincipalType: input.approvedByPrincipalType,
	        approvalSurface: input.approvalSurface,
	        expiresAt: input.expiresAt,
	        sessionKey: input.sessionKey,
	        surface: input.surface,
	        scopes: input.scopes,
	        canonicalActionDigest: input.canonicalActionDigest,
	        canonicalAction: input.canonicalAction,
	        canonicalRisk: input.canonicalRisk,
	        canonicalMutating: input.canonicalMutating,
	        canonicalResourceType: input.canonicalResourceType,
	        canonicalResourceId: input.canonicalResourceId,
	      },
    }).catch((err: unknown) => warnHubBootstrapOnce(`[friday] audit-append: ${err instanceof Error ? err.message : String(err)}`));
  };

  const toolApprovalResolver = async (prompt: {
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
	    canonicalRisk?: string;
	    canonicalMutating?: boolean;
	    canonicalResourceType?: string;
	    canonicalResourceId?: string;
	  }): Promise<{
    approved: boolean;
    reason?: string;
    decidedByPrincipalId?: string;
    decidedByPrincipalType?: string;
    approvalSurface?: string;
  }> => {
    let runMap = toolApprovalGates.get(prompt.runId);
    if (!runMap) {
      runMap = new Map();
      toolApprovalGates.set(prompt.runId, runMap);
    }
    return new Promise<{
      approved: boolean;
      reason?: string;
      decidedByPrincipalId?: string;
      decidedByPrincipalType?: string;
      approvalSurface?: string;
    }>((resolve) => {
      runMap!.set(prompt.toolCallId, {
        resolve,
        prompt: {
          grantId: prompt.grantId,
          expiresAt: prompt.expiresAt,
          toolName: prompt.toolName,
          toolCallId: prompt.toolCallId,
          reason: prompt.reason,
          ...(prompt.principalId ? { principalId: prompt.principalId } : {}),
	          ...(prompt.scopes?.length ? { scopes: prompt.scopes } : {}),
	          ...(prompt.sessionKey ? { sessionKey: prompt.sessionKey } : {}),
	          ...(prompt.surface ? { surface: prompt.surface } : {}),
	          ...(prompt.canonicalActionDigest ? { canonicalActionDigest: prompt.canonicalActionDigest } : {}),
	          ...(prompt.canonicalAction ? { canonicalAction: prompt.canonicalAction } : {}),
	          ...(prompt.canonicalRisk ? { canonicalRisk: prompt.canonicalRisk } : {}),
	          ...(prompt.canonicalMutating !== undefined ? { canonicalMutating: prompt.canonicalMutating } : {}),
	          ...(prompt.canonicalResourceType ? { canonicalResourceType: prompt.canonicalResourceType } : {}),
	          ...(prompt.canonicalResourceId ? { canonicalResourceId: prompt.canonicalResourceId } : {}),
	        },
	      });
      notifyChannelToolApprovalRequest(prompt);
    });
  };

  const resolveToolApproval = (
    runId: string,
    toolCallId: string,
    approved: boolean,
    options: {
      reason?: string;
      approverPrincipalId: string;
      approverPrincipalType?: string;
      approvalSurface?: string;
    },
  ): { resolved: boolean; grantId?: string; decision?: "approved" | "rejected"; reason?: string } => {
    const runMap = toolApprovalGates.get(runId);
    if (!runMap) return { resolved: false };
    const gate = runMap.get(toolCallId);
    if (!gate) return { resolved: false };
    const reason = options.reason;
    const grantPayloadBase = {
      runId,
      grantId: gate.prompt.grantId,
      toolCallId,
      toolName: gate.prompt.toolName,
      reason: gate.prompt.reason,
      expiresAt: gate.prompt.expiresAt,
      approvedByPrincipalId: options.approverPrincipalId,
      ...(options.approverPrincipalType ? { approvedByPrincipalType: options.approverPrincipalType } : {}),
      ...(options.approvalSurface ? { approvalSurface: options.approvalSurface } : {}),
      ...(gate.prompt.principalId ? { principalId: gate.prompt.principalId } : {}),
      ...(gate.prompt.scopes?.length ? { scopes: gate.prompt.scopes } : {}),
      ...(gate.prompt.sessionKey ? { sessionKey: gate.prompt.sessionKey } : {}),
      ...(gate.prompt.surface ? { surface: gate.prompt.surface } : {}),
      ...(gate.prompt.canonicalActionDigest ? { canonicalActionDigest: gate.prompt.canonicalActionDigest } : {}),
      ...(gate.prompt.canonicalAction ? { canonicalAction: gate.prompt.canonicalAction } : {}),
      ...(gate.prompt.canonicalRisk ? { canonicalRisk: gate.prompt.canonicalRisk } : {}),
      ...(gate.prompt.canonicalMutating !== undefined ? { canonicalMutating: gate.prompt.canonicalMutating } : {}),
      ...(gate.prompt.canonicalResourceType ? { canonicalResourceType: gate.prompt.canonicalResourceType } : {}),
      ...(gate.prompt.canonicalResourceId ? { canonicalResourceId: gate.prompt.canonicalResourceId } : {}),
    };
    const expiryDecision = evaluateFridayChannelApprovalExpiry({
      expiresAt: gate.prompt.expiresAt,
      nowIso: nowIso(),
    });
    if (expiryDecision.expired) {
      const denialReason = expiryDecision.reason;
      appendAgentRunEventOutsideRuntime(runId, "agent.run.capability_grant_denied", {
        ...grantPayloadBase,
        denialReason,
      });
      appendCapabilityGrantAudit({
        ...grantPayloadBase,
        decision: "denied",
        denialReason,
      });
      gate.resolve({
        approved: false,
        reason: denialReason,
        decidedByPrincipalId: options.approverPrincipalId,
        ...(options.approverPrincipalType ? { decidedByPrincipalType: options.approverPrincipalType } : {}),
        ...(options.approvalSurface ? { approvalSurface: options.approvalSurface } : {}),
      });
      runMap.delete(toolCallId);
      deleteChannelToolApprovalSessionsForRun(runId, toolCallId);
      if (runMap.size === 0) toolApprovalGates.delete(runId);
      return {
        resolved: true,
        grantId: gate.prompt.grantId,
        decision: "rejected",
        reason: denialReason,
      };
    }
    if (approved) {
      appendAgentRunEventOutsideRuntime(runId, "agent.run.capability_grant_issued", {
        ...grantPayloadBase,
        approvalProvenance: "user_approval",
      });
      appendCapabilityGrantAudit({
        ...grantPayloadBase,
        decision: "issued",
      });
    } else {
      appendAgentRunEventOutsideRuntime(runId, "agent.run.capability_grant_denied", {
        ...grantPayloadBase,
        ...(reason ? { denialReason: reason } : {}),
      });
      appendCapabilityGrantAudit({
        ...grantPayloadBase,
        decision: "denied",
        denialReason: reason,
      });
    }
    gate.resolve({
      approved,
      reason,
      decidedByPrincipalId: options.approverPrincipalId,
      ...(options.approverPrincipalType ? { decidedByPrincipalType: options.approverPrincipalType } : {}),
      ...(options.approvalSurface ? { approvalSurface: options.approvalSurface } : {}),
    });
    runMap.delete(toolCallId);
    deleteChannelToolApprovalSessionsForRun(runId, toolCallId);
    if (runMap.size === 0) toolApprovalGates.delete(runId);
    return {
      resolved: true,
      grantId: gate.prompt.grantId,
      decision: approved ? "approved" : "rejected",
    };
  };

  // ── Compaction pipeline: bridge + memory sink ──
  const agentTokenEstimator = createFridayProviderTokenEstimator();
  const agentContextPruner = createFridayProviderContextPruner();
  const agentContextCompactor = createFridayProviderContextCompactor({
    estimator: agentTokenEstimator,
    pruner: agentContextPruner,
  });
  const agentCompactionBridge = createFridayAgentCompactionBridge({
    compactor: agentContextCompactor,
    estimator: agentTokenEstimator,
    pruner: agentContextPruner,
    idGenerator,
    nowIso,
    // Route compaction summarization to a fast/cheap model via the provider service.
    defaultSummarize: async (prompt) => {
      try {
        const { result } = await providerService.runWithFallback({
          requestedModel: "haiku", // Prefer cheapest model; falls back to whatever is available
          run: async (_route, credential) => {
            const client = createFridayAgentLlmClient({
              baseUrl: _route.provider.baseUrl,
              apiKey: credential ?? "",
              api: _route.provider.config.api,
              backendKind: _route.provider.config.backendKind,
              authMode: _route.provider.config.authMode,
            });
            const chunks: string[] = [];
            for await (const event of client.stream({
              model: _route.model,
              systemPrompt: prompt.system,
              messages: [{ role: "user", content: prompt.user }],
              tools: [],
              signal: AbortSignal.timeout(30_000),
            })) {
              if (event.type === "text_delta") chunks.push(event.text);
            }
            return chunks.join("");
          },
        });
        return result;
      } catch {
        // LLM summarization failure is non-fatal — template extraction is used instead
        return "";
      }
    },
  });
  const agentCompactionContextReplaySink = createFridayCompactionContextReplaySink({
    db: stateRuntime!.sqlite,
    idGenerator,
    nowIso,
  });
  const agentCompactionContextLoader = createFridayCompactionContextLoader({
    db: stateRuntime!.sqlite,
  });

  const agentRuntime = createFridayAgentRuntime({
    // TS Runtime Retirement (method-level guard): production leaves this unset
    // (config flag undefined) so the agent run loop `executeRun` method is
    // fail-closed for every non-route caller. Test-oracle hub configs set it true.
    allowTestOnlyAgentRunExecution: config.allowTestOnlyAgentRunExecution,
    db: stateRuntime!.sqlite,
    llmClient: agentLlmClient,
    model: agentDefaultModel,
    providerId: agentDefaultProviderId,
    systemPromptBuilder: agentSystemPromptBuilder,
    tools: agentTools,
    eventEmitter: agentEventEmitter,
    idGenerator,
    nowIso,
    reviewGate: agentReviewGate,
    runEventRepository: agentRunEventRepository,
    selfTestService: agentSelfTestService,
    selfFixService: agentSelfFixService,
    compactionBridge: agentCompactionBridge,
    compactionContextReplaySink: agentCompactionContextReplaySink,
    sessionMirror: async (sessionKey, message) => {
      await hubSessionService.addMessage(sessionKey, message);
    },
    workdir: workspaceRoot,
    artifactWriter: agentArtifactWriter,
    evaluateRules,
    contextEngine: agentContextEngine,
    decisionEngine: worldModelDecisionEngine,
    worldStateManager: worldModelStateManager,
    learningContextBuilder: (input) => {
      return buildMergedPreferenceContext(input);
    },
    compactionContextBuilder: async (input) => {
      if (!agentCompactionContextLoader) return null;
      const loaded = await agentCompactionContextLoader.loadContext({ sessionKey: input.sessionKey });
      return loaded.fragment.trim().length > 0 ? {
        fragment: loaded.fragment,
        blockCount: loaded.blockCount,
        sources: loaded.sources,
        sessionKey: loaded.sessionKey,
        evidenceTier: loaded.evidenceTier,
        trustLevel: loaded.trustLevel,
        source: loaded.source,
        memoryBoundary: loaded.memoryBoundary,
        redactionApplied: loaded.redactionApplied,
        redactionCount: loaded.redactionCount,
        replayEntryIds: loaded.replayEntryIds,
      } : null;
    },
    communicationPromptBuilder: async (input) => {
      const fragments: string[] = [];
      const explicitPreferences = stateRuntime.sqlite.withReadConnection((db) =>
        uixUserPreferenceRepository.listByPrincipal(db, {
          principalId: input.userId,
          category: "communication",
        }));
      const learnedPreferences = _learningContextRef?.buildContext(input).preferences ?? {};
      const persona = resolveFridayCommunicationPersona({
        explicitPreferences,
        learnedPreferences,
      });
      const personaFragment = buildFridayCommunicationPromptFragment(persona);
      if (personaFragment.trim().length > 0) {
        fragments.push(personaFragment.trim());
      }
      const reflexFragment = buildReflexPreferencePromptFragment(input.userId);
      if (reflexFragment) {
        fragments.push(reflexFragment);
      }
      return fragments.length > 0 ? fragments.join("\n\n") : null;
    },
    starterSkillRouting: {
      enabled: starterSkillRoutingEnforced,
      skills: listInstalledStarterSkills(),
    },
    delegationHandler: async (input) => {
      const inferredProfile = inferFridaySubagentProfile(input.task);
      const detached = await subagentRegistry.spawnDetached({
        task: input.task,
        taskPrompt: input.taskPrompt,
        providerId: input.providerId,
        model: input.model,
        profile: taskLikelyNeedsWriteAccessForSubagent(input.task)
          ? {
              id: inferredProfile,
              readOnly: false,
              ...(typeof input.taskProfile === "string"
                ? { taskProfile: input.taskProfile }
                : input.taskProfile?.id
                  ? { taskProfile: input.taskProfile.id }
                  : {}),
            }
          : inferredProfile,
        timezone: input.timezone,
        timeoutMs: input.timeoutMs,
        conversationContext: input.conversationContext,
        tenantContext: input.tenantContext,
        parentRunId: input.runId,
        parentSessionKey: input.sessionKey,
        depth: 0,
        rootRunId: input.runId,
        constraints: input.constraints,
        disabledToolNames: input.disabledToolNames,
        principalId: input.principalId,
        signal: input.signal,
      });

      const outcome = await subagentRegistry.waitForCompletion(detached.subagentId, input.timeoutMs);
      const completedRecord = subagentRegistry.getById(detached.subagentId);

      return {
        delegated: true,
        subagentId: detached.subagentId,
        childRunId: detached.childRunId,
        childSessionKey: detached.childSessionKey,
        statusSnapshot: completedRecord?.status ?? detached.statusSnapshot,
        outcome,
      };
    },
    usageRecorder: async (usage) => {
      await providerService.recordUsage({
        providerId: usage.providerId,
        providerApi: usage.providerApi as FridayProviderApi,
        model: usage.model,
        routeStrategy: "configured",
        taskComplexity: "medium",
        usage: {
          input: usage.inputTokens,
          output: usage.outputTokens,
          cacheRead: usage.cacheReadInputTokens ?? 0,
          cacheWrite: usage.cacheCreationInputTokens ?? 0,
          total: usage.inputTokens + usage.outputTokens,
        },
        costUsd: usage.costUsd ?? 0,
        // Provider request-id (when the turn surfaced one): makes the write
        // idempotent on it (no double-count on retry/replay) and binds a durable
        // receipt to the agent turn. Null/absent ⇒ recorded without a receipt.
        requestId: usage.requestId,
        metadata: { source: "agent-runtime" },
      });
	    },
	    toolApprovalResolver,
	    canonicalMutatingActionGate: canonicalMutatingActionGateEnabled,
	    canonicalApprovalSecret: tokenSecret,
	    learnedLessons: () => {
      try {
        const repo = createFridayLearnedLessonRepository();
        return stateRuntime!.sqlite.withReadConnection((db) =>
          repo.listRecent(db, 5).map((l) => ({
            title: l.title,
            cause: l.cause,
            fix: l.fix,
          })),
        );
      } catch {
        return [];
      }
    },
  });

  // Wire the lazy agentRuntime reference now that runtime is created (Issue 2 fix)
  _agentRuntimeRef = agentRuntime;

  const agentPlanningGate = createFridayAgentPlanningGateService({
    repo: agentRunRepo,
    runEventRepository: agentRunEventRepository,
    runtime: agentRuntime,
    eventEmitter: agentEventEmitter,
    db: stateRuntime!.sqlite,
    idGenerator,
    nowIso,
  });

  // P2: Wire planning gate + tool approval gate cleanup to agent run completion events
  const cleanupRunGates = (runId: string) => {
    agentPlanningGate.cleanupRun(runId);
    // Reject any pending tool approval gates for this run
    const runMap = toolApprovalGates.get(runId);
    if (runMap) {
      for (const gate of runMap.values()) {
        gate.resolve({ approved: false, reason: "Run terminated" });
      }
      toolApprovalGates.delete(runId);
    }
    deleteChannelToolApprovalSessionsForRun(runId);
    channelApprovalRoutesByRun.delete(runId);
  };
  agentEventEmitter.on("agent.run.completed", (payload) => {
    if (payload && typeof payload === "object" && "runId" in payload) {
      cleanupRunGates((payload as { runId: string }).runId);
    }
  });
  agentEventEmitter.on("agent.run.failed", (payload) => {
    if (payload && typeof payload === "object" && "runId" in payload) {
      cleanupRunGates((payload as { runId: string }).runId);
    }
  });
  agentEventEmitter.on("agent.run.cancelled", (payload) => {
    if (payload && typeof payload === "object" && "runId" in payload) {
      cleanupRunGates((payload as { runId: string }).runId);
    }
  });
  agentEventEmitter.on("agent.run.degraded", (payload) => {
    if (payload && typeof payload === "object" && "runId" in payload) {
      const p = payload as FridayAgentRunDegradedPayload;
      console.info("[friday][agent] run degraded runId=%s level=%s", p.runId, p.level);
    }
  });
  agentEventEmitter.on("agent.run.mode_changed", (payload) => {
    if (payload && typeof payload === "object" && "runId" in payload) {
      const p = payload as FridayAgentModeChangedPayload;
      console.info("[friday][agent] run mode changed runId=%s mode=%s", p.runId, p.newMode);
    }
  });

  const resolveAgentMirrorIdempotencyKey = (input: {
    runId: string;
    kind: "planning" | "assistant" | "planning-reject" | "deterministic";
    status?: FridayAgentRunStatus;
  }): string => {
    if (input.kind === "assistant") {
      return `agent-run:${input.runId}:response`;
    }
    if (input.kind === "planning-reject" || input.kind === "deterministic") {
      return `agent-run:${input.runId}:${input.kind}`;
    }
    const run = stateRuntime!.sqlite.withReadConnection((reader) =>
      agentRunRepo.getById(reader, input.runId));
    const gateState = run?.planReview?.gate?.state ?? "none";
    const answerCount = run?.planReview?.gate?.answers?.length ?? 0;
    const status = input.status ?? run?.status ?? "unknown";
    return `agent-run:${input.runId}:${input.kind}:${status}:${gateState}:${String(answerCount)}`;
  };

  // ─── Sub-agent registry ───

  subagentRegistry = createFridaySubagentRegistry({
    db: stateRuntime!.sqlite,
    sessionService: hubSessionService,
    userRulesContextProvider: (input) =>
      buildFridayUserRulesPromptContext({
        task: input.task,
        surface: input.surface,
      }),
    createChildRuntime: (params) => {
      let childRuntimeRef: FridayAgentRuntime | undefined;
      const childRuntimeGetter = () => childRuntimeRef;
      const childTools = createFridayAgentToolRegistry({
        workdir: workspaceRoot,
        skillExecutor: executor,
        skillRegistry: registry,
        getSkillLifecycleStatus: getPersistedSkillLifecycleStatus,
        // OF6: same skill-run retirement fence on subagent child tools.
        allowTestOnlySkillRunExecution: config.allowTestOnlySkillRunExecution,
        // Route-only-guard defect: same provider validate-probe fence on subagent
        // child tools (default-off → fail-closed).
        allowTestOnlyProviderProbeExecution: config.allowTestOnlyProviderProbeExecution,
        workflowCrudService: workflowRuntime.crud,
        workflowExecutionService: workflowRuntime.execution,
        memoryService,
        memoryGuardFactory,
        listLearnedFacts: (input) =>
          selfLearningRuntime.facts
            .listActiveFacts({ userId: input.userId, minConfidence: 0, limit: input.limit })
            .map((f) => ({
              key: f.key,
              value: f.value,
              confidence: f.confidence,
              evidenceCount: f.evidenceCount,
              lastConfirmedAt: f.lastConfirmedAt,
            })),
        learningEventWriter: (events) => {
          selfLearningRuntime.pipeline.processBatch(events);
        },
        idGenerator,
        nowIso,
        subagentRegistry,
        subagentContext: {
          depth: params.depth,
          parentRunId: "subagent-parent",
          parentSessionKey: "agent:run:subagent-parent",
          rootRunId: params.rootRunId,
        },
        browserManager,
        xhsPageInteractions,
        xhsSessionManager,
        desktopSessionManager,
        systemService,
        guideLensService,
        ssrfGuard: agentSsrfGuard,
        sessionService: hubSessionService,
        agentRuntimeGetter: childRuntimeGetter,
        analyzeImages,
        gatewayService: gatewayService
          ? createFridayGatewayService({
              statusFn: (sig) => gatewayService!.status(sig),
              restartFn: async () => ({
                success: false,
                message: "Sub-agents cannot restart the gateway. Escalate to the parent agent.",
              }),
              configGetFn: (key, sig) => gatewayService!.configGet(key, sig),
              configSetFn: async (_key, _value) => ({
                success: false,
                key: _key,
                value: _value,
              }),
              updateFn: async () => ({
                success: false,
                message: "Sub-agents cannot trigger gateway updates.",
              }),
            })
          : undefined,
        channelRegistry,
        schedulerRepository: schedulerRepo,
        schedulerService: jobScheduler,
        mcpAdapter,
        getMcpServerAvailability,
        extractionService: sessionExtractionService,
        providerService,
        ttsService,
        webSearchProvider: configuredSearchProvider,
        webSearchApiKey: configuredSearchApiKey,
        capabilitySnapshotGetter: getAgentCapabilitySnapshot,
        taskStatusSnapshotGetter: getAgentTaskStatusSnapshot,
        reflexServiceGetter: () => reflexService,
        defaultReflexUserId: learningDefaultUserId,
        subagentForkModeEnabled,
      });
      const childRuntime = createFridayAgentRuntime({
        // TS Runtime Retirement (method-level guard): the child/subagent runtime
        // must receive the SAME test-oracle flag as the parent factory, otherwise
        // a flag-on parent run would fail-closed mid-run when it spawns a
        // subagent (child `executeChildRun` -> childRuntime.executeRun).
        // Production leaves config undefined → fail-closed.
        allowTestOnlyAgentRunExecution: config.allowTestOnlyAgentRunExecution,
        db: stateRuntime!.sqlite,
        llmClient: agentLlmClient,
        model: params.model ?? agentDefaultModel,
        providerId: params.providerId ?? agentDefaultProviderId,
        systemPrompt: params.systemPrompt,
        tools: childTools,
        eventEmitter: agentEventEmitter,
        idGenerator,
        nowIso,
        reviewGate: agentReviewGate,
        runEventRepository: agentRunEventRepository,
        selfTestService: agentSelfTestService,
        selfFixService: createFridayAgentSelfFixService(),
        compactionBridge: agentCompactionBridge,
        compactionContextReplaySink: agentCompactionContextReplaySink,
        sessionMirror: async (sessionKey, message) => {
          await hubSessionService.addMessage(sessionKey, message);
        },
        workdir: workspaceRoot,
        artifactWriter: agentArtifactWriter,
        evaluateRules,
        learningContextBuilder: (input) => {
          return buildMergedPreferenceContext(input);
        },
        compactionContextBuilder: async (input) => {
          if (!agentCompactionContextLoader) return null;
          const loaded = await agentCompactionContextLoader.loadContext({ sessionKey: input.sessionKey });
          return loaded.fragment.trim().length > 0 ? {
            fragment: loaded.fragment,
            blockCount: loaded.blockCount,
            sources: loaded.sources,
            sessionKey: loaded.sessionKey,
            evidenceTier: loaded.evidenceTier,
            trustLevel: loaded.trustLevel,
            source: loaded.source,
            memoryBoundary: loaded.memoryBoundary,
            redactionApplied: loaded.redactionApplied,
            redactionCount: loaded.redactionCount,
            replayEntryIds: loaded.replayEntryIds,
          } : null;
        },
        communicationPromptBuilder: async (input) => {
          const fragments: string[] = [];
          const explicitPreferences = stateRuntime.sqlite.withReadConnection((db) =>
            uixUserPreferenceRepository.listByPrincipal(db, {
              principalId: input.userId,
              category: "communication",
            }));
          const learnedPreferences = _learningContextRef?.buildContext(input).preferences ?? {};
          const persona = resolveFridayCommunicationPersona({
            explicitPreferences,
            learnedPreferences,
          });
          const personaFragment = buildFridayCommunicationPromptFragment(persona);
          if (personaFragment.trim().length > 0) {
            fragments.push(personaFragment.trim());
          }
          const reflexFragment = buildReflexPreferencePromptFragment(input.userId);
          if (reflexFragment) {
            fragments.push(reflexFragment);
          }
          return fragments.length > 0 ? fragments.join("\n\n") : null;
        },
        starterSkillRouting: {
          enabled: starterSkillRoutingEnforced,
          skills: listInstalledStarterSkills(),
        },
        usageRecorder: async (usage) => {
          await providerService.recordUsage({
            providerId: usage.providerId,
            providerApi: usage.providerApi as FridayProviderApi,
            model: usage.model,
            routeStrategy: "configured",
            taskComplexity: "medium",
            usage: {
              input: usage.inputTokens,
              output: usage.outputTokens,
              cacheRead: usage.cacheReadInputTokens ?? 0,
              cacheWrite: usage.cacheCreationInputTokens ?? 0,
              total: usage.inputTokens + usage.outputTokens,
            },
            costUsd: usage.costUsd ?? 0,
            // Provider request-id (when the turn surfaced one): makes the write
            // idempotent on it (no double-count on retry/replay) and binds a
            // durable receipt to the child agent turn. Null/absent ⇒ no receipt.
            requestId: usage.requestId,
            metadata: { source: "agent-runtime" },
          });
        },
        toolApprovalResolver,
        canonicalMutatingActionGate: canonicalMutatingActionGateEnabled,
        canonicalApprovalSecret: tokenSecret,
      });
      childRuntimeRef = childRuntime;

      const feedbackTool = createFridayAgentFeedbackTool({
        learningEventWriter,
        idGenerator,
        nowIso,
        defaultUserId: learningDefaultUserId,
      });
      childRuntime.registerTool(feedbackTool);

      const childSkillGenTool = createFridayAgentSkillGeneratorTool({
        generatorService: skillGenerator,
      });
      childRuntime.registerTool(childSkillGenTool);

      const childWorkflowGenTool = createFridayAgentWorkflowGeneratorTool({
        generatorService: workflowGenerator,
      });
      childRuntime.registerTool(childWorkflowGenTool);

      const childSkillImportTool = createFridayAgentSkillImportTool({
        converterService,
      });
      childRuntime.registerTool(childSkillImportTool);

      const executeChildRun = childRuntime.executeRun.bind(childRuntime);
      return {
        executeRun: async (runParams) => {
          const childRunId = runParams.runId;
          const rootRoute = params.rootRunId ? channelApprovalRoutesByRun.get(params.rootRunId) : undefined;
          if (childRunId && rootRoute) {
            channelApprovalRoutesByRun.set(childRunId, rootRoute);
          }
          if (runParams.sessionKey && runParams.principalId && rootRoute) {
            channelApprovalRoutesBySessionPrincipal.set(
              channelApprovalSessionPrincipalKey(runParams.sessionKey, runParams.principalId),
              rootRoute,
            );
          }
          try {
            return await executeChildRun({
              ...runParams,
              ...(rootRoute
                ? {
                    executionContext: {
                      surface: "channel" as const,
                      interactive: true,
                      channelKind: rootRoute.channelKind,
                      channelChatType: rootRoute.chatType,
                      channelControlRoute: "full_agent" as const,
                    },
                  }
                : {}),
            });
          } finally {
            if (childRunId) {
              channelApprovalRoutesByRun.delete(childRunId);
            }
            if (runParams.sessionKey && runParams.principalId) {
              channelApprovalRoutesBySessionPrincipal.delete(
                channelApprovalSessionPrincipalKey(runParams.sessionKey, runParams.principalId),
              );
            }
          }
        },
      };
    },
    eventEmitter: agentEventEmitter,
    idGenerator,
    nowIso,
  });

  // ─── Channel registry ───

  const webchatWsService = createWebchatWsService();
  const lineWebhookRelay = createLineWebhookListenerService();
  const whatsappWebhookRelay = createWhatsappWebhookService();
  const larkWebhookRelay = createLarkWebhookRelayService();
  // CHAN-TELEGRAM-INBOX-001: durable inbox shared by the polling + webhook transports so the
  // poll offset survives restart and inbound updates are committed exactly-once before ACK.
  const telegramInboxStore = new FridaySqliteTelegramInboxStore(stateRuntime!.sqlite);
  const telegramWebhookRelay = createTelegramWebhookService({ inbox: telegramInboxStore });

  const updateConversationFocus = (
    sessionKey: string,
    updater: (current: Awaited<ReturnType<typeof hubSessionService.getConversationFocus>>) =>
      Awaited<ReturnType<typeof hubSessionService.getConversationFocus>>,
  ): void => {
    void (async () => {
      const current = await hubSessionService.getConversationFocus(sessionKey).catch(() => null);
      const next = updater(current);
      await hubSessionService.setConversationFocus(sessionKey, next).catch(() => undefined);
    })();
  };

  const resolveAgentRun = (runId: string) =>
    stateRuntime!.sqlite.withReadConnection((reader) => agentRunRepo.getById(reader, runId));

  const clearActiveRun = (runId: string): void => {
    const run = resolveAgentRun(runId);
    if (!run) return;
    updateConversationFocus(run.sessionKey, (current) => ({
      ...(current ?? { updatedAt: nowIso() }),
      activeRunId: current?.activeRunId === runId ? undefined : current?.activeRunId,
      updatedAt: nowIso(),
    }));
  };

  agentEventEmitter.on("agent.run.completed", (payload) => {
    clearActiveRun(payload.runId);
  });
  agentEventEmitter.on("agent.run.failed", (payload) => {
    clearActiveRun(payload.runId);
  });
  agentEventEmitter.on("agent.run.cancelled", (payload) => {
    clearActiveRun(payload.runId);
  });

  agentEventEmitter.on("agent.subagent.spawned", (payload) => {
    const record = subagentRegistry.getById(payload.subagentId);
    if (!record) return;
    updateConversationFocus(record.parentSessionKey, (current) => ({
      ...(current ?? { updatedAt: nowIso() }),
      activeRunId: record.childRunId,
      activeSubagentIds: current?.activeSubagentIds?.includes(record.id)
        ? current.activeSubagentIds
        : [...(current?.activeSubagentIds ?? []), record.id],
      updatedAt: nowIso(),
    }));
    updateConversationFocus(record.childSessionKey, (current) => ({
      ...(current ?? { updatedAt: nowIso() }),
      activeRunId: record.childRunId,
      updatedAt: nowIso(),
    }));
  });

  agentEventEmitter.on("agent.subagent.completed", (payload) => {
    const record = subagentRegistry.getById(payload.subagentId);
    if (!record) return;
    updateConversationFocus(record.parentSessionKey, (current) => ({
      ...(current ?? { updatedAt: nowIso() }),
      activeRunId: current?.activeRunId === record.childRunId ? undefined : current?.activeRunId,
      activeSubagentIds: (current?.activeSubagentIds ?? []).filter((id) => id !== record.id),
      updatedAt: nowIso(),
    }));
    updateConversationFocus(record.childSessionKey, (current) => ({
      ...(current ?? { updatedAt: nowIso() }),
      activeRunId: current?.activeRunId === record.childRunId ? undefined : current?.activeRunId,
      updatedAt: nowIso(),
    }));
  });

  // Parse channel config and register channel plugins via loader.
  // Precedence: explicit config (CLI/env) > setup wizard persisted state.
  const channelsInput = config.channels ?? loadChannelsConfigFromSetupState(stateRuntime.sqlite);
  const channelSecretPolicy = resolveFridayChannelSecretPolicy(
    process.env.FRIDAY_CHANNEL_SECRET_POLICY,
  );
  const channelSecretRepository = createFridaySecretRepository();
  const resolveChannelSecretRef = (refKey: string): string | null => {
    try {
      const entity = stateRuntime.sqlite.withReadConnection((db) =>
        channelSecretRepository.getByRef(db, FRIDAY_CHANNEL_SECRET_SCOPE, refKey),
      );
      if (!entity) {
        return null;
      }
      const envelope = JSON.parse(entity.encryptedValue) as FridayEncryptedEnvelope;
      const { plaintext, rewrapped } = decryptSecretWithMigration(
        envelope,
        getStrictMasterKey(),
        fridaySecretAadContext(entity),
      );
      if (rewrapped) {
        // Read-repair (SEC-SECRET-AAD-001): persist v2 re-wrap; best-effort.
        try {
          stateRuntime.sqlite.withWriteTransaction((db) => {
            channelSecretRepository.updateById(db, {
              secretId: entity.id,
              encryptedValue: JSON.stringify(rewrapped),
              keyId: "master-v1",
              nowIso: new Date().toISOString(),
            });
          });
        } catch {
          // Non-fatal: the read already succeeded.
        }
      }
      return plaintext;
    } catch (err) {
      warnHubBootstrapOperationFailureOnce(err);
      return null;
    }
  };
  const channelLoader = createFridayChannelLoader({
    builtins: {
      qq: createFridayQqChannel,
      lark: () => createFridayLarkChannel({ webhookRelay: larkWebhookRelay }),
      feishu: () => createFridayLarkChannel({ webhookRelay: larkWebhookRelay }),
      discord: () => createFridayDiscordChannel({
        gateway: createDiscordGatewayService(),
        rest: createDiscordRestService(),
      }),
      telegram: () => createFridayTelegramChannel({
        polling: createTelegramPollingService({ inbox: telegramInboxStore }),
        webhook: telegramWebhookRelay,
        api: createTelegramApiService(),
      }),
      whatsapp: () => createFridayWhatsappChannel({
        webhook: whatsappWebhookRelay,
        api: createWhatsappApiService(),
      }),
      signal: () => createFridaySignalChannel({
        sse: createSignalSseService(),
        rpc: createSignalRpcService(),
      }),
      slack: () => createFridaySlackChannel({
        socket: createSlackSocketService(),
        httpEvents: createSlackHttpEventService(),
        webApi: createSlackWebApiService(),
      }),
      webchat: () => createFridayWebchatChannel({ ws: webchatWsService }),
      irc: () => createFridayIrcChannel({
        connection: createIrcConnectionService(),
      }),
      line: () => createFridayLineChannel({
        webhookListener: lineWebhookRelay,
        api: createLineApiService(),
      }),
    },
  });

  type RuntimeChannelActivationResult = {
    startedKinds: string[];
    failed: Array<{ kind: string; message: string }>;
    restartRequired: boolean;
    warnings: string[];
  };

  let liveChannelMessageHandler: FridayChannelMessageHandler | null = null;

  const registerChannelsFromConfig = async (
    input: unknown,
    options: { replaceExisting: boolean },
  ): Promise<{ registeredKinds: string[]; warnings: string[] }> => {
    const parsedChannelsConfig = parseFridayChannelsConfig(input);
    const registeredKinds: string[] = [];
    const warnings: string[] = [];
    const desiredKinds = new Set<string>();
    const isRuntimeSupportedChannel = (instance: { kind: string; mode?: unknown }): boolean => {
      if (!isFridayChannelKindSupported(instance.kind)) return false;
      const mode = typeof instance.mode === "string" ? instance.mode : undefined;
      return isFridayChannelModeSupported(instance.kind, mode);
    };
    const warnUnsupportedChannel = (instance: { kind: string; mode?: unknown }): void => {
      const mode = typeof instance.mode === "string" ? instance.mode : undefined;
      const message = mode === undefined
        ? `Channel ${instance.kind} disabled: kind is unsupported in this release.`
        : `Channel ${instance.kind} disabled: mode ${mode} is unsupported in this release.`;
      warnings.push(message);
      console.warn(`[friday] ${message}`);
    };

    if (parsedChannelsConfig.enabled) {
      for (const instance of parsedChannelsConfig.instances) {
        if (instance.enabled && isRuntimeSupportedChannel(instance)) {
          desiredKinds.add(instance.kind);
        }
      }
    }

    if (options.replaceExisting) {
      for (const kind of channelRegistry.list()) {
        if (!desiredKinds.has(kind)) {
          await channelRegistry.unregister(kind);
        }
      }
    }

    if (!parsedChannelsConfig.enabled) {
      return { registeredKinds, warnings };
    }

    for (const instance of parsedChannelsConfig.instances) {
      if (!instance.enabled) continue;

      if (!isRuntimeSupportedChannel(instance)) {
        warnUnsupportedChannel(instance);
        continue;
      }

      if (options.replaceExisting && channelRegistry.get(instance.kind)) {
        await channelRegistry.unregister(instance.kind);
      }

      const resolvedConfig = resolveChannelInitConfigWithSecretPolicy({
        instance,
        env: process.env,
        secretPolicy: channelSecretPolicy,
        resolveSecretRef: resolveChannelSecretRef,
      });
      if (resolvedConfig.warnings.length > 0) {
        warnings.push(
          `Channel ${instance.kind} secret policy warnings: ${resolvedConfig.warnings.join("; ")}`,
        );
        console.warn(
          `[friday] Channel ${instance.kind} secret policy warnings: ${resolvedConfig.warnings.join("; ")}`,
        );
      }
      if (resolvedConfig.errors.length > 0) {
        warnings.push(
          `Channel ${instance.kind} disabled by policy: ${resolvedConfig.errors.join("; ")}`,
        );
        console.warn(
          `[friday] Channel ${instance.kind} disabled by policy: ${resolvedConfig.errors.join("; ")}`,
        );
        continue;
      }

      const initConfig: Record<string, unknown> = { ...resolvedConfig.config };
      // For feishu kind, ensure useFeishu is set
      if (instance.kind === "feishu") {
        initConfig.useFeishu = (instance as Record<string, unknown>).useFeishu ?? true;
      }

      const plugin = await channelLoader.createAndInit(instance.kind, initConfig);

      // Build allowlist config from instance-specific fields
      const allowlistConfig: Record<string, string[] | undefined> = {};
      if ("allowedUsers" in instance) allowlistConfig.allowedUsers = instance.allowedUsers;
      if ("allowedChats" in instance) allowlistConfig.allowedChats = (instance as Record<string, unknown>).allowedChats as string[] | undefined;
      // QQ uses "allowedGroups" — map to "allowedChats" so registry filtering works
      if ("allowedGroups" in instance && !allowlistConfig.allowedChats) {
        allowlistConfig.allowedChats = (instance as Record<string, unknown>).allowedGroups as string[] | undefined;
      }
      // Discord/Slack use "allowedChannels" — map to "allowedChats" so registry filtering works
      if ("allowedChannels" in instance && !allowlistConfig.allowedChats) {
        allowlistConfig.allowedChats = (instance as Record<string, unknown>).allowedChannels as string[] | undefined;
      }

      // Fail closed: a control-capable external channel with no persisted
      // user/chat allowlist must NOT be activated (a missing allowlist would
      // otherwise accept inbound control messages from anyone). Skip activation
      // and surface a warning instead of silently allowing all.
      const controlCapable = isControlCapableChannelKind(instance.kind);
      const hasAllowlist =
        (allowlistConfig.allowedUsers?.length ?? 0) > 0
        || (allowlistConfig.allowedChats?.length ?? 0) > 0;
      if (controlCapable && !hasAllowlist) {
        const message = `Channel ${instance.kind} not activated: a verified user/chat allowlist is required for control-capable channels (fail-closed).`;
        warnings.push(message);
        console.warn(`[friday] ${message}`);
        continue;
      }

      channelRegistry.register(plugin, allowlistConfig, { controlCapable });
      registeredKinds.push(plugin.kind);
    }

    return { registeredKinds, warnings };
  };

  const initialChannelsInput = channelsInput;
  await registerChannelsFromConfig(initialChannelsInput, { replaceExisting: false });

  const activateSavedChannelsFromSetupState = async (): Promise<RuntimeChannelActivationResult> => {
    if (config.channels) {
      return {
        startedKinds: [],
        failed: [],
        restartRequired: true,
        warnings: [
          "Friday is using an explicit channels config from startup; restart with setup-managed channels to apply saved setup changes.",
        ],
      };
    }

    const setupChannelsInput = loadChannelsConfigFromSetupState(stateRuntime.sqlite);
    const registration = await registerChannelsFromConfig(setupChannelsInput, {
      replaceExisting: true,
    });

    if (!liveChannelMessageHandler) {
      return {
        startedKinds: [],
        failed: [],
        restartRequired: true,
        warnings: [
          ...registration.warnings,
          "Friday saved the channel, but the channel runtime is not ready yet. Restart Friday to activate it.",
        ],
      };
    }

    const activationTimeoutMs = Math.max(
      1_000,
      Number.parseInt(process.env.FRIDAY_SETUP_CHANNEL_ACTIVATION_TIMEOUT_MS ?? "5000", 10) || 5_000,
    );
    let activationTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const activationTimeout = new Promise<RuntimeChannelActivationResult>((resolve) => {
      activationTimeoutHandle = setTimeout(() => {
        resolve({
          startedKinds: [],
          failed: registration.registeredKinds.map((kind) => ({
            kind,
            message: `Timed out after ${String(activationTimeoutMs)}ms while starting channel.`,
          })),
          restartRequired: false,
          warnings: registration.warnings,
        });
      }, activationTimeoutMs);
    });
    const startSummary = await Promise.race([
      channelRegistry.startAllBestEffort(liveChannelMessageHandler),
      activationTimeout,
    ]).finally(() => {
      if (activationTimeoutHandle) {
        clearTimeout(activationTimeoutHandle);
      }
    });
    if ("restartRequired" in startSummary) {
      return startSummary;
    }
    return {
      startedKinds: startSummary.startedKinds,
      failed: startSummary.failed,
      restartRequired: false,
      warnings: registration.warnings,
    };
  };

  // Wire message tool now that channelRegistry is available.
  // Register in both the array (for LLM schema) AND runtime toolMap (for execution).
  {
    const messageTool = createFridayAgentMessageTool({ channelRegistry });
    agentTools.push(messageTool);
    agentRuntime.registerTool(messageTool);
  }

  // ─── Plugin runtime mode wiring (stub/full) ───

  const stubPluginService: FridayPluginService = {
    listPlugins: () => [],
    getPlugin: () => null,
    listPluginVersions: () => [],
    installPlugin: () => { throw new FridayDomainError("PLUGIN_NOT_IMPLEMENTED", "Plugin installation is not available in standalone mode", { httpStatus: 501 }); },
    enablePlugin: async () => { throw new FridayDomainError("PLUGIN_NOT_IMPLEMENTED", "Plugin management is not available in standalone mode", { httpStatus: 501 }); },
    disablePlugin: async () => { throw new FridayDomainError("PLUGIN_NOT_IMPLEMENTED", "Plugin management is not available in standalone mode", { httpStatus: 501 }); },
	    uninstallPlugin: async () => { throw new FridayDomainError("PLUGIN_NOT_IMPLEMENTED", "Plugin management is not available in standalone mode", { httpStatus: 501 }); },
	  };

  let pluginRuntimeMode: "stub" | "full" = configuredPluginRuntimeMode;
  const pluginManifestLoader = createFridayPluginManifestLoader();
  let runtimePluginService: FridayPluginService = stubPluginService;

  if (pluginRuntimeMode === "full") {
    try {
      const pluginRepository = createFridayPluginRepository();
      const pluginRegistryService = createFridayPluginRegistryService({
        sqlite: stateRuntime!.sqlite,
        pluginRepository,
      });
      const pluginResolver = createFridayPluginDependencyResolver();
      const pluginSignatureVerifier = createFridayPluginSignatureVerifier();
      const pluginLoader = createFridayPluginLoader({
        registry: pluginRegistryService,
        signatureVerifier: pluginSignatureVerifier,
        nowIso,
      });

      runtimePluginService = createFridayPluginService({
	        sqlite: stateRuntime!.sqlite,
	        registry: pluginRegistryService,
	        resolver: pluginResolver,
	        loader: pluginLoader,
	        signatureVerifier: pluginSignatureVerifier,
	        nowIso,
	        idGenerator,
	      });
      console.log("[friday] Plugin runtime mode: full");
    } catch (err) {
      pluginRuntimeMode = "stub";
      runtimePluginService = stubPluginService;
      console.error(
        "[friday] WARNING: Plugin runtime full mode initialization failed; falling back to stub mode.",
        "Plugin install/enable/disable APIs will return 501.",
        err instanceof Error ? err.message : String(err),
      );
    }
  } else {
    console.log("[friday] Plugin runtime mode: stub");
  }

  const getEnabledChannelKinds = () =>
    channelRegistry.listViews()
      .filter((view) => view.running && view.status === "connected")
      .map((view) => view.kind);

  const deterministicPipeline = pipelineRuntimeConfig.enabled
    ? createFridayDeterministicPipelineRuntime({
      db: stateRuntime!.sqlite,
      idGenerator,
      nowIso,
      invokeSkill: invokeSkillForWorkflow,
    })
    : undefined;

  const discovery = (() => {
    if (!capabilityGates.discoveryEnabled) {
      return undefined;
    }
    const scanner = createDiscoveryScannerForPlatform(process.platform);
    if (!scanner) {
      console.warn(`[friday] Program discovery is not supported on platform '${process.platform}'.`);
      return undefined;
    }
    console.log(`[friday] Program discovery enabled (${scanner.platform}).`);
    return {
      discovery: createFridayProgramDiscoveryService({
        scanner,
        initialPolicy: {
          enabled: true,
        },
      }),
    };
  })();

  // ─── Observability runtime ───

  // Late-init reference for heartbeat state — populated when heartbeat is created (line ~4782)
  let heartbeatStateRef: (() => { lastRunAt: string | null; result: string; intervalMs: number | null; nextRunAt: string | null } | null) | undefined;
  let heartbeatTriggerRef: (() => Promise<unknown>) | undefined;

  const observabilityService = createFridayObservabilityApiService({
    db: stateRuntime.sqlite,
    idGenerator,
    nowIso,
    heartbeatStateGetter: () => heartbeatStateRef ? heartbeatStateRef() : null,
    heartbeatTrigger: async () => {
      if (!heartbeatTriggerRef) {
        throw new FridayDomainError("HEARTBEAT_UNAVAILABLE", "Heartbeat runner is not available in this runtime.", { httpStatus: 503 });
      }
      return heartbeatTriggerRef();
    },
    browserDiagnosticsProvider: () => {
      if (!browserManager) {
        return undefined;
      }
      const summary = browserManager.getDiagnosticsSummary();
      return {
        configuredMode: summary.presentation.configuredMode,
        activeMode: summary.presentation.activeMode,
        targetBrowser: summary.presentation.targetBrowser,
        fallbackReason: summary.presentation.fallbackReason,
        sessionCount: summary.sessionCount,
        profiles: summary.profiles.map((profile) => ({
          name: profile.name,
          kind: profile.kind,
          sessionCount: profile.sessionCount,
          activeTabCount: profile.activeTabCount,
        })),
      };
    },
  });

  // Buffer events published before the real event publisher is wired (late init).
  const selfHealingEventBuffer: Array<{ streamId: string; event: string; payload: Record<string, unknown>; correlationId?: string }> = [];
  let selfHealingEventPublisher:
    | {
      publish(
        streamId: string,
        event: string,
        payload: Record<string, unknown>,
        correlationId?: string,
      ): void;
    }
    | undefined;
  let agentLoopService:
    | ReturnType<typeof createFridayAgentLoopService>
    | undefined;
  const selfHealingApiService = createFridaySelfHealingApiService({
    db: stateRuntime.sqlite,
    idGenerator,
    nowIso,
    incidentRepo: createFridayErrorIncidentRepository(),
    diagnosisRepo: createFridayDiagnosisRecordRepository(),
    lessonRepo: createFridayLearnedLessonRepository(),
    actionRepo: createFridayAutoFixActionRepository(),
    approvalRepo: createFridayApprovalRequestRepository(),
    factRepo: createFridayPreferenceFactRepository(),
    diagnosisService: selfLearningRuntime.diagnosis,
    planService: selfLearningRuntime.autoFixPlan,
    riskService: selfLearningRuntime.autoFixRisk,
    executionService: selfLearningRuntime.autoFixExecution,
    rollbackService: selfLearningRuntime.autoFixRollback,
    approvalService: selfLearningRuntime.approvals,
    autoFixDispatcher: selfLearningRuntime.autoFixDispatcher,
    metricsService: selfLearningRuntime.metrics,
    pipeline: selfLearningRuntime.pipeline,
    observability: observabilityService,
    agentLoop: {
      handleProcessResults(input) {
        return agentLoopService?.handleProcessResults(input) ?? Promise.resolve([]);
      },
      syncAction(input) {
        return agentLoopService?.syncAction(input) ?? Promise.resolve(null);
      },
    },
    publishEvent: {
      publish(streamId, event, payload, correlationId) {
        if (selfHealingEventPublisher) {
          selfHealingEventPublisher.publish(streamId, event, payload, correlationId);
        } else {
          if (selfHealingEventBuffer.length >= FRIDAY_EVENT_BUFFER_MAX) {
            selfHealingEventBuffer.shift();
            warnHubBootstrapOnce("[friday] self-healing event buffer overflow — oldest event dropped");
          }
          selfHealingEventBuffer.push({ streamId, event, payload, correlationId });
        }
      },
    },
  });
  selfHealingApiServiceRef = selfHealingApiService;
  const skillLifecycle = createFridaySkillLifecycleService({
    db: stateRuntime.sqlite,
    nowIso,
    managedSkillsDir,
    catalog: createFridayManagedSkillsCatalogBackend({
      managedSkillsDir,
      workspaceDir: workspaceRoot,
      nowIso,
    }),
    hubVersion: FRIDAY_HUB_SKILL_COMPAT_VERSION,
    supportedApiVersions: ["1"],
    registry,
    installations: skillInstallationService,
    packageInstaller: skillPackageInstaller,
    signatureVerifier: skillSignatureVerifier,
    trustScoring: skillTrustScoring,
    skillRepo: converterSkillRepo,
    versionRepo: skillVersionRepo,
    installationRepo: skillInstallationRepo,
    selfHealing: selfHealingApiService,
  });
  agentLoopService = createFridayAgentLoopService({
    db: stateRuntime.sqlite,
    idGenerator,
    nowIso,
    loopRepo: createFridayAgentLoopRepository(),
    incidentRepo: createFridayErrorIncidentRepository(),
    diagnosisRepo: createFridayDiagnosisRecordRepository(),
    actionRepo: createFridayAutoFixActionRepository(),
    lessonRepo: createFridayLearnedLessonRepository(),
    approvalService: selfLearningRuntime.approvals,
    executionService: selfLearningRuntime.autoFixExecution,
    dispatcher: selfLearningRuntime.autoFixDispatcher,
    selfHealing: selfHealingApiService,
    observability: observabilityService,
    publishEvent: {
      publish(streamId, event, payload, correlationId) {
        if (selfHealingEventPublisher) {
          selfHealingEventPublisher.publish(streamId, event, payload, correlationId);
        } else {
          if (selfHealingEventBuffer.length >= FRIDAY_EVENT_BUFFER_MAX) {
            selfHealingEventBuffer.shift();
            warnHubBootstrapOnce("[friday] self-healing event buffer overflow — oldest event dropped");
          }
          selfHealingEventBuffer.push({ streamId, event, payload, correlationId });
        }
      },
    },
  });
  const workflowProductService = createFridayWorkflowProductService({
    builderRuntime: workflowBuilderRuntime,
    workflowRuntime,
    workflowGenerator,
    observability: observabilityService,
    selfHealing: selfHealingApiService,
    db: stateRuntime.sqlite,
    idGenerator,
    nowIso,
    // TS Runtime Retirement (§1 method-level guard): production leaves this
    // unset (config flag undefined) so the `deployDraft` method is fail-closed
    // for the UIX deploy-workflow card and cross-border pack paths (this hub
    // instance is the one wired into both), not just the HTTP route.
    // Test-oracle hub configs set it true to exercise legacy deployment.
    allowTestOnlyWorkflowDeployExecution: config.allowTestOnlyWorkflowDeployExecution,
  });

  const enrichAgentRunForUi = (run: FridayAgentRunRecord): FridayAgentRunRecord => {
    const rollbackAvailable = agentRuntime.hasRollbackCheckpoint(run.id);
    return {
      ...run,
      rollbackAvailable,
      health: buildFridayAgentRunHealthSnapshot({
        run,
        rollbackAvailable,
      }),
      contextSummary: buildFridayAgentRunContextSummarySnapshot(run),
    };
  };

  const getUiRunSurface = (run: FridayAgentRunRecord): string | undefined => {
    const directSurface = run.metadata?.surface?.trim();
    if (directSurface) {
      return directSurface;
    }
    const packSurface = run.metadata?.packContext?.surface?.trim();
    return packSurface && packSurface.length > 0 ? packSurface : undefined;
  };

  const unwrapUiSubagentSessionKey = (sessionKey: string): string => {
    let normalized = sessionKey;
    while (normalized.startsWith("subagent:")) {
      normalized = normalized.slice("subagent:".length);
    }
    return normalized;
  };

  const isUserVisibleAgentRun = (run: FridayAgentRunRecord): boolean => {
    const surface = getUiRunSurface(run);
    if (surface?.startsWith("autonomous_internal_")) {
      return false;
    }
    if (unwrapUiSubagentSessionKey(run.sessionKey).startsWith("autonomous:")) {
      return false;
    }
    return !run.sessionKey.trim().startsWith("subagent:");
  };

  const listVisibleAgentRunsForUi = (input: {
    status?: FridayAgentRunStatus;
    limit?: number;
  }): FridayAgentRunRecord[] => {
    const requestedLimit = input.limit ?? 12;
    const fetchLimit = Math.min(Math.max(requestedLimit * 4, requestedLimit), 100);
    return stateRuntime.sqlite.withReadConnection((db) =>
      agentRunRepo.list(db, {
        status: input.status,
        limit: fetchLimit,
      })
        .filter(isUserVisibleAgentRun)
        .slice(0, requestedLimit)
        .map(enrichAgentRunForUi));
  };

  const uixService = createFridayUixSurfaceService({
    db: stateRuntime.sqlite,
    idGenerator,
    sessionService: hubSessionService,
    skillGenerator,
    skillExecutor: executor,
    // TS Runtime Retirement — GAP G2 (DEFAULT-OFF): production leaves this unset
    // so UIX starter-skill execution (executeStarterSkillTemplate) behaves
    // exactly as today — zero degradation. Flip true only when the operator
    // decides to Rust-own skill execution (R11) — then the UIX skill-exec lane
    // fails closed (TS_RUNTIME_SKILL_RUNS_RETIRED).
    enforceUixSkillExecRetirement: config.enforceUixSkillExecRetirement,
    workflowGenerator,
    workflowProduct: workflowProductService,
    selfHealing: selfHealingApiService,
    agentRuntime,
    observability: observabilityService,
    preferenceRepo: uixUserPreferenceRepository,
    wizardContextRepo: uixGuidedContextRepository,
    learningEventWriter: (events) => {
      // Lazy: learningEventWriter is defined after uixService, so use the pipeline directly.
      selfLearningRuntime.pipeline.processBatch(events);
    },
    learningContextBuilder: (input) => buildMergedPreferenceContext(input),
    diagnosticsBuilder: () => ({
      generatedAt: nowIso(),
      taskProfilePresets: [
        resolveFridayAgentTaskProfile("default"),
        resolveFridayAgentTaskProfile("deterministic"),
        resolveFridayAgentTaskProfile("planning"),
        resolveFridayAgentTaskProfile("review"),
        resolveFridayAgentTaskProfile("creative"),
      ],
      recentRuns: listVisibleAgentRunsForUi({ limit: 8 }).map((run) => ({
        rollbackAvailable: agentRuntime.hasRollbackCheckpoint(run.id),
        runId: run.id,
        task: run.task,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        contextCostSummary: run.contextCostSummary,
        taskProfile: run.taskProfile,
        health: buildFridayAgentRunHealthSnapshot({
          run,
          rollbackAvailable: agentRuntime.hasRollbackCheckpoint(run.id),
        }),
        contextSummary: buildFridayAgentRunContextSummarySnapshot(run),
      })),
      mcpServerStates: [...(mcpAdapter?.listServerStates() ?? [])],
      supportedPreprocessors: [
        "test_output",
        "log_excerpt",
        "browser_snapshot",
        "diff_excerpt",
      ],
    }),
    listAgentRuns: (input) => listVisibleAgentRunsForUi(input),
    listAutomations: (input) =>
      stateRuntime.sqlite.withReadConnection((db) =>
        agentAutomationRepo.findMany(db, {
          enabled: input.enabled,
          limit: input.limit,
        })),
    nowIso,
  });

  const crossBorderPackService = createFridayCrossBorderPackService({
    db: stateRuntime.sqlite,
    preferenceRepo: uixUserPreferenceRepository,
    idGenerator,
    nowIso,
    workflowRuntime,
    workflowBuilderRuntime,
    workflowProductService,
  });
  crossBorderPackServiceRef = crossBorderPackService;

  // ─── API runtime ───

  // Shared learning event writer — used by satellite sync, agent bridge, feedback,
  // and incentive-alignment automation signals.
  const learningEventWriter = (events: FridayLearningEventAppendInput[]) => {
    const results = selfLearningRuntime.pipeline.processBatch(events);
    selfHealingApiService.emitProcessResults(results);
  };

  const reflexCandidateRepository = createFridayReflexCandidateRepository();
  const reflexOnboardingRepository = createFridayReflexOnboardingRepository();
  const reflexSecretAdminService = createFridaySecretAdminService({
    db: stateRuntime.sqlite,
    idGenerator,
    nowIso,
  });
  reflexService = createFridayReflexService({
    db: stateRuntime.sqlite,
    candidateRepo: reflexCandidateRepository,
    onboardingRepo: reflexOnboardingRepository,
    preferenceRepo: uixUserPreferenceRepository,
    memoryService,
    learnedFactApprover: (input) => {
      const eventId = idGenerator();
      const event: FridayLearningEventAppendInput = {
        eventId,
        ts: input.nowIso,
        userId: input.userId,
        sessionId: input.sessionKey,
        runId: input.sourceRunId,
        kind: "user_correction",
        payload: {
          feedbackKind: "learned_fact_approval",
          key: input.key,
          value: input.value,
          candidateId: input.candidateId,
          origin: input.origin,
        },
      };
      const signal: FridayExtractedSignal = {
        signalId: idGenerator(),
        kind: "preference",
        key: input.key,
        value: input.value,
        confidence: input.confidence,
        sourceEventId: eventId,
        userId: input.userId,
        sessionId: input.sessionKey,
        runId: input.sourceRunId,
        ts: input.nowIso,
        situationalContext: {
          candidateId: input.candidateId,
          origin: input.origin,
          evidence: input.evidence,
        },
      };
      const [fact] = selfLearningRuntime.facts.applySignals({
        event,
        signals: [signal],
        nowIso: input.nowIso,
      });
      if (!fact) {
        throw new Error("Learned-fact approval produced no persisted fact.");
      }
      return {
        factId: fact.factId,
        key: fact.key,
        confidence: fact.confidence,
        evidenceCount: fact.evidenceCount,
        lastConfirmedAt: fact.lastConfirmedAt,
      };
    },
    secureFactStager: (input) => {
      const secret = reflexSecretAdminService.createSecret({
        scope: "learned_fact",
        refKey: `${input.userId}:${input.candidateId}`,
        value: input.value,
      });
      return {
        secretId: secret.id,
        scope: secret.scope,
        refKey: secret.refKey,
        createdAt: secret.createdAt,
        updatedAt: secret.updatedAt,
      };
    },
    secureFactRejecter: (input) => ({
      deleted: reflexSecretAdminService.deleteSecret(input.secretId),
    }),
    skillGenerator,
    workflowGenerator,
    learningEventWriter,
    idGenerator,
    nowIso,
    capabilities: {
      reflexOnboardingEnabled: true,
      reflexCandidatesEnabled: true,
      reflexCuratorEnabled: true,
      liveLlmReflexTestsEnabled: process.env.FRIDAY_LIVE_LLM_REFLEX_TESTS === "1",
    },
  });
  reflexCuratorInterval = setInterval(() => {
    try {
      reflexService?.curateCandidates();
    } catch (err) {
      console.warn("[friday][reflex] daily curator failed:", err instanceof Error ? err.message : String(err));
    }
  }, 24 * 60 * 60 * 1000);
  reflexCuratorInterval.unref?.();

  const readSetupCompletedAt = (): string | null =>
    stateRuntime.sqlite.withReadConnection((db) => {
      const row = db.prepare(
        `SELECT setup_completed_at
         FROM friday_setup_state
         WHERE id = 'singleton'`,
      ).get() as { setup_completed_at: string | null } | undefined;
      return row?.setup_completed_at ?? null;
    });

  const readSavedSetupChannelKinds = (): string[] =>
    stateRuntime.sqlite.withReadConnection((db) => {
      const row = db.prepare(
        `SELECT channels_json
         FROM friday_setup_state
         WHERE id = 'singleton'`,
      ).get() as { channels_json: string | null } | undefined;
      const parsed = safeJsonParse<unknown>(row?.channels_json ?? "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((entry): entry is { kind: string; enabled?: unknown } =>
          !!entry
          && typeof entry === "object"
          && typeof (entry as { kind?: unknown }).kind === "string"
          && (entry as { enabled?: unknown }).enabled === true)
        .map((entry) => entry.kind);
    });

  const markReflexEligibleAfterSetup = (input: { userId: string }): void => {
    if (!reflexService) return;
    const snapshot = reflexService.markNewUserEligible({ userId: input.userId });
    const savedKinds = readSavedSetupChannelKinds();
    if (snapshot.session?.status === "not_started" && savedKinds.length > 0) {
      reflexService.startOnboarding({
        userId: input.userId,
        primaryChannelKind: savedKinds[0],
      });
    }
  };

  const startReflexOnboardingAfterChannelBind = (input: { userId: string; savedKinds: string[] }): void => {
    if (!reflexService || input.savedKinds.length === 0 || !readSetupCompletedAt()) {
      return;
    }
    const snapshot = reflexService.getOnboarding(input.userId);
    if (snapshot.session?.status !== "not_started") {
      return;
    }
    reflexService.startOnboarding({
      userId: input.userId,
      primaryChannelKind: input.savedKinds[0],
    });
  };

  // ─── Owner-bound retention Settings (RETENTION-R3a) ───
  // Persisted per-content-category opt-ins for the single hub owner. The loader
  // resolves the reaper's policy FAIL-CLOSED (all-permanent) on any unreadable /
  // missing / invalid persisted state; the store backs GET|PUT
  // /v1/uix/retention-policy. The owner id is the seeded single-owner user
  // (learningDefaultUserId) — the SAME principal_id the API writes under
  // (requireUserId → principal.userId), so a restart re-reads what the owner set.
  const retentionSettingsRepository = createFridayRetentionSettingsRepository();
  const retentionSettingsStore = createFridayRetentionSettingsStore({
    db: stateRuntime.sqlite,
    repo: retentionSettingsRepository,
    idGenerator,
    nowIso,
  });
  const retentionPolicyLoader = createFridayRetentionPolicyLoader({
    db: stateRuntime.sqlite,
    repo: retentionSettingsRepository,
    principalId: learningDefaultUserId,
  });

  // RETENTION-R3b: report-only disk-growth snapshot holder. The system-health
  // monitor job (below) updates it each run; the owner-bound
  // GET /v1/uix/retention-policy/disk-usage serves it. Declared HERE (before the
  // retentionSettings deps at the api-runtime call) so both the reader closure and
  // the scheduler-job writer capture the same in-memory holder. It is
  // DERIVED/observable — never persisted as canonical (DATA-RETENTION-001).
  const diskGrowthHolder: FridayDiskGrowthHolder = createFridayDiskGrowthHolder();

  // ─── Satellite runtime ───
  const satelliteRuntime = createFridaySatelliteRuntime({
    db: stateRuntime.sqlite,
    cursorSecret: tokenSecret,
    tokenSecret,
    idGenerator,
    nowIso,
    // RETENTION-R3a live-revocation fix: the hourly reaper re-reads the CURRENT
    // persisted owner policy at the START of every sweep (fail-closed to
    // all-permanent). A startup snapshot let the running reaper keep deleting
    // under an opt-in the owner had since set back to permanent, until restart.
    retentionPolicyProvider: () => retentionPolicyLoader.load(),
    learningEventWriter,
    remoteNodeResultWriter: async (input) => {
      await workflowRuntime.execution.reportRemoteNodeResult({
        satelliteId: input.satelliteId,
        runId: input.runId,
        nodeId: input.nodeId,
        attemptId: input.attemptId,
        attempt: input.attempt,
        status: input.status,
        output: input.output as JsonValue | undefined,
        error: input.error
          ? {
            code: input.error.code,
            message: input.error.message,
            retryable: input.error.retryable,
            details: input.error.details as JsonValue | undefined,
          }
          : undefined,
      });
    },
    onStatusTransition: ({ satelliteId, fromStatus, toStatus, at, failureRate1m, explicitDisconnect }) => {
      if (toStatus !== "degraded" && toStatus !== "offline") {
        return;
      }
      selfHealingApiService.reportStructuredFailure({
        userId: learningDefaultUserId,
        category: "config",
        severity: toStatus === "offline" ? "high" : "medium",
        message: `Satellite ${satelliteId} transitioned from ${fromStatus} to ${toStatus}`,
        correlationId: `satellite:${satelliteId}:${toStatus}:${at}`,
        context: {
          satelliteId,
          fromStatus,
          toStatus,
          failureRate1m,
          explicitDisconnect,
          source: "satellite_runtime",
        },
      });
    },
    // TS-runtime-retirement (method-level guards): same top-level flags the
    // satellite-runtime + pairing ROUTES use, so the inbound satellite mutations
    // (register/pairing/heartbeat/capabilities/sync) fail-close by default in
    // live (route + method both fenced) and are reachable only under the test
    // oracle. Live/prod config leaves these unset.
    allowTestOnlySatelliteRuntimeExecution: config.allowTestOnlySatelliteRuntimeExecution,
    allowTestOnlySatellitePairingExecution: config.allowTestOnlySatellitePairingExecution,
  });

  const workflowSatelliteDispatcher = createFridayWorkflowSatelliteDispatchService({
    db: stateRuntime.sqlite,
    outbox: satelliteRuntime.outbox,
    nowIso,
  });
  workflowRuntime.execution.setDistributedDispatcher(workflowSatelliteDispatcher);

  const satelliteRepo = createFridaySatelliteRepository();

  // ── Packaging system (opt-in) ──
  let packagingDeps: FridayPackagingRoutesDeps | undefined;
  if (process.env.FRIDAY_PACKAGING_ENABLED === "true") {
    const packagingRegistry = createSqliteRegistryManager({
      sqlite: stateRuntime.sqlite,
      generateId: idGenerator,
      nowIso,
    });
    const trustedKeyStore = createSqliteTrustedKeyStore({
      sqlite: stateRuntime.sqlite,
      generateId: idGenerator,
      nowIso,
    });
    const packagingInstaller = createSqlitePackageInstaller({
      sqlite: stateRuntime.sqlite,
      registry: packagingRegistry,
      generateId: idGenerator,
      nowIso,
      verifyPackage: (ctx) => verifySignatureLogical(
        ctx.entry.signature,
        ctx.entry.manifestDigest,
        ctx.entry.archiveDigest,
        trustedKeyStore.listAll(),
        ctx.verifiedAt,
      ),
    });
    const packagingHandlers = createFridayPackagingApiHandlers({
      registry: packagingRegistry,
      installer: packagingInstaller,
      principalId: "system",
      platformVersion: config.serverVersion ?? FRIDAY_HUB_DEFAULT_SERVER_VERSION,
    });

    packagingDeps = {
      packages: {
        publish(req) {
          const envelope = decodeFridayPackageArchiveEnvelope(req.archive);
          const verification = verifySignatureLogical(
            envelope.signature,
            envelope.manifestDigest,
            envelope.archiveDigest,
            trustedKeyStore.listAll(),
            nowIso(),
          );
          if (!verification.valid) {
            throw new FridayDomainError(`PACKAGING_${verification.outcome.toUpperCase()}`, verification.message, { httpStatus: 400 });
          }
          const entry = packagingRegistry.publish({
            manifest: envelope.manifest,
            signature: envelope.signature,
            archiveDigest: envelope.archiveDigest,
            manifestDigest: envelope.manifestDigest,
            sizeBytes: envelope.archiveSizeBytes,
            publishedBy: "system",
            tenantId: req.tenantId,
          });
          return {
            package: entry as any,
            verification,
          };
        },
        list(query) {
          const page = packagingRegistry.search(
            { tenantId: query.tenantId, name: query.name, capability: query.capability, keyword: query.keyword, author: query.author, sortBy: query.sortBy, sortDir: query.sortDir },
            { cursor: query.cursor, limit: query.limit },
          );
          return {
            items: page.items.map((e) => ({
              id: e.id, name: e.name, version: e.version,
              description: e.description, author: e.author,
              license: e.license, capabilities: e.capabilities,
              sizeBytes: e.sizeBytes, publishedBy: e.publishedBy,
              createdAt: e.createdAt, updatedAt: e.updatedAt,
            })),
            nextCursor: page.nextCursor,
          };
        },
        get(packageId) {
          const entry = packagingRegistry.getById(packageId);
          if (!entry) { throw new FridayDomainError("NOT_FOUND", `Package "${packageId}" not found`); }
          return {
            package: entry as any,
            signature: (entry as any).signature ?? {
              algorithm: "Ed25519" as const, publicKey: "", signature: "",
              digest: entry.archiveDigest, manifestDigest: entry.manifestDigest,
              timestamp: entry.createdAt, expiresAt: entry.createdAt, keyId: "unknown",
            },
            versionCount: packagingRegistry.getVersionCount(entry.name, entry.tenantId),
          };
        },
        listVersions(packageName, query) {
          const versions = packagingRegistry.getVersions(packageName, query.tenantId);
          const limit = Math.max(1, Math.min(query.limit ?? 20, 100));
          let startIndex = 0;
          if (query.cursor) {
            const idx = versions.findIndex((v) => v.id === query.cursor);
            if (idx >= 0) startIndex = idx + 1;
          }
          const paged = versions.slice(startIndex, startIndex + limit);
          return {
            items: paged.map((v) => ({
              id: v.id, packageName: v.name, version: v.version,
              compatibilityRange: v.fridayVersionRange,
              archiveDigest: v.archiveDigest, sizeBytes: v.sizeBytes,
              publishedAt: v.createdAt, publishedBy: v.publishedBy,
              deprecated: false,
            })),
            nextCursor: startIndex + limit < versions.length ? paged[paged.length - 1]?.id : undefined,
          };
        },
        verify(packageId, _req) {
          const entry = packagingRegistry.getById(packageId);
          if (!entry) { throw new FridayDomainError("NOT_FOUND", `Package "${packageId}" not found`); }
          const verification = verifySignatureLogical(
            entry.signature,
            entry.manifestDigest,
            entry.archiveDigest,
            trustedKeyStore.listAll(),
            nowIso(),
          );
          return {
            verification,
            package: entry as any,
          };
        },
        checkDependencies(packageName, req) {
          return packagingHandlers.checkDependencies(packageName, req);
        },
      },
      installs: {
        install(packageName, req) { return packagingHandlers.installPackage(packageName, req); },
        upgrade(packageName, req) { return packagingHandlers.upgradePackage(packageName, req); },
        rollback(packageName, req) { return packagingHandlers.rollbackPackage(packageName, req); },
        uninstall(packageName, req) { return packagingHandlers.uninstallPackage(packageName, req); },
        list(query) { return packagingHandlers.listInstalls(query); },
        get(installId) { return packagingHandlers.getInstall(installId); },
      },
      lifecycle: {
        list(query) { return packagingHandlers.listLifecycleEvents(query); },
      },
      keys: {
        list(query) {
          const page = trustedKeyStore.list({
            tenantId: query.tenantId,
            includeRevoked: query.includeRevoked,
            cursor: query.cursor,
            limit: query.limit,
          });
          return { items: page.items as never, nextCursor: page.nextCursor };
        },
        add(req) {
          try {
            const key = trustedKeyStore.add({
              keyId: req.keyId,
              publicKey: req.publicKey,
              algorithm: req.algorithm,
              owner: req.owner,
              tenantId: req.tenantId,
              expiresAt: req.expiresAt,
            });
            return { key: key as never };
          } catch (e) {
            throw new FridayDomainError("CONFLICT", (e as Error).message);
          }
        },
        revoke(keyId, req) {
          const updated = trustedKeyStore.revoke(keyId, req.reason);
          if (!updated) { throw new FridayDomainError("NOT_FOUND", `Key "${keyId}" not found`); }
          return { key: updated as never, affectedInstalls: 0 };
        },
        rotate(keyId, req) {
          const result = trustedKeyStore.rotate({
            oldKeyId: keyId,
            newKeyId: req.newKeyId,
            newPublicKey: req.newPublicKey,
            owner: req.owner,
            expiresAt: req.expiresAt,
          });
          return {
            newKey: result.newKey as never,
            oldKey: result.oldKey as never,
            gracePeriodEndsAt: result.gracePeriodEndsAt,
          };
        },
      },
      packagingMutationGate: skillRunCanonicalMutationGate,
    };
  }

  // ── Multi-tenant security (opt-in) ──
  let multiTenantSecurityDeps: Parameters<typeof createFridayApiRuntime>[0]["multiTenantSecurity"] = undefined;
  if (process.env.FRIDAY_MULTI_TENANT_ENABLED === "true") {
    const {
      TenantManager,
      RbacEngine,
      PolicyEngine,
      SecretManager,
      AuditLogger,
      TenantScopedResourceRegistry,
    } = await import("../security/multi-tenant/engine/index.js");
    const { MIGRATION_ACTOR } = await import("../security/multi-tenant/engine/tenant-manager.js");
    const {
      createSqliteTenantPersistence,
      createSqliteSecretPersistence,
      createSqliteAuditPersistence,
      createSqliteTenantScopedResourcePersistence,
    } = await import("../security/multi-tenant/persistence/friday-multi-tenant-sqlite-store.js");
    const { getStrictMasterKey } = await import("../providers/security/friday-secret-crypto.js");

    // Fail-closed master key check: refuses to boot without explicit key.
    // Multi-tenant security must NOT auto-generate or print a master key.
    getStrictMasterKey();

    const tenantPersistence = createSqliteTenantPersistence(stateRuntime.sqlite);
    const secretPersistence = createSqliteSecretPersistence(stateRuntime.sqlite);
    const auditPersistence = createSqliteAuditPersistence(stateRuntime.sqlite);
    const scopedResourcePersistence = createSqliteTenantScopedResourcePersistence(stateRuntime.sqlite);

    const mtAuditLogger = new AuditLogger({ persistence: auditPersistence });
    const mtTenantManager = new TenantManager(mtAuditLogger, { persistence: tenantPersistence });
    const mtRbacEngine = new RbacEngine(mtAuditLogger);
    const mtPolicyEngine = new PolicyEngine(mtAuditLogger);
    const mtSecretManager = new SecretManager(mtAuditLogger, {
      persistence: secretPersistence,
      masterKeyResolver: getStrictMasterKey,
    });
    // Tenant-scoped resource registry (sessions/skills/workflows/providers/memory/rules).
    // Phase 11 Module 18 cross-tenant denial + restart proof for legacy domains.
    const mtScopedResources = new TenantScopedResourceRegistry(mtAuditLogger, {
      persistence: scopedResourcePersistence,
    });
    const { FRIDAY_TENANT_SCOPED_RESOURCE_KINDS } = await import("../security/multi-tenant/engine/tenant-scoped-resource-registry.js");

    // System-level actor for API-initiated operations (routes enforce their own auth scopes)
    const sysActor = MIGRATION_ACTOR;

    multiTenantSecurityDeps = {
      tenants: {
        create: (req) => ({ tenant: mtTenantManager.createTenant(req as never, sysActor) }) as never,
        list: (query) => ({ items: mtTenantManager.listTenants(sysActor, (query as unknown as Record<string, unknown>)?.status as never) }) as never,
        get: (tenantId) => ({ tenant: mtTenantManager.getTenant(tenantId, sysActor) }) as never,
        update: (tenantId, req) => ({ tenant: mtTenantManager.updateTenant(tenantId, req as never, sysActor) }) as never,
        delete: (tenantId, req) => ({ tenant: mtTenantManager.deleteTenant(tenantId, (req as unknown as Record<string, unknown>).etag as string, sysActor) }) as never,
      },
      workspaces: {
        create: (tenantId, req) => ({ workspace: mtTenantManager.createWorkspace(tenantId, req as never, sysActor) }) as never,
        list: (tenantId, query) => ({ items: mtTenantManager.listWorkspaces(tenantId, sysActor, (query as unknown as Record<string, unknown>)?.status as never) }) as never,
        get: (tenantId, workspaceId) => ({ workspace: mtTenantManager.getWorkspace(tenantId, workspaceId, sysActor) }) as never,
        update: (tenantId, workspaceId, req) => ({ workspace: mtTenantManager.updateWorkspace(tenantId, workspaceId, req as never, sysActor) }) as never,
        delete: (tenantId, workspaceId, req) => ({ workspace: mtTenantManager.deleteWorkspace(tenantId, workspaceId, (req as unknown as Record<string, unknown>).etag as string, sysActor) }) as never,
      },
      members: {
        add: (tenantId, workspaceId, req) => ({ membership: mtTenantManager.addMember(tenantId, workspaceId, req as never) }) as never,
        list: (tenantId, workspaceId, query) => ({ items: mtTenantManager.listMembers(tenantId, workspaceId, query as never) }) as never,
        revoke: (tenantId, workspaceId, membershipId, _req) => ({ membership: mtTenantManager.revokeMembership(tenantId, workspaceId, membershipId) }) as never,
      },
      roles: {
        create: (tenantId, req) => ({ role: mtRbacEngine.createRole(tenantId, req as never) }) as never,
        list: (tenantId, query) => ({ items: mtRbacEngine.listRoles(tenantId, (query as unknown as Record<string, unknown>)?.scope as never) }) as never,
        get: (tenantId, roleId) => ({ role: mtRbacEngine.getRole(tenantId, roleId) }) as never,
        update: (tenantId, roleId, req) => ({ role: mtRbacEngine.updateRole(tenantId, roleId, req as never) }) as never,
        delete: (tenantId, roleId, req) => ({ role: mtRbacEngine.deleteRole(tenantId, roleId, (req as unknown as Record<string, unknown>).etag as string) }) as never,
      },
      assignments: {
        grant: (_tenantId, req) => ({ assignment: mtRbacEngine.grantRole(req as never) }) as never,
        list: (tenantId, query) => ({ items: mtRbacEngine.listAssignments(tenantId, query as never) }) as never,
        revoke: (tenantId, assignmentId, _req) => ({ assignment: mtRbacEngine.revokeAssignment(tenantId, assignmentId) }) as never,
      },
      secrets: {
        create: (tenantId, req) => ({ secret: mtSecretManager.createSecret(tenantId, req as never) }) as never,
        list: (tenantId, query) => ({ items: mtSecretManager.listSecrets(tenantId, query as never) }) as never,
        get: (tenantId, secretId) => ({ secret: mtSecretManager.getSecret(tenantId, secretId) }) as never,
        update: (tenantId, secretId, req) => ({ secret: mtSecretManager.updateSecret(tenantId, secretId, req as never) }) as never,
        delete: (tenantId, secretId, req) => ({ secret: mtSecretManager.deleteSecret(tenantId, secretId, (req as unknown as Record<string, unknown>).etag as string) }) as never,
        rotate: (tenantId, secretId, req) => mtSecretManager.rotateSecret(tenantId, secretId, req as never) as never,
        listAccessLog: (tenantId, secretId, query) => ({ items: mtSecretManager.queryAccessLog(tenantId, secretId, query as never) }) as never,
      },
      policies: {
        create: (tenantId, req) => ({ policy: mtPolicyEngine.createPolicy(tenantId, req as never) }) as never,
        list: (tenantId, query) => ({ items: mtPolicyEngine.listPolicies(tenantId, (query as unknown as Record<string, unknown>)?.scope as never) }) as never,
        get: (tenantId, policyId) => ({ policy: mtPolicyEngine.getPolicy(tenantId, policyId) }) as never,
        update: (tenantId, policyId, req) => ({ policy: mtPolicyEngine.updatePolicy(tenantId, policyId, req as never) }) as never,
        delete: (tenantId, policyId, req) => ({ policy: mtPolicyEngine.deletePolicy(tenantId, policyId, (req as unknown as Record<string, unknown>).etag as string) }) as never,
        evaluate: (tenantId, req) => ({ evaluation: mtPolicyEngine.evaluate(tenantId, req as never) }) as never,
      },
      audit: {
        list: (tenantId, query) => ({ items: mtAuditLogger.queryAuditLog({ tenantId, ...(query as unknown as Record<string, unknown>) } as never) }) as never,
      },
      violations: {
        list: (tenantId, query) => ({ items: mtAuditLogger.queryViolations({ tenantId, ...(query as unknown as Record<string, unknown>) } as never) }) as never,
        resolve: (tenantId, violationId, req) => ({ violation: mtAuditLogger.resolveViolation(tenantId, violationId, (req as unknown as Record<string, unknown>)?.resolvedBy as string ?? "system") }) as never,
      },
      scopedResources: {
        register: (tenantId, req) => ({
          record: mtScopedResources.register({
            tenantId,
            resourceKind: req.resourceKind,
            resourceId: req.resourceId,
            workspaceId: req.workspaceId,
            resourceLabel: req.resourceLabel,
          }),
        }) as never,
        list: (tenantId, query) => ({
          items: mtScopedResources.listForTenant(tenantId, query?.resourceKind),
        }) as never,
        get: (tenantId, resourceKind, resourceId) => {
          const record = mtScopedResources.getForTenant(tenantId, resourceKind, resourceId);
          if (!record) {
            throw new FridayDomainError("NOT_FOUND", "scoped resource not found");
          }
          return { record } as never;
        },
        unregister: (tenantId, resourceKind, resourceId) => {
          const record = mtScopedResources.unregister(tenantId, resourceKind, resourceId);
          if (!record) {
            throw new FridayDomainError("NOT_FOUND", "scoped resource not found");
          }
          return { record } as never;
        },
        status: (tenantId) => {
          const items = mtScopedResources.listForTenant(tenantId);
          const totals = Object.fromEntries(
            FRIDAY_TENANT_SCOPED_RESOURCE_KINDS.map((kind) => [kind, 0]),
          ) as Record<string, number>;
          for (const item of items) {
            totals[item.resourceKind] = (totals[item.resourceKind] ?? 0) + 1;
          }
          return {
            tenantId,
            totals,
            activeTotal: items.length,
            supportedKinds: FRIDAY_TENANT_SCOPED_RESOURCE_KINDS,
          } as never;
        },
      },
    };
    console.log("[friday] Multi-tenant security runtime enabled.");
  }

  // ── Desktop route deps (opt-in, wired from desktopSessionManager) ──
  const desktopRouteDeps: Parameters<typeof createFridayApiRuntime>[0]["desktop"] = desktopSessionManager
    ? {
      allowTestOnlyDesktopActionExecution: config.allowTestOnlyDesktopActionExecution,
      // TS Runtime Retirement (A3 HOLE 1): keep the recording-route fence
      // (throwRetiredDesktopRecording, gated on this flag) in lockstep with the
      // new session-manager method guard, both driven by the same config knob.
      allowTestOnlyDesktopRecordingExecution: config.allowTestOnlyDesktopRecordingExecution,
      actions: {
        async execute(req) { return desktopSessionManager!.executeAction(req.action as never) as never; },
        async batch(req) {
          const results = [];
          for (const action of req.actions) {
            results.push(await desktopSessionManager!.executeAction(action as never));
          }
          return { results, batchId: req.idempotencyKey } as never;
        },
        async cancel(actionId, _req) { desktopSessionManager!.cancelAction(actionId); return { cancelled: true } as never; },
        log(query) { const log = desktopSessionManager!.getActionLog(); return { entries: log.slice(0, (query as unknown as Record<string, unknown>)?.limit as number ?? 100) } as never; },
      },
      recordings: {
        start(req) { return desktopSessionManager!.startRecording({ name: (req as unknown as Record<string, unknown>).name as string }) as never; },
        stop(recordingId, _req) { return desktopSessionManager!.stopRecording(recordingId) as never; },
        pause(recordingId, _req) { return desktopSessionManager!.pauseRecording(recordingId) as never; },
        resume(recordingId, _req) { return desktopSessionManager!.resumeRecording(recordingId) as never; },
        list(_query) { return { recordings: desktopSessionManager!.listRecordings() } as never; },
        get(recordingId) { return { recording: desktopSessionManager!.getRecording(recordingId) } as never; },
        listSteps(recordingId, _query) { return { steps: desktopSessionManager!.getRecordingSteps(recordingId) } as never; },
        async replay(recordingId, _req) { return desktopSessionManager!.replayRecording(recordingId) as never; },
        delete(recordingId, _req) { desktopSessionManager!.deleteRecording(recordingId); return { deleted: true } as never; },
      },
      policies: {
        // B3 / FRI-AUD-005 fail-closed: desktop policy persistence is
        // proof_pending in this release. Previous implementations of these
        // deps echoed the request back with a synthetic id and returned
        // empty/null reads, which let synthetic responses look enforced.
        // Per POST_RELEASE_DEFAULT_DECISIONS.md B3 ("Desktop policy routes
        // must either persist/enforce real policy with audit and rollback,
        // or be hidden/gated/labeled proof_pending"), routes stay
        // registered for contract stability (FridayCreateDesktopPolicyRequest
        // / FridayUpdateDesktopPolicyRequest types remain unchanged) but
        // call sites get a typed 503 they can render truthfully.
        create(_req): never { throw createDesktopPolicyNotPersistedError("create"); },
        get(_policyId): never { throw createDesktopPolicyNotPersistedError("get"); },
        list(_query): never { throw createDesktopPolicyNotPersistedError("list"); },
        update(_policyId, _req): never { throw createDesktopPolicyNotPersistedError("update"); },
        delete(_policyId, _req): never { throw createDesktopPolicyNotPersistedError("delete"); },
        addRule(_policyId, _req): never { throw createDesktopPolicyNotPersistedError("addRule"); },
        removeRule(_policyId, _ruleId, _req): never { throw createDesktopPolicyNotPersistedError("removeRule"); },
      },
      permissions: {
        // permissions.list reads real OS permissions via the session manager —
        // this is a true read (no persistence required). Kept as real.
        async list() { const perms = await desktopSessionManager!.checkPermissions(); return { permissions: [...perms] } as never; },
        // B3 / FRI-AUD-005 fail-closed: the previous implementations echoed
        // the decision and returned an always-empty decision log without
        // persisting anything. Synthetic responses must not look enforced.
        respond(_promptId, _req): never { throw createDesktopPermissionDecisionNotPersistedError("respond"); },
        listDecisions(_query): never { throw createDesktopPermissionDecisionNotPersistedError("listDecisions"); },
      },
      platform: {
        async get() {
          const platform = desktopSessionManager!.getAdapterManager().getDetectedPlatform();
          return { platform: platform ?? "unknown", connected: desktopSessionManager!.isConnected() } as never;
        },
      },
      elements: {
        async inspect(req) { const el = await desktopSessionManager!.inspectElement((req as unknown as Record<string, unknown>).selector as never); return { element: el } as never; },
        async search(query) { const els = await desktopSessionManager!.searchElements((query as unknown as Record<string, unknown>).query as string); return { elements: [...els] } as never; },
      },
    }
    : undefined;

  const CHANNEL_PERSONA_SETTINGS_KEY = "channels.persona.v1";

  function loadPersistedChannelPersonas(): Record<string, FridayChannelPersonaConfig> {
    const row = stateRuntime!.sqlite.withReadConnection((db) =>
      db
        .prepare("SELECT value_json FROM hub_settings WHERE key = ?")
        .get(CHANNEL_PERSONA_SETTINGS_KEY) as { value_json: string } | undefined,
    );
    if (!row) {
      return {};
    }
    const parsed = safeJsonParse<Record<string, unknown>>(row.value_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const personas: Record<string, FridayChannelPersonaConfig> = {};
    for (const [kind, value] of Object.entries(parsed)) {
      if (!channelRegistry.describe(kind) && !isFridayChannelKindSupported(kind)) {
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const record = value as Record<string, unknown>;
      const persona = typeof record.persona === "string" ? record.persona.trim() : "";
      const systemPrompt = typeof record.systemPrompt === "string" ? record.systemPrompt.trim() : "";
      const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : nowIso();
      if (!persona && !systemPrompt) {
        continue;
      }
      personas[kind] = {
        persona,
        systemPrompt,
        updatedAt,
      };
    }
    return personas;
  }

  function savePersistedChannelPersonas(input: Record<string, FridayChannelPersonaConfig>): void {
    const json = JSON.stringify(input);
    const now = nowIso();
    stateRuntime!.sqlite.withWriteTransaction((db) => {
      const existing = db
        .prepare("SELECT key FROM hub_settings WHERE key = ?")
        .get(CHANNEL_PERSONA_SETTINGS_KEY) as { key: string } | undefined;
      if (existing) {
        db.prepare(
          `UPDATE hub_settings SET value_json = ?, revision = revision + 1, updated_at = ?
           WHERE key = ?`,
        ).run(json, now, CHANNEL_PERSONA_SETTINGS_KEY);
      } else {
        db.prepare(
          `INSERT INTO hub_settings (key, value_json, revision, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?)`,
        ).run(CHANNEL_PERSONA_SETTINGS_KEY, json, now, now);
      }
    });
  }

  const persistedChannelPersonas = loadPersistedChannelPersonas();
  hydrateChannelPersonaStore(persistedChannelPersonas);
  savePersistedChannelPersonas(persistedChannelPersonas);

  const missionSpineWorkbenchProjectionService = createFridayRustHubWorkbenchProjectionService({
    stateDir: stateRuntime.stateDir,
  });

  // (Lane B-2) ORGANIC mission-spine POST routes (DARK): construct the dispatch adapter that makes
  // `/v1/mission-spine/intake|lifecycle|work-item-status` CALLABLE — but ONLY when the operator flag is
  // on. SINGLE SOURCE OF TRUTH = `resolveRouteMissionSpineViaRust` (explicit config wins; else the
  // `FRIDAY_MISSION_SPINE_ROUTES_VIA_RUST` env knob, case-insensitive "1"/"true" → true; anything else,
  // incl. unset → false). With nothing set (the default) this is `false`, so the adapter is NOT built,
  // `missionSpine.dispatch` stays unset (the conditional spread below omits the key entirely), and each
  // POST route returns today's fail-closed 503 (`MISSION_SPINE_DISPATCH_UNAVAILABLE`) → byte-identical.
  //
  // SIDE-EFFECT-FREE construction: the adapter factory captures host/port/timeout + the SecureStore
  // X25519 secret resolver only — it resolves NO secret and opens NO socket here. The secret is resolved
  // + the sealed client built LAZILY, per route call, so a flag-ON-but-unprovisioned host FAILS CLOSED
  // (503) per call rather than crashing boot. Config (endpoint + ECDH secret resolver) MIRRORS the
  // agent-run sealed-WS path (friday-api-runtime.ts ~:4816); the DB path is intentionally NOT carried
  // (the mission round-trips are refs-only WS, no DB readback).
  const routeMissionSpineViaRust = resolveRouteMissionSpineViaRust(config.routeMissionSpineViaRust);
  // (Organic mission→run binding PRODUCER — DARK) When BOTH `missionAutoDispatch` AND the mission-spine
  // route flag resolve true, construct the auto-dispatch driver and wire it into the dispatch adapter so
  // a fresh-Ready intake immediately fires a READ-ONLY bound agent-run carrying the server-produced
  // handle. DEFAULT-OFF: with `missionAutoDispatch` false the driver is NEVER built, the adapter's
  // `autoDispatchDriver` option is OMITTED, `intakeMission` is byte-identical, and no organic run fires.
  //
  // ORDERING: the adapter is constructed here, BEFORE `createFridayApiRuntime` below, so the driver
  // cannot capture `apiRuntime.agent.startRun` directly. The driver instead takes a THUNK
  // (`() => resolvedMissionAutoDispatchStartRun`) that is populated AFTER the runtime exists. The
  // driver's `onIntakeReady` only fires at request time (long after boot), by which point the ref is set.
  const missionAutoDispatch = resolveMissionAutoDispatch(config.missionAutoDispatch);
  let resolvedMissionAutoDispatchStartRun: MissionAutoDispatchStartRun | undefined;
  const missionAutoDispatchDriver =
    missionAutoDispatch && routeMissionSpineViaRust
      ? createFridayMissionAutoDispatchDriver({
        startRun: () => resolvedMissionAutoDispatchStartRun,
        deepseekProviderId: RUST_ROUTE_DEEPSEEK_PROVIDER_ID,
        deepseekFlashModel: RUST_ROUTE_DEEPSEEK_FLASH_MODEL,
        codexProviderId: RUST_ROUTE_CODEX_PROVIDER_ID,
        codexModel: RUST_ROUTE_CODEX_MODEL,
        claudeProviderId: RUST_ROUTE_CLAUDE_PROVIDER_ID,
        claudeModel: RUST_ROUTE_CLAUDE_MODEL,
      })
      : undefined;
  const missionSpineDispatch = routeMissionSpineViaRust
    ? createFridayMissionSpineDispatchAdapter({
      host: process.env.FRIDAY_HUB_AGENT_RUN_WS_HOST ?? "127.0.0.1",
      port: readMissionSpineRustWsPort(process.env.FRIDAY_HUB_AGENT_RUN_WS_PORT),
      secretResolver: resolveRustAgentRunWsClientX25519Secret,
      // DARK: present ONLY when `missionAutoDispatch` is also on (above). Absent (the default) ⇒ no
      // hook ⇒ `intakeMission` byte-identical.
      ...(missionAutoDispatchDriver ? { autoDispatchDriver: missionAutoDispatchDriver } : {}),
    })
    : null;

  // (Lane M) ORGANIC memory-confirmation POST route (DARK): construct the dispatch adapter that makes
  // `/v1/memory-spine/decide` CALLABLE — but ONLY when the operator flag is on. SINGLE SOURCE OF TRUTH =
  // `resolveRouteMemorySpineViaRust` (explicit config wins; else the `FRIDAY_MEMORY_SPINE_ROUTES_VIA_RUST`
  // env knob, case-insensitive "1"/"true" → true; anything else, incl. unset → false). With nothing set
  // (the default) this is `false`, so the adapter is NOT built, the `memorySpine` deps object is omitted
  // entirely (undefined below) → the route resolves its own default (`dispatch: null`) and returns today's
  // fail-closed 503 (`MEMORY_SPINE_DISPATCH_UNAVAILABLE`) → byte-identical.
  //
  // SIDE-EFFECT-FREE construction: the adapter factory captures host/port + the SecureStore X25519 secret
  // resolver only — it resolves NO secret and opens NO socket here. The secret is resolved + the sealed
  // client built LAZILY, per route call, so a flag-ON-but-unprovisioned host FAILS CLOSED (503) per call
  // rather than crashing boot. Config (endpoint + ECDH secret resolver) MIRRORS the mission-spine sealed-WS
  // path above; memory decisions are refs-only WS round-trips (no DB readback), same as mission.
  const routeMemorySpineViaRust = resolveRouteMemorySpineViaRust(config.routeMemorySpineViaRust);
  const memorySpineDispatch = routeMemorySpineViaRust
    ? createFridayMemorySpineDispatchAdapter({
      host: process.env.FRIDAY_HUB_AGENT_RUN_WS_HOST ?? "127.0.0.1",
      port: readMemorySpineRustWsPort(process.env.FRIDAY_HUB_AGENT_RUN_WS_PORT),
      secretResolver: resolveRustAgentRunWsClientX25519Secret,
    })
    : null;
  const routeRunOutcomeLearningViaRust = resolveRouteRunOutcomeLearningViaRust(
    config.routeRunOutcomeLearningViaRust,
  );
  const runOutcomeLearningDispatch = routeRunOutcomeLearningViaRust
    ? createFridayRunOutcomeLearningDispatchAdapter({
      host: process.env.FRIDAY_HUB_AGENT_RUN_WS_HOST ?? "127.0.0.1",
      port: readRunOutcomeLearningRustWsPort(process.env.FRIDAY_HUB_AGENT_RUN_WS_PORT),
      secretResolver: resolveRustAgentRunWsClientX25519Secret,
    })
    : null;

  // (CORE-RUNNABLE-001 / CORE-A CR-3) SESSION Rust-owned lifecycle/run bridge (DARK, default-off).
  // SINGLE SOURCE OF TRUTH for resolution = `resolveRouteSessionsViaRust` (explicit config wins; else
  // the `FRIDAY_ROUTE_SESSIONS_VIA_RUST` env knob, case-insensitive "1"/"true" → true; anything else
  // incl. unset → false). When OFF (the default) the bridge is NOT constructed and the runtime dep
  // stays unset → the session routes resolve today's fail-closed 503 → byte-identical. When ON, build
  // the REAL sealed-WS session dispatch adapter (mirrors the agent-run sealed-WS host/port/secret
  // config exactly) so the session run route is reachable-and-real; the adapter is SIDE-EFFECT-FREE
  // (resolves no secret + opens no socket until a real run). `readMissionSpineRustWsPort` parses the
  // SAME `FRIDAY_HUB_AGENT_RUN_WS_PORT` the agent-run path dials.
  const routeSessionsViaRust = resolveRouteSessionsViaRust(config.routeSessionsViaRust);
  const rustSessionLifecycleBridge = routeSessionsViaRust
    ? createFridayRustHubSessionLifecycleDispatchAdapter({
      host: process.env.FRIDAY_HUB_AGENT_RUN_WS_HOST ?? "127.0.0.1",
      port: readMissionSpineRustWsPort(process.env.FRIDAY_HUB_AGENT_RUN_WS_PORT),
      secretResolver: resolveRustAgentRunWsClientX25519Secret,
      idGenerator,
    })
    : undefined;

  const runtimeSupportedChannelKinds = FRIDAY_SUPPORTED_CHANNEL_KINDS.filter(isFridayChannelKindSupported);

  const apiRuntime = createFridayApiRuntime({
    db: stateRuntime!.sqlite,
    idGenerator,
    nowIso,
    providerService,
    memoryService,
    allowTestOnlyTsMemoryWrites: config.allowTestOnlyTsMemoryWrites,
    skillGenerator,
    converterService,
    workflowGenerator,
    skillLifecycle,
    skillRegistry: registry,
    skillExecutor: executor,
    updateSkillStatus: (skillId, status) => memoryState.updateSkillStatus(skillId, status),
    tokenSecret,
    pluginRuntimeMode,
    supportedChannelKinds: [...runtimeSupportedChannelKinds],
    enabledChannelKinds: getEnabledChannelKinds,
    activateSavedChannels: activateSavedChannelsFromSetupState,
    onSetupChannelsSaved: startReflexOnboardingAfterChannelBind,
    onSetupCompleted: markReflexEligibleAfterSetup,
    learningEventWriter,
    learningUserId: learningDefaultUserId,
    sessionService: hubSessionService,
    capabilitySnapshotGetter: getAgentCapabilitySnapshot,
    taskStatusSnapshotGetter: getAgentTaskStatusSnapshot,
    daemonStatusGetter: () => daemonService.status(),
    listMcpServers: mcpAdapter
      ? () => mcpAdapter.listServers().map((server) => ({ id: server.id, transport: server.transport }))
      : undefined,
    mcpAdapter,
    mcpConfigStore,
    serverVersion: config.serverVersion ?? FRIDAY_HUB_DEFAULT_SERVER_VERSION,
    serverHost: config.host ?? "127.0.0.1",
    serverPort: config.port ?? 3141,
    stateDir: stateRuntime.stateDir,
    managedSkillsDir: config.skillDirs[1] ?? "managed-skills",
    allowPrivateNetwork: config.ssrfPolicy?.allowPrivateNetwork,
    configManager,
    computeChecksum,
    workflowRuntime,
    pluginService: runtimePluginService,
    pluginManifestLoader,
    deterministicPipeline,
    diagnosis: {
      service: selfHealingApiService,
      agentLoop: agentLoopService,
      // Test-oracle only: production/live config leaves this unset, so the
      // diagnosis mutation surfaces fail-close. Test harnesses (real-env live
      // proof, mock-env) set it true to exercise legacy logic.
      allowTestOnlyDiagnosisExecution: config.allowTestOnlyDiagnosisExecution,
    },
    autoFix: {
      service: selfHealingApiService,
      agentLoop: agentLoopService,
      allowTestOnlyAutoFixExecution: config.allowTestOnlyAutoFixExecution,
    },
    agentLoop: {
      service: agentLoopService,
      allowTestOnlyAgentLoopRunControlExecution: config.allowTestOnlyAgentLoopRunControlExecution,
      allowTestOnlyAgentLoopPolicyMutation: config.allowTestOnlyAgentLoopPolicyMutation,
    },
    observability: observabilityService.routes,
    observabilityService,
    channels: {
      registry: channelRegistry,
      supportedKinds: [...runtimeSupportedChannelKinds],
      nowIso,
      persistPersona(kind, config) {
        const personas = loadPersistedChannelPersonas();
        if (config) {
          personas[kind] = config;
        } else {
          delete personas[kind];
        }
        savePersistedChannelPersonas(personas);
      },
    },
    system: systemRouteDeps,
    guideLens: guideLensRouteDeps,
    canonicalMutatingActionGate: canonicalMutatingActionGateEnabled,
    missionSpine: {
      workbench: missionSpineWorkbenchProjectionService,
      // (Lane B-2) DARK: `dispatch` is spread in ONLY when the route flag is on (above). With the flag
      // off the key is OMITTED entirely → the `missionSpine` deps object is structurally IDENTICAL to
      // today, the routes see `deps.dispatch === undefined`, and each POST route is fail-closed 503.
      ...(missionSpineDispatch ? { dispatch: missionSpineDispatch } : {}),
      disabledReason: null,
    },
    // (Lane M) DARK: the `memorySpine` deps object is provided ONLY when the route flag is on (above).
    // With the flag off `memorySpineDispatch` is null → this is `undefined`, the runtime falls back to
    // the route's own default (`dispatch: null`), and `POST /v1/memory-spine/decide` is fail-closed 503
    // (`MEMORY_SPINE_DISPATCH_UNAVAILABLE`) → byte-identical to today.
    memorySpine: memorySpineDispatch ? { dispatch: memorySpineDispatch } : undefined,
    runOutcomeLearning: runOutcomeLearningDispatch ? { dispatch: runOutcomeLearningDispatch } : undefined,
    // RETENTION-R3a: owner-bound retention-Settings surface (GET|PUT /v1/uix/retention-policy).
    // The route binds GET/PUT to the SINGLE canonical owner the reaper's policy
    // loader is bound to (learningDefaultUserId = admin-001) — the SAME source, so
    // what the API accepts is exactly what the per-sweep reaper reads (accept ==
    // honored). Role/scope alone is NOT canonical-owner identity: a second
    // legitimately-authenticated admin is refused. Fail-closed if unresolvable.
    retentionSettings: {
      store: retentionSettingsStore,
      resolveCanonicalOwnerId: () => learningDefaultUserId,
      // RETENTION-R3b: owner-bound disk-usage readback source (report-only; the
      // ONLY read surface for the disk-growth reading — never on any public route).
      readDiskUsage: () => diskGrowthHolder.get(),
    },
    uix: {
      service: uixService,
      readSetupCompletedAt,
      listLearnedFacts: (input: { userId: string }) =>
        selfLearningRuntime.facts.listActiveFacts({ userId: input.userId, minConfidence: 0, limit: 200 })
          .map((f) => ({ key: f.key, value: f.value, confidence: f.confidence, evidenceCount: f.evidenceCount, lastConfirmedAt: f.lastConfirmedAt })),
      deleteLearnedFact: (input: { userId: string; key: string }) =>
        selfLearningRuntime.facts.deleteFact({ userId: input.userId, key: input.key }),
      updateLearnedFact: (input: { userId: string; key: string; value?: unknown; confidence?: number }) => {
        const updated = selfLearningRuntime.facts.updateFact({
          userId: input.userId,
          key: input.key,
          value: input.value as JsonValue | undefined,
          confidence: input.confidence,
        });
        if (!updated) return null;
        return { key: updated.key, value: updated.value, confidence: updated.confidence, evidenceCount: updated.evidenceCount, lastConfirmedAt: updated.lastConfirmedAt };
      },
      clearLearnedFacts: (input: { userId: string }) => {
        const facts = selfLearningRuntime.facts.listActiveFacts({
          userId: input.userId,
          minConfidence: 0,
          limit: 1000,
        });
        let deletedCount = 0;
        for (const fact of facts) {
          if (selfLearningRuntime.facts.deleteFact({ userId: input.userId, key: fact.key })) {
            deletedCount += 1;
          }
        }
        return deletedCount;
      },
      collectLearningEvents: learningEventWriter,
      idGenerator,
    },
    crossBorderPack: {
      service: crossBorderPackService,
      // Test-oracle only: production/live config leaves this unset, so the
      // cross-border pack mutation surfaces fail-close. Test harnesses
      // (mock-env/browser-env/api-test-server) set it true to exercise legacy
      // logic.
      allowTestOnlyCrossBorderPackExecution: config.allowTestOnlyCrossBorderPackExecution,
    },
    searchHealth: resolveWebSearchHealth,
    systemHealth: getPublicSystemHealth,
    discovery,
    mcpServer,
    outboxQueueService: satelliteRuntime.outbox,
    satellitePairing: {
      registerSatellite: async (input) => satelliteRuntime.registration.register({
        type: input.type as Parameters<typeof satelliteRuntime.registration.register>[0]["type"],
        displayName: input.displayName,
        publicKey: input.publicKey,
        runtime: input.runtime,
        transport: input.transport,
        requestedByIp: input.requestedByIp,
        requestedByUserAgent: input.requestedByUserAgent,
      }),
      listPendingPairings: async () =>
        stateRuntime!.sqlite.withReadConnection((db) => {
          const rows = db.prepare(
            `SELECT
               r.id AS request_id,
               r.satellite_id,
               s.display_name,
               s.type,
               r.code,
               r.created_at,
               r.expires_at
             FROM satellite_pairing_requests r
             JOIN satellites s ON s.id = r.satellite_id
             WHERE r.status = 'pending' AND s.deleted_at IS NULL
             ORDER BY r.created_at DESC`,
          ).all() as Array<{
            request_id: string;
            satellite_id: string;
            display_name: string;
            type: string;
            code: string;
            created_at: string;
            expires_at: string;
          }>;
          return rows.map((row) => ({
            requestId: row.request_id,
            satelliteId: row.satellite_id,
            displayName: row.display_name,
            type: row.type,
            pairingCode: row.code,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
          }));
        }),
      approvePairing: async (input) => {
        const result = satelliteRuntime.pairing.approvePairing({
          ...input,
          scopes: input.scopes ?? [],
        });
        return { ...result, expiresAt: result.expiresAt ?? "" };
      },
      rejectPairing: async (input) => {
        satelliteRuntime.pairing.rejectPairing(input);
        return { rejectedAt: nowIso() };
      },
      completeHandshake: async (input) => satelliteRuntime.pairing.completeHandshake({
        ...input,
        supportedAlgorithms: (input.supportedAlgorithms ?? []) as Parameters<typeof satelliteRuntime.pairing.completeHandshake>[0]["supportedAlgorithms"],
      }),
      revokeSatellite: async (input) => {
        satelliteRuntime.pairing.revokeSatellite({
          satelliteId: input.satelliteId,
          reason: input.reason,
        });
        return { revokedAt: nowIso() };
      },
      getPairingRequest: async (satelliteId) =>
        stateRuntime!.sqlite.withReadConnection((db) => {
          const request = db.prepare(
            `SELECT *
             FROM satellite_pairing_requests
             WHERE satellite_id = ?
             ORDER BY created_at DESC
             LIMIT 1`,
          ).get(satelliteId) as {
            id: string;
            satellite_id: string;
            status: string;
            code: string;
            created_at: string;
            expires_at: string;
          } | undefined;
          if (!request) {
            return null;
          }
          const satellite = satelliteRepo.getSatellite(db, satelliteId);
          if (!satellite) {
            return null;
          }
          return {
            requestId: request.id,
            satelliteId: request.satellite_id,
            status: request.status,
            pairingCode: request.code,
            createdAt: request.created_at,
            expiresAt: request.expires_at,
          };
        }),
    },
    channelWebhooks: {
      lineWebhookRelay: lineWebhookRelay,
      whatsappWebhookRelay: whatsappWebhookRelay,
      larkWebhookRelay: larkWebhookRelay,
      telegramWebhookRelay: telegramWebhookRelay,
    },
    resolveSkill: (skillId) => {
      const skill = registry.get(skillId);
      return skill ?? null;
    },
    invokeSkill: invokeSkillForWorkflow,
    allowTestOnlyWorkflowRunExecution: config.allowTestOnlyWorkflowRunExecution,
    allowTestOnlySkillRunExecution: config.allowTestOnlySkillRunExecution,
    allowTestOnlySkillVerifyExecution: config.allowTestOnlySkillVerifyExecution,
    allowTestOnlySkillGeneratorExecution: config.allowTestOnlySkillGeneratorExecution,
    allowTestOnlyWorkflowGeneratorExecution: config.allowTestOnlyWorkflowGeneratorExecution,
    allowTestOnlyWorkflowCatalogMutationExecution: config.allowTestOnlyWorkflowCatalogMutationExecution,
    allowTestOnlyWorkflowDeployExecution: config.allowTestOnlyWorkflowDeployExecution,
    allowTestOnlyWorkflowBuilderDraftExecution: config.allowTestOnlyWorkflowBuilderDraftExecution,
    agentRuntime,
    allowTestOnlyAgentRunStartExecution: config.allowTestOnlyAgentRunStartExecution,
    // execrun-replacement slice 4 (DARK): default-false per-run Rust-route flag. SINGLE
    // SOURCE OF TRUTH for its resolution = `resolveRouteAgentRunViaRust`: an explicit config
    // boolean wins; otherwise the `FRIDAY_ROUTE_AGENT_RUN_VIA_RUST` env knob fills the gap
    // (case-insensitive "1"/"true" → true; anything else, incl. unset → false). With nothing
    // set (the default) this is `false`, so the `=== true` gate is never satisfied → the
    // predicate is never evaluated → byte-identical to today's fail-closed 503.
    routeAgentRunViaRust: resolveRouteAgentRunViaRust(config.routeAgentRunViaRust),
    // (CORE-RUNNABLE-001 / CORE-A CR-3) SESSION Rust-owned lifecycle/run bridge (DARK): the resolved
    // default-false flag + the REAL bridge (constructed above ONLY when the flag is on). With nothing
    // set (the default) `routeSessionsViaRust` is false AND `rustSessionLifecycleBridge` is undefined,
    // so the session routes resolve today's fail-closed 503 → byte-identical to today.
    routeSessionsViaRust,
    ...(rustSessionLifecycleBridge ? { rustSessionLifecycleBridge } : {}),
    // GATE-AGENT-REPLACE A3 courier (DARK): default-false master flag arming the pause/resume
    // PRODUCT TRANSPORT (the sealed WS courier's `AgentRunPaused` inbound + `resumeWithApproval`
    // relay). SINGLE SOURCE OF TRUTH = `resolveAgentRunControlViaRust` (explicit config wins; else
    // the `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST` env knob, case-insensitive "1"/"true" → true; anything
    // else incl. unset → false). With nothing set (the default) this is `false`, so the courier's
    // paused/resume behavior is inert → the compose path never sees a paused outcome → byte-identical
    // to today. It admits NO mutating run (the read-only qualifier stays hard — a SEPARATE later PR).
    agentRunControlViaRust: resolveAgentRunControlViaRust(config.agentRunControlViaRust),
    // D20 W2 signed-batch worktree PRODUCT ENTRYPOINT (DARK): default-false flag that makes the
    // owner-gated TS route callable. Rust still owns verify-only batch admission, replay, worktree
    // scope, and audit; this does not mint signatures or satisfy GO-LIVE by itself.
    d20SignedBatchWorktreeViaRust: resolveD20SignedBatchWorktreeViaRust(
      config.d20SignedBatchWorktreeViaRust,
    ),
    // providers-bridge cut-over (DARK): default-false master flag for routing the retired
    // Tier-2 PROVIDER surfaces to the merged Rust bins. SINGLE SOURCE OF TRUTH =
    // `resolveRouteProvidersViaRust` (explicit config wins; else FRIDAY_ROUTE_PROVIDERS_VIA_RUST,
    // case-insensitive "1"/"true" → true; anything else incl. unset → false). With nothing set
    // (the default) this is `false` → the route handlers' `=== true` gate is never satisfied →
    // byte-identical to today's fail-closed 503.
    routeProvidersViaRust: resolveRouteProvidersViaRust(config.routeProvidersViaRust),
    // Tier-2 WORKFLOW catalog-mutation route bridge (DARK): default-false flag routing
    // create/update/archive/publish/deploy → the Rust `hub_workflow_catalog` bin. SINGLE
    // SOURCE OF TRUTH = `resolveRouteWorkflowsViaRust` (explicit config wins; otherwise the
    // `FRIDAY_ROUTE_WORKFLOWS_VIA_RUST` env knob fills the gap, "1"/"true" → true; anything
    // else incl. unset → false). With nothing set (the default) this is `false`, so the
    // `=== true` gate is never satisfied → byte-identical to today's fail-closed retirement 503.
    routeWorkflowsViaRust: resolveRouteWorkflowsViaRust(config.routeWorkflowsViaRust),
    routeWorkflowRunsViaRust: resolveRouteWorkflowRunsViaRust(config.routeWorkflowRunsViaRust),
    allowTestOnlyAgentRunControlExecution: config.allowTestOnlyAgentRunControlExecution,
    allowTestOnlyAutonomyLifecycleExecution: configuredAllowTestOnlyAutonomyLifecycleExecution,
    allowTestOnlyStandingAgendaExecution: config.allowTestOnlyStandingAgendaExecution,
    allowTestOnlyAutonomyPolicyMutation: config.allowTestOnlyAutonomyPolicyMutation,
    allowTestOnlyCapabilityAcquisitionExecution: config.allowTestOnlyCapabilityAcquisitionExecution,
    allowTestOnlySessionExecution: config.allowTestOnlySessionExecution,
    allowTestOnlySessionRunExecution: config.allowTestOnlySessionRunExecution,
    allowTestOnlySessionMemoryExtractionExecution: config.allowTestOnlySessionMemoryExtractionExecution,
    allowTestOnlyRealtimeExecution: config.allowTestOnlyRealtimeExecution,
    allowTestOnlySkillConverterExecution: config.allowTestOnlySkillConverterExecution,
    allowTestOnlyPluginExecution: configuredAllowTestOnlyPluginExecution,
    allowTestOnlyProviderDetectExecution: config.allowTestOnlyProviderDetectExecution,
    allowTestOnlyProviderProbeExecution: config.allowTestOnlyProviderProbeExecution,
    allowTestOnlyProviderRoutingControlsExecution: config.allowTestOnlyProviderRoutingControlsExecution,
    reflexService,
    agentEventEmitter,
    resolveToolApproval,
    subagentRegistry,
    packaging: packagingDeps,
    multiTenantSecurity: multiTenantSecurityDeps,
    desktop: desktopRouteDeps,
    mediaUnderstanding: mediaUnderstandingDeps,
    socialImport: socialImportDeps,
    taskWorkflows: taskWorkflowDeps,
  });

  // (Organic mission→run binding PRODUCER — DARK) Populate the auto-dispatch driver's startRun thunk
  // now that the api runtime exists. `apiRuntime.agent?.startRun` is the ROUTING `routeStartRun`
  // (the SAME entrypoint the HTTP startRun route uses — route-qualifying for the Rust read-only path).
  // No-op assignment when the driver was never constructed (flag-OFF) or the agent surface is absent.
  if (missionAutoDispatchDriver) {
    resolvedMissionAutoDispatchStartRun = apiRuntime.agent?.startRun;
  }

  if (reflexService) {
    for (const route of createFridayReflexRoutes({ service: reflexService })) {
      apiRuntime.routes.register(route as Parameters<typeof apiRuntime.routes.register>[0]);
    }
  }

  observabilityService.health.registerCheck("api-runtime", "api", async () => ({
    name: "api-runtime",
    module: "api",
    status: "healthy",
    message: `HTTP route registry is serving ${apiRuntime.routes.getRouteCount()} routes.`,
    dependencies: [],
    lastCheckedAt: nowIso(),
    checkDurationMs: 0,
  }));
  observabilityService.health.registerCheck("learning-runtime", "learning", async () => ({
    name: "learning-runtime",
    module: "learning",
    status: "healthy",
    message: "Self-healing runtime is wired into the hub bootstrap.",
    dependencies: [],
    lastCheckedAt: nowIso(),
    checkDurationMs: 0,
  }));
  observabilityService.health.registerCheck("assistant-surface", "uix", async () => ({
    name: "assistant-surface",
    module: "uix",
    status: "healthy",
    message: "Assistant templates and wizards are available.",
    dependencies: [],
    lastCheckedAt: nowIso(),
    checkDurationMs: 0,
  }));
  if (skillGenerator) {
    observabilityService.health.registerCheck("skill-generator", "skills", async () => ({
      name: "skill-generator",
      module: "skills",
      status: "healthy",
      message: "Skill generator service is active.",
      dependencies: [],
      lastCheckedAt: nowIso(),
      checkDurationMs: 0,
    }));
  }
  if (deterministicPipeline) {
    observabilityService.health.registerCheck("workflow-pipeline", "workflows", async () => ({
      name: "workflow-pipeline",
      module: "workflows",
      status: "healthy",
      message: "Deterministic workflow pipeline routes are wired.",
      dependencies: [],
      lastCheckedAt: nowIso(),
      checkDurationMs: 0,
    }));
  }
  if (systemEnabled) {
    observabilityService.health.registerCheck("desktop-system", "desktop", async () => ({
      name: "desktop-system",
      module: "desktop",
      status: systemService ? "healthy" : "degraded",
      message: systemService
        ? "Agent OS system service is active."
        : "Agent OS system service is unavailable in this runtime.",
      dependencies: [],
      lastCheckedAt: nowIso(),
      checkDurationMs: 0,
    }));
  }
  observabilityService.scheduler.start();

  selfHealingEventPublisher = {
    publish(streamId, event, payload, correlationId) {
      apiRuntime.eventBus.publish(
        streamId,
        event as never,
        payload as never,
        correlationId,
      );
    },
  };
  workflowRealtimeEventPublisher = {
    publish(streamId, event, payload) {
      apiRuntime.eventBus.publish(
        streamId,
        event as never,
        payload as never,
      );
    },
  };

  // Flush any events that were buffered during bootstrap before the publisher was ready.
  for (const buffered of selfHealingEventBuffer) {
    selfHealingEventPublisher.publish(buffered.streamId, buffered.event, buffered.payload, buffered.correlationId);
  }
  selfHealingEventBuffer.length = 0;
  for (const buffered of workflowRealtimeEventBuffer) {
    workflowRealtimeEventPublisher.publish(buffered.streamId, buffered.event, buffered.payload);
  }
  workflowRealtimeEventBuffer.length = 0;

  // ─── Agent → Learning bridge ───
  const agentLearningBridge = createFridayAgentLearningBridge({
    eventEmitter: agentEventEmitter,
    learningEventWriter,
    idGenerator,
    nowIso,
    defaultUserId: learningDefaultUserId,
  });
  agentLearningBridge.start();

  // Register feedback tool (late-bound — learning runtime created after tool registry).
  const feedbackTool = createFridayAgentFeedbackTool({ learningEventWriter, idGenerator, nowIso, defaultUserId: learningDefaultUserId });
  agentRuntime.registerTool(feedbackTool);

  for (const route of createFridaySatelliteRuntimeRoutes({
    recordHeartbeat: (input) => satelliteRuntime.heartbeat.recordHeartbeat(input),
    updateCapabilities: (report) => satelliteRuntime.capabilities.updateCapabilities(report),
    pullSync: (input) => satelliteRuntime.sync.pull(input),
    pushSync: (input) => satelliteRuntime.sync.push(input),
    pollCommands: ({ satelliteId, limit, leaseMs }) => {
      const leased = satelliteRuntime.outbox.leaseBatch({
        satelliteId,
        limit: limit ?? 25,
        leaseMs: leaseMs ?? 60_000,
      });
      return leased.map((item) => ({
        id: item.id,
        seq: item.seq,
        messageType: item.messageType,
        payload: item.payloadCiphertext,
      }));
    },
    ackCommand: ({ satelliteId, commandId }) =>
      satelliteRuntime.outbox.ackMessage({
        satelliteId,
        messageId: commandId,
      }),
    reportCommandResult: async (input) => {
      await workflowRuntime.execution.reportRemoteNodeResult({
        satelliteId: input.satelliteId,
        runId: input.runId,
        nodeId: input.nodeId,
        attemptId: input.attemptId,
        attempt: input.attempt,
        status: input.status,
        output: input.output as JsonValue | undefined,
        error: input.error
          ? {
            code: input.error.code,
            message: input.error.message,
            retryable: input.error.retryable,
            details: input.error.details as JsonValue | undefined,
          }
          : undefined,
      });
    },
    pullEvents: ({ streamId, afterSeq, limit }) =>
      apiRuntime.subscriptions.pullEvents(streamId, afterSeq, limit),
    getCheckpoint: ({ principalId, streamId }) =>
      apiRuntime.subscriptions.getCheckpoint(principalId, streamId),
  })) {
    apiRuntime.routes.register(route as Parameters<typeof apiRuntime.routes.register>[0]);
  }

  // ─── Skill Scan & Migrate routes ───

  const scanMigrateRoutes = createFridayScanMigrateRoutes({
    scanLocal: scanLocalSkills,
    getCommunitySkills: getCommunitySkillCatalog,
    convertSkill: async (sourcePath, formatHint) => {
      try {
        const result = await converterService.convert({
          source: { uri: sourcePath },
          formatHint: (formatHint ?? "auto") as FridaySkillSourceFormat | "auto",
          dryRun: true,
        });
        const firstDraft = result.drafts[0];
        return {
          success: true,
          skillId: firstDraft?.manifest.id,
          mode: "preview" as const,
        };
      } catch (err) {
        const rawMessage = err instanceof Error ? err.message : "Conversion preview failed";
        return {
          success: false,
          error: redactFridaySkillSourceText(rawMessage, { uri: sourcePath }),
        };
      }
    },
    allowTestOnlyScanMigrateExecution: config.allowTestOnlyScanMigrateExecution,
  });
  for (const route of scanMigrateRoutes) {
    apiRuntime.routes.register(route as Parameters<typeof apiRuntime.routes.register>[0]);
  }

  // ─── Memory File Sync service ───

  let memoryFileSyncService: FridayMemoryFileSyncService | undefined;
  if (stateRuntime) {
    const syncRepo = createFridayMemoryFileSyncRepository({ db: stateRuntime.sqlite });
    memoryFileSyncService = createFridayMemoryFileSyncService({
      repository: syncRepo,
      stateDir: workspaceRoot,
      nowIso,
    });
  }

  // ─── Session memory extraction service (for lifecycle + extraction jobs) ───

  let sessionExtractionService: ReturnType<typeof createFridaySessionMemoryExtractionService> | undefined;
  if (stateRuntime && memoryService) {
    sessionExtractionService = createFridaySessionMemoryExtractionService({
      db: stateRuntime.sqlite,
      sessionService: hubSessionService,
      memoryService,
      providerService,
      idGenerator,
      nowIso,
      // TS Runtime Retirement (TS-R4/G3 method-level guard): production leaves
      // this unset so extractFromSession/extractSpecificMessages/
      // retryFailedExtractions are fail-closed for the `session-memory-extraction`
      // worker job, the `session-lifecycle-sweep` job, and the agent
      // memory-extract tool — all of which reach this instance off-route,
      // bypassing the HTTP route guard. This stops the armed quota-spending
      // inline extraction on next deploy. Test-oracle hub configs set it true.
      allowTestOnlySessionMemoryExtractionExecution:
        config.allowTestOnlySessionMemoryExtractionExecution,
    });
  }

  // OC-013: Register memory extraction tool (late-bound — extraction service created after tool registry)
  if (sessionExtractionService) {
    const memoryExtractTool = createFridayAgentMemoryExtractTool({ extractionService: sessionExtractionService });
    agentTools.push(memoryExtractTool);
    agentRuntime.registerTool(memoryExtractTool);
  }

  // ─── Heartbeat runner (periodic proactive checks) ───

  const heartbeatEnabled = capabilityGates.heartbeatEnabled;
  const heartbeatIntervalMs = Math.max(
    60_000,
    Number(process.env.FRIDAY_HEARTBEAT_INTERVAL_MS ?? "900000"),
  );
  const heartbeatCooldownMs = Math.max(
    0,
    Number(process.env.FRIDAY_HEARTBEAT_COOLDOWN_MS ?? "1800000"),
  );
  const heartbeatTimeoutMs = Math.max(
    5_000,
    Number(process.env.FRIDAY_HEARTBEAT_TIMEOUT_MS ?? "120000"),
  );

  let heartbeatJob: ReturnType<typeof createFridayHeartbeatJob> | undefined;
  if (stateRuntime && heartbeatEnabled) {
    const heartbeatRepo = createFridayHeartbeatStateRepository({
      db: stateRuntime.sqlite,
      nowIso,
    });

    // Wire heartbeat state into observability for GET /v1/heartbeat/status
    heartbeatStateRef = () => {
      const state = heartbeatRepo.getState();
      const runs = heartbeatRepo.listRuns(1);
      const latest = runs[0];
      return {
        lastRunAt: latest?.startedAt ?? state.lastRunAt ?? null,
        result: latest?.status ?? "pending",
        intervalMs: heartbeatIntervalMs,
        nextRunAt: null,
      };
    };

    const heartbeatRunner = createFridayHeartbeatRunner({
      config: {
        enabled: true,
        intervalMs: heartbeatIntervalMs,
        cooldownMs: heartbeatCooldownMs,
        timeoutMs: heartbeatTimeoutMs,
        sessionKey: process.env.FRIDAY_HEARTBEAT_SESSION_KEY ?? "system:default:heartbeat",
        principalId: process.env.FRIDAY_HEARTBEAT_PRINCIPAL_ID ?? "system",
        tenantContext: {
          hubId: "default",
          userId: process.env.FRIDAY_HEARTBEAT_PRINCIPAL_ID ?? "system",
          channelKind: "heartbeat",
        },
        promptPath: process.env.FRIDAY_HEARTBEAT_PROMPT_PATH,
        fallbackPrompt:
          "Run a proactive system heartbeat check. If there is no urgent action needed, respond only with HEARTBEAT_OK. " +
          "If action is needed, provide a concise actionable summary.",
        timezone: process.env.FRIDAY_HEARTBEAT_TZ,
        activeHours: {
          enabled: capabilityGates.heartbeatActiveHoursEnabled,
          startHour: Number(process.env.FRIDAY_HEARTBEAT_ACTIVE_START_HOUR ?? "9"),
          endHour: Number(process.env.FRIDAY_HEARTBEAT_ACTIVE_END_HOUR ?? "21"),
          timezone: process.env.FRIDAY_HEARTBEAT_TZ,
        },
      },
      repository: heartbeatRepo,
      agentRuntime,
      nowIso,
      idGenerator,
      loadHistoryMessages: async (sessionKey, limit) => {
        const records = await hubSessionService.getMessages(sessionKey, limit).catch(() => []);
        const mapped = records
          .map((message) => mapSessionMessageToAgentMessage(message))
          .filter((message): message is FridayAgentMessage => message !== null)
          .filter((message): message is { role: "user" | "assistant"; content: string } =>
            typeof message.content === "string");
        return mapped;
      },
      onActionRequired: async (result) => {
        if (!result.responseText || result.responseText.trim().length === 0) return;
        await hubSessionService.addMessage(
          process.env.FRIDAY_HEARTBEAT_SESSION_KEY ?? "system:default:heartbeat",
          {
            role: "assistant",
            content: result.responseText,
            contentText: result.responseText,
            idempotencyKey: `heartbeat:${result.runId ?? nowIso()}`,
            metadata: { source: "heartbeat" },
          },
        );
      },
    });

    heartbeatJob = createFridayHeartbeatJob({ runner: heartbeatRunner });
    heartbeatTriggerRef = () => heartbeatJob!.run();
  }

  // ─── Unified Job Scheduler (F10: register ALL job modules) ───

  let jobScheduler: FridayJobSchedulerService | undefined;
  let schedulerRepo: FridayJobSchedulerRepository | undefined;
  // F1.5 self-probe last-outcome holder — the in-product diagnostic readback surface. Only
  // assigned when the default-OFF FRIDAY_RUST_ROUTE_DIAGNOSTIC_ENABLED flag is on; stays
  // undefined (no diagnostic) otherwise. Read-only outcome; NEVER holds the bearer.
  let rustRouteProbeOutcomeHolder: RustRouteProbeOutcomeHolder | undefined;
  if (stateRuntime) {
    schedulerRepo = createFridayJobSchedulerRepository({ db: stateRuntime.sqlite });
    const schedulerRepoRef = schedulerRepo;

    // Build workflow cron trigger job
    const cronTriggerJob = createFridayWorkflowCronTriggerJob({
      triggerService: workflowRuntime.triggers,
      nowIso,
    });

    // Build workflow timeout sweep job
    const timeoutJob = createFridayWorkflowTimeoutJob({
      executionService: workflowRuntime.execution,
      nowIso,
    });

    // Build all scheduler job definitions
    const schedulerJobs: Array<FridayScheduledJobDefinition> = [
      {
        id: "workflow-cron-trigger",
        intervalMs: 60_000, // every 60s
        timeoutMs: 300_000, // 5 min
        catchUpRuns: 1,
        run: async () => { await cronTriggerJob.run(); },
      },
      {
        id: "workflow-timeout-sweep",
        intervalMs: 30_000, // every 30s
        timeoutMs: 120_000, // 2 min
        catchUpRuns: 1,
        run: async () => { await timeoutJob.run(); },
      },
    ];

    // Session lifecycle sweep — RETIRED (SEV-1 stop-the-fail-loop).
    // The `session-lifecycle-sweep` job's handler called sessionService.sweepLifecycle(),
    // which is fail-closed (TS_RUNTIME_SESSION_RETIRED, 503) in default/live runtime.
    // A recurring sweep against a retired method fail-loops forever (the scheduler
    // never auto-disables a recurring failer; it markFailed → reschedule with capped
    // backoff). The job is no longer registered here so start() does not re-seed its
    // row enabled=1; the persisted row (if any) is disabled below via
    // schedulerRepoRef.disableJob so it is excluded from BOTH due-selection and the
    // min-wake computation (no busy-spin). The Rust-owned session_lifecycle entrypoint
    // is a separate operator-gated Phase-1/2 replacement.

    // Session memory extraction worker
    if (sessionExtractionService) {
      const extractionWorkerJob = createFridaySessionMemoryExtractionWorkerJob({
        db: stateRuntime.sqlite,
        extractionService: sessionExtractionService,
        nowIso,
      });
      schedulerJobs.push({
        id: "session-memory-extraction",
        intervalMs: 60_000, // every 60s
        timeoutMs: 600_000, // 10 min
        catchUpRuns: 1,
        run: async () => { await extractionWorkerJob.run(); },
      });
    }

    if (heartbeatJob && heartbeatEnabled) {
      schedulerJobs.push({
        id: "heartbeat-runner",
        intervalMs: heartbeatIntervalMs,
        timeoutMs: heartbeatTimeoutMs,
        catchUpRuns: 1,
        run: async () => {
          await heartbeatJob!.run();
        },
      });
    }

    // Retention sweep — cleans stale pairing requests, heartbeats, outbox, learning events, skill runs
    schedulerJobs.push({
      id: "retention-sweep",
      intervalMs: 3_600_000, // every 1h
      timeoutMs: 300_000, // 5 min
      catchUpRuns: 1,
      run: async () => { satelliteRuntime.retention.run(); },
    });

    // Learning metrics daily aggregation
    {
      const learningMetricsJob = createFridayLearningMetricsJob({
        metricsService: selfLearningRuntime.metrics,
        nowIso,
      });
      schedulerJobs.push({
        id: "learning-metrics-daily",
        intervalMs: 86_400_000, // every 24h
        timeoutMs: 120_000, // 2 min
        catchUpRuns: 1,
        run: async () => { learningMetricsJob.run(); },
      });
    }

    // Approval expiry sweep — expires stale pending approval requests
    {
      const approvalExpiryJob = createFridayApprovalExpiryJob({
        approvalService: selfLearningRuntime.approvals,
        nowIso,
      });
      schedulerJobs.push({
        id: "approval-expiry-sweep",
        intervalMs: 300_000, // every 5 min
        timeoutMs: 60_000, // 1 min
        catchUpRuns: 1,
        run: async () => { approvalExpiryJob.run(); },
      });
    }

    // Auto-fix dispatcher — executes planned low-risk actions.
    {
      const autoFixDispatchEnabled = capabilityGates.autoFixDispatchEnabled;
      if (autoFixDispatchEnabled) {
        const intervalRaw = Number(process.env.FRIDAY_AUTOFIX_DISPATCH_INTERVAL_MS ?? "60000");
        const limitRaw = Number(process.env.FRIDAY_AUTOFIX_DISPATCH_LIMIT ?? "10");
        const intervalMs = Math.max(30_000, Number.isFinite(intervalRaw) ? intervalRaw : 60_000);
        const limit = Math.max(1, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 10);
        const maxRiskTier = process.env.FRIDAY_AUTOFIX_MAX_RISK_TIER === "0" ? 0 : 1;

        schedulerJobs.push({
          id: "autofix-dispatch",
          intervalMs,
          timeoutMs: 120_000, // 2 min
          catchUpRuns: 1,
          run: async () => {
            const results = await selfLearningRuntime.autoFixDispatcher.runReadyActions({
              maxRiskTier,
              limit,
            });
            for (const result of results) {
              const action = selfHealingApiService.getAction({
                actionId: result.action.actionId,
              });
              if (action) {
                selfHealingEventPublisher?.publish(
                  result.action.rolledBackAt ? "workflow:self-healing" : "workflow:self-healing",
                  result.action.status === "rolled_back"
                    ? "autofix.action.rolled_back"
                    : "autofix.action.executed",
                  {
                    actionId: action.action.actionId,
                    incidentId: action.action.incidentId,
                    runId: action.incident?.runId,
                    riskTier: action.action.riskTier,
                    status: action.action.status,
                    outcome: action.action.outcome,
                    approvalStatus: action.approval?.status,
                  },
                  action.action.actionId,
                );
              }
            }
          },
        });
      }
    }

    // Agent-loop cooldown sweep — RETIRED (SEV-1 stop-the-fail-loop, latent twin).
    // The `agent-loop-cooldown-sweep` job's handler called
    // agentLoopService.resumeCooldownRuns() → executeRun → executionService.execute(),
    // which is fail-closed (TS_RUNTIME_AUTOFIX_EXECUTION_RETIRED, 503) in default/live
    // runtime. It does not fire today only because it queries cooldown rows first and
    // there are none — but its terminal action is already retired, so it can never do
    // work and becomes an infinite fail-loop the instant any cooldown loop-run row
    // exists. The job is no longer registered here so start() does not re-seed its row
    // enabled=1; the persisted row (if any) is disabled below via
    // schedulerRepoRef.disableJob so it is excluded from BOTH due-selection and the
    // min-wake computation (no busy-spin). The Rust-owned auto-fix execution entrypoint
    // is a separate operator-gated Phase-1/2 replacement.

    // System self-health monitor: periodic diagnose-only checks; maintenance cleanup requires an explicit gate.
    {
      const {
        createFridaySystemHealthMonitor,
        createFridayHealthLogDeduper,
        healthCheckStatusLabel,
      } = await import("../learning/services/friday-system-health-monitor.js");
      // One-time setup (persists across ticks): a transition-only log deduper so
      // a persistently large table never spams a warning every 5 minutes. Per the
      // #1606 split, the report-only realtime_events growth reading is surfaced
      // ONLY via these transition-only logs — it is NOT published to any
      // observability route / HTTP surface (owner-authorized readback is deferred
      // to R3). Report-only — none of this deletes anything.
      const systemHealthLogDeduper = createFridayHealthLogDeduper();
      schedulerJobs.push({
        id: "system-health-monitor",
        intervalMs: 300_000, // every 5 min
        timeoutMs: 60_000,
        catchUpRuns: 1,
        run: async () => {
          const monitor = createFridaySystemHealthMonitor({
            db: stateRuntime!.sqlite,
            nowIso,
            // RETENTION-R3b: report-only free-space probe for the `disk_growth`
            // check. Node >=22 provides statfsSync; fail-closed to `null` on any
            // throw/unsupported platform so the evaluator reports `unknown` (never
            // a false healthy). Never reads or writes any DB row.
            probeDiskSpace: () => {
              try {
                const st = fs.statfsSync(stateRuntime!.stateDir);
                const freeBytes = st.bavail * st.bsize;
                const totalBytes = st.blocks * st.bsize;
                if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes)) return null;
                return { freeBytes, totalBytes };
              } catch {
                return null;
              }
            },
            // U13 projected-exhaustion branch: no AUTHORITATIVE growth-window
            // measurement exists in the TS runtime yet, so the growth rate is
            // UNKNOWN today. Returning null is the HONEST fail-closed posture — per
            // U13, above the max(10 GiB, 10%) free-space floor the disk_growth
            // reading reports `unknown` (healthy=false), NEVER a false healthy `ok`;
            // below the floor it still warns (the live authoritative signal). An
            // authoritative bytes/day growth-window measurement is the named R3c
            // follow-up; it will replace this null with a real rate so the 7-day
            // projected-exhaustion warning becomes observable.
            probeGrowthRateBytesPerDay: () => null,
            onRunComplete: (summary) => {
              // Log an unhealthy/warn/critical/degraded check only on a status
              // TRANSITION; feed healthy statuses too so a recovery resets state
              // and the next regression re-alerts.
              for (const check of summary.checks) {
                const status = healthCheckStatusLabel(check);
                if (check.healthy) {
                  systemHealthLogDeduper.shouldLog(check.name, status);
                  continue;
                }
                if (systemHealthLogDeduper.shouldLog(check.name, status)) {
                  console.warn(
                    `[friday][system-health] ${check.name}: ${status} (${String(check.value)} ${check.unit})`,
                  );
                }
              }
              for (const recommendation of summary.maintenanceRecommendations) {
                console.warn(
                  `[friday][system-health] maintenance ${recommendation.name}: ${recommendation.detail}; explicit maintenance gate required`,
                );
              }
              for (const receipt of summary.maintenanceReceipts) {
                console.warn(`[friday][system-health] maintenance ${receipt.name}: ${receipt.detail}`);
              }
            },
          });
          const summary = monitor.runAll();
          // RETENTION-R3b: refresh the report-only disk-usage snapshot that the
          // owner-bound GET /v1/uix/retention-policy/disk-usage serves. Held in
          // memory only (derived/observable; never persisted as canonical).
          const diskDetail = summary.checks.find((c) => c.name === "disk_growth")?.detail as
            | FridayDiskGrowthWarning
            | undefined;
          if (diskDetail) {
            diskGrowthHolder.set(diskDetail);
          }
        },
      });
    }

    // F1.5 — Headless Rust-route self-probe diagnostic (DARK, DEFAULT-OFF; OPTION-1 / H-b).
    // WHEN ENABLED by the operator via FRIDAY_RUST_ROUTE_DIAGNOSTIC_ENABLED=true ONLY, this
    // recurring read-only self-probe lands ONE qualifying agent-run through the LIVE Rust
    // read-only route (in-process loopback POST /v1/agent/runs with a self-minted, sessionless,
    // short-lived, agent.run-only admin-001 bearer — the EXACT slice6 H-b path; no new trust
    // surface, no direct routeStartRun caller). Each successful tick produces a REAL
    // token_ledger row in rust-hub.sqlite. HONEST LABEL: "recurring REAL row, WEAKLY organic
    // (system-initiated)" — NOT strictly organic. ENABLING = recurring REAL DeepSeek spend
    // (operator gate; default cadence hourly, 5-min floor). Default-OFF by construction: when
    // the flag is unset/anything-but-"true", maybeBuildRustRouteSelfProbeJob returns null ⇒ the
    // job is never pushed ⇒ never registered ⇒ never fires. A failed probe is log-and-continue
    // (runRustRouteSelfProbe never throws) so the recurring job cannot become a crash/fail-loop.
    {
      const diagnosticConfig = resolveRustRouteDiagnosticConfig(process.env);
      if (diagnosticConfig.enabled) {
        const probeHost = config.host ?? process.env.FRIDAY_HOST ?? "127.0.0.1";
        const probePort = config.port ?? parseFridayHubPort(process.env.FRIDAY_PORT) ?? 3141;
        rustRouteProbeOutcomeHolder = createRustRouteProbeOutcomeHolder();
        const probeJob = maybeBuildRustRouteSelfProbeJob(diagnosticConfig, {
          tokenSecret,
          nowIso,
          idGenerator,
          providerService,
          transport: createRustRouteLoopbackTransport({ host: probeHost, port: probePort }),
          outcomeHolder: rustRouteProbeOutcomeHolder,
        });
        if (probeJob) {
          schedulerJobs.push(probeJob);
          console.warn(
            `[friday][rust-route-self-probe] ENABLED — recurring REAL DeepSeek spend every `
            + `${Math.round(diagnosticConfig.intervalMs / 1000)}s (weakly organic, system-initiated). `
            + `Verify landings via token_ledger in rust-hub.sqlite (fallback=0, total_tokens>0).`,
          );
        }
      }
    }

    jobScheduler = createFridayJobSchedulerService({
      repository: schedulerRepoRef,
      nowIso,
      jobs: schedulerJobs,
    });
    const schedulerService = jobScheduler;

    // SEV-1 stop-the-fail-loop: disable the two retired recurring sweeps' persisted
    // rows. Removing the registration alone is NOT enough — the rows are already
    // persisted enabled=1 with a next_run_at, and start() does not re-enable existing
    // rows, but a row left enabled=1 with a def absent from the in-memory map is the
    // busy-spin trap: the run loop skips it (no jobDef) yet the min-wake computation
    // still sees it (enabled + nextRunAt), so once next_run_at is in the past,
    // delayMs=max(0,past)=0 → armTimer(0) spins every event-loop turn (STRICTLY worse
    // than the original 120s/60s fail-loop). disableJob sets enabled=0 AND
    // next_run_at=NULL, excluding the row from BOTH listDue (WHERE enabled=1) and the
    // min-wake (skips !enabled || !nextRunAt) → loop stops, no spin, no orphaned state
    // (the guarded write-txn never ran). On a fresh DB these are harmless no-op UPDATEs.
    // Runs before jobScheduler.start(), so start()'s seed loop will not re-create them.
    schedulerRepoRef.disableJob("session-lifecycle-sweep", nowIso());
    schedulerRepoRef.disableJob("agent-loop-cooldown-sweep", nowIso());

    // F1.5 stop-the-spin: if the Rust-route self-probe is NOT enabled this boot, disable any row
    // a PRIOR enabled boot persisted (enabled=1, next_run_at set). Enable→disable is the expected
    // operator lifecycle (turn it on to land rows, off to stop spend). Without this, a disabled
    // boot leaves the row enabled=1 with NO in-memory def → the exact orphan busy-spin trap
    // described above (run loop skips it, but min-wake still sees it → armTimer(0) spins once
    // next_run_at passes). disableJob clears enabled + next_run_at; harmless no-op on a fresh DB.
    // Runs before start() so its seed loop will not re-create the row.
    if (!resolveRustRouteDiagnosticConfig(process.env).enabled) {
      schedulerRepoRef.disableJob(RUST_ROUTE_DIAGNOSTIC_JOB_ID, nowIso());
    }

    // Link agent automations to the unified scheduler.
    if (apiRuntime.agentAutomationService) {
      const automationService = apiRuntime.agentAutomationService;
      const toAutomationJobId = (automationId: string) => `agent-automation:${automationId}`;

      automationService.attachSchedulerBridge({
        sync(automation) {
          const now = nowIso();
          const jobId = toAutomationJobId(automation.id);

          if (!automation.enabled || !automation.schedule || automation.schedule.type !== "cron") {
            schedulerRepoRef.disableJob(jobId, now);
            return;
          }

          const nextRunAtMs = computeNextRunAtMs(
            {
              kind: "cron",
              cronExpr: automation.schedule.cron,
              tz: automation.schedule.timezone,
            },
            Date.now(),
          );
          if (nextRunAtMs == null) {
            schedulerRepoRef.disableJob(jobId, now);
            throw new FridayDomainError("VALIDATION_ERROR", `Invalid cron schedule for automation ${automation.id}`, { httpStatus: 400 });
          }

          schedulerRepoRef.upsert({
            id: jobId,
            intervalMs: 0,
            timeoutMs: 900_000,
            catchUpRuns: 1,
            nowIso: now,
            scheduleKind: "cron",
            scheduleCronExpr: automation.schedule.cron,
            scheduleTz: automation.schedule.timezone ?? null,
          });
          schedulerRepoRef.enableJob(jobId, now);
          schedulerRepoRef.setNextRunAt(jobId, new Date(nextRunAtMs).toISOString(), now);

          schedulerService.registerDynamicJob({
            id: jobId,
            schedule: {
              kind: "cron",
              cronExpr: automation.schedule.cron,
              tz: automation.schedule.timezone,
            },
            timeoutMs: 900_000,
            catchUpRuns: 1,
            run: async () => {
              const latest = automationService.get(automation.id);
              if (!latest || !latest.enabled) return;
              const result = await automationService.run(automation.id);
              if (result.status !== "completed") {
                const suffix = result.response.trim().length > 0
                  ? `: ${result.response}`
                  : "";
                throw new FridayDomainError("INTERNAL_ERROR", `[E-SCHED-AUTOMATION-RUN-FAILED] Automation ${automation.id} finished with status ${result.status}${suffix}`, { httpStatus: 500 });
              }
            },
          });
          schedulerService.wakeNow("agent automation schedule synced");
        },

        remove(automation) {
          const now = nowIso();
          schedulerRepoRef.disableJob(toAutomationJobId(automation.id), now);
        },
      });

      automationService.syncScheduledAutomations();
    }

    // Wire cron tool now that scheduler repo + service are available.
    // Register in both the array (for LLM schema) AND runtime toolMap (for execution).
    {
      const cronTool = createFridayAgentCronTool({
        schedulerRepository: schedulerRepoRef,
        schedulerService: jobScheduler,
        dynamicJobRunner: (jobId, payload) => {
          // Return an async function that the scheduler invokes on each cron tick.
          // It executes the task via the agent runtime, enabling LLM-created cron jobs
          // to actually perform work instead of logging a no-op warning.
          return async () => {
            const task = typeof payload.task === "string" ? payload.task : `Execute scheduled job: ${jobId}`;
            const scheduleTimezone = schedulerRepoRef.getById(jobId)?.scheduleTz ?? undefined;
            const payloadTimezone = typeof payload.timezone === "string" && payload.timezone.trim().length > 0
              ? payload.timezone.trim()
              : undefined;
            const result = await agentRuntime.executeRun({
              task,
              sessionKey: `cron:${jobId}`,
              timezone: payloadTimezone ?? scheduleTimezone,
            });
            return { runId: result.runId, status: result.status };
          };
        },
      });
      agentTools.push(cronTool);
      agentRuntime.registerTool(cronTool);
    }
  }

  // ─── Register remaining dependency-gated tools ───
  // These tools are dependency-gated in the registry factory but their deps
  // weren't passed during initial construction. Register them now with
  // graceful stubs for services that aren't available yet.

  // 1. agents_list + subagent spawn/list/get — subagentRegistry is ready
  {
    const agentsListTool = createFridayAgentAgentsListTool({ subagentRegistry });
    agentTools.push(agentsListTool);
    agentRuntime.registerTool(agentsListTool);

    const topLevelSubagentContext = {
      depth: 0,
      parentRunId: "root",
      parentSessionKey: "agent:run:root",
      rootRunId: "root",
    };

    const subagentTools = createFridayAgentSubagentTools({
      registry: subagentRegistry,
      subagentContext: topLevelSubagentContext,
      forkModeEnabled: subagentForkModeEnabled,
    });
    for (const tool of subagentTools) {
      agentTools.push(tool);
      agentRuntime.registerTool(tool);
    }
  }

  // 2. image_analysis — stub analyzeImages via provider service (vision model)
  const analyzeImages: FridayImageAnalysisFn = async (request, signal) => {
    // Use the provider service to resolve a vision-capable model and call it.
    const requestedModel = typeof request.model === "string" && request.model.trim().length > 0
      ? request.model.trim()
      : undefined;
    const { result } = await providerService.runWithFallback({
      requestedProviderId: request.providerId,
      requestedModel,
      tenantContext: request.tenantContext,
      routingContext: {
        estimatedInputTokens: 0,
        complexity: "medium",
        requiredCapabilities: ["vision"],
      },
      run: async (_route, credential) => {
        const innerClient = createFridayAgentLlmClient({
          baseUrl: _route.provider.baseUrl,
          apiKey: credential ?? "",
          api: _route.provider.config.api,
          backendKind: _route.provider.config.backendKind,
          cliConfig: _route.provider.config.cliConfig,
          authMode: _route.provider.config.authMode,
          allowPrivateNetwork: config.ssrfPolicy?.allowPrivateNetwork,
        });
        let text = "";
        let inputTokens = 0;
        let outputTokens = 0;
        let responseModel = _route.model;

        for await (const event of innerClient.stream({
          model: _route.model,
          systemPrompt: "Analyze the provided image(s) and answer the user's request directly.",
          messages: [{
            role: "user",
            content: [
              { type: "text", text: request.prompt },
              ...request.images.map((img) => ({
                type: "image" as const,
                source: img.type === "url"
                  ? { type: "url" as const, url: img.url! }
                  : {
                      type: "base64" as const,
                      media_type: img.mimeType ?? "image/png",
                      data: img.data!,
                    },
              })),
            ],
          }],
          tools: [],
          signal,
          tenantContext: request.tenantContext,
        })) {
          if (event.type === "text_delta") {
            text += event.text;
          } else if (event.type === "message_end") {
            inputTokens = event.inputTokens;
            outputTokens = event.outputTokens;
            responseModel = event.actualModel ?? responseModel;
          }
        }

        return {
          text,
          model: responseModel,
          inputTokens,
          outputTokens,
        };
      },
    });

    return result;
  };

  {
    const imageAnalysisTool = createFridayAgentImageAnalysisTool({
      analyzeImages,
      workspaceRoot,
    });
    agentTools.push(imageAnalysisTool);
    agentRuntime.registerTool(imageAnalysisTool);
  }

  let autonomousEngine!: FridayAutonomousEngine;
  let setupRecipeRegistry: ReturnType<typeof createFridaySetupRecipeRegistry> | undefined;
  // 3. autonomous + setup — late-bind after runtime construction to avoid
  // circular dependency on agentRuntime during initial tool registry creation.
  {
    const autonomousAnalyzeImages = (
      request: {
        prompt: string;
        images: readonly { type: "base64" | "url"; data?: string; url?: string; mimeType?: string }[];
        providerId?: string;
        model?: string;
        detail: "low" | "high" | "auto";
        maxTokens?: number;
      },
      signal: AbortSignal,
    ) => analyzeImages({
      ...request,
      images: request.images.map((image) => ({ ...image })),
    }, signal);
    const autonomousDesktopManager = desktopSessionManager
      ? {
          isConnected: () => desktopSessionManager.isConnected(),
          executeAction: (action: Record<string, unknown>) =>
            desktopSessionManager.executeAction(action as never),
          searchElements: (query: string, appBundleId?: string) =>
            desktopSessionManager.searchElements(query, appBundleId).then((elements) => [...elements]),
        }
      : undefined;
    const autonomousBrowserManager = browserManager
      ? {
          launch: async (sessionId: string) => {
            await browserManager.launch(sessionId);
          },
          close: async (sessionId: string) => {
            await browserManager.close(sessionId);
          },
          screenshot: async (sessionId: string) => {
            const { page } = await browserManager.getPage(
              sessionId,
              { createIfMissing: true },
            );
            return {
              base64: (await page.screenshot({ type: "png" })).toString("base64"),
            };
          },
          snapshot: async (sessionId: string) => ({
            content: await browserManager.snapshotAria(sessionId),
          }),
          title: async (sessionId: string) => {
            const { page } = await browserManager.getPage(
              sessionId,
              { createIfMissing: true },
            );
            return {
              title: await page.title(),
            };
          },
          url: async (sessionId: string) => {
            const { page } = await browserManager.getPage(
              sessionId,
              { createIfMissing: true },
            );
            return {
              url: page.url(),
            };
          },
          act: async (sessionId: string, action: string, args: Record<string, unknown>) => {
            const { page } = await browserManager.getPage(
              sessionId,
              { createIfMissing: true },
            );

            switch (action) {
              case "click":
                if (typeof args.selector !== "string") {
                  throw new FridayDomainError("VALIDATION_ERROR", "Browser action \"click\" requires a string selector.", { httpStatus: 400 });
                }
                await page.click(args.selector);
                return { ok: true };
              case "fill":
                if (typeof args.selector !== "string" || typeof args.value !== "string") {
                  throw new FridayDomainError("VALIDATION_ERROR", "Browser action \"fill\" requires selector and value strings.", { httpStatus: 400 });
                }
                await page.fill(args.selector, args.value);
                return { ok: true };
              default:
                throw new FridayDomainError("VALIDATION_ERROR", `Unsupported browser action "${action}" in autonomous wrapper.`, { httpStatus: 400 });
            }
          },
          navigate: async (sessionId: string, url: string) => {
            const { page } = await browserManager.getPage(
              sessionId,
              { createIfMissing: true },
            );
            await page.goto(url);
          },
        }
      : undefined;
    // Shared mapping from autonomous goalId → agent runId.
    // The autonomous tool writes entries; the event bridge reads them.
    const autonomousGoalRunIdMap: Map<string, string> = new Map();

    const autonomousRepo = createFridayAutonomousRepository();
    autonomousEngine = createFridayAutonomousEngine({
      // Anchor the autonomous engine's deterministic file verifier to the same
      // workspace root the agent write/edit tools use (createFridayAgentToolRegistry
      // workdir above). Without this the engine fell back to process.cwd() and
      // rejected files the agent legitimately wrote under the hub workspace as
      // "Path is outside the autonomous workspace root", breaking autonomous
      // file ops (self-repair, office-task writes) and the restart-resume proof.
      workspaceRoot,
      agentRuntime: {
        executeRun: (params) =>
          agentRuntime.executeRun({
            ...params,
            disabledToolNames: ["autonomous", "setup", "setup_assistant"],
          }),
      },
      toolExecutor: async (toolName, args, signal) => {
        const tool = [...agentTools].reverse().find((candidate) => candidate.name === toolName);
        if (!tool) {
          throw new FridayDomainError("NOT_FOUND", `Autonomous tool "${toolName}" is not registered.`, { httpStatus: 404 });
        }
        return tool.execute(args, signal);
      },
      analyzeImages: autonomousAnalyzeImages,
      desktopSessionManager: autonomousDesktopManager,
      browserManager: autonomousBrowserManager,
      idGenerator,
      nowIso,
      persistence: {
        sqlite: stateRuntime!.sqlite,
        repository: autonomousRepo,
      },
      eventEmitter: {
        emit: (event, payload) => {
          // Bridge autonomous events into the agent run SSE stream.
          // The goalRunIdMap is populated by the autonomous tool with
          // goalId → runId entries. For goal.created, we promote the
          // __pending sentinel to the real goalId.
          const p = payload as Record<string, unknown>;
          const goalId = typeof p.goalId === "string" ? p.goalId : undefined;

          if (event === "autonomous.goal.created" && goalId) {
            const pendingRunId = autonomousGoalRunIdMap.get("__pending");
            if (pendingRunId) {
              autonomousGoalRunIdMap.set(goalId, pendingRunId);
            }
          }

          const runId = goalId ? autonomousGoalRunIdMap.get(goalId) : undefined;

          if (runId && event.startsWith("autonomous.")) {
            // Persist and emit via the runtime so the SSE stream picks it up.
            agentRuntime.emitRunEvent(event, { ...p, runId }, runId);
          } else {
            // Fallback: emit directly (non-run-scoped observability).
            agentEventEmitter.emit(event as never, payload as never);
          }
        },
      },
    });
    const environmentScanner = createFridayEnvironmentScanner();
    setupRecipeRegistry = createFridaySetupRecipeRegistry();
    for (const recipe of FRIDAY_BUILTIN_RECIPES) {
      setupRecipeRegistry.register(recipe);
    }
    const setupRecipeExecutor = createFridaySetupRecipeExecutor({
      registry: setupRecipeRegistry,
      autonomousEngine,
      environmentScanner,
      idGenerator,
      nowIso,
    });
    const onboardingSessionRepo = createFridayOnboardingSessionRepository();
    const onboardingEngine = createOnboardingEngine({
      persistence: {
        save: (session) => stateRuntime.sqlite.withWriteTransaction((db) => onboardingSessionRepo.save(db, session)),
        loadActive: () => stateRuntime.sqlite.withReadConnection((db) => onboardingSessionRepo.listActive(db)),
      },
    });
    const setupCoordinator = createFridaySetupCoordinator({
      idGenerator,
      nowIso,
    });
    const prerequisiteInstaller = createFridayPrerequisiteInstaller({
      environmentScanner,
      execCommand: async (command, args) =>
        new Promise((resolve) => {
          execFileCb(command, args, (error, stdout, stderr) => {
            const exitCode =
              typeof (error as { code?: number | string } | null)?.code === "number"
                ? (error as { code: number }).code
                : error
                  ? 1
                  : 0;
            resolve({
              exitCode,
              stdout: stdout ?? "",
              stderr: stderr ?? "",
            });
          });
        }),
    });
    const setupAssistant = createFridaySetupAssistant({
      onboardingEngine,
      recipeRegistry: setupRecipeRegistry,
      recipeExecutor: setupRecipeExecutor,
      environmentScanner,
      coordinator: setupCoordinator,
      prerequisiteInstaller,
      // Barrier 5: the setup assistant is a SECOND agent-reachable token-holder of
      // the live companion bridge that bypasses the executeIntent retirement guard.
      // Fail closed to `undefined` on the default/prod path (it null-checks the
      // bridge and degrades setOverlayVisible to a no-op when absent), opened only
      // by the same test-only flag that fences executeIntent.
      companionBridge: resolveAgentReachableCompanionBridge(
        systemCompanionBridge,
        config.allowTestOnlySystemIntentExecution,
      ),
      eventEmitter: {
        emit: (event, payload) => {
          agentEventEmitter.emit(event as never, payload as never);
        },
      },
      idGenerator,
      nowIso,
    });

    for (const tool of [
      createFridayAgentAutonomousTool({ autonomousEngine, goalRunIdMap: autonomousGoalRunIdMap }),
      createFridayAgentControlledAutonomyTool({
        policyService: apiRuntime.autonomyPolicyService,
        acquisitionService: apiRuntime.capabilityAcquisitionService,
        standingAgendaService: apiRuntime.standingAgendaService,
        defaultUserId: learningDefaultUserId,
      }),
      createFridayAgentSetupTool({
        recipeRegistry: setupRecipeRegistry,
        recipeExecutor: setupRecipeExecutor,
        environmentScanner,
      }),
      createFridayAgentSetupAssistantTool({ setupAssistant }),
    ]) {
      agentTools.push(tool);
      agentRuntime.registerTool(tool);
    }
  }

  // 4. tts — only register when a real TTS provider is configured.
  // Stub services waste tokens: LLM tries to use the tool, gets an error, retries.
  // Skip registration entirely when no provider is available.

  // 5. nodes — the satellite node/device-control tool is ALWAYS registered;
  // it operates on paired satellites and returns "satellite not found" when
  // none are paired. (There is no FRIDAY_NODES_ENABLED gate — that env var is
  // not read by the runtime; the earlier comment naming it was inaccurate.)
  {
    const encodeNodeControlPayload = (payload: unknown): string =>
      Buffer.from(JSON.stringify(payload), "utf8").toString("base64");

    const rowToSatelliteNode = (row: ReturnType<typeof satelliteRepo.getSatellite>) => {
      if (!row) return null;
      return {
        satelliteId: row.id,
        displayName: row.display_name,
        type: row.type,
        pairingStatus: row.pairing_status,
        lastSeenAt: row.last_seen_at,
        metadata: row.metadata_json
          ? (safeJsonParse<Record<string, unknown>>(row.metadata_json) ?? undefined)
          : undefined,
      };
    };

    const satelliteNodesService = createFridaySatelliteNodesService({
      listPairedSatellites: async () =>
        stateRuntime!.sqlite.withReadConnection((db) =>
          satelliteRepo.listByStatus(db, ["paired", "online", "degraded", "offline"])
            .map(rowToSatelliteNode)
            .filter((row): row is NonNullable<ReturnType<typeof rowToSatelliteNode>> => row !== null),
        ),
      getSatellite: async (satelliteId) =>
        stateRuntime!.sqlite.withReadConnection((db) =>
          rowToSatelliteNode(satelliteRepo.getSatellite(db, satelliteId))),
      sendCommand: async (satelliteId, command, args, timeoutMs) => {
        const now = nowIso();
        const effectiveTimeoutMs = Math.max(timeoutMs ?? 30_000, 1_000);
        const expiresAt = new Date(new Date(now).getTime() + effectiveTimeoutMs).toISOString();
        const satellite = stateRuntime!.sqlite.withReadConnection((db) =>
          satelliteRepo.getSatellite(db, satelliteId));

        if (!satellite || satellite.deleted_at !== null) {
          return { success: false, error: "satellite not found" };
        }
        if (satellite.pairing_status === "pending" || satellite.pairing_status === "revoked") {
          return {
            success: false,
            error: `satellite is ${satellite.pairing_status}`,
          };
        }

        const payload = {
          type: "node.control",
          nodeId: satelliteId,
          command,
          args: args ?? {},
          timeoutMs: effectiveTimeoutMs,
          requestedAt: now,
        };
        const queued = satelliteRuntime.outbox.enqueue({
          satelliteId,
          queueKey: `node:${satelliteId}`,
          messageType: "node.control",
          payloadCiphertext: encodeNodeControlPayload(payload),
          nonce: "inline-transport",
          keyId: "inline-transport:v1",
          idempotencyKey: `node-control:${satelliteId}:${command}:${now}`,
          expiresAt,
        });

        return {
          success: true,
          response: { queued: true, messageId: queued.id, expiresAt },
        };
      },
    });

    const nodesTool = createFridayAgentNodesTool({ nodesService: satelliteNodesService });
    agentTools.push(nodesTool);
    agentRuntime.registerTool(nodesTool);
  }

  // 6. gateway — OC-011: real process info instead of stubs
  let gatewayService: ReturnType<typeof createFridayGatewayService> | undefined;
  {
    const gatewayHost = config.host ?? "127.0.0.1";
    const gatewayPort = config.port ?? 3141;
    gatewayService = createFridayGatewayService({
      async statusFn() {
        return {
          healthy: hubState === "running",
          version: FRIDAY_VERSION,
          uptime: process.uptime(),
          pid: process.pid,
          url: `http://${gatewayHost}:${String(gatewayPort)}`,
        };
      },
      async restartFn() {
        console.log("[friday] Gateway restart requested via agent tool — exiting for supervisor restart.");
        setTimeout(() => { process.exit(0); }, 500);
        return { success: true, message: "Restart initiated. Process will exit shortly." };
      },
      async configGetFn(key) {
        const value = (config as unknown as Record<string, unknown>)[key];
        if (value === undefined) return null;
        return { key, value };
      },
      async configSetFn(_key, _value) {
        return { success: false, key: _key, value: _value };
      },
      async updateFn() {
        return { success: false, message: "Self-update is not supported in this deployment mode." };
      },
    });
    const gatewayTool = createFridayAgentGatewayTool({ gatewayService });
    agentTools.push(gatewayTool);
    agentRuntime.registerTool(gatewayTool);
  }

  // ─── Generator & import tools ───

  {
    const skillGenTool = createFridayAgentSkillGeneratorTool({
      generatorService: skillGenerator,
    });
    agentTools.push(skillGenTool);
    agentRuntime.registerTool(skillGenTool);

    const workflowGenTool = createFridayAgentWorkflowGeneratorTool({
      generatorService: workflowGenerator,
    });
    agentTools.push(workflowGenTool);
    agentRuntime.registerTool(workflowGenTool);

    const skillImportTool = createFridayAgentSkillImportTool({
      converterService,
    });
    agentTools.push(skillImportTool);
    agentRuntime.registerTool(skillImportTool);
  }

  const hub: FridayHub = {
    async start(): Promise<void> {
      hubState = "starting";

      // 1. Load skills from configured directories
      await registry.initialize();

      // 2. Load published workflow triggers into memory
      await workflowRuntime.triggers.reloadFromPublishedVersions();

      // 2b. Resume or fail stale subagent runs from previous boot
      {
        const failedCount = subagentRegistry.resumeOnBoot();
        if (failedCount > 0) {
          console.log(`[friday] Marked ${String(failedCount)} stale subagent run(s) as failed on boot`);
        }
      }

      // 2c. Resume or fail stale agent runs from previous boot
      {
        const failedCount = agentRuntime.resumeStaleRunsOnBoot();
        if (failedCount > 0) {
          console.log(`[friday] Marked ${String(failedCount)} stale agent run(s) as failed on boot`);
        }
      }

      // 2d. Auto-detect LLM providers from environment variables
      if (canonicalMutatingActionGateEnabled) {
        console.warn(
          "[friday] Skipping automatic provider setup/repair because canonical mutation gate is enabled; use approved provider setup routes.",
        );
      } else {
        const autoDetected = await autoDetectProvidersFromEnv(providerService);
        if (autoDetected.length > 0) {
          console.log(
            `[friday] Auto-detected ${String(autoDetected.length)} provider(s) from environment: ${autoDetected.map((p) => p.kind).join(", ")}`,
          );
        }
        const repairedLegacyProviders = await repairLegacyAutoDetectedOpenAiProviders(providerService);
        if (repairedLegacyProviders.length > 0) {
          console.log(
            `[friday] Repaired ${String(repairedLegacyProviders.length)} legacy auto-detected OpenAI provider(s) to ${STABLE_OPENAI_DEFAULT_MODEL}.`,
          );
        }
        const repairedMisnamedOpenAiProviders = await repairMisnamedOpenAiSetupProviders(providerService);
        if (repairedMisnamedOpenAiProviders.length > 0) {
          console.log(
            `[friday] Repaired ${String(repairedMisnamedOpenAiProviders.length)} misnamed OpenAI provider(s).`,
          );
        }
      }

      // 3. API runtime is ready (created synchronously above)
      //    HTTP listener start is handled by CLI run-loop (Batch 2), not here.

      // 4. Start channel plugins (route inbound messages to agent runtime)

      // Deterministic dispatch deps — reused across all channel messages.
      const deterministicDispatchDeps: FridayDeterministicDispatchDeps = {
        sessionMessageGetter: (key: string, limit?: number) => hubSessionService.getMessages(key, limit),
        capabilitySnapshotGetter: getAgentCapabilitySnapshot,
        taskStatusSnapshotGetter: getAgentTaskStatusSnapshot,
        getDaemonStatus: () => daemonService.status(),
        listMcpServers: mcpAdapter
          ? () => mcpAdapter.listServers().map((s) => ({ id: s.id, transport: s.transport }))
          : undefined,
        approvalService: workflowRuntime.approval,
        workflowExecutionService: workflowRuntime.execution,
        setupRecipeRegistry,
      };
      const managedAsyncDispatchDeps: FridayManagedAsyncDispatchDeps = {
        workflowExecutionService: workflowRuntime.execution,
      };
      const persistImmediateRunResult = createFridayImmediateRunPersistence({
        db: stateRuntime!.sqlite,
        repo: agentRunRepo,
        runEventRepository: agentRunEventRepository,
        idGenerator,
        nowIso,
      });

      // ── Channel Orchestration Engine (Initiative A-WIRE) ──
      // TS Runtime Retirement (G5 completeness): this sessionDeps object is wired
      // SOLELY into the channel orchestration engine (channelOrchestrationEngine
      // below; the API/non-channel engine uses its own separate engineSessionDeps
      // in friday-api-runtime). On the channel path the engine's run-executor
      // control-plane writes (finalizeControlPlane / planning return+reject) and
      // any turn-preparer write persist assistant/user session messages via this
      // addMessage BEFORE the agent-runtime executeRun guard, so a deterministic /
      // control-plane channel message would otherwise bypass the channel-mirror
      // (G5) guard placed at the handler boundary. We close that bypass by applying
      // the IDENTICAL fail-closed check here, with the SAME family + flag as the
      // retired session route and the handler mirror (TS_RUNTIME_SESSION_RETIRED,
      // allowTestOnlySessionExecution). The check returns a rejected promise (never
      // throws synchronously) so the run-executor's `.catch(() => undefined)` on
      // each control-plane write degrades cleanly under flag-unset — no half-state,
      // no unhandled rejection, turn does not crash (mirrors the handler's chained
      // non-fatal .catch). Production leaves the flag unset → channel-engine session
      // writes fail-closed; test-oracle harnesses opt in. Guarding here (the
      // channel-only caller boundary) — NOT addMessage itself — leaves the many
      // legitimate non-channel addMessage callers untouched.
      const channelEngineSessionDeps = {
        getMessages: (key: string, limit?: number) => hubSessionService.getMessages(key, limit),
        addMessage: (key: string, msg: Parameters<typeof hubSessionService.addMessage>[1]) => {
          if (config.allowTestOnlySessionExecution !== true) {
            return Promise.reject(
              new FridayDomainError(
                "TS_RUNTIME_SESSION_RETIRED",
                "TypeScript session execution is fail-closed in default/live runtime; use the Rust-owned session_lifecycle entrypoint.",
                {
                  httpStatus: 503,
                  details: {
                    classification: "fail_closed",
                    replacement: "rust_owned_session_lifecycle_entrypoint_required",
                  },
                },
              ),
            );
          }
          return hubSessionService.addMessage(key, msg);
        },
        getConversationFocus: (key: string) => hubSessionService.getConversationFocus(key),
        // setConversationFocus is the SECOND session-state WRITE on this channel-only
        // dep (a sibling of addMessage). It rewrites conversation focus (currentTopicSummary,
        // assistantAnchorSummary, lastRunId, reply anchors, fingerprints, task ledger) on
        // pre-existing channel session rows. The run-executor's control-plane finalize does
        // addMessage THEN setConversationFocus per branch, each `.catch(() => undefined)`-
        // swallowed — so the addMessage fail-closed rejection is caught and flow STILL reaches
        // this write. setConversationFocus is retirement-in-scope (the /v1/sessions/:key/compact
        // focus route is gated behind assertSessionTestOracleAllowed). Apply the IDENTICAL
        // fail-closed check (same family + flag, no new flag) so the COMPLETE channel-engine
        // session-write surface is fenced under the production default. getConversationFocus /
        // getMessages are READS → left live per the retirement (reads stay live).
        setConversationFocus: (key: string, state: Parameters<typeof hubSessionService.setConversationFocus>[1]) => {
          if (config.allowTestOnlySessionExecution !== true) {
            return Promise.reject(
              new FridayDomainError(
                "TS_RUNTIME_SESSION_RETIRED",
                "TypeScript session execution is fail-closed in default/live runtime; use the Rust-owned session_lifecycle entrypoint.",
                {
                  httpStatus: 503,
                  details: {
                    classification: "fail_closed",
                    replacement: "rust_owned_session_lifecycle_entrypoint_required",
                  },
                },
              ),
            );
          }
          return hubSessionService.setConversationFocus(key, state).then(() => undefined);
        },
      };
      const channelOrchestrationEngine = createFridayOrchestrationEngine({
        turnPreparerDeps: {
          sessionDeps: channelEngineSessionDeps,
          historyLimit: FRIDAY_CHANNEL_CONTEXT_HISTORY_LIMIT,
          nowIso,
          prepareTurn: prepareFridayConversationTurn as CreateFridayEngineTurnPreparerDeps["prepareTurn"],
          buildEvidenceBlocks: buildFridayEvidenceBlocks as CreateFridayEngineTurnPreparerDeps["buildEvidenceBlocks"],
          classifyExecution: classifyFridayExecution,
          capabilitySnapshotGetter: getAgentCapabilitySnapshot as unknown as CreateFridayEngineTurnPreparerDeps["capabilitySnapshotGetter"],
          taskStatusSnapshotGetter: getAgentTaskStatusSnapshot as unknown as CreateFridayEngineTurnPreparerDeps["taskStatusSnapshotGetter"],
          // persistCompactionEvidence is the THIRD channel-engine session/memory-state
          // WRITE — separately wired (NOT part of channelEngineSessionDeps), so the
          // addMessage / setConversationFocus guards above do NOT cover it. The
          // turn-preparer runs BEFORE dispatch / before the agent-runtime executeRun
          // guard and, when buildSelectedBlockCompactionEvidence(selectedBlocks) is
          // non-null, calls this to write a session+runId-keyed derived-state row into
          // friday_agent_context_replay_entries (summaryText / decisions / todos /
          // openQuestions / toolFailures / fileOperations) via db.withWriteTransaction →
          // appendCompactionSummary. Reachable on a bound channel turn even while
          // addMessage / setConversationFocus reject (proven RED). Apply the IDENTICAL
          // fail-closed check (SAME family + flag, no new flag) so the COMPLETE
          // channel-engine session/memory-write surface is fenced under the production
          // default. The check returns a rejected promise (never throws synchronously);
          // the turn-preparer wraps the call in `.catch(() => undefined)`
          // (friday-engine-turn-preparer.ts ~455-463) so flow degrades cleanly — no
          // half-state, no unhandled rejection, the turn does not crash. Production leaves
          // the flag unset → channel-engine compaction-evidence writes fail-closed;
          // test-oracle harnesses opt in. The sink's OTHER consumers (agent runtime parent
          // + sub-agent, bootstrap ~4851 / ~5172) are downstream of executeRun:803 and
          // already fenced by allowTestOnlyAgentRunExecution — this closure is the only
          // channel path to the sink BEFORE that guard.
          persistCompactionEvidence: agentCompactionContextReplaySink
            ? async (input) => {
              if (config.allowTestOnlySessionExecution !== true) {
                return Promise.reject(
                  new FridayDomainError(
                    "TS_RUNTIME_SESSION_RETIRED",
                    "TypeScript session execution is fail-closed in default/live runtime; use the Rust-owned session_lifecycle entrypoint.",
                    {
                      httpStatus: 503,
                      details: {
                        classification: "fail_closed",
                        replacement: "rust_owned_session_lifecycle_entrypoint_required",
                      },
                    },
                  ),
                );
              }
              await agentCompactionContextReplaySink.persist({
                sessionKey: input.sessionKey,
                runId: input.runId,
                summary: input.summary,
                blocks: input.blocks,
                compactedAt: nowIso(),
              });
              return undefined;
            }
            : undefined,
        },
        runExecutorDeps: {
          agentRuntime,
          sessionDeps: channelEngineSessionDeps,
          planningGate: agentPlanningGate,
          nowIso,
          persistImmediateRunResult,
          dispatchDeterministic,
          dispatchManagedAsync,
          finalizeFocus: finalizeFridayConversationFocus as CreateFridayEngineRunExecutorDeps["finalizeFocus"],
          deterministicDispatchDeps: deterministicDispatchDeps as unknown as Record<string, unknown>,
          managedAsyncDispatchDeps: managedAsyncDispatchDeps as unknown as Record<string, unknown>,
          resolveIdempotencyKey: resolveAgentMirrorIdempotencyKey,
        },
      });
      const channelNaturalTriggerResolver = memoryService
        ? createFridayChannelNaturalTriggerResolver({
            memoryService,
            workflowCrudService: workflowRuntime.crud,
            workflowExecutionService: workflowRuntime.execution,
            getSessionMemoryNamespace: (key) => hubSessionService.getSessionMemoryNamespace(key),
            startedByUserId: learningDefaultUserId,
            nowIso,
          })
        : undefined;
      {
        let lastChannelUiWakeAt = 0;
        const channelUiWakeCooldownMs = Math.max(
          0,
          Number.parseInt(process.env.FRIDAY_CHANNEL_WAKE_UI_COOLDOWN_MS ?? "300000", 10) || 0,
        );
        const resolveLocalUiWakeBaseUrl = (): string | undefined => {
          const publicBase = process.env.FRIDAY_PUBLIC_APP_BASE_URL?.trim();
          if (publicBase) return publicBase;
          const configuredHost = config.host ?? process.env.FRIDAY_HOST ?? "127.0.0.1";
          const host = configuredHost === "0.0.0.0" ? "localhost" : configuredHost;
          const port = config.port ?? parseFridayHubPort(process.env.FRIDAY_PORT) ?? 3141;
          const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
          return `http://${hostname}:${String(port)}`;
        };
        const wakeUiForChannelMessage = (
          msg: FridayChannelMessage,
          runId: string,
        ): void => {
          if (process.env.FRIDAY_CHANNEL_WAKE_UI !== "true") return;
          const nowMs = Date.now();
          if (
            channelUiWakeCooldownMs > 0 &&
            lastChannelUiWakeAt > 0 &&
            nowMs - lastChannelUiWakeAt < channelUiWakeCooldownMs
          ) {
            return;
          }
          lastChannelUiWakeAt = nowMs;

          try {
            const baseUrl = resolveLocalUiWakeBaseUrl();
            if (!baseUrl) return;
            const url = new URL("/channels", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
            url.searchParams.set("channel", msg.channelKind);
            url.searchParams.set("chatId", msg.chatId);
            url.searchParams.set("runId", runId);
            const { command, args } = buildOpenBrowserUrlCommand(url.toString());
            execFileCb(command, args, { windowsHide: true }, (err) => {
              if (err) {
                warnHubBootstrapOnce(`[friday] channel-ui-wake: ${err.message}`);
              }
            });
          } catch (err) {
            warnHubBootstrapOnce(`[friday] channel-ui-wake: ${err instanceof Error ? err.message : String(err)}`);
          }
        };

        const channelProgressReceiptKinds = new Set(["feishu", "lark"]);
        const channelProgressReceiptDelayMs = Math.max(
          0,
          Number.parseInt(process.env.FRIDAY_CHANNEL_PROGRESS_RECEIPT_DELAY_MS ?? "1000", 10) || 0,
        );
        const progressReceiptEnabled = (): boolean =>
          process.env.FRIDAY_CHANNEL_PROGRESS_RECEIPT !== "false";
        const buildChannelProgressReceiptText = (sourceText: string): string =>
          /[\u4e00-\u9fff]/u.test(sourceText)
            ? "收到，正在处理。"
            : "Received. Working on it.";
        const createChannelProgressReceipt = (
          msg: FridayChannelMessage,
          sourceText: string,
          logChannelIssue: (input: {
            level: "warn" | "error";
            code: string;
            routeId: string;
            runId?: string;
            error: unknown;
          }) => void,
        ) => {
          let closed = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let receipt: { messageId: string } | undefined;
          let sendPromise: Promise<void> | undefined;
          const enabled = progressReceiptEnabled() && channelProgressReceiptKinds.has(msg.channelKind);

          return {
            start(): void {
              if (!enabled || closed) return;
              timer = setTimeout(() => {
                if (closed) return;
                sendPromise = channelRegistry.send(msg.channelKind, {
                  chatId: msg.chatId,
                  text: buildChannelProgressReceiptText(sourceText),
                  replyTo: msg.id,
                }).then((delivery) => {
                  receipt = delivery;
                }).catch((err) => {
                  logChannelIssue({
                    level: "warn",
                    code: "W-CH-PROGRESS-RECEIPT-001",
                    routeId: "hub.channel.progress_receipt.send",
                    error: err,
                  });
                });
              }, channelProgressReceiptDelayMs);
            },
            async deliverFinal(input: {
              text: string;
              runId?: string;
              images?: string[];
            }): Promise<{ messageId: string }> {
              closed = true;
              if (timer) {
                clearTimeout(timer);
                timer = undefined;
              }
              if (sendPromise) {
                await sendPromise;
              }
              if (receipt?.messageId) {
                try {
                  return await channelRegistry.update(msg.channelKind, receipt.messageId, {
                    chatId: msg.chatId,
                    text: input.text,
                    replyTo: msg.id,
                    images: input.images,
                  });
                } catch (err) {
                  logChannelIssue({
                    level: "warn",
                    code: "W-CH-PROGRESS-RECEIPT-002",
                    routeId: "hub.channel.progress_receipt.update",
                    runId: input.runId,
                    error: err,
                  });
                }
              }
              return channelRegistry.send(msg.channelKind, {
                chatId: msg.chatId,
                text: input.text,
                replyTo: msg.id,
                images: input.images,
              });
            },
            stop(): void {
              closed = true;
              if (timer) {
                clearTimeout(timer);
                timer = undefined;
              }
            },
          };
        };

        const buildReflexOnboardingChannelText = (
          snapshot: NonNullable<ReturnType<NonNullable<typeof reflexService>["getOnboarding"]>>,
        ): string => {
          const question = snapshot.activeQuestion;
          if (!question) {
            return "Reflex onboarding 已完成。你之后仍可在 Review Center 修改偏好或审批候选。";
          }
          const optionLines = question.options
            .map((option, index) => `${String(index + 1)}. ${option.label} — ${option.description}`)
            .join("\n");
          return [
            `Reflex onboarding ${String(snapshot.progress.completed + 1)}/${String(snapshot.progress.total)}`,
            `${question.id} · ${question.title}`,
            question.scenario,
            question.prompt,
            optionLines,
            "回复序号即可选择；回复「跳过」或 skip 会永久跳过这一题，之后只能在 Review Center 手动补。",
          ].join("\n\n");
        };

        const parseReflexOnboardingAnswer = (
          textValue: string,
          question: NonNullable<ReturnType<NonNullable<typeof reflexService>["getOnboarding"]>["activeQuestion"]>,
        ): { value: string; text?: string } | null => {
          const normalized = textValue.trim();
          const numeric = /^(?:选|选择|option\s*)?([1-9])$/iu.exec(normalized);
          if (numeric?.[1]) {
            const option = question.options[Number.parseInt(numeric[1], 10) - 1];
            return option ? { value: option.value } : null;
          }
          const lowered = normalized.toLowerCase();
          const option = question.options.find((candidate) =>
            candidate.value.toLowerCase() === lowered
            || candidate.label.toLowerCase() === lowered);
          if (option) {
            return { value: option.value };
          }
          if (question.id === "O2" && normalized.length > 0 && normalized.length <= 80) {
            return { value: "custom", text: normalized };
          }
          return null;
        };

        const maybeHandleReflexOnboardingChannelMessage = async (
          msg: FridayChannelMessage,
          textValue: string,
        ): Promise<boolean> => {
          if (!reflexService || textValue.trim().length === 0) return false;
          let snapshot = reflexService.getOnboarding(learningDefaultUserId);
          if (snapshot.session?.status === "not_started") {
            snapshot = reflexService.startOnboarding({
              userId: learningDefaultUserId,
              primaryChannelKind: msg.channelKind,
              primaryChannelUserId: msg.senderId,
            });
          }
          if (snapshot.session?.status !== "active" || !snapshot.activeQuestion) {
            return false;
          }
          if (
            snapshot.session.primaryChannelKind
            && snapshot.session.primaryChannelKind !== msg.channelKind
          ) {
            return false;
          }
          const trimmed = textValue.trim();
          const skip = /^(?:skip|跳过|略过|先跳过)$/iu.test(trimmed);
          if (skip) {
            snapshot = reflexService.skipOnboarding({
              userId: learningDefaultUserId,
              questionId: snapshot.activeQuestion.id,
              sourceSurface: "channel",
            });
          } else {
            const answer = parseReflexOnboardingAnswer(trimmed, snapshot.activeQuestion);
            if (!answer) {
              await channelRegistry.send(msg.channelKind, {
                chatId: msg.chatId,
                text: buildReflexOnboardingChannelText(snapshot),
                replyTo: msg.id,
              });
              return true;
            }
            snapshot = reflexService.answerOnboarding({
              userId: learningDefaultUserId,
              questionId: snapshot.activeQuestion.id,
              answer,
              sourceSurface: "channel",
            });
          }
          await channelRegistry.send(msg.channelKind, {
            chatId: msg.chatId,
            text: buildReflexOnboardingChannelText(snapshot),
            replyTo: msg.id,
          });
          return true;
        };

        const channelMessageHandler = (msg: FridayChannelMessage) => {
          const text = sanitizeChannelInput(msg.text);
          const hasInboundImages = (msg.images?.length ?? 0) > 0;
          const hasInboundAttachments = (msg.attachments?.length ?? 0) > 0;
          const hasInboundMedia = hasInboundImages || hasInboundAttachments;
          const taskText = text || (hasInboundImages
            ? "Analyze the attached image."
            : hasInboundAttachments
              ? "Analyze the attached media."
              : "");
          const sessionKey = resolveFridayChannelSessionKey(msg, {
            crossChannelIdentityEnabled,
            identityMap: crossChannelIdentityMap,
          });
          const correlationId = `channel:${msg.channelKind}:${msg.chatId}:${msg.id}`;
          const inboundIdempotencyKey = `channel:${msg.channelKind}:${msg.chatId}:${msg.id}:user`;
          const logChannelIssue = (input: {
            level: "warn" | "error";
            code: string;
            routeId: string;
            runId?: string;
            toolName?: string;
            error: unknown;
            details?: Record<string, unknown>;
          }) => {
            const errorMessage = input.error instanceof Error ? input.error.message : String(input.error);
            const effectiveCorrelationId = input.runId ?? correlationId;
            const payload = {
              code: input.code,
              routeId: input.routeId,
              correlationId: effectiveCorrelationId,
              channelCorrelationId: correlationId,
              runId: input.runId,
              toolName: input.toolName,
              channelKind: msg.channelKind,
              chatId: msg.chatId,
              messageId: msg.id,
              sessionKey,
              errorMessage,
              ...(input.details ?? {}),
            };
            if (input.level === "warn") {
              console.warn(`[friday][${input.code}]`, payload);
            } else {
              console.error(`[friday][${input.code}]`, payload);
            }
            void memoryState.appendAuditLog({
              id: idGenerator(),
              ts: nowIso(),
              actorType: "service",
              actorId: msg.senderId,
              action: `channel.${input.code.toLowerCase()}`,
              resourceType: `channel_${msg.channelKind}`,
              resourceId: msg.id,
              traceId: effectiveCorrelationId,
              result: input.level === "warn" ? "failure" : "error",
              errorCode: input.code,
              errorMessage,
              caller: input.routeId,
              details: payload,
            }).catch((err: unknown) => warnHubBootstrapOnce(`[friday] audit-append: ${err instanceof Error ? err.message : String(err)}`));
          };
          // ─── TS Runtime Retirement (G5): channel-mirror write boundary guard ───
          // The channel webhook ingress → channelMessageHandler path mirrors
          // inbound/outbound channel traffic into the TS session store via
          // FridaySessionService.addMessage (withWriteTransaction). The session
          // ROUTE write is already retired (assertSessionTestOracleAllowed →
          // TS_RUNTIME_SESSION_RETIRED), but this off-route mirror entry was
          // unguarded. We guard at THIS caller boundary — never on addMessage
          // itself — because addMessage has many legitimate non-channel callers
          // (API session routes, agent sessions tool, engine turn-preparer /
          // run-executor, subagent lineage, parent-summary writes). Guarding the
          // method globally would break those; guarding here closes the
          // channel-mirror bypass with the SAME family + flag as the retired
          // route. Production leaves the flag unset → mirror writes fail-closed;
          // test-oracle harnesses opt in. Returns the addMessage promise so every
          // call site (await / await+catch / void async) behaves identically.
          const mirrorChannelSessionMessage: typeof hubSessionService.addMessage = (key, message) => {
            if (config.allowTestOnlySessionExecution !== true) {
              return Promise.reject(
                new FridayDomainError(
                  "TS_RUNTIME_SESSION_RETIRED",
                  "TypeScript session execution is fail-closed in default/live runtime; use the Rust-owned session_lifecycle entrypoint.",
                  {
                    httpStatus: 503,
                    details: {
                      classification: "fail_closed",
                      replacement: "rust_owned_session_lifecycle_entrypoint_required",
                    },
                  },
                ),
              );
            }
            return hubSessionService.addMessage(key, message);
          };
          if (taskText.length === 0) return;
          channelApprovalRoutesBySession.set(sessionKey, {
            channelKind: msg.channelKind,
            chatId: msg.chatId,
            chatType: msg.chatType,
	            senderId: msg.senderId,
	            messageId: msg.id,
	            sessionKey,
	          });

          if (text.length > FRIDAY_CHANNEL_MAX_MESSAGE_LENGTH) {
            channelRegistry
              .send(msg.channelKind, {
                chatId: msg.chatId,
                text: buildFridayChannelMessageTooLongText(FRIDAY_CHANNEL_MAX_MESSAGE_LENGTH, text),
                replyTo: msg.id,
              })
              .catch((err) => {
                logChannelIssue({
                  level: "error",
                  code: "E-CH-OUTBOUND-001",
                  routeId: "hub.channel.delivery.message_too_long",
                  error: err,
                });
              });
            return;
          }

          const approvalCommand = text.length > 0 ? parseChannelToolApprovalCommand(text) : null;
          const pendingApprovalsForCommand = approvalCommand
            ? listPendingChannelToolApprovalsForSession(sessionKey)
            : [];
          const restartedApprovalsForCommand = approvalCommand && pendingApprovalsForCommand.length === 0
            ? listRestartedChannelToolApprovalsForSession(sessionKey)
            : [];
          const pendingApprovalForCommand = approvalCommand
            ? approvalCommand.shortId
              ? pendingApprovalsForCommand.find((pending) => pending.shortId === approvalCommand.shortId)
              : pendingApprovalsForCommand.length === 1
                ? pendingApprovalsForCommand[0]
                : undefined
            : undefined;
          const restartedApprovalForCommand = approvalCommand
            ? approvalCommand.shortId
              ? restartedApprovalsForCommand.find((pending) => pending.shortId === approvalCommand.shortId)
              : restartedApprovalsForCommand.length === 1
                ? restartedApprovalsForCommand[0]
                : undefined
            : undefined;
          const shouldRouteToolApprovalCommand = Boolean(
            approvalCommand
            && (
              pendingApprovalForCommand
              || restartedApprovalForCommand
              || approvalCommand.shortId
              || pendingApprovalsForCommand.length > 1
              || restartedApprovalsForCommand.length > 1
            ),
          );
          const reflexCandidateCommand = text.length > 0 ? parseReflexCandidateDecisionCommand(text) : null;
          if (reflexCandidateCommand) {
            void (async () => {
              await mirrorChannelSessionMessage(sessionKey, {
                role: "user",
                content: text,
                contentText: text,
                idempotencyKey: inboundIdempotencyKey,
                metadata: {
                  sourceMessageId: msg.id,
                  channelKind: msg.channelKind,
                  reflexCandidateCommand: true,
                },
              }).catch((err) => {
                logChannelIssue({
                  level: "warn",
                  code: "W-CH-SESSION-MIRROR-001",
                  routeId: "hub.channel.session.mirror.reflex_candidate_command",
                  error: err,
                });
              });

              let ackText: string;
              if (!reflexService) {
                ackText = "Reflex 审核服务当前不可用，候选项没有被更改。";
              } else {
                const command = reflexCandidateCommand;
                try {
                  const senderUserId = msg.senderId?.trim() || learningDefaultUserId;
                  const decideCandidate = async (userId: string) =>
                    command.action === "test"
                      ? await reflexService.testCandidate({
                          userId,
                          candidateId: command.candidateId,
                        })
                      : command.action === "approve"
                        ? await reflexService.approveCandidate({
                            userId,
                            candidateId: command.candidateId,
                          })
                        : command.action === "reject"
                          ? reflexService.rejectCandidate({
                              userId,
                              candidateId: command.candidateId,
                              reason: command.reason,
                            })
                          : reflexService.dismissCandidate({
                              userId,
                              candidateId: command.candidateId,
                              reason: command.reason,
                            });
                  let candidate;
                  try {
                    candidate = await decideCandidate(senderUserId);
                  } catch (err) {
                    if (
                      senderUserId === learningDefaultUserId
                      || !(err instanceof FridayDomainError)
                      || err.code !== "REFLEX_CANDIDATE_NOT_FOUND"
                    ) {
                      throw err;
                    }
                    candidate = await decideCandidate(learningDefaultUserId);
                  }
                  ackText = `Reflex candidate ${candidate.id} 已更新为 ${candidate.status}。`;
                } catch (err) {
                  ackText = `Reflex candidate ${command.candidateId} 处理失败：${err instanceof Error ? err.message : String(err)}`;
                }
              }

              const delivery = await channelRegistry.send(msg.channelKind, {
                chatId: msg.chatId,
                text: ackText,
                replyTo: msg.id,
              });
              await mirrorChannelSessionMessage(sessionKey, {
                role: "assistant",
                content: ackText,
                contentText: ackText,
                idempotencyKey: `channel:${msg.channelKind}:${msg.chatId}:${msg.id}:reflex-candidate-ack`,
                metadata: {
                  sourceMessageId: delivery.messageId,
                  replyToMessageId: msg.id,
                  channelKind: msg.channelKind,
                  reflexCandidateAck: true,
                },
              }).catch((err) => {
                logChannelIssue({
                  level: "warn",
                  code: "W-CH-SESSION-MIRROR-001",
                  routeId: "hub.channel.session.mirror.reflex_candidate_ack",
                  error: err,
                });
              });
            })().catch((err) => {
              logChannelIssue({
                level: "error",
                code: "E-CH-REFLEX-CANDIDATE-001",
                routeId: "hub.channel.reflex_candidate_decision",
                error: err,
              });
            });
            return;
          }

          const reflexPreferenceResult = applyChannelReflexExplicitPreferences({
            userId: learningDefaultUserId,
            text,
          });
          if (reflexPreferenceResult.applied > 0 || reflexPreferenceResult.pendingConfirmation > 0) {
            void (async () => {
              await mirrorChannelSessionMessage(sessionKey, {
                role: "user",
                content: text,
                contentText: text,
                idempotencyKey: inboundIdempotencyKey,
                metadata: {
                  sourceMessageId: msg.id,
                  channelKind: msg.channelKind,
                  reflexPreferenceCommand: true,
                },
              }).catch((err) => {
                logChannelIssue({
                  level: "warn",
                  code: "W-CH-SESSION-MIRROR-001",
                  routeId: "hub.channel.session.mirror.reflex_preference_command",
                  error: err,
                });
              });
              const ackText = reflexPreferenceResult.pendingConfirmation > 0
                ? [
                    reflexPreferenceResult.applied > 0
                      ? `已更新 ${String(reflexPreferenceResult.applied)} 条普通 Friday 偏好。`
                      : null,
                    `有 ${String(reflexPreferenceResult.pendingConfirmation)} 条会影响安全、执行、自动化、记忆或测试策略的设置，我已放到 Review Center 待确认；你确认一次后才会长期生效。`,
                  ].filter(Boolean).join(" ")
                : `已更新 ${String(reflexPreferenceResult.applied)} 条 Friday 偏好，会在所有绑定渠道生效。你可以在 Review Center 撤销。`;
              const delivery = await channelRegistry.send(msg.channelKind, {
                chatId: msg.chatId,
                text: ackText,
                replyTo: msg.id,
              });
              await mirrorChannelSessionMessage(sessionKey, {
                role: "assistant",
                content: ackText,
                contentText: ackText,
                idempotencyKey: `channel:${msg.channelKind}:${msg.chatId}:${msg.id}:reflex-preference-ack`,
                metadata: {
                  sourceMessageId: delivery.messageId,
                  replyToMessageId: msg.id,
                  channelKind: msg.channelKind,
                  reflexPreferenceAck: true,
                },
              }).catch((err) => {
                logChannelIssue({
                  level: "warn",
                  code: "W-CH-SESSION-MIRROR-001",
                  routeId: "hub.channel.session.mirror.reflex_preference_ack",
                  error: err,
                });
              });
            })().catch((err) => {
              logChannelIssue({
                level: "error",
                code: "E-CH-REFLEX-PREFERENCE-001",
                routeId: "hub.channel.reflex_preference_update",
                error: err,
              });
            });
            return;
          }

          const reflexSnapshot = reflexService?.getOnboarding(learningDefaultUserId);
          const shouldHandleReflexOnboarding = Boolean(
            reflexSnapshot?.session
            && (reflexSnapshot.session.status === "active" || reflexSnapshot.session.status === "not_started")
            && (!reflexSnapshot.session.primaryChannelKind || reflexSnapshot.session.primaryChannelKind === msg.channelKind)
            && !shouldRouteToolApprovalCommand,
          );
          if (shouldHandleReflexOnboarding) {
            void maybeHandleReflexOnboardingChannelMessage(msg, text).catch((err) => {
              logChannelIssue({
                level: "error",
                code: "E-CH-REFLEX-ONBOARDING-001",
                routeId: "hub.channel.reflex_onboarding",
                error: err,
              });
            });
            return;
          }

          if (approvalCommand) {
            if (shouldRouteToolApprovalCommand) {
              void (async () => {
                await mirrorChannelSessionMessage(sessionKey, {
                  role: "user",
                  content: text,
                  contentText: text,
                  idempotencyKey: inboundIdempotencyKey,
                  metadata: {
                    sourceMessageId: msg.id,
                    channelKind: msg.channelKind,
                    toolApprovalCommand: true,
                  },
                }).catch((err) => {
                  logChannelIssue({
                    level: "warn",
                    code: "W-CH-SESSION-MIRROR-001",
                    routeId: "hub.channel.session.mirror.tool_approval_command",
                    error: err,
                  });
                });

	                let ackText: string;
	                if (pendingApprovalForCommand) {
	                  const senderAuthorized = canResolveFridayChannelApprovalFromMessage({
	                    route: pendingApprovalForCommand.route,
	                    message: msg,
	                  });
	                  if (!senderAuthorized) {
	                    ackText = `审批 ${pendingApprovalForCommand.shortId} 只能由原请求者确认。`;
	                  } else {
	                    const resolution = resolveToolApproval(
	                      pendingApprovalForCommand.runId,
	                      pendingApprovalForCommand.toolCallId,
	                      approvalCommand.approved,
	                      {
	                        reason: approvalCommand.reason,
	                        approverPrincipalId: resolveFridayChannelApprovalPrincipalId({
	                          channelKind: msg.channelKind,
	                          chatId: msg.chatId,
	                          senderId: msg.senderId,
	                        }),
	                        approverPrincipalType: "channel",
	                        approvalSurface: "channel",
	                      },
	                    );
	                    if (resolution.resolved) {
	                      if (resolution.reason === "approval_expired") {
	                        ackText = `审批 ${pendingApprovalForCommand.shortId} 已过期，请重新发起操作。`;
	                      } else if (resolution.reason === "approval_expiration_invalid") {
	                        ackText = `审批 ${pendingApprovalForCommand.shortId} 的过期时间无效，Friday 已拒绝继续执行。`;
	                      } else {
	                        ackText = approvalCommand.approved
	                          ? `已批准 ${pendingApprovalForCommand.shortId}，Friday 会继续执行。`
	                          : `已拒绝 ${pendingApprovalForCommand.shortId}，Friday 不会执行该敏感操作。`;
	                      }
	                    } else {
	                      ackText = `审批 ${pendingApprovalForCommand.shortId} 已经结束，不需要重复处理。`;
	                    }
	                  }
	                } else if (restartedApprovalForCommand) {
	                  const expiryDecision = evaluateFridayChannelApprovalExpiry({
	                    expiresAt: restartedApprovalForCommand.expiresAt,
	                    nowIso: nowIso(),
	                  });
	                  if (expiryDecision.expired) {
	                    ackText = `审批 ${restartedApprovalForCommand.shortId} 已过期，请重新发起操作。`;
	                  } else {
	                    ackText = `审批 ${restartedApprovalForCommand.shortId} 所属运行已在重启后中断，Friday 不能继续执行旧敏感操作；请重新发起操作，我会重新请求确认。`;
	                  }
	                } else if ((pendingApprovalsForCommand.length + restartedApprovalsForCommand.length) > 1 && !approvalCommand.shortId) {
                  const combinedApprovals = [
                    ...pendingApprovalsForCommand,
                    ...restartedApprovalsForCommand,
                  ];
                  const ids = combinedApprovals.map((pending) => pending.shortId).join(", ");
                  ackText = `当前有多个待审批操作：${ids}。请回复「批准 <编号>」或「拒绝 <编号>」。`;
                } else {
                  ackText = `没有找到待审批操作 ${approvalCommand.shortId ?? ""}。`;
                }

                const delivery = await channelRegistry.send(msg.channelKind, {
                  chatId: msg.chatId,
                  text: ackText,
                  replyTo: msg.id,
                });
                await mirrorChannelSessionMessage(sessionKey, {
                  role: "assistant",
                  content: ackText,
                  contentText: ackText,
                  idempotencyKey: `channel:${msg.channelKind}:${msg.chatId}:${msg.id}:tool-approval-ack`,
                  metadata: {
                    sourceMessageId: delivery.messageId,
                    replyToMessageId: msg.id,
                    channelKind: msg.channelKind,
                    toolApprovalAck: true,
                  },
                }).catch((err) => {
                  logChannelIssue({
                    level: "warn",
                    code: "W-CH-SESSION-MIRROR-001",
                    routeId: "hub.channel.session.mirror.tool_approval_ack",
                    error: err,
                  });
                });
              })().catch((err) => {
                logChannelIssue({
                  level: "error",
                  code: "E-CH-OUTBOUND-001",
                  routeId: "hub.channel.delivery.tool_approval_ack",
                  error: err,
                });
              });
              return;
            }
          }

          // Route inbound channel messages to agent runtime

          // OC-005: Lifecycle-aware typing controller
          const typingController = createFridayChannelTypingController({
            emitTyping: () => {
              channelRegistry
                .signalTyping(msg.channelKind, msg.chatId)
                .catch((err) => {
                  logChannelIssue({
                    level: "warn",
                    code: "W-CH-TYPING-001",
                    routeId: "hub.channel.typing",
                    error: err,
                  });
                });
            },
          });
          typingController.start();
          const progressReceipt = createChannelProgressReceipt(msg, taskText, logChannelIssue);
          progressReceipt.start();

	          void (async () => {
	            const runId = idGenerator();
	            channelApprovalRoutesByRun.set(runId, {
	              channelKind: msg.channelKind,
	              chatId: msg.chatId,
	              chatType: msg.chatType,
	              senderId: msg.senderId,
	              messageId: msg.id,
	              sessionKey,
	            });
	            channelApprovalRoutesBySessionPrincipal.set(
	              channelApprovalSessionPrincipalKey(sessionKey, msg.senderId),
	              {
	                channelKind: msg.channelKind,
	                chatId: msg.chatId,
	                chatType: msg.chatType,
	                senderId: msg.senderId,
	                messageId: msg.id,
	                sessionKey,
	              },
	            );
	            wakeUiForChannelMessage(msg, runId);
            const channelEntryAdapter = createFridayChannelEntryAdapter({
              engine: channelOrchestrationEngine,
              idGenerator: () => runId,
              resolveChannelPersona: (channelKind) => getChannelPersona(channelKind),
              resolveDisabledToolNames: (channelKind) => resolveFridayChannelDisabledToolNames(channelKind),
              resolveSessionKey: (inboundMessage) => resolveFridayChannelSessionKey({
                channelKind: inboundMessage.channelKind,
                chatId: inboundMessage.chatId,
                senderId: inboundMessage.senderId,
                senderName: inboundMessage.senderName,
                text: inboundMessage.text,
                id: inboundMessage.id,
                timestamp: typeof inboundMessage.timestamp === "number" && Number.isFinite(inboundMessage.timestamp)
                  ? inboundMessage.timestamp
                  : Date.now(),
                chatType: inboundMessage.chatType,
                replyTo: inboundMessage.replyToMessageId,
                timezone: inboundMessage.timezone,
                images: inboundMessage.images,
              }, {
                crossChannelIdentityEnabled,
                identityMap: crossChannelIdentityMap,
              }),
            });
            const messageTimestampMs = typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp)
              ? msg.timestamp
              : Date.now();
            const slowTaskNotifier = createFridayChannelSlowTaskNotifier({
              eventEmitter: agentEventEmitter,
              channelRegistry,
              channelKind: msg.channelKind,
              chatId: msg.chatId,
              replyTo: msg.id,
              runId,
              publicRunUrl: resolveFridayPublicRunUrl(runId),
              sourceText: taskText,
            });
            try {
              const inboundMessage = await mirrorChannelSessionMessage(sessionKey, {
                role: "user",
                content: taskText,
                contentText: taskText,
                idempotencyKey: inboundIdempotencyKey,
                metadata: {
                  sourceMessageId: msg.id,
                  ...(msg.replyTo ? { replyToMessageId: msg.replyTo } : {}),
                  channelKind: msg.channelKind,
                  ...(hasInboundMedia ? { mediaMessage: true } : {}),
                  ...(msg.images?.length ? { images: msg.images } : {}),
                  ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
                },
              }).catch((err) => {
                // Non-fatal: session mirror errors should not block channel handling.
                logChannelIssue({
                  level: "warn",
                  code: "W-CH-SESSION-MIRROR-001",
                  routeId: "hub.channel.session.mirror",
                  error: err,
                });
                return undefined;
              });

              if (channelNaturalTriggerResolver) {
                const naturalTriggerResolution = await channelNaturalTriggerResolver.resolve({
                  text: taskText,
                  sessionKey,
                  channelKind: msg.channelKind,
                  chatId: msg.chatId,
                  senderId: msg.senderId,
                });
                if (naturalTriggerResolution.handled) {
                  const outboundText = sanitizeFridayChannelVisibleReply(naturalTriggerResolution.replyText);
                  const delivery = await progressReceipt.deliverFinal({
                    text: outboundText,
                    runId,
                  });
                  await mirrorChannelSessionMessage(sessionKey, {
                    role: "assistant",
                    content: outboundText,
                    contentText: outboundText,
                    idempotencyKey: `channel:${msg.channelKind}:${msg.chatId}:${msg.id}:natural-trigger-${naturalTriggerResolution.action}`,
                    metadata: {
                      sourceMessageId: delivery.messageId,
                      replyToMessageId: msg.id,
                      channelKind: msg.channelKind,
                      channelNaturalTrigger: true,
                      action: naturalTriggerResolution.action,
                      diagnostics: naturalTriggerResolution.diagnostics,
                      ...(naturalTriggerResolution.action === "executed"
                        ? {
                            workflowId: naturalTriggerResolution.workflowId,
                            workflowVersionId: naturalTriggerResolution.workflowVersionId,
                            workflowRunId: naturalTriggerResolution.workflowRun.id,
                            memoryItemId: naturalTriggerResolution.memoryItemId,
                          }
                        : {}),
                    },
                  }).catch((err) => {
                    logChannelIssue({
                      level: "warn",
                      code: "W-CH-SESSION-MIRROR-001",
                      routeId: "hub.channel.session.mirror.natural_trigger",
                      runId,
                      error: err,
                    });
                  });
                  return;
                }
              }

              // ── Engine delegation (Initiative A-WIRE) ──
              // The engine handles: focus loading, history, turn preparation,
              // evidence blocks, deterministic dispatch, planning gate,
              // agent runtime execution, and focus finalization.
              // Alignment invariant: the engine injects historyMessages, into executeRun() internally.
              const engineResult = await channelEntryAdapter.handleMessage({
                id: msg.id,
                channelKind: msg.channelKind,
                senderId: msg.senderId,
                senderName: msg.senderName,
                chatId: msg.chatId,
                chatType: msg.chatType,
                text: taskText,
                occurredAt: new Date(messageTimestampMs).toISOString(),
                replyToMessageId: msg.replyTo,
                timezone: msg.timezone,
                images: msg.images,
                attachments: msg.attachments,
              });
              const result = {
                runId: engineResult.runId,
                status: engineResult.status,
                response: engineResult.response ?? "",
                toolCallCount: engineResult.toolCallCount,
                durationMs: engineResult.durationMs,
                images: engineResult.images,
              };

              typingController.stopRun();

              const hasResponse = result.response.trim().length > 0;
              const outboundImages = result.status === "completed" &&
                Array.isArray(result.images) &&
                result.images.length > 0
                ? result.images
                : undefined;

              const outboundText = result.status === "awaiting_clarification" || result.status === "awaiting_plan_approval"
                ? sanitizeFridayChannelVisibleReply(stripFridayUiActionHints(result.response))
                : resolveFridayChannelTerminalText({
                  status: result.status === "completed"
                    ? "completed"
                    : result.status === "cancelled"
                      ? "cancelled"
                      : "failed",
                  response: result.response,
                  imageCount: outboundImages?.length ?? 0,
                  sourceText: taskText,
                });

              console.log(
                `[friday] Channel run terminal (${msg.channelKind}): ` +
                  `status=${result.status} hasResponse=${String(hasResponse)} ` +
                  `images=${String(outboundImages?.length ?? 0)}`,
              );

              try {
                const delivery = await progressReceipt.deliverFinal({
                  text: outboundText,
                  runId: result.runId,
                  images: outboundImages,
                });
                // Engine handles planning decisions internally; use "assistant" kind
                // for the outbound delivery metadata patch.
                const assistantMirrorIdempotencyKey = resolveAgentMirrorIdempotencyKey({
                  runId: result.runId,
                  kind: "assistant",
                  status: result.status as FridayAgentRunStatus,
                });
                await hubSessionService.updateMessageMetadataByIdempotency(sessionKey, {
                  idempotencyKey: assistantMirrorIdempotencyKey,
                  metadataPatch: {
                    sourceMessageId: delivery.messageId,
                    replyToMessageId: msg.id,
                    channelKind: msg.channelKind,
                  },
                }).catch((err) => {
                  logChannelIssue({
                    level: "warn",
                    code: "W-CH-SESSION-MIRROR-001",
                    routeId: "hub.channel.session.mirror.outbound_source",
                    runId: result.runId,
                    error: err,
                  });
                });
              } catch (err) {
                logChannelIssue({
                  level: "error",
                  code: "E-CH-OUTBOUND-001",
                  routeId: "hub.channel.delivery.primary",
                  runId: result.runId,
                  error: err,
                });
                const fallbackText = buildFridayChannelDeliveryFailureText(result.runId, taskText);
                await mirrorChannelSessionMessage(sessionKey, {
                  role: "assistant",
                  content: fallbackText,
                  contentText: fallbackText,
                  idempotencyKey: `channel:${msg.channelKind}:${msg.chatId}:${msg.id}:delivery-failure`,
                }).catch((mirrorErr) => {
                  logChannelIssue({
                    level: "warn",
                    code: "W-CH-SESSION-MIRROR-001",
                    routeId: "hub.channel.session.mirror.delivery_failure",
                    runId: result.runId,
                    error: mirrorErr,
                  });
                });
                try {
                  await channelRegistry.send(msg.channelKind, {
                    chatId: msg.chatId,
                    text: fallbackText,
                    replyTo: msg.id,
                  });
                } catch (retryErr) {
                  logChannelIssue({
                    level: "error",
                    code: "E-CH-OUTBOUND-RETRY-001",
                    routeId: "hub.channel.delivery.retry",
                    runId: result.runId,
                    error: retryErr,
                  });
                }
              }
            } catch (err) {
              typingController.stopRun();
              const errorCode = "E-CH-RUN-001";
              const errorMessage = err instanceof Error ? err.message : String(err);
              logChannelIssue({
                level: "error",
                code: errorCode,
                routeId: "hub.channel.run.execute",
                error: err,
              });
              await progressReceipt
                .deliverFinal({
                  text:
                    `Sorry, I couldn't complete your request (${errorCode}). ` +
                    `Correlation: ${correlationId}. Please retry.`,
                })
                .catch((sendErr) => {
                  logChannelIssue({
                    level: "error",
                    code: "E-CH-OUTBOUND-001",
                    routeId: "hub.channel.delivery.run_error",
                    error: sendErr,
                  });
                });
            } finally {
              slowTaskNotifier.stop();
              progressReceipt.stop();
              typingController.stopDispatch();
            }
          })()
            .catch((err) => {
              console.error("[friday][E-CH-RUN-UNHANDLED-001] Unhandled channel run error:", err);
            })
            .finally(() => {
              typingController.seal();
            });
        };

        // OC-004: Wrap handler with inbound debouncer
        const channelDebounceMs = parseInt(process.env.FRIDAY_CHANNEL_DEBOUNCE_MS ?? "0", 10) || 0;
        const channelDebouncer = createFridayChannelInboundDebouncer({
          handler: channelMessageHandler,
          windowMs: channelDebounceMs,
        });
        const debouncedHandler = (msg: FridayChannelMessage) => channelDebouncer.submit(msg);
        liveChannelMessageHandler = debouncedHandler;

        if (channelRegistry.list().length > 0) {
          const channelStartSummary = await channelRegistry.startAllBestEffort(debouncedHandler);
          if (channelStartSummary.startedKinds.length > 0) {
            console.log(
              `[friday] Started ${String(channelStartSummary.startedKinds.length)} channel(s): ` +
                channelStartSummary.startedKinds.join(", "),
            );
            if (channelDebounceMs > 0) {
              console.log(`[friday] Channel inbound debounce: ${String(channelDebounceMs)}ms`);
            }
          }
          if (channelStartSummary.failed.length > 0) {
            console.error(
              `[friday] Failed to start ${String(channelStartSummary.failed.length)} channel(s): ` +
                channelStartSummary.failed
                  .map((failure) => `${failure.kind}: ${failure.message}`)
                  .join("; "),
            );
          }
        }
        channelRegistry.startHealthMonitor(debouncedHandler);
      }

      // 5. Start memory file sync
      if (memoryFileSyncService) {
        await memoryFileSyncService.start();
      }

      // 6. Start job scheduler
      if (jobScheduler) {
        await jobScheduler.start();
      }

      hubState = "running";
      upSince = new Date().toISOString();

      // ─── Startup diagnostics ───
      {
        const providerCount = (await providerService.listProviders()).length;
        const connectedChannelCount = getEnabledChannelKinds().length;
        const configuredChannelCount = channelRegistry.list().length;
        const skillCount = registry.list().length;
        console.log("[friday] ✓ Friday is running");
        console.log(`[friday]   Providers: ${String(providerCount)}${providerCount === 0 ? " — set FRIDAY_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY) or visit /setup to add one" : ""}`);
        console.log(
          `[friday]   Channels:  ${String(connectedChannelCount)}` +
            (configuredChannelCount === 0
              ? " — no messaging channels configured"
              : connectedChannelCount === configuredChannelCount
                ? ""
                : ` connected / ${String(configuredChannelCount)} configured`),
        );
        console.log(`[friday]   Skills:    ${String(skillCount)}`);
      }
    },

    async stop(): Promise<void> {
      // Shutdown in reverse order: API → workflows → skills → state
      // P2-DATA: Use transitional "stopping" state — set "stopped" after cleanup completes
      hubState = "stopping";
      upSince = null;

      // P1-SHUT-001/002/003: Stop services started during bootstrap
      let observabilityStopError: unknown;
      try { await observabilityService.shutdown(); } catch (err) {
      observabilityStopError = err;
      warnHubBootstrapOperationFailureOnce(err); /* best-effort */ }
      try { agentLearningBridge?.stop(); } catch (err) {
      warnHubBootstrapOperationFailureOnce(err); /* best-effort */ }
      if (reflexCuratorInterval) {
        clearInterval(reflexCuratorInterval);
        reflexCuratorInterval = undefined;
      }
      try { if (mcpAdapter && "close" in mcpAdapter) await (mcpAdapter as unknown as { close(): Promise<void> }).close(); } catch (err) {
      warnHubBootstrapOperationFailureOnce(err); /* best-effort */ }

      // 1. Stop job scheduler (F11: await in-flight)
      if (jobScheduler) {
        await jobScheduler.stop();
      }

      // 2. Stop memory file sync
      if (memoryFileSyncService) {
        await memoryFileSyncService.stop();
      }

      // 3. Stop channel plugins
      await channelRegistry.stopAll();
      if (systemCompanionBridge?.isConnected()) {
        await systemCompanionBridge.disconnect();
      }
      if (systemCompanionServer?.isRunning()) {
        await systemCompanionServer.stop();
      }
      if (desktopSessionManager?.isConnected()) {
        desktopSessionManager.disconnect();
      }
      await browserManager?.close();
      await subagentRegistry.drain();
      // 4. API runtime — no async teardown yet (HTTP server stop is CLI concern)
      // 5. Workflow runtime — scheduler now handles cron lifecycle
      // 6. Skills
      await registry.close();
      // 7. State
      stateRuntime?.close();
      hubState = "stopped";
      if (observabilityStopError) {
        throw observabilityStopError;
      }
    },

    status(): FridayHubStatus {
      return {
        state: hubState,
        skillCount: registry.list().length,
        upSince,
      };
    },

    skills: registry,
    executor,
    providerService,
    skillGenerator,
    converterService,
    workflowGenerator,
    workflowRuntime,
    autonomousEngine,
    selfHealing: selfHealingApiService,
    apiRuntime,
    channelRegistry,
    satelliteRuntime,
    mcpAdapter,
    webchatWsService,
    // F1.5 diagnostic readback surface — the last self-probe outcome (undefined when the
    // default-OFF flag is unset, i.e. the diagnostic never ran). Read-only; never holds the bearer.
    rustRouteDiagnostic: {
      lastProbeOutcome: () => rustRouteProbeOutcomeHolder?.get(),
    },
  };

  return hub;

  } catch (bootstrapError) {
    // P0-001: Clean up SQLite connections on partial bootstrap failure
    stateRuntime?.close();
    throw bootstrapError;
  }
}

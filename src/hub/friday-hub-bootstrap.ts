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
import { createFridayAgentAutonomousTool } from "../agent/tools/friday-agent-autonomous-tool.js";
import { createFridayAgentSetupAssistantTool } from "../agent/tools/friday-agent-setup-assistant-tool.js";
import { createFridayAgentSetupTool } from "../agent/tools/friday-agent-setup-tool.js";
import {
  createFridayEnvironmentScanner,
  createFridayPrerequisiteInstaller,
  createFridaySetupAssistant,
  createFridaySetupCoordinator,
  createFridaySetupRecipeExecutor,
  createFridaySetupRecipeRegistry,
} from "../setup/index.js";
import { createOnboardingEngine } from "../uix/engine/index.js";
import {
  createFridayCrossBorderPackService,
  type FridayCrossBorderPackService,
} from "../packs/cross-border/friday-cross-border-pack-service.js";
import { FridayDomainError } from "#errors";
import { isFridayTestSecurityWarningSuppressed, safeJsonParse } from "#utilities";
import { initializeFridayState } from "#state";
import type { FridayStateRuntime } from "#state";
import { createFridayLocalDaemonService } from "#daemon";
import {
  createFridayProviderCostCalculator,
  createFridayProviderPricingCatalog,
  createFridayProviderService,
  createFridaySecretRepository,
  decryptSecret,
  getFridayProviderPreset,
  getMasterKey,
  resolveFridayRoutingStabilityWarning,
} from "#providers";
import type { FridayEncryptedEnvelope, FridayProviderApi, FridayProviderKind, FridayProviderService } from "#providers";
import { FridaySkillRegistryImpl, safeParseFridaySkillManifestV2 } from "#skills";
import { createFridaySkillExecutor } from "#skills";
import { createFridaySkillGeneratorService } from "#skills/generator";
import { createFridayWorkflowGeneratorService } from "#workflows";
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
import { createFridayApiRuntime, createFridayDeterministicPipelineRuntime } from "#api";
import type { FridaySystemRoutesDeps } from "#api";
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
  createFridayPluginMarketplaceClient,
  createFridayPluginRegistryService,
  createFridayPluginRepository,
  createFridayPluginService,
  createFridayPluginSignatureVerifier,
} from "#plugins";
import type { FridayPluginService } from "#plugins";
import { createFridayEpisodeExtractor, createFridayMemoryFileSyncRepository, createFridayMemoryFileSyncService, createFridayMemoryService, createFridayPatternExtractor } from "#memory";
import {
  createFridaySessionMemoryExtractionService,
  finalizeFridayConversationFocus,
  prepareFridayConversationTurn,
} from "#sessions";
import type { FridayConversationBlock } from "#sessions";
import type { FridayMemoryFileSyncService, FridayMemoryService } from "#memory";
import {
  buildFridayAgentRunContextSummarySnapshot,
  buildFridayAgentRunHealthSnapshot,
  buildFridayAgentSystemPrompt,
  buildFridayEvidenceBlocks,
  createDefaultFridayDecisionEngine,
  createFridayAgentAgentsListTool,
  createFridayAgentArtifactWriter,
  createFridayAgentAutomationRepository,
  createFridayAgentCronTool,
  createFridayAgentEventEmitter,
  createFridayAgentFeedbackTool,
  createFridayAgentGatewayTool,
  createFridayAgentImageAnalysisTool,
  createFridayAgentLearningBridge,
  createFridayAgentLlmClient,
  createFridayAgentMemoryExtractTool,
  createFridayAgentMessageTool,
  createFridayAgentPlanningGateService,
  createFridayAgentReviewGate,
  createFridayAgentRunEventRepository,
  createFridayAgentRunRepository,
  createFridayAgentRuntime,
  createFridayAgentSelfTestService,
  createFridayAgentSkillGeneratorTool,
  createFridayAgentSkillImportTool,
  createFridayAgentSsrfGuard,
  createFridayAgentSubagentTools,
  createFridayAgentToolRegistry,
  createFridayAgentWorkflowGeneratorTool,
  createFridayMcpAdapter,
  createFridaySubagentRegistry,
  createFridayWorkspaceContextEngine,
  createFridayWorldStateManager,
  inferFridaySubagentProfile,
  listFridayMcpServerReadiness,
  parseFridayMcpServersFromEnv,
  resolveFridayAgentTaskProfile,
  resolveFridayContextEnginePromptFragment,
  taskLikelyNeedsWriteAccessForSubagent,
} from "#agent";
import type { FridayAgentModeChangedPayload, FridayAgentRunDegradedPayload, loadFridayWorkspaceContext } from "#agent";
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
  parseFridayChannelsConfig,
  resolveFridayChannelSecretPolicy,
} from "#channels";
import type { FridayChannelMessage, FridayChannelRegistry } from "#channels";
import { createFridayChannelInboundDebouncer, createFridayChannelTypingController, sanitizeChannelInput } from "#channels";
import { createFridayChannelSlowTaskNotifier } from "../channels/friday-channel-slow-task-notifier.js";
import { resolveFridayPublicRunUrl } from "../agent/runtime/friday-public-run-url.js";
import {
  createFridaySatelliteRepository,
  createFridaySatelliteRuntime,
} from "#satellites";
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
} from "#learning";
import {
  createFridayObservabilityApiService,
  FRIDAY_BUILT_IN_SELF_HEALING_ALERT_RULE_ID,
} from "../observability/services/friday-observability-api-service.js";
import { createFridaySatelliteRuntimeRoutes } from "../api/http/routes/friday-satellite-runtime-routes.js";
import { createFridaySessionService } from "#sessions";
import {
  computeNextRunAtMs,
  createFridayApprovalExpiryJob,
  createFridayJobSchedulerRepository,
  createFridayJobSchedulerService,
  createFridayLearningMetricsJob,
  createFridaySessionLifecycleJob,
  createFridaySessionMemoryExtractionWorkerJob,
  createFridayWorkflowCronTriggerJob,
  createFridayWorkflowTimeoutJob,
} from "#jobs";
import type {
  FridayJobSchedulerRepository,
  FridayJobSchedulerService,
  FridayScheduledJobDefinition,
} from "#jobs";
import { createFridayBrowserManager, type FridayBrowserManager } from "#browser";
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
  createFridaySystemUnixSocketBridge,
  createFridaySystemUnixSocketCompanionServer,
  resolveFridaySystemCompanionAuthToken,
  resolveFridaySystemCompanionPipeName,
  resolveFridaySystemCompanionServerMode,
} from "../system/index.js";
import type { FridaySystemRemoteMode, FridaySystemService } from "../system/index.js";
import { buildFridayCommunicationPromptFragment, resolveFridayCommunicationPersona } from "../uix/services/friday-communication-persona.js";
import { createFridayUixGuidedContextRepository } from "../uix/persistence/friday-uix-guided-context-repository.js";
import { createFridayUixUserPreferenceRepository } from "../uix/persistence/friday-uix-user-preference-repository.js";
import { createFridayOnboardingSessionRepository } from "../uix/persistence/friday-onboarding-session-repository.js";
import { createFridayUixSurfaceService } from "../uix/services/friday-uix-surface-service.js";
import { appendFridayAuditLog, resolveFridayAuditLogPath } from "./services/friday-hub-audit-log-writer.js";
import { createFridayGatewayService } from "./services/friday-gateway-service.js";
import { createFridaySkillMarketplaceRuntime } from "#skills";
import { createFridayMarketplaceCommercePersistence } from "../marketplace/persistence/index.js";
import { FridayMarketplaceAssetCatalogService } from "../marketplace/services/friday-marketplace-asset-catalog-service.js";
import { FridayMarketplaceCreatorService } from "../marketplace/services/friday-marketplace-creator-service.js";
import { FridayMarketplaceRequestBoardService } from "../marketplace/services/friday-marketplace-request-board-service.js";
import { assertListingExecutionReady } from "../marketplace/engine/index.js";
import type { MarketplaceAuditEventSink } from "../marketplace/engine/index.js";
import type { FridayMarketplaceAssetType } from "../marketplace/model/index.js";

// ─── Extracted helpers, types, and stubs ───

import {
  buildFridayChannelDeliveryFailureText,
  createFridayHubAutoFixExecutionSupport,
  createStubConfigManager,
  createStubMemoryState,
  deriveMarketplaceSkillIdCandidates,
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
  resolveFridayChannelSessionKey,
  resolveFridayChannelTerminalText,
  resolveTokenSecret,
} from "./bootstrap/hub-helpers.js";
import { resolveFridayCapabilityGates } from "./bootstrap/friday-capability-gates.js";

// Re-export public API for backward compatibility with `#hub` barrel.
export {
  parseFridayChannelIdentityMap,
  resolveFridayChannelDisabledToolNames,
  resolveFridayChannelSessionKey,
  resolveTokenSecret,
} from "./bootstrap/hub-helpers.js";

type FridayWarnSink = (message: string) => void;

// P2-06: Module-level Set avoids WeakMap edge cases with replaced warn sinks.
const warnedMessages = new Set<string>();

function warnOnce(warn: FridayWarnSink, message: string): void {
  if (warnedMessages.has(message)) return;
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

function isExpectedVitestProviderNoRouting(error: unknown): boolean {
  return Boolean(process.env.VITEST)
    && error instanceof FridayDomainError
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

/** Default server version reported by the API runtime. */
const FRIDAY_HUB_DEFAULT_SERVER_VERSION = FRIDAY_VERSION;
const FRIDAY_AGENT_ROUTE_DEFAULT_MODEL = "default";
const FRIDAY_HUB_SKILL_COMPAT_VERSION = "1.0.0";

const FRIDAY_CHANNEL_MAX_MESSAGE_LENGTH = 4000;
const FRIDAY_CHANNEL_CONTEXT_HISTORY_LIMIT = 24;

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
}> = [
  { envVar: "ANTHROPIC_API_KEY", kind: "anthropic", defaultModel: "claude-sonnet-4-20250514" },
  { envVar: "OPENAI_API_KEY", kind: "openai", defaultModel: "gpt-4o" },
  { envVar: "GOOGLE_API_KEY", kind: "google", defaultModel: "gemini-2.0-flash" },
  { envVar: "OPENROUTER_API_KEY", kind: "openrouter", defaultModel: "anthropic/claude-sonnet-4" },
  { envVar: "GROQ_API_KEY", kind: "groq", defaultModel: "llama-3.3-70b-versatile" },
  { envVar: "MISTRAL_API_KEY", kind: "mistral", defaultModel: "mistral-large-latest" },
  { envVar: "XAI_API_KEY", kind: "xai", defaultModel: "grok-3-mini" },
];

/** Routing priority: anthropic first, then openai, then detection order. */
const ROUTING_PRIORITY: readonly FridayProviderKind[] = ["anthropic", "openai"];

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
        supportedModels: [entry.defaultModel],
        defaultModel: entry.defaultModel,
        validateOnSave: false,
      });
      detected.push({ kind: entry.kind, id: profile.id });
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

  // Set default routing if none configured and we registered at least one provider
  if (detected.length > 0) {
    const routing = await providerService.getRoutingConfig();
    if (!routing.defaultProviderId) {
      // Pick best provider by priority
      let chosen = detected[0]!;
      for (const priorityKind of ROUTING_PRIORITY) {
        const match = detected.find((d) => d.kind === priorityKind);
        if (match) {
          chosen = match;
          break;
        }
      }
      const chosenEntry = ENV_PROVIDER_MAP.find((e) => e.kind === chosen.kind);
      const defaultModel = chosenEntry?.defaultModel ?? (chosen.kind === "ollama" ? "llama3.2" : "default");
      try {
        await providerService.setRoutingConfig({
          defaultProviderId: chosen.id,
          defaultModel,
          fallbackProviderIds: detected
            .filter((d) => d.id !== chosen.id)
            .map((d) => d.id),
        });
      } catch (err) {
        console.warn(
          "[friday] Auto-detect: failed to set default routing:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  return detected;
}

// ─── Resolved Hub Config ───

/**
 * Resolves hub configuration with precedence: explicit config > env var > default.
 */
export function resolveFridayHubConfig(
  input: FridayHubConfig,
  env: NodeJS.ProcessEnv = process.env,
): FridayResolvedHubConfig {
  const port =
    input.port ??
    (env.FRIDAY_PORT ? parseInt(env.FRIDAY_PORT, 10) : undefined) ??
    3141;

  const stateDir = input.stateDir ?? env.FRIDAY_STATE_DIR ?? undefined;

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

  const isProduction = env.NODE_ENV === "production";
  const tokenSecretExplicit = tokenSecretResult.source === "config" || tokenSecretResult.source === "env";
  const allowPasswordlessLocalLogin = !tokenSecretExplicit && !isProduction;
  const localBypassExplicit = (env.FRIDAY_ALLOW_LOCAL_BYPASS_LOGIN ?? "").trim().toLowerCase();
  const allowLocalBypassLogin = localBypassExplicit
    ? ["1", "true", "yes", "on"].includes(localBypassExplicit)
    : allowPasswordlessLocalLogin;

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

  const pluginRuntimeModeRaw = input.pluginRuntimeMode ?? env.FRIDAY_PLUGIN_RUNTIME_MODE ?? "full";
  const pluginRuntimeMode = pluginRuntimeModeRaw === "stub" ? "stub" : "full";
  const pipelineRuntimeConfig = resolveFridayPipelineRuntimeConfig(env);

  // Self-hosted deployments typically use local providers (Ollama on localhost).
  // Default allowPrivateNetwork to true unless explicitly disabled or in production mode.
  let allowPrivateNetwork: boolean;
  const envAllowPrivate = (env.FRIDAY_ALLOW_PRIVATE_NETWORK ?? "").trim().toLowerCase();
  if (envAllowPrivate) {
    allowPrivateNetwork = ["1", "true", "yes", "on"].includes(envAllowPrivate);
  } else if (input.ssrfPolicy?.allowPrivateNetwork !== undefined) {
    allowPrivateNetwork = input.ssrfPolicy.allowPrivateNetwork;
  } else {
    // Default: allow for self-hosted (non-production); disallow in production
    allowPrivateNetwork = !isProduction;
  }

  return {
    stateDir,
    skillDirs,
    port,
    tokenSecret,
    tokenSecretSource: tokenSecretResult.source,
    serverVersion,
    corsOrigins,
    logRequests,
    pluginRuntimeMode,
    allowPasswordlessLocalLogin,
    allowLocalBypassLogin,
    pipelineEnabled: pipelineRuntimeConfig.enabled,
    pipelineMode: pipelineRuntimeConfig.mode,
    ssrfPolicy: { allowPrivateNetwork },
  };
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
      // P2: Always warn when creating passwordless admin (password_hash = NULL)
      if (!isFridayTestSecurityWarningSuppressed()) {
        warnHubBootstrapOnce(
          "[friday][SECURITY] Created default admin user (admin@friday.dev) with NO password — set a passphrase via the setup wizard for production use",
        );
      }
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

  // 2. Create stub services for standalone operation.
  // P2: configManager and memoryState are intentionally stubbed for v0.4.x standalone mode.
  // Full implementations with persistence are planned for the multi-node milestone.
  // Config mutations via API are silently no-ops; use env vars and friday.config.yaml instead.
  const configManager = createStubConfigManager(config, stateRuntime);
  const auditLogPath = resolveFridayAuditLogPath(config.stateDir ?? ".");
  const memoryState = createStubMemoryState(auditLogPath);

  // 3. Create skill registry
  const registry = new FridaySkillRegistryImpl({
    workspaceDir: config.stateDir ?? ".",
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

  // Auth policy: dev mode = token secret was NOT explicitly set AND not production
  const isProduction = process.env.NODE_ENV === "production";
  const tokenSecretExplicit = tokenSecretResult.source === "config" || tokenSecretResult.source === "env";
  const allowPasswordlessLocalLogin = !tokenSecretExplicit && !isProduction;
  const localBypassExplicit2 = (process.env.FRIDAY_ALLOW_LOCAL_BYPASS_LOGIN ?? "").trim().toLowerCase();
  const allowLocalBypassLogin = localBypassExplicit2
    ? ["1", "true", "yes", "on"].includes(localBypassExplicit2)
    : allowPasswordlessLocalLogin;
  const pipelineRuntimeConfig = resolveFridayPipelineRuntimeConfig(process.env);
  const capabilityGates = resolveFridayCapabilityGates(process.env);
  const crossChannelIdentityEnabled = process.env.FRIDAY_CROSS_CHANNEL_IDENTITY_ENABLED === "true";
  const crossChannelIdentityMap = parseFridayChannelIdentityMap(process.env.FRIDAY_CHANNEL_IDENTITY_MAP);
  const configuredPluginRuntimeMode = (
    config.pluginRuntimeMode ??
    process.env.FRIDAY_PLUGIN_RUNTIME_MODE ??
    "full"
  ) === "stub"
    ? "stub"
    : "full";

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
  });

  let browserManager: FridayBrowserManager | undefined;
  const channelRegistry: FridayChannelRegistry = createFridayChannelRegistry();

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

  // 8. Create AI skill generator service
  const skillGenerator = createFridaySkillGeneratorService({
    db: stateRuntime.sqlite,
    providerService,
    registry,
    configManager,
    memoryStateService: memoryState,
    idGenerator,
    nowIso,
  });

  // 9. Create converter service
  const converterRegistry = createFridaySkillConverterRegistry();
  for (const factory of FRIDAY_DEFAULT_CONVERTER_FACTORIES) {
    converterRegistry.register(factory());
  }

  const converterInstaller = createFridaySkillImportInstaller();
  const converterArchiver = createFridaySkillPackageArchiver();

  const converterService = createFridaySkillConverterService({
    registry: converterRegistry,
    installer: converterInstaller,
    archiver: converterArchiver,
    context: {
      workspaceDir: config.stateDir ?? ".",
      managedSkillsDir: config.skillDirs[1] ?? "managed-skills",
      nowIso,
    },
    hubVersion: FRIDAY_HUB_SKILL_COMPAT_VERSION,
    supportedApiVersions: ["1"],
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
    });
  }

  // ─── Workflow runtime ───

  const triggerRepo = createFridayWorkflowTriggerRepository({ db: stateRuntime!.sqlite });
  // P2-03: Bounded event buffers prevent OOM if publisher init is delayed.
  const FRIDAY_EVENT_BUFFER_MAX = 10_000;
  const workflowRealtimeEventBuffer: Array<{ streamId: string; event: string; payload: Record<string, unknown> }> = [];
  let workflowRealtimeEventPublisher:
    | {
      publish(streamId: string, event: string, payload: Record<string, unknown>): void;
    }
    | undefined;

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

  let crossBorderPackServiceRef: FridayCrossBorderPackService | null = null;
  let workflowRuntimeRef: ReturnType<typeof createFridayWorkflowRuntime> | null = null;

  const workflowRuntime = createFridayWorkflowRuntime({
    db: stateRuntime!.sqlite,
    idGenerator,
    nowIso,
    computeChecksum,
    resolveSkill: (skillId) => {
      const skill = registry.get(skillId);
      return skill ?? null;
    },
    invokeSkill: invokeSkillForWorkflow,
    publishEvent: publishWorkflowRealtimeEvent,
    triggerRepo,
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
  });
  const workflowBuilderRuntime = createFridayWorkflowBuilderRuntime({
    db: stateRuntime!.sqlite,
    crudService: workflowRuntime.crud,
    idGenerator,
    nowIso,
    computeChecksum,
  });
  workflowRuntimeRef = workflowRuntime;

  // ─── Workflow generator service ───

  const workflowGenerator = createFridayWorkflowGeneratorService({
    db: stateRuntime!.sqlite,
    providerService,
    workflowCrud: workflowRuntime.crud,
    skillRegistry: registry,
    idGenerator,
    nowIso,
    computeChecksum,
  });

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
  const workspaceRoot = config.stateDir ?? ".";
  const agentArtifactWriter = createFridayAgentArtifactWriter(workspaceRoot);

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
      const { result: events, route, attempts, routingDecision } = await providerService.runWithFallback({
        requestedModel: resolvedModel,
        requestedProviderId: params.providerId,
        tenantContext: params.tenantContext,
        routingContext: params.routingContext,
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
          const costUsd = costCalculator.calculate({
            providerKind: route.provider.kind,
            model: route.model,
            usage: {
              input: event.inputTokens,
              output: event.outputTokens,
              cacheRead: 0,
              cacheWrite: 0,
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
  browserManager = createFridayBrowserManager({
    workspaceRoot,
    presentationMode: browserPresentationMode,
    hostBrowser: browserHostConfig,
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
      process.env.FRIDAY_SYSTEM_REMOTE_MODE === "disabled"
        ? "disabled"
        : "trusted_private_network";
    const systemCloudPlanningMode = process.env.FRIDAY_SYSTEM_CLOUD_PLANNING === "local_only"
      ? "local_only"
      : process.env.FRIDAY_SYSTEM_CLOUD_PLANNING === "hybrid"
        ? "hybrid"
        : "opt_in";
    const resolvedPort = config.port
      ?? (process.env.FRIDAY_PORT ? Number.parseInt(process.env.FRIDAY_PORT, 10) : undefined)
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
    const { token: companionAuthToken } = await resolveFridaySystemCompanionAuthToken({
      workspaceRoot,
      explicitToken: process.env.FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN,
      explicitTokenFilePath: process.env.FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN_FILE,
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
      cloudPlanningMode: systemCloudPlanningMode,
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
        update: (approvalId, req) => {
          const approval = systemService!.updateApprovalRule(approvalId, {
            decision: req.decision,
            rationale: req.rationale,
          });
          if (!approval) {
            throw new FridayDomainError("SYSTEM_APPROVAL_NOT_FOUND", "Approval rule not found", {
              httpStatus: 404,
            });
          }
          return { approval };
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
  });

  // Build agent tool registry (exec, read, write, edit, web_fetch, browser, xhs, + new tools)
  // IMPL-4: Pass SSRF guard to tool registry
  // Lazy getter for agentRuntime — runtime is created after tool list, so sessions tool
  // receives a deferred reference that resolves once runtime is wired up.
  let _agentRuntimeRef: FridayAgentRuntime | undefined;
  const agentRuntimeGetter = () => _agentRuntimeRef;
  let subagentRegistry!: ReturnType<typeof createFridaySubagentRegistry>;

  // Optional MCP adapter (JSON config from FRIDAY_MCP_SERVERS).
  // Example:
  // FRIDAY_MCP_SERVERS='[{"id":"filesystem","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/Users/me"]}]'
  const mcpServers = parseFridayMcpServersFromEnv(process.env);
  const mcpAdapter = mcpServers.length > 0
    ? createFridayMcpAdapter({ servers: mcpServers })
    : undefined;
  if (mcpAdapter) {
    console.log(`[friday] MCP adapter enabled with ${String(mcpServers.length)} server(s)`);
  }
  const configuredSearchProvider = process.env.FRIDAY_SEARCH_PROVIDER?.trim().toLowerCase();
  const hasConfiguredSearchKey = Boolean(
    process.env.FRIDAY_SERPER_API_KEY?.trim() || process.env.FRIDAY_TAVILY_API_KEY?.trim(),
  );
  const searchWarning = configuredSearchProvider === "serper" && !process.env.FRIDAY_SERPER_API_KEY?.trim()
    ? 'Configured search provider "serper" is missing FRIDAY_SERPER_API_KEY; time-sensitive news lookup is unverified.'
    : configuredSearchProvider === "tavily" && !process.env.FRIDAY_TAVILY_API_KEY?.trim()
      ? 'Configured search provider "tavily" is missing FRIDAY_TAVILY_API_KEY; time-sensitive news lookup is unverified.'
      : !configuredSearchProvider
        ? "FRIDAY_SEARCH_PROVIDER is not configured; Friday will fall back to DuckDuckGo HTML search and time-sensitive news lookup is unverified."
        : !hasConfiguredSearchKey && (configuredSearchProvider === "serper" || configuredSearchProvider === "tavily")
          ? `Search provider "${configuredSearchProvider}" has no API key configured; time-sensitive news lookup is unverified.`
          : undefined;
  if (process.env.NODE_ENV !== "test") {
    if (searchWarning) {
      console.warn(`[friday] ${searchWarning}`);
    }
  }
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
      servers: mcpAdapter?.listServers() ?? [],
      serverStates: mcpAdapter?.listServerStates() ?? [],
    });
    const providerCount = await providerService.listProviders()
      .then((providers) => providers.length)
      .catch(() => 0);
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
        enabled: mcpServers.length > 0,
        serverCount: mcpServers.length,
        servers: mcpServers.map((server) => ({
          name: server.name,
          connected: server.connected,
          authenticated: server.authenticated,
        })),
      },
      provider: {
        available: true,
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
              summary: trackedRun.summary,
              responseText: trackedRun.responseText,
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
      ? (process.env.FRIDAY_SYSTEM_REMOTE_MODE === "disabled" ? "disabled" : "trusted_private_network")
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
    workflowExecutionService: workflowRuntime.execution,
    memoryService,
    browserManager,
    xhsPageInteractions,
    xhsSessionManager,
    desktopSessionManager,
    systemService,
    ssrfGuard: agentSsrfGuard,
    sessionService: hubSessionService,
    agentRuntimeGetter,
    mcpAdapter,
    providerService,
    webSearchProvider: process.env.FRIDAY_SEARCH_PROVIDER,
    webSearchApiKey: process.env.FRIDAY_SERPER_API_KEY ?? process.env.FRIDAY_TAVILY_API_KEY,
    capabilitySnapshotGetter: getAgentCapabilitySnapshot,
    taskStatusSnapshotGetter: getAgentTaskStatusSnapshot,
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

  // Resolve the default model/provider for agent runtime
  // This is a best-effort resolution at boot time; individual runs can override.
  const agentDefaultModel = FRIDAY_AGENT_ROUTE_DEFAULT_MODEL;
  const agentDefaultProviderId = "default";

  // ─── Resolve provider identity at boot for system prompt ───
  let agentModelIdentity = "an AI model";
  try {
    const defaultRoute = await providerService.resolveRoute(undefined);
    const providerKind = defaultRoute.provider.kind; // e.g. "anthropic"
    const modelName = defaultRoute.model;            // e.g. "claude-opus-4-5-20251101"
    agentModelIdentity = `${modelName} (provider: ${providerKind})`;
  } catch (err) {
      if (!isExpectedVitestProviderNoRouting(err)) {
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
    if (routingWarning) {
      warnHubBootstrapOnce(`[friday][W-PROVIDER-ROUTING-001] ${routingWarning}`);
    }
  } catch (err) {
      if (!isExpectedVitestProviderNoRouting(err)) {
        warnHubBootstrapOperationFailureOnce(err);
      }
    // Non-fatal: provider routing diagnostics should not block startup.
  }

  // ── World Model Readiness layer ──
  const worldModelEpisodeExtractor = createFridayEpisodeExtractor({
    db: stateRuntime!.sqlite,
    idGenerator,
    nowIso,
  });
  const worldModelStateManager = createFridayWorldStateManager({
    db: stateRuntime!.sqlite,
    idGenerator,
    nowIso,
  });
  const worldModelDecisionEngine = createDefaultFridayDecisionEngine();
  const worldModelPatternExtractor = createFridayPatternExtractor({
    db: stateRuntime!.sqlite,
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
      } catch (err) {
        console.warn("[friday][world-model] afterTurn episode extraction failed:", err instanceof Error ? err.message : String(err));
      }
    },
  };

  // Dynamic system prompt builder — invoked at each executeRun() with the
  // current set of registered tool names, so the prompt is always accurate.
  // Loads workspace context files (AGENTS.md, SOUL.md, USER.md, MEMORY.md)
  // fresh on each run so edits take effect immediately.
  const agentSystemPromptBuilder = async (input: {
    userId?: string;
    toolNames: string[];
    nowIso: string;
    timezone: string;
    localDate: string;
    task?: string;
    conversationContext?: {
      selectedBlocks?: FridayConversationBlock[];
    };
  }) => {
    let workspaceContext: string | undefined;
    let workspaceContextSummary:
      | Awaited<ReturnType<typeof loadFridayWorkspaceContext>>["summary"]
      | undefined;
    try {
      const ctx = await resolveFridayContextEnginePromptFragment(agentContextEngine, {
        task: input.task,
        conversationContext: input.conversationContext,
      });
      if (ctx.promptFragment) {
        workspaceContext = ctx.promptFragment;
      }
      workspaceContextSummary = ctx.workspaceContext?.summary;
    } catch (err) {
      warnHubBootstrapOperationFailureOnce(err);
      // Non-fatal: workspace context loading failure should not block agent runs.
    }

    // ── World model context injection (C4) ──
    // Load recent interactions so the agent has access to learned knowledge.
    if (input.userId) {
      try {
        const recentEpisodes = await worldModelStateManager.getRecentEpisodes(input.userId, 5);
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
    }
    const starterSkills = listInstalledStarterSkills().slice(0, 8);
    const prompt = buildFridayAgentSystemPrompt({
      toolNames: input.toolNames,
      modelIdentity: agentModelIdentity,
      version: FRIDAY_VERSION,
      workspaceContext,
      starterSkills,
      enforceStarterSkillRouting: starterSkillRoutingEnforced,
      subagentForkModeEnabled,
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
          && typeof mcpAdapter !== "undefined"
          && !!mcpAdapter
          && mcpAdapter.listServers().length > 0,
        mcpServerCount: mcpAdapter?.listServers().length ?? 0,
        cronEnabled: input.toolNames.includes("cron") && !!jobScheduler && !!schedulerRepo,
        subagentsEnabled: input.toolNames.includes("spawn_subagent"),
        marketplaceEnabled: !!marketplaceRuntime,
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
    const mcpStates = mcpAdapter?.listServerStates() ?? [];
    const components = [
      workspaceContextSummary && workspaceContextSummary.promptChars > 0
        ? {
            kind: "workspace_context" as const,
            estimatedChars: workspaceContextSummary.promptChars,
            count: workspaceContextSummary.selectedFileCount,
            metadata: {
              pathRuleCount: workspaceContextSummary.selectedPathRuleCount,
              candidatePaths: workspaceContextSummary.candidatePaths,
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
    ].filter((component): component is NonNullable<typeof component> => component !== null);
    return {
      prompt,
      contextCostSummary: {
        totalEstimatedChars: components.reduce((sum, component) => sum + component.estimatedChars, 0),
        components,
      },
    };
  };

  // ─── Self-learning runtime (created early to avoid race with agentRuntime) ───
  const hubAutoFixSupport = createFridayHubAutoFixExecutionSupport({
    registry,
    memoryState,
    providerService,
    workflowRuntime,
    nowIso,
  });

  const selfLearningRuntime = createFridaySelfLearningRuntime({
    db: stateRuntime.sqlite,
    idGenerator,
    nowIso,
    stepExecutors: hubAutoFixSupport.stepExecutors,
    stepVerifiers: hubAutoFixSupport.stepVerifiers,
  });

  // P1-01: Assign immediately so learningContextBuilder and communicationPromptBuilder
  // always have access to learned preferences — no startup window gap.
  const _learningContextRef = selfLearningRuntime.context;
  const uixUserPreferenceRepository = createFridayUixUserPreferenceRepository();
  const uixGuidedContextRepository = createFridayUixGuidedContextRepository();

  // ─── Tool approval gates (GAP 2) ───
  // Shared promise map for tool-level approval flow.
  // The agent runtime awaits the resolver; the API routes resolve/reject the promise.
  const toolApprovalGates = new Map<string, Map<string, {
    resolve: (v: { approved: boolean; reason?: string }) => void;
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
    };
  }>>();

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
    scopes?: string[];
    sessionKey?: string;
    surface?: string;
    expiresAt?: string;
  }): void => {
    appendFridayAuditLog(auditLogPath, {
      id: idGenerator(),
      ts: nowIso(),
      actorType: input.principalId ? "user" : "service",
      ...(input.principalId ? { actorId: input.principalId } : {}),
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
        expiresAt: input.expiresAt,
        sessionKey: input.sessionKey,
        surface: input.surface,
        scopes: input.scopes,
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
  }): Promise<{ approved: boolean; reason?: string }> => {
    let runMap = toolApprovalGates.get(prompt.runId);
    if (!runMap) {
      runMap = new Map();
      toolApprovalGates.set(prompt.runId, runMap);
    }
    return new Promise<{ approved: boolean; reason?: string }>((resolve) => {
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
        },
      });
    });
  };

  const resolveToolApproval = (
    runId: string,
    toolCallId: string,
    approved: boolean,
    reason?: string,
  ): { resolved: boolean; grantId?: string; decision?: "approved" | "rejected" } => {
    const runMap = toolApprovalGates.get(runId);
    if (!runMap) return { resolved: false };
    const gate = runMap.get(toolCallId);
    if (!gate) return { resolved: false };
    const grantPayloadBase = {
      runId,
      grantId: gate.prompt.grantId,
      toolCallId,
      toolName: gate.prompt.toolName,
      reason: gate.prompt.reason,
      expiresAt: gate.prompt.expiresAt,
      ...(gate.prompt.principalId ? { principalId: gate.prompt.principalId } : {}),
      ...(gate.prompt.scopes?.length ? { scopes: gate.prompt.scopes } : {}),
      ...(gate.prompt.sessionKey ? { sessionKey: gate.prompt.sessionKey } : {}),
      ...(gate.prompt.surface ? { surface: gate.prompt.surface } : {}),
    };
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
    gate.resolve({ approved, reason });
    runMap.delete(toolCallId);
    if (runMap.size === 0) toolApprovalGates.delete(runId);
    return {
      resolved: true,
      grantId: gate.prompt.grantId,
      decision: approved ? "approved" : "rejected",
    };
  };

  const agentRuntime = createFridayAgentRuntime({
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
      if (!_learningContextRef) return { preferences: {} };
      return _learningContextRef.buildContext(input);
    },
    communicationPromptBuilder: (input) => {
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
      return buildFridayCommunicationPromptFragment(persona);
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
          cacheRead: 0,
          cacheWrite: 0,
          total: usage.inputTokens + usage.outputTokens,
        },
        costUsd: usage.costUsd ?? 0,
        metadata: { source: "agent-runtime" },
      });
    },
    toolApprovalResolver,
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
    createChildRuntime: (params) => {
      let childRuntimeRef: FridayAgentRuntime | undefined;
      const childRuntimeGetter = () => childRuntimeRef;
      const childTools = createFridayAgentToolRegistry({
        workdir: workspaceRoot,
        skillExecutor: executor,
        skillRegistry: registry,
        workflowExecutionService: workflowRuntime.execution,
        memoryService,
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
        ssrfGuard: agentSsrfGuard,
        sessionService: hubSessionService,
        agentRuntimeGetter: childRuntimeGetter,
        analyzeImages,
        gatewayService,
        channelRegistry,
        schedulerRepository: schedulerRepo,
        schedulerService: jobScheduler,
        mcpAdapter,
        extractionService: sessionExtractionService,
        providerService,
        webSearchProvider: process.env.FRIDAY_SEARCH_PROVIDER,
        webSearchApiKey: process.env.FRIDAY_SERPER_API_KEY ?? process.env.FRIDAY_TAVILY_API_KEY,
        capabilitySnapshotGetter: getAgentCapabilitySnapshot,
        taskStatusSnapshotGetter: getAgentTaskStatusSnapshot,
        subagentForkModeEnabled,
      });
      const childRuntime = createFridayAgentRuntime({
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
        sessionMirror: async (sessionKey, message) => {
          await hubSessionService.addMessage(sessionKey, message);
        },
        workdir: workspaceRoot,
        artifactWriter: agentArtifactWriter,
        evaluateRules,
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
              cacheRead: 0,
              cacheWrite: 0,
              total: usage.inputTokens + usage.outputTokens,
            },
            costUsd: usage.costUsd ?? 0,
            metadata: { source: "agent-runtime" },
          });
        },
      });
      childRuntimeRef = childRuntime;

      const feedbackTool = createFridayAgentFeedbackTool({
        learningEventWriter,
        idGenerator,
        nowIso,
        defaultUserId: learningDefaultUserId,
      });
      childRuntime.registerTool(feedbackTool);

      return childRuntime;
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
  const channelsConfig = parseFridayChannelsConfig(channelsInput);
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
      return decryptSecret(envelope, getMasterKey());
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
        polling: createTelegramPollingService(),
        webhook: createTelegramWebhookService(),
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

  if (channelsConfig.enabled) {
    for (const instance of channelsConfig.instances) {
      if (!instance.enabled) continue;

      const resolvedConfig = resolveChannelInitConfigWithSecretPolicy({
        instance,
        env: process.env,
        secretPolicy: channelSecretPolicy,
        resolveSecretRef: resolveChannelSecretRef,
      });
      if (resolvedConfig.warnings.length > 0) {
        console.warn(
          `[friday] Channel ${instance.kind} secret policy warnings: ${resolvedConfig.warnings.join("; ")}`,
        );
      }
      if (resolvedConfig.errors.length > 0) {
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

      channelRegistry.register(plugin, allowlistConfig);
    }
  }

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
    searchMarketplace: async () => ({ items: [], total: 0 }),
    getMarketplacePlugin: async () => { throw new FridayDomainError("PLUGIN_NOT_IMPLEMENTED", "Marketplace is not available in standalone mode", { httpStatus: 501 }); },
    listMarketplacePluginVersions: async () => [],
    installFromMarketplace: async () => { throw new FridayDomainError("PLUGIN_NOT_IMPLEMENTED", "Marketplace is not available in standalone mode", { httpStatus: 501 }); },
  };

  let pluginRuntimeMode: "stub" | "full" = configuredPluginRuntimeMode;
  const pluginManifestLoader = createFridayPluginManifestLoader();
  let runtimePluginService: FridayPluginService = stubPluginService;
  const pluginMarketplaceBaseUrl = (process.env.FRIDAY_PLUGIN_MARKETPLACE_BASE_URL ?? "").trim();
  const pluginMarketplaceClient = pluginMarketplaceBaseUrl
    ? createFridayPluginMarketplaceClient({
      baseUrl: pluginMarketplaceBaseUrl.replace(/\/+$/, ""),
    })
    : undefined;
  let pluginMarketplaceAvailable = false;

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
        marketplace: pluginMarketplaceClient,
        signatureVerifier: pluginSignatureVerifier,
        nowIso,
        idGenerator,
      });
      pluginMarketplaceAvailable = pluginMarketplaceClient !== undefined;
      console.log("[friday] Plugin runtime mode: full");
    } catch (err) {
      pluginRuntimeMode = "stub";
      runtimePluginService = stubPluginService;
      pluginMarketplaceAvailable = false;
      console.error(
        "[friday] WARNING: Plugin runtime full mode initialization failed; falling back to stub mode.",
        "Plugin install/enable/disable APIs will return 501.",
        err instanceof Error ? err.message : String(err),
      );
    }
  } else {
    pluginMarketplaceAvailable = false;
    console.log("[friday] Plugin runtime mode: stub");
  }

  const enabledChannelKinds = [
    ...new Set(
      channelsConfig.instances
        .filter((instance) => instance.enabled)
        .map((instance) => instance.kind),
    ),
  ];

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

  // ─── Skill Marketplace runtime (shared by API routes + sync job) ───
  let marketplaceRuntime: ReturnType<typeof createFridaySkillMarketplaceRuntime> | undefined;
  let marketplaceInitError: Error | undefined;

  const marketplaceCommerceEnabled = capabilityGates.marketplaceCommerceEnabled;
  const marketplaceInstallRequired = capabilityGates.marketplaceInstallRequired;
  const marketplaceCommercePersistence = marketplaceCommerceEnabled
    ? createFridayMarketplaceCommercePersistence({ db: stateRuntime!.sqlite })
    : undefined;
  const marketplaceAuditSink: MarketplaceAuditEventSink | undefined = marketplaceCommercePersistence
    ? (event) => {
      void memoryState.appendAuditLog({
        id: idGenerator(),
        ts: event.timestamp,
        actorType: "service",
        actorId: event.actor,
        action: event.action,
        resourceType: `marketplace_${event.entityType}`,
        resourceId: event.entityId,
        result: "success",
        caller: "marketplace.runtime",
        details: event.metadata ? { ...event.metadata } : undefined,
      }).catch((err: unknown) => warnHubBootstrapOnce(`[friday] audit-append: ${err instanceof Error ? err.message : String(err)}`));
    }
    : undefined;
  const marketplaceEntitlementCheck = marketplaceCommercePersistence
    ? async (input: { listingId: string; principalId: string }) => {
      const result = await assertListingExecutionReady(
        input,
        {
          listEntitlements: marketplaceCommercePersistence.listEntitlements,
          listInstallations: marketplaceCommercePersistence.listInstallations,
          requireInstallation: marketplaceInstallRequired,
        },
      );
      if (!result.ok) {
        void memoryState.appendAuditLog({
          id: idGenerator(),
          ts: nowIso(),
          actorType: "service",
          actorId: input.principalId,
          action: "marketplace.execution.denied",
          resourceType: "marketplace_listing",
          resourceId: input.listingId,
          result: "denied",
          errorCode: result.error.code,
          errorMessage: result.error.message,
          caller: "marketplace.entitlement-check",
          details: {
            listingId: input.listingId,
            principalId: input.principalId,
          },
        }).catch((err: unknown) => warnHubBootstrapOnce(`[friday] audit-append: ${err instanceof Error ? err.message : String(err)}`));
        throw new FridayDomainError(
          result.error.code,
          result.error.message,
          { httpStatus: result.error.httpStatus, details: { listingId: input.listingId } },
        );
      }
    }
    : undefined;
  const marketplaceInstallMaterializer = marketplaceCommercePersistence
    ? async (input: {
      listingId: string;
      versionId: string;
      tenantId: string;
      principalId: string;
      installationId: string;
      assetType: FridayMarketplaceAssetType;
      packageName: string;
      packageVersion: string;
    }) => {
      // Allows emergency rollback to legacy behavior.
      if (!capabilityGates.marketplaceInstallMaterialize) {
        return;
      }

      switch (input.assetType) {
        case "skill": {
          const candidates = deriveMarketplaceSkillIdCandidates(input.packageName);
          const resolved = candidates.find((skillId) => registry.get(skillId));
          if (!resolved) {
            throw new FridayDomainError("NOT_FOUND", `Marketplace skill asset "${input.packageName}@${input.packageVersion}" not found in local registry`, { httpStatus: 404 });
          }
          return;
        }
        case "workflow": {
          const byId = workflowRuntime.crud.getWorkflow(input.packageName);
          const bySlug = workflowRuntime.crud.getWorkflowBySlug(input.packageName);
          if (!byId && !bySlug) {
            throw new FridayDomainError("NOT_FOUND", `Marketplace workflow asset "${input.packageName}@${input.packageVersion}" not found in local runtime`, { httpStatus: 404 });
          }
          return;
        }
        case "agent": {
          if (!agentRuntime) {
            throw new FridayDomainError("NOT_INITIALIZED", `Marketplace agent asset "${input.packageName}@${input.packageVersion}" requires an active agent runtime`, { httpStatus: 503 });
          }
          return;
        }
        default: {
          const exhaustive: never = input.assetType;
          throw new FridayDomainError("VALIDATION_ERROR", `Unsupported marketplace asset type: ${String(exhaustive)}`, { httpStatus: 400 });
        }
      }
    }
    : undefined;
  if (marketplaceCommerceEnabled) {
    console.log("[friday] Marketplace commerce runtime: enabled");
  }

  // ─── Observability runtime ───

  const observabilityService = createFridayObservabilityApiService({
    db: stateRuntime.sqlite,
    idGenerator,
    nowIso,
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

  const uixService = createFridayUixSurfaceService({
    db: stateRuntime.sqlite,
    idGenerator,
    sessionService: hubSessionService,
    skillGenerator,
    skillExecutor: executor,
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
    learningContextBuilder: (input) => _learningContextRef?.buildContext(input) ?? { preferences: {} },
    diagnosticsBuilder: () => ({
      generatedAt: nowIso(),
      taskProfilePresets: [
        resolveFridayAgentTaskProfile("default"),
        resolveFridayAgentTaskProfile("deterministic"),
        resolveFridayAgentTaskProfile("planning"),
        resolveFridayAgentTaskProfile("review"),
        resolveFridayAgentTaskProfile("creative"),
      ],
      recentRuns: stateRuntime.sqlite.withReadConnection((db) =>
        agentRunRepo.list(db, { limit: 8 }).map((run) => ({
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
        }))),
      mcpServerStates: [...(mcpAdapter?.listServerStates() ?? [])],
      supportedPreprocessors: [
        "test_output",
        "log_excerpt",
        "browser_snapshot",
        "diff_excerpt",
      ],
    }),
    listAgentRuns: (input) =>
      stateRuntime.sqlite.withReadConnection((db) =>
        agentRunRepo.list(db, {
          status: input.status,
          limit: input.limit,
        }).map(enrichAgentRunForUi)),
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

  if (stateRuntime) {
    try {
      marketplaceRuntime = createFridaySkillMarketplaceRuntime({
        db: stateRuntime.sqlite,
        idGenerator,
        nowIso,
        fetchFn: globalThis.fetch.bind(globalThis),
        managedSkillsDir: config.skillDirs[1] ?? "managed-skills",
        hubVersion: config.serverVersion ?? FRIDAY_HUB_DEFAULT_SERVER_VERSION,
        supportedApiVersions: ["1"],
        registry,
        selfHealing: selfHealingApiService,
      });
    } catch (err) {
      marketplaceInitError = err instanceof Error ? err : new Error(String(err));
      console.error("[friday] Marketplace runtime init failed:", marketplaceInitError.message);
    }
  }

  // ─── API runtime ───

  // Shared learning event writer — used by satellite sync, agent bridge, feedback,
  // and incentive-alignment marketplace/automation signals.
  const learningEventWriter = (events: FridayLearningEventAppendInput[]) => {
    const results = selfLearningRuntime.pipeline.processBatch(events);
    selfHealingApiService.emitProcessResults(results);
  };

  // Default learning user for runtime-originated remediation and feedback events.
  const learningDefaultUserId = "admin-001";

  const marketplaceAssetCatalogService =
    marketplaceRuntime && marketplaceCommercePersistence
      ? new FridayMarketplaceAssetCatalogService({
        commerce: {
          getPublisher: marketplaceCommercePersistence.getPublisher,
          getSearchIndex: marketplaceCommercePersistence.getSearchIndex,
        },
        commerceAnalytics: {
          listInstallations: marketplaceCommercePersistence.listInstallations,
          listSupportEvents: marketplaceCommercePersistence.listSupportEvents,
          listAcceptedRequestCountsByCreator: marketplaceCommercePersistence.listAcceptedRequestCountsByCreator,
        },
        skillLifecycle: marketplaceRuntime.lifecycle,
      })
      : null;

  const marketplaceCreatorService =
    marketplaceAssetCatalogService && marketplaceCommercePersistence
      ? new FridayMarketplaceCreatorService({
        commerce: {
          getPublisher: marketplaceCommercePersistence.getPublisher,
          listPublishers: marketplaceCommercePersistence.listPublishers,
          listInstallations: marketplaceCommercePersistence.listInstallations,
          listAcceptedRequestCountsByCreator: marketplaceCommercePersistence.listAcceptedRequestCountsByCreator,
          listSupportEvents: marketplaceCommercePersistence.listSupportEvents,
          saveSupportEvent: marketplaceCommercePersistence.saveSupportEvent,
        },
        assetCatalog: marketplaceAssetCatalogService,
        generateId: idGenerator,
        now: nowIso,
        learningEventWriter,
        learningUserId: learningDefaultUserId,
      })
      : null;

  const marketplaceRequestBoardService =
    marketplaceCommercePersistence
      ? new FridayMarketplaceRequestBoardService({
        commerce: {
          getPublisherByPrincipal: marketplaceCommercePersistence.getPublisherByPrincipal,
          getRequest: marketplaceCommercePersistence.getRequest,
          listRequestResponses: marketplaceCommercePersistence.listRequestResponses,
          listRequests: marketplaceCommercePersistence.listRequests,
          saveRequest: marketplaceCommercePersistence.saveRequest,
          saveRequestResponse: marketplaceCommercePersistence.saveRequestResponse,
        },
        generateId: idGenerator,
        now: nowIso,
        learningEventWriter,
        learningUserId: learningDefaultUserId,
      })
      : null;

  // ─── Satellite runtime ───
  const satelliteRuntime = createFridaySatelliteRuntime({
    db: stateRuntime.sqlite,
    cursorSecret: tokenSecret,
    tokenSecret,
    idGenerator,
    nowIso,
    learningEventWriter,
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
  });

  const workflowSatelliteDispatcher = createFridayWorkflowSatelliteDispatchService({
    db: stateRuntime.sqlite,
    outbox: satelliteRuntime.outbox,
    nowIso,
  });
  workflowRuntime.execution.setDistributedDispatcher(workflowSatelliteDispatcher);

  const satelliteRepo = createFridaySatelliteRepository();

  const apiRuntime = createFridayApiRuntime({
    db: stateRuntime!.sqlite,
    idGenerator,
    nowIso,
    providerService,
    memoryService,
    skillGenerator,
    converterService,
    workflowGenerator,
    skillRegistry: registry,
    tokenSecret,
    allowPasswordlessLocalLogin,
    allowLocalBypassLogin,
    pluginRuntimeMode,
    pluginMarketplaceAvailable,
    supportedChannelKinds: [...FRIDAY_SUPPORTED_CHANNEL_KINDS],
    enabledChannelKinds,
    learningEventWriter,
    learningUserId: learningDefaultUserId,
    sessionService: hubSessionService,
    capabilitySnapshotGetter: getAgentCapabilitySnapshot,
    taskStatusSnapshotGetter: getAgentTaskStatusSnapshot,
    daemonStatusGetter: () => daemonService.status(),
    listMcpServers: mcpAdapter
      ? () => mcpAdapter.listServers().map((server) => ({ id: server.id, transport: server.transport }))
      : undefined,
    serverVersion: config.serverVersion ?? FRIDAY_HUB_DEFAULT_SERVER_VERSION,
    serverHost: config.host ?? "127.0.0.1",
    serverPort: config.port ?? 3141,
    stateDir: config.stateDir ?? ".",
    allowPrivateNetwork: config.ssrfPolicy?.allowPrivateNetwork,
    configManager,
    computeChecksum,
    workflowRuntime,
    pluginService: runtimePluginService,
    pluginManifestLoader,
    deterministicPipeline,
    diagnosis: { service: selfHealingApiService, agentLoop: agentLoopService },
    autoFix: { service: selfHealingApiService, agentLoop: agentLoopService },
    agentLoop: { service: agentLoopService },
    observability: observabilityService.routes,
    observabilityService,
    channels: { registry: channelRegistry },
    system: systemRouteDeps,
    uix: {
      service: uixService,
      listLearnedFacts: (input: { userId: string }) =>
        selfLearningRuntime.facts.listActiveFacts({ userId: input.userId, minConfidence: 0, limit: 200 })
          .map((f) => ({ key: f.key, value: f.value, confidence: f.confidence, evidenceCount: f.evidenceCount, lastConfirmedAt: f.lastConfirmedAt })),
      collectLearningEvents: learningEventWriter,
      idGenerator,
    },
    crossBorderPack: {
      service: crossBorderPackService,
    },
    searchHealth: {
      provider: configuredSearchProvider && configuredSearchProvider.length > 0
        ? configuredSearchProvider
        : "duckduckgo_html",
      latestness: searchWarning ? "unverified" : "provider_backed",
      ...(searchWarning ? { warning: searchWarning } : {}),
    },
    systemHealth: getPublicSystemHealth,
    discovery,
    mcpServer,
    marketplaceEntitlementCheck,
    marketplaceCommerce: marketplaceCommercePersistence
      ? {
        generateId: idGenerator,
        now: nowIso,
        auditSink: marketplaceAuditSink,
        learningEventWriter,
        learningUserId: learningDefaultUserId,
        beforePersistInstallation: marketplaceInstallMaterializer,
        ...marketplaceCommercePersistence,
      }
      : undefined,
    marketplaceAssets: marketplaceAssetCatalogService
      ? {
        service: marketplaceAssetCatalogService,
      }
      : undefined,
    marketplaceCreators: marketplaceCreatorService
      ? {
        service: marketplaceCreatorService,
      }
      : undefined,
    marketplaceRequests: marketplaceRequestBoardService
      ? {
        service: marketplaceRequestBoardService,
      }
      : undefined,
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
    skillMarketplace: marketplaceRuntime
      ? {
        sources: marketplaceRuntime.sources,
        discovery: marketplaceRuntime.discovery,
        installations: marketplaceRuntime.installations,
        sync: marketplaceRuntime.sync,
        cache: marketplaceRuntime.cache,
      }
      : undefined,
    skillLifecycle: marketplaceRuntime?.lifecycle,
    channelWebhooks: {
      lineWebhookRelay: lineWebhookRelay,
      whatsappWebhookRelay: whatsappWebhookRelay,
      larkWebhookRelay: larkWebhookRelay,
    },
    resolveSkill: (skillId) => {
      const skill = registry.get(skillId);
      return skill ?? null;
    },
    invokeSkill: invokeSkillForWorkflow,
    agentRuntime,
    agentEventEmitter,
    resolveToolApproval,
    subagentRegistry,
  });

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

    const heartbeatRunner = createFridayHeartbeatRunner({
      config: {
        enabled: true,
        intervalMs: heartbeatIntervalMs,
        cooldownMs: heartbeatCooldownMs,
        timeoutMs: heartbeatTimeoutMs,
        sessionKey: process.env.FRIDAY_HEARTBEAT_SESSION_KEY ?? "system:heartbeat",
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
          process.env.FRIDAY_HEARTBEAT_SESSION_KEY ?? "system:heartbeat",
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
  }

  // ─── Unified Job Scheduler (F10: register ALL job modules) ───

  let jobScheduler: FridayJobSchedulerService | undefined;
  let schedulerRepo: FridayJobSchedulerRepository | undefined;
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

    // Session lifecycle sweep
    if (sessionExtractionService) {
      const lifecycleJob = createFridaySessionLifecycleJob({
        db: stateRuntime.sqlite,
        sessionService: hubSessionService,
        extractionService: sessionExtractionService,
        nowIso,
      });
      schedulerJobs.push({
        id: "session-lifecycle-sweep",
        intervalMs: 120_000, // every 2 min
        timeoutMs: 300_000, // 5 min
        catchUpRuns: 1,
        run: async () => { await lifecycleJob.run(); },
      });
    }

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

    // Marketplace sync — always registered; degraded runner if init failed (L2)
    {
      const marketplaceSyncRunner = marketplaceRuntime
        ? async () => { await marketplaceRuntime!.syncJob.runOnce(); }
        : async () => {
            const errMsg = marketplaceInitError?.message ?? "unknown init error";
            console.error(`[friday] marketplace-sync skipped: MARKETPLACE_RUNTIME_INIT_FAILED — ${errMsg}`);
            throw new FridayDomainError("NOT_INITIALIZED", `MARKETPLACE_RUNTIME_INIT_FAILED: ${errMsg}`, { httpStatus: 503 });
          };

      schedulerJobs.push({
        id: "marketplace-sync",
        intervalMs: 3_600_000, // every 1h
        timeoutMs: 300_000, // 5 min
        catchUpRuns: 0, // no catch-up for periodic sync
        run: marketplaceSyncRunner,
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

    schedulerJobs.push({
      id: "agent-loop-cooldown-sweep",
      intervalMs: 60_000,
      timeoutMs: 120_000,
      catchUpRuns: 1,
      run: async () => {
        const hasRepeatedFailureAlert = observabilityService.alerts.getActiveEvents().some(
          (event) => event.ruleId === FRIDAY_BUILT_IN_SELF_HEALING_ALERT_RULE_ID && event.status !== "resolved",
        );
        await agentLoopService?.resumeCooldownRuns({
          limit: 10,
          trigger: hasRepeatedFailureAlert ? "repeated_failure_alert" : "cooldown_elapsed",
        });
      },
    });

    // System self-health monitor: periodic checks + auto-fix for DB bloat, expired data, etc.
    schedulerJobs.push({
      id: "system-health-monitor",
      intervalMs: 300_000, // every 5 min
      timeoutMs: 60_000,
      catchUpRuns: 1,
      run: async () => {
        const { createFridaySystemHealthMonitor } = await import("../learning/services/friday-system-health-monitor.js");
        const monitor = createFridaySystemHealthMonitor({
          db: stateRuntime!.sqlite,
          nowIso,
          onRunComplete: (summary) => {
            const unhealthy = summary.checks.filter((c) => !c.healthy);
            if (unhealthy.length > 0) {
              for (const check of unhealthy) {
                console.warn(`[friday][system-health] ${check.name}: unhealthy (${String(check.value)} ${check.unit})`);
              }
            }
            for (const fix of summary.autoFixes) {
              console.log(`[friday][system-health] auto-fix ${fix.name}: ${fix.detail}`);
            }
          },
        });
        monitor.runAll();
      },
    });

    jobScheduler = createFridayJobSchedulerService({
      repository: schedulerRepoRef,
      nowIso,
      jobs: schedulerJobs,
    });
    const schedulerService = jobScheduler;

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
    // For now, create a graceful stub that reports service availability.
    const resolvedModel = request.model ?? "gpt-4o";
    const { result, route } = await providerService.runWithFallback({
      requestedModel: resolvedModel,
      tenantContext: request.tenantContext,
      run: async (_route, credential) => {
        const baseUrl = _route.provider.baseUrl ?? "https://api.openai.com/v1";
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${credential ?? ""}`,
          },
          body: JSON.stringify({
            model: _route.model,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: request.prompt },
                  ...request.images.map((img) => ({
                    type: "image_url" as const,
                    image_url: {
                      url: img.type === "url" ? img.url! : `data:${img.mimeType ?? "image/png"};base64,${img.data!}`,
                      detail: request.detail,
                    },
                  })),
                ],
              },
            ],
            max_tokens: request.maxTokens ?? 1024,
          }),
          signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new FridayDomainError("INTERNAL_ERROR", `Vision API error ${String(response.status)}: ${body}`, { httpStatus: 500 });
        }

        const json = await response.json() as {
          choices: Array<{ message: { content: string } }>;
          model: string;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };

        return {
          text: json.choices?.[0]?.message?.content ?? "",
          model: json.model ?? _route.model,
          inputTokens: json.usage?.prompt_tokens,
          outputTokens: json.usage?.completion_tokens,
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

  // 3. autonomous + setup — late-bind after runtime construction to avoid
  // circular dependency on agentRuntime during initial tool registry creation.
  {
    const autonomousAnalyzeImages = (
      request: {
        prompt: string;
        images: readonly { type: "base64" | "url"; data?: string; url?: string; mimeType?: string }[];
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
    const autonomousEngine = createFridayAutonomousEngine({
      agentRuntime: {
        executeRun: (params) =>
          agentRuntime.executeRun({
            ...params,
            disabledToolNames: ["autonomous", "setup", "setup_assistant"],
          }),
      },
      analyzeImages: autonomousAnalyzeImages,
      desktopSessionManager: autonomousDesktopManager,
      browserManager: autonomousBrowserManager,
      idGenerator,
      nowIso,
      eventEmitter: {
        emit: (event, payload) => {
          agentEventEmitter.emit(event as never, payload as never);
        },
      },
    });
    const environmentScanner = createFridayEnvironmentScanner();
    const setupRecipeRegistry = createFridaySetupRecipeRegistry();
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
      companionBridge: systemCompanionBridge,
      eventEmitter: {
        emit: (event, payload) => {
          agentEventEmitter.emit(event as never, payload as never);
        },
      },
      idGenerator,
      nowIso,
    });

    for (const tool of [
      createFridayAgentAutonomousTool({ autonomousEngine }),
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

  // 5. nodes — only register when nodes service is available (via FRIDAY_NODES_ENABLED).
  // Same principle: don't register tools that can't work.

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
      {
        const autoDetected = await autoDetectProvidersFromEnv(providerService);
        if (autoDetected.length > 0) {
          console.log(
            `[friday] Auto-detected ${String(autoDetected.length)} provider(s) from environment: ${autoDetected.map((p) => p.kind).join(", ")}`,
          );
        }
      }

      // 3. API runtime is ready (created synchronously above)
      //    HTTP listener start is handled by CLI run-loop (Batch 2), not here.

      // 4. Start channel plugins (route inbound messages to agent runtime)

      // Deterministic dispatch deps — reused across all channel messages.
      const deterministicDispatchDeps: FridayDeterministicDispatchDeps = {
        capabilitySnapshotGetter: getAgentCapabilitySnapshot,
        taskStatusSnapshotGetter: getAgentTaskStatusSnapshot,
        getDaemonStatus: () => daemonService.status(),
        listMcpServers: mcpAdapter
          ? () => mcpAdapter.listServers().map((s) => ({ id: s.id, transport: s.transport }))
          : undefined,
        approvalService: workflowRuntime.approval,
        workflowExecutionService: workflowRuntime.execution,
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
      const channelEngineSessionDeps = {
        getMessages: (key: string, limit?: number) => hubSessionService.getMessages(key, limit),
        addMessage: (key: string, msg: Parameters<typeof hubSessionService.addMessage>[1]) =>
          hubSessionService.addMessage(key, msg),
        getConversationFocus: (key: string) => hubSessionService.getConversationFocus(key),
        setConversationFocus: (key: string, state: Parameters<typeof hubSessionService.setConversationFocus>[1]) =>
          hubSessionService.setConversationFocus(key, state).then(() => undefined),
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
      if (channelsConfig.enabled && channelRegistry.list().length > 0) {
        const channelMessageHandler = (msg: FridayChannelMessage) => {
          const text = sanitizeChannelInput(msg.text);
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
          if (text.length === 0) return;

          if (text.length > FRIDAY_CHANNEL_MAX_MESSAGE_LENGTH) {
            channelRegistry
              .send(msg.channelKind, {
                chatId: msg.chatId,
                text: `Message too long (max ${String(FRIDAY_CHANNEL_MAX_MESSAGE_LENGTH)} chars).`,
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

          void (async () => {
            const runId = idGenerator();
            const channelEntryAdapter = createFridayChannelEntryAdapter({
              engine: channelOrchestrationEngine,
              idGenerator: () => runId,
              resolveSessionKey: (inboundMessage) => resolveFridayChannelSessionKey({
                channelKind: inboundMessage.channelKind,
                chatId: inboundMessage.chatId,
                senderId: inboundMessage.senderId,
                senderName: inboundMessage.senderName,
                text: inboundMessage.text,
                id: inboundMessage.id,
                timestamp: inboundMessage.timestamp ?? Date.now(),
                chatType: inboundMessage.chatType,
                replyTo: inboundMessage.replyToMessageId,
                timezone: inboundMessage.timezone,
                images: inboundMessage.images,
              }, {
                crossChannelIdentityEnabled,
                identityMap: crossChannelIdentityMap,
              }),
            });
            const slowTaskNotifier = createFridayChannelSlowTaskNotifier({
              eventEmitter: agentEventEmitter,
              channelRegistry,
              channelKind: msg.channelKind,
              chatId: msg.chatId,
              replyTo: msg.id,
              runId,
              publicRunUrl: resolveFridayPublicRunUrl(runId),
            });
            try {
              const inboundMessage = await hubSessionService.addMessage(sessionKey, {
                role: "user",
                content: text,
                contentText: text,
                idempotencyKey: inboundIdempotencyKey,
                metadata: {
                  sourceMessageId: msg.id,
                  ...(msg.replyTo ? { replyToMessageId: msg.replyTo } : {}),
                  channelKind: msg.channelKind,
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
                text,
                occurredAt: new Date(msg.timestamp).toISOString(),
                replyToMessageId: msg.replyTo,
                timezone: msg.timezone,
                images: msg.images,
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
                ? result.response
                : resolveFridayChannelTerminalText({
                  status: result.status === "completed"
                    ? "completed"
                    : result.status === "cancelled"
                      ? "cancelled"
                      : "failed",
                  response: result.response,
                  imageCount: outboundImages?.length ?? 0,
                });

              console.log(
                `[friday] Channel run terminal (${msg.channelKind}): ` +
                  `status=${result.status} hasResponse=${String(hasResponse)} ` +
                  `images=${String(outboundImages?.length ?? 0)}`,
              );

              try {
                const delivery = await channelRegistry.send(msg.channelKind, {
                  chatId: msg.chatId,
                  text: outboundText,
                  replyTo: msg.id,
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
                const fallbackText = buildFridayChannelDeliveryFailureText(result.runId);
                await hubSessionService.addMessage(sessionKey, {
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
              await channelRegistry
                .send(msg.channelKind, {
                  chatId: msg.chatId,
                  text:
                    `Sorry, I couldn't complete your request (${errorCode}). ` +
                    `Correlation: ${correlationId}. Please retry.`,
                  replyTo: msg.id,
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
        const channelCount = channelRegistry.list().length;
        const skillCount = registry.list().length;
        console.log("[friday] ✓ Friday is running");
        console.log(`[friday]   Providers: ${String(providerCount)}${providerCount === 0 ? " — set ANTHROPIC_API_KEY or visit /setup to add one" : ""}`);
        console.log(`[friday]   Channels:  ${String(channelCount)}${channelCount === 0 ? " — no messaging channels configured" : ""}`);
        console.log(`[friday]   Skills:    ${String(skillCount)}`);
      }
    },

    async stop(): Promise<void> {
      // Shutdown in reverse order: API → workflows → skills → state
      // P2-DATA: Use transitional "stopping" state — set "stopped" after cleanup completes
      hubState = "stopping";
      upSince = null;

      // P1-SHUT-001/002/003: Stop services started during bootstrap
      try { observabilityService?.scheduler?.stop(); } catch (err) {
      warnHubBootstrapOperationFailureOnce(err); /* best-effort */ }
      try { agentLearningBridge?.stop(); } catch (err) {
      warnHubBootstrapOperationFailureOnce(err); /* best-effort */ }
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
      await browserManager.close();
      await subagentRegistry.drain();
      // 4. API runtime — no async teardown yet (HTTP server stop is CLI concern)
      // 5. Workflow runtime — scheduler now handles cron lifecycle
      // 6. Skills
      await registry.close();
      // 7. State
      stateRuntime?.close();
      hubState = "stopped";
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
    apiRuntime,
    channelRegistry,
    satelliteRuntime,
    webchatWsService,
  };

  return hub;

  } catch (bootstrapError) {
    // P0-001: Clean up SQLite connections on partial bootstrap failure
    stateRuntime?.close();
    throw bootstrapError;
  }
}

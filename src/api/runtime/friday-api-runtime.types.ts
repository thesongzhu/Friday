import type { FridaySqliteLayer } from "#state";
import type { FridayDaemonStatus } from "#daemon";
import type { FridayHubConfigManagerService } from "#hub";
import type { FridayLearningEventAppendInput } from "#ledger";
import type { FridayOutboxQueueService } from "#satellites";
import type { FridayAccessTokenClaims, FridayRole } from "../model/friday-api-auth.types.js";
import type { FridayAuthService } from "../auth/friday-auth-service.types.js";
import type { FridayRateLimitService } from "../auth/friday-rate-limit-service.types.js";
import type { FridayTokenValidator } from "../auth/friday-token-validator.js";
import type { FridayAuthMiddlewareFactory } from "../auth/friday-auth-middleware.js";
import type { FridayRealtimeEventBus } from "../realtime/friday-realtime-event-bus.types.js";
import type { FridayRealtimeSubscriptionService } from "../realtime/friday-realtime-subscription-service.js";
import type { FridayRealtimeWsGateway } from "../realtime/friday-realtime-ws-gateway.js";
import type { FridayFleetDashboardService } from "../fleet/friday-fleet-dashboard-service.types.js";
import type { FridayWorkflowConflictService } from "../conflicts/friday-workflow-conflict-service.types.js";
import type { FridayHttpRouteRegistry } from "../http/friday-http-route-registry.js";
import type {
  CreateFridayWorkflowRuntimeDeps,
  FridayWorkflowBuilderDraftService,
  FridayWorkflowCrudService,
  FridayWorkflowExecutionService,
  FridayWorkflowRuntime,
} from "#workflows";
import type {
  FridayAutonomyPolicyService,
  FridayCapabilityAcquisitionService,
  FridayStandingAgendaService,
} from "../../autonomy/index.js";
import type { FridayProviderService } from "#providers";
import type { FridayMediaUnderstandingRoutesDeps } from "../http/routes/friday-media-understanding-routes.js";
import type { FridaySocialImportRoutesDeps } from "../http/routes/friday-social-import-routes.js";
import type { FridayMemoryGuardServiceFactory, FridayMemoryService } from "#memory";
import type { FridaySessionMemoryExtractionService, FridaySessionService } from "#sessions";
import type {
  FridaySkillExecutor,
  FridaySkillGeneratorService,
  FridaySkillLifecycleService,
  FridaySkillRegistry,
  SkillLifecycleStatus,
} from "#skills";
import type { FridaySkillConverterService } from "#skills/converter";
import type { FridayPluginManifestLoader, FridayPluginService } from "#plugins";
import type { FridayWorkflowGeneratorService } from "#workflows";
import type { FridayMcpAdapter } from "../../agent/mcp/friday-mcp-adapter.types.js";
import type { FridayMcpConfigStore } from "../../agent/mcp/friday-mcp-config-store.js";
import type { FridayReflexService } from "../../reflex/index.js";
import type {
  FridayAgentAutomationService,
  FridayAgentEventEmitter,
  FridayAgentRunRepository,
  FridayAgentRuntime,
  FridaySubagentRegistry,
} from "#agent";
import type { FridayAgentCapabilitiesSnapshot } from "#agent";
import type { FridayAgentTaskStatusSnapshot } from "#agent";
import type { FridayDeterministicPipelineRoutesDeps } from "../http/routes/friday-deterministic-pipeline-routes.js";
import type { FridayDesktopRoutesDeps } from "../http/routes/friday-desktop-routes.js";
import type { FridayChannelRoutesDeps } from "../http/routes/friday-channel-routes.js";
import type { FridayDiscoveryRoutesDeps } from "../http/routes/friday-discovery-routes.js";
import type { FridayMcpServerRoutesDeps } from "../http/routes/friday-mcp-server-routes.js";
import type { FridayMultiTenantSecurityRoutesDeps } from "../http/routes/friday-multi-tenant-security-routes.js";
import type { FridayObservabilityRoutesDeps } from "../http/routes/friday-observability-routes.js";
import type { FridayObservabilityApiService } from "../../observability/services/friday-observability-api-service.js";
import type { FridaySatellitePairingRoutesDeps } from "../http/routes/friday-satellite-pairing-routes.js";
import type { FridaySatelliteRuntimeRoutesDeps } from "../http/routes/friday-satellite-runtime-routes.js";
import type { FridayDiagnosisRoutesDeps } from "../http/routes/friday-diagnosis-routes.js";
import type { FridayAutoFixRoutesDeps } from "../http/routes/friday-auto-fix-routes.js";
import type { FridayAgentLoopRoutesDeps } from "../http/routes/friday-agent-loop-routes.js";
import type { FridaySystemRoutesDeps } from "../http/routes/friday-system-routes.js";
import type { FridayGuideLensRoutesDeps } from "../http/routes/friday-guide-lens-routes.js";
import type { FridayUixRoutesDeps } from "../http/routes/friday-uix-routes.js";
import type { FridayCrossBorderPackRoutesDeps } from "../http/routes/friday-cross-border-pack-routes.js";
import type { FridayPackagingRoutesDeps } from "../http/routes/friday-packaging-routes.js";
import type {
  LarkWebhookRelayService,
  LineWebhookListenerService,
  WhatsappWebhookService,
} from "#channels";

export interface FridayApiRuntime {
  auth: FridayAuthService;
  tokenValidator: FridayTokenValidator;
  rateLimiter: FridayRateLimitService;
  middleware: FridayAuthMiddlewareFactory;
  eventBus: FridayRealtimeEventBus;
  subscriptions: FridayRealtimeSubscriptionService;
  wsGateway: FridayRealtimeWsGateway;
  fleet: FridayFleetDashboardService;
  conflicts: FridayWorkflowConflictService;
  routes: FridayHttpRouteRegistry;
  autonomyPolicyService: FridayAutonomyPolicyService;
  capabilityAcquisitionService: FridayCapabilityAcquisitionService;
  standingAgendaService: FridayStandingAgendaService;
  workflowCrud: FridayWorkflowCrudService;
  workflowExecution: FridayWorkflowExecutionService;
  draftService: FridayWorkflowBuilderDraftService;
  providerService: FridayProviderService;
  memoryService?: FridayMemoryService;
  memoryGuardFactory?: FridayMemoryGuardServiceFactory;
  sessionService?: FridaySessionService;
  extractionService?: FridaySessionMemoryExtractionService;
  skillGenerator?: FridaySkillGeneratorService;
  converterService?: FridaySkillConverterService;
  workflowGenerator?: FridayWorkflowGeneratorService;
  pluginService?: FridayPluginService;
  agentRuntime?: FridayAgentRuntime;
  agentEventEmitter?: FridayAgentEventEmitter;
  agentRunRepository?: FridayAgentRunRepository;
  agentAutomationService?: FridayAgentAutomationService;
  mcpServer?: FridayMcpServerRoutesDeps;
  deterministicPipeline?: FridayDeterministicPipelineRoutesDeps;
  diagnosis?: FridayDiagnosisRoutesDeps;
  autoFix?: FridayAutoFixRoutesDeps;
  agentLoop?: FridayAgentLoopRoutesDeps;
  uix?: FridayUixRoutesDeps;
  crossBorderPack?: FridayCrossBorderPackRoutesDeps;
  system?: FridaySystemRoutesDeps;
  guideLens?: FridayGuideLensRoutesDeps;
  channels?: FridayChannelRoutesDeps;
}

export interface CreateFridayApiRuntimeDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
  providerService: FridayProviderService;
  memoryService?: FridayMemoryService;
  skillGenerator?: FridaySkillGeneratorService;
  converterService?: FridaySkillConverterService;
  workflowGenerator?: FridayWorkflowGeneratorService;
  skillRegistry?: FridaySkillRegistry;
  skillExecutor?: FridaySkillExecutor;
  tokenSecret: string;
  accessTokenTtlSec?: number;
  refreshTokenTtlSec?: number;
  /** Optional tenant resolver shared by auth claim issuance and validation. */
  resolveAuthTenantId?: (input: {
    principalType: string;
    principalId: string;
    userId?: string;
    role?: FridayRole;
    tenantId?: string | null;
    claims?: FridayAccessTokenClaims;
  }) => string | null | undefined;
  /** Current plugin runtime mode exposed via health capabilities. */
  pluginRuntimeMode?: "stub" | "full";
  /** Supported channel kinds (from backend schema). */
  supportedChannelKinds?: string[];
  /** Channel kinds currently enabled in runtime config or currently running in runtime state. */
  enabledChannelKinds?: string[] | (() => string[]);
  /** Optional hot-activation hook used by setup after saving channel config. */
  activateSavedChannels?: () =>
    | Promise<{
      startedKinds: string[];
      failed: Array<{ kind: string; message: string }>;
      restartRequired: boolean;
      warnings: string[];
    }>
    | {
      startedKinds: string[];
      failed: Array<{ kind: string; message: string }>;
      restartRequired: boolean;
      warnings: string[];
    };
  onSetupChannelsSaved?: (input: { userId: string; savedKinds: string[] }) => Promise<void> | void;
  onSetupCompleted?: (input: { userId: string }) => Promise<void> | void;
  serverVersion?: string;
  /** The host the HTTP server is bound to, used to detect if a restart is needed. */
  serverHost?: string;
  /** The port the HTTP server is listening on, used to detect if a restart is needed. */
  serverPort?: number;
  stateDir?: string;
  /** Absolute path to the managed-skills directory used for skill content edits. */
  managedSkillsDir?: string;
  /** Allow loopback/private network addresses for self-hosted deployments using local providers. */
  allowPrivateNetwork?: boolean;
  pluginService?: FridayPluginService;
  pluginManifestLoader?: FridayPluginManifestLoader;
  computeChecksum: (content: string) => string;
  /** Returns any truthy value if the skill exists; null otherwise. */
  resolveSkill: (skillId: string) => unknown | null;
  invokeSkill: (
    skillId: string,
    runId: string,
    nodeId: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
  /** Optional: pass the hub's workflow runtime to avoid creating a duplicate. */
  workflowRuntime?: FridayWorkflowRuntime;
  /** Optional: user/project prompt-guidance provider for fallback workflow runtime creation. */
  userRulesContextProvider?: CreateFridayWorkflowRuntimeDeps["userRulesContextProvider"];
  /** Optional: reuse hub's session service instead of creating a new one. */
  sessionService?: FridaySessionService;
  /** Optional: agent runtime for agent run endpoints. */
  agentRuntime?: FridayAgentRuntime;
  /** Optional: Reflex service for deterministic preference writes before agent runs. */
  reflexService?: FridayReflexService;
  /** Optional deterministic runtime capability getter used by context evidence selection. */
  capabilitySnapshotGetter?: (input: { readOnly: boolean }) =>
    Promise<FridayAgentCapabilitiesSnapshot> | FridayAgentCapabilitiesSnapshot;
  /** Optional deterministic task status getter used by context evidence selection. */
  taskStatusSnapshotGetter?: (input: { runId?: string; sessionKey?: string; readOnly: boolean }) =>
    Promise<FridayAgentTaskStatusSnapshot> | FridayAgentTaskStatusSnapshot;
  /** Optional: daemon status getter for deterministic daemon status responses. */
  daemonStatusGetter?: () => FridayDaemonStatus;
  /** Optional: external MCP server lister for deterministic MCP bridge queries. */
  listMcpServers?: () => ReadonlyArray<{ id: string; transport?: string }>;
  /** Optional: live MCP adapter used by autonomy inventory and upgrade actions. */
  mcpAdapter?: Pick<FridayMcpAdapter, "listServers" | "listServerStates" | "listTools">;
  /** Optional: durable MCP server config store for deeplink apply persistence. */
  mcpConfigStore?: FridayMcpConfigStore;
  /** Optional: agent event emitter for SSE streaming. */
  agentEventEmitter?: FridayAgentEventEmitter;
  /** Optional: resolves a pending tool approval gate (approve or reject). */
  resolveToolApproval?: (
    runId: string,
    toolCallId: string,
    approved: boolean,
    options: {
      reason?: string;
      approverPrincipalId: string;
      approverPrincipalType?: string;
      approvalSurface?: string;
    },
  ) => { resolved: boolean; grantId?: string; decision?: "approved" | "rejected" };
  /** Optional: learning event sink used by runtime-originated automation signals. */
  learningEventWriter?: (events: FridayLearningEventAppendInput[]) => void;
  /** Optional: default user id used for runtime-originated automation learning events. */
  learningUserId?: string;
  /** Optional: sub-agent registry for sub-agent tree endpoints. */
  subagentRegistry?: FridaySubagentRegistry;
  /** Optional: deterministic pipeline module services for global pipeline APIs. */
  deterministicPipeline?: FridayDeterministicPipelineRoutesDeps;
  /** Optional: multi-tenant security route surface (tenant/workspace/member/role/policy). */
  multiTenantSecurity?: FridayMultiTenantSecurityRoutesDeps;
  /** Optional: observability route surface (trace/audit/slo/alerts). */
  observability?: FridayObservabilityRoutesDeps;
  /** Optional: observability service used by non-route flows such as skill generation. */
  observabilityService?: FridayObservabilityApiService;
  /** Optional: runtime config manager for `/v1/config*` admin APIs. */
  configManager?: FridayHubConfigManagerService;
  /** Optional: self-healing diagnosis route surface. */
  diagnosis?: FridayDiagnosisRoutesDeps;
  /** Optional: self-healing auto-fix route surface. */
  autoFix?: FridayAutoFixRoutesDeps;
  /** Optional: supervised autonomous loop route surface. */
  agentLoop?: FridayAgentLoopRoutesDeps;
  /** Optional: desktop control route surface. */
  desktop?: FridayDesktopRoutesDeps;
  /** Optional: channel health and capability route surface. */
  channels?: FridayChannelRoutesDeps;
  /** Optional: Agent OS system route surface. */
  system?: FridaySystemRoutesDeps;
  /** Optional: read-only native guidance overlay route surface. */
  guideLens?: FridayGuideLensRoutesDeps;
  /** Whether canonical mutating approval gate is required for profile-gated API mutations. */
  canonicalMutatingActionGate?: boolean;
  /** Optional: beginner-friendly UIX route surface. */
  uix?: FridayUixRoutesDeps;
  /** Optional: cross-border operating pack route surface. */
  crossBorderPack?: FridayCrossBorderPackRoutesDeps;
  /**
   * Phase 02a media-understanding route surface.
   *
   * Optional. The routes are always registered regardless of whether this slot
   * is supplied — `createFridayApiRuntime` coalesces a missing/undefined value
   * to a honest-disabled deps shape so disabled deployments return
   * `503 MEDIA_UNDERSTANDING_DISABLED` (never 404). When supplied, the hub
   * bootstrap sets non-null `service` + `doctorProvider` only when the runtime
   * flag and provider credential resolution both succeed; otherwise fields are
   * null with a structured `disabledReason` that never echoes any env value or
   * credential.
   */
  mediaUnderstanding?: FridayMediaUnderstandingRoutesDeps;
  /**
   * Phase 02b social-import route surface.
   *
   * Optional. The route is always registered regardless of whether this slot
   * is supplied — `createFridayApiRuntime` coalesces a missing/undefined
   * value to an honest-disabled deps shape so disabled deployments return
   * `503 SOCIAL_IMPORT_DISABLED` (never 404). When supplied, the hub
   * bootstrap sets non-null `service` only when XHS browser deps, the
   * converter service, and the canonical mutation gate are all available;
   * otherwise the field is null with a structured `disabledReason` that
   * never echoes cookies, session strings, env values, or credentials.
   */
  socialImport?: FridaySocialImportRoutesDeps;
  /** Optional: search capability metadata surfaced by /v1/health. */
  searchHealth?: {
    provider: string;
    latestness: "provider_backed" | "unverified";
    warning?: string;
  } | (() => {
    provider: string;
    latestness: "provider_backed" | "unverified";
    warning?: string;
  } | Promise<{
    provider: string;
    latestness: "provider_backed" | "unverified";
    warning?: string;
  }>);
  /** Optional: system health metadata surfaced by /v1/health. */
  systemHealth?: {
    enabled: boolean;
    remoteMode: "trusted_private_network" | "disabled" | "unavailable";
    healthStatus?: "healthy" | "degraded" | "safe_mode" | "unavailable";
    companionConnected?: boolean;
    companionReadiness?: "ready" | "degraded" | "unavailable";
    reasons?: string[];
    warning?: string;
  } | (() =>
    | {
      enabled: boolean;
      remoteMode: "trusted_private_network" | "disabled" | "unavailable";
      healthStatus?: "healthy" | "degraded" | "safe_mode" | "unavailable";
      companionConnected?: boolean;
      companionReadiness?: "ready" | "degraded" | "unavailable";
      reasons?: string[];
      warning?: string;
    }
    | Promise<{
      enabled: boolean;
      remoteMode: "trusted_private_network" | "disabled" | "unavailable";
      healthStatus?: "healthy" | "degraded" | "safe_mode" | "unavailable";
      companionConnected?: boolean;
      companionReadiness?: "ready" | "degraded" | "unavailable";
      reasons?: string[];
      warning?: string;
    }>);
  /** Optional: local program discovery route surface. */
  discovery?: FridayDiscoveryRoutesDeps;
  /** Optional: MCP server route surface (JSON-RPC tools/resources/prompts). */
  mcpServer?: FridayMcpServerRoutesDeps;
  /** Optional: canonical skills lifecycle service. */
  skillLifecycle?: FridaySkillLifecycleService;
  /** Optional: writes runtime-visible skill status before registry refresh after external lifecycle changes. */
  updateSkillStatus?: (skillId: string, status: SkillLifecycleStatus) => Promise<void> | void;
  /** Optional: satellite pairing/handshake route surface. */
  satellitePairing?: FridaySatellitePairingRoutesDeps;
  /** Optional: satellite runtime sync/command route surface. */
  satelliteRuntime?: Omit<FridaySatelliteRuntimeRoutesDeps, "pullEvents" | "getCheckpoint">;
  /** Optional: channel webhook relays for LINE/WhatsApp/Lark HTTP ingress. */
  channelWebhooks?: {
    lineWebhookRelay?: LineWebhookListenerService;
    whatsappWebhookRelay?: WhatsappWebhookService;
    larkWebhookRelay?: LarkWebhookRelayService;
  };
  outboxQueueService?: FridayOutboxQueueService;
  /** Optional: packaging system route surface (publish, install, upgrade, rollback, keys). */
  packaging?: FridayPackagingRoutesDeps;
}

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
import type { FridayWorkflowBuilderDraftService, FridayWorkflowCrudService, FridayWorkflowExecutionService, FridayWorkflowRuntime } from "#workflows";
import type { FridayProviderService } from "#providers";
import type { FridayMemoryGuardServiceFactory, FridayMemoryService } from "#memory";
import type { FridaySessionMemoryExtractionService, FridaySessionService } from "#sessions";
import type { FridaySkillGeneratorService, FridaySkillLifecycleService, FridaySkillRegistry } from "#skills";
import type { FridaySkillConverterService } from "#skills/converter";
import type { FridayPluginManifestLoader, FridayPluginService } from "#plugins";
import type { FridayWorkflowGeneratorService } from "#workflows";
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
import type { FridayMarketplaceCommerceRoutesDeps } from "../http/routes/friday-marketplace-commerce-routes.js";
import type { FridayMarketplaceAssetRoutesDeps } from "../http/routes/friday-marketplace-asset-routes.js";
import type { FridayMarketplaceCreatorRoutesDeps } from "../http/routes/friday-marketplace-creator-routes.js";
import type { FridayMarketplaceRequestRoutesDeps } from "../http/routes/friday-marketplace-request-routes.js";
import type { FridaySkillMarketplaceRoutesDeps } from "../http/routes/friday-skill-marketplace-routes.js";
import type { FridayMultiTenantSecurityRoutesDeps } from "../http/routes/friday-multi-tenant-security-routes.js";
import type { FridayObservabilityRoutesDeps } from "../http/routes/friday-observability-routes.js";
import type { FridayObservabilityApiService } from "../../observability/services/friday-observability-api-service.js";
import type { FridaySatellitePairingRoutesDeps } from "../http/routes/friday-satellite-pairing-routes.js";
import type { FridaySatelliteRuntimeRoutesDeps } from "../http/routes/friday-satellite-runtime-routes.js";
import type { FridayDiagnosisRoutesDeps } from "../http/routes/friday-diagnosis-routes.js";
import type { FridayAutoFixRoutesDeps } from "../http/routes/friday-auto-fix-routes.js";
import type { FridayAgentLoopRoutesDeps } from "../http/routes/friday-agent-loop-routes.js";
import type { FridaySystemRoutesDeps } from "../http/routes/friday-system-routes.js";
import type { FridayUixRoutesDeps } from "../http/routes/friday-uix-routes.js";
import type { FridayCrossBorderPackRoutesDeps } from "../http/routes/friday-cross-border-pack-routes.js";
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
  tokenSecret: string;
  accessTokenTtlSec?: number;
  refreshTokenTtlSec?: number;
  /** When true, allow login with `{}` (no credentials) for local-only user. Default: false. */
  allowPasswordlessLocalLogin?: boolean;
  /** When true, allow `login({ local: true })` without passphrase checks (localhost-only, never a remote auth bypass). */
  allowLocalBypassLogin?: boolean;
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
  /** Whether plugin marketplace access is configured and available. */
  pluginMarketplaceAvailable?: boolean;
  /** Supported channel kinds (from backend schema). */
  supportedChannelKinds?: string[];
  /** Channel kinds currently enabled in runtime config. */
  enabledChannelKinds?: string[];
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
  /** Optional: reuse hub's session service instead of creating a new one. */
  sessionService?: FridaySessionService;
  /** Optional: agent runtime for agent run endpoints. */
  agentRuntime?: FridayAgentRuntime;
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
  /** Optional: agent event emitter for SSE streaming. */
  agentEventEmitter?: FridayAgentEventEmitter;
  /** Optional: resolves a pending tool approval gate (approve or reject). */
  resolveToolApproval?: (
    runId: string,
    toolCallId: string,
    approved: boolean,
    reason?: string,
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
  /** Optional: beginner-friendly UIX route surface. */
  uix?: FridayUixRoutesDeps;
  /** Optional: cross-border operating pack route surface. */
  crossBorderPack?: FridayCrossBorderPackRoutesDeps;
  /** Optional: search capability metadata surfaced by /v1/health. */
  searchHealth?: {
    provider: string;
    latestness: "provider_backed" | "unverified";
    warning?: string;
  } | (() => {
    provider: string;
    latestness: "provider_backed" | "unverified";
    warning?: string;
  });
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
  /** Optional: marketplace commerce route surface. */
  marketplaceCommerce?: FridayMarketplaceCommerceRoutesDeps;
  /** Optional: unified marketplace asset catalog route surface. */
  marketplaceAssets?: FridayMarketplaceAssetRoutesDeps;
  /** Optional: creator support/profile route surface. */
  marketplaceCreators?: FridayMarketplaceCreatorRoutesDeps;
  /** Optional: request board route surface. */
  marketplaceRequests?: FridayMarketplaceRequestRoutesDeps;
  /** Optional: skill marketplace control-plane route surface. */
  skillMarketplace?: FridaySkillMarketplaceRoutesDeps;
  /** Optional: canonical skills lifecycle service. */
  skillLifecycle?: FridaySkillLifecycleService;
  /** Optional: runtime entitlement guard for marketplace-protected listings. */
  marketplaceEntitlementCheck?: (input: { listingId: string; principalId: string }) => Promise<void>;
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
}

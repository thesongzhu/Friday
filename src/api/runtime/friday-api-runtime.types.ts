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
import type { FridayRustHubAgentRunSealedClientService } from "../mission-spine/friday-rust-hub-agent-run-sealed-client-service.js";
import type {
  FridayOrganicRunProvenance,
  FridayRustHubAgentRunMissionContext,
} from "../mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js";
import type { FridayRustHubRunContinuityProjectorService } from "../mission-spine/friday-rust-hub-run-continuity-projector-service.js";
import type { FridayRustHubRunAnswerReadbackService } from "../mission-spine/friday-rust-hub-run-answer-readback-service.js";
import type { FridayRustHubProvidersDetectService } from "../mission-spine/friday-rust-hub-providers-detect-bridge-service.js";
import type { FridayRustHubCapabilityDoctorService } from "../mission-spine/friday-rust-hub-capability-doctor-bridge-service.js";
import type { FridayRustAgentRunWsClientX25519SecretResolver } from "../mission-spine/friday-rust-hub-agent-run-ws-client-x25519-secret.js";
import type { FridayRustHubWorkflowCatalogBridgeService } from "../mission-spine/friday-rust-hub-workflow-catalog-bridge-service.js";
import type { FridayRustHubWorkflowRunBridgeService } from "../mission-spine/friday-rust-hub-workflow-run-bridge-service.js";
import type { FridayD20SignedBatchWorktreeService } from "../mission-spine/friday-rust-hub-d20-signed-batch-worktree-service.js";
import type { FridayRustSessionLifecycleBridge } from "../http/routes/friday-session-routes.js";
import type { FridayMediaUnderstandingRoutesDeps } from "../http/routes/friday-media-understanding-routes.js";
import type { FridaySocialImportRoutesDeps } from "../http/routes/friday-social-import-routes.js";
import type { FridayTaskWorkflowRoutesDeps } from "../http/routes/friday-task-workflow-routes.js";
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
import type { FridayRetentionSettingsRoutesDeps } from "../http/routes/friday-retention-settings-routes.js";
import type { FridayMissionSpineRoutesDeps } from "../http/routes/friday-mission-spine-routes.js";
import type { FridayMemorySpineRoutesDeps } from "../http/routes/friday-memory-spine-routes.js";
import type { FridayRunOutcomeLearningRoutesDeps } from "../http/routes/friday-run-outcome-learning-routes.js";
import type { FridayCrossBorderPackRoutesDeps } from "../http/routes/friday-cross-border-pack-routes.js";
import type { FridayPackagingRoutesDeps } from "../http/routes/friday-packaging-routes.js";
import type {
  LarkWebhookRelayService,
  LineWebhookListenerService,
  TelegramWebhookService,
  WhatsappWebhookService,
} from "#channels";

/**
 * (Organic mission→run binding PRODUCER — DARK) The narrow structural shape of the ROUTING `startRun`
 * (`routeStartRun`) exposed on {@link FridayApiRuntime.agent}. Typed to the fields the mission
 * auto-dispatch driver sets (the route's full input type is a SUPERSET, so the assignment is
 * type-compatible). The result is awaited-and-discarded by the driver (fire-and-forget); the bound
 * seam is the observability surface.
 */
export type FridayAgentRouteStartRun = (input: {
  task: string;
  principalId?: string;
  providerId?: string;
  model?: string;
  constraints?: { readOnly?: boolean };
  allowedRustRouteTools?: string[];
  missionContext?: FridayRustHubAgentRunMissionContext;
  organicProvenance?: FridayOrganicRunProvenance;
}) => Promise<unknown>;

export interface FridayApiRuntime {
  /**
   * The app SQLite layer backing the HTTP routes. Exposed so the CLI run loop can
   * construct the durable HTTP idempotency/operation journal store from the SAME db
   * (no second db is invented). Optional so lightweight test doubles that build a
   * partial runtime literal stay valid; the real runtime always sets it.
   */
  db?: FridaySqliteLayer;
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
  /**
   * (Organic mission→run binding PRODUCER — DARK) The ROUTING `startRun` entrypoint (the
   * `routeStartRun` wrapper the HTTP startRun route uses). Present only when the agent runtime +
   * emitter are wired; `startRun` is undefined otherwise. Bootstrap hands this to the mission
   * auto-dispatch driver (behind two default-OFF flags) so an organic intake can fire a bound
   * read-only run via the SAME route-qualifying path as a manual startRun. No other consumer reads
   * it, so exposing it is additive + dark-safe.
   */
  agent?: { startRun?: FridayAgentRouteStartRun };
  mcpServer?: FridayMcpServerRoutesDeps;
  deterministicPipeline?: FridayDeterministicPipelineRoutesDeps;
  diagnosis?: FridayDiagnosisRoutesDeps;
  autoFix?: FridayAutoFixRoutesDeps;
  agentLoop?: FridayAgentLoopRoutesDeps;
  uix?: FridayUixRoutesDeps;
  missionSpine?: FridayMissionSpineRoutesDeps;
  /** (Lane M) Memory-confirmation loop terminal route surface. Always registered; DEFAULT-OFF (503). */
  memorySpine?: FridayMemorySpineRoutesDeps;
  /** A1 run-outcome learning candidate decision route surface. Always registered; DEFAULT-OFF (503). */
  runOutcomeLearning?: FridayRunOutcomeLearningRoutesDeps;
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
  /**
   * Test-oracle only: allows legacy TypeScript durable memory writes in
   * isolated validation. Production/runtime callers must leave this unset so
   * memory store/delete/prune, including guard-local quota pre-prune, fail
   * closed until Rust owns durable memory writes.
   */
  allowTestOnlyTsMemoryWrites?: boolean;
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
  /**
   * Test-oracle only: allows legacy TypeScript workflow run execution/control
   * in isolated mock/unit validation. Production/runtime callers must leave
   * this unset so workflow run start, cancel, retry, resume, and evidence
   * export mutation stay fail-closed until Rust owns workflow execution and
   * evidence-export truth.
   */
  allowTestOnlyWorkflowRunExecution?: boolean;
  /**
   * DARK workflow-run Rust bridge (DEFAULT-FALSE): routes POST/GET workflow-run
   * start/read through the proof-only Rust `hub_workflow_run` +
   * `hub_workflow_run_readback` bridge. Default/unset preserves the existing
   * fail-closed TS-retirement path.
   */
  routeWorkflowRunsViaRust?: boolean;
  rustWorkflowRunBridge?: FridayRustHubWorkflowRunBridgeService;
  /**
   * Test-oracle only: allows legacy TypeScript skill run execution in isolated
   * mock/unit validation. Production/runtime callers must leave this unset so
   * POST /v1/skills/:skillId/run remains fail-closed until Rust owns skill
   * execution truth.
   */
  allowTestOnlySkillRunExecution?: boolean;
  /**
   * Test-oracle only: allows legacy TypeScript skill verification in isolated
   * mock/unit validation. Production/runtime callers must leave this unset so
   * POST /v1/skills/:skillId/verify remains fail-closed until Rust owns skill
   * verification truth.
   */
  allowTestOnlySkillVerifyExecution?: boolean;
  /**
   * Test-oracle only: allows legacy TypeScript skill generator sessions in
   * isolated mock/unit validation. Production/runtime callers must leave this
   * unset so skill generator session create/read/message/generate/test/approve/
   * cancel routes remain fail-closed until Rust owns generator truth.
   */
  allowTestOnlySkillGeneratorExecution?: boolean;
  /**
   * Test-oracle only: allows legacy TypeScript workflow generator sessions in
   * isolated mock/unit validation. Production/runtime callers must leave this
   * unset so workflow generator session routes remain fail-closed until Rust
   * owns generator truth.
   */
  allowTestOnlyWorkflowGeneratorExecution?: boolean;
  /**
   * Test-oracle only: allows legacy TypeScript workflow catalog mutations in
   * isolated mock/unit validation. Production/runtime callers must leave this
   * unset so workflow create/update/archive/publish stays fail-closed until
   * Rust owns workflow catalog write truth.
   */
  allowTestOnlyWorkflowCatalogMutationExecution?: boolean;
  /**
   * Test-oracle only: allows legacy TypeScript workflow deploy execution in
   * isolated mock/unit validation. Production/runtime callers must leave this
   * unset so workflow deploy stays fail-closed until Rust owns deployment
   * truth.
   */
  allowTestOnlyWorkflowDeployExecution?: boolean;
  /**
   * Test-oracle only: allows the legacy TypeScript workflow bundle import
   * mutation in isolated mock/unit validation. Production/runtime callers must
   * leave this unset so `POST /v1/workflows/:workflowId/import` stays
   * fail-closed until Rust owns workflow bundle import truth.
   */
  allowTestOnlyWorkflowBundleImportExecution?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript deterministic-pipeline
   * surfaces (rules, node-runner, acceptance, retry, playbook) in isolated
   * mock/unit validation. Production/runtime callers must leave these unset so
   * the corresponding mutation/engine-execution routes stay fail-closed until
   * Rust owns the deterministic-pipeline entrypoints.
   */
  allowTestOnlyRulesPipelineExecution?: boolean;
  allowTestOnlyNodeRunnerExecution?: boolean;
  allowTestOnlyAcceptancePipelineExecution?: boolean;
  allowTestOnlyRetryPipelineExecution?: boolean;
  allowTestOnlyPlaybookPipelineExecution?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript workflow builder draft/lock/
   * template-instantiate mutations in isolated mock/unit/e2e validation.
   * Production/runtime callers must leave this unset so workflow builder draft
   * authoring stays fail-closed until Rust owns it.
   */
  allowTestOnlyWorkflowBuilderDraftExecution?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript workflow conflict resolution
   * mutation in isolated mock/unit validation. Production/runtime callers must
   * leave this unset so conflict resolution stays fail-closed until Rust owns
   * it.
   */
  allowTestOnlyWorkflowConflictResolution?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript autonomy subject upgrade-
   * lifecycle mutations (workflow/skill/plugin/provider/mcp-server/channel-
   * adapter shadow/canary/promote/rollback + plugin review-enable) in isolated
   * mock/unit/e2e validation. Production/runtime callers must leave this unset
   * so autonomy upgrade-lifecycle stays fail-closed until Rust owns it.
   */
  allowTestOnlyAutonomyLifecycleExecution?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript standing-goal/agenda
   * mutations in isolated validation. Production/runtime callers must leave
   * this unset so standing-agenda stays fail-closed until Rust owns it.
   */
  allowTestOnlyStandingAgendaExecution?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript autonomy-policy patch
   * mutation in isolated validation. Production/runtime callers must leave this
   * unset so autonomy policy mutation stays fail-closed until Rust owns it.
   */
  allowTestOnlyAutonomyPolicyMutation?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript capability-acquisition run
   * mutations (start/approve/cancel) in isolated validation. Production/runtime
   * callers must leave this unset so capability acquisition stays fail-closed
   * until Rust owns it.
   */
  allowTestOnlyCapabilityAcquisitionExecution?: boolean;
  /** Optional: user/project prompt-guidance provider for fallback workflow runtime creation. */
  userRulesContextProvider?: CreateFridayWorkflowRuntimeDeps["userRulesContextProvider"];
  /** Optional: reuse hub's session service instead of creating a new one. */
  sessionService?: FridaySessionService;
  /** Optional: agent runtime for agent run endpoints. */
  agentRuntime?: FridayAgentRuntime;
  /**
   * Test-oracle only: allows legacy TypeScript agent run execution in isolated
   * mock/unit validation. Production/runtime callers must leave this unset so
   * POST /v1/agent/runs remains fail-closed until Rust owns execution.
   */
  allowTestOnlyAgentRunStartExecution?: boolean;
  /**
   * execrun-replacement slice 4 (DARK): per-run "route this run via the future Rust
   * read-only loop" flag. DEFAULT-FALSE — leave unset in production/runtime. When unset
   * (default) the startRun HTTP route never even evaluates the qualifying predicate and
   * behavior is byte-identical to today. When set true, the route-bound startRun wrapper
   * computes `qualifiesForRustReadOnlyRoute(...)` and DISCARDS the result — no actual
   * routing is wired in this slice (the later composition slice consumes the bool). This
   * flag holds the gate; it does not turn anything on.
   */
  routeAgentRunViaRust?: boolean;
  /**
   * GATE-AGENT-REPLACE A3 courier (DARK): the master ON/OFF (resolved boolean) for the
   * pause/resume PRODUCT TRANSPORT. DEFAULT-FALSE — leave unset in production/runtime. Mirrors the
   * Phase-2 Rust server's default-off `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST` flag posture EXACTLY.
   * When FALSE (default): the sealed WS courier's new `AgentRunPaused` inbound branch fails closed
   * (a paused frame is an unknown message) and its `resumeWithApproval` relay is inert — so the
   * compose path NEVER sees a paused outcome and behavior is BYTE-IDENTICAL to today. When TRUE:
   * the courier admits a server `AgentRunPaused` (settling with a refs-only paused outcome →
   * compose projects an honest non-Finished row) and relays an opaque operator-signed approval over
   * a fresh sealed session. This flag ADMITS the ability to handle a paused run + relay a signature;
   * it admits NO mutating run (the read-only qualifier stays hard — a SEPARATE later PR). Sourced in
   * bootstrap from `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST` / explicit config via
   * `resolveAgentRunControlViaRust`. When unset/false the courier is constructed but its new
   * behavior is never reached (byte-identical 503 / result paths untouched).
   */
  agentRunControlViaRust?: boolean;
  /**
   * D20 W2 trust-dial worktree batch product entrypoint (DARK): default false. When true, the
   * agent route can relay an owner-bound signed batch artifact + exact action JSON to the Rust
   * verifier/consumer. It does not mint signatures and does not relax the normal GO-LIVE gates.
   */
  d20SignedBatchWorktreeViaRust?: boolean;
  /** D20 W2 bridge service; tests inject stubs, production lazily constructs the Rust-bin bridge. */
  d20SignedBatchWorktreeService?: FridayD20SignedBatchWorktreeService;
  /**
   * providers-bridge cut-over (DARK): the master ON/OFF (resolved boolean) for routing
   * the retired Tier-2 PROVIDER surfaces — `providers.detect` (setup routes) and
   * `providers.doctor` / `providers.validate` / `capabilities.doctor` (provider routes)
   * — to the merged Rust `hub_providers_detect` / `hub_capability_doctor` bins instead
   * of fail-closing with 503. DEFAULT-FALSE — leave unset in production/runtime so those
   * routes stay byte-identical to today. Sourced (in bootstrap) from
   * `FRIDAY_ROUTE_PROVIDERS_VIA_RUST` / explicit config via `resolveRouteProvidersViaRust`.
   * When unset/false the bridge services below are constructed but NEVER consulted.
   */
  routeProvidersViaRust?: boolean;
  /**
   * providers-bridge cut-over (DARK): the providers-detect bridge service consulted by
   * the `providers.detect` route ONLY when {@link routeProvidersViaRust} is true. OPTIONAL
   * — when omitted the runtime lazily constructs the real service. Tests inject a bridge
   * pointed at a scripted fake bin (no real cargo/provider, no spend, no network).
   */
  rustProvidersDetect?: FridayRustHubProvidersDetectService;
  /**
   * providers-bridge cut-over (DARK): the capability-doctor bridge service consulted by
   * the `providers.doctor` / `providers.validate` / `capabilities.doctor` routes ONLY when
   * {@link routeProvidersViaRust} is true. OPTIONAL — when omitted the runtime lazily
   * constructs the real service. The bin's LIVE key-validation arm (~1-2 Anthropic tokens)
   * runs ONLY when a caller explicitly opts in (capabilities.doctor `validateKeys: true`).
   */
  rustCapabilityDoctor?: FridayRustHubCapabilityDoctorService;
  /**
   * execrun-replacement slice S-F-compose (DARK): the three dark-substrate services the
   * composition wires together when {@link routeAgentRunViaRust} is on AND a run qualifies.
   * ALL OPTIONAL — when omitted the composition lazily constructs the real services. Tests
   * inject a scripted-stub WS client + a `delivered` readback + the real projector so the
   * full path is mock-proven (no real Rust bin, no provider, no spend, no network egress).
   * None of these is consulted while the flag is off / a run is disqualified (byte-identical
   * 503 path is untouched).
   */
  rustAgentRunWsClient?: FridayRustHubAgentRunSealedClientService;
  /** S-F-compose (DARK): the slice-2 Rust→TS continuity projector (SOLE TS usage writer). */
  rustAgentRunContinuityProjector?: FridayRustHubRunContinuityProjectorService;
  /** S-F-compose (DARK): the slice-3 owner-gated body readback (returns body to the owner). */
  rustAgentRunAnswerReadback?: FridayRustHubRunAnswerReadbackService;
  /**
   * B1-compose (DARK): the SecureStore resolver for the sealed WS client's X25519 SECRET (the
   * ECDH model — REPLACES the old symmetric session-key resolver). The sealed client runs the
   * handshake with this secret and builds the auth_proof itself; its derived pubkey is what 6b
   * enrolls in the server peer-allowlist. Default = the keychain-backed resolver. A `null`/short
   * resolve fails closed → no WS call, today's 503. Tests inject a fixture secret. NEVER logs it.
   */
  rustAgentRunWsClientSecretResolver?: FridayRustAgentRunWsClientX25519SecretResolver;
  /**
   * S-F-compose (DARK): filesystem path to the Rust Hub DB the owner-gated body readback
   * reads from. Default = `process.env.FRIDAY_HUB_AGENT_RUN_DB_PATH`. Absent → the readback
   * fails closed (no body) → 503. Tests point this at a hermetic fixture DB / stub readback.
   */
  rustAgentRunHubDbPath?: string;
  /**
   * Tier-2 WORKFLOW catalog-mutation route bridge (DARK): the master ON/OFF for routing the
   * `workflows.create/update/archive/publish/deploy` mutations to the Rust `hub_workflow_catalog`
   * bin (#657). DEFAULT-FALSE — leave unset in production/runtime so the catalog-mutation routes
   * stay byte-identical to today's fail-closed `TS_RUNTIME_WORKFLOW_CATALOG_MUTATION_RETIRED` 503.
   * When set true, each catalog-mutation route handler runs auth, then routes to the refs-only
   * bridge ({@link rustWorkflowCatalogBridge}) and returns a refs-only receipt (a `rust_wired_dev`
   * DEV-DB ceiling — the bin migrates the target DB on open and must NOT point at the production
   * hub DB, so the production cut-over is a separate operator decision). Its resolution +
   * precedence live in `resolveRouteWorkflowsViaRust` (explicit config wins; the
   * `FRIDAY_ROUTE_WORKFLOWS_VIA_RUST` env knob fills the unset gap).
   */
  routeWorkflowsViaRust?: boolean;
  /**
   * Tier-2 WORKFLOW catalog-mutation route bridge (DARK): the refs-only TS→Rust catalog-mutation
   * bridge consulted ONLY on the {@link routeWorkflowsViaRust}-on branch. OPTIONAL — when omitted
   * the runtime lazily constructs the real bridge (reads the `FRIDAY_HUB_WORKFLOW_CATALOG_*`
   * knobs: bin path + DEV DB path + timeout). NEVER consulted while the flag is off → byte-identical
   * 503 path is untouched. Tests inject a scripted-mock `.mjs` adapterBin bridge so the flag-on
   * path is mock-proven (no real Rust bin, no compile).
   */
  rustWorkflowCatalogBridge?: FridayRustHubWorkflowCatalogBridgeService;
  /**
   * Test-oracle only: allows legacy TypeScript agent run controls in isolated
   * mock/unit validation. Production/runtime callers must leave this unset so
   * agent cancel, rollback, automation-run, plan approval, and tool approval
   * controls stay fail-closed until Rust owns execution/control truth.
   */
  allowTestOnlyAgentRunControlExecution?: boolean;
  /**
   * Test-oracle only: allows legacy TypeScript session lifecycle/message
   * mutations in isolated mock/unit validation. Production/runtime callers must
   * leave this unset so session create/messages.create/archive/reset/delete/
   * prune/sweep/compact and fork create/merge stay fail-closed until Rust owns
   * the session lifecycle entrypoint.
   */
  allowTestOnlySessionExecution?: boolean;
  /**
   * Test-oracle only: allows legacy TypeScript session agent-run execution in
   * isolated mock/unit validation. Production/runtime callers must leave this
   * unset so POST /v1/sessions/:sessionKey/run stays fail-closed until Rust owns
   * the session agent-run entrypoint.
   */
  allowTestOnlySessionRunExecution?: boolean;
  /**
   * Test-oracle only: allows legacy TypeScript session memory extraction
   * mutations in isolated mock/unit validation. Production/runtime callers must
   * leave this unset so memory extract/remember/extraction-retry stay
   * fail-closed until Rust owns the session memory extraction entrypoint.
   */
  allowTestOnlySessionMemoryExtractionExecution?: boolean;
  /**
   * (CORE-RUNNABLE-001 / CORE-A CR-3) SESSION Rust-owned lifecycle/run bridge (DARK): the resolved
   * default-false master flag for routing the session run (`POST /v1/sessions/:sessionKey/run`) to
   * the Rust-owned loop instead of fail-closing. DEFAULT-FALSE — leave unset in production/runtime so
   * the session routes stay byte-identical to today's fail-closed 503. Sourced (in bootstrap) from
   * `FRIDAY_ROUTE_SESSIONS_VIA_RUST` / explicit config via `resolveRouteSessionsViaRust`. When
   * unset/false the {@link rustSessionLifecycleBridge} is never consulted.
   */
  routeSessionsViaRust?: boolean;
  /**
   * (CORE-RUNNABLE-001 / CORE-A CR-3) The REAL Rust-owned session lifecycle/run bridge consulted by
   * the session routes ONLY when {@link routeSessionsViaRust} is true. OPTIONAL — bootstrap builds +
   * injects the real sealed-WS adapter ONLY when the flag is on; when omitted (the DEFAULT) the
   * session routes fail closed (503). Tests inject the real adapter over a test transport (a fake
   * sealed client + readback) to prove reachability WITHOUT a socket.
   */
  rustSessionLifecycleBridge?: FridayRustSessionLifecycleBridge;
  /**
   * Test-oracle only: allow the legacy TypeScript realtime checkpoint-ack
   * mutation (POST /v1/realtime/ack). Production/runtime callers must leave this
   * unset so the ack surface stays fail-closed until Rust owns realtime delivery.
   */
  allowTestOnlyRealtimeExecution?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript skill-converter mutations
   * (POST /v1/skills/convert, /v1/skills/import, /v1/skills/pack). Production/
   * runtime callers must leave this unset so those surfaces fail-close until
   * Rust owns skill conversion.
   */
  allowTestOnlySkillConverterExecution?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript media-understanding product
   * logic (POST /v1/media-understanding/analyze + /doctor). Production/runtime
   * callers must leave this unset so those surfaces fail-close until Rust owns
   * media understanding.
   */
  allowTestOnlyMediaUnderstandingExecution?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript fleet satellite remediation
   * execute mutation (POST /v1/fleet/satellites/:id/remediation/:actionId/execute).
   * Production/runtime callers must leave this unset so the route fail-closes
   * until Rust owns fleet remediation.
   */
  allowTestOnlyFleetRemediationExecution?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript discovery product-logic
   * routes (POST /v1/discovery/scan, PATCH /v1/discovery/policy, POST
   * /v1/discovery/integrate). Production/runtime callers must leave this unset
   * so those surfaces fail-close until Rust owns discovery.
   */
  allowTestOnlyDiscoveryExecution?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript social-import mutation
   * (POST /v1/skills/social-import). Production/runtime callers must leave this
   * unset so the route fail-closes (and the XHS extraction never runs) until
   * Rust owns social import.
   */
  allowTestOnlySocialImportExecution?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript deep-link product logic
   * (POST /v1/deeplink/preview verdict compute + POST /v1/deeplink/apply
   * dispatch). Production/runtime callers must leave this unset so both routes
   * fail-close until Rust owns deep-link handling.
   */
  allowTestOnlyDeepLinkExecution?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript plugin lifecycle mutations
   * (install/enable/disable/uninstall). Production/runtime callers must leave
   * this unset so those routes fail-close until Rust owns the plugin lifecycle.
   */
  allowTestOnlyPluginExecution?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript provider-detect probe
   * (POST /v1/providers/detect). Production/runtime callers must leave this
   * unset so the route fail-closes until Rust owns provider detection. NOTE:
   * retiring this 503s onboarding model-detection + the release-GO closure
   * harness (operator reconciliation item).
   */
  allowTestOnlyProviderDetectExecution?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript provider probe surfaces
   * (POST /v1/providers/:providerId/validate, GET /v1/providers/:providerId/doctor,
   * POST /v1/capabilities/doctor). Production/runtime callers must leave this
   * unset so these probes fail-close until Rust owns the provider-probe
   * entrypoint. NOTE: retiring validate 503s the release-GO closure harness
   * (operator reconciliation item).
   */
  allowTestOnlyProviderProbeExecution?: boolean;
  /**
   * Test-oracle only: allow the legacy TypeScript provider routing-controls
   * surfaces (POST /v1/providers/routing/pin, POST /v1/providers/routing/penalties/clear).
   * Production/runtime callers must leave this unset so these user-scoped routing
   * mutations fail-close until Rust owns the routing-controls entrypoint. Does NOT
   * cover the model-routing config surfaces (GET/PUT /v1/model-routing).
   */
  allowTestOnlyProviderRoutingControlsExecution?: boolean;
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
  /**
   * TEST-ONLY escape hatch (SEC-REALTIME-EVENT-PII-BY-VALUE / round-6 P0-1). When
   * `true`, a realtime identifier pseudonymizer that cannot resolve a durable master
   * key (or owner) runs as an INACTIVE identity no-op instead of FAILING CLOSED — so
   * unit/integration constructions that never provision a master key and do not care
   * about identifier opacity keep working. It is NEVER set on the production
   * `createFridayHub` path: default (undefined) = fail-closed, i.e. the realtime sink
   * REFUSES to persist raw identifiers when no durable key exists (never identity
   * passthrough, never raw at rest). Identity behaviour is therefore unreachable from
   * default `createFridayHub`.
   */
  allowTestOnlyInactiveRealtimePseudonym?: boolean;
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
  /** Optional: owner-bound retention-Settings route surface (RETENTION-R3a). */
  retentionSettings?: FridayRetentionSettingsRoutesDeps;
  /**
   * Optional Mission Spine workbench projection route surface.
   *
   * The route is always registered. When omitted, GET
   * `/v1/mission-spine/workbench` fails closed with
   * `503 MISSION_SPINE_WORKBENCH_UNAVAILABLE` instead of returning a prep
   * snapshot as live proof.
   */
  missionSpine?: FridayMissionSpineRoutesDeps;
  /**
   * (Lane M) Memory-confirmation loop terminal route surface. The route is ALWAYS registered. When
   * omitted (the DEFAULT), POST `/v1/memory-spine/decide` fails closed with
   * `503 MEMORY_SPINE_DISPATCH_UNAVAILABLE` instead of driving a confirm/reject — the live path
   * needs an operator to wire the adapter AND flip the Rust `FRIDAY_MEMORY_CONFIRM` flag.
   */
  memorySpine?: FridayMemorySpineRoutesDeps;
  /** Optional A1 run-outcome learning candidate decision route surface. Default: fail-closed 503. */
  runOutcomeLearning?: FridayRunOutcomeLearningRoutesDeps;
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
    telegramWebhookRelay?: TelegramWebhookService;
  };
  outboxQueueService?: FridayOutboxQueueService;
  /** Optional: packaging system route surface (publish, install, upgrade, rollback, keys). */
  packaging?: FridayPackagingRoutesDeps;
  /**
   * Phase 13.5A task workflow policy route surface.
   *
   * Optional. The routes are always registered regardless of whether this
   * slot is supplied — `createFridayApiRuntime` coalesces a missing/undefined
   * value to an honest-disabled deps shape so disabled deployments return
   * `503 TASK_WORKFLOWS_DISABLED`, never 404.
   *
   * The surface is intentionally separate from `/v1/agent/runs`; the task
   * workflow service only writes additive task workflow tables and never
   * mutates agent run records.
   */
  taskWorkflows?: FridayTaskWorkflowRoutesDeps;
}

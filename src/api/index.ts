// ─── Phase 8: API Layer barrel exports ───

// Error code catalog
export { FRIDAY_API_ERROR_CODES, buildFridayApiError } from "./model/friday-api-error-codes.js";
export type { FridayApiErrorCode, FridayApiErrorShape } from "./model/friday-api-error-codes.js";

// Model types
export type * from "./model/friday-api-common.types.js";
export type * from "./model/friday-api-auth.types.js";
export type * from "./model/friday-api-workflow.types.js";
export type * from "./model/friday-api-fleet.types.js";
export type * from "./model/friday-api-realtime.types.js";
export type * from "./model/friday-api-security.types.js";
export type * from "./model/friday-api-provider.types.js";
export type * from "./model/friday-api-skill-generator.types.js";
export type * from "./model/friday-api-skill-converter.types.js";
export type * from "./model/friday-api-memory.types.js";
export type * from "./model/friday-api-session.types.js";
export type * from "./model/friday-api-plugin.types.js";
export type * from "./model/friday-api-system.types.js";
export type * from "./model/friday-api-guide-lens.types.js";
export type * from "./model/friday-api-self-healing.types.js";
export type * from "./model/friday-api-uix-surface.types.js";
export type * from "./model/friday-api-cross-border-pack.types.js";
export type * from "./model/friday-api-studio.types.js";
export type * from "./model/friday-api-runtime-admin.types.js";
export type * from "./model/friday-api-autonomy.types.js";
export type * from "./model/friday-api-mission-spine.types.js";

// Deep link types
export type {
  FridayDeepLinkResourceType,
  FridayDeepLinkPayload,
  FridayDeepLinkCheck,
  FridayDeepLinkCheckLevel,
  FridayDeepLinkPreviewResult,
  FridayDeepLinkApplyResult,
} from "../deeplink/index.js";
export type { FridayDeepLinkParseResult } from "../deeplink/index.js";

// Auth
export { createFridayAuthService, FridayAuthError, hashPasswordScrypt } from "./auth/friday-auth-service.js";
export type { FridayAuthService } from "./auth/friday-auth-service.types.js";
export { createFridayTokenValidator, encodeToken, FridayTokenValidationError } from "./auth/friday-token-validator.js";
export { getScopesForRole, roleHasScope, principalHasAnyScope, principalHasAnyRole } from "./auth/friday-rbac-policy.js";
export { createFridayRateLimitService } from "./auth/friday-rate-limit-service.js";
export type { FridayRateLimitService } from "./auth/friday-rate-limit-service.types.js";
export { AUTH_LOCKOUT_SCOPE_SHARED_SECRET, AUTH_LOCKOUT_SCOPE_DEVICE_TOKEN } from "./auth/friday-rate-limit-service.types.js";
export { createFridayAuthMiddlewareFactory } from "./auth/friday-auth-middleware.js";
export type { FridayAuthMiddlewareFactory } from "./auth/friday-auth-middleware.js";

// Realtime
export { createFridayRealtimeEventBus } from "./realtime/friday-realtime-event-bus.js";
export { createFridayRealtimeSubscriptionService } from "./realtime/friday-realtime-subscription-service.js";
export type { FridayRealtimeSubscriptionService } from "./realtime/friday-realtime-subscription-service.js";
export { createFridayRealtimeWsGateway } from "./realtime/friday-realtime-ws-gateway.js";
export type { FridayRealtimeWsGateway, FridayWsConnection } from "./realtime/friday-realtime-ws-gateway.js";
export {
  createFridayRealtimeFrameCrypto,
  isFridayRealtimeEncryptedFrameEnvelope,
} from "./realtime/friday-realtime-frame-crypto.js";
export type { FridayRealtimeFrameCrypto } from "./realtime/friday-realtime-frame-crypto.js";

// Execution-control event emitter
export { createExecutionControlEventEmitter } from "./realtime/friday-execution-control-event-emitter.js";
export type {
  FridayExecutionControlEventEmitter,
  FridayExecutionControlEventName,
  CreateExecutionControlEventEmitterDeps,
} from "./realtime/friday-execution-control-event-emitter.js";

// Event payload redaction
export { redactEventPayload } from "./realtime/friday-event-payload-redactor.js";

// Fleet
export { createFridayFleetDashboardService } from "./fleet/friday-fleet-dashboard-service.js";
export type { FridayFleetDashboardService } from "./fleet/friday-fleet-dashboard-service.types.js";
export { calculateSatelliteHealth, healthStateFromScore } from "./fleet/friday-fleet-health-calculator.js";
export type { FridayHealthCalculatorInput } from "./fleet/friday-fleet-health-calculator.js";
export { calculateSatelliteTrust, trustBandFromScore } from "./fleet/friday-fleet-trust-calculator.js";
export type { FridayTrustCalculatorInput } from "./fleet/friday-fleet-trust-calculator.js";
export { createFridayFleetDashboardRepository } from "./fleet/friday-fleet-dashboard-repository.js";
export type { FridayFleetDashboardRepository } from "./fleet/friday-fleet-dashboard-repository.js";

// Conflicts
export { createFridayWorkflowConflictService, FridayConflictServiceError } from "./conflicts/friday-workflow-conflict-service.js";
export type { FridayWorkflowConflictService } from "./conflicts/friday-workflow-conflict-service.types.js";
// HTTP
export { createFridayHttpRouteRegistry } from "./http/friday-http-route-registry.js";
export {
  FRIDAY_ROUTE_OPERATION_ID_RENAMES,
  FRIDAY_ROUTE_OPERATION_ID_PATTERN,
  isFridayCanonicalRouteOperationId,
} from "./http/friday-http-route-contract.js";
export type {
  FridayRenamedOperationId,
  FridayCanonicalRenamedOperationId,
} from "./http/friday-http-route-contract.js";
export { buildErrorResponse, mapErrorToStatusCode, mapErrorToApiError } from "./http/friday-http-error-mapper.js";
export { createFridayHttpServer } from "./http/friday-http-server.js";
export type { FridayHttpServer, FridayHttpServerDeps } from "./http/friday-http-server.js";
export {
  parseFridayHttpTrustProxyMode,
  resolveFridayClientIp,
  normalizeFridayClientIp,
} from "./http/friday-http-client-ip.js";
export type { FridayHttpTrustProxyMode } from "./http/friday-http-client-ip.js";

// Asset inventory routes (unified cross-category inventory)
export { createFridayAssetInventoryRoutes } from "./http/routes/friday-asset-inventory-routes.js";
export type { FridayAssetInventoryRoutesDeps } from "./http/routes/friday-asset-inventory-routes.js";

// Memory routes (guard-based)
export { createFridayMemoryRoutes } from "./http/routes/friday-memory-routes.js";
export type { FridayMemoryRoutesDeps } from "./http/routes/friday-memory-routes.js";

// Session routes
export { createFridaySessionRoutes } from "./http/routes/friday-session-routes.js";
export type { FridaySessionRoutesDeps } from "./http/routes/friday-session-routes.js";

// Health routes
export { createFridayHealthRoutes } from "./http/routes/friday-health-routes.js";
export type { FridayHealthRoutesDeps } from "./http/routes/friday-health-routes.js";

// Runtime admin routes
export { createFridayRuntimeAdminRoutes } from "./http/routes/friday-runtime-admin-routes.js";
export type { FridayRuntimeAdminRoutesDeps } from "./http/routes/friday-runtime-admin-routes.js";
export { createFridayAutonomyRoutes } from "./http/routes/friday-autonomy-routes.js";
export type { FridayAutonomyRoutesDeps } from "./http/routes/friday-autonomy-routes.js";

// Secret routes
export { createFridaySecretRoutes } from "./http/routes/friday-secret-routes.js";
export type { FridaySecretRoutesDeps } from "./http/routes/friday-secret-routes.js";

// HTTP Routes
export { createFridayProviderRoutes } from "./http/routes/friday-provider-routes.js";
export { createFridayMediaUnderstandingRoutes } from "./http/routes/friday-media-understanding-routes.js";
export type {
  FridayMediaUnderstandingRoutesDeps,
  FridayMediaUnderstandingDoctorRequest,
  FridayMediaUnderstandingDoctorResponse,
  FridayMediaUnderstandingAnalyzeRequest,
  FridayMediaUnderstandingAnalyzeRequestAttachment,
  FridayMediaUnderstandingAnalyzeResponse,
} from "./http/routes/friday-media-understanding-routes.js";
export { createFridaySocialImportRoutes } from "./http/routes/friday-social-import-routes.js";
export type { FridaySocialImportRoutesDeps } from "./http/routes/friday-social-import-routes.js";
export { createFridayAuthRoutes } from "./http/routes/friday-auth-routes.js";
export { createFridayRealtimeRoutes } from "./http/routes/friday-realtime-routes.js";
export { createFridayFleetRoutes } from "./http/routes/friday-fleet-routes.js";
export { createFridayWorkflowRoutes } from "./http/routes/friday-workflow-routes.js";
export type { FridayWorkflowRoutesDeps } from "./http/routes/friday-workflow-routes.js";
export { createFridayWorkflowRunRoutes } from "./http/routes/friday-workflow-run-routes.js";
export type { FridayWorkflowRunRoutesDeps } from "./http/routes/friday-workflow-run-routes.js";
export { createFridayWorkflowBuilderRoutes } from "./http/routes/friday-workflow-builder-routes.js";
export {
  createFridayWorkflowBuilderTemplateRoutes,
} from "./http/routes/friday-workflow-builder-routes.js";
export type {
  FridayWorkflowBuilderRoutesDeps,
  FridayWorkflowBuilderTemplateRoutesDeps,
} from "./http/routes/friday-workflow-builder-routes.js";
export { createFridayWorkflowConflictRoutes } from "./http/routes/friday-workflow-conflict-routes.js";
export type { FridayWorkflowConflictRoutesDeps } from "./http/routes/friday-workflow-conflict-routes.js";
export { createFridaySkillGeneratorRoutes } from "./http/routes/friday-skill-generator-routes.js";
export type { FridaySkillGeneratorRoutesDeps } from "./http/routes/friday-skill-generator-routes.js";
export { createFridayDiagnosisRoutes } from "./http/routes/friday-diagnosis-routes.js";
export type { FridayDiagnosisRoutesDeps } from "./http/routes/friday-diagnosis-routes.js";
export { createFridayAutoFixRoutes } from "./http/routes/friday-auto-fix-routes.js";
export type { FridayAutoFixRoutesDeps } from "./http/routes/friday-auto-fix-routes.js";
export { createFridayAgentLoopRoutes } from "./http/routes/friday-agent-loop-routes.js";
export type { FridayAgentLoopRoutesDeps } from "./http/routes/friday-agent-loop-routes.js";
export { createFridaySkillConverterRoutes } from "./http/routes/friday-skill-converter-routes.js";
export { createFridayWorkflowGeneratorRoutes } from "./http/routes/friday-workflow-generator-routes.js";
export type { FridayWorkflowGeneratorRoutesDeps } from "./http/routes/friday-workflow-generator-routes.js";
export { createFridaySecurityRoutes } from "./http/routes/friday-security-routes.js";
export type { FridaySecurityRoutesDeps } from "./http/routes/friday-security-routes.js";

// Plugin routes
export { createFridayPluginRoutes } from "./http/routes/friday-plugin-routes.js";
export type { FridayPluginRoutesDeps } from "./http/routes/friday-plugin-routes.js";

// Agent routes
export { createFridayAgentRoutes } from "./http/routes/friday-agent-routes.js";
export type { FridayAgentRoutesDeps } from "./http/routes/friday-agent-routes.js";

// Sub-agent routes
export { createFridaySubagentRoutes } from "./http/routes/friday-subagent-routes.js";
export type { FridaySubagentRoutesDeps } from "./http/routes/friday-subagent-routes.js";

// Persistence
export { createFridayRealtimeEventRepository } from "./persistence/friday-realtime-event-repository.js";
export type { FridayRealtimeEventRepository } from "./persistence/friday-realtime-event-repository.js";
export { createFridayRealtimeCheckpointRepository } from "./persistence/friday-realtime-checkpoint-repository.js";
export { createFridaySetupBootstrapNonceRepository } from "./persistence/friday-setup-bootstrap-nonce-repository.js";
export type {
  FridaySetupBootstrapNonceRepository,
  FridaySetupBootstrapNonceRow,
  SweepFridaySetupBootstrapNoncesInput,
  SweepFridaySetupBootstrapNoncesResult,
} from "./persistence/friday-setup-bootstrap-nonce-repository.js";

// Multi-tenant security routes (B-002)
export { createFridayMultiTenantSecurityRoutes } from "./http/routes/friday-multi-tenant-security-routes.js";
export type { FridayMultiTenantSecurityRoutesDeps } from "./http/routes/friday-multi-tenant-security-routes.js";

// Deterministic pipeline routes (A-007)
export { createFridayDeterministicPipelineRoutes } from "./http/routes/friday-deterministic-pipeline-routes.js";
export type { FridayDeterministicPipelineRoutesDeps } from "./http/routes/friday-deterministic-pipeline-routes.js";

// Observability routes (B-005)
export { createFridayObservabilityRoutes } from "./http/routes/friday-observability-routes.js";
export type { FridayObservabilityRoutesDeps } from "./http/routes/friday-observability-routes.js";
export type {
  FridayAlertDestinationType,
  FridayAlertDestinationBaseSummary,
  FridayAlertDestinationSlackSummary,
  FridayAlertDestinationEmailSummary,
  FridayAlertDestinationSummary,
  FridayListAlertDestinationsResponse,
  FridayCreateAlertDestinationRequest,
  FridayCreateAlertDestinationResponse,
  FridayUpdateAlertDestinationRequest,
  FridayUpdateAlertDestinationResponse,
  FridayDeleteAlertDestinationResponse,
  FridayAlertDispatchAttemptSummary,
} from "../observability/api/friday-observability-api.types.js";

// Desktop routes (C-003)
export { createFridayDesktopRoutes } from "./http/routes/friday-desktop-routes.js";
export type { FridayDesktopRoutesDeps } from "./http/routes/friday-desktop-routes.js";
export {
  createFridayChannelRoutes,
  getChannelPersona,
  hydrateChannelPersonaStore,
  resetChannelPersonaStore,
} from "./http/routes/friday-channel-routes.js";
export type { FridayChannelRoutesDeps, FridayChannelPersonaConfig } from "./http/routes/friday-channel-routes.js";
export { createFridayGrantRoutes } from "./http/routes/friday-grant-routes.js";
export type { FridayGrantRoutesDeps } from "./http/routes/friday-grant-routes.js";

// System routes (C-012)
export { createFridaySystemRoutes } from "./http/routes/friday-system-routes.js";
export type { FridaySystemRoutesDeps } from "./http/routes/friday-system-routes.js";
export { createFridayGuideLensRoutes } from "./http/routes/friday-guide-lens-routes.js";
export type { FridayGuideLensRoutesDeps } from "./http/routes/friday-guide-lens-routes.js";
export { createFridayUixRoutes } from "./http/routes/friday-uix-routes.js";
export type { FridayUixRoutesDeps } from "./http/routes/friday-uix-routes.js";
export {
  createFridayRetentionSettingsRoutes,
  createFridayRetentionPolicyAuditAppender,
  createFridayRetentionReceiptRecovery,
} from "./http/routes/friday-retention-settings-routes.js";
export type {
  FridayRetentionSettingsRoutesDeps,
  FridayRetentionPolicyAuditEntry,
  FridayRetentionPolicyUpdateReceipt,
} from "./http/routes/friday-retention-settings-routes.js";
export { createFridayMissionSpineRoutes } from "./http/routes/friday-mission-spine-routes.js";
export type { FridayMissionSpineRoutesDeps } from "./http/routes/friday-mission-spine-routes.js";
export { createFridayMemorySpineRoutes } from "./http/routes/friday-memory-spine-routes.js";
export type {
  FridayMemorySpineRoutesDeps,
  FridayMemorySpineDispatchService,
} from "./http/routes/friday-memory-spine-routes.js";
export { createFridayReflexRoutes } from "./http/routes/friday-reflex-routes.js";
export type { FridayReflexRoutesDeps } from "./http/routes/friday-reflex-routes.js";
export { createFridayCrossBorderPackRoutes } from "./http/routes/friday-cross-border-pack-routes.js";
export type { FridayCrossBorderPackRoutesDeps } from "./http/routes/friday-cross-border-pack-routes.js";
export { createFridayStudioRoutes } from "./http/routes/friday-studio-routes.js";
export type { FridayStudioRoutesDeps } from "./http/routes/friday-studio-routes.js";

// Discovery routes (C-005)
export { createFridayDiscoveryDisabledRoutes, createFridayDiscoveryRoutes } from "./http/routes/friday-discovery-routes.js";
export type { FridayDiscoveryRoutesDeps } from "./http/routes/friday-discovery-routes.js";
export { createFridayDiscoveryIntegrationRoutes } from "./http/routes/friday-discovery-integration-routes.js";
export type { FridayDiscoveryIntegrationRoutesDeps } from "./http/routes/friday-discovery-integration-routes.js";
export type {
  FridayAgentRunExecutionResponse,
  FridayCancelAgentRunResponse,
  FridayGetAgentRunResponse,
  FridayListAgentRunsQuery,
  FridayListAgentRunsResponse,
  FridayStartAgentRunRequest,
  FridayStartAgentRunResponse,
} from "./model/friday-api-agent.types.js";

// MCP server routes (C-011)
export { createFridayMcpServerRoutes } from "./http/routes/friday-mcp-server-routes.js";
export type { FridayMcpServerRoutesDeps } from "./http/routes/friday-mcp-server-routes.js";

// Satellite pairing routes (C-010)
export { createFridaySatellitePairingRoutes } from "./http/routes/friday-satellite-pairing-routes.js";
export type { FridaySatellitePairingRoutesDeps } from "./http/routes/friday-satellite-pairing-routes.js";
export { createFridaySatelliteRuntimeRoutes } from "./http/routes/friday-satellite-runtime-routes.js";
export type { FridaySatelliteRuntimeRoutesDeps } from "./http/routes/friday-satellite-runtime-routes.js";

// Phase 17A — user-owned cloud worker setup UX routes.
export { createFridayCloudWorkerSetupRoutes } from "./http/routes/friday-cloud-worker-setup-routes.js";
export type { FridayCloudWorkerSetupRoutesDeps } from "./http/routes/friday-cloud-worker-setup-routes.js";

// Runtime
export { createFridayApiRuntime } from "./runtime/friday-api-runtime.js";
// (Organic mission→run binding PRODUCER — DARK) The provider/model shapes the Rust route qualifier
// admits. Re-exported so bootstrap can hand the mission auto-dispatch driver the EXACT qualifying
// shapes without retyping literals.
export {
  RUST_ROUTE_CLAUDE_MODEL,
  RUST_ROUTE_CLAUDE_PROVIDER_ID,
  RUST_ROUTE_CODEX_MODEL,
  RUST_ROUTE_CODEX_PROVIDER_ID,
  RUST_ROUTE_DEEPSEEK_FLASH_MODEL,
  RUST_ROUTE_DEEPSEEK_PROVIDER_ID,
  RUST_ROUTE_READ_TOOL_ALLOWLIST,
} from "./runtime/friday-api-runtime.js";
export type {
  FridayApiRuntime,
  CreateFridayApiRuntimeDeps,
  FridayAgentRouteStartRun,
} from "./runtime/friday-api-runtime.types.js";
// (Organic mission→run binding PRODUCER — DARK) The intake-triggered auto-dispatch driver factory +
// types — the missing producer that originates a `mission_context` handle on a live read-only run.
export {
  createFridayMissionAutoDispatchDriver,
} from "./mission-spine/friday-mission-auto-dispatch-driver.js";
export type {
  CreateFridayMissionAutoDispatchDriverOptions,
  FridayMissionAutoDispatchDriver,
  MissionAutoDispatchStartRun,
} from "./mission-spine/friday-mission-auto-dispatch-driver.js";
export {
  FRIDAY_D20_SIGNED_BATCH_WORKTREE_FLAG,
  createFridayD20SignedBatchWorktreeService,
} from "./mission-spine/friday-rust-hub-d20-signed-batch-worktree-service.js";
export type {
  FridayD20SignedBatchWorktreeInput,
  FridayD20SignedBatchWorktreeReceipt,
  FridayD20SignedBatchWorktreeService,
} from "./mission-spine/friday-rust-hub-d20-signed-batch-worktree-service.js";
export {
  FRIDAY_SYSTEM_INTENT_RUST_FLAG,
  createFridayRustHubSystemIntentService,
} from "./mission-spine/friday-rust-hub-system-intent-service.js";
export type {
  CreateFridayRustHubSystemIntentServiceOptions,
  FridayRustHubSystemIntentService,
} from "./mission-spine/friday-rust-hub-system-intent-service.js";
export { createFridayDeterministicPipelineRuntime } from "./runtime/friday-deterministic-pipeline-runtime.js";
export type { CreateFridayDeterministicPipelineRuntimeDeps } from "./runtime/friday-deterministic-pipeline-runtime.js";

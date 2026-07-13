import { createHash } from "node:crypto";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { FridayDomainError } from "#errors";
import { createFridayMemoryGuardServiceFactory, createFridayMemoryItemRepository } from "#memory";
import type { FridaySqliteLayer } from "#state";
import {
  createFridaySecretAdminService,
  createFridaySecretRepository,
  decryptSecretWithMigration,
  fridaySecretAadContext,
  getStrictMasterKey,
} from "#providers";
import type { FridayEncryptedEnvelope, FridayProviderTenantContext } from "#providers";
import {
  createFridaySessionMemoryExtractionService,
  createFridaySessionService,
  finalizeFridayConversationFocus,
  prepareFridayConversationTurn,
} from "#sessions";
import type { FridayConversationBlock, FridaySessionMessageRecord, FridaySessionRecord } from "#sessions";
import {
  createFridayStableWorkflowDraftBundle,
  createFridayWorkflowBuilderRuntime,
  createFridayWorkflowProductService,
  createFridayWorkflowRuntime,
  createFridayWorkflowTriggerRepository,
  listFridayStableWorkflowTemplates,
} from "#workflows";
import type {
  FridayWorkflowDraftEntity,
  FridayWorkflowEntity,
  FridayWorkflowEvidenceEvent,
  FridayWorkflowPlaybookEvidenceTrace,
  FridayWorkflowRetryEvidenceTrace,
  FridayWorkflowRunEntity,
  FridayWorkflowRunEvidenceExport,
  FridayWorkflowRunEvidenceExportRecord,
  FridayWorkflowRunEvidenceResponse,
  FridayWorkflowRunNodeEntity,
  FridayWorkflowSpecV1,
  FridayWorkflowVersionEntity,
  FridayWorkflowVisualGraphV1,
  JsonObject,
} from "#workflows";

import { classifyFridayExecution } from "../../sessions/services/friday-execution-classifier.js";
import { dispatchDeterministic } from "../../sessions/services/friday-deterministic-dispatch.js";
import type { FridayDeterministicDispatchDeps } from "../../sessions/services/friday-deterministic-dispatch.js";
import { dispatchManagedAsync } from "../../sessions/services/friday-managed-async-dispatch.js";
import type { FridayManagedAsyncDispatchDeps } from "../../sessions/services/friday-managed-async-dispatch.js";
import { parseFridayReflexExplicitPreferenceMessage } from "../../reflex/index.js";
import type {
  CreateFridayApiRuntimeDeps,
  FridayAgentRouteStartRun,
  FridayApiRuntime,
} from "./friday-api-runtime.types.js";
import { createFridayAuthService } from "../auth/friday-auth-service.js";
import { createFridayTokenValidator } from "../auth/friday-token-validator.js";
import { createFridayRateLimitService } from "../auth/friday-rate-limit-service.js";
import { createFridayAuthMiddlewareFactory } from "../auth/friday-auth-middleware.js";
import { createFridayAuthSessionRepository } from "../persistence/friday-auth-session-repository.js";
import { createFridayRealtimeEventBus } from "../realtime/friday-realtime-event-bus.js";
import { createFridayRealtimeEventRepository } from "../persistence/friday-realtime-event-repository.js";
import { createFridayRealtimeCheckpointRepository } from "../persistence/friday-realtime-checkpoint-repository.js";
import { createFridayRealtimeSubscriptionService } from "../realtime/friday-realtime-subscription-service.js";
import { redactEventPayload } from "../realtime/friday-event-payload-redactor.js";
import { createFridayRealtimeWsGateway } from "../realtime/friday-realtime-ws-gateway.js";
import { createFridayFleetDashboardService } from "../fleet/friday-fleet-dashboard-service.js";
import { createFridayWorkflowConflictService } from "../conflicts/friday-workflow-conflict-service.js";
import { createFridayHttpRouteRegistry } from "../http/friday-http-route-registry.js";
import { createFridayHttpRawTextResponse } from "../http/friday-http-raw-response.js";
import { createFridayAuthRoutes } from "../http/routes/friday-auth-routes.js";
import { createFridayRuntimeAdminRoutes } from "../http/routes/friday-runtime-admin-routes.js";
import { createFridayAutonomyRoutes } from "../http/routes/friday-autonomy-routes.js";
import { createFridaySecretRoutes } from "../http/routes/friday-secret-routes.js";
import { createFridayWorkflowRoutes } from "../http/routes/friday-workflow-routes.js";
import {
  createFridayWorkflowBuilderRoutes,
  createFridayWorkflowBuilderTemplateRoutes,
} from "../http/routes/friday-workflow-builder-routes.js";
import { createFridayWorkflowProductRoutes } from "../http/routes/friday-workflow-product-routes.js";
import { createFridayWorkflowRunRoutes } from "../http/routes/friday-workflow-run-routes.js";
import { createFridayWorkflowConflictRoutes } from "../http/routes/friday-workflow-conflict-routes.js";
import { createFridayFleetRoutes } from "../http/routes/friday-fleet-routes.js";
import { createFridaySecurityRoutes } from "../http/routes/friday-security-routes.js";
import { createFridayRealtimeRoutes } from "../http/routes/friday-realtime-routes.js";
import { createFridayProviderRoutes } from "../http/routes/friday-provider-routes.js";
import { createFridayProviderUsageRoutes } from "../http/routes/friday-provider-usage-routes.js";
import {
  createFridayMediaUnderstandingRoutes,
  type FridayMediaUnderstandingRoutesDeps,
} from "../http/routes/friday-media-understanding-routes.js";
import {
  createFridayTaskWorkflowRoutes,
  type FridayTaskWorkflowRoutesDeps,
} from "../http/routes/friday-task-workflow-routes.js";
import {
  createFridaySocialImportRoutes,
  type FridaySocialImportRoutesDeps,
} from "../http/routes/friday-social-import-routes.js";
import { createFridaySkillGeneratorRoutes } from "../http/routes/friday-skill-generator-routes.js";
import { createFridayDiagnosisRoutes } from "../http/routes/friday-diagnosis-routes.js";
import { createFridayAutoFixRoutes } from "../http/routes/friday-auto-fix-routes.js";
import { createFridayAgentLoopRoutes } from "../http/routes/friday-agent-loop-routes.js";
import { createFridaySkillConverterRoutes } from "../http/routes/friday-skill-converter-routes.js";
import { createFridayWorkflowGeneratorRoutes } from "../http/routes/friday-workflow-generator-routes.js";
import { createFridayDeterministicPipelineRoutes } from "../http/routes/friday-deterministic-pipeline-routes.js";
import { createFridayMemoryRoutes } from "../http/routes/friday-memory-routes.js";
import {
  readStoredIdempotencyPayloadHash,
  throwIdempotencyConflict,
} from "../http/routes/friday-route-idempotency.js";
import { createFridaySessionRoutes } from "../http/routes/friday-session-routes.js";
import { createFridaySessionUsageRoutes } from "../http/routes/friday-session-usage-routes.js";
import { createFridayPluginRoutes } from "../http/routes/friday-plugin-routes.js";
import { createFridayAgentRoutes } from "../http/routes/friday-agent-routes.js";
import { createFridaySubagentRoutes } from "../http/routes/friday-subagent-routes.js";
import { createFridaySetupRoutes } from "../http/routes/friday-setup-routes.js";
import { createFridaySkillRoutes } from "../http/routes/friday-skill-routes.js";
import { createFridayDesktopRoutes } from "../http/routes/friday-desktop-routes.js";
import { createFridayChannelRoutes } from "../http/routes/friday-channel-routes.js";
import { createFridayDeepLinkRoutes } from "../http/routes/friday-deeplink-routes.js";
import { createFridayGrantRoutes } from "../http/routes/friday-grant-routes.js";
import { createFridaySystemRoutes } from "../http/routes/friday-system-routes.js";
import { createFridayGuideLensRoutes } from "../http/routes/friday-guide-lens-routes.js";
import { createFridayUixRoutes } from "../http/routes/friday-uix-routes.js";
import {
  createFridayMissionSpineRoutes,
  type FridayMissionSpineRoutesDeps,
} from "../http/routes/friday-mission-spine-routes.js";
import {
  createFridayMemorySpineRoutes,
  type FridayMemorySpineRoutesDeps,
} from "../http/routes/friday-memory-spine-routes.js";
import {
  createFridayRunOutcomeLearningRoutes,
  type FridayRunOutcomeLearningRoutesDeps,
} from "../http/routes/friday-run-outcome-learning-routes.js";
import { createFridayCrossBorderPackRoutes } from "../http/routes/friday-cross-border-pack-routes.js";
import { createFridayAssetInventoryRoutes } from "../http/routes/friday-asset-inventory-routes.js";
import { createFridayStudioRoutes } from "../http/routes/friday-studio-routes.js";
import { createFridayDiscoveryDisabledRoutes, createFridayDiscoveryRoutes } from "../http/routes/friday-discovery-routes.js";
import { createFridayDiscoveryIntegrationRoutes } from "../http/routes/friday-discovery-integration-routes.js";
import { createFridayMcpServerRoutes } from "../http/routes/friday-mcp-server-routes.js";
import { createFridayMultiTenantSecurityRoutes } from "../http/routes/friday-multi-tenant-security-routes.js";
import { createFridayObservabilityRoutes } from "../http/routes/friday-observability-routes.js";
import { createFridaySatellitePairingRoutes } from "../http/routes/friday-satellite-pairing-routes.js";
import { createFridaySatelliteRuntimeRoutes } from "../http/routes/friday-satellite-runtime-routes.js";
import { createFridayChannelWebhookRoutes } from "../http/routes/friday-channel-webhook-routes.js";
import { createFridayPackagingRoutes } from "../http/routes/friday-packaging-routes.js";
import { createFridayCloudWorkerSetupRoutes } from "../http/routes/friday-cloud-worker-setup-routes.js";
import { createFridayCloudWorkerSetupService } from "#cloud-workers";
// execrun B1-compose (DARK): the composition repoints routeStartRun to the PROVEN sealed WS
// client (the real ECDH handshake) via its service adapter + a SecureStore X25519-SECRET resolver
// (the ECDH model — REPLACES #612's symmetric session-key resolver, which was the wrong shape).
import {
  createFridayRustHubAgentRunSealedClientService,
  isPausedDispatchOutcome,
} from "../mission-spine/friday-rust-hub-agent-run-sealed-client-service.js";
import type {
  FridayRustHubAgentRunSealedClientService,
  FridayRustHubAgentRunSealedClientServiceDispatchOutcome,
} from "../mission-spine/friday-rust-hub-agent-run-sealed-client-service.js";
import type {
  FridayOrganicRunProvenance,
  FridayRustHubAgentRunConstraints,
  FridayRustHubAgentRunMissionContext,
  FridayRustHubAgentRunResumeResult,
} from "../mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js";
import type { FridayResumeAgentRunResponse } from "../model/friday-api-agent.types.js";
import { createFridayRustHubRunContinuityProjectorService } from "../mission-spine/friday-rust-hub-run-continuity-projector-service.js";
import type { FridayRustHubRunContinuityProjectorService } from "../mission-spine/friday-rust-hub-run-continuity-projector-service.js";
import { createFridayRustHubRunAnswerReadbackService } from "../mission-spine/friday-rust-hub-run-answer-readback-service.js";
import type { FridayRustHubRunAnswerReadbackService } from "../mission-spine/friday-rust-hub-run-answer-readback-service.js";
import { createFridayRustHubProvidersDetectService } from "../mission-spine/friday-rust-hub-providers-detect-bridge-service.js";
import { createFridayRustHubCapabilityDoctorService } from "../mission-spine/friday-rust-hub-capability-doctor-bridge-service.js";
import { createFridayRustHubWorkflowCatalogBridgeService } from "../mission-spine/friday-rust-hub-workflow-catalog-bridge-service.js";
import { createFridayRustHubWorkflowRunBridgeService } from "../mission-spine/friday-rust-hub-workflow-run-bridge-service.js";
import { createFridayD20SignedBatchWorktreeService } from "../mission-spine/friday-rust-hub-d20-signed-batch-worktree-service.js";
import { resolveRustAgentRunWsClientX25519Secret } from "../mission-spine/friday-rust-hub-agent-run-ws-client-x25519-secret.js";
import type { FridayRustAgentRunWsClientX25519SecretResolver } from "../mission-spine/friday-rust-hub-agent-run-ws-client-x25519-secret.js";
import {
  RUST_ROUTE_CLAUDE_MODEL,
  RUST_ROUTE_CLAUDE_PROVIDER_ID,
  RUST_ROUTE_CODEX_MODEL,
  RUST_ROUTE_CODEX_PROVIDER_ID,
  RUST_ROUTE_DEEPSEEK_FLASH_MODEL,
  RUST_ROUTE_DEEPSEEK_PROVIDER_ID,
  RUST_ROUTE_READ_TOOL_ALLOWLIST,
} from "./friday-rust-route-constants.js";
export {
  RUST_ROUTE_CLAUDE_MODEL,
  RUST_ROUTE_CLAUDE_PROVIDER_ID,
  RUST_ROUTE_CODEX_MODEL,
  RUST_ROUTE_CODEX_PROVIDER_ID,
  RUST_ROUTE_DEEPSEEK_FLASH_MODEL,
  RUST_ROUTE_DEEPSEEK_PROVIDER_ID,
  RUST_ROUTE_READ_TOOL_ALLOWLIST,
} from "./friday-rust-route-constants.js";
import { createFridayStudioService } from "../../studio/index.js";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
  type FridayCanonicalApprovalResolution,
  type FridayMutatingActionActor,
  type FridayMutatingActionRequest,
  type FridayMutatingActionTicket,
  signFridayCanonicalApproval,
} from "../../security/friday-mutating-action-gate.js";
import {
  assertBoundPrincipalAuthorityForOperation,
  assertBoundPrincipalForOperation,
} from "../../security/friday-owner-session-channel-capability.js";
import {
  buildFridayAgentRunContextSummarySnapshot,
  buildFridayAgentRunHealthSnapshot,
  createFridayAgentAutomationRepository,
  createFridayAgentAutomationService,
  createFridayAgentPlanningGateService,
  createFridayAgentRunEventRepository,
  createFridayAgentRunRepository,
  createFridayCompactionContextReplaySink,
} from "#agent";
import type {
  FridayAgentAutomationService,
  FridayAgentExecutionContext,
  FridayAgentMessage,
  FridayAgentRunConstraints,
  FridayAgentRunRecord,
  FridayAgentRunStatus,
  FridayAgentRuntimeResult,
  FridayAgentTaskProfileInput,
} from "#agent";
import { buildFridayEvidenceBlocks } from "#agent";
import { createFridayOrchestrationEngine } from "#engine";
import { createFridayImmediateRunPersistence } from "#engine";
import type { FridayEngineRunResult } from "#engine";
import type { CreateFridayEngineTurnPreparerDeps } from "#engine";
import type { CreateFridayEngineRunExecutorDeps } from "#engine";
import { createFridayApiTokenRepository } from "../persistence/friday-api-token-repository.js";
import { createFridayProviderProfileRepository } from "#providers";
import { createFridaySkillRepository, type FridaySkillLifecycleDetail } from "#skills";
import { createFridayPluginRepository, type FridayPluginEntity } from "#plugins";
import { createFridayWorkflowRepository } from "#workflows";
import { createFridayAutonomySubjectInventoryService } from "../../autonomy/services/friday-autonomy-subject-inventory-service.js";
import { createFridayAutonomyImpactCensusService } from "../../autonomy/services/friday-autonomy-impact-census-service.js";
import { createFridayAutonomyUpgradePlannerService } from "../../autonomy/services/friday-autonomy-upgrade-planner-service.js";
import { createFridayAutonomyUpgradeStatusService } from "../../autonomy/services/friday-autonomy-upgrade-status-service.js";
import { createFridayWorkflowUpgradeLifecycleService } from "../../autonomy/services/friday-workflow-upgrade-lifecycle-service.js";
import { createFridaySkillUpgradeLifecycleService } from "../../autonomy/services/friday-skill-upgrade-lifecycle-service.js";
import { createFridaySkillUpgradeAnalysisService } from "../../skills/services/friday-skill-upgrade-analysis-service.js";
import { createFridayProviderProfileUpgradeLifecycleService } from "../../autonomy/services/friday-provider-profile-upgrade-lifecycle-service.js";
import {
  createFridayPluginLifecycleMutatingActionRequest,
  createFridayPluginUpgradeLifecycleService,
  type FridayPluginLifecycleApprovalRequestInput,
} from "../../autonomy/services/friday-plugin-upgrade-lifecycle-service.js";
import { createFridayAutonomySubjectUpgradeStateRepository } from "../../autonomy/persistence/friday-autonomy-subject-upgrade-state-repository.js";
import { createFridayMcpServerUpgradeLifecycleService } from "../../autonomy/services/friday-mcp-server-upgrade-lifecycle-service.js";
import { createFridayChannelAdapterUpgradeLifecycleService } from "../../autonomy/services/friday-channel-adapter-upgrade-lifecycle-service.js";
import {
  createFridayAutonomyPolicyService,
  createFridayCapabilityAcquisitionService,
  createFridayStandingAgendaService,
} from "../../autonomy/index.js";
import type { FridayAuthPrincipal } from "../model/friday-api-common.types.js";
import type { FridayRole } from "../model/friday-api-auth.types.js";
import type {
  FridayGetRunEvidenceQuery,
  FridayRunTimelineEntry,
  FridayWorkflowOverview,
  FridayWorkflowVisualization,
} from "../model/friday-api-workflow.types.js";
import { createFridayDeepLinkApplyService } from "./friday-deep-link-apply-service.js";
import { installFridayApiRuntimeBaseRoutes } from "./friday-api-runtime-base-routes.js";

const DEFAULT_ACCESS_TTL = 3600; // 1 hour
const DEFAULT_REFRESH_TTL = 604_800; // 7 days
const CURRENT_EPOCH = 1;
const SESSION_CONTEXT_HISTORY_LIMIT = 24;
const WORKFLOW_WEBHOOK_SECRET_SCOPES = ["workflow-webhook", "workflow"] as const;

function summarizePublicJsonShape(value: unknown): JsonObject {
  if (value === null || value === undefined) {
    return { kind: "empty" };
  }
  if (Array.isArray(value)) {
    return { kind: "array", itemCount: value.length };
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return {
      kind: "object",
      keyCount: keys.length,
      keys: keys.slice(0, 20),
      truncated: keys.length > 20,
    };
  }
  return { kind: typeof value };
}

function sanitizePublicWorkflowRun(run: FridayWorkflowRunEntity): FridayWorkflowRunEntity {
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowVersionId: run.workflowVersionId,
    status: run.status,
    triggerType: run.triggerType,
    startedAt: run.startedAt,
    deadlineAt: run.deadlineAt,
    pausedAt: run.pausedAt,
    resumedAt: run.resumedAt,
    finishedAt: run.finishedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    proofRequired: run.proofRequired,
    evidenceStatus: run.evidenceStatus,
    completionVerification: run.completionVerification,
    failure: run.failure
      ? {
        code: run.failure.code,
        message: "redacted",
      }
      : undefined,
  };
}

function sanitizePublicWorkflowRunNode(node: FridayWorkflowRunNodeEntity): FridayWorkflowRunNodeEntity {
  return {
    id: node.id,
    runId: node.runId,
    nodeId: node.nodeId,
    attempt: node.attempt,
    attemptId: node.attemptId,
    status: node.status,
    startedAt: node.startedAt,
    finishedAt: node.finishedAt,
    error: node.error
      ? {
        code: node.error.code,
        message: "redacted",
        retryable: node.error.retryable,
      }
      : undefined,
    idempotencyKey: "redacted",
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

function sanitizePublicWorkflowEvidenceEvent(event: FridayWorkflowEvidenceEvent): FridayWorkflowEvidenceEvent {
  return {
    eventId: event.eventId,
    event: event.event,
    module: event.module,
    emittedAt: event.emittedAt,
    redacted: true,
    correlation: {
      runId: event.correlation.runId,
      workflowId: event.correlation.workflowId,
      nodeId: event.correlation.nodeId,
      attempt: event.correlation.attempt,
    },
    payload: {
      redacted: true,
      shape: summarizePublicJsonShape(event.payload),
    },
  };
}

function sanitizePublicWorkflowRetryTrace(
  trace: FridayWorkflowRetryEvidenceTrace,
): FridayWorkflowRetryEvidenceTrace {
  return {
    ...trace,
    errorMessage: trace.errorMessage ? "redacted" : undefined,
    decision: {
      shouldRetry: trace.decision.shouldRetry,
      delayMs: trace.decision.delayMs,
      reason: trace.decision.reason,
      maxAttempts: trace.decision.maxAttempts,
      budgetExhausted: trace.decision.budgetExhausted,
      circuitOpen: trace.decision.circuitOpen,
      escalateToDlq: trace.decision.escalateToDlq,
    },
  };
}

function sanitizePublicWorkflowPlaybookTrace(
  trace: FridayWorkflowPlaybookEvidenceTrace,
): FridayWorkflowPlaybookEvidenceTrace {
  return {
    runId: trace.runId,
    workflowId: trace.workflowId,
    phase: trace.phase,
    timestamp: trace.timestamp,
    intake: trace.intake
      ? {
        decision: trace.intake.decision,
        playbookId: trace.intake.playbookId ? "redacted" : null,
        versionNumber: trace.intake.versionNumber,
        matchScore: trace.intake.matchScore,
        evaluatedAt: trace.intake.evaluatedAt,
      }
      : undefined,
    feedback: trace.feedback
      ? {
        candidateId: trace.feedback.candidateId ? "redacted" : null,
        promotedPlaybookId: trace.feedback.promotedPlaybookId ? "redacted" : null,
        promotionDecision: trace.feedback.promotionDecision,
        scoreRecalculated: trace.feedback.scoreRecalculated,
        recordedAt: trace.feedback.recordedAt,
      }
      : undefined,
  };
}

function sanitizePublicWorkflowEvidence(
  evidence: FridayWorkflowRunEvidenceResponse,
): FridayWorkflowRunEvidenceResponse {
  return {
    ...evidence,
    run: evidence.run ? sanitizePublicWorkflowRun(evidence.run) : null,
    events: evidence.events.map(sanitizePublicWorkflowEvidenceEvent),
    playbook: {
      traces: evidence.playbook.traces.map(sanitizePublicWorkflowPlaybookTrace),
    },
    acceptance: {
      events: evidence.acceptance.events.map(sanitizePublicWorkflowEvidenceEvent),
    },
    retry: {
      events: evidence.retry.events.map(sanitizePublicWorkflowEvidenceEvent),
      traces: evidence.retry.traces.map(sanitizePublicWorkflowRetryTrace),
    },
  };
}

function sanitizePublicWorkflowEvidenceExport(
  evidenceExport: FridayWorkflowRunEvidenceExport,
): FridayWorkflowRunEvidenceExport {
  return {
    ...evidenceExport,
    artifactId: "redacted",
    uri: `friday://workflow-runs/${evidenceExport.runId}/evidence-exports/${evidenceExport.exportId}.json`,
    filePersisted: false,
  };
}

function sanitizePublicWorkflowEvidenceExportRecord(
  record: FridayWorkflowRunEvidenceExportRecord,
): FridayWorkflowRunEvidenceExportRecord {
  return {
    export: sanitizePublicWorkflowEvidenceExport(record.export),
    evidence: sanitizePublicWorkflowEvidence(record.evidence),
  };
}

// ─── Workflow catalog/builder compatibility read projections ───
//
// These bounded redacted projections back the `compat_shim` classification for
// the workflow catalog/builder read surfaces (`workflows.list`, `workflows.get`,
// `workflows.list.versions`, `workflow.versions.get`, `workflows.overview`,
// `workflows.visualization`). They are not authoritative: the authoritative
// workflow graph/version/draft truth must move to a Rust-owned entrypoint. Each
// projection drops private user ids, provider/runtime model fields, and raw
// graph/spec config (which can carry commands or secrets), so the compatibility
// read cannot leak `requiredLeakControls` data.

function sanitizePublicWorkflowEntity(workflow: FridayWorkflowEntity): FridayWorkflowEntity {
  return {
    id: workflow.id,
    slug: workflow.slug,
    name: workflow.name,
    description: workflow.description,
    tags: workflow.tags,
    latestVersionNumber: workflow.latestVersionNumber,
    publishedVersionNumber: workflow.publishedVersionNumber,
    isArchived: workflow.isArchived,
    revision: workflow.revision,
    etag: workflow.etag,
    lastVerifiedAt: workflow.lastVerifiedAt,
    compatibilityStatus: workflow.compatibilityStatus,
    promotionChannel: workflow.promotionChannel,
    canaryStats: workflow.canaryStats,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    deletedAt: workflow.deletedAt,
  };
}

function sanitizePublicWorkflowVersion(version: FridayWorkflowVersionEntity): FridayWorkflowVersionEntity {
  return {
    id: version.id,
    workflowId: version.workflowId,
    versionNumber: version.versionNumber,
    checksum: version.checksum,
    graphJson: {
      redacted: true,
      shape: summarizePublicJsonShape(version.graphJson),
    },
    isPublished: version.isPublished,
    changeNote: version.changeNote,
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
  };
}

function sanitizePublicWorkflowSpec(spec: FridayWorkflowSpecV1): FridayWorkflowSpecV1 {
  return {
    schemaVersion: spec.schemaVersion,
    workflowId: spec.workflowId,
    name: spec.name,
    description: spec.description,
    startStepId: spec.startStepId,
    trigger: spec.trigger,
    inputs: spec.inputs.map((input) => ({
      key: input.key,
      type: input.type,
      required: input.required,
    })),
    steps: spec.steps.map((step) => ({
      id: step.id,
      type: step.type,
      ref: step.ref,
      condition: step.condition,
      timeoutSec: step.timeoutSec,
      retry: step.retry,
    })),
    edges: spec.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      when: edge.when,
    })),
    outputs: spec.outputs.map((output) => ({
      key: output.key,
      fromStep: output.fromStep,
      path: output.path,
    })),
    errorPolicy: spec.errorPolicy,
    tests: [],
  };
}

function defaultDraftVisual(
  workflowId: string,
  spec: unknown,
): FridayWorkflowVisualGraphV1 {
  const maybeSpec = spec && typeof spec === "object" ? spec as Record<string, unknown> : {};
  const rawStepIds = Array.isArray(maybeSpec.steps)
    ? maybeSpec.steps.map((step) => (
      step && typeof step === "object" && typeof (step as { id?: unknown }).id === "string"
        ? (step as { id: string }).id
        : undefined
    ))
    : Array.isArray(maybeSpec.nodes)
      ? maybeSpec.nodes.map((node) => (
        node && typeof node === "object" && typeof (node as { id?: unknown }).id === "string"
          ? (node as { id: string }).id
          : undefined
      ))
      : [];
  const stepIds = rawStepIds.filter((id): id is string => Boolean(id));
  const nodeIds = stepIds.length > 0 ? stepIds : ["__trigger__"];

  return {
    schemaVersion: "1.0",
    workflowId,
    viewport: { x: 0, y: 0, zoom: 1 },
    panelLayout: { leftOpen: true, rightOpen: false, bottomOpen: false },
    nodes: nodeIds.map((nodeId, index) => ({
      nodeId,
      x: index * 250,
      y: 0,
    })),
    edges: [],
  };
}

function draftVisualOrDefault(
  workflowId: string,
  spec: unknown,
  visual: FridayWorkflowVisualGraphV1 | undefined,
): FridayWorkflowVisualGraphV1 {
  return visual ?? defaultDraftVisual(workflowId, spec);
}

function sanitizePublicWorkflowDraft(draft: FridayWorkflowDraftEntity): FridayWorkflowDraftEntity {
  return {
    draftId: draft.draftId,
    workflowId: draft.workflowId,
    title: draft.title,
    status: draft.status,
    revision: draft.revision,
    baseWorkflowVersionId: draft.baseWorkflowVersionId,
    spec: sanitizePublicWorkflowSpec(draft.spec),
    visual: draft.visual,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    publishedVersionId: draft.publishedVersionId,
    autosave: draft.autosave,
    sourceReview: draft.sourceReview
      ? {
        source: draft.sourceReview.source,
        importedAt: draft.sourceReview.importedAt,
        requiresReviewBeforePublish: draft.sourceReview.requiresReviewBeforePublish,
      }
      : undefined,
  };
}

function sanitizePublicWorkflowNodeTimeline(
  timeline: FridayWorkflowOverview["latestRunNodeTimeline"],
): FridayWorkflowOverview["latestRunNodeTimeline"] {
  return timeline.map((entry) => ({
    nodeId: entry.nodeId,
    attempt: entry.attempt,
    status: entry.status,
    finishedAt: entry.finishedAt,
    message: entry.message !== undefined ? "redacted" : undefined,
  }));
}

function sanitizePublicWorkflowOverview(overview: FridayWorkflowOverview): FridayWorkflowOverview {
  return {
    workflow: sanitizePublicWorkflowEntity(overview.workflow),
    latestVersion: overview.latestVersion
      ? sanitizePublicWorkflowVersion(overview.latestVersion)
      : undefined,
    publishedVersion: overview.publishedVersion
      ? sanitizePublicWorkflowVersion(overview.publishedVersion)
      : undefined,
    drafts: overview.drafts.map(sanitizePublicWorkflowDraft),
    latestDraft: overview.latestDraft
      ? sanitizePublicWorkflowDraft(overview.latestDraft)
      : undefined,
    recentRuns: overview.recentRuns.map(sanitizePublicWorkflowRun),
    latestRun: overview.latestRun ? sanitizePublicWorkflowRun(overview.latestRun) : undefined,
    latestRunNodeTimeline: sanitizePublicWorkflowNodeTimeline(overview.latestRunNodeTimeline),
    latestEvidenceExports: overview.latestEvidenceExports.map(sanitizePublicWorkflowEvidenceExport),
    versionHistory: overview.versionHistory.map(sanitizePublicWorkflowVersion),
  };
}

function sanitizePublicWorkflowVisualization(
  visualization: FridayWorkflowVisualization,
): FridayWorkflowVisualization {
  return {
    workflow: sanitizePublicWorkflowEntity(visualization.workflow),
    targetKind: visualization.targetKind,
    draft: visualization.draft ? sanitizePublicWorkflowDraft(visualization.draft) : undefined,
    version: visualization.version
      ? sanitizePublicWorkflowVersion(visualization.version)
      : undefined,
    spec: sanitizePublicWorkflowSpec(visualization.spec),
    visual: visualization.visual,
    latestRun: visualization.latestRun
      ? sanitizePublicWorkflowRun(visualization.latestRun)
      : undefined,
    recentRuns: visualization.recentRuns.map(sanitizePublicWorkflowRun),
    nodeTimeline: sanitizePublicWorkflowNodeTimeline(visualization.nodeTimeline),
    latestEvidenceExports: visualization.latestEvidenceExports.map(
      sanitizePublicWorkflowEvidenceExport,
    ),
  };
}

function createFridayPluginReviewEnablePlanDigest(input: {
  plugin: FridayPluginEntity;
  runtimeVersion: string;
  providerModel?: string;
}): string {
  return createHash("sha256").update(stableStringify({
    schemaVersion: "friday.plugin.review_enable.phase3.2D.v1",
    pluginId: input.plugin.id,
    version: input.plugin.version,
    installPath: input.plugin.installPath,
    manifest: input.plugin.manifest,
    signatureVerified: input.plugin.signatureVerified,
    trustedFingerprintSha256: input.plugin.trustedFingerprintSha256,
    runtimeVersion: input.runtimeVersion,
    providerModel: input.providerModel,
  })).digest("hex");
}

function createFridayPluginReviewEnableShadowVersionId(input: {
  plugin: FridayPluginEntity;
  planDigest: string;
}): string {
  return `${input.plugin.id}@${input.plugin.version}-${input.planDigest.slice(0, 12)}`;
}

function createFridayPluginReviewEnableParentRequest(input: {
  plugin: FridayPluginEntity;
  runtimeVersion: string;
  providerModel?: string;
  actor: FridayMutatingActionActor;
  surface: string;
  planDigest: string;
  shadowVersionId: string;
  idempotencyKey?: string;
}): FridayMutatingActionRequest {
  return {
    action: "plugins.lifecycle.review_enable",
    actor: input.actor,
    surface: input.surface,
    resource: {
      type: "external_plugin_lifecycle",
      id: input.plugin.id,
      digest: input.planDigest,
      attributes: {
        pluginId: input.plugin.id,
        version: input.plugin.version,
        shadowVersionId: input.shadowVersionId,
      },
    },
    mutating: true,
    risk: "high",
    parameters: {
      pluginId: input.plugin.id,
      version: input.plugin.version,
      runtimeVersion: input.runtimeVersion,
      providerModel: input.providerModel,
      shadowVersionId: input.shadowVersionId,
      childActions: ["plugins.lifecycle.shadow", "plugins.lifecycle.canary", "plugins.lifecycle.promote"],
    },
    planDigest: input.planDigest,
    idempotencyKey: input.idempotencyKey,
    localClaims: [
      {
        guardId: "plugin_review_enable_lifecycle_guard",
        decision: "requires_approval",
        risk: "high",
        reason: "plugin_review_enable_requires_canonical_lifecycle_approval",
        evidence: {
          pluginId: input.plugin.id,
          version: input.plugin.version,
          shadowVersionId: input.shadowVersionId,
        },
      },
    ],
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function readStringListQuery(
  value: unknown,
): string[] | undefined {
  if (typeof value === "string") {
    const parts = value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    return parts.length > 0 ? parts : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .filter((item): item is string => typeof item === "string")
      .flatMap((item) =>
        item
          .split(",")
          .map((part) => part.trim()),
      )
      .filter((part) => part.length > 0);
    return parts.length > 0 ? parts : undefined;
  }
  return undefined;
}

function readPositiveIntQuery(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function parseRunEvidenceQuery(source: Record<string, unknown>): FridayGetRunEvidenceQuery {
  const modules = readStringListQuery(source.modules);
  const eventNames = readStringListQuery(source.eventNames);
  const nodeIdRaw = source.nodeId;
  const nodeId = typeof nodeIdRaw === "string" && nodeIdRaw.trim().length > 0
    ? nodeIdRaw
    : undefined;
  return {
    modules: modules as FridayGetRunEvidenceQuery["modules"],
    eventNames,
    nodeId,
    attempt: readPositiveIntQuery(source.attempt),
    limit: readPositiveIntQuery(source.limit),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function resolveWorkflowRealtimeStreamId(
  event: string,
  payload: Record<string, unknown>,
): string | null {
  if (!event.startsWith("workflow.")) {
    return null;
  }

  const runId = asString(payload.runId);
  if (runId) {
    return `run:${runId}`;
  }

  const workflowId = asString(payload.workflowId);
  if (workflowId) {
    return `workflow:${workflowId}`;
  }

  return null;
}

function isPrivilegedRunEvidencePrincipal(principal: FridayAuthPrincipal | null): boolean {
  if (!principal) {
    return false;
  }
  if (principal.scopes.includes("hub.admin")) {
    return true;
  }
  return principal.role === "owner" || principal.role === "admin";
}

function canRevokeCapabilityGrant(
  principal: FridayAuthPrincipal,
  grantPrincipalId: string,
): boolean {
  const scopes = principal.scopes ?? [];
  if (scopes.includes("hub.admin") || scopes.includes("security.write")) {
    return true;
  }
  if (principal.role === "owner" || principal.role === "admin") {
    return true;
  }
  return principal.principalId === grantPrincipalId || principal.userId === grantPrincipalId;
}

function resolvePrincipalTenantId(principal: FridayAuthPrincipal | null): string | null {
  if (!principal) {
    return null;
  }
  if (typeof principal.tenantId === "string" && principal.tenantId.trim().length > 0) {
    return principal.tenantId.trim();
  }
  return principal.principalId;
}

function createWorkflowWebhookSecretResolver(
  db: FridaySqliteLayer,
): (refKey: string) => string | null {
  const secretRepo = createFridaySecretRepository();
  return (refKey) => {
    try {
      for (const scope of WORKFLOW_WEBHOOK_SECRET_SCOPES) {
        const entity = db.withReadConnection((conn) =>
          secretRepo.getByRef(conn, scope, refKey),
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
            db.withWriteTransaction((conn) => {
              secretRepo.updateById(conn, {
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
      console.warn("[friday][workflow-webhook] secret resolution failed:", error instanceof Error ? error.message : String(error));
      return null;
    }
  };
}

function resolveRunTenantContext(input: {
  tenantContext?: FridayProviderTenantContext;
  session?: {
    accountId?: string;
    channel?: string;
    userId?: string | null;
  } | null;
  principalId?: string;
  constraints?: FridayAgentRunConstraints;
}): FridayProviderTenantContext | undefined {
  if (isPublicIsolatedRunConstraints(input.constraints)) {
    return undefined;
  }

  const explicitHubId = input.tenantContext?.hubId?.trim();
  const sessionHubId = input.session?.accountId?.trim();
  const hubId = explicitHubId && explicitHubId.length > 0
    ? explicitHubId
    : sessionHubId && sessionHubId.length > 0
      ? sessionHubId
      : undefined;
  if (!hubId) {
    return undefined;
  }

  const sessionUserId = input.session?.userId?.trim() ?? undefined;
  const explicitUserId = input.tenantContext?.userId?.trim();
  const principalId = input.principalId?.trim();
  const explicitChannelKind = input.tenantContext?.channelKind?.trim();
  const sessionChannelKind = input.session?.channel?.trim();

  return {
    hubId,
    ...(explicitChannelKind || sessionChannelKind
      ? { channelKind: explicitChannelKind ?? sessionChannelKind }
      : {}),
    ...(sessionUserId || explicitUserId || principalId
      ? { userId: sessionUserId ?? explicitUserId ?? principalId }
      : {}),
  };
}

function isPublicIsolatedRunConstraints(
  constraints: FridayAgentRunConstraints | undefined,
): boolean {
  return constraints?.readOnly === true
    && constraints.operationalMode === "restricted"
    && constraints.dataSensitivity === "public";
}

function assertTenantScopedAccess(
  principal: FridayAuthPrincipal | null,
  tenantId: string,
): void {
  if (isPrivilegedRunEvidencePrincipal(principal)) {
    return;
  }
  if (!principal) {
    throw new FridayDomainError("UNAUTHORIZED", "Authentication required", { httpStatus: 401 });
  }
  if (principal.principalType === "satellite") {
    throw new FridayDomainError("FORBIDDEN", "Satellite principal cannot access tenant-scoped security routes", {
      httpStatus: 403,
    });
  }
  if (resolvePrincipalTenantId(principal) !== tenantId) {
    throw new FridayDomainError("FORBIDDEN", "Tenant access denied", { httpStatus: 403 });
  }
}

function resolveTenantIdFromContext(ctx: {
  params?: unknown;
  query?: unknown;
  body?: unknown;
}): string | undefined {
  const params = asRecord(ctx.params);
  const query = asRecord(ctx.query);
  const body = asRecord(ctx.body);
  return (
    asString(params.tenantId)
    ?? asString(query.tenantId)
    ?? asString(body.tenantId)
    ?? asString(query.buyerTenantId)
    ?? asString(body.buyerTenantId)
  );
}

const API_RUNTIME_CANONICAL_GATE_TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const API_RUNTIME_CANONICAL_GATE_FALSE_VALUES = new Set(["0", "false", "no", "off", "disabled"]);

export function resolveApiRuntimeCanonicalGateRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env.FRIDAY_CANONICAL_GATE?.trim().toLowerCase();
  const protectedProfile = env.NODE_ENV?.trim().toLowerCase() === "production"
    || Boolean(env.FRIDAY_RELEASE_TAG?.trim());
  if (explicit) {
    if (API_RUNTIME_CANONICAL_GATE_TRUE_VALUES.has(explicit)) {
      return true;
    }
    if (API_RUNTIME_CANONICAL_GATE_FALSE_VALUES.has(explicit)) {
      if (protectedProfile) {
        throw new Error(
          "[friday] FRIDAY_CANONICAL_GATE cannot be disabled in production/release profiles. " +
            "Use a development or test profile for mock lanes.",
        );
      }
      return false;
    }
    throw new Error(
      `[friday] Invalid FRIDAY_CANONICAL_GATE value "${env.FRIDAY_CANONICAL_GATE}". Use true or false.`,
    );
  }
  return protectedProfile;
}

// ─── execrun-replacement slice 4: per-run Rust-route qualifying predicate (DARK) ───
//
// This predicate decides whether ONE production agent-run qualifies for the future
// Rust read-only loop. It is DARK substrate: nobody consumes its boolean yet (the
// later "composition" slice wires the actual routing). With the per-run flag off OR
// the predicate disqualified, behavior is byte-identical to today — the startRun route
// falls through to the existing `allowTestOnlyAgentRunStartExecution !== true` 503 stub.
//
// Invariants (so dark == byte-identical):
//   * TOTAL: never throws (any uncertainty / missing field → returns false).
//   * Side-effect-free: computes a bool, reads nothing external, writes nothing.
//   * The route-via-Rust flag is checked FIRST and short-circuits; if the flag is not
//     exactly `true` the predicate is not even evaluated by the route wrapper.
//   * Every clause is a strict `=== true` / exact-string comparison; nothing truthy.
//
// The exact qualifying set (matches the coordinator's pre-authorized predicate):
//   1. Route-not-method: admitted ONLY from the single startRun HTTP route. Enforced
//      structurally (the predicate is computed only inside the route-bound startRun
//      wrapper, never the automation-service copy or the executeRun callers) AND by an
//      explicit internal marker `invokedFromHttpStartRunRoute === true` that ONLY the
//      route wrapper passes. The 7 non-route callers (heartbeat/cron/channel-entry/
//      autonomous/planning-gate/subagent/sessions-tool) reach executeRun directly, not
//      this route, and never set the marker → never admitted. This avoids the historical
//      route-only-retirement trap of pinning at the method chokepoint.
//   2. constraints.readOnly === true (hard-blocks every mutating tool at the runtime).
//   3. Provider/model must match one of the admitted Rust route shapes:
//      (a) DeepSeek flash via EITHER real provider shape — providerId === "deepseek" (the literal
//          id the test/RGG envs seed), OR the requested providerId RESOLVES to an enabled provider
//          record whose kind === "deepseek" (production rows carry UUID ids, e.g.
//          kind="deepseek", id="fa15f1fe-…"; the route wrapper populates `resolvedProvider` from
//          ONE cheap providerService.getProvider read). Fail-closed: unresolvable / disabled /
//          non-deepseek kind → DISQUALIFIED. Requested model must be exactly
//          "deepseek-v4-flash"; deepseek-pro / chat / reasoner / a missing model stay
//          disqualified.
//      (b) Mission-bound Codex observe route: exact Codex sentinel provider/model plus a valid
//          3-field missionContext and non-empty authenticated principal.
//      (c) Mission-bound Claude route: exact Claude sentinel provider/model plus the same
//          missionContext + principal gates. Ordinary Codex/Claude requests remain disqualified.
//      If a taskProfile model override is present it must match the admitted model for that route.
//   4. The 4 READ tools ONLY: the run must positively grant exactly the Rust read-tool
//      set {read_file, list_dir, stat_file, search} via `allowedRustRouteTools`. Any other
//      tool (run_command / write_file / edit_file / append_file / delete_file / move_file /
//      …) or a missing grant → disqualified. The grant carries the Rust-loop tool names
//      because it gates what the Rust read-only loop may expose (the composition slice
//      wires the HTTP-body parse that populates it; today the route never sets it → the
//      run is disqualified → today's 503).
//   5. No subagents, no plan-review, no session-mirror dependency, no Pause-able
//      (mutating/approval) action:
//        * plan-review: requireReview === true OR planReviewOverride present OR
//          skipPlanningReview / resumeExistingRun truthy → disqualified.
//        * session-mirror: a non-empty input.sessionKey is admitted only with a non-empty
//          owner principal; blank/anonymous sessioned runs are disqualified.
//        * subagents: no startRun-input field represents them — a subagent child reaches
//          executeRun, not this HTTP route (covered by the route marker), and the
//          allow-list excludes spawn_subagent. Stated explicitly; bound structurally.
//        * Pause-able / mutating-approval actions: structurally precluded by readOnly
//          (clause 2 hard-blocks mutating tool calls) + the reads-only allow-list
//          (clause 4). No separate field.
//
// NOTE: RUST_ROUTE_READ_TOOL_ALLOWLIST / RUST_ROUTE_DEEPSEEK_* are imported + re-exported from
// `friday-rust-route-constants.ts` so lean producers such as the mission auto-dispatch driver can
// use the exact same route shape without importing this full runtime module.

// (honest-non-finished) The well-known SHA-256 of the EMPTY byte string. A non-Finished terminal
// run produced NO answer body, but the continuity-projector receipt requires a `finalMessageSha256`
// string — we stamp this empty-body sentinel (with `finalMessageLen: 0`) so the body REF is
// truthfully "zero bytes", NEVER an answer fingerprint. Refs-only — this is not a body.
const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // pragma: allowlist secret

// (honest-non-finished) The CLOSED allow-list of dispatch loop-status labels that mark a
// NON-deliverable terminal run (the run ended without an answer to persist). The wire COLLAPSES
// Blocked/Errored/Bounded/no-answer into ONE label: `AuthedAnswer::NoAnswer`'s refs carry no
// `status` key, so the agent-run server falls back to the `outcome` → compose actually sees
// `"no_answer_safe_failure"` for ALL non-Finished/no-body terminals (the raw loop-status tokens are
// admitted too, for a server that surfaces them directly). EVERY OTHER status — notably `"finished"`
// (a finished run SHOULD have a row) and any error status (`storage_failed`/`auth_failed`/
// `operator_vk_unprovisioned`) — is NOT here, so it keeps today's fail-closed 503 (no gate-weakening).
const RUST_ROUTE_NON_FINISHED_TERMINAL_STATUSES = new Set<string>([
  "no_answer_safe_failure",
  "no_answer",
  "blocked",
  "bounded",
  "errored",
]);

// (honest-non-finished) Map a NON-Finished terminal wire status to the projector's `loopStatus`
// token. The opaque collapsed labels (`no_answer_safe_failure`/`no_answer` — the only values the
// LIVE wire emits, since `AuthedAnswer::NoAnswer` carries no status key) cannot recover which
// non-Finished kind they were, so they map to "Errored". A raw loop-status token a server MIGHT
// surface directly keeps its FAITHFUL capitalized form. ALL of these map to the SAME terminal
// "failed" run status downstream (mapLoopStatusToTsStatus) — the distinction is metadata fidelity
// only, never a different product-visible outcome, and is NEVER the resumable "Paused"/"cancelled".
const RUST_ROUTE_NON_FINISHED_LOOP_STATUS: Record<string, string> = {
  blocked: "Blocked",
  bounded: "Bounded",
  errored: "Errored",
};

// (A2b Phase 2, mutation-relax — DARK, default-off) The CLOSED, NAMED allow-list of mutating
// Rust tools a gated chat run may carry. Clause 4's admitted tool set is the read set
// (RUST_ROUTE_READ_TOOL_ALLOWLIST) UNION an EXPLICITLY-GRANTED subset of THIS list — only
// tools named here may ever be granted, and only when the grant is explicit. The runtime
// Rust gate remains the real enforcer: every one of these Pauses pending an operator-signed
// Ed25519 approval (the qualifier admits CANDIDACY, never EXECUTION). Mirrors the exact 6
// mutating tools the Rust loop Pause-tests assert (write_file/append_file/edit_file/
// delete_file/move_file/run_command, lib.rs:4614+).
export const RUST_ROUTE_MUTATING_TOOL_ALLOWLIST = [
  "write_file",
  "append_file",
  "edit_file",
  "delete_file",
  "move_file",
  "run_command",
] as const;

// (A2b Phase 2, mutation-relax — DARK, default-off) The REQUIRED explicit opt-in marker on
// a mutating run: a run with `readOnly:false` is admitted ONLY when it ALSO carries
// `mutationGate === "operator_signed_ed25519"`. This makes "mutating" structurally
// inseparable from "operator-gated" at the admission boundary — there is NO admission for
// "mutating + no gate-marker". The value names the ONLY mutation-gating scheme the Rust
// spine implements (single-use Ed25519 over the canonical action digest); it is never
// inferred from `readOnly` flipping.
const RUST_ROUTE_MUTATION_GATE_MARKER = "operator_signed_ed25519";

export interface RustRouteQualificationInput {
  /**
   * Internal route marker. ONLY the createFridayAgentRoutes-bound startRun wrapper sets
   * this to `true`; the automation-service startRun copy and every executeRun caller
   * leave it unset. This is the route-not-method pin (NOT derived from the body-controlled
   * executionContext.surface).
   */
  invokedFromHttpStartRunRoute?: boolean;
  providerId?: string;
  /**
   * Resolved provider RECORD identity for `providerId` (execrun prod-provider-shape fix).
   * Production provider rows carry UUID ids with kind="deepseek"; only test/RGG envs seed
   * the literal id "deepseek". The route wrapper populates this from ONE cheap
   * `providerService.getProvider` read-by-id, ONLY when the literal id doesn't already
   * match. Fail-closed: absent (unresolvable / lookup threw) OR `enabled !== true` OR
   * `kind !== "deepseek"` → clause 3 disqualifies (falls to today's TS path; never throws).
   */
  resolvedProvider?: {
    kind?: string;
    enabled?: boolean;
  };
  model?: string;
  missionContext?: FridayRustHubAgentRunMissionContext;
  sessionKey?: string;
  /**
   * (A2a Phase 1) The OWNER principal for the run. Used ONLY by the relaxed clause-5 session
   * sub-clause: a sessioned run (`sessionKey` non-empty) is admitted ONLY with a non-empty
   * `principalId` (the bound owner the Rust server scopes the session history + body to). A
   * blank/whitespace/absent principal disqualifies a SESSIONED run (fail-closed). It has NO
   * effect on a sessionless run (that path is unchanged). The route wrapper populates this
   * from the SAME normalized `principalId` it already threads to compose/idempotency.
   */
  principalId?: string;
  requireReview?: boolean;
  constraints?: FridayAgentRunConstraints;
  taskProfile?: FridayAgentTaskProfileInput;
  /**
   * Positive per-run grant of the Rust read-tool set. The composition slice wires the
   * HTTP-body parse that populates this; today the startRun route never sets it.
   */
  allowedRustRouteTools?: string[];
  skipPlanningReview?: boolean;
  resumeExistingRun?: boolean;
  /**
   * Plan-review OVERRIDE (0h clause-5 disqualifier). An independently-sufficient plan-review
   * marker: friday-agent-runtime honors a supplied `planReviewOverride` standalone (precedence
   * over an existing `planReview`, no dependency on skip/resume). PRESENCE → disqualified.
   * Typed `unknown` because the predicate only checks PRESENCE, never the payload. The
   * composition slice wires the body-parse that populates this from the real startRun input.
   */
  planReviewOverride?: unknown;
  /**
   * (A2b Phase 2, mutation-relax — DARK, default-off) The resolved on/off state of the Rust
   * run-CONTROL plane flag (`FRIDAY_AGENT_RUN_CONTROL_VIA_RUST`). The ENTIRE clause-2/4
   * mutation relax is gated on this being EXACTLY `true`; absent / `undefined` / `false`
   * (the default) ⇒ the mutating-admission branch is DEAD CODE and a `readOnly:false` run
   * stays disqualified to the 503 fence, BYTE-IDENTICAL to today. The route wrapper sources
   * this from the SAME resolved boolean the Rust server gates its pause/resume protocol on,
   * so the TS admission boundary and the Rust control plane flip together.
   */
  agentRunControlViaRust?: boolean;
  /**
   * (A2b Phase 2, mutation-relax — DARK, default-off) The POSITIVE per-run grant of mutating
   * Rust tools. A mutating run (`readOnly:false`) is admitted ONLY when this is a non-empty
   * array whose EVERY element is a member of {@link RUST_ROUTE_MUTATING_TOOL_ALLOWLIST} (a
   * subset of the closed 6 — any tool not on that list disqualifies). Mutation-permission is
   * NEVER inferred from `readOnly` flipping; it requires this explicit positive grant exactly
   * as clause 4 already requires a positive READ grant. Ignored entirely for a read-only run
   * (a stray grant on a read-only run changes nothing). The composition slice wires the
   * body-parse that populates this; today the startRun route never sets it.
   */
  mutatingToolGrant?: string[];
  /**
   * (A2b Phase 2, mutation-relax — DARK, default-off) The REQUIRED explicit operator-signed
   * gate opt-in marker. A mutating run is admitted ONLY when this equals
   * `"operator_signed_ed25519"` ({@link RUST_ROUTE_MUTATION_GATE_MARKER}). This makes
   * "mutating" structurally inseparable from "operator-gated" at the admission boundary —
   * there is NO admission for "mutating + no gate-marker". Ignored entirely for a read-only
   * run. The composition slice wires the body-parse that populates this.
   */
  mutationGate?: string;
}

/**
 * (A2b Phase 2, mutation-relax — DARK, default-off) The SINGLE source of truth for whether an
 * agent-run is a VALID GATED MUTATING run. Extracted from {@link qualifiesForRustReadOnlyRoute}'s
 * clause-2 computation so the qualifier (admission) AND the route's compose call site (the
 * `constraints.readOnly` it forwards on the wire) consult the EXACT same predicate — they can
 * never diverge (no guard-divergence hole). Side-effect-free; returns a bool.
 *
 * Every conjunct must hold; any uncertainty ⇒ false ⇒ the run is treated as read-only-only (the
 * compose path forwards `{ readOnly: true }`, byte-identical to today). The FIRST conjunct is
 * `agentRunControlViaRust === true`, which is default-off, so OFF ⇒ this is always false ⇒
 * BYTE-IDENTICAL-WHEN-OFF. The compensating tightenings (an explicit positive `mutatingToolGrant`
 * ⊆ the closed allow-list, an explicit `mutationGate` marker, and a non-empty bound owner
 * principal) keep the admitted UNGATED-mutation surface EXACTLY ZERO. This admits CANDIDACY only:
 * the Rust runtime gate remains the real enforcer and PAUSES every mutating tool pending an
 * operator-signed Ed25519 approval.
 */
export function isGatedMutatingRustRouteRun(input: RustRouteQualificationInput): boolean {
  const mutatingGrant = input.mutatingToolGrant;
  const mutatingGrantWithinAllowList =
    Array.isArray(mutatingGrant)
    && mutatingGrant.length > 0
    && mutatingGrant.every((tool) =>
      (RUST_ROUTE_MUTATING_TOOL_ALLOWLIST as readonly string[]).includes(tool),
    );
  const hasBoundOwnerPrincipal =
    typeof input.principalId === "string" && input.principalId.trim().length > 0;
  return (
    input.agentRunControlViaRust === true
    && input.constraints?.readOnly === false
    && mutatingGrantWithinAllowList
    && input.mutationGate === RUST_ROUTE_MUTATION_GATE_MARKER
    && hasBoundOwnerPrincipal
  );
}

function hasValidMissionContext(input: RustRouteQualificationInput): boolean {
  const context = input.missionContext;
  return !!context
    && typeof context.fridayConversationId === "string"
    && context.fridayConversationId.trim().length > 0
    && typeof context.missionId === "string"
    && context.missionId.trim().length > 0
    && typeof context.workItemId === "string"
    && context.workItemId.trim().length > 0;
}

// Mission-bound provider admission arms: a route-wrapper request with a validated 3-field
// Mission handle plus an authenticated owner principal. The handle may come from the HTTP
// body (for operator/driver-triggered mission-bound starts) or from server-produced
// auto-dispatch, but it is only a selector. Authority remains the authenticated principal,
// and the Rust mission-bound path re-validates the Mission/WorkItem ownership before
// producing proof or readback.
function isMissionBoundCodexObserveRoute(input: RustRouteQualificationInput): boolean {
  return input.providerId === RUST_ROUTE_CODEX_PROVIDER_ID
    && input.model === RUST_ROUTE_CODEX_MODEL
    && (input.taskProfile?.model === undefined || input.taskProfile.model === RUST_ROUTE_CODEX_MODEL)
    && hasValidMissionContext(input)
    && typeof input.principalId === "string"
    && input.principalId.trim().length > 0;
}

function isMissionBoundClaudeRoute(input: RustRouteQualificationInput): boolean {
  return input.providerId === RUST_ROUTE_CLAUDE_PROVIDER_ID
    && input.model === RUST_ROUTE_CLAUDE_MODEL
    && (input.taskProfile?.model === undefined || input.taskProfile.model === RUST_ROUTE_CLAUDE_MODEL)
    && hasValidMissionContext(input)
    && typeof input.principalId === "string"
    && input.principalId.trim().length > 0;
}

/**
 * Fail-closed qualifying predicate for the future Rust read-only route (DARK).
 * TOTAL + side-effect-free: returns `true` only when EVERY clause holds; any missing /
 * uncertain field → `false`. Computes a bool; routes nothing.
 */
export function qualifiesForRustReadOnlyRoute(input: RustRouteQualificationInput): boolean {
  // Clause 1 — route-not-method: explicit internal marker from the HTTP route wrapper only.
  if (input.invokedFromHttpStartRunRoute !== true) {
    return false;
  }

  // ── (A2b Phase 2, mutation-relax — DARK, default-off) GATED-MUTATING-RUN admission ──
  //
  // The SINGLE source of truth for whether this run is a VALID gated mutating run. Computed
  // ONCE so clause 2 (the readOnly gate) and clause 4 (the tool allow-list) can NEVER diverge
  // — clause 2 admits a mutating run ONLY if this is true, and clause 4 widens its allow-list
  // ONLY by exactly the grant this validated. Every conjunct must hold; any uncertainty ⇒
  // false ⇒ the run falls back to the read-only-only admission (today's behavior).
  //
  // BYTE-IDENTICAL-WHEN-OFF: the FIRST conjunct is `agentRunControlViaRust === true`. The flag
  // is default-off (absent/undefined/false), so off ⇒ this is always false ⇒ clause 2's
  // `readOnly !== true` disqualifies a mutating run EXACTLY as today, and clause 4 never widens.
  // The mutating branch is dead code until the operator flips the SAME flag the Rust pause/
  // resume control plane gates on. A read-only run never consults the mutating fields at all.
  //
  // COMPENSATING TIGHTENINGS (INV-2 + INV-7): every relaxation is matched by an added
  // requirement so the admitted UNGATED-mutation surface stays EXACTLY ZERO —
  //   (i)   an EXPLICIT positive `mutatingToolGrant` (never inferred from `readOnly` flipping),
  //   (ii)  EVERY granted tool a member of the closed RUST_ROUTE_MUTATING_TOOL_ALLOWLIST,
  //   (iii) an EXPLICIT `mutationGate === "operator_signed_ed25519"` opt-in marker, and
  //   (iv)  a NON-EMPTY bound owner `principalId` (single-owner; the Rust server scopes the
  //         body + owner-gated readback to it — a blank/whitespace owner cannot own a
  //         mutating run, independent of any session sub-clause below).
  // The Rust runtime gate remains the REAL enforcer: each granted mutating tool still Pauses
  // pending an operator-signed Ed25519 approval. This admits CANDIDACY only, never EXECUTION.
  // The SINGLE source of truth, shared VERBATIM with the route's compose call site (which forwards
  // `constraints.readOnly: false` ONLY for this verdict) via {@link isGatedMutatingRustRouteRun} —
  // so admission (here) and the on-the-wire constraint can NEVER diverge.
  const isGatedMutatingRun = isGatedMutatingRustRouteRun(input);

  // Clause 2 — readOnly (hard-blocks mutating tools in the runtime) OR a VALID gated mutating
  // run (the only way `readOnly:false` is ever admitted; flag-off ⇒ this OR-arm is dead code).
  if (input.constraints?.readOnly !== true && !isGatedMutatingRun) {
    return false;
  }

  // Clause 3 — Provider/model. The default non-mission route remains exact DeepSeek flash; Codex
  // and Claude are admitted only as mission-bound provider runs with a validated 3-field
  // missionContext and bound owner principal. That context selects the Mission/WorkItem only; the
  // authenticated principal remains the owner and Rust re-validates the binding. Ordinary
  // Codex/Claude/pro/missing-provider runs stay disqualified.
  // Provider identity qualifies via EITHER real shape:
  //   (a) the literal provider id "deepseek" (test/RGG envs seed the row with that id), OR
  //   (b) a NON-EMPTY requested providerId whose RESOLVED record (route wrapper's cheap
  //       getProvider read) has kind === "deepseek" AND enabled === true (production rows
  //       carry UUID ids). Fail-closed: no resolved record / disabled / non-deepseek kind
  //       → disqualified. A resolved record can never rescue a missing/blank providerId.
  const resolvedDeepseekProvider =
    typeof input.providerId === "string"
    && input.providerId.trim().length > 0
    && input.resolvedProvider?.kind === RUST_ROUTE_DEEPSEEK_PROVIDER_ID
    && input.resolvedProvider.enabled === true;
  const deepseekFlashRoute =
    (input.providerId === RUST_ROUTE_DEEPSEEK_PROVIDER_ID || resolvedDeepseekProvider)
    && input.model === RUST_ROUTE_DEEPSEEK_FLASH_MODEL
    && (input.taskProfile?.model === undefined || input.taskProfile.model === RUST_ROUTE_DEEPSEEK_FLASH_MODEL);
  if (
    !deepseekFlashRoute
    && !isMissionBoundCodexObserveRoute(input)
    && !isMissionBoundClaudeRoute(input)
  ) {
    return false;
  }

  // Clause 4 — the admitted tool set.
  //   • READ-ONLY run (today's behavior, byte-identical): EXACTLY the 4 Rust read tools,
  //     nothing else. The `allowedRustRouteTools` grant must be precisely the read set.
  //   • GATED MUTATING run (A2b, dark/default-off): the read set UNION the explicitly-granted
  //     mutating subset — a NAMED, CLOSED allow-list. `allowedRustRouteTools` must still be
  //     exactly the 4 reads (the base), and EVERY admitted extra must be a member of the
  //     validated `mutatingToolGrant` (already proven ⊆ RUST_ROUTE_MUTATING_TOOL_ALLOWLIST by
  //     `isGatedMutatingRun`). The runtime Rust gate remains the real enforcer of execution.
  const grant = input.allowedRustRouteTools;
  if (!Array.isArray(grant) || grant.length !== RUST_ROUTE_READ_TOOL_ALLOWLIST.length) {
    return false;
  }
  const granted = new Set(grant);
  if (granted.size !== RUST_ROUTE_READ_TOOL_ALLOWLIST.length) {
    return false;
  }
  for (const tool of RUST_ROUTE_READ_TOOL_ALLOWLIST) {
    if (!granted.has(tool)) {
      return false;
    }
  }
  // The mutating half of the union is `input.mutatingToolGrant`, already validated by
  // `isGatedMutatingRun` (non-empty, ⊆ the closed mutating allow-list) and gated on the
  // default-off flag. No further check is needed here: for a read-only run `isGatedMutatingRun`
  // is false and the mutating grant is never consulted, so this stays byte-identical to today.

  // Clause 5 — no plan-review.
  if (input.requireReview === true) {
    return false;
  }
  if (input.taskProfile?.id === "review") {
    return false;
  }
  if (input.skipPlanningReview === true || input.resumeExistingRun === true) {
    return false;
  }
  // The 4th plan-review disqualifier (0h): planReviewOverride is independently sufficient —
  // PRESENCE alone disqualifies (matches the clause-5 contract above), regardless of skip/resume.
  if (input.planReviewOverride !== undefined) {
    return false;
  }

  // Clause 5 — session sub-clause (A2a Phase 1 RELAX, owner-scoped).
  //
  // A non-empty `sessionKey` NO LONGER disqualifies — a read-only sessioned (multi-turn)
  // chat run may now route to Rust, where the server reloads + threads the session history
  // via the already-built `run_session_loop`. This is the ONLY relaxation in Phase 1: clause
  // 2 (readOnly), clause 3 (admitted provider/model shapes), clause 4 (exactly the 4 read tools),
  // and the plan-review sub-clauses above all stay intact and fail-closed.
  //
  // COMPENSATING REQUIREMENT (the matched tightening): a sessioned run is admitted ONLY with
  // a NON-EMPTY owner `principalId`. The session history + answer body are releasable only to
  // the run's bound OWNER = the authenticated forwarded principal; an anonymous / blank
  // principal cannot own a session, so it MUST still disqualify (fail-closed) — otherwise an
  // ownerless sessioned run could not be safely owner-scoped. A blank/whitespace principalId
  // counts as absent. SCOPE: this requirement is checked ONLY when a sessionKey is present —
  // the SESSIONLESS path is UNTOUCHED (a sessionless run with a blank principal stays exactly
  // as today: it qualifies here and fail-closes downstream in compose, byte-identical).
  if (typeof input.sessionKey === "string" && input.sessionKey.trim().length > 0) {
    const hasOwnerPrincipal =
      typeof input.principalId === "string" && input.principalId.trim().length > 0;
    if (!hasOwnerPrincipal) {
      return false;
    }
  }

  // Subagents + Pause-able/mutating-approval actions are precluded structurally
  // (route marker + readOnly + reads-only allow-list); no separate field to check.
  return true;
}

/**
 * execrun-replacement S-F-compose (DARK) — the qualifying-run composition that routes ONE
 * agent-run through the Rust read-only loop. This is only ever reached when the
 * default-OFF `routeAgentRunViaRust` flag is ON AND {@link qualifiesForRustReadOnlyRoute}
 * returned true (see {@link createFridayApiRuntime}'s route wrapper). Flag-off /
 * disqualified NEVER reaches here — those fall to today's unchanged 503 path, byte-identical.
 *
 * The wired path (operator decision):
 *   1. Resolve the WS session key from the SecureStore. MISSING/invalid → fail CLOSED:
 *      throw the SAME 503 the disqualified path would have raised, WITHOUT ever opening a
 *      WS connection (no unauthenticated egress). The key bytes become the WS `authProof`.
 *   2. WS client (S-D) `dispatchRun` → the REFS-ONLY result (sha256 + len; NEVER the body).
 *   3. Owner-gated readback (slice-3) `readAnswer({ runId, callerPrincipal })` → the body,
 *      released ONLY to the authenticated owner principal. `callerPrincipal` is the bound
 *      `principalId`; absent → fail closed.
 *   4. Continuity projector (slice-2) writes the SOLE TS agent_run + run_result + usage row
 *      (idempotent on run_id; no double-count). It is the only DB write here.
 *   5. Return a `FridayAgentRuntimeResult` carrying the owner-released body as `finalResponse`.
 *
 * Fail-closed: ANY failure (missing key, WS error, readback non-delivered, projector throw)
 * throws a 503-shaped {@link FridayDomainError}; it NEVER falls through to the TS `startRun`.
 *
 * Truth label: `rust_wired` — dark, mock-proven, no real spend; NOT v1 GO.
 */
/**
 * The SOLE 503 the Rust read-only compose path raises on ANY fail-closed condition
 * (missing session key, missing owner principal / Hub DB path, WS error, non-delivered
 * readback, projector throw). Byte-identical to the disqualified / flag-off `startRun`
 * 503 (same code, message, status, classification, replacement) so the route stays
 * indistinguishable from today on every non-routed path. Hoisted to module scope so the
 * compose path AND the route-level idempotency-replay guard share one definition.
 */
function failClosedRustAgentRun(): FridayDomainError {
  return new FridayDomainError(
    "TS_RUNTIME_AGENT_RUNS_RETIRED",
    "Agent run execution is fail-closed while runtime ownership is being moved out of TypeScript.",
    {
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_agent_run_entrypoint_required",
      },
    },
  );
}

/**
 * B1-compose (DARK): parse the Rust agent-run WS server port from its env var. Defaults to a
 * sentinel `0` (the same sentinel the old plain-WS client used) when unset / non-numeric — on the
 * default-off route this port is never dialed, and 6b provisions the real port via env.
 */
function readRustAgentRunWsPort(raw: string | undefined): number {
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function stampOrganicProvenance(
  db: Database.Database,
  runId: string,
  provenance: FridayOrganicRunProvenance | undefined,
): void {
  if (!provenance) return;
  db.prepare(
    `UPDATE friday_agent_runs
     SET organic = 1,
         organic_principal = ?,
         organic_source = ?,
         organic_attestation_ref = ?,
         metadata_json = json_set(metadata_json, '$.organicProvenance', json(?))
     WHERE id = ?`,
  ).run(
    provenance.principal,
    provenance.source,
    provenance.attestationRef,
    JSON.stringify({
      principal: provenance.principal,
      source: provenance.source,
      attestationRef: provenance.attestationRef,
      ...(provenance.publicKeyId ? { publicKeyId: provenance.publicKeyId } : {}),
      taskSha256: provenance.taskSha256,
      issuedAt: provenance.issuedAt,
      route: provenance.route,
    }),
    runId,
  );
}

/**
 * (honest-non-finished) Project + return an HONEST non-Finished terminal result for a run whose
 * Rust loop terminated WITHOUT an answer (the persist guard skipped ⇒ the owner-gated readback
 * legitimately `not_found`). Mirrors the Paused-branch projection pattern (write-transaction + the
 * real projector) but maps to `loopStatus:"Errored"` (→ the projector's terminal "failed" status):
 * the wire collapses Blocked/Errored/Bounded into one no-answer label and all three map to "failed"
 * anyway, so "Errored" is the faithful coarse non-resumable terminal — NEVER "Paused" (resumable
 * "cancelled", which a no-answer terminal is not). REFS-ONLY: empty body ref (len 0), empty
 * response — we NEVER fabricate an answer body. We DELIBERATELY do NOT stamp the apiRequest
 * idempotency descriptor (a failed/no-answer run must NOT replay on a retry).
 */
function projectHonestNonFinishedTerminal(input: {
  readonly db: FridaySqliteLayer;
  readonly projector: FridayRustHubRunContinuityProjectorService;
  readonly runId: string;
  readonly providerId: string;
  readonly model: string;
  readonly ownerPrincipal: string;
  readonly wsStatus: string;
  readonly turns: number;
  readonly executedTools: number;
  readonly completedAtIso: string;
  readonly organicProvenance?: FridayOrganicRunProvenance;
}): FridayAgentRuntimeResult {
  const projection = input.db.withWriteTransaction((db) => {
    const result = input.projector.project(db, {
      truthLabel: "rust_wired_dev",
      proofOnly: true,
      ok: true,
      runId: input.runId,
      routeId: `${input.providerId}:${input.model}`,
      providerId: input.providerId,
      model: input.model,
      // The faithful non-Finished loop status (→ the projector's terminal "failed" run status —
      // NEVER a fabricated "completed"/"finished", NEVER the resumable "Paused"/"cancelled"). The
      // opaque collapsed labels fall back to "Errored". `errorCategory` is a bounded body-free label.
      loopStatus: RUST_ROUTE_NON_FINISHED_LOOP_STATUS[input.wsStatus] ?? "Errored",
      errorCategory: "rust_loop_non_finished",
      // Carried run COUNTS when present (0 when omitted — old server / no-answer terminal).
      turns: input.turns,
      executedTools: input.executedTools,
      // No body exists → an EMPTY body REF: the empty-string sha sentinel + len 0; NEVER an answer
      // sha (the receipt type requires a sha string).
      finalMessageSha256: EMPTY_BODY_SHA256,
      finalMessageLen: 0,
      auditChainVerified: false,
      usagePromptTokens: 0,
      usageCompletionTokens: 0,
      usageTotalTokens: 0,
      completedAtIso: input.completedAtIso,
      // Stamp the BOUND OWNER (the authenticated caller, non-empty by the preflight) so the row is
      // owner-scoped for the read routes — the same shape the delivered/paused branches use. A ref.
      ...(input.ownerPrincipal ? { ownerPrincipalId: input.ownerPrincipal } : {}),
    });
    stampOrganicProvenance(db, input.runId, input.organicProvenance);
    return result;
  });
  // A non-Finished terminal settle is NOT a fail-closed 503 — it returns an HONEST terminal row.
  // Logged body-free on its OWN line, never confused with a 503.
  console.warn(
    `[friday][rust-agent-run] non-finished-terminal run_id=${input.runId} leg=readback_not_found ws_status=${input.wsStatus} status=${projection.status}`,
  );
  return {
    runId: input.runId,
    // The HONEST terminal mapping ("failed") — NOT Finished. No body → empty response (INV-5).
    status: projection.status as FridayAgentRuntimeResult["status"],
    response: "",
    toolCallCount: input.executedTools,
    durationMs: 0,
    usageInput: 0,
    usageOutput: 0,
    finalResponse: "",
  };
}

async function composeRustReadOnlyAgentRun(args: {
  readonly runId: string;
  readonly task: string;
  readonly principalId: string | undefined;
  /**
   * (A2a Phase 1) The session key for a MULTI-TURN read-only chat run, forwarded to the sealed
   * WS dispatch as `session_id` ONLY when non-empty. Absent/blank ⇒ the dispatch is byte-
   * identical to today's sessionless request (no `session_id` on the wire). The Rust server
   * scopes the session to the authenticated owner principal, never this key.
   */
  readonly sessionKey: string | undefined;
  /**
   * (A1 run-controls) The per-run CONSTRAINTS to forward on the sealed-WS dispatch so the Rust
   * server COMPOSES them onto the run's `RunPolicy` (read-only / disabled-tools / max-turns) —
   * they can only ever TIGHTEN. For a qualifying read-only Rust run this is `{ readOnly: true }`
   * (clause 2 of {@link qualifiesForRustReadOnlyRoute} already REQUIRES `readOnly === true`, so
   * forwarding it makes the read-only guarantee travel on the WIRE + be enforced in RUST, not
   * only by the TS qualifier — the defense-in-depth A1 closes). ABSENT (`undefined`) ⇒ no
   * `constraints` on the wire, byte-identical to the pre-A1 dispatch, server applies no override
   * (gated additionally by the server's default-off run-control flag).
   */
  readonly constraints: FridayRustHubAgentRunConstraints | undefined;
  /**
   * (NS45-PR2 mission-bound driver — DARK) The first-class Mission handle to forward on the sealed-WS
   * dispatch so the Rust server resolves the Mission/WorkItem and (behind its default-off
   * `FRIDAY_MISSION_BOUND_RUN` flag) walks the bound run path. The WS client emits the snake_case
   * `mission_context` block ONLY when this is present; ABSENT (`undefined`) ⇒ no `mission_context` on
   * the wire, byte-identical to the pre-NS45 unbound dispatch. SECURITY: the bound owner is the
   * authenticated `principalId` (forwarded as `forwardedPrincipal`), never this handle.
   */
  readonly missionContext?: FridayRustHubAgentRunMissionContext;
  readonly organicProvenance?: FridayOrganicRunProvenance;
  readonly providerId: string;
  readonly model: string;
  readonly wsClient: FridayRustHubAgentRunSealedClientService;
  readonly projector: FridayRustHubRunContinuityProjectorService;
  readonly readback: FridayRustHubRunAnswerReadbackService;
  readonly clientSecretResolver: FridayRustAgentRunWsClientX25519SecretResolver;
  readonly hubDbPath: string | undefined;
  readonly db: FridaySqliteLayer;
  readonly nowIso: () => string;
  /**
   * execrun S-F carry-forward (DARK) — optional apiRequest idempotency descriptor. When
   * present, the projected continuity row is stamped with
   * `metadata.apiRequest.{principalId,idempotencyKey,payloadHash}` (the EXACT shape the
   * bare `startRun` persists) so a SUBSEQUENT request sharing the key REPLAYS this run
   * instead of minting a second runId. Absent ⇒ no stamp (unchanged).
   */
  readonly apiRequestIdempotency?: {
    readonly operationId: string;
    readonly principalId: string;
    readonly idempotencyKey: string;
    readonly payloadHash: string;
    readonly receivedAt: string;
  };
}): Promise<FridayAgentRuntimeResult> {
  const failClosed = failClosedRustAgentRun;

  // (observability) Close the 503-after-billing diagnostic gap: the failing run_id appeared
  // in NO log, so a billed run that 503s left no trail linking the spend to a leg. Log
  // {run_id, leg, code} on every fail-closed exit of this compose path — body-free (never the
  // answer, owner, key, or task; the runId is a uuid ref). Cheap (one console.warn per 503).
  const logFailClosed = (leg: string, code = "TS_RUNTIME_AGENT_RUNS_RETIRED"): void => {
    console.warn(
      `[friday][rust-agent-run] fail-closed 503 run_id=${args.runId} leg=${leg} code=${code}`,
    );
  };

  // (1) SecureStore X25519 client SECRET — MISSING/invalid ⇒ fail closed BEFORE any WS
  // connection. The sealed client runs the ECDH handshake with this secret and builds the
  // auth_proof itself; a non-32-byte secret fails closed here (the 503), never escaping as a
  // RangeError from the sealed client. Never open an unauthenticated WS call; never log the key.
  const clientSecret = args.clientSecretResolver();
  if (!clientSecret || clientSecret.length !== 32) {
    logFailClosed("preflight_client_secret");
    throw failClosed();
  }
  // The owner principal must be present to gate the body readback (slice-3). Absent ⇒ 503.
  const callerPrincipal = args.principalId;
  if (!callerPrincipal) {
    logFailClosed("preflight_principal");
    throw failClosed();
  }
  // The owner-gated body readback needs a Hub DB path. Absent ⇒ fail closed (no body).
  const hubDbPath = args.hubDbPath;
  if (!hubDbPath) {
    logFailClosed("preflight_hub_db_path");
    throw failClosed();
  }

  // (2) Dispatch the run over the SEALED WS client (B1). The client runs the ECDH handshake +
  // builds the auth_proof from `clientSecret` INTERNALLY; refs-only result; fail-closed on error.
  // leg A: a dispatch throw is the sealed-WS "closed-before-the-body" / transport surface —
  // log {run_id, leg=dispatch, code} before rethrowing so the spend ties to this leg. Typed as the
  // discriminated union so the `outcome === "paused"` narrowing below (and the result narrowing
  // after the paused early-return) is sound.
  let wsResult: FridayRustHubAgentRunSealedClientServiceDispatchOutcome;
  try {
    wsResult = await args.wsClient.dispatchRun({
      runId: args.runId,
      task: args.task,
      forwardedPrincipal: callerPrincipal,
      clientSecret,
      // (A2a Phase 1) forward the session key; the WS client emits `session_id` only when it is
      // non-empty (absent/blank ⇒ byte-identical sessionless wire, today's behavior). The server
      // owner-scopes the session to `callerPrincipal` (the authenticated owner), never this key.
      ...(args.sessionKey !== undefined ? { sessionKey: args.sessionKey } : {}),
      // (A1 run-controls) forward the per-run constraints; the WS client emits `constraints` only
      // when something tightens (here `{ readOnly: true }`), else OMITS the field (byte-identical
      // pre-A1 wire). The server composes them onto the run policy behind its default-off flag.
      ...(args.constraints !== undefined ? { constraints: args.constraints } : {}),
      // (NS45-PR2 mission-bound driver — DARK) forward the Mission handle; the WS client emits the
      // `mission_context` wire block ONLY when present (absent ⇒ OMITTED ⇒ byte-identical unbound
      // wire). The server walks the bound run path behind its default-off `FRIDAY_MISSION_BOUND_RUN`
      // flag; the bound owner is `forwardedPrincipal`, never this handle.
      ...(args.missionContext !== undefined ? { missionContext: args.missionContext } : {}),
    });
  } catch (err) {
    logFailClosed(
      "dispatch",
      err instanceof FridayDomainError ? err.code : "dispatch_error",
    );
    throw err;
  }

  // (A3 courier) PAUSED outcome — the Rust loop gate PAUSED a mutating tool and the courier settled
  // with a refs-only paused outcome (approval nonce + action digest + summary; NO signing material,
  // INV-1). This reaches here ONLY when the courier's default-off run-control flag is on AND the
  // server paused; with the flag off the courier never returns a paused outcome, so this whole branch
  // is UNREACHABLE and the path below is byte-identical to today. (A read-only run can never pause —
  // this branch is also DARK until a LATER PR relaxes clause 2 to admit a mutating run.)
  //
  // We MUST NOT route a paused outcome through the delivered-body readback (it has no body ⇒ it would
  // fail-close at the readback gate before projecting). Instead we BRANCH EARLY: project an HONEST
  // non-Finished continuity row via `loopStatus:"Paused"` (the projector maps it to the NONTERMINAL
  // "awaiting_approval" status — a resumable, non-error stop pending approval, never a fake "finished"
  // and never a terminal "cancelled"; INV-5 refs-only — the row stores only the pause refs, NEVER the
  // answer/summary body). The returned result carries an EMPTY `response` (no body exists yet — the
  // run paused pending approval) and a 0 tool count.
  if (isPausedDispatchOutcome(wsResult)) {
    const pausedAtIso = args.nowIso();
    const pausedProjection = args.db.withWriteTransaction((db) => {
      const result = args.projector.project(db, {
        truthLabel: "rust_wired_dev",
        proofOnly: true,
        // `ok` is the receipt-well-formed flag (a fixed `true` on the receipt type — the same value
        // every non-finished mapping uses, e.g. Bounded/Errored); the NON-finished semantics of a
        // pause are carried by `loopStatus:"Paused"` → the projector's nonterminal "awaiting_approval"
        // status mapping, NOT by this flag.
        ok: true,
        runId: args.runId,
        routeId: `${args.providerId}:${args.model}`,
        providerId: args.providerId,
        model: args.model,
        // HONEST non-Finished status: the projector maps "Paused" → the NONTERMINAL "awaiting_approval"
        // run status (a resumable, non-error stop pending approval) — NEVER a fabricated
        // "completed"/"finished", and NEVER a terminal "cancelled".
        loopStatus: "Paused",
        // A paused run executed reads (turns/tools) up to the pause; surface the carried counts when
        // present (absent ⇒ 0, an old server). Counts are refs, never a body.
        turns: 0,
        executedTools: 0,
        // No answer body exists for a paused run — store a body REF over the pause refs (NEVER the
        // answer/summary body). The action digest is the run's fingerprint at the pause point.
        finalMessageSha256: wsResult.actionDigest,
        finalMessageLen: 0,
        auditChainVerified: false,
        usagePromptTokens: 0,
        usageCompletionTokens: 0,
        usageTotalTokens: 0,
        completedAtIso: pausedAtIso,
        // (S6 mutating-chat) Stamp the run's BOUND OWNER onto the paused row's
        // `metadata.apiRequest.principalId`. The paused branch previously returned BEFORE any
        // owner stamp (the delivered branch's idempotency merge below is unreached for a pause),
        // leaving a paused row ownerless — so the resume route's owner-binding gate would reject
        // EVERY resume, including the legitimate owner. `callerPrincipal` is the same bound owner
        // the readback/qualifier require (clause `hasBoundOwnerPrincipal` already guaranteed it is
        // non-empty for a gated mutating run). Safe for the flag-off invariant: the paused outcome
        // is reachable ONLY flag-on (the courier never returns a pause when off), so this never
        // changes byte-identical-when-off behavior.
        ...(callerPrincipal ? { ownerPrincipalId: callerPrincipal } : {}),
      });
      stampOrganicProvenance(db, args.runId, args.organicProvenance);
      return result;
    });
    // A pause is NOT a fail-closed 503 — it is an honest non-Finished settle that returns a row.
    // Log it body-free (run_id + leg) on its OWN line so it is never confused with a 503.
    console.warn(
      `[friday][rust-agent-run] paused-pending-approval run_id=${args.runId} leg=paused status=${pausedProjection.status}`,
    );
    return {
      runId: args.runId,
      // The projected status is the HONEST nonterminal mapping of a pause ("awaiting_approval") — NOT
      // Finished, and NOT a terminal "cancelled". The run is awaiting approval and stays resumable.
      status: pausedProjection.status as FridayAgentRuntimeResult["status"],
      // No body exists for a paused run — the empty response keeps the owner-sealed summary OUT of
      // plaintext (INV-5 refs-only). A LATER PR's resume leg delivers the answer after approval.
      response: "",
      toolCallCount: 0,
      durationMs: 0,
      usageInput: 0,
      usageOutput: 0,
      finalResponse: "",
    };
  }

  // (3) Owner-gated body readback (slice-3). The body is released ONLY to the matching
  // owner; a non-`delivered` outcome carries no body ⇒ fail closed. leg B: a readback throw is
  // the readback-bin (spawn/open/parse) surface — the SQLITE_BUSY-readback path this fix
  // targets. Log {run_id, leg=readback, code} before rethrowing.
  let readbackReceipt;
  try {
    readbackReceipt = await args.readback.readAnswer({
      dbPath: hubDbPath,
      runId: args.runId,
      callerPrincipal,
    });
  } catch (err) {
    logFailClosed(
      "readback",
      err instanceof FridayDomainError ? err.code : "readback_error",
    );
    throw err;
  }
  if (readbackReceipt.outcome !== "delivered") {
    // leg C: the readback succeeded but returned a non-delivered outcome (denied / not_found).
    //
    // (honest-non-finished) A run that terminated NON-Finished (the Rust loop ended Blocked /
    // Errored / Bounded, or fail-closed-to-no-answer) DELIBERATELY skips the Rust-side persist guard
    // (`if outcome.status == Finished { persist_run_result }`), so NO `run_result` row is written and
    // the owner-gated body readback LEGITIMATELY returns `not_found` — there was never an answer to
    // store. Throwing the `readback_not_found` 503 for that case MISREPORTS an honest terminal settle
    // as a transport/storage failure (the hourly self-probe + S6 saw exactly this). We carve out ONLY
    // that one honest case — `not_found` (NOT `denied`: an ownership-gate refusal MUST still 503; a
    // missing-row read is the only honest-terminal signal) AND a non-deliverable terminal wire status
    // (RUST_ROUTE_NON_FINISHED_TERMINAL_STATUSES) — and keep TODAY's 503 for everything else.
    if (
      readbackReceipt.outcome === "not_found" &&
      RUST_ROUTE_NON_FINISHED_TERMINAL_STATUSES.has(wsResult.status)
    ) {
      // HONEST non-Finished terminal: project a refs-only "failed" continuity row + return it instead
      // of throwing (see {@link projectHonestNonFinishedTerminal} for the full no-body rationale).
      return projectHonestNonFinishedTerminal({
        db: args.db,
        projector: args.projector,
        runId: args.runId,
        providerId: args.providerId,
        model: args.model,
        ownerPrincipal: callerPrincipal,
        wsStatus: wsResult.status,
        turns: wsResult.turns ?? 0,
        executedTools: wsResult.executedTools ?? 0,
        completedAtIso: args.nowIso(),
        organicProvenance: args.organicProvenance,
      });
    }
    // Every OTHER non-delivered case (denied, finished-but-missing-row, any error status) keeps
    // TODAY's fail-closed 503 EXACTLY — body-free observability then the unchanged 503.
    logFailClosed(`readback_${readbackReceipt.outcome}`);
    throw failClosed();
  }

  // (4) Project the ONE TS continuity row (slice-2). SOLE TS usage writer; idempotent on
  // run_id (re-projection adds no second row — the no-double-count contract).
  //
  // A1 transport-truth: the refs-only WS result now CARRIES the run COUNTS (turns /
  // executedTools) when the server populated them — so we stop hardcoding turns:0 /
  // executedTools:0 and use the carried values, falling back to 0 ONLY when absent (an OLD
  // server that predates A1, byte-identically to today). TOKEN totals stay 0: the per-turn
  // usage is billed to the Rust token_ledger and is NOT carried on the wire yet (deferred),
  // so `pricingResolved:false` still stands — truth label dark, no fabricated numbers.
  const completedAtIso = args.nowIso();
  const projection = args.db.withWriteTransaction((db) => {
    const result = args.projector.project(db, {
      truthLabel: "rust_wired_dev",
      proofOnly: true,
      ok: true,
      runId: args.runId,
      routeId: `${args.providerId}:${args.model}`,
      providerId: args.providerId,
      model: args.model,
      // The Rust server's wire `AgentRunResult.status` echoes the persisted RunResult status,
      // which for a finished loop is the literal "finished" (rust-core lib.rs `detail: "finished"`,
      // asserted by hub_server.rs `status == "finished"`) — NOT "completed". A delivered readback
      // (gated above) implies the loop finished, so map "finished" → Finished, else Errored.
      loopStatus: wsResult.status === "finished" ? "Finished" : "Errored",
      // (A1) carried run COUNTS (0 ONLY when the server omitted them — old server).
      turns: wsResult.turns ?? 0,
      executedTools: wsResult.executedTools ?? 0,
      finalMessageSha256: readbackReceipt.answerSha256,
      finalMessageLen: readbackReceipt.answerLen,
      auditChainVerified: false,
      // Token totals stay 0 — DEFERRED (not on the wire yet); pricingResolved:false stands.
      usagePromptTokens: wsResult.promptTokens ?? 0,
      usageCompletionTokens: wsResult.completionTokens ?? 0,
      usageTotalTokens: (wsResult.promptTokens ?? 0) + (wsResult.completionTokens ?? 0),
      completedAtIso,
    });
    // execrun S-F carry-forward (DARK): MERGE the apiRequest idempotency descriptor into the
    // projected row's metadata so a subsequent request sharing the key replays this run.
    // `json_set('$.apiRequest', json(?))` MERGES — it preserves the projector's
    // `surface`/`rustContinuity` telemetry (an `agentRepo.update({metadata})` would clobber
    // metadata_json wholesale). Stamped in the SAME write transaction as the projection.
    if (args.apiRequestIdempotency) {
      db.prepare(
        "UPDATE friday_agent_runs SET metadata_json = json_set(metadata_json, '$.apiRequest', json(?)) WHERE id = ?",
      ).run(
        JSON.stringify({
          operationId: args.apiRequestIdempotency.operationId,
          idempotencyKey: args.apiRequestIdempotency.idempotencyKey,
          payloadHash: args.apiRequestIdempotency.payloadHash,
          receivedAt: args.apiRequestIdempotency.receivedAt,
          principalId: args.apiRequestIdempotency.principalId,
        }),
        args.runId,
      );
    }
    stampOrganicProvenance(db, args.runId, args.organicProvenance);
    return result;
  });

  // (5) Return the owner-released body as the run's final response. (A1) `toolCallCount` is the
  // product-visible surface where "turns>0 with real tools" actually shows — use the carried
  // executed-tool COUNT (0 ONLY when an old server omitted it). `usageInput`/`usageOutput` use the
  // carried token counts (currently 0 — DEFERRED, not on the wire). `durationMs` stays 0: the
  // refs-only result carries no start time, so a real duration is not derivable — honest 0, not
  // invented.
  return {
    runId: args.runId,
    status: projection.status as FridayAgentRuntimeResult["status"],
    response: readbackReceipt.answer,
    toolCallCount: wsResult.executedTools ?? 0,
    durationMs: 0,
    usageInput: wsResult.promptTokens ?? 0,
    usageOutput: wsResult.completionTokens ?? 0,
    finalResponse: readbackReceipt.answer,
  };
}

export function createFridayApiRuntime(deps: CreateFridayApiRuntimeDeps): FridayApiRuntime {
  const accessTokenTtlSec = deps.accessTokenTtlSec ?? DEFAULT_ACCESS_TTL;
  const refreshTokenTtlSec = deps.refreshTokenTtlSec ?? DEFAULT_REFRESH_TTL;
  const serverVersion = deps.serverVersion ?? "1.0.0";
  const stateDir = deps.stateDir ?? ".";
  const canonicalMutationGate = createFridayMutatingActionGate({
    nowIso: deps.nowIso,
    ticketIdGenerator: () => deps.idGenerator(),
    approvalSignatureSecret: deps.tokenSecret,
    requireApprovalSignature: true,
  });
  const providerMutationGateRequired = deps.canonicalMutatingActionGate
    ?? resolveApiRuntimeCanonicalGateRequired(process.env);

  // Auth
  const tokenRepo = createFridayApiTokenRepository();
  const sessionRepo = createFridayAuthSessionRepository();

  // ─── In-memory access token revocation map (SEC-005) ───
  // Load persisted revocations from DB on startup
  const revokedAccessTokens = new Map<string, number>(); // tokenId → expiry epoch sec
  {
    const nowSec = Math.floor(new Date(deps.nowIso()).getTime() / 1000);
    const persisted = deps.db.withReadConnection((db) =>
      tokenRepo.loadRevokedAccessTokens(db, nowSec),
    );
    for (const row of persisted) {
      revokedAccessTokens.set(row.token_id, row.expires_at_epoch);
    }
    // Purge expired entries from DB
    deps.db.withWriteTransaction((db) => {
      tokenRepo.purgeExpiredAccessTokenRevocations(db, nowSec);
      tokenRepo.purgeExpiredAuthAccessTokens(db, nowSec);
    });
  }

  function markAccessTokenRevoked(tokenId: string, expSec: number): void {
    revokedAccessTokens.set(tokenId, expSec);
    // Persist to DB so revocations survive restarts (SEC-005)
    deps.db.withWriteTransaction((db) => {
      tokenRepo.revokeAccessToken(db, tokenId, expSec, deps.nowIso());
      tokenRepo.revokeAuthAccessToken(db, tokenId, deps.nowIso());
    });
  }

  /** Lazy cleanup: remove expired entries, then check if tokenId is revoked. */
  function isAccessTokenRevokedInMemory(tokenId: string): boolean {
    const nowSec = Math.floor(new Date(deps.nowIso()).getTime() / 1000);
    for (const [id, exp] of revokedAccessTokens) {
      if (exp < nowSec) {
        revokedAccessTokens.delete(id);
      }
    }
    return revokedAccessTokens.has(tokenId);
  }

  const tokenValidator = createFridayTokenValidator({
    tokenSecret: deps.tokenSecret,
    nowMs: () => new Date(deps.nowIso()).getTime(),
    lookupTokenRevocation: (tokenId) => {
      if (isAccessTokenRevokedInMemory(tokenId)) {
        return true;
      }
      return deps.db.withReadConnection((db) => {
        return tokenRepo.isAccessTokenRevoked(db, tokenId) || tokenRepo.isRevoked(db, tokenId);
      });
    },
    lookupSessionTokenState: (claims) => {
      if (!claims.sid) {
        return "active";
      }
      return deps.db.withReadConnection((db) => {
        const accessToken = tokenRepo.findAuthAccessToken(db, claims.tokenId);
        if (!accessToken) {
          return "unknown";
        }
        if (accessToken.revoked_at) {
          return "revoked";
        }
        const session = sessionRepo.findById(db, accessToken.session_id);
        if (!session || session.revoked_at !== null && session.revoked_at !== undefined) {
          return "revoked";
        }
        return "active";
      });
    },
    lookupSatelliteTokenVersion: (satelliteId) => {
      const row = deps.db.withReadConnection((db) =>
        db
          .prepare("SELECT token_version FROM satellites WHERE id = ?")
          .get(satelliteId) as { token_version: number } | undefined,
      );
      return row?.token_version ?? null;
    },
    resolveTenantId: (claims) =>
      deps.resolveAuthTenantId?.({
        principalType: claims.principalType,
        principalId: claims.principalId,
        userId: claims.userId,
        role: claims.role,
        tenantId: claims.tenantId,
        claims,
      }),
  });

  const rateLimiter = createFridayRateLimitService({
    db: deps.db,
    nowIso: deps.nowIso,
  });

  const authService = createFridayAuthService({
    db: deps.db,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    tokenSecret: deps.tokenSecret,
    accessTokenTtlSec,
    refreshTokenTtlSec,
    markAccessTokenRevoked,
    registerIssuedAccessToken: (db, input) => {
      tokenRepo.recordAuthAccessToken(db, {
        tokenId: input.tokenId,
        sessionId: input.sessionId,
        userId: input.userId,
        expiresAtEpoch: input.expiresAtEpoch,
        now: input.now,
      });
    },
    rateLimiter,
    resolveTenantId: (input) =>
      deps.resolveAuthTenantId?.({
        principalType: input.principalType,
        principalId: input.principalId,
        userId: input.userId,
        role: input.role,
      }),
  });

  const middleware = createFridayAuthMiddlewareFactory({
    tokenValidator,
    rateLimitService: rateLimiter,
  });

  // Realtime
  const eventRepo = createFridayRealtimeEventRepository();
  const checkpointRepo = createFridayRealtimeCheckpointRepository();

  const eventBus = createFridayRealtimeEventBus({
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    persistEvent: (envelope) => {
      deps.db.withWriteTransaction((db) => {
        eventRepo.append(db, envelope);
      });
    },
    db: deps.db,
    eventRepo,
  });

  const subscriptions = createFridayRealtimeSubscriptionService({
    db: deps.db,
    eventRepo,
    checkpointRepo,
    nowIso: deps.nowIso,
    currentEpoch: CURRENT_EPOCH,
    cursorSecret: deps.tokenSecret,
    // TS-runtime-retirement (method-level guard): same top-level flag the HTTP
    // realtime route + WS ack frame use, so ackEvent fail-closes by default in
    // live (all three sites fenced) and the legacy path is reachable only under
    // the test oracle. Both ingress points already pre-check this flag, so live
    // test-oracle mode passes the ingress gate AND this method guard together.
    allowTestOnlyRealtimeExecution: deps.allowTestOnlyRealtimeExecution,
  });

  const wsGateway = createFridayRealtimeWsGateway({
    tokenValidator,
    subscriptionService: subscriptions,
    eventBus,
    nowIso: deps.nowIso,
    serverVersion,
    currentEpoch: CURRENT_EPOCH,
    // Test-oracle only: undefined in default/live runtime, so the WS ack frame
    // fail-closes (matching POST /v1/realtime/ack). Same top-level flag.
    allowTestOnlyRealtimeExecution: deps.allowTestOnlyRealtimeExecution,
  });

  const publishWorkflowRealtimeEvent = async (
    event: string,
    payload: unknown,
  ): Promise<void> => {
    const normalizedPayload = asRecord(payload);
    const redactedPayload = redactEventPayload(normalizedPayload);
    const streamId = resolveWorkflowRealtimeStreamId(event, normalizedPayload);
    if (!streamId) {
      return;
    }

    eventBus.publish(
      streamId,
      event as never,
      redactedPayload as never,
    );
  };

  // Fleet
  const fleet = createFridayFleetDashboardService({
    db: deps.db,
    nowIso: deps.nowIso,
    idGenerator: deps.idGenerator,
    outboxQueueService: deps.outboxQueueService,
    // TS-runtime-retirement (method-level guard): same top-level flag the fleet
    // route uses, so the method fail-closes by default in live (route + method
    // both fenced) and the legacy path is reachable only under the test oracle.
    allowTestOnlyFleetRemediationExecution: deps.allowTestOnlyFleetRemediationExecution,
  });

  // Conflicts
  const conflicts = createFridayWorkflowConflictService({
    db: deps.db,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  // ─── Workflow runtime (use provided or create new for backward compat) ───
  const workflowRuntime = deps.workflowRuntime ?? (() => {
    const triggerRepo = createFridayWorkflowTriggerRepository({ db: deps.db });
    return createFridayWorkflowRuntime({
      db: deps.db,
      idGenerator: deps.idGenerator,
      nowIso: deps.nowIso,
      computeChecksum: deps.computeChecksum,
      resolveSkill: deps.resolveSkill,
      invokeSkill: deps.invokeSkill,
      userRulesContextProvider: deps.userRulesContextProvider,
      publishEvent: publishWorkflowRealtimeEvent,
      triggerRepo,
      resolveWebhookSecretRef: createWorkflowWebhookSecretResolver(deps.db),
      // Keep the fallback runtime's execution `startRun` method consistent with the
      // route-level guard: it honors the same `allowTestOnlyWorkflowRunExecution`
      // flag so a caller that enables the route guard also enables the method.
      allowTestOnlyWorkflowRunExecution: deps.allowTestOnlyWorkflowRunExecution,
    });
  })();

  const resolveAuthorizedRun = (
    runId: string,
    principal: FridayAuthPrincipal | null,
    options?: { evidence?: boolean },
  ) => {
    const run = workflowRuntime.execution.getRun(runId);
    if (!run) {
      throw new FridayDomainError("WORKFLOW_RUN_NOT_FOUND", "Workflow run not found", { httpStatus: 404 });
    }

    if (isPrivilegedRunEvidencePrincipal(principal)) {
      return run;
    }

    if (!principal) {
      throw new FridayDomainError("UNAUTHORIZED", "Authentication required", { httpStatus: 401 });
    }

    if (principal.userId && run.startedByUserId === principal.userId) {
      return run;
    }

    if (principal.principalType === "satellite" && run.startedBySatelliteId === principal.principalId) {
      return run;
    }

    const runContext = asRecord(run.context);
    const securityContext = asRecord(runContext.security);
    const ownerPrincipalId = asString(securityContext.ownerPrincipalId);
    const ownerUserId = asString(securityContext.ownerUserId);
    const tenantId = asString(securityContext.tenantId)
      ?? asString(runContext.tenantId)
      ?? asString(runContext.accountId);

    if (ownerPrincipalId && ownerPrincipalId === principal.principalId) {
      return run;
    }

    if (ownerUserId && principal.userId && ownerUserId === principal.userId) {
      return run;
    }

    if (tenantId && resolvePrincipalTenantId(principal) === tenantId) {
      return run;
    }

    if (options?.evidence) {
      throw new FridayDomainError(
        "WORKFLOW_RUN_EVIDENCE_FORBIDDEN",
        "You do not have permission to access this run evidence",
        { httpStatus: 403 },
      );
    }
    throw new FridayDomainError(
      "WORKFLOW_RUN_FORBIDDEN",
      "You do not have permission to access this workflow run",
      { httpStatus: 403 },
    );
  };

  const resolveAuthorizedRunForEvidence = (
    runId: string,
    principal: FridayAuthPrincipal | null,
  ) => {
    return resolveAuthorizedRun(runId, principal, { evidence: true });
  };
  const throwRetiredWorkflowRunExecution = (): never => {
    throw new FridayDomainError(
      "TS_RUNTIME_WORKFLOW_RUNS_RETIRED",
      "Workflow run execution and controls are fail-closed while runtime ownership is being moved out of TypeScript.",
      {
        httpStatus: 503,
        details: {
          classification: "fail_closed",
          replacement: "rust_owned_workflow_run_entrypoint_required",
        },
      },
    );
  };
  const throwRetiredWorkflowRunEvidenceExport = (): never => {
    throw new FridayDomainError(
      "TS_RUNTIME_WORKFLOW_RUN_EVIDENCE_EXPORT_RETIRED",
      "Workflow run evidence export mutation is fail-closed while evidence-export ownership is being moved out of TypeScript.",
      {
        httpStatus: 503,
        details: {
          classification: "fail_closed",
          replacement: "rust_owned_workflow_run_evidence_export_entrypoint_required",
        },
      },
    );
  };

  const requireWorkflowBuilderOperator = (
    principal: FridayAuthPrincipal | null,
  ): string => {
    if (!principal?.userId) {
      throw new FridayDomainError(
        "UNAUTHORIZED",
        "A user-scoped workflow builder principal is required",
        { httpStatus: 401 },
      );
    }
    return principal.userId;
  };

  const assertWorkflowExistsForBuilder = (workflowId: string): void => {
    const workflow = deps.db.withReadConnection((db) =>
      workflowRepo.getWorkflowById(db, workflowId),
    );
    if (!workflow || workflow.deletedAt || workflow.isArchived) {
      throw new FridayDomainError("WORKFLOW_NOT_FOUND", "Workflow not found", { httpStatus: 404 });
    }
  };

  const skillRepo = createFridaySkillRepository();

  // ─── Builder runtime ───
  const builderRuntime = createFridayWorkflowBuilderRuntime({
    db: deps.db,
    crudService: workflowRuntime.crud,
    skillRegistry: deps.skillRegistry,
    skillRepo,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    computeChecksum: deps.computeChecksum,
  });
  const workflowProductService = createFridayWorkflowProductService({
    builderRuntime,
    workflowRuntime,
    workflowGenerator: deps.workflowGenerator,
    observability: deps.observabilityService,
    selfHealing: deps.diagnosis?.service,
    db: deps.db,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    // METHOD-level retirement guard: plumb the same test-oracle flag the route
    // honors so `deployDraft` fails closed for every non-route caller unless
    // explicitly enabled. Production leaves this unset.
    allowTestOnlyWorkflowDeployExecution: deps.allowTestOnlyWorkflowDeployExecution,
  });
  const deepLinkApplyService = createFridayDeepLinkApplyService({
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    providerService: deps.providerService,
    converterService: deps.converterService,
    workflowImportExport: builderRuntime.importExport,
    workflowCrud: workflowRuntime.crud,
    canonicalMutationGate,
    mcpConfigStore: deps.mcpConfigStore,
  });
  const workflowRepo = createFridayWorkflowRepository({ db: deps.db });
  const providerProfileRepo = createFridayProviderProfileRepository();
  const pluginRepo = createFridayPluginRepository();
  const subjectUpgradeStateRepo = createFridayAutonomySubjectUpgradeStateRepository();
  const autonomyInventory = createFridayAutonomySubjectInventoryService({
    sqlite: deps.db,
    skillRepo,
    workflowRepo,
    providerProfileRepo,
    pluginRegistry: {
      list: () => deps.pluginService?.listPlugins() ?? [],
    },
    subjectUpgradeStateRepo,
    mcpAdapter: deps.mcpAdapter,
    channelRegistry: deps.channels?.registry,
  });
  const autonomyCensus = createFridayAutonomyImpactCensusService({
    inventory: autonomyInventory,
    hubVersion: serverVersion,
    supportedApiVersions: ["1", "1.0", "v1"],
  });
  const autonomyPlanner = createFridayAutonomyUpgradePlannerService({
    census: autonomyCensus,
  });
  const autonomyUpgradeStatus = createFridayAutonomyUpgradeStatusService({
    census: autonomyCensus,
    planner: autonomyPlanner,
  });
  const workflowUpgradeLifecycle = createFridayWorkflowUpgradeLifecycleService({
    db: deps.db,
    workflowRepo,
    workflowCrud: workflowRuntime.crud,
    nowIso: deps.nowIso,
    canonicalMutationGate,
  });
  const skillUpgradeLifecycle = createFridaySkillUpgradeLifecycleService({
    db: deps.db,
    skillRepo,
    nowIso: deps.nowIso,
    managedSkillsDir: deps.managedSkillsDir,
    resolveCandidate: deps.converterService
      ? (input) => deps.converterService!.getCandidate(input)
      : undefined,
    skillExecutor: deps.skillExecutor,
    canonicalMutationGate,
    refreshRegistry: deps.skillRegistry
      ? () => deps.skillRegistry!.refresh()
      : undefined,
    updateSkillStatus: deps.updateSkillStatus,
  });
  const upgradeAnalysis = createFridaySkillUpgradeAnalysisService({
    db: deps.db,
    nowIso: deps.nowIso,
    skillRepo,
    workflowRepo,
    workspaceDir: stateDir,
    resolveCandidate: deps.converterService
      ? (input) => deps.converterService!.getCandidate(input)
      : undefined,
  });
  const getSkillLifecycleDetail = (skillId: string): FridaySkillLifecycleDetail | null => {
    const lifecycleDetail = deps.skillLifecycle?.getSkill(skillId);
    if (lifecycleDetail) {
      return lifecycleDetail;
    }
    const registeredSkill = deps.skillRegistry?.get(skillId);
    const persistedSkill = skillRepo.getSkillById(deps.db.writer, skillId);
    if (!registeredSkill && !persistedSkill) {
      return null;
    }
    const manifest = registeredSkill?.manifest ?? persistedSkill?.currentManifest;
    const status = persistedSkill?.status ?? registeredSkill?.status ?? "not_installed";
    const latestVersion = persistedSkill?.latestVersion ?? manifest?.version;
    const installedVersion = persistedSkill?.installedVersion
      ?? (status === "installed" ? manifest?.version : undefined);
    const requirementPreview = {
      bins: [] as string[],
      env: [] as string[],
      config: [] as string[],
      supportedOs: [],
      requiredCapabilities: [] as string[],
      missingBins: [] as string[],
      missingEnv: [] as string[],
      unresolvedConfig: [] as string[],
      unsupportedOs: false,
    };
    const permissionPreview = {
      required: [] as string[],
      optional: [] as string[],
      promptOn: [] as string[],
      grants: [],
    };
    const eligibility = {
      verdict: "eligible" as const,
      installable: status !== "installed",
      reviewRequired: status !== "installed",
      reasons: [],
    };
    return {
      skillId,
      name: persistedSkill?.name ?? manifest?.name ?? skillId,
      description: manifest?.description,
      source: persistedSkill?.source ?? registeredSkill?.source ?? "local",
      origin: persistedSkill?.origin ?? registeredSkill?.origin ?? "managed",
      status,
      starter: (manifest?.tags ?? []).includes("starter"),
      category: manifest?.category,
      tags: manifest?.tags ?? [],
      publisher: persistedSkill?.publisher ?? manifest?.author?.name,
      latestVersion,
      installedVersion,
      updateAvailable: false,
      managed: (persistedSkill?.origin ?? registeredSkill?.origin) === "managed",
      registryLoaded: Boolean(registeredSkill),
      currentManifest: manifest,
      originType: "generated",
      maturity: status === "installed" ? "stable" : "draft",
      verificationStatus: registeredSkill ? "local" : "unverified",
      requirementPreview,
      permissionPreview,
      eligibility,
      installPlan: {
        strategy: installedVersion ? "update" : "install",
        targetVersion: latestVersion,
        targetCount: 1,
        verificationStatus: registeredSkill ? "local" : "unverified",
        eligibility,
        requirements: requirementPreview,
        permissions: permissionPreview,
      },
      versions: [],
      installations: [],
    };
  };
  const skillLifecycleActionsAvailable = Boolean(
    deps.skillLifecycle || (deps.converterService && deps.skillExecutor && deps.managedSkillsDir),
  );
  const providerProfileUpgradeLifecycle = createFridayProviderProfileUpgradeLifecycleService({
    db: deps.db,
    providerProfileRepo,
    nowIso: deps.nowIso,
    stateDir,
    validateProvider: deps.providerService
      ? (providerId, options) => deps.providerService!.validateProvider(providerId, options)
      : undefined,
    canonicalMutationGate,
  });
  const pluginUpgradeLifecycle = createFridayPluginUpgradeLifecycleService({
    db: deps.db,
    pluginRepo,
    nowIso: deps.nowIso,
    stateDir,
    pluginRuntime: deps.pluginService,
    canonicalMutationGate,
    rollbackSnapshotSecret: deps.tokenSecret,
  });
  const signCanonicalApprovalForRequest = (
    request: FridayMutatingActionRequest,
    input: {
      approvalIdPrefix: string;
      childOfLifecycleTicketId?: string;
    },
  ): FridayCanonicalApprovalResolution => {
    const evaluatedAtMs = Date.parse(deps.nowIso());
    const expiresAt = new Date(
      (Number.isFinite(evaluatedAtMs) ? evaluatedAtMs : Date.now()) + 10 * 60 * 1000,
    ).toISOString();
    return signFridayCanonicalApproval({
      decision: "approved",
      approvalId: `${input.approvalIdPrefix}-${deps.idGenerator()}`,
      decidedByPrincipalId: request.actor.principalId ?? request.actor.id,
      actionDigest: createFridayMutatingActionDigest(request),
      expiresAt,
      childOfLifecycleTicketId: input.childOfLifecycleTicketId,
    }, deps.tokenSecret);
  };
  const signPluginLifecycleApproval = (
    input: FridayPluginLifecycleApprovalRequestInput,
    options: { childOfLifecycleTicketId?: string } = {},
  ) => signCanonicalApprovalForRequest(createFridayPluginLifecycleMutatingActionRequest(input), {
    approvalIdPrefix: `plugin-review-enable-${input.action}`,
    childOfLifecycleTicketId: options.childOfLifecycleTicketId,
  });
  const mcpServerUpgradeLifecycle = deps.mcpAdapter
      ? createFridayMcpServerUpgradeLifecycleService({
        db: deps.db,
        stateRepo: subjectUpgradeStateRepo,
        mcpAdapter: deps.mcpAdapter,
        nowIso: deps.nowIso,
        stateDir,
        canonicalMutationGate,
        // TS-runtime-retirement (method-level guard): same top-level flag the
        // autonomy route uses, so the lifecycle mutations fail-close by default
        // in live (route + method both fenced) and the legacy path is reachable
        // only under the test oracle.
        allowTestOnlyAutonomyLifecycleExecution: deps.allowTestOnlyAutonomyLifecycleExecution,
      })
    : undefined;
  const channelAdapterUpgradeLifecycle = deps.channels?.registry
    ? createFridayChannelAdapterUpgradeLifecycleService({
        db: deps.db,
        stateRepo: subjectUpgradeStateRepo,
        channelRegistry: deps.channels.registry,
        nowIso: deps.nowIso,
        stateDir,
        canonicalMutationGate,
      })
    : undefined;
  const autonomyPolicyService = createFridayAutonomyPolicyService({
    db: deps.db,
    nowIso: deps.nowIso,
    // METHOD-level retirement guard: plumb the same test-oracle flag the route
    // honors so the shared service instance (also wired into the agent
    // controlled-autonomy tool's `policy_update`) fails closed for every
    // non-route caller unless explicitly enabled. Production leaves this unset.
    allowTestOnlyAutonomyPolicyMutation: deps.allowTestOnlyAutonomyPolicyMutation,
  });
  const capabilityAcquisitionService = createFridayCapabilityAcquisitionService({
    db: deps.db,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    policyService: autonomyPolicyService,
    capabilitySnapshotGetter: deps.capabilitySnapshotGetter,
    // METHOD-level retirement guard: plumb the same test-oracle flag the route
    // honors so the shared service instance (also wired into the agent
    // controlled-autonomy tool's acquisition_* actions and the standing-agenda
    // service) fails closed for every non-route caller unless explicitly
    // enabled. Production leaves this unset.
    allowTestOnlyCapabilityAcquisitionExecution: deps.allowTestOnlyCapabilityAcquisitionExecution,
  });
  const standingAgendaService = createFridayStandingAgendaService({
    db: deps.db,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    policyService: autonomyPolicyService,
    acquisitionService: capabilityAcquisitionService,
    // METHOD-level retirement guard: plumb the same test-oracle flag the route
    // honors so the shared service instance fails closed for every non-route
    // caller (e.g. a future agent/background caller of createStandingGoal /
    // updateStandingGoal) unless explicitly enabled. Production leaves this unset.
    allowTestOnlyStandingAgendaExecution: deps.allowTestOnlyStandingAgendaExecution,
  });

  // Route registry
  const routes = createFridayHttpRouteRegistry();
  const secretAdminService = createFridaySecretAdminService({
    db: deps.db,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  installFridayApiRuntimeBaseRoutes({
    routes,
    deps,
    fleet,
    serverVersion,
  });

  for (const route of createFridayRuntimeAdminRoutes({
    version: {
      get: () => ({
        version: serverVersion,
        apiVersion: "v1",
      }),
    },
    config: deps.configManager
      ? {
        get: async (query) => {
          const [currentConfig, snapshot] = await Promise.all([
            deps.configManager!.getCurrentConfig(),
            deps.configManager!.getConfig(query.keys),
          ]);
          return {
            revision: snapshot.revision,
            settings: snapshot.settings,
            currentConfig,
          };
        },
        update: async (request) => {
          const validation = await deps.configManager!.validatePatch(request.patch);
          if (!validation.valid) {
            throw new FridayDomainError("VALIDATION_ERROR", "Config patch validation failed", {
              httpStatus: 400,
              details: { errors: validation.errors },
            });
          }
          const result = await deps.configManager!.applyPatch(request);
          return {
            ...result,
            validation: {
              valid: true as const,
              errors: [] as [],
            },
          };
        },
        listRevisions: (query) => deps.configManager!.listRevisions(query.cursor, query.limit),
        revert: (request) => deps.configManager!.revertToRevision(request.toRevision),
      }
      : undefined,
    auditLogs: deps.observability
      ? {
        list: (query) => deps.observability!.audit.search(query),
      }
      : undefined,
  })) {
    routes.register(route);
  }

  for (const route of createFridayAutonomyRoutes({
    listUpgradeStatus: (query) => ({
      items: autonomyUpgradeStatus.list(query),
    }),
    canonicalMutationGate,
    policyService: autonomyPolicyService,
    acquisitionService: capabilityAcquisitionService,
    standingAgendaService,
    workflowActions: {
      registerShadow: (input) =>
        workflowUpgradeLifecycle.registerShadowVersion({
          workflowId: input.workflowId,
          workflowVersionId: input.workflowVersionId,
          runtimeVersion: input.runtimeVersion,
          providerModel: input.providerModel,
          actor: input.actor,
          surface: input.surface,
          planDigest: input.planDigest,
          idempotencyKey: input.idempotencyKey,
          canonicalApproval: input.canonicalApproval,
        }),
      recordCanary: (input) =>
        workflowUpgradeLifecycle.recordCanaryResult({
          workflowId: input.workflowId,
          success: input.success,
          runtimeVersion: input.runtimeVersion,
          providerModel: input.providerModel,
          evaluatedAt: input.evaluatedAt,
          actor: input.actor,
          surface: input.surface,
          planDigest: input.planDigest,
          idempotencyKey: input.idempotencyKey,
          canonicalApproval: input.canonicalApproval,
        }),
      promote: (input) =>
        workflowUpgradeLifecycle.promote({
          workflowId: input.workflowId,
          versionNumber: input.versionNumber,
          runtimeVersion: input.runtimeVersion,
          providerModel: input.providerModel,
          actor: input.actor,
          surface: input.surface,
          planDigest: input.planDigest,
          idempotencyKey: input.idempotencyKey,
          canonicalApproval: input.canonicalApproval,
        }),
      rollback: (input) =>
        workflowUpgradeLifecycle.rollback({
          workflowId: input.workflowId,
          targetVersionNumber: input.targetVersionNumber,
          runtimeVersion: input.runtimeVersion,
          providerModel: input.providerModel,
          actor: input.actor,
          surface: input.surface,
          planDigest: input.planDigest,
          idempotencyKey: input.idempotencyKey,
          canonicalApproval: input.canonicalApproval,
        }),
      getStatus: (workflowId) => autonomyUpgradeStatus.get("workflow", workflowId),
    },
    skillActions: skillLifecycleActionsAvailable
      ? {
        registerShadow: async (input) => {
          await skillUpgradeLifecycle.registerShadowVersion({
            skillId: input.skillId,
            candidateId: input.candidateId,
            shadowVersionId: input.shadowVersionId,
            runtimeVersion: input.runtimeVersion,
            providerModel: input.providerModel,
            actor: input.actor,
            surface: input.surface,
            planDigest: input.planDigest,
            idempotencyKey: input.idempotencyKey,
            canonicalApproval: input.canonicalApproval,
          });
          const detail = getSkillLifecycleDetail(input.skillId);
          if (!detail) {
            throw new FridayDomainError("SKILL_NOT_FOUND", `Skill "${input.skillId}" not found`, {
              httpStatus: 404,
            });
          }
          return detail;
        },
        recordCanary: async (input) => {
          await skillUpgradeLifecycle.recordCanaryResult({
            skillId: input.skillId,
            candidateId: input.candidateId,
            runtimeVersion: input.runtimeVersion,
            providerModel: input.providerModel,
            canaryInput: input.input,
            actor: input.actor,
            surface: input.surface,
            planDigest: input.planDigest,
            idempotencyKey: input.idempotencyKey,
            canonicalApproval: input.canonicalApproval,
          });
          const detail = getSkillLifecycleDetail(input.skillId);
          if (!detail) {
            throw new FridayDomainError("SKILL_NOT_FOUND", `Skill "${input.skillId}" not found`, {
              httpStatus: 404,
            });
          }
          return detail;
        },
        promote: async (input) => {
          await skillUpgradeLifecycle.promote({
            skillId: input.skillId,
            candidateId: input.candidateId,
            runtimeVersion: input.runtimeVersion,
            providerModel: input.providerModel,
            actor: input.actor,
            surface: input.surface,
            planDigest: input.planDigest,
            idempotencyKey: input.idempotencyKey,
            canonicalApproval: input.canonicalApproval,
          });
          const detail = getSkillLifecycleDetail(input.skillId);
          if (!detail) {
            throw new FridayDomainError("SKILL_NOT_FOUND", `Skill "${input.skillId}" not found`, {
              httpStatus: 404,
            });
          }
          return detail;
        },
        rollback: async (input) => {
          await skillUpgradeLifecycle.rollback({
            skillId: input.skillId,
            candidateId: input.candidateId,
            runtimeVersion: input.runtimeVersion,
            providerModel: input.providerModel,
            reason: input.reason,
            actor: input.actor,
            surface: input.surface,
            planDigest: input.planDigest,
            idempotencyKey: input.idempotencyKey,
            canonicalApproval: input.canonicalApproval,
          });
          const detail = getSkillLifecycleDetail(input.skillId);
          if (!detail) {
            throw new FridayDomainError("SKILL_NOT_FOUND", `Skill "${input.skillId}" not found`, {
              httpStatus: 404,
            });
          }
          return detail;
        },
        getStatus: (skillId) => autonomyUpgradeStatus.get("skill", skillId),
        getEvidence: (input) =>
          skillUpgradeLifecycle.getLifecycleEvidence(input) as Record<string, unknown> | null,
      }
      : undefined,
    pluginActions: deps.pluginService
      ? {
        registerShadow: (input) =>
          pluginUpgradeLifecycle.registerShadowVersion({
            pluginId: input.pluginId,
            shadowVersionId: input.shadowVersionId,
            runtimeVersion: input.runtimeVersion,
            providerModel: input.providerModel,
            actor: input.actor,
            surface: input.surface,
            planDigest: input.planDigest,
            idempotencyKey: input.idempotencyKey,
            canonicalApproval: input.canonicalApproval,
          }),
        recordCanary: (input) =>
          pluginUpgradeLifecycle.recordCanaryResult({
            pluginId: input.pluginId,
            runtimeVersion: input.runtimeVersion,
            providerModel: input.providerModel,
            actor: input.actor,
            surface: input.surface,
            planDigest: input.planDigest,
            idempotencyKey: input.idempotencyKey,
            canonicalApproval: input.canonicalApproval,
          }),
        promote: (input) =>
          pluginUpgradeLifecycle.promote({
            pluginId: input.pluginId,
            runtimeVersion: input.runtimeVersion,
            providerModel: input.providerModel,
            actor: input.actor,
            surface: input.surface,
            planDigest: input.planDigest,
            idempotencyKey: input.idempotencyKey,
            canonicalApproval: input.canonicalApproval,
          }),
        rollback: (input) =>
          pluginUpgradeLifecycle.rollback({
            pluginId: input.pluginId,
            runtimeVersion: input.runtimeVersion,
            providerModel: input.providerModel,
            reason: input.reason,
            actor: input.actor,
            surface: input.surface,
            planDigest: input.planDigest,
            idempotencyKey: input.idempotencyKey,
            canonicalApproval: input.canonicalApproval,
          }),
        reviewEnable: async (input) => {
          const plugin = deps.pluginService!.getPlugin(input.pluginId);
          if (!plugin) {
            throw new FridayDomainError("PLUGIN_NOT_FOUND", `Plugin ${input.pluginId} not found`, {
              httpStatus: 404,
            });
          }
          const runtimeVersion = input.runtimeVersion ?? serverVersion;
          const planDigest = createFridayPluginReviewEnablePlanDigest({
            plugin,
            runtimeVersion,
            providerModel: input.providerModel,
          });
          const shadowVersionId = createFridayPluginReviewEnableShadowVersionId({ plugin, planDigest });
          const parentRequest = createFridayPluginReviewEnableParentRequest({
            plugin,
            runtimeVersion,
            providerModel: input.providerModel,
            actor: input.actor,
            surface: input.surface,
            planDigest,
            shadowVersionId,
            idempotencyKey: input.idempotencyKey,
          });
          const parentGate = canonicalMutationGate.evaluate({
            ...parentRequest,
            canonicalApproval: signCanonicalApprovalForRequest(parentRequest, {
              approvalIdPrefix: "plugin-review-enable-parent",
            }),
          });
          if (parentGate.decision !== "allow" || !parentGate.ticket) {
            throw new FridayDomainError(
              parentGate.decision === "requires_approval"
                ? "PLUGIN_REVIEW_ENABLE_CANONICAL_APPROVAL_REQUIRED"
                : "PLUGIN_REVIEW_ENABLE_CANONICAL_APPROVAL_DENIED",
              parentGate.decision === "requires_approval"
                ? "Plugin review-enable requires canonical approval before lifecycle child actions can run."
                : `Plugin review-enable was blocked by the canonical approval gate: ${parentGate.reason}`,
              {
                httpStatus: parentGate.decision === "requires_approval" ? 403 : 409,
                details: {
                  pluginId: input.pluginId,
                  actionDigest: parentGate.actionDigest,
                  reason: parentGate.reason,
                },
              },
            );
          }
          const parentTicket: FridayMutatingActionTicket = parentGate.ticket;
          const childIdempotencyKey = (action: FridayPluginLifecycleApprovalRequestInput["action"]) =>
            input.idempotencyKey ? `${input.idempotencyKey}:${action}` : undefined;
          const buildLifecycleApprovalInput = (
            action: FridayPluginLifecycleApprovalRequestInput["action"],
          ): FridayPluginLifecycleApprovalRequestInput => ({
            action,
            pluginId: input.pluginId,
            shadowVersionId,
            runtimeVersion,
            providerModel: input.providerModel,
            actor: input.actor,
            surface: `${input.surface}/${action}`,
            planDigest,
            idempotencyKey: childIdempotencyKey(action),
          });

          pluginUpgradeLifecycle.registerShadowVersion({
            pluginId: input.pluginId,
            shadowVersionId,
            runtimeVersion,
            providerModel: input.providerModel,
            actor: input.actor,
            surface: `${input.surface}/shadow`,
            planDigest,
            idempotencyKey: childIdempotencyKey("shadow"),
            canonicalApproval: signPluginLifecycleApproval(buildLifecycleApprovalInput("shadow"), {
              childOfLifecycleTicketId: parentTicket.ticketId,
            }),
          });
          await pluginUpgradeLifecycle.recordCanaryResult({
            pluginId: input.pluginId,
            runtimeVersion,
            providerModel: input.providerModel,
            actor: input.actor,
            surface: `${input.surface}/canary`,
            planDigest,
            idempotencyKey: childIdempotencyKey("canary"),
            canonicalApproval: signPluginLifecycleApproval(buildLifecycleApprovalInput("canary"), {
              childOfLifecycleTicketId: parentTicket.ticketId,
            }),
          });
          return pluginUpgradeLifecycle.promote({
            pluginId: input.pluginId,
            runtimeVersion,
            providerModel: input.providerModel,
            actor: input.actor,
            surface: `${input.surface}/promote`,
            planDigest,
            idempotencyKey: childIdempotencyKey("promote"),
            canonicalApproval: signPluginLifecycleApproval(buildLifecycleApprovalInput("promote"), {
              childOfLifecycleTicketId: parentTicket.ticketId,
            }),
          });
        },
        getStatus: (pluginId) => autonomyUpgradeStatus.get("plugin", pluginId),
        getEvidence: (input) =>
          pluginUpgradeLifecycle.getLifecycleEvidence(input) as Record<string, unknown> | null,
      }
      : undefined,
    providerProfileActions: deps.providerService
      ? {
        registerShadow: (input) =>
          providerProfileUpgradeLifecycle.registerShadowVersion({
            providerId: input.providerId,
            shadowVersionId: input.shadowVersionId,
            runtimeVersion: input.runtimeVersion,
            providerModel: input.providerModel,
            actor: input.actor,
            surface: input.surface,
            planDigest: input.planDigest,
            idempotencyKey: input.idempotencyKey,
            canonicalApproval: input.canonicalApproval,
          }),
        recordCanary: (input) =>
          providerProfileUpgradeLifecycle.recordCanaryResult({
            providerId: input.providerId,
            runtimeVersion: input.runtimeVersion,
            providerModel: input.providerModel,
            actor: input.actor,
            surface: input.surface,
            planDigest: input.planDigest,
            tenantContext: input.tenantContext,
            idempotencyKey: input.idempotencyKey,
            canonicalApproval: input.canonicalApproval,
          }),
        promote: (input) =>
          providerProfileUpgradeLifecycle.promote({
            providerId: input.providerId,
            runtimeVersion: input.runtimeVersion,
            providerModel: input.providerModel,
            actor: input.actor,
            surface: input.surface,
            planDigest: input.planDigest,
            idempotencyKey: input.idempotencyKey,
            canonicalApproval: input.canonicalApproval,
          }),
        rollback: (input) =>
          providerProfileUpgradeLifecycle.rollback({
            providerId: input.providerId,
            runtimeVersion: input.runtimeVersion,
            providerModel: input.providerModel,
            reason: input.reason,
            actor: input.actor,
            surface: input.surface,
            planDigest: input.planDigest,
            idempotencyKey: input.idempotencyKey,
            canonicalApproval: input.canonicalApproval,
          }),
        getStatus: (providerId) => autonomyUpgradeStatus.get("provider_profile", providerId),
        getEvidence: (input) =>
          providerProfileUpgradeLifecycle.getLifecycleEvidence(input) as Record<string, unknown> | null,
      }
      : undefined,
    mcpServerActions: mcpServerUpgradeLifecycle
      ? {
        registerShadow: (input) =>
          mcpServerUpgradeLifecycle.registerShadowVersion({
            serverId: input.serverId,
            shadowVersionId: input.shadowVersionId,
            runtimeVersion: input.runtimeVersion,
            providerModel: input.providerModel,
            actor: input.actor,
            surface: input.surface,
            planDigest: input.planDigest,
            idempotencyKey: input.idempotencyKey,
            canonicalApproval: input.canonicalApproval,
          }),
        recordCanary: (input) =>
          mcpServerUpgradeLifecycle.recordCanaryResult({
            serverId: input.serverId,
            runtimeVersion: input.runtimeVersion,
            providerModel: input.providerModel,
            actor: input.actor,
            surface: input.surface,
            planDigest: input.planDigest,
            idempotencyKey: input.idempotencyKey,
            canonicalApproval: input.canonicalApproval,
          }),
        promote: (input) =>
          mcpServerUpgradeLifecycle.promote({
            serverId: input.serverId,
            runtimeVersion: input.runtimeVersion,
            providerModel: input.providerModel,
            actor: input.actor,
            surface: input.surface,
            planDigest: input.planDigest,
            idempotencyKey: input.idempotencyKey,
            canonicalApproval: input.canonicalApproval,
          }),
        rollback: (input) =>
          mcpServerUpgradeLifecycle.rollback({
            serverId: input.serverId,
            runtimeVersion: input.runtimeVersion,
            providerModel: input.providerModel,
            reason: input.reason,
            actor: input.actor,
            surface: input.surface,
            planDigest: input.planDigest,
            idempotencyKey: input.idempotencyKey,
            canonicalApproval: input.canonicalApproval,
          }),
        getStatus: (serverId) => autonomyUpgradeStatus.get("mcp_server", serverId),
        getEvidence: (input) =>
          mcpServerUpgradeLifecycle.getLifecycleEvidence(input) as Record<string, unknown> | null,
      }
      : undefined,
    channelAdapterActions: channelAdapterUpgradeLifecycle
      ? {
        registerShadow: (input) =>
          channelAdapterUpgradeLifecycle.registerShadowVersion({
            channelKind: input.channelKind,
            shadowVersionId: input.shadowVersionId,
            runtimeVersion: input.runtimeVersion,
            providerModel: input.providerModel,
            actor: input.actor,
            surface: input.surface,
            planDigest: input.planDigest,
            idempotencyKey: input.idempotencyKey,
            canonicalApproval: input.canonicalApproval,
          }),
        recordCanary: (input) =>
          channelAdapterUpgradeLifecycle.recordCanaryResult({
            channelKind: input.channelKind,
            runtimeVersion: input.runtimeVersion,
            providerModel: input.providerModel,
            actor: input.actor,
            surface: input.surface,
            planDigest: input.planDigest,
            idempotencyKey: input.idempotencyKey,
            canonicalApproval: input.canonicalApproval,
          }),
        promote: (input) =>
          channelAdapterUpgradeLifecycle.promote({
            channelKind: input.channelKind,
            runtimeVersion: input.runtimeVersion,
            providerModel: input.providerModel,
            actor: input.actor,
            surface: input.surface,
            planDigest: input.planDigest,
            idempotencyKey: input.idempotencyKey,
            canonicalApproval: input.canonicalApproval,
          }),
        rollback: (input) =>
          channelAdapterUpgradeLifecycle.rollback({
            channelKind: input.channelKind,
            runtimeVersion: input.runtimeVersion,
            providerModel: input.providerModel,
            reason: input.reason,
            actor: input.actor,
            surface: input.surface,
            planDigest: input.planDigest,
            idempotencyKey: input.idempotencyKey,
            canonicalApproval: input.canonicalApproval,
          }),
        getStatus: (channelKind) => autonomyUpgradeStatus.get("channel_adapter", channelKind),
        getEvidence: (input) =>
          channelAdapterUpgradeLifecycle.getLifecycleEvidence(input) as Record<string, unknown> | null,
      }
      : undefined,
    allowTestOnlyAutonomyLifecycleExecution: deps.allowTestOnlyAutonomyLifecycleExecution,
    allowTestOnlyStandingAgendaExecution: deps.allowTestOnlyStandingAgendaExecution,
    allowTestOnlyAutonomyPolicyMutation: deps.allowTestOnlyAutonomyPolicyMutation,
    allowTestOnlyCapabilityAcquisitionExecution: deps.allowTestOnlyCapabilityAcquisitionExecution,
  })) {
    routes.register(route);
  }

  // Register auth routes
  for (const route of createFridayAuthRoutes({ authService })) {
    routes.register(route);
  }

  for (const route of createFridaySecretRoutes({
    service: secretAdminService,
  })) {
    routes.register(route);
  }

  // Tier-2 WORKFLOW catalog-mutation route bridge (DARK): the refs-only TS→Rust bridge for the
  // `hub_workflow_catalog` bin, consulted ONLY on the `routeWorkflowsViaRust`-on branch of the
  // catalog-mutation handlers. Constructed lazily ONLY when the flag is on (default-off ⇒ the
  // bridge is never built and the routes stay byte-identical to today's retirement 503). Tests
  // inject a scripted-mock adapterBin bridge via `deps.rustWorkflowCatalogBridge`.
  const routeWorkflowsViaRust = deps.routeWorkflowsViaRust === true;
  const rustWorkflowCatalogBridge = routeWorkflowsViaRust
    ? deps.rustWorkflowCatalogBridge ?? createFridayRustHubWorkflowCatalogBridgeService()
    : undefined;
  const routeWorkflowRunsViaRust = deps.routeWorkflowRunsViaRust === true;
  const rustWorkflowRunBridge = routeWorkflowRunsViaRust
    ? deps.rustWorkflowRunBridge ?? createFridayRustHubWorkflowRunBridgeService()
    : undefined;

  // Register workflow routes (real service wiring)
  for (const route of createFridayWorkflowRoutes({
    allowTestOnlyWorkflowCatalogMutationExecution: deps.allowTestOnlyWorkflowCatalogMutationExecution,
    routeWorkflowsViaRust,
    rustWorkflowCatalogBridge,
    listWorkflows: (query) => {
      const workflows = workflowRuntime.crud.listWorkflows({
        tag: query.tag,
        archived: query.archived,
        cursor: query.cursor,
        limit: query.limit,
      });
      return { items: workflows.map(sanitizePublicWorkflowEntity) };
    },
    createWorkflow: (input) => {
      return workflowRuntime.crud.createWorkflowWithVersion(
        {
          slug: input.slug,
          name: input.name,
          description: input.description,
          tags: input.tags,
        },
        input.graph,
      );
    },
    getWorkflow: (workflowId) => {
      const workflow = workflowRuntime.crud.getWorkflow(workflowId);
      if (!workflow) {
        throw new FridayDomainError("WORKFLOW_NOT_FOUND", "Workflow not found", { httpStatus: 404 });
      }
      const versions = workflowRuntime.crud.listVersions(workflowId, 1);
      const latestVersion = versions[0];
      if (!latestVersion) {
        throw new FridayDomainError("WORKFLOW_VERSION_NOT_FOUND", "Workflow version not found", { httpStatus: 404 });
      }
      const publishedVersion =
        workflowRuntime.crud.getPublishedVersion(workflowId) ?? undefined;
      return {
        workflow: sanitizePublicWorkflowEntity(workflow),
        latestVersion: sanitizePublicWorkflowVersion(latestVersion),
        publishedVersion: publishedVersion
          ? sanitizePublicWorkflowVersion(publishedVersion)
          : undefined,
      };
    },
    updateWorkflow: (workflowId, input) => {
      const updateInput = {
        workflowId,
        expectedRevision: input.expectedRevision,
        etag: input.etag,
        name: input.name,
        description: input.description,
        tags: input.tags,
      };
      if (input.graph) {
        return workflowRuntime.crud.updateWorkflowWithGraph(updateInput, input.graph);
      }
      const workflow = workflowRuntime.crud.updateWorkflow(updateInput);
      return { workflow };
    },
    archiveWorkflow: (workflowId) => {
      workflowRuntime.crud.archiveWorkflow(workflowId, "api");
      return { archived: true };
    },
    publishWorkflow: (_workflowId, input) => {
      const publishedVersion = workflowRuntime.crud.publishVersion(
        _workflowId,
        input.versionNumber,
      );
      return { publishedVersion };
    },
    listVersions: (workflowId, query) => {
      const versions = workflowRuntime.crud.listVersions(
        workflowId,
        query.limit,
      );
      return { items: versions.map(sanitizePublicWorkflowVersion) };
    },
    getVersion: (versionId) => {
      const version = workflowRuntime.crud.getVersion(versionId);
      if (!version) {
        throw new FridayDomainError("WORKFLOW_VERSION_NOT_FOUND", "Workflow version not found", {
          httpStatus: 404,
        });
      }
      return { version: sanitizePublicWorkflowVersion(version) };
    },
  })) {
    routes.register(route);
  }

  // Register builder routes (real service wiring)
  for (const route of createFridayWorkflowBuilderTemplateRoutes({
    allowTestOnlyWorkflowBuilderDraftExecution: deps.allowTestOnlyWorkflowBuilderDraftExecution,
    listTemplates: ({ scope }) => ({
      items: builderRuntime.templates.listTemplates(
        scope === "user" || scope === "global" ? scope : undefined,
      ),
      stableItems: listFridayStableWorkflowTemplates(),
    }),
    getTemplate: (templateId) => {
      const template = builderRuntime.templates.getTemplate(templateId);
      if (!template) {
        throw new FridayDomainError("TEMPLATE_NOT_FOUND", "Template not found", { httpStatus: 404 });
      }
      return { template };
    },
    instantiateTemplate: (templateId, body) => {
      if (!body || typeof body !== "object") {
        throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
      }
      if (typeof body.workflowId !== "string" || body.workflowId.length === 0) {
        throw new FridayDomainError("VALIDATION_ERROR", "workflowId is required", { httpStatus: 400 });
      }
      if (typeof body.title !== "string" || body.title.trim().length === 0) {
        throw new FridayDomainError("VALIDATION_ERROR", "title is required", { httpStatus: 400 });
      }
      if (typeof body.taskProfileId !== "undefined" && typeof body.taskProfileId !== "string") {
        throw new FridayDomainError("VALIDATION_ERROR", "taskProfileId must be a string when provided", {
          httpStatus: 400,
        });
      }
      const stableBundle = createFridayStableWorkflowDraftBundle({
        templateId,
        workflowId: body.workflowId,
        title: body.title,
        taskProfileId: body.taskProfileId,
      });
      if (stableBundle) {
        return {
          draft: builderRuntime.drafts.createDraft({
            workflowId: body.workflowId,
            title: body.title,
            spec: stableBundle.spec,
            visual: stableBundle.visual,
            ownerUserId: body.ownerUserId,
          }),
        };
      }
      return {
        draft: builderRuntime.templates.instantiateTemplate(
          templateId,
          body.workflowId,
          body.title,
          body.ownerUserId,
        ),
      };
    },
  })) {
    routes.register(route);
  }

  for (const route of createFridayWorkflowBuilderRoutes({
    allowTestOnlyWorkflowBundleImportExecution: deps.allowTestOnlyWorkflowBundleImportExecution,
    allowTestOnlyWorkflowBuilderDraftExecution: deps.allowTestOnlyWorkflowBuilderDraftExecution,
    createDraft: (workflowId, input) => {
      const draft = builderRuntime.drafts.createDraft({
        workflowId,
        title: input.title,
        spec: input.spec,
        visual: draftVisualOrDefault(workflowId, input.spec, input.visual),
        ownerUserId: input.ownerUserId,
        baseWorkflowVersionId: input.baseWorkflowVersionId,
      });
      return { draft };
    },
    listDrafts: (workflowId, _query) => {
      const drafts = builderRuntime.drafts.listDrafts(workflowId);
      return { items: drafts };
    },
    getDraft: (workflowId, draftId) => {
      const draft = builderRuntime.drafts.getDraft(draftId);
      if (!draft) {
        throw new FridayDomainError("DRAFT_NOT_FOUND", "Draft not found", { httpStatus: 404 });
      }
      if (draft.workflowId !== workflowId) {
        throw new FridayDomainError("DRAFT_WORKFLOW_MISMATCH", "Draft does not belong to this workflow", { httpStatus: 409 });
      }
      return { draft };
    },
    exportDraftBundle: (workflowId, draftId) => {
      const draft = builderRuntime.drafts.getDraft(draftId);
      if (!draft) {
        throw new FridayDomainError("DRAFT_NOT_FOUND", "Draft not found", { httpStatus: 404 });
      }
      if (draft.workflowId !== workflowId) {
        throw new FridayDomainError("DRAFT_WORKFLOW_MISMATCH", "Draft does not belong to this workflow", { httpStatus: 409 });
      }
      return {
        bundle: builderRuntime.importExport.exportDraft(draftId),
      };
    },
    importWorkflowBundle: (workflowId, input) => {
      if (!input || typeof input !== "object") {
        throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
      }
      if (!input.bundle || typeof input.bundle !== "object") {
        throw new FridayDomainError("VALIDATION_ERROR", "bundle is required", { httpStatus: 400 });
      }
      const result = builderRuntime.importExport.importBundle(
        input.bundle,
        workflowId,
        input.ownerUserId,
        { force: input.force === true },
      );
      return { result };
    },
    saveDraft: (workflowId, draftId, input) => {
      const existing = builderRuntime.drafts.getDraft(draftId);
      if (!existing) {
        throw new FridayDomainError("DRAFT_NOT_FOUND", "Draft not found", { httpStatus: 404 });
      }
      if (existing.workflowId !== workflowId) {
        throw new FridayDomainError("DRAFT_WORKFLOW_MISMATCH", "Draft does not belong to this workflow", { httpStatus: 409 });
      }
      const draft = builderRuntime.drafts.saveDraft({
        draftId,
        expectedRevision: input.expectedRevision,
        lockToken: input.lockToken,
        title: input.title,
        spec: input.spec,
        visual: input.visual,
        autosave: input.autosave,
      });
      return { draft };
    },
    autosaveDraft: (workflowId, draftId, input) => {
      const existing = builderRuntime.drafts.getDraft(draftId);
      if (!existing) {
        throw new FridayDomainError("DRAFT_NOT_FOUND", "Draft not found", { httpStatus: 404 });
      }
      if (existing.workflowId !== workflowId) {
        throw new FridayDomainError("DRAFT_WORKFLOW_MISMATCH", "Draft does not belong to this workflow", { httpStatus: 409 });
      }
      const draft = builderRuntime.drafts.autosaveDraft({
        draftId,
        lockToken: input.lockToken,
        spec: input.spec,
        visual: input.visual ?? existing.visual,
      });
      return { draft };
    },
    compileDraft: (workflowId, draftId) => {
      const draft = builderRuntime.drafts.getDraft(draftId);
      if (!draft) {
        throw new FridayDomainError("DRAFT_NOT_FOUND", "Draft not found", { httpStatus: 404 });
      }
      if (draft.workflowId !== workflowId) {
        throw new FridayDomainError("DRAFT_WORKFLOW_MISMATCH", "Draft does not belong to this workflow", { httpStatus: 409 });
      }
      return builderRuntime.compositor.compileDraft(draftId);
    },
    publishDraft: (workflowId, draftId, input) => {
      return builderRuntime.compositor.publishDraft({
        draftId,
        workflowId,
        lockToken: input.lockToken,
        createdByUserId: input.createdByUserId,
        changeNote: input.changeNote,
        publishNow: input.publishNow,
        externalReviewConfirmed: input.externalReviewConfirmed,
      });
    },
    acquireLock: (workflowId, input, principal) => {
      assertWorkflowExistsForBuilder(workflowId);
      const actorUserId = requireWorkflowBuilderOperator(principal);
      if (input.ownerUserId && input.ownerUserId !== actorUserId) {
        throw new FridayDomainError(
          "VALIDATION_ERROR",
          "ownerUserId must match the authenticated principal",
          { httpStatus: 400 },
        );
      }
      const result = builderRuntime.collaboration.acquireLock({
        workflowId,
        ownerUserId: actorUserId,
        ownerSessionId: input.ownerSessionId,
        ttlSec: input.ttlSec,
      });
      return {
        acquired: result.acquired,
        lock: result.lock,
        conflict: result.conflict,
      };
    },
    renewLock: (workflowId, input, principal) => {
      assertWorkflowExistsForBuilder(workflowId);
      const actorUserId = requireWorkflowBuilderOperator(principal);
      const lock = builderRuntime.collaboration.renewLock(
        workflowId,
        input.lockToken,
        input.ttlSec,
        actorUserId,
      );
      return { lock };
    },
    releaseLock: (workflowId, input, principal) => {
      assertWorkflowExistsForBuilder(workflowId);
      const actorUserId = requireWorkflowBuilderOperator(principal);
      builderRuntime.collaboration.releaseLock(workflowId, input.lockToken, actorUserId);
      return { released: true };
    },
  })) {
    routes.register(route);
  }

  for (const route of createFridayWorkflowProductRoutes({
    service: {
      ...workflowProductService,
      getOverview: (input) =>
        sanitizePublicWorkflowOverview(workflowProductService.getOverview(input)),
      getVisualization: (input) =>
        sanitizePublicWorkflowVisualization(workflowProductService.getVisualization(input)),
    },
    allowTestOnlyWorkflowDeployExecution: deps.allowTestOnlyWorkflowDeployExecution,
  })) {
    routes.register(route);
  }

  // Register run routes (real service wiring)
  for (const route of createFridayWorkflowRunRoutes({
    routeWorkflowRunsViaRust,
    rustWorkflowRunBridge,
    startRun: async (input, principal) => {
      if (deps.allowTestOnlyWorkflowRunExecution !== true) {
        void input;
        void principal;
        throwRetiredWorkflowRunExecution();
      }
      const runSecurityContext = principal
        ? {
          security: {
            ownerPrincipalId: principal.principalId,
            ownerPrincipalType: principal.principalType,
            ownerUserId: principal.userId ?? null,
            tenantId: resolvePrincipalTenantId(principal) ?? principal.principalId,
            tokenId: principal.tokenId,
          },
        }
        : undefined;
      const run = await workflowRuntime.execution.startRun({
        workflowId: input.workflowId,
        workflowVersionId: input.workflowVersionId,
        triggerType: input.triggerType,
        triggerPayload: input.triggerPayload,
        startedByUserId: principal?.userId,
        startedBySatelliteId: principal?.principalType === "satellite"
          ? principal.principalId
          : undefined,
        context: runSecurityContext,
        dryRun: input.dryRun,
        proofRequired: input.proofRequired === true,
      });
      return {
        run: {
          ...run,
          evidenceStatus: workflowRuntime.evidence.getRunEvidenceStatus(run.id),
        },
      };
    },
    getRun: (runId, principal) => {
      const run = resolveAuthorizedRun(runId, principal);
      return {
        run: sanitizePublicWorkflowRun({
          ...run,
          evidenceStatus: workflowRuntime.evidence.getRunEvidenceStatus(run.id),
        }),
      };
    },
    listRunNodes: (runId, query, principal) => {
      resolveAuthorizedRun(runId, principal);
      const nodes = workflowRuntime.execution.getRunNodes(
        runId,
        query.status,
      );
      return { items: nodes.map(sanitizePublicWorkflowRunNode) };
    },
    getRunTimeline: (runId, query, principal) => {
      resolveAuthorizedRun(runId, principal);
      const streamId = `run:${runId}`;
      const afterSeq = query.afterSeq ?? 0;
      const limit = query.limit ?? 50;
      const envelopes = deps.db.withReadConnection((db) =>
        eventRepo.listAfterSeq(db, streamId, afterSeq, limit),
      );
      const items: FridayRunTimelineEntry[] = envelopes.map((e) => {
        const p = e.payload as JsonObject;
        return {
          seq: e.seq,
          streamId: e.streamId,
          event: e.event,
          emittedAt: e.emittedAt,
          nodeId: p.nodeId as string | undefined,
          attempt: p.attempt as number | undefined,
          status: p.status as FridayRunTimelineEntry["status"] | undefined,
          payload: {
            redacted: true,
            shape: summarizePublicJsonShape(p),
          },
        };
      });
      return { items };
    },
    getRunEvidence: (runId, query, principal) => {
      resolveAuthorizedRunForEvidence(runId, principal);
      return sanitizePublicWorkflowEvidence(
        workflowRuntime.evidence.getRunEvidence(
          runId,
          parseRunEvidenceQuery(query as Record<string, unknown>),
        ),
      );
    },
    listRunEvidenceExports: (runId, query, principal) => {
      resolveAuthorizedRunForEvidence(runId, principal);
      const limit = readPositiveIntQuery((query as Record<string, unknown>).limit) ?? 20;
      return {
        items: workflowRuntime.evidence.listRunEvidenceExports(runId, limit)
          .map(sanitizePublicWorkflowEvidenceExport),
      };
    },
    exportRunEvidence: (runId, input, principal) => {
      if (deps.allowTestOnlyWorkflowRunExecution !== true) {
        void runId;
        void input;
        void principal;
        throwRetiredWorkflowRunEvidenceExport();
      }
      resolveAuthorizedRunForEvidence(runId, principal);
      return workflowRuntime.evidence.exportRunEvidence(
        runId,
        parseRunEvidenceQuery((input ?? {}) as Record<string, unknown>),
      );
    },
    getRunEvidenceExport: (runId, exportId, principal) => {
      resolveAuthorizedRunForEvidence(runId, principal);
      const record = workflowRuntime.evidence.getRunEvidenceExport(runId, exportId);
      if (!record) {
        throw new FridayDomainError("WORKFLOW_RUN_EVIDENCE_EXPORT_NOT_FOUND", "Workflow run evidence export not found", {
          httpStatus: 404,
        });
      }
      return sanitizePublicWorkflowEvidenceExportRecord(record);
    },
    downloadRunEvidenceExport: (runId, exportId, principal) => {
      resolveAuthorizedRunForEvidence(runId, principal);
      const record = workflowRuntime.evidence.getRunEvidenceExport(runId, exportId);
      if (!record) {
        throw new FridayDomainError("WORKFLOW_RUN_EVIDENCE_EXPORT_NOT_FOUND", "Workflow run evidence export not found", {
          httpStatus: 404,
        });
      }
      const sanitized = sanitizePublicWorkflowEvidenceExportRecord(record);
      return createFridayHttpRawTextResponse(JSON.stringify(sanitized, null, 2), {
        contentType: "application/json; charset=utf-8",
        headers: {
          "Content-Disposition": `attachment; filename=\"workflow-run-evidence-${exportId}.json\"`,
          ETag: `"${sanitized.export.checksum}"`,
          "X-Friday-Evidence-Checksum": sanitized.export.checksum,
          "X-Friday-Evidence-File-Persisted": "false",
        },
      });
    },
    cancelRun: async (runId, input, principal) => {
      if (deps.allowTestOnlyWorkflowRunExecution !== true) {
        void runId;
        void input;
        void principal;
        throwRetiredWorkflowRunExecution();
      }
      resolveAuthorizedRun(runId, principal);
      const run = await workflowRuntime.execution.cancelRun(
        runId,
        input.reason,
      );
      return { run };
    },
    retryRun: async (runId, input = {}, principal) => {
      if (deps.allowTestOnlyWorkflowRunExecution !== true) {
        void runId;
        void input;
        void principal;
        throwRetiredWorkflowRunExecution();
      }
      resolveAuthorizedRun(runId, principal);
      const latestAttempts = new Map<string, { nodeId: string; status: string; attempt: number }>();
      for (const node of workflowRuntime.execution.getRunNodes(runId)) {
        const existing = latestAttempts.get(node.nodeId);
        if (!existing || node.attempt > existing.attempt) {
          latestAttempts.set(node.nodeId, {
            nodeId: node.nodeId,
            status: node.status,
            attempt: node.attempt,
          });
        }
      }
      const failedNodeIds = Array.from(latestAttempts.values())
        .filter((node) => node.status === "failed")
        .map((node) => node.nodeId);
      const requestedNodeIds = Array.isArray(input.nodeIds) ? input.nodeIds : undefined;
      const retriedNodes = requestedNodeIds
        ? failedNodeIds.filter((nodeId) => requestedNodeIds.includes(nodeId))
        : failedNodeIds;
      const run = await workflowRuntime.execution.retryRun(
        runId,
        input.nodeIds,
      );
      return { run, retriedNodes };
    },
    resumeRun: async (runId, principal) => {
      if (deps.allowTestOnlyWorkflowRunExecution !== true) {
        void runId;
        void principal;
        throwRetiredWorkflowRunExecution();
      }
      resolveAuthorizedRun(runId, principal);
      const run = await workflowRuntime.execution.resumeRun(runId);
      return { run };
    },
  })) {
    routes.register(route);
  }

  // ─── Approval service (from workflow runtime — no duplicate) ───
  const approvalService = workflowRuntime.approval;
  const listWorkflowApprovals = async (ctx: {
    query: unknown;
  }) => {
    const query = ctx.query as { approverUserId?: string; limit?: string; cursor?: string };
    const items = approvalService.listPending({
      approverUserId: query.approverUserId,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      cursor: query.cursor,
    });
    return { items };
  };
  const getWorkflowApproval = async (ctx: {
    params: unknown;
  }) => {
    const { approvalId } = ctx.params as { approvalId: string };
    const approval = approvalService.getById(approvalId);
    if (!approval) {
      throw new FridayDomainError("WORKFLOW_APPROVAL_NOT_FOUND", "Approval request not found", { httpStatus: 404 });
    }
    return { approval };
  };
  const approveWorkflowApproval = async (ctx: {
    params: unknown;
    body: unknown;
    principal?: FridayAuthPrincipal | null;
  }) => {
    const { approvalId } = ctx.params as { approvalId: string };
    const body = ctx.body as { comment?: string };
    // Phase 14.5A module_28a: refuse the synthetic public principal even though
    // it carries a deterministic userId. Workflow approval is high-risk and
    // must be a bound owner/session/channel principal.
    const bound = assertBoundPrincipalForOperation(
      ctx.principal ?? null,
      "workflow.approval.approve",
      "api",
    );
    return approvalService.approve({
      approvalId,
      decidedByUserId: bound.userId ?? bound.principalId,
      comment: body.comment,
    });
  };
  const rejectWorkflowApproval = async (ctx: {
    params: unknown;
    body: unknown;
    principal?: FridayAuthPrincipal | null;
  }) => {
    const { approvalId } = ctx.params as { approvalId: string };
    const body = ctx.body as { comment?: string };
    const bound = assertBoundPrincipalForOperation(
      ctx.principal ?? null,
      "workflow.approval.reject",
      "api",
    );
    return approvalService.reject({
      approvalId,
      decidedByUserId: bound.userId ?? bound.principalId,
      comment: body.comment,
    });
  };

  // Approval API routes — wired to real service
  routes.register({
    operationId: "workflows.approvals.list",
    method: "GET",
    path: "/v1/workflow-approvals",
    auth: { public: true },
    handler: listWorkflowApprovals,
  });

  routes.register({
    operationId: "workflows.approvals.get",
    method: "GET",
    path: "/v1/workflow-approvals/:approvalId",
    auth: { public: true },
    handler: getWorkflowApproval,
  });

  routes.register({
    operationId: "workflows.approvals.approve",
    method: "POST",
    path: "/v1/workflow-approvals/:approvalId/approve",
    auth: { public: true },
    handler: approveWorkflowApproval,
  });

  routes.register({
    operationId: "workflows.approvals.reject",
    method: "POST",
    path: "/v1/workflow-approvals/:approvalId/reject",
    auth: { public: true },
    handler: rejectWorkflowApproval,
  });

  routes.register({
    operationId: "approvals.list",
    method: "GET",
    path: "/v1/approvals",
    auth: { public: true },
    handler: listWorkflowApprovals,
  });

  routes.register({
    operationId: "approvals.get",
    method: "GET",
    path: "/v1/approvals/:approvalId",
    auth: { public: true },
    handler: getWorkflowApproval,
  });

  routes.register({
    operationId: "approvals.approve",
    method: "POST",
    path: "/v1/approvals/:approvalId/approve",
    auth: { public: true },
    handler: approveWorkflowApproval,
  });

  routes.register({
    operationId: "approvals.reject",
    method: "POST",
    path: "/v1/approvals/:approvalId/reject",
    auth: { public: true },
    handler: rejectWorkflowApproval,
  });

  // ─── Trigger routes (Issue 6: setEnabled) ───
  routes.register({
    operationId: "workflows.triggers.list",
    method: "GET",
    path: "/v1/workflows/:workflowId/triggers",
    auth: { public: true },
    async handler(ctx) {
      const { workflowId } = ctx.params as { workflowId: string };
      const items = workflowRuntime.triggers.listRegistrations(workflowId);
      return { items };
    },
  });

  routes.register({
    operationId: "workflows.triggers.update",
    method: "PATCH",
    path: "/v1/workflow-triggers/:registrationId",
    auth: { public: true },
    async handler(ctx) {
      assertBoundPrincipalAuthorityForOperation(
        ctx.principal ?? null,
        "workflow.trigger.update",
        "api",
        {
          anyOfScopes: ["hub.admin", "workflow.write"],
          anyOfRoles: ["owner", "admin", "operator"],
        },
      );
      const { registrationId } = ctx.params as { registrationId: string };
      const body = ctx.body as { enabled?: boolean };
      if (body.enabled != null) {
        await workflowRuntime.triggers.setRegistrationEnabled(
          registrationId,
          body.enabled,
        );
      }
      return { updated: true };
    },
  });

  routes.register({
    operationId: "workflows.triggers.resync",
    method: "POST",
    path: "/v1/workflows/:workflowId/triggers/resync",
    auth: { public: true },
    async handler(ctx) {
      assertBoundPrincipalAuthorityForOperation(
        ctx.principal ?? null,
        "workflow.trigger.resync",
        "api",
        {
          anyOfScopes: ["hub.admin", "workflow.write"],
          anyOfRoles: ["owner", "admin", "operator"],
        },
      );
      const { workflowId } = ctx.params as { workflowId: string };
      await workflowRuntime.triggers.syncPublishedVersionTriggers(workflowId);
      return { synced: true };
    },
  });

  // ─── Webhook route (Issue 2: proper trigger repo lookup + M4 HMAC verification) ───
  routes.register({
    operationId: "workflows.webhooks.invoke",
    method: "POST",
    path: "/v1/workflow-webhooks/:pathToken",
    // External-platform delivery: workflow webhooks are signed by the upstream
    // caller with an HMAC over the raw body. workflowRuntime.triggers
    // .handleWebhook verifies the signature against the per-trigger secret
    // before accepting the payload and throws WORKFLOW_WEBHOOK_HMAC_REQUIRED
    // (401) when missing or WEBHOOK_SIGNATURE_INVALID (403) when wrong.
    // Synthetic public principal cannot forge that signature. Negative test:
    // test/e2e/api/friday-api-workflows-routes.test.ts
    // (workflow_trigger_webhook_default_rejects_unsigned_invocation).
    auth: { public: true, allowUnauthenticatedMutation: true },
    rateLimitPolicyId: "workflow.webhook",
    async handler(ctx) {
      const { pathToken } = ctx.params as { pathToken: string };
      const body = (ctx.body ?? {}) as JsonObject;
      const headers = ctx.headers as Record<string, string> | undefined;
      const result = await workflowRuntime.triggers.handleWebhook({
        pathToken,
        body,
        headers,
        rawBody: ctx.rawBody,
      });
      if (!result.accepted) {
        if (result.statusCode === 401) {
          const code = result.errorCode ?? "WEBHOOK_SIGNATURE_MISSING";
          const message =
            code === "WORKFLOW_WEBHOOK_HMAC_REQUIRED"
              ? "Workflow webhook requires HMAC verification by default; bearer path-token-only mode requires explicit opt-in."
              : code === "WORKFLOW_WEBHOOK_PATH_TOKEN_WEAK"
                ? "Bearer path-token mode requires a high-entropy path token."
                : "Webhook signature header is missing";
          throw new FridayDomainError(code, message, { httpStatus: 401 });
        }
        if (result.statusCode === 403) {
          throw new FridayDomainError(
            result.errorCode ?? "WEBHOOK_SIGNATURE_INVALID",
            "Webhook signature verification failed",
            { httpStatus: 403 },
          );
        }
        if (result.statusCode === 500) {
          throw new FridayDomainError(
            result.errorCode ?? "WEBHOOK_SECRET_REF_UNRESOLVED",
            "Webhook signing secret could not be resolved",
            { httpStatus: 500 },
          );
        }
        throw new FridayDomainError("WORKFLOW_WEBHOOK_NOT_FOUND", "Webhook not found or disabled", { httpStatus: 404 });
      }
      return { accepted: true, runId: result.runId };
    },
  });

  // Register conflict routes
  for (const route of createFridayWorkflowConflictRoutes({
    allowTestOnlyWorkflowConflictResolution: deps.allowTestOnlyWorkflowConflictResolution,
    listConflicts: (workflowId, query) => ({
      items: conflicts.listConflicts(workflowId, query.status, query.limit),
    }),
    resolveConflict: (workflowId, conflictId, input, userId) =>
      conflicts.resolveConflict(conflictId, input, userId),
  })) {
    routes.register(route);
  }

  // Register fleet routes
  for (const route of createFridayFleetRoutes({ fleetService: fleet, canonicalMutationGate, allowTestOnlyFleetRemediationExecution: deps.allowTestOnlyFleetRemediationExecution })) {
    routes.register(route);
  }

  // Register security routes
  for (const route of createFridaySecurityRoutes({
    fleetService: fleet,
    revokeToken: (tokenId) => {
      const now = deps.nowIso();
      const result = deps.db.withWriteTransaction((db) => {
        let revoked = false;
        let accessTokenExpiry: number | null = null;

        const apiToken = tokenRepo.findById(db, tokenId);
        if (apiToken) {
          revoked = true;
          if (apiToken.revoked_at === null || apiToken.revoked_at === undefined) {
            tokenRepo.revoke(db, tokenId, now);
          }
        }

        const accessToken = tokenRepo.findAuthAccessToken(db, tokenId);
        if (accessToken) {
          revoked = true;
          accessTokenExpiry = accessToken.expires_at_epoch;
          tokenRepo.revokeAccessToken(db, tokenId, accessToken.expires_at_epoch, now);
          tokenRepo.revokeAuthAccessToken(db, tokenId, now);
          sessionRepo.revokeById(db, accessToken.session_id, now);
        }

        return { revoked, accessTokenExpiry };
      });
      if (result.accessTokenExpiry !== null) {
        revokedAccessTokens.set(tokenId, result.accessTokenExpiry);
      }
      return { revoked: result.revoked, tokenId };
    },
    revokeSatellite: (satelliteId, reason) => {
      deps.db.withWriteTransaction((db) => {
        const satelliteUpdate = db.prepare(
          "UPDATE satellites SET pairing_status = 'revoked', updated_at = ? WHERE id = ?",
        ).run(deps.nowIso(), satelliteId);
        if (satelliteUpdate.changes === 0) {
          throw new FridayDomainError(
            "SATELLITE_NOT_FOUND",
            "Security satellite revoke did not match any satellite",
            {
              httpStatus: 404,
              details: { satelliteId },
            },
          );
        }
      });
      return { revoked: true, satelliteId };
    },
  })) {
    routes.register(route);
  }

  // Register multi-tenant security routes (optional)
  if (deps.multiTenantSecurity) {
    for (const route of createFridayMultiTenantSecurityRoutes(deps.multiTenantSecurity)) {
      const guardedRoute = route.path.includes("/tenants/:tenantId")
        ? {
          ...route,
          async handler(ctx: Parameters<typeof route.handler>[0]) {
            const params = ctx.params as Record<string, unknown>;
            const tenantId = asString(params.tenantId);
            if (tenantId) {
              assertTenantScopedAccess(ctx.principal, tenantId);
            }
            return route.handler(ctx);
          },
        }
        : route;
      routes.register(guardedRoute);
    }
  }

  // Register observability routes (optional)
  if (deps.observability) {
    for (const route of createFridayObservabilityRoutes(deps.observability)) {
      routes.register(route);
    }
  }

  // Register desktop runtime routes (optional)
  if (deps.desktop) {
    for (const route of createFridayDesktopRoutes(deps.desktop)) {
      routes.register(route);
    }
  }

  if (deps.channels) {
    for (const route of createFridayChannelRoutes(deps.channels)) {
      routes.register(route);
    }
  }

  // Register deep link routes (always available)
  for (const route of createFridayDeepLinkRoutes({
    applyDeepLink: (payload, options) => deepLinkApplyService.apply(payload, options),
    allowTestOnlyDeepLinkExecution: deps.allowTestOnlyDeepLinkExecution,
  })) {
    routes.register(route);
  }

  // Register grant routes (always available)
  for (const route of createFridayGrantRoutes({
    async listActiveGrants(principal) {
      return deps.db.withReadConnection((reader) => {
        const now = new Date().toISOString();
        const rows = reader.prepare(`
          SELECT id, principal_id, target, surface, scopes, issued_at, expires_at, tool_name
          FROM capability_grants
          WHERE principal_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
        `).all(principal.principalId, now) as Array<Record<string, unknown>>;
        return rows.map((row) => ({
          id: String(row.id),
          principalId: String(row.principal_id),
          target: String(row.target),
          surface: row.surface ? String(row.surface) : undefined,
          scopes: JSON.parse(String(row.scopes ?? "[]")) as string[],
          issuedAt: String(row.issued_at),
          expiresAt: row.expires_at ? String(row.expires_at) : undefined,
          toolName: row.tool_name ? String(row.tool_name) : undefined,
        }));
      });
    },
    async revokeGrant(grantId, _reason, principal) {
      const now = deps.nowIso();
      deps.db.withWriteTransaction((writer) => {
        const row = writer.prepare(`
          SELECT id, principal_id, revoked_at
          FROM capability_grants
          WHERE id = ?
        `).get(grantId) as { id: string; principal_id: string; revoked_at: string | null } | undefined;
        if (!row || row.revoked_at !== null) {
          return;
        }
        if (!canRevokeCapabilityGrant(principal, row.principal_id)) {
          throw new FridayDomainError(
            "FORBIDDEN",
            "Grant revoke requires admin/security authority or ownership of the grant principal",
            { httpStatus: 403 },
          );
        }
        writer.prepare(`UPDATE capability_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(now, grantId);
      });
      return { revoked: true };
    },
  })) {
    routes.register(route);
  }

  // Register self-healing routes (optional)
  if (deps.diagnosis) {
    for (const route of createFridayDiagnosisRoutes(deps.diagnosis)) {
      routes.register(route);
    }
  }

  if (deps.autoFix) {
    for (const route of createFridayAutoFixRoutes(deps.autoFix)) {
      routes.register(route);
    }
  }

  if (deps.agentLoop) {
    for (const route of createFridayAgentLoopRoutes(deps.agentLoop)) {
      routes.register(route);
    }
  }

  // Register Agent OS system routes (optional)
  if (deps.system) {
    for (const route of createFridaySystemRoutes(deps.system)) {
      routes.register(route);
    }
  }

  // Register read-only Guide Mode routes (optional)
  if (deps.guideLens) {
    for (const route of createFridayGuideLensRoutes(deps.guideLens)) {
      routes.register(route);
    }
  }

  // Register local discovery routes (optional)
  for (const route of deps.discovery
    ? createFridayDiscoveryRoutes({ ...deps.discovery, allowTestOnlyDiscoveryExecution: deps.allowTestOnlyDiscoveryExecution })
    : createFridayDiscoveryDisabledRoutes()) {
    routes.register(route as unknown as Parameters<typeof routes.register>[0]);
  }

  // Register discovery integration route (always registered; disabled when deps absent)
  for (const route of createFridayDiscoveryIntegrationRoutes({
    discovery: deps.discovery?.discovery ?? null,
    converterService: deps.converterService ?? null,
    canonicalMutationGate: deps.discovery ? canonicalMutationGate : null,
    disabledReason: deps.discovery ? null : "discovery service not provided",
    allowTestOnlyDiscoveryExecution: deps.allowTestOnlyDiscoveryExecution,
  })) {
    routes.register(route as unknown as Parameters<typeof routes.register>[0]);
  }

  // Register MCP server route surface with stable disabled semantics when absent.
  for (const route of createFridayMcpServerRoutes(deps.mcpServer)) {
    routes.register(route as unknown as Parameters<typeof routes.register>[0]);
  }

  // Register satellite pairing routes (optional)
  if (deps.satellitePairing) {
    for (const route of createFridaySatellitePairingRoutes(deps.satellitePairing)) {
      routes.register(route as unknown as Parameters<typeof routes.register>[0]);
    }
  }

  if (deps.satelliteRuntime) {
    for (const route of createFridaySatelliteRuntimeRoutes({
      ...deps.satelliteRuntime,
      pullEvents: ({ streamId, afterSeq, limit }) =>
        subscriptions.pullEvents(streamId, afterSeq, limit),
      getCheckpoint: ({ principalId, streamId }) =>
        subscriptions.getCheckpoint(principalId, streamId),
    })) {
      routes.register(route as unknown as Parameters<typeof routes.register>[0]);
    }
  }

  // Register channel webhook relay routes with stable disabled semantics when listeners are absent.
  for (const route of createFridayChannelWebhookRoutes(deps.channelWebhooks ?? {})) {
    routes.register(route);
  }

  // Register packaging routes with stable disabled semantics when packaging is absent.
  for (const route of createFridayPackagingRoutes(deps.packaging)) {
    routes.register(route);
  }

  // Phase 17A: user-owned cloud worker setup UX routes. Always registered;
  // 17B live cloud certification stays blocked_by_env and surfaces that
  // honestly through the catalog rather than being treated as a pass.
  const cloudWorkerSetupService = createFridayCloudWorkerSetupService({
    nowIso: deps.nowIso,
  });
  for (const route of createFridayCloudWorkerSetupRoutes({
    setupService: cloudWorkerSetupService,
  })) {
    routes.register(route as unknown as Parameters<typeof routes.register>[0]);
  }

  const studioService = createFridayStudioService({
    workspaceRoot: deps.stateDir ?? process.cwd(),
    nowIso: deps.nowIso,
  });
  for (const route of createFridayStudioRoutes({ service: studioService })) {
    routes.register(route);
  }

  const missionSpineDeps: FridayMissionSpineRoutesDeps =
    deps.missionSpine ?? {
      workbench: null,
      disabledReason: "mission spine workbench projection deps not provided",
    };
  for (const route of createFridayMissionSpineRoutes(missionSpineDeps)) {
    routes.register(route);
  }

  // (Lane M) Memory-confirmation loop terminal route. ALWAYS registered (byte-additive); DEFAULT-OFF
  // (dispatch null) ⇒ POST /v1/memory-spine/decide is honest-unavailable (503) until an operator
  // wires the adapter AND flips the Rust `FRIDAY_MEMORY_CONFIRM` flag. Mirrors mission-spine above.
  const memorySpineDeps: FridayMemorySpineRoutesDeps =
    deps.memorySpine ?? {
      dispatch: null,
      dispatchDisabledReason: "memory spine confirmation dispatch deps not provided",
    };
  for (const route of createFridayMemorySpineRoutes(memorySpineDeps)) {
    routes.register(route);
  }

  const runOutcomeLearningDeps: FridayRunOutcomeLearningRoutesDeps =
    deps.runOutcomeLearning ?? {
      dispatch: null,
      dispatchDisabledReason: "run-outcome learning decision dispatch deps not provided",
    };
  for (const route of createFridayRunOutcomeLearningRoutes(runOutcomeLearningDeps)) {
    routes.register(route);
  }

  // Register realtime routes
  for (const route of createFridayRealtimeRoutes({
    subscriptionService: subscriptions,
    currentEpoch: CURRENT_EPOCH,
    // Test-oracle only: undefined in default/live runtime, so realtime.ack
    // fail-closes; test harnesses thread it true via hub config.
    allowTestOnlyRealtimeExecution: deps.allowTestOnlyRealtimeExecution,
  })) {
    routes.register(route);
  }

  // Keep provider usage/budget routes grouped ahead of provider CRUD routes.
  // Route lookup now prefers more specific static patterns, so this order
  // stays readable without being correctness-critical for dispatch.
  for (const route of createFridayProviderUsageRoutes({
    providerService: deps.providerService,
    canonicalMutationGate,
    providerMutationGateRequired,
  })) {
    routes.register(route);
  }

  // providers-bridge cut-over (DARK, DEFAULT-OFF): the TS->Rust bridge services for the
  // retired Tier-2 PROVIDER surfaces. They are constructed unconditionally (cheap; no
  // spawn until consulted) but are consulted ONLY when deps.routeProvidersViaRust is
  // true — the route handlers gate on that flag and otherwise fail-close exactly as
  // today. Shared by the provider routes (doctor/validate/capabilities.doctor) and the
  // setup routes (providers.detect). Tests inject scripted-fake-bin bridges via deps.
  const rustProvidersDetectService =
    deps.rustProvidersDetect ?? createFridayRustHubProvidersDetectService();
  const rustCapabilityDoctorService =
    deps.rustCapabilityDoctor ?? createFridayRustHubCapabilityDoctorService();

  // Register provider routes (BYOK)
  for (const route of createFridayProviderRoutes({
    providerService: deps.providerService,
    canonicalMutationGate,
    providerMutationGateRequired,
    allowTestOnlyProviderProbeExecution: deps.allowTestOnlyProviderProbeExecution,
    allowTestOnlyProviderRoutingControlsExecution: deps.allowTestOnlyProviderRoutingControlsExecution,
    routeProvidersViaRust: deps.routeProvidersViaRust,
    rustCapabilityDoctor: rustCapabilityDoctorService,
  })) {
    routes.register(route);
  }

  // Register media-understanding routes (Phase 02a).
  //
  // Routes are always registered; the disabled state is represented inside the
  // handlers via null `service`/`doctorProvider` plus a structured
  // `disabledReason`. When deps.mediaUnderstanding is undefined (e.g. test
  // fixtures or runtimes that do not opt in to the media-understanding wiring)
  // we coalesce to a honest-disabled shape so disabled deployments return 503
  // MEDIA_UNDERSTANDING_DISABLED, never 404.
  const mediaUnderstandingDeps: FridayMediaUnderstandingRoutesDeps =
    deps.mediaUnderstanding ?? {
      service: null,
      doctorProvider: null,
      disabledReason: "media understanding deps not provided",
    };
  for (const route of createFridayMediaUnderstandingRoutes({
    service: mediaUnderstandingDeps.service,
    doctorProvider: mediaUnderstandingDeps.doctorProvider,
    disabledReason: mediaUnderstandingDeps.disabledReason,
    nowIso: deps.nowIso,
    allowTestOnlyMediaUnderstandingExecution: deps.allowTestOnlyMediaUnderstandingExecution,
  })) {
    routes.register(route);
  }

  // Register Phase 13.5A task workflow routes (separate from /v1/agent/runs).
  //
  // Routes are always registered; when deps.taskWorkflows is missing or its
  // service slot is null, the handlers return `503 TASK_WORKFLOWS_DISABLED`
  // with a structured disabledReason so disabled deployments never return
  // 404. The task workflow surface only writes additive task workflow
  // tables and never mutates agent run state.
  const taskWorkflowDeps: FridayTaskWorkflowRoutesDeps =
    deps.taskWorkflows ?? {
      service: null,
      disabledReason: "task workflow deps not provided",
    };
  for (const route of createFridayTaskWorkflowRoutes(taskWorkflowDeps)) {
    routes.register(route);
  }

  // Register Phase 02b social-import route.
  //
  // The route is always registered; the disabled state is represented inside
  // the handler via null `service` / `converterService` / `canonicalMutationGate`
  // plus a structured `disabledReason`. When deps.socialImport is undefined
  // (e.g. test fixtures or runtimes that do not opt in to XHS browser deps)
  // we coalesce to an honest-disabled shape so disabled deployments return
  // `503 SOCIAL_IMPORT_DISABLED`, never 404. The converter service and the
  // canonical mutation gate are injected by the api-runtime so the route can
  // build the stage-candidate mutation request and stage the candidate
  // through the existing converter path after gate approval.
  const socialImportDeps: FridaySocialImportRoutesDeps =
    deps.socialImport ?? {
      service: null,
      disabledReason: "social import deps not provided",
    };
  for (const route of createFridaySocialImportRoutes({
    service: socialImportDeps.service,
    disabledReason: socialImportDeps.disabledReason,
    converterService: deps.converterService ?? null,
    canonicalMutationGate: socialImportDeps.service ? canonicalMutationGate : null,
    allowTestOnlySocialImportExecution: deps.allowTestOnlySocialImportExecution,
  })) {
    routes.register(route);
  }

  // Register setup wizard routes
  if (deps.skillRegistry) {
    for (const route of createFridaySetupRoutes({
      db: deps.db,
      providerService: deps.providerService,
      skillRegistry: deps.skillRegistry,
      nowIso: deps.nowIso,
      runningHost: deps.serverHost ?? "127.0.0.1",
      runningPort: deps.serverPort ?? 3141,
      allowPrivateNetwork: deps.allowPrivateNetwork,
      getLiveChannelCount: () => deps.channels?.registry.listViews().length ?? 0,
      activateSavedChannels: deps.activateSavedChannels,
      onChannelsSaved: deps.onSetupChannelsSaved,
      onSetupCompleted: deps.onSetupCompleted,
      allowTestOnlyProviderDetectExecution: deps.allowTestOnlyProviderDetectExecution,
      routeProvidersViaRust: deps.routeProvidersViaRust,
      rustProvidersDetect: rustProvidersDetectService,
    })) {
      routes.register(route);
    }
  }

  // Register skill list route (GET /v1/skills)
  if (deps.skillRegistry || deps.skillLifecycle) {
    for (const route of createFridaySkillRoutes({
      skillRegistry: deps.skillRegistry,
      lifecycle: deps.skillLifecycle,
      skillExecutor: deps.skillExecutor,
      allowTestOnlySkillRunExecution: deps.allowTestOnlySkillRunExecution,
      allowTestOnlySkillVerifyExecution: deps.allowTestOnlySkillVerifyExecution,
	      managedSkillsDir: deps.managedSkillsDir,
	      getSkillLifecycleStatus: (skillId) => skillRepo.getSkillById(deps.db.writer, skillId)?.status,
	      canonicalMutationGate,
	      registerRetiredLegacySkillMutationRoutes: !deps.skillLifecycle && skillLifecycleActionsAvailable,
	      upgradeAnalysis,
	    })) {
      routes.register(route);
    }
  }

  // Register skill generator routes (optional — only if service is provided)
  if (deps.skillGenerator && deps.skillRegistry) {
    for (const route of createFridaySkillGeneratorRoutes({
      skillGenerator: deps.skillGenerator,
      registry: deps.skillRegistry,
      selfHealing: deps.diagnosis?.service,
      observability: deps.observabilityService,
      canonicalMutationGate,
      allowTestOnlySkillGeneratorExecution: deps.allowTestOnlySkillGeneratorExecution,
    })) {
      routes.register(route);
    }
  }

  if (deps.uix) {
    for (const route of createFridayUixRoutes(deps.uix)) {
      routes.register(route);
    }
  }

  if (deps.crossBorderPack) {
    for (const route of createFridayCrossBorderPackRoutes(deps.crossBorderPack)) {
      routes.register(route);
    }
  }

  // Register skill converter routes (optional — only if service is provided)
  if (deps.converterService) {
    for (const route of createFridaySkillConverterRoutes({
      converterService: deps.converterService,
      canonicalMutationGate,
      packOutputDir: join(stateDir, "artifacts", "skill-packs"),
      allowTestOnlySkillConverterExecution: deps.allowTestOnlySkillConverterExecution,
    })) {
      routes.register(route);
    }
  }

  // Register workflow generator routes (optional — only if service is provided)
  if (deps.workflowGenerator) {
    for (const route of createFridayWorkflowGeneratorRoutes({
      workflowGenerator: deps.workflowGenerator,
      allowTestOnlyWorkflowGeneratorExecution: deps.allowTestOnlyWorkflowGeneratorExecution,
      routeWorkflowGeneratorViaRust: routeWorkflowsViaRust,
      rustWorkflowCatalogBridge,
      idGenerator: deps.idGenerator,
      nowIso: deps.nowIso,
      computeChecksum: deps.computeChecksum,
    })) {
      routes.register(route);
    }
  }

  // Register deterministic pipeline routes (optional — only if service is provided)
  if (deps.deterministicPipeline) {
    for (const route of createFridayDeterministicPipelineRoutes({
      ...deps.deterministicPipeline,
      allowTestOnlyRulesPipelineExecution: deps.allowTestOnlyRulesPipelineExecution,
      allowTestOnlyNodeRunnerExecution: deps.allowTestOnlyNodeRunnerExecution,
      allowTestOnlyAcceptancePipelineExecution: deps.allowTestOnlyAcceptancePipelineExecution,
      allowTestOnlyRetryPipelineExecution: deps.allowTestOnlyRetryPipelineExecution,
      allowTestOnlyPlaybookPipelineExecution: deps.allowTestOnlyPlaybookPipelineExecution,
    })) {
      routes.register(route);
    }
  }

  // Register memory routes (optional — only if service is provided)
  let memoryGuardFactory: ReturnType<typeof createFridayMemoryGuardServiceFactory> | undefined;
  if (deps.memoryService) {
    const memoryItemRepo = createFridayMemoryItemRepository();
    memoryGuardFactory = createFridayMemoryGuardServiceFactory({
      core: deps.memoryService,
      db: deps.db,
      nowIso: deps.nowIso,
      nowMs: () => new Date(deps.nowIso()).getTime(),
      tsMemoryWritesEnabled: deps.allowTestOnlyTsMemoryWrites === true,
    });

    for (const route of createFridayMemoryRoutes({
      memoryGuardFactory,
      findStoreReplay: ({ principalId, idempotencyKey }) =>
        deps.db.withReadConnection((db) =>
          memoryItemRepo.findLatestByApiRequestIdempotencyKey(db, {
            principalId,
            idempotencyKey,
          })),
      listLearnedFacts: deps.uix?.listLearnedFacts
        ? (input) => deps.uix!.listLearnedFacts!({ userId: input.userId }).slice(0, input.limit)
        : undefined,
      deleteLearnedFact: deps.uix?.deleteLearnedFact,
    })) {
      routes.register(route);
    }
  }

  // Register session routes
  const sessionService = deps.sessionService ?? createFridaySessionService({
    db: deps.db,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    // TS Runtime Retirement (TS-R4/G3 method-level guard): plumb the same
    // test-oracle flag the route honors so `sweepLifecycle` fails closed for
    // every non-route caller unless explicitly enabled. Only used when the hub
    // does not pass its own sessionService (e.g. standalone API runtime / the
    // api-test-server helper). Production leaves this unset.
    allowTestOnlySessionExecution: deps.allowTestOnlySessionExecution,
  });

  async function loadSessionHistoryMessages(sessionKey: string): Promise<FridaySessionMessageRecord[]> {
    return sessionService
      .getMessages(sessionKey, SESSION_CONTEXT_HISTORY_LIMIT * 2)
      .catch(() => [] as FridaySessionMessageRecord[]);
  }

  const agentRepo = deps.agentRuntime ? createFridayAgentRunRepository() : undefined;
  const agentRunEventRepo = deps.agentRuntime ? createFridayAgentRunEventRepository() : undefined;
  const enrichAgentRun = <T extends ReturnType<NonNullable<typeof agentRepo>["getById"]> | ReturnType<NonNullable<typeof agentRepo>["list"]>[number] | null | undefined>(
    run: T,
  ): T => {
    if (!run || !deps.agentRuntime) {
      return run;
    }
    const rollbackAvailable = typeof deps.agentRuntime.hasRollbackCheckpoint === "function"
      ? deps.agentRuntime.hasRollbackCheckpoint(run.id)
      : false;
    return {
      ...run,
      rollbackAvailable,
      health: buildFridayAgentRunHealthSnapshot({
        run,
        rollbackAvailable,
      }),
      contextSummary: buildFridayAgentRunContextSummarySnapshot(run),
    } as T;
  };
  const agentPlanningGate = deps.agentRuntime && deps.agentEventEmitter && agentRepo
    ? createFridayAgentPlanningGateService({
      repo: agentRepo,
      runEventRepository: agentRunEventRepo,
      runtime: deps.agentRuntime,
      eventEmitter: deps.agentEventEmitter,
      db: deps.db,
      idGenerator: deps.idGenerator,
      nowIso: deps.nowIso,
    })
    : undefined;

  const resolveAgentMirrorIdempotencyKey = (input: {
    runId: string;
    kind: "planning" | "assistant" | "planning-reject" | "deterministic";
    status?: FridayAgentRunStatus;
  }): string => {
    if (input.kind === "assistant") {
      return `agent-run:${input.runId}:response`;
    }
    if (input.kind === "planning-reject" || input.kind === "deterministic" || !agentRepo) {
      return `agent-run:${input.runId}:${input.kind}`;
    }
    const run = deps.db.withReadConnection((reader) => agentRepo.getById(reader, input.runId));
    const gateState = run?.planReview?.gate?.state ?? "none";
    const answerCount = run?.planReview?.gate?.answers?.length ?? 0;
    const status = input.status ?? run?.status ?? "unknown";
    return `agent-run:${input.runId}:${input.kind}:${status}:${gateState}:${String(answerCount)}`;
  };

  // ── Orchestration Engine (Initiative A-WIRE) ──
  // Alignment invariant: the engine's turn preparer loads loadSessionHistoryMessages(sessionKey)
  // and injects historyMessages, into agentRuntime.executeRun() internally.
  const apiDispatchDeps: FridayDeterministicDispatchDeps = {
    sessionMessageGetter: (key: string, limit?: number) => sessionService.getMessages(key, limit),
    capabilitySnapshotGetter: deps.capabilitySnapshotGetter,
    taskStatusSnapshotGetter: deps.taskStatusSnapshotGetter,
    getDaemonStatus: deps.daemonStatusGetter,
    listMcpServers: deps.listMcpServers,
    approvalService,
    workflowExecutionService: workflowRuntime.execution,
  };
  const managedAsyncDeps: FridayManagedAsyncDispatchDeps = {
    workflowExecutionService: workflowRuntime.execution,
  };

  // Narrow session deps to the engine's expected interface
  const engineSessionDeps = {
    getMessages: (key: string, limit?: number) => sessionService.getMessages(key, limit),
    addMessage: (key: string, msg: Parameters<typeof sessionService.addMessage>[1]) =>
      sessionService.addMessage(key, msg),
    getConversationFocus: (key: string) => sessionService.getConversationFocus(key),
    setConversationFocus: (key: string, state: Parameters<typeof sessionService.setConversationFocus>[1]) =>
      sessionService.setConversationFocus(key, state).then(() => undefined),
  };

  const persistImmediateRunResult = agentRepo && agentRunEventRepo
    ? createFridayImmediateRunPersistence({
      db: deps.db,
      repo: agentRepo,
      runEventRepository: agentRunEventRepo,
      idGenerator: deps.idGenerator,
      nowIso: deps.nowIso,
    })
    : undefined;
  const engineCompactionContextReplaySink = createFridayCompactionContextReplaySink({
    db: deps.db,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  const orchestrationEngine = deps.agentRuntime
    ? createFridayOrchestrationEngine({
      turnPreparerDeps: {
        sessionDeps: engineSessionDeps,
        historyLimit: SESSION_CONTEXT_HISTORY_LIMIT,
        nowIso: deps.nowIso,
        prepareTurn: prepareFridayConversationTurn as CreateFridayEngineTurnPreparerDeps["prepareTurn"],
        buildEvidenceBlocks: buildFridayEvidenceBlocks as CreateFridayEngineTurnPreparerDeps["buildEvidenceBlocks"],
        classifyExecution: classifyFridayExecution,
        capabilitySnapshotGetter: deps.capabilitySnapshotGetter as CreateFridayEngineTurnPreparerDeps["capabilitySnapshotGetter"],
        taskStatusSnapshotGetter: deps.taskStatusSnapshotGetter as CreateFridayEngineTurnPreparerDeps["taskStatusSnapshotGetter"],
        persistCompactionEvidence: engineCompactionContextReplaySink
          ? async (input) => {
            await engineCompactionContextReplaySink.persist({
              sessionKey: input.sessionKey,
              runId: input.runId,
              summary: input.summary,
              blocks: input.blocks,
              compactedAt: deps.nowIso(),
            });
          }
          : undefined,
      },
      runExecutorDeps: {
        agentRuntime: deps.agentRuntime!,
        sessionDeps: engineSessionDeps,
        planningGate: agentPlanningGate,
        nowIso: deps.nowIso,
        persistImmediateRunResult,
        dispatchDeterministic,
        dispatchManagedAsync,
        finalizeFocus: finalizeFridayConversationFocus as CreateFridayEngineRunExecutorDeps["finalizeFocus"],
        deterministicDispatchDeps: apiDispatchDeps as unknown as Record<string, unknown>,
        managedAsyncDispatchDeps: managedAsyncDeps as unknown as Record<string, unknown>,
        resolveIdempotencyKey: resolveAgentMirrorIdempotencyKey,
      },
    })
    : undefined;

  /**
   * Map `FridayEngineRunResult` back to the `FridayAgentRuntimeResult`-compatible
   * shape that existing callers (agent routes, session routes) expect.
   */
  function engineResultToRuntimeResult(
    engineResult: FridayEngineRunResult,
  ): {
    runId: string;
    status: FridayAgentRunStatus;
    response: string;
    toolCallCount: number;
    durationMs: number;
    usageInput: number;
    usageOutput: number;
    images?: string[];
    finalResponse?: string;
    contextCostSummary?: FridayEngineRunResult["contextCostSummary"];
    taskProfile?: FridayEngineRunResult["taskProfile"];
  } {
    return {
      runId: engineResult.runId,
      status: engineResult.status as FridayAgentRunStatus,
      response: engineResult.response ?? "",
      toolCallCount: engineResult.toolCallCount,
      durationMs: engineResult.durationMs,
      usageInput: engineResult.usageInput ?? 0,
      usageOutput: engineResult.usageOutput ?? 0,
      images: engineResult.images,
      finalResponse: engineResult.response,
      contextCostSummary: engineResult.contextCostSummary,
      taskProfile: engineResult.taskProfile,
    };
  }

  const executeAgentRunWithSessionContext = orchestrationEngine
    ? async (input: {
      task: string;
      taskPrompt?: string;
      runId: string;
      sessionKey?: string;
      providerId?: string;
      model?: string;
      replyToMessageId?: string;
      timezone?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      reviewRequired?: boolean;
      constraints?: FridayAgentRunConstraints;
      disabledToolNames?: string[];
      principalId?: string;
      scopes?: string[];
      executionContext?: FridayAgentExecutionContext;
      taskProfile?: FridayAgentTaskProfileInput;
      tenantContext?: FridayProviderTenantContext;
      persistTaskMessage?: boolean;
      taskAlreadyInHistory?: boolean;
      idempotencyPrefix: "api-agent-run" | "api-session-run";
      apiRequestIdempotency?: {
        operationId: string;
        idempotencyKey: string;
        payloadHash: string;
        receivedAt: string;
        principalId?: string;
      };
    }) => {
      const packId = input.executionContext?.packId?.trim();
      const publicIsolatedRun = isPublicIsolatedRunConstraints(input.constraints);
      let sessionRecord: FridaySessionRecord | null = null;
      if (input.sessionKey && !publicIsolatedRun) {
        sessionRecord = await sessionService.getOrCreateSession(input.sessionKey).catch(() => null);
      }
      if (sessionRecord && input.tenantContext && (input.tenantContext.hubId || input.tenantContext.userId)) {
        const sessionUserId =
          typeof sessionRecord.userId === "string" && sessionRecord.userId.trim().length > 0
            ? sessionRecord.userId.trim()
            : undefined;
        const nextUserId =
          sessionUserId === undefined
            && typeof input.tenantContext.userId === "string"
            && input.tenantContext.userId.trim().length > 0
              ? input.tenantContext.userId.trim()
              : undefined;
        sessionRecord = await sessionService.alignSessionContext(sessionRecord.key, {
          ...(input.tenantContext.hubId ? { accountId: input.tenantContext.hubId } : {}),
          ...(nextUserId ? { userId: nextUserId } : {}),
        }).catch(() => sessionRecord);
      }
      if (packId && sessionRecord && !publicIsolatedRun) {
        sessionRecord = await sessionService.mergeMetadata(sessionRecord.key, {
          packContext: {
            packId,
            ...(input.executionContext?.surface ? { surface: input.executionContext.surface } : {}),
            updatedAt: deps.nowIso(),
          },
        });
      }
      const tenantContext = resolveRunTenantContext({
        tenantContext: input.tenantContext,
        session: sessionRecord,
        principalId: input.principalId,
        constraints: input.constraints,
      });
      const engineResult = await orchestrationEngine.executeRun({
        task: input.task,
        taskPrompt: input.taskPrompt,
        runId: input.runId,
        sessionKey: publicIsolatedRun ? undefined : input.sessionKey,
        providerId: input.providerId,
        tenantContext,
        model: input.model,
        replyToMessageId: input.replyToMessageId,
        timezone: input.timezone,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        reviewRequired: input.reviewRequired,
        constraints: input.constraints,
        disabledToolNames: input.disabledToolNames,
        principalId: input.principalId,
        scopes: input.scopes,
        executionContext: input.executionContext,
        taskProfile: input.taskProfile,
        taskAlreadyInHistory: input.taskAlreadyInHistory ?? (input.persistTaskMessage === false),
        idempotencyPrefix: input.idempotencyPrefix,
        apiRequestIdempotency: input.apiRequestIdempotency,
      });
      return engineResultToRuntimeResult(engineResult);
    }
    : undefined;

  // Extraction service (optional — requires memory + provider services)
  let extractionService: ReturnType<typeof createFridaySessionMemoryExtractionService> | undefined;
  if (deps.memoryService) {
    extractionService = createFridaySessionMemoryExtractionService({
      db: deps.db,
      sessionService,
      memoryService: deps.memoryService,
      providerService: deps.providerService,
      idGenerator: deps.idGenerator,
      nowIso: deps.nowIso,
      // TS Runtime Retirement (TS-R4/G3 method-level guard): plumb the same
      // test-oracle flag the route honors so the extraction mutators fail closed
      // for every non-route caller (this is the route-facing instance; the
      // scheduler uses a separate instance in hub bootstrap) unless explicitly
      // enabled. Production leaves this unset.
      allowTestOnlySessionMemoryExtractionExecution:
        deps.allowTestOnlySessionMemoryExtractionExecution,
    });
  }

  const runSession = deps.agentRuntime
    ? async (input: {
      sessionKey: string;
      task: string;
      taskPrompt?: string;
      providerId?: string;
      model?: string;
      replyToMessageId?: string;
      timezone?: string;
      timeoutMs?: number;
      principalId?: string;
      scopes?: string[];
      constraints?: FridayAgentRunConstraints;
      disabledToolNames?: string[];
      executionContext?: FridayAgentExecutionContext;
      taskProfile?: FridayAgentTaskProfileInput;
      tenantContext?: FridayProviderTenantContext;
      persistTaskMessage?: boolean;
      taskAlreadyInHistory?: boolean;
    }) => {
      const runId = deps.idGenerator();
      const reflexUserId = input.tenantContext?.userId?.trim();
      if (deps.reflexService && reflexUserId) {
        for (const write of parseFridayReflexExplicitPreferenceMessage(input.task)) {
          deps.reflexService.requestPreferenceUpdate({
            userId: reflexUserId,
            category: write.category,
            key: write.key,
            value: write.value,
            sourceSurface: "operate",
          });
        }
      }
      return executeAgentRunWithSessionContext!({
        task: input.task,
        taskPrompt: input.taskPrompt,
        runId,
        sessionKey: input.sessionKey,
        providerId: input.providerId,
        model: input.model,
        replyToMessageId: input.replyToMessageId,
        timezone: input.timezone,
        timeoutMs: input.timeoutMs,
        principalId: input.principalId,
        scopes: input.scopes,
        constraints: input.constraints,
        disabledToolNames: input.disabledToolNames,
        executionContext: input.executionContext,
        taskProfile: input.taskProfile,
        tenantContext: input.tenantContext,
        persistTaskMessage: input.persistTaskMessage,
        taskAlreadyInHistory: input.taskAlreadyInHistory,
        idempotencyPrefix: "api-session-run",
      });
    }
    : undefined;

  // OC-012: Keep session usage routes grouped ahead of main session routes.
  // Route lookup now prefers more specific static patterns, so this order
  // documents intent without being a shadowing workaround.
  for (const route of createFridaySessionUsageRoutes({ db: deps.db, sessionService })) {
    routes.register(route);
  }

  for (const route of createFridaySessionRoutes({
    sessionService,
    extractionService,
    channelRegistry: deps.channels?.registry,
    nowIso: deps.nowIso,
    runSession,
    allowTestOnlySessionExecution: deps.allowTestOnlySessionExecution,
    allowTestOnlySessionRunExecution: deps.allowTestOnlySessionRunExecution,
    allowTestOnlySessionMemoryExtractionExecution: deps.allowTestOnlySessionMemoryExtractionExecution,
  })) {
    routes.register(route);
  }

  // Register plugin routes (optional — only if service is provided)
  if (deps.pluginService && deps.pluginManifestLoader) {
    for (const route of createFridayPluginRoutes({
      pluginService: deps.pluginService,
      manifestLoader: deps.pluginManifestLoader,
      allowTestOnlyPluginExecution: deps.allowTestOnlyPluginExecution,
    })) {
      routes.register(route);
    }
  }

  // Register agent routes (optional — only if runtime and emitter are provided)
  let agentAutomationService: FridayAgentAutomationService | undefined;
  // (Organic mission→run binding PRODUCER — DARK) Function-scoped ref to the ROUTING `startRun`
  // (the `routeStartRun` wrapper at the route registration below). Hoisted here because
  // `routeStartRun` is block-scoped inside the `if (deps.agentRuntime…)` arm and is otherwise
  // invisible at the runtime return. Exposed as `agent.startRun` so bootstrap can hand the SAME
  // route-qualifying entrypoint to the mission auto-dispatch driver. agentRuntime/emitter absent
  // ⇒ this stays undefined ⇒ `agent.startRun` undefined ⇒ the driver no-ops (default-OFF safe).
  let routeStartRunRef: FridayAgentRouteStartRun | undefined;
  if (deps.agentRuntime && deps.agentEventEmitter && agentRepo && agentRunEventRepo) {
    const agentAbortControllers = new Map<string, AbortController>();
    const throwRetiredAgentRunControl = (): never => {
      throw new FridayDomainError(
        "TS_RUNTIME_AGENT_RUN_CONTROLS_RETIRED",
        "Agent run controls are fail-closed while runtime control ownership is being moved out of TypeScript.",
        {
          httpStatus: 503,
          details: {
            classification: "fail_closed",
            replacement: "rust_owned_agent_run_control_entrypoint_required",
          },
        },
      );
    };
    const replayAgentRunResult = (run: FridayAgentRunRecord): FridayAgentRuntimeResult => ({
      runId: run.id,
      status: run.status,
      response: run.responseText ?? run.summary ?? "",
      toolCallCount: 0,
      durationMs: run.durationMs ?? 0,
      usageInput: run.usageInput ?? 0,
      usageOutput: run.usageOutput ?? 0,
      ...(run.responseText ? { finalResponse: run.responseText } : {}),
      ...(run.contextCostSummary ? { contextCostSummary: run.contextCostSummary } : {}),
      ...(run.taskProfile ? { taskProfile: run.taskProfile } : {}),
    });

    const startRun = async (input: {
      task: string;
      taskPrompt?: string;
      sessionKey?: string;
      providerId?: string;
      model?: string;
      replyToMessageId?: string;
      timezone?: string;
      timeoutMs?: number;
      requireReview?: boolean;
      constraints?: FridayAgentRunConstraints;
      disabledToolNames?: string[];
      executionContext?: FridayAgentExecutionContext;
      taskProfile?: FridayAgentTaskProfileInput;
      principalId?: string;
      scopes?: string[];
      tenantContext?: FridayProviderTenantContext;
      apiIdempotencyKey?: string;
      apiIdempotencyPayloadHash?: string;
      apiIdempotencyReceivedAt?: string;
      // execrun-replacement S-F-compose (DARK): the explicit, positive, per-run grant of
      // the Rust read-tool set. Purely additive + optional — every existing caller omits
      // it (→ undefined → predicate clause-4 fails → disqualified → byte-identical 503).
      // The HTTP route forwards `body.allowedRustRouteTools`; no other route behavior
      // changes. NEVER derived from readOnly/operationalMode — clause-4 is an explicit gate.
      allowedRustRouteTools?: string[];
      // S-F-compose (DARK): an explicit plan-review override marker (clause-5 disqualifier).
      // Additive + optional; absent for every existing caller.
      planReviewOverride?: unknown;
      // (A2b Phase 2, mutation-relax — DARK, default-off) the explicit POSITIVE grant of
      // mutating Rust tools and the operator-signed gate opt-in marker. Purely additive +
      // optional — every existing caller omits BOTH (→ undefined → the qualifier's mutating
      // branch never opens → a `readOnly:false` run stays disqualified → byte-identical 503).
      // Consulted by the qualifier ONLY behind the default-off `agentRunControlViaRust` flag.
      mutatingToolGrant?: string[];
      mutationGate?: string;
      // (NS45-PR2 mission-bound driver — DARK) the first-class Mission handle this run binds to.
      // Purely additive + optional — every existing caller omits it. The HTTP route forwards the
      // validated `body.missionContext`; server-produced auto-dispatch may also pass the same shape.
      // `routeStartRun` uses it to qualify mission-bound Codex/Claude routes and threads it onto
      // sealed-WS dispatch. It NEVER overrides principal/owner; Rust re-validates binding.
      missionContext?: FridayRustHubAgentRunMissionContext;
      organicProvenance?: FridayOrganicRunProvenance;
    }) => {
      if (deps.allowTestOnlyAgentRunStartExecution !== true) {
        void input;
        throw new FridayDomainError(
          "TS_RUNTIME_AGENT_RUNS_RETIRED",
          "Agent run execution is fail-closed while runtime ownership is being moved out of TypeScript.",
          {
            httpStatus: 503,
            details: {
              classification: "fail_closed",
              replacement: "rust_owned_agent_run_entrypoint_required",
            },
          },
        );
      }

      const principalId =
        typeof input.principalId === "string" && input.principalId.trim().length > 0
          ? input.principalId.trim()
          : undefined;
      if (input.apiIdempotencyKey && input.apiIdempotencyPayloadHash) {
        const scopedPrincipalId = principalId ?? "anonymous";
        const existingRun = deps.db.withReadConnection((db) =>
          agentRepo.findLatestByApiRequestIdempotencyKey(db, {
            principalId: scopedPrincipalId,
            idempotencyKey: input.apiIdempotencyKey!,
          }));
        if (existingRun) {
          const existingHash = readStoredIdempotencyPayloadHash(existingRun.metadata);
          if (existingHash && existingHash !== input.apiIdempotencyPayloadHash) {
            throwIdempotencyConflict(input.apiIdempotencyKey, "agent.runs.start");
          }
          return replayAgentRunResult(existingRun);
        }
      }
      const abortController = new AbortController();
      const runId = deps.idGenerator();
      agentAbortControllers.set(runId, abortController);

      try {
        return await executeAgentRunWithSessionContext!({
          task: input.task,
          taskPrompt: input.taskPrompt,
          runId,
          sessionKey: input.sessionKey,
          providerId: input.providerId,
          model: input.model,
          replyToMessageId: input.replyToMessageId,
          timezone: input.timezone,
          timeoutMs: input.timeoutMs,
          signal: abortController.signal,
          reviewRequired: input.requireReview,
          constraints: input.constraints,
          disabledToolNames: input.disabledToolNames,
          principalId,
          scopes: input.scopes,
          tenantContext: input.tenantContext,
          executionContext: input.executionContext,
          taskProfile: input.taskProfile,
          ...(input.apiIdempotencyKey && input.apiIdempotencyPayloadHash
            ? {
              apiRequestIdempotency: {
                operationId: "agent.runs.start",
                idempotencyKey: input.apiIdempotencyKey,
                payloadHash: input.apiIdempotencyPayloadHash,
                receivedAt: input.apiIdempotencyReceivedAt ?? deps.nowIso(),
                principalId: principalId ?? "anonymous",
              },
            }
            : {}),
          idempotencyPrefix: "api-agent-run",
        });
      } finally {
        agentAbortControllers.delete(runId);
      }
    };

    agentAutomationService = createFridayAgentAutomationService({
      db: deps.db,
      repository: createFridayAgentAutomationRepository(),
      startRun,
      idGenerator: deps.idGenerator,
      nowIso: deps.nowIso,
      learningEventWriter: deps.learningEventWriter,
      learningUserId: deps.learningUserId,
      resolveSourceSessionKey: (sourceRunId) =>
        deps.db.withReadConnection((db) => agentRepo.getById(db, sourceRunId)?.sessionKey ?? null),
    });
    const routeAutomationService: FridayAgentAutomationService =
      deps.allowTestOnlyAgentRunControlExecution === true
        ? agentAutomationService
        : {
          ...agentAutomationService,
          save: () => throwRetiredAgentRunControl(),
          update: () => throwRetiredAgentRunControl(),
          remove: () => throwRetiredAgentRunControl(),
          run: async () => throwRetiredAgentRunControl(),
        };

    // execrun-replacement S-F-compose (DARK): route a QUALIFYING agent-run through the
    // Rust read-only loop — behind the DEFAULT-OFF `routeAgentRunViaRust` flag.
    //
    // This wrapper is handed ONLY to createFridayAgentRoutes (the single startRun HTTP
    // route) — NOT to the automation-service copy (a non-route caller) above, and NOT to
    // the executeRun path the 7 non-route callers use. That is the structural half of the
    // route-not-method pin; the explicit `invokedFromHttpStartRunRoute: true` marker below
    // is the testable half.
    //
    // BYTE-IDENTICAL 503 GUARANTEE: the flag is checked FIRST. With the flag OFF (the
    // default), the predicate is not even evaluated and the wrapper calls the unchanged
    // `startRun(input)` → byte-identical to today (today's fail-closed 503 fires inside).
    // With the flag ON but the predicate DISQUALIFIED (e.g. no allowedRustRouteTools
    // grant, not DeepSeek-flash, sessioned, plan-review), the wrapper ALSO calls the
    // unchanged `startRun(input)` → the same 503. The ONLY divergence from today is a
    // flag-ON + fully-qualifying run, which is routed to Rust and NEVER touches `startRun`.
    //
    // Dark-substrate services are lazily constructed once (real constructors), overridable
    // via deps for mock-proven tests. They are consulted ONLY on the qualifying branch.
    // B1-compose (DARK): the PROVEN sealed WS client (real ECDH handshake) via its service
    // adapter. SIDE-EFFECT-FREE construction (no secret resolved, no socket opened here) — so the
    // DEFAULT-OFF route stays byte-identical to today (these services are built but never
    // consulted while the flag is off / a run is disqualified). host/port from config/env (default
    // 127.0.0.1 + the existing WS port env); the sealed client opens the socket lazily per dispatch.
    const rustWsClient =
      deps.rustAgentRunWsClient
      ?? createFridayRustHubAgentRunSealedClientService({
        host: process.env.FRIDAY_HUB_AGENT_RUN_WS_HOST ?? "127.0.0.1",
        port: readRustAgentRunWsPort(process.env.FRIDAY_HUB_AGENT_RUN_WS_PORT),
        // (A3 courier) Forward the DEFAULT-OFF run-control flag to the courier. When false (default)
        // the courier's paused/resume behavior is inert (byte-identical to today); when true it
        // admits a server `AgentRunPaused` (paused outcome) + relays an opaque approval. Resolved in
        // ONE place (`resolveAgentRunControlViaRust` in friday-hub-bootstrap.ts) → `deps`.
        ...(deps.agentRunControlViaRust === true ? { agentRunControlViaRust: true } : {}),
      });
    const rustContinuityProjector =
      deps.rustAgentRunContinuityProjector ?? createFridayRustHubRunContinuityProjectorService();
    const rustAnswerReadback =
      deps.rustAgentRunAnswerReadback ?? createFridayRustHubRunAnswerReadbackService();
    // B1-compose (DARK): the SecureStore X25519-SECRET resolver (the ECDH model) REPLACES #612's
    // symmetric session-key resolver. Default = the keychain-backed resolver; a null/short resolve
    // fails closed → no WS call, today's 503. Tests inject a fixture secret.
    const rustWsClientSecretResolver =
      deps.rustAgentRunWsClientSecretResolver ?? resolveRustAgentRunWsClientX25519Secret;
    const rustHubDbPath = deps.rustAgentRunHubDbPath ?? process.env.FRIDAY_HUB_AGENT_RUN_DB_PATH;
    const d20SignedBatchWorktreeService =
      deps.d20SignedBatchWorktreeService ?? createFridayD20SignedBatchWorktreeService();

    // OPERATOR ENV KNOBS for this dark Rust read-only execrun route (kept discoverable
    // together here, alongside the WS host/port + DB path siblings above):
    //   FRIDAY_HUB_AGENT_RUN_WS_HOST  — sealed-WS host  (default 127.0.0.1)        [above]
    //   FRIDAY_HUB_AGENT_RUN_WS_PORT  — sealed-WS port                              [above]
    //   FRIDAY_HUB_AGENT_RUN_DB_PATH  — Rust hub DB path for answer readback        [above]
    //   FRIDAY_ROUTE_AGENT_RUN_VIA_RUST — the master ON/OFF for routing a qualifying
    //     run to Rust (execrun slice 4). DEFAULT-OFF: unset/""/"0"/"false"/garbage → off;
    //     case-insensitive "1"/"true" → on. It is NOT read here — its resolve + precedence
    //     (an explicit HubConfig.routeAgentRunViaRust wins over the env) live in ONE place,
    //     `resolveRouteAgentRunViaRust` in friday-hub-bootstrap.ts, which feeds
    //     `deps.routeAgentRunViaRust`. The gate just below checks that resolved boolean.
    const routeStartRun: typeof startRun = async (input) => {
      if (deps.routeAgentRunViaRust === true) {
        // execrun prod-provider-shape fix: production provider rows carry UUID ids with
        // kind="deepseek", while test/RGG envs seed the literal id "deepseek". Clause 3 of
        // the predicate accepts EITHER the literal id OR a resolved record whose kind is
        // "deepseek" AND which is enabled. Resolve the record here — ONE cheap
        // read-by-id (`providerService.getProvider` → profile-repo getById; far cheaper
        // than the `resolveRoute` validation this same request already ran) — ONLY when
        // the literal doesn't already match (literal-id envs stay byte-identical, zero
        // extra reads). Fail-closed: unresolvable / lookup-throw / disabled /
        // non-deepseek-kind ⇒ the predicate disqualifies ⇒ today's unchanged TS path
        // (this resolution NEVER raises a new error class of its own).
        let resolvedProvider: { kind: string; enabled: boolean } | undefined;
        if (
          typeof input.providerId === "string"
          && input.providerId.trim().length > 0
          && input.providerId !== RUST_ROUTE_DEEPSEEK_PROVIDER_ID
        ) {
          try {
            const providerRecord = await deps.providerService.getProvider(input.providerId);
            if (providerRecord) {
              resolvedProvider = { kind: providerRecord.kind, enabled: providerRecord.enabled };
            }
          } catch {
            // Unresolvable ⇒ resolvedProvider stays undefined ⇒ clause 3 disqualifies.
          }
        }
        // The ONE qualification input, built ONCE and reused for BOTH the admission predicate
        // (`qualifiesForRustReadOnlyRoute`) AND the gated-mutating verdict
        // (`isGatedMutatingRustRouteRun`, which decides the `constraints.readOnly` we forward on
        // the wire). Sharing one object guarantees the two predicates see byte-identical inputs —
        // no field can drift between admission and the on-the-wire constraint.
        const rustRouteQualificationInput: RustRouteQualificationInput = {
          invokedFromHttpStartRunRoute: true,
          providerId: input.providerId,
          resolvedProvider,
          model: input.model,
          sessionKey: input.sessionKey,
          // (A2a Phase 1) the owner principal the relaxed clause-5 session sub-clause requires
          // for a SESSIONED run. The qualifier trims it; a blank/absent principal disqualifies
          // a sessioned run (fail-closed) and is a no-op for a sessionless run.
          principalId: input.principalId,
          requireReview: input.requireReview,
          constraints: input.constraints,
          taskProfile: input.taskProfile,
          allowedRustRouteTools: input.allowedRustRouteTools,
          planReviewOverride: input.planReviewOverride,
          // (A2b Phase 2, mutation-relax — DARK) the SAME default-off flag the Rust WS server
          // gates its pause/resume control plane on. With it false (the default) the qualifier's
          // clause-2/4 mutation relax is dead code and a `readOnly:false` run stays disqualified.
          agentRunControlViaRust: deps.agentRunControlViaRust,
          // The explicit positive mutating grant + operator-signed gate marker. Absent for every
          // existing caller (→ the mutating branch never opens). Consulted only behind the flag.
          mutatingToolGrant: input.mutatingToolGrant,
          mutationGate: input.mutationGate,
          missionContext: input.missionContext,
        };
        const qualifies = qualifiesForRustReadOnlyRoute(rustRouteQualificationInput);
        if (qualifies) {
          // execrun S-F carry-forward (DARK) — apiRequestIdempotencyKey REPLAY precedence.
          // The compose path mints a FRESH runId; without this guard two requests sharing
          // one `apiIdempotencyKey` would each mint a new runId → two agent_run/usage rows
          // (the projector's run_id-keyed dedup is per-run and does NOT catch this cross-
          // request case). So BEFORE minting + routing, mirror the SAME idempotency path the
          // bare `startRun` uses: if a prior run exists for this key, REPLAY it (no new WS
          // dispatch, no second projection) instead of routing a new run.
          const normalizedPrincipalId =
            typeof input.principalId === "string" && input.principalId.trim().length > 0
              ? input.principalId.trim()
              : undefined;
          if (input.apiIdempotencyKey && input.apiIdempotencyPayloadHash) {
            const scopedPrincipalId = normalizedPrincipalId ?? "anonymous";
            const existingRun = deps.db.withReadConnection((db) =>
              agentRepo.findLatestByApiRequestIdempotencyKey(db, {
                principalId: scopedPrincipalId,
                idempotencyKey: input.apiIdempotencyKey!,
              }),
            );
            if (existingRun) {
              const existingHash = readStoredIdempotencyPayloadHash(existingRun.metadata);
              if (existingHash && existingHash !== input.apiIdempotencyPayloadHash) {
                throwIdempotencyConflict(input.apiIdempotencyKey, "agent.runs.start");
              }
              // Faithful compose-path replay: the projector NEVER stores the answer body
              // (projector contract #3 — the row carries only a body REF), so we cannot
              // `replayAgentRunResult(existingRun)` (that would hand the caller the internal
              // `rust-run-body-ref:…` string, not their answer). Instead re-run the SAME
              // owner-gated readback (slice-3) for the EXISTING runId — no WS dispatch, no
              // re-projection — and return the owner-released body. Owner principal absent /
              // body non-delivered ⇒ fail closed (same 503 the compose raises).
              const callerPrincipal = normalizedPrincipalId;
              if (!callerPrincipal) {
                throw failClosedRustAgentRun();
              }
              if (!rustHubDbPath) {
                throw failClosedRustAgentRun();
              }
              const replayReadback = await rustAnswerReadback.readAnswer({
                dbPath: rustHubDbPath,
                runId: existingRun.id,
                callerPrincipal,
              });
              if (replayReadback.outcome !== "delivered") {
                throw failClosedRustAgentRun();
              }
              return {
                runId: existingRun.id,
                status: existingRun.status,
                response: replayReadback.answer,
                toolCallCount: 0,
                durationMs: existingRun.durationMs ?? 0,
                usageInput: existingRun.usageInput ?? 0,
                usageOutput: existingRun.usageOutput ?? 0,
                finalResponse: replayReadback.answer,
              };
            }
          }

          // Qualifying run: route via Rust. Fail-closed on missing key / WS / readback /
          // projector — this NEVER falls through to the TS `startRun`. providerId/model
          // are guaranteed defined here (the predicate required an exact admitted route shape),
          // but coalesce defensively to satisfy the type.
          return composeRustReadOnlyAgentRun({
            runId: deps.idGenerator(),
            task: input.task,
            // Owner-binding keys on the NORMALIZED principal — the SAME value the idempotency
            // lookup (above), the owner-gated readback, and the stamp use — so all four agree on
            // one canonical owner string (a blank/whitespace principal ⇒ undefined ⇒ fail-closed,
            // matching the bare startRun which normalizes throughout). Robust to future auth
            // issuance even if a principalId ever arrives non-canonical.
            principalId: normalizedPrincipalId,
            // (A2a Phase 1) forward the session key so a SESSIONED qualifying run dispatches
            // `session_id`; absent/blank ⇒ byte-identical sessionless dispatch (today's behavior).
            sessionKey: input.sessionKey,
            // (A1 run-controls + A2b mutation-relax) Derive the per-run `readOnly` constraint to
            // forward on the wire from the SAME verdict the qualifier validated (one shared
            // predicate — `isGatedMutatingRustRouteRun` — so admission + the wire constraint can
            // NEVER diverge):
            //   • READ-ONLY run (today's behavior, byte-identical): clause 2 REQUIRED
            //     `constraints.readOnly === true`, so forward `{ readOnly: true }` — the read-only
            //     guarantee travels on the wire + is enforced in Rust (defense-in-depth), not only
            //     by this TS qualifier. UNCHANGED — no degrade.
            //   • GATED MUTATING run (A2b, dark/default-off): forward `{ readOnly: false }` — the
            //     REAL constraint the qualifier validated. The wire `read_only` is then OMITTED
            //     (`buildConstraintsWire` never emits `read_only:false`), so the Rust RunPolicy is
            //     NOT read-only and the granted mutating tool FIRES → the runtime gate evaluates it
            //     → withholds the (default-absent) approval → PAUSES, surfacing the courier's
            //     paused outcome. The `mutatingToolGrant` is NOT a wire field (the constraints/wire
            //     are restriction-only by design); it is the TS-side ADMISSION gate the qualifier
            //     enforces, and the Rust gate pauses every mutating action regardless.
            // The disabled-tool / max-turns axes are not asserted by this route, so they stay
            // absent (omitted on the wire). The server gates application behind its default-off
            // run-control flag, so this remains DARK + DEPLOY-GO-gated.
            constraints: { readOnly: !isGatedMutatingRustRouteRun(rustRouteQualificationInput) },
            providerId: input.providerId ?? RUST_ROUTE_DEEPSEEK_PROVIDER_ID,
            model: input.model ?? RUST_ROUTE_DEEPSEEK_FLASH_MODEL,
            wsClient: rustWsClient,
            projector: rustContinuityProjector,
            readback: rustAnswerReadback,
            clientSecretResolver: rustWsClientSecretResolver,
            hubDbPath: rustHubDbPath,
            db: deps.db,
            nowIso: deps.nowIso,
            // (NS45-PR2 mission-bound driver — DARK) forward the Mission handle so the sealed-WS
            // dispatch emits the `mission_context` wire block when present (absent ⇒ omitted ⇒
            // byte-identical unbound dispatch). This is part of `rustRouteQualificationInput` for
            // mission-bound Codex/Claude routes, but only as a selector: it does not touch
            // `principalId`; the bound owner stays the authenticated `normalizedPrincipal`, and
            // Rust re-validates the Mission/WorkItem binding before producing proof/readback.
            ...(input.missionContext !== undefined ? { missionContext: input.missionContext } : {}),
            ...(input.organicProvenance !== undefined ? { organicProvenance: input.organicProvenance } : {}),
            // Stamp the apiRequest idempotency descriptor onto the projected row so a
            // SUBSEQUENT request sharing this key REPLAYS this run (the lookup above) rather
            // than minting a second runId. Mirrors the EXACT shape the bare startRun persists
            // (`metadata.apiRequest.{principalId,idempotencyKey,payloadHash}`), so both
            // `findLatestByApiRequestIdempotencyKey` and the `payloadHash` conflict check work.
            ...(input.apiIdempotencyKey && input.apiIdempotencyPayloadHash
              ? {
                apiRequestIdempotency: {
                  operationId: "agent.runs.start",
                  principalId: normalizedPrincipalId ?? "anonymous",
                  idempotencyKey: input.apiIdempotencyKey,
                  payloadHash: input.apiIdempotencyPayloadHash,
                  receivedAt: input.apiIdempotencyReceivedAt ?? deps.nowIso(),
                },
              }
              : {}),
          });
        }
      }
      // Flag off OR disqualified → today's unchanged path (byte-identical 503 inside).
      return startRun(input);
    };
    // (Organic mission→run binding PRODUCER — DARK) Publish the ROUTING `startRun` (this wrapper, NOT
    // the bare `startRun` nor the automation copy) so bootstrap can hand the mission auto-dispatch
    // driver the SAME entrypoint the HTTP startRun route uses. Additive + default-OFF: nothing reads
    // this ref unless the driver is constructed (behind two default-OFF flags).
    routeStartRunRef = routeStartRun;

    // (S6 mutating-chat — DARK, default-off) Runtime-level RESUME relay handed to the resume HTTP
    // route. The route already (1) flag-gated on `deps.agentRunControlViaRust` BEFORE any run lookup
    // and (2) enforced caller == the run's bound owner, so this fn is reached ONLY for an
    // owner-authorized resume on a flag-on host. It is the pure courier's transport half: resolve
    // the SecureStore X25519 client secret (the SAME ECDH secret the dispatch path uses), then dial
    // the sealed-WS `resumeWithApproval`, relaying the OPAQUE blob VERBATIM (INV-1: it inspects
    // NOTHING inside the blob; verification happens ONLY in Rust under the operator verify key).
    // Fails CLOSED to the byte-identical retired 503 on a missing/short secret OR any WS error — it
    // NEVER falls through to a TS-side resume (there is none). Returns the refs-only outcome.
    const routeResumeRun = async (
      runId: string,
      opaqueSignedBlob: Uint8Array,
      _principal: FridayAuthPrincipal | null,
    ): Promise<FridayResumeAgentRunResponse> => {
      // Defense-in-depth: even though the route flag-gated already, re-check here so this fn can
      // NEVER relay while the control plane is off (a future caller can't bypass the dark posture).
      if (deps.agentRunControlViaRust !== true) {
        throw failClosedRustAgentRun();
      }
      // Resolve the X25519 client SECRET fail-closed BEFORE any WS connection (a non-32-byte secret
      // ⇒ the byte-identical 503; never open an unauthenticated WS, never log the key).
      const clientSecret = rustWsClientSecretResolver();
      if (!clientSecret || clientSecret.length !== 32) {
        throw failClosedRustAgentRun();
      }
      let outcome: FridayRustHubAgentRunResumeResult;
      try {
        outcome = await rustWsClient.resumeWithApproval({
          runId,
          clientSecret,
          // INV-1: the OPAQUE operator-signed blob is relayed VERBATIM — the courier authors nothing.
          opaqueSignedBlob,
        });
      } catch {
        // Any sealed-WS failure (flag-off inner client, transport, refused) ⇒ the byte-identical
        // 503; never a partial / TS-side resume.
        throw failClosedRustAgentRun();
      }
      return {
        runId: outcome.runId,
        op: outcome.op,
        accepted: outcome.accepted,
        status: outcome.status,
        ...(outcome.auditRef !== undefined ? { auditRef: outcome.auditRef } : {}),
      };
    };

    for (const route of createFridayAgentRoutes({
      validateRequestedRoute: async (providerId, model, tenantContext) => {
        await deps.providerService.resolveRoute(model, providerId, {
          tenantContext,
          autoValidate: true,
        });
      },
      startRun: routeStartRun,
      getRun: (runId) => {
        return deps.db.withReadConnection((db) =>
          enrichAgentRun(agentRepo.getById(db, runId)),
        );
      },
      listRuns: (query) => {
        return deps.db.withReadConnection((db) =>
          agentRepo.list(db, query).map((run) => enrichAgentRun(run)),
        );
      },
      listRunEvents: (runId, afterSeq) => {
        return deps.db.withReadConnection((db) =>
          agentRunEventRepo.list(db, runId, afterSeq),
        );
      },
      cancelRun: (runId) => {
        if (deps.allowTestOnlyAgentRunControlExecution !== true) {
          void runId;
          throwRetiredAgentRunControl();
        }
        const controller = agentAbortControllers.get(runId);
        if (controller) {
          controller.abort(new Error("Cancelled via API"));
          agentAbortControllers.delete(runId);
        }
      },
      approvePlan: async (input) => {
        if (deps.allowTestOnlyAgentRunControlExecution !== true) {
          void input;
          throwRetiredAgentRunControl();
        }
        if (!agentPlanningGate) {
          throw new FridayDomainError("AGENT_PLAN_NOT_AVAILABLE", "Planning gate is not available", { httpStatus: 501 });
        }
        const result = await agentPlanningGate.approvePlan(input);
        const { runId } = input;
        const run = deps.db.withReadConnection((db) => agentRepo.getById(db, runId));
        if (run?.sessionKey) {
          await sessionService.addMessage(run.sessionKey, {
            role: "assistant",
            content: result.response,
            contentText: result.response,
            idempotencyKey: `agent-run:${result.runId}:response`,
          }).catch(() => undefined);
          const currentFocus = await sessionService.getConversationFocus(run.sessionKey).catch(() => null);
          const nextPendingPlanRunId = result.status === "awaiting_clarification"
            || result.status === "awaiting_plan_approval"
            ? result.runId
            : null;
          await sessionService.setConversationFocus(
            run.sessionKey,
            finalizeFridayConversationFocus({
              task: run.task,
              responseText: result.response,
              runId: result.runId,
              turnKind: result.status === "awaiting_clarification"
                ? "clarification"
                : "continue_active_task",
              focusState: currentFocus,
              pendingPlanRunId: nextPendingPlanRunId,
              nowIso: deps.nowIso(),
            }),
          ).catch(() => undefined);
        }
        return result;
      },
      rejectPlan: async (input) => {
        if (deps.allowTestOnlyAgentRunControlExecution !== true) {
          void input;
          throwRetiredAgentRunControl();
        }
        if (!agentPlanningGate) {
          throw new FridayDomainError("AGENT_PLAN_NOT_AVAILABLE", "Planning gate is not available", { httpStatus: 501 });
        }
        const result = agentPlanningGate.rejectPlan(input);
        const { runId } = input;
        const run = deps.db.withReadConnection((db) => agentRepo.getById(db, runId));
        if (run?.sessionKey) {
          await sessionService.addMessage(run.sessionKey, {
            role: "assistant",
            content: result.response,
            contentText: result.response,
            idempotencyKey: resolveAgentMirrorIdempotencyKey({
              runId: result.runId,
              kind: "planning-reject",
            }),
          }).catch(() => undefined);
          const currentFocus = await sessionService.getConversationFocus(run.sessionKey).catch(() => null);
          await sessionService.setConversationFocus(run.sessionKey, {
            ...(currentFocus ?? { updatedAt: deps.nowIso() }),
            pendingPlanRunId: undefined,
            updatedAt: deps.nowIso(),
          }).catch(() => undefined);
        }
        return result;
      },
      resolveToolApproval: (runId, toolCallId, approved, options) => {
        if (deps.allowTestOnlyAgentRunControlExecution !== true) {
          void runId;
          void toolCallId;
          void approved;
          void options;
          throwRetiredAgentRunControl();
        }
        return deps.resolveToolApproval
          ? deps.resolveToolApproval(runId, toolCallId, approved, options)
          : { resolved: false };
      },
      rollbackRun: (runId) => {
        if (deps.allowTestOnlyAgentRunControlExecution !== true) {
          void runId;
          throwRetiredAgentRunControl();
        }
        return deps.agentRuntime!.rollbackRun?.(runId) ?? null;
      },
      eventEmitter: deps.agentEventEmitter,
      automationService: routeAutomationService,
      // (S6 mutating-chat — DARK, default-off) the SAME resolved control-plane flag the Rust server
      // + sealed client gate on. With it off (the default), the resume route SHORT-CIRCUITS to the
      // byte-identical retired 503 before any run lookup; on, it relays an owner-authorized resume.
      agentRunControlViaRust: deps.agentRunControlViaRust,
      resumeRun: routeResumeRun,
      d20SignedBatchWorktreeViaRust: deps.d20SignedBatchWorktreeViaRust,
      dispatchD20SignedBatchWorktree: (input) => d20SignedBatchWorktreeService.dispatch(input),
    })) {
      routes.register(route);
    }
  }

  // Register sub-agent routes (optional — only if subagentRegistry is provided)
  if (deps.subagentRegistry) {
    for (const route of createFridaySubagentRoutes({
      subagentRegistry: deps.subagentRegistry,
      getRun: agentRepo
        ? (runId) =>
          deps.db.withReadConnection((db) =>
            enrichAgentRun(agentRepo.getById(db, runId)),
          )
        : undefined,
    })) {
      routes.register(route);
    }
  }

  // Register unified asset inventory routes (composed from runtime-local services)
  for (const route of createFridayAssetInventoryRoutes({
    subjectInventory: autonomyInventory,
    listLearnedFacts: deps.uix?.listLearnedFacts
      ? (input) => deps.uix!.listLearnedFacts!({ userId: input.userId })
      : undefined,
    deleteLearnedFact: deps.uix?.deleteLearnedFact,
    listAutomations: agentAutomationService
      ? () => agentAutomationService!.list({})
      : undefined,
  })) {
    routes.register(route);
  }

  return {
    // Exposed so the CLI run loop can build the durable HTTP idempotency journal store
    // from the SAME app db (no second db invented).
    db: deps.db,
    auth: authService,
    tokenValidator,
    rateLimiter,
    middleware,
    eventBus,
    subscriptions,
    wsGateway,
    fleet,
    conflicts,
    routes,
    autonomyPolicyService,
    capabilityAcquisitionService,
    standingAgendaService,
    workflowCrud: workflowRuntime.crud,
    workflowExecution: workflowRuntime.execution,
    draftService: builderRuntime.drafts,
    providerService: deps.providerService,
    memoryService: deps.memoryService,
    memoryGuardFactory,
    sessionService,
    extractionService,
    skillGenerator: deps.skillGenerator,
    converterService: deps.converterService,
    workflowGenerator: deps.workflowGenerator,
    pluginService: deps.pluginService,
    agentRuntime: deps.agentRuntime,
    agentEventEmitter: deps.agentEventEmitter,
    agentAutomationService,
    // (Organic mission→run binding PRODUCER — DARK) Expose the ROUTING startRun so bootstrap can
    // hand the mission auto-dispatch driver the SAME route-qualifying entrypoint. Undefined when the
    // agent runtime/emitter are absent ⇒ the driver no-ops (default-OFF safe).
    agent: { startRun: routeStartRunRef },
    mcpServer: deps.mcpServer,
    deterministicPipeline: deps.deterministicPipeline,
    diagnosis: deps.diagnosis,
    autoFix: deps.autoFix,
    agentLoop: deps.agentLoop,
    uix: deps.uix,
    missionSpine: deps.missionSpine,
    memorySpine: deps.memorySpine,
    runOutcomeLearning: deps.runOutcomeLearning,
    system: deps.system,
    guideLens: deps.guideLens,
  };
}

import { createHash } from "node:crypto";
import { join } from "node:path";

import { FridayDomainError } from "#errors";
import { createFridayMemoryGuardServiceFactory, createFridayMemoryItemRepository } from "#memory";
import type { FridaySqliteLayer } from "#state";
import {
  createFridaySecretAdminService,
  createFridaySecretRepository,
  decryptSecret,
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
  JsonObject,
} from "#workflows";

import { classifyFridayExecution } from "../../sessions/services/friday-execution-classifier.js";
import { dispatchDeterministic } from "../../sessions/services/friday-deterministic-dispatch.js";
import type { FridayDeterministicDispatchDeps } from "../../sessions/services/friday-deterministic-dispatch.js";
import { dispatchManagedAsync } from "../../sessions/services/friday-managed-async-dispatch.js";
import type { FridayManagedAsyncDispatchDeps } from "../../sessions/services/friday-managed-async-dispatch.js";
import { parseFridayReflexExplicitPreferenceMessage } from "../../reflex/index.js";
import type { CreateFridayApiRuntimeDeps, FridayApiRuntime } from "./friday-api-runtime.types.js";
import { createFridayAuthService } from "../auth/friday-auth-service.js";
import { createFridayTokenValidator } from "../auth/friday-token-validator.js";
import { createFridayRateLimitService } from "../auth/friday-rate-limit-service.js";
import { createFridayAuthMiddlewareFactory } from "../auth/friday-auth-middleware.js";
import { createFridayAuthSessionRepository } from "../persistence/friday-auth-session-repository.js";
import { createFridayRealtimeEventBus } from "../realtime/friday-realtime-event-bus.js";
import { createFridayRealtimeEventRepository } from "../persistence/friday-realtime-event-repository.js";
import { createFridayRealtimeCheckpointRepository } from "../persistence/friday-realtime-checkpoint-repository.js";
import { createFridayRealtimeSubscriptionService } from "../realtime/friday-realtime-subscription-service.js";
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
        return decryptSecret(envelope, getStrictMasterKey());
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
  });

  const wsGateway = createFridayRealtimeWsGateway({
    tokenValidator,
    subscriptionService: subscriptions,
    eventBus,
    nowIso: deps.nowIso,
    serverVersion,
    currentEpoch: CURRENT_EPOCH,
  });

  const publishWorkflowRealtimeEvent = async (
    event: string,
    payload: unknown,
  ): Promise<void> => {
    const normalizedPayload = asRecord(payload);
    const streamId = resolveWorkflowRealtimeStreamId(event, normalizedPayload);
    if (!streamId) {
      return;
    }

    eventBus.publish(
      streamId,
      event as never,
      normalizedPayload as never,
    );
  };

  // Fleet
  const fleet = createFridayFleetDashboardService({
    db: deps.db,
    nowIso: deps.nowIso,
    idGenerator: deps.idGenerator,
    outboxQueueService: deps.outboxQueueService,
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
  });
  const capabilityAcquisitionService = createFridayCapabilityAcquisitionService({
    db: deps.db,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    policyService: autonomyPolicyService,
    capabilitySnapshotGetter: deps.capabilitySnapshotGetter,
  });
  const standingAgendaService = createFridayStandingAgendaService({
    db: deps.db,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    policyService: autonomyPolicyService,
    acquisitionService: capabilityAcquisitionService,
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

  // Register workflow routes (real service wiring)
  for (const route of createFridayWorkflowRoutes({
    allowTestOnlyWorkflowCatalogMutationExecution: deps.allowTestOnlyWorkflowCatalogMutationExecution,
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
        visual: input.visual,
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
        visual: input.visual,
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
  for (const route of createFridayFleetRoutes({ fleetService: fleet, canonicalMutationGate })) {
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
        db.prepare(
          "UPDATE satellites SET pairing_status = 'revoked', updated_at = ? WHERE id = ?",
        ).run(deps.nowIso(), satelliteId);
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
  })) {
    routes.register(route);
  }

  // Register grant routes (always available)
  for (const route of createFridayGrantRoutes({
    async listActiveGrants() {
      return deps.db.withReadConnection((reader) => {
        const now = new Date().toISOString();
        const rows = reader.prepare(`
          SELECT id, principal_id, target, surface, scopes, issued_at, expires_at, tool_name
          FROM capability_grants
          WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
        `).all(now) as Array<Record<string, unknown>>;
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
    ? createFridayDiscoveryRoutes(deps.discovery)
    : createFridayDiscoveryDisabledRoutes()) {
    routes.register(route as unknown as Parameters<typeof routes.register>[0]);
  }

  // Register discovery integration route (always registered; disabled when deps absent)
  for (const route of createFridayDiscoveryIntegrationRoutes({
    discovery: deps.discovery?.discovery ?? null,
    converterService: deps.converterService ?? null,
    canonicalMutationGate: deps.discovery ? canonicalMutationGate : null,
    disabledReason: deps.discovery ? null : "discovery service not provided",
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

  // Register realtime routes
  for (const route of createFridayRealtimeRoutes({
    subscriptionService: subscriptions,
    currentEpoch: CURRENT_EPOCH,
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

  // Register provider routes (BYOK)
  for (const route of createFridayProviderRoutes({
    providerService: deps.providerService,
    canonicalMutationGate,
    providerMutationGateRequired,
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
    })) {
      routes.register(route);
    }
  }

  // Register workflow generator routes (optional — only if service is provided)
  if (deps.workflowGenerator) {
    for (const route of createFridayWorkflowGeneratorRoutes({
      workflowGenerator: deps.workflowGenerator,
      allowTestOnlyWorkflowGeneratorExecution: deps.allowTestOnlyWorkflowGeneratorExecution,
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
  for (const route of createFridaySessionUsageRoutes({ db: deps.db })) {
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
    })) {
      routes.register(route);
    }
  }

  // Register agent routes (optional — only if runtime and emitter are provided)
  let agentAutomationService: FridayAgentAutomationService | undefined;
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

    for (const route of createFridayAgentRoutes({
      validateRequestedRoute: async (providerId, model, tenantContext) => {
        await deps.providerService.resolveRoute(model, providerId, {
          tenantContext,
          autoValidate: true,
        });
      },
      startRun,
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
    mcpServer: deps.mcpServer,
    deterministicPipeline: deps.deterministicPipeline,
    diagnosis: deps.diagnosis,
    autoFix: deps.autoFix,
    agentLoop: deps.agentLoop,
    uix: deps.uix,
    missionSpine: deps.missionSpine,
    system: deps.system,
    guideLens: deps.guideLens,
  };
}

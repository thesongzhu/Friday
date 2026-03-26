import type {
  FridayGeneratedWorkflowDraft,
  FridayStableWorkflowTemplate,
  FridayWorkflowEntity,
  FridayWorkflowGenerationSession,
  FridayWorkflowGenerationTurn,
  FridayWorkflowImportResult,
  FridayWorkflowRunEntity,
  FridayWorkflowRunEvidenceExport,
  FridayWorkflowRunEvidenceExportDownload,
  FridayWorkflowRunEvidenceExportRecord,
  FridayWorkflowRunEvidenceQuery,
  FridayWorkflowRunEvidenceResponse,
  FridayWorkflowRunNodeEntity,
  FridayWorkflowSpecBundleV1,
  FridayWorkflowTemplateEntity,
  FridayWorkflowVersionEntity,
  ISODateTime,
  JsonObject,
  JsonValue,
  NodeAttemptStatus,
  UUID,
  WorkflowRunStatus,
} from "#workflows";
import type { FridayCompiledWorkflowGraphV2, FridayWorkflowBuilderValidationReport, FridayWorkflowDraftEntity, FridayWorkflowSpecV1, FridayWorkflowVisualGraphV1 } from "#workflows";
import type { FridayAgentTaskProfileId } from "#agent";
import type { FridayPage, FridayPaginationQuery } from "./friday-api-common.types.js";

// Re-export needed types
export type {
  FridayWorkflowEntity,
  FridayWorkflowVersionEntity,
  FridayWorkflowRunEntity,
  FridayWorkflowRunNodeEntity,
  FridayWorkflowRunEvidenceExport,
  FridayWorkflowRunEvidenceExportDownload,
  FridayWorkflowRunEvidenceExportRecord,
  FridayWorkflowRunEvidenceQuery,
  FridayWorkflowRunEvidenceResponse,
  WorkflowRunStatus,
  NodeAttemptStatus,
  FridayWorkflowDraftEntity,
  FridayWorkflowBuilderValidationReport,
  FridayCompiledWorkflowGraphV2,
  FridayWorkflowSpecV1,
  FridayWorkflowVisualGraphV1,
  FridayWorkflowTemplateEntity,
  FridayStableWorkflowTemplate,
  FridayWorkflowImportResult,
  FridayWorkflowSpecBundleV1,
};

// ─── Workflow CRUD ───

export interface FridayListWorkflowsQuery extends FridayPaginationQuery {
  tag?: string;
  archived?: boolean;
}
export interface FridayListWorkflowsResponse extends FridayPage<FridayWorkflowEntity> {}

/** A raw authoring graph — just nodes and edges arrays without compiled metadata. */
export interface FridayRawWorkflowGraph {
  [key: string]: unknown;
  nodes: unknown[];
  edges: unknown[];
}

export interface FridayCreateWorkflowRequest {
  slug: string;
  name: string;
  description?: string;
  tags?: string[];
  graph: FridayCompiledWorkflowGraphV2 | FridayRawWorkflowGraph;
}
export interface FridayCreateWorkflowResponse {
  workflow: FridayWorkflowEntity;
  version: FridayWorkflowVersionEntity;
}

export interface FridayGetWorkflowResponse {
  workflow: FridayWorkflowEntity;
  latestVersion: FridayWorkflowVersionEntity;
  publishedVersion?: FridayWorkflowVersionEntity;
}

export interface FridayGetWorkflowVersionResponse {
  version: FridayWorkflowVersionEntity;
}

export interface FridayUpdateWorkflowRequest {
  expectedRevision: number;
  etag: string;
  name?: string;
  description?: string;
  tags?: string[];
  graph?: FridayCompiledWorkflowGraphV2 | FridayRawWorkflowGraph;
}
export interface FridayUpdateWorkflowResponse {
  workflow: FridayWorkflowEntity;
  version?: FridayWorkflowVersionEntity;
}

export interface FridayArchiveWorkflowResponse {
  archived: true;
}

export interface FridayPublishWorkflowRequest {
  versionNumber?: number;
  changeNote?: string;
}
export interface FridayPublishWorkflowResponse {
  publishedVersion: FridayWorkflowVersionEntity;
}

export interface FridayListVersionsQuery extends FridayPaginationQuery {}
export interface FridayListVersionsResponse extends FridayPage<FridayWorkflowVersionEntity> {}

// ─── Builder / Draft CRUD ───

export interface FridayCreateDraftRequest {
  title: string;
  spec: FridayWorkflowSpecV1;
  visual: FridayWorkflowVisualGraphV1;
  ownerUserId?: UUID;
  baseWorkflowVersionId?: UUID;
}
export interface FridayCreateDraftResponse {
  draft: FridayWorkflowDraftEntity;
}

export interface FridayListDraftsResponse extends FridayPage<FridayWorkflowDraftEntity> {}

export interface FridayListWorkflowBuilderTemplatesResponse {
  items: FridayWorkflowTemplateEntity[];
  stableItems: FridayStableWorkflowTemplate[];
}

export interface FridayGetWorkflowBuilderTemplateResponse {
  template: FridayWorkflowTemplateEntity;
}

export interface FridayInstantiateWorkflowBuilderTemplateRequest {
  workflowId: UUID;
  title: string;
  ownerUserId?: UUID;
  taskProfileId?: FridayAgentTaskProfileId;
}

export interface FridayInstantiateWorkflowBuilderTemplateResponse {
  draft: FridayWorkflowDraftEntity;
}

export interface FridayGetDraftResponse {
  draft: FridayWorkflowDraftEntity;
}

export interface FridayExportDraftBundleResponse {
  bundle: FridayWorkflowSpecBundleV1;
}

export interface FridayImportWorkflowBundleRequest {
  bundle: FridayWorkflowSpecBundleV1;
  ownerUserId?: UUID;
  force?: boolean;
}

export interface FridayImportWorkflowBundleResponse {
  result: FridayWorkflowImportResult;
}

export interface FridaySaveDraftRequest {
  expectedRevision: number;
  lockToken: string;
  title?: string;
  spec?: FridayWorkflowSpecV1;
  visual?: FridayWorkflowVisualGraphV1;
  autosave?: {
    enabled?: boolean;
    intervalMs?: number;
  };
}
export interface FridaySaveDraftResponse {
  draft: FridayWorkflowDraftEntity;
}

export interface FridayAutosaveDraftRequest {
  lockToken: string;
  spec: FridayWorkflowSpecV1;
  visual: FridayWorkflowVisualGraphV1;
}
export interface FridayAutosaveDraftResponse {
  draft: FridayWorkflowDraftEntity | null;
}

export interface FridayCompileDraftResponse {
  compiled: FridayCompiledWorkflowGraphV2;
  validation: FridayWorkflowBuilderValidationReport;
}

export interface FridayPublishDraftRequest {
  workflowId: UUID;
  lockToken: string;
  createdByUserId?: UUID;
  changeNote?: string;
  publishNow: boolean;
}
export interface FridayPublishDraftResponse {
  workflowId: UUID;
  workflowVersionId: UUID;
  versionNumber: number;
  published: boolean;
  checksum: string;
  validation: FridayWorkflowBuilderValidationReport;
}

export interface FridayWorkflowDeployEvidenceSummary {
  incidentId?: string;
  runId?: UUID;
  exportedBundleChecksum?: string;
  exportedAt?: ISODateTime;
  traceSummary: string;
}

export interface FridayWorkflowDeployResult {
  workflowId: UUID;
  draftId: UUID;
  workflowVersionId: UUID;
  versionNumber: number;
  published: boolean;
  triggerSync: {
    requested: boolean;
    synced: boolean;
  };
  validation: FridayWorkflowBuilderValidationReport;
  run?: FridayWorkflowRunEntity;
  exportBundle?: {
    bundleSchemaVersion: string;
    exportedAt: ISODateTime;
    checksum: string;
    sourceType: "draft" | "workflow_version";
    sourceId: UUID;
    workflowId: UUID;
  };
  evidence: FridayWorkflowDeployEvidenceSummary;
}

export interface FridayWorkflowOverview {
  workflow: FridayWorkflowEntity;
  latestVersion?: FridayWorkflowVersionEntity;
  publishedVersion?: FridayWorkflowVersionEntity;
  drafts: FridayWorkflowDraftEntity[];
  latestDraft?: FridayWorkflowDraftEntity;
  recentRuns: FridayWorkflowRunEntity[];
  latestRun?: FridayWorkflowRunEntity;
  latestRunNodeTimeline: Array<{
    nodeId: string;
    attempt: number;
    status: string;
    message?: string;
    finishedAt?: ISODateTime;
  }>;
  latestEvidenceExports: FridayWorkflowRunEvidenceExport[];
  versionHistory: FridayWorkflowVersionEntity[];
}

export interface FridayWorkflowVisualization {
  workflow: FridayWorkflowEntity;
  targetKind: "draft" | "published_version" | "version";
  draft?: FridayWorkflowDraftEntity;
  version?: FridayWorkflowVersionEntity;
  spec: FridayWorkflowSpecV1;
  visual: FridayWorkflowVisualGraphV1;
  latestRun?: FridayWorkflowRunEntity;
  recentRuns: FridayWorkflowRunEntity[];
  nodeTimeline: Array<{
    nodeId: string;
    attempt: number;
    status: string;
    message?: string;
    finishedAt?: ISODateTime;
  }>;
  latestEvidenceExports: FridayWorkflowRunEvidenceExport[];
}

export interface FridayAssistantWorkflowCard {
  kind: "session_started" | "draft_ready" | "deployment_result" | "export_ready" | "blocked";
  workflowId?: UUID;
  workflowName: string;
  draftId?: UUID;
  sessionId?: string;
  summary: string;
  routeTarget: "/assistant" | "/workflows";
  deployReady: boolean;
  questions?: string[];
  latestRun?: FridayWorkflowRunEntity;
  exportBundle?: FridayWorkflowDeployResult["exportBundle"];
  evidence?: FridayWorkflowDeployEvidenceSummary;
}

// ─── Collaboration Locks ───

export interface FridayAcquireWorkflowLockRequest {
  ownerUserId: UUID;
  ownerSessionId?: string;
  ttlSec: number;
}

export interface FridayAcquireWorkflowLockResponse {
  acquired: boolean;
  lock?: {
    workflowId: UUID;
    lockToken: string;
    ownerUserId: UUID;
    ownerSessionId?: string;
    acquiredAt: ISODateTime;
    heartbeatAt: ISODateTime;
    expiresAt: ISODateTime;
  };
  conflict?: {
    workflowId: UUID;
    lockToken: string;
    ownerUserId: UUID;
    ownerSessionId?: string;
    acquiredAt: ISODateTime;
    heartbeatAt: ISODateTime;
    expiresAt: ISODateTime;
  };
}

export interface FridayRenewWorkflowLockRequest {
  lockToken: string;
  ttlSec: number;
}
export interface FridayRenewWorkflowLockResponse {
  lock: FridayAcquireWorkflowLockResponse["lock"];
}

export interface FridayReleaseWorkflowLockRequest {
  lockToken: string;
}
export interface FridayReleaseWorkflowLockResponse {
  released: true;
}

// ─── Conflict Resolution ───

export type FridayWorkflowConflictStatus = "open" | "resolved" | "dismissed";
export type FridayWorkflowConflictKind = "revision_conflict" | "lock_conflict";

export interface FridayWorkflowConflictEntity {
  conflictId: UUID;
  workflowId: UUID;
  draftId: UUID;
  kind: FridayWorkflowConflictKind;
  status: FridayWorkflowConflictStatus;
  baseWorkflowVersionId?: UUID;
  headWorkflowVersionId: UUID;
  detectedAt: ISODateTime;
  resolvedAt?: ISODateTime;
  resolvedByUserId?: UUID;
  summary: string;
  patches: Array<{
    path: string;
    op: "add" | "remove" | "replace";
    baseValue?: JsonValue;
    localValue?: JsonValue;
    headValue?: JsonValue;
  }>;
}

export interface FridayListWorkflowConflictsQuery extends FridayPaginationQuery {
  status?: FridayWorkflowConflictStatus;
}
export interface FridayListWorkflowConflictsResponse extends FridayPage<FridayWorkflowConflictEntity> {}

export interface FridayResolveWorkflowConflictRequest {
  resolution:
    | { strategy: "accept_local" }
    | { strategy: "accept_remote" }
    | {
        strategy: "manual_merge";
        mergedSpec: FridayWorkflowSpecV1;
        mergedVisual: FridayWorkflowVisualGraphV1;
      };
  lockToken: string;
  expectedDraftRevision: number;
}
export interface FridayResolveWorkflowConflictResponse {
  conflict: FridayWorkflowConflictEntity;
  draft: FridayWorkflowDraftEntity;
}

// ─── Workflow Generator ───

export interface FridayWorkflowGeneratorCreateSessionRequest {
  goal: string;
  requestedModel?: string;
  userId: string;
  channel: string;
}

export interface FridayWorkflowGeneratorSubmitMessageRequest {
  message: string;
  requestedModel?: string;
}

export interface FridayWorkflowGeneratorGenerateRequest {
  requestedModel?: string;
}

export { type FridayWorkflowGenerationTurnResponse as FridayWorkflowGeneratorStartSessionResponse } from "#workflows";
export { type FridayWorkflowGenerationTurnResponse as FridayWorkflowGeneratorSubmitMessageResponse } from "#workflows";

export interface FridayWorkflowGeneratorGetSessionResponse {
  session: FridayWorkflowGenerationSession;
  turns: FridayWorkflowGenerationTurn[];
  draft?: FridayGeneratedWorkflowDraft;
}

export interface FridayWorkflowGeneratorGenerateResponse {
  draft: FridayGeneratedWorkflowDraft;
}

export interface FridayWorkflowGeneratorApproveResponse {
  sessionId: string;
  workflowId: string;
  workflowVersionId: string;
  versionNumber: number;
  slug: string;
  published: boolean;
}

export interface FridayWorkflowGeneratorCancelResponse {
  cancelled: true;
}

// ─── Run Execution ───

export interface FridayStartRunRequest {
  workflowId: UUID;
  marketplaceListingId?: UUID;
  workflowVersionId?: UUID;
  triggerType: string;
  triggerPayload?: JsonObject;
  dryRun?: boolean;
}
export interface FridayStartRunResponse {
  run: FridayWorkflowRunEntity;
}

export interface FridayGetRunResponse {
  run: FridayWorkflowRunEntity;
}

export interface FridayListRunNodesQuery extends FridayPaginationQuery {
  status?: NodeAttemptStatus;
}
export interface FridayListRunNodesResponse extends FridayPage<FridayWorkflowRunNodeEntity> {}

export interface FridayRunTimelineEntry {
  seq: number;
  streamId: string;
  event: string;
  emittedAt: ISODateTime;
  nodeId?: string;
  attempt?: number;
  status?: WorkflowRunStatus | NodeAttemptStatus;
  payload: JsonObject;
}

export interface FridayGetRunTimelineQuery extends FridayPaginationQuery {
  afterSeq?: number;
}
export interface FridayGetRunTimelineResponse extends FridayPage<FridayRunTimelineEntry> {}

export type FridayGetRunEvidenceQuery = FridayWorkflowRunEvidenceQuery;
export type FridayGetRunEvidenceResponse = FridayWorkflowRunEvidenceResponse;
export type FridayExportRunEvidenceRequest = FridayWorkflowRunEvidenceQuery;
export type FridayExportRunEvidenceResponse = FridayWorkflowRunEvidenceExportRecord;

export interface FridayListRunEvidenceExportsQuery extends FridayPaginationQuery {}
export interface FridayListRunEvidenceExportsResponse extends FridayPage<FridayWorkflowRunEvidenceExport> {}

export interface FridayGetRunEvidenceExportResponse {
  export: FridayWorkflowRunEvidenceExport;
  evidence: FridayWorkflowRunEvidenceResponse;
}

export type FridayDownloadRunEvidenceExportResponse = FridayWorkflowRunEvidenceExportDownload;

export interface FridayCancelRunRequest {
  reason?: string;
}
export interface FridayCancelRunResponse {
  run: FridayWorkflowRunEntity;
}

export interface FridayRetryRunRequest {
  nodeIds?: string[];
}
export interface FridayRetryRunResponse {
  run: FridayWorkflowRunEntity;
  retriedNodes: string[];
}

export interface FridayResumeRunResponse {
  run: FridayWorkflowRunEntity;
}

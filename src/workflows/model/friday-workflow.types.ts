// ─── Foundational value types (local definitions; not coupled to SQLite layer) ───

export type UUID = string;
export type ISODateTime = string;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

// ─── Workflow Run Status ───

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "pausing"
  | "paused"
  | "compensating"
  | "completed"
  | "failed"
  | "cancelled";

// ─── Node Attempt Status ───

export type NodeAttemptStatus =
  | "queued"
  | "running"
  | "retrying"
  | "completed"
  | "failed"
  | "blocked_offline"
  | "cancelled";

// ─── Failure Policy ───

export type WorkflowFailureStrategy =
  | "fail_fast"
  | "continue_on_error"
  | "fallback_step"
  | "compensate"
  | "pause_for_approval";

export interface WorkflowFailurePolicyV2 {
  onFailure: WorkflowFailureStrategy;
  fallbackStepId?: string;
  compensationWorkflowId?: string;
  notifyUser: boolean;
}

// ─── Workflow Node Types ───

export type WorkflowNodeType =
  | "trigger"
  | "action"
  | "condition"
  | "data"
  | "ai"
  | "approval";

// ─── Workflow Definition Row (DB shape) ───

export interface FridayWorkflowRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  tags_json: string;
  owner_user_id: string | null;
  latest_version_number: number;
  published_version_number: number | null;
  is_archived: number;
  revision: number;
  etag: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

// ─── Workflow Definition Entity (domain shape) ───

export interface FridayWorkflowEntity {
  id: UUID;
  slug: string;
  name: string;
  description?: string;
  tags: string[];
  ownerUserId?: UUID;
  latestVersionNumber: number;
  publishedVersionNumber?: number;
  isArchived: boolean;
  revision: number;
  etag: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  deletedAt?: ISODateTime;
  deletedBy?: string;
}

// ─── Workflow Version Row ───

export interface FridayWorkflowVersionRow {
  id: string;
  workflow_id: string;
  version_number: number;
  checksum: string;
  graph_json: string;
  created_by_user_id: string | null;
  is_published: number;
  change_note: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Workflow Version Entity ───

export interface FridayWorkflowVersionEntity {
  id: UUID;
  workflowId: UUID;
  versionNumber: number;
  checksum: string;
  graphJson: JsonValue;
  createdByUserId?: UUID;
  isPublished: boolean;
  changeNote?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ─── Workflow Run Row ───

export interface FridayWorkflowRunRow {
  id: string;
  workflow_id: string;
  workflow_version_id: string;
  status: string;
  trigger_type: string;
  trigger_payload_json: string | null;
  started_by_user_id: string | null;
  started_by_satellite_id: string | null;
  started_at: string;
  finished_at: string | null;
  correlation_id: string | null;
  context_json: string | null;
  failure_code: string | null;
  failure_message: string | null;
  failure_details_json: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Workflow Run Entity ───

export interface FridayWorkflowRunEntity {
  id: UUID;
  workflowId: UUID;
  workflowVersionId: UUID;
  status: WorkflowRunStatus;
  triggerType: string;
  triggerPayload?: JsonObject;
  startedByUserId?: UUID;
  startedBySatelliteId?: UUID;
  startedAt: ISODateTime;
  finishedAt?: ISODateTime;
  correlationId?: string;
  context?: JsonObject;
  failure?: {
    code: string;
    message: string;
    details?: JsonValue;
  };
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ─── Workflow Run Node Row ───

export interface FridayWorkflowRunNodeRow {
  id: string;
  run_id: string;
  node_id: string;
  attempt: number;
  attempt_id: string;
  status: string;
  satellite_id: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  input_json: string | null;
  output_json: string | null;
  error_json: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

// ─── Workflow Run Node Entity ───

export interface FridayWorkflowRunNodeEntity {
  id: UUID;
  runId: UUID;
  nodeId: string;
  attempt: number;
  attemptId: UUID;
  status: NodeAttemptStatus;
  satelliteId?: UUID;
  leaseOwner?: string;
  leaseExpiresAt?: ISODateTime;
  startedAt?: ISODateTime;
  finishedAt?: ISODateTime;
  input?: JsonValue;
  output?: JsonValue;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: JsonValue;
  };
  idempotencyKey: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ─── Workflow Artifact Row ───

export interface FridayWorkflowArtifactRow {
  id: string;
  run_id: string;
  node_id: string;
  artifact_type: string;
  uri: string;
  checksum: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Workflow Artifact Entity ───

export interface FridayWorkflowArtifactEntity {
  id: UUID;
  runId: UUID;
  nodeId: string;
  artifactType: "json" | "text" | "file" | "image" | "audio" | "video";
  uri: string;
  checksum?: string;
  metadata?: JsonObject;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ─── Create Workflow Input ───

export interface FridayWorkflowCreateInput {
  slug: string;
  name: string;
  description?: string;
  tags?: string[];
  ownerUserId?: UUID;
}

// ─── Update Workflow Input ───

export interface FridayWorkflowUpdateInput {
  workflowId: UUID;
  expectedRevision: number;
  etag: string;
  name?: string;
  description?: string;
  tags?: string[];
}

// ─── List Workflows Input ───

export interface FridayWorkflowListInput {
  tag?: string;
  archived?: boolean;
  cursor?: string;
  limit?: number;
}

// ─── Start Run Input ───

export interface FridayWorkflowStartRunInput {
  workflowId: UUID;
  workflowVersionId?: UUID;
  triggerType: string;
  triggerPayload?: JsonObject;
  startedByUserId?: UUID;
  startedBySatelliteId?: UUID;
  correlationId?: string;
  context?: JsonObject;
  dryRun?: boolean;
}

// ─── Node Outcome (internal) ───

export interface FridayNodeOutcome {
  nodeId: string;
  status: "completed" | "failed" | "cancelled";
  output?: JsonValue;
  error?: { code: string; message: string; retryable: boolean };
}

// ─── Row-to-entity mapper signature ───

export type RowMapper<TRow, TEntity> = (row: TRow) => TEntity;

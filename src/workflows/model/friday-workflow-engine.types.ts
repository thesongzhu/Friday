// ─── Workflow Engine Types ───

import type { ISODateTime, UUID } from "./friday-workflow.types.js";

// ─── Status / Discriminant Union Types ───

export type FridayWorkflowStatus = "draft" | "published" | "archived";
export type FridayWorkflowEngineTriggerType = "cron" | "webhook" | "event";
export type FridayWorkflowNodeType = "trigger" | "action" | "condition" | "transform" | "approval";
export type FridayWorkflowActionType = "skill" | "ai_completion" | "http_request";
export type FridayWorkflowRunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type FridayWorkflowNodeStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "waiting_approval"
  | "cancelled"
  | "retrying";

// ─── Workflow Version Config ───

export interface FridayWorkflowVersionConfig {
  runTimeoutMs?: number;
  defaultNodeTimeoutMs?: number;
  maxParallelism?: number;
  failurePolicy: {
    onFailure:
      | "fail_fast"
      | "continue_on_error"
      | "fallback_step"
      | "compensate"
      | "pause_for_approval";
    fallbackNodeId?: string;
  };
}

// ─── Node Config (discriminated union) ───

export type FridayWorkflowNodeConfig =
  | { triggerType: "cron"; cron: string; timezone: string }
  | { triggerType: "webhook"; method: "POST"; secretRef?: string; dedupeKeyPath?: string }
  | { triggerType: "event"; source: string; event: string; filterExpr?: string; pluginId?: string }
  | { actionType: "skill"; skillId: string; inputMapping?: Record<string, unknown> }
  | { actionType: "ai_completion"; prompt: string; model?: string; temperature?: number }
  | { actionType: "http_request"; method: string; url: string; headers?: Record<string, string>; body?: unknown }
  | { conditionType: "if" | "switch"; expression: string; cases?: Array<{ label: string; expression: string }> }
  | {
      transformType: "map" | "template" | "merge";
      mapping?: Record<string, unknown>;
      expression?: string;
      outputKey?: string;
    }
  | {
      approverUserId?: string;
      approverRole?: "owner" | "admin" | "operator";
      timeoutMs?: number;
      onReject?: "fail" | "reject_branch";
    };

// ─── Node Definition ───

export interface FridayWorkflowNodeDefinition {
  id: string;
  type: FridayWorkflowNodeType;
  name: string;
  config: FridayWorkflowNodeConfig;
  timeoutMs?: number;
}

// ─── Edge Definition ───

export interface FridayWorkflowEdgeDefinition {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  condition?: string;
  branch?: "true" | "false" | "success" | "failure" | "approve" | "reject";
}

// ─── Trigger Registration Entity (DB row shape) ───

export interface FridayWorkflowTriggerRegistrationRow {
  id: string;
  workflow_id: string;
  workflow_version_id: string;
  trigger_node_id: string;
  trigger_type: string;
  enabled: number;
  cron_expression: string | null;
  cron_timezone: string | null;
  webhook_path_token: string | null;
  webhook_secret_ref: string | null;
  webhook_signature_header: string | null;
  event_source: string | null;
  event_name: string | null;
  event_filter_expr: string | null;
  plugin_id: string | null;
  dedupe_window_sec: number;
  last_fired_at: string | null;
  next_fire_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Trigger Registration Entity (domain shape) ───

export interface FridayWorkflowTriggerRegistrationEntity {
  id: UUID;
  workflowId: UUID;
  workflowVersionId: UUID;
  triggerNodeId: string;
  triggerType: FridayWorkflowEngineTriggerType;
  enabled: boolean;
  cronExpression?: string;
  cronTimezone?: string;
  webhookPathToken?: string;
  webhookSecretRef?: string;
  webhookSignatureHeader?: string;
  eventSource?: string;
  eventName?: string;
  eventFilterExpr?: string;
  pluginId?: string;
  dedupeWindowSec: number;
  lastFiredAt?: ISODateTime;
  nextFireAt?: ISODateTime;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ─── Trigger Delivery Row ───

export interface FridayWorkflowTriggerDeliveryRow {
  id: string;
  trigger_registration_id: string;
  dedupe_key: string;
  run_id: string | null;
  status: string;
  error_code: string | null;
  error_message: string | null;
  delivered_at: string;
  created_at: string;
}

// ─── Trigger Delivery Entity ───

export type FridayWorkflowTriggerDeliveryStatus = "accepted" | "duplicate" | "failed";

export interface FridayWorkflowTriggerDeliveryEntity {
  id: UUID;
  triggerRegistrationId: UUID;
  dedupeKey: string;
  runId?: UUID;
  status: FridayWorkflowTriggerDeliveryStatus;
  errorCode?: string;
  errorMessage?: string;
  deliveredAt: ISODateTime;
  createdAt: ISODateTime;
}

// ─── Run Checkpoint Row ───

export interface FridayWorkflowRunCheckpointRow {
  run_id: string;
  checkpoint_seq: number;
  run_status: string;
  active_node_ids_json: string;
  completed_node_ids_json: string;
  failed_node_ids_json: string;
  waiting_approval_node_ids_json: string;
  context_json: string;
  last_node_id: string | null;
  updated_at: string;
}

// ─── Run Checkpoint Entity ───

export interface FridayWorkflowRunCheckpointEntity {
  runId: UUID;
  checkpointSeq: number;
  runStatus: FridayWorkflowRunStatus;
  activeNodeIds: string[];
  completedNodeIds: string[];
  failedNodeIds: string[];
  waitingApprovalNodeIds: string[];
  context: Record<string, unknown>;
  lastNodeId?: string;
  updatedAt: ISODateTime;
}

// ─── Approval Request Row ───

export interface FridayWorkflowApprovalRequestRow {
  id: string;
  workflow_id: string;
  workflow_version_id: string;
  run_id: string;
  run_node_attempt_id: string;
  node_id: string;
  approver_user_id: string | null;
  approver_role: string | null;
  status: string;
  request_payload_json: string;
  timeout_at: string | null;
  decided_at: string | null;
  decided_by_user_id: string | null;
  decision_comment: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Approval Request Status ───

export type FridayWorkflowApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

// ─── Approval Request Entity ───

export interface FridayWorkflowApprovalRequestEntity {
  id: UUID;
  workflowId: UUID;
  workflowVersionId: UUID;
  runId: UUID;
  runNodeAttemptId: UUID;
  nodeId: string;
  approverUserId?: UUID;
  approverRole?: string;
  status: FridayWorkflowApprovalStatus;
  requestPayload: Record<string, unknown>;
  timeoutAt?: ISODateTime;
  decidedAt?: ISODateTime;
  decidedByUserId?: UUID;
  decisionComment?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

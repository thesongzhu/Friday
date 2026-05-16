/**
 * Phase 13.5D task workflow API client — supervisor / channels /
 * evidence explorer surface. The client is a thin typed wrapper over
 * the `/v1/task-workflows*` HTTP routes registered by the API runtime.
 *
 * The gated raw drilldown route (`gateConfirmed=true`) returns
 * server-redacted ref text only via `refIdRedacted`; the unredacted raw
 * refId is never exposed by the API even after the gate is confirmed.
 */

import { apiClient } from "./client";

export type TaskWorkflowSupervisorMode = "off" | "light" | "standard" | "strict";

export type TaskWorkflowRisk = "low" | "medium" | "high";

export type TaskWorkflowClaimStatus =
  | "draft"
  | "unverified"
  | "verified"
  | "blocked";

export type TaskWorkflowClaimKind =
  | "docs_intent"
  | "summary_replay"
  | "cli_self_report"
  | "provider_fallback"
  | "runtime_evidence"
  | "code_evidence"
  | "api_evidence"
  | "artifact_evidence";

export type TaskWorkflowEvidenceSource =
  | "agent_run_event"
  | "workflow_run_evidence"
  | "provider_route_trace"
  | "context_replay"
  | "self_heal_event"
  | "channel_event"
  | "session_event"
  | "observability_audit"
  | "manual_external"
  | "docs_intent_reference";

export interface TaskWorkflowGatePlanEntry {
  gateId: string;
  required: boolean;
  additiveUser: boolean;
}

export interface TaskWorkflowContextPackageSummary {
  boundaryIds: readonly string[];
  allowedFilesCount: number;
  allowedToolsCount: number;
  allowedApisCount: number;
}

export interface TaskWorkflowClaimRecord {
  id: string;
  workflowId: string;
  specHash: string;
  claimText: string;
  claimKind: TaskWorkflowClaimKind;
  status: TaskWorkflowClaimStatus;
  reason: string | null;
  verifierVerdict: string | null;
  verifierLaneId: string | null;
  evidenceRefCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskWorkflowCloseoutGateOutcome {
  gateId: string;
  required: boolean;
  status: "pass" | "block" | "not_applicable";
  reason: string | null;
}

export interface TaskWorkflowCloseoutReceipt {
  id: string;
  workflowId: string;
  specHash: string;
  status: "complete" | "partial" | "blocked";
  claimSummary: { draft: number; unverified: number; verified: number; blocked: number };
  blockers: readonly string[];
  gateOutcomes: readonly TaskWorkflowCloseoutGateOutcome[];
  createdAt: string;
}

export interface TaskWorkflowChannelCommandSummary {
  total: number;
  issued: number;
  confirmed: number;
  dispatched: number;
  declined: number;
  expired: number;
}

export interface TaskWorkflowLaneSummary {
  executor: { count: number; open: number; completed: number; blocked: number };
  verifier: {
    count: number;
    open: number;
    completed: number;
    blocked: number;
    independent: number;
    degraded: number;
  };
}

export interface TaskWorkflowSupervisorOverview {
  workflow: {
    id: string;
    charter: string;
    specHash: string;
    parentSpecHash: string | null;
    taskKind: string;
    risk: TaskWorkflowRisk;
    supervisorMode: TaskWorkflowSupervisorMode;
    budget: number;
    stage: string;
    boundaryRefs: readonly string[];
  };
  supervisorCursor: {
    workflowId: string;
    currentStage: string;
    blockers: readonly string[];
    lastEventRef: string | null;
    updatedAt: string;
  } | null;
  boundaryRefs: readonly string[];
  contextPackageSummary: TaskWorkflowContextPackageSummary;
  gatePlan: readonly TaskWorkflowGatePlanEntry[];
  immutableRequiredGateIds: readonly string[];
  claimMatrix: {
    counts: { draft: number; unverified: number; verified: number; blocked: number };
    unverifiedClaims: readonly TaskWorkflowClaimRecord[];
    blockedClaims: readonly TaskWorkflowClaimRecord[];
  };
  laneSummary: TaskWorkflowLaneSummary;
  channelCommandSummary: TaskWorkflowChannelCommandSummary;
  blockers: readonly string[];
  closeoutReceipt: TaskWorkflowCloseoutReceipt | null;
}

export interface TaskWorkflowEvidenceExplorerEntry {
  evidenceRefId: string;
  workflowId: string;
  claimId: string;
  refKind: string;
  refSource: TaskWorkflowEvidenceSource;
  refHash: string | null;
  claimStatus: TaskWorkflowClaimStatus;
  claimKind: TaskWorkflowClaimKind;
  createdAt: string;
}

export interface TaskWorkflowEvidenceRawDrilldown {
  evidenceRefId: string;
  workflowId: string;
  claimId: string;
  refKind: string;
  refSource: TaskWorkflowEvidenceSource;
  refIdRedacted: string;
  refHash: string | null;
  redactionApplied: boolean;
  createdAt: string;
}

export interface TaskWorkflowListItem {
  id: string;
  charter: string;
  taskKind: string;
  risk: TaskWorkflowRisk;
  supervisorMode: TaskWorkflowSupervisorMode;
  stage: string;
  createdAt: string;
  updatedAt: string;
}

interface ListResponse<T> {
  items: readonly T[];
}

interface SupervisorReadResponse {
  overview: TaskWorkflowSupervisorOverview;
}

interface EvidenceRawResponse {
  drilldown: TaskWorkflowEvidenceRawDrilldown;
}

export interface TaskWorkflowEvidenceExplorerFilter {
  workflowId?: string;
  claimId?: string;
  refSource?: TaskWorkflowEvidenceSource;
  refKind?: string;
  claimKind?: TaskWorkflowClaimKind;
  limit?: number;
}

function buildQueryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text.length > 0 ? `?${text}` : "";
}

export const taskWorkflowsApi = {
  async list(): Promise<readonly TaskWorkflowListItem[]> {
    const data = await apiClient.get<ListResponse<TaskWorkflowListItem>>(
      "/v1/task-workflows",
    );
    return data.items;
  },

  async getSupervisorOverview(
    workflowId: string,
  ): Promise<TaskWorkflowSupervisorOverview> {
    const data = await apiClient.get<SupervisorReadResponse>(
      `/v1/task-workflows/${encodeURIComponent(workflowId)}/supervisor`,
    );
    return data.overview;
  },

  async queryEvidence(
    filter: TaskWorkflowEvidenceExplorerFilter = {},
  ): Promise<readonly TaskWorkflowEvidenceExplorerEntry[]> {
    const query = buildQueryString({
      workflowId: filter.workflowId,
      claimId: filter.claimId,
      refSource: filter.refSource,
      refKind: filter.refKind,
      claimKind: filter.claimKind,
      limit: filter.limit,
    });
    const data = await apiClient.get<ListResponse<TaskWorkflowEvidenceExplorerEntry>>(
      `/v1/task-workflows/evidence${query}`,
    );
    return data.items;
  },

  async getEvidenceRawDrilldown(
    evidenceRefId: string,
  ): Promise<TaskWorkflowEvidenceRawDrilldown> {
    const data = await apiClient.get<EvidenceRawResponse>(
      `/v1/task-workflows/evidence/${encodeURIComponent(
        evidenceRefId,
      )}/raw?gateConfirmed=true`,
    );
    return data.drilldown;
  },
};

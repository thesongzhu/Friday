import { apiClient } from "./client";
import type {
  FridayWorkflowRunEntity,
  FridayWorkflowRunNodeEntity,
  FridayRunTimelineEntry,
  NodeAttemptStatus,
} from "./types";

// ─── Response wrappers ───

interface StartRunResponse {
  run: FridayWorkflowRunEntity;
}

interface GetRunResponse {
  run: FridayWorkflowRunEntity;
}

interface ListRunNodesResponse {
  items: FridayWorkflowRunNodeEntity[];
  nextCursor?: string;
}

interface GetRunTimelineResponse {
  items: FridayRunTimelineEntry[];
  nextCursor?: string;
}

interface CancelRunResponse {
  run: FridayWorkflowRunEntity;
}

interface RetryRunResponse {
  run: FridayWorkflowRunEntity;
  retriedNodes: string[];
}

interface ResumeRunResponse {
  run: FridayWorkflowRunEntity;
}

// ─── API ───

export const workflowRunsApi = {
  async start(input: {
    workflowId: string;
    workflowVersionId?: string;
    triggerType: string;
    triggerPayload?: Record<string, unknown>;
    dryRun?: boolean;
  }): Promise<StartRunResponse> {
    return apiClient.post<typeof input, StartRunResponse>(
      "/v1/workflow-runs",
      input,
    );
  },

  async get(runId: string): Promise<GetRunResponse> {
    return apiClient.get<GetRunResponse>(
      `/v1/workflow-runs/${encodeURIComponent(runId)}`,
    );
  },

  async listNodes(
    runId: string,
    query?: { status?: NodeAttemptStatus; cursor?: string; limit?: number },
  ): Promise<ListRunNodesResponse> {
    const params = new URLSearchParams();
    if (query?.status) params.set("status", query.status);
    if (query?.cursor) params.set("cursor", query.cursor);
    if (query?.limit !== undefined) params.set("limit", String(query.limit));
    const qs = params.toString();
    const path = qs
      ? `/v1/workflow-runs/${encodeURIComponent(runId)}/nodes?${qs}`
      : `/v1/workflow-runs/${encodeURIComponent(runId)}/nodes`;
    return apiClient.get<ListRunNodesResponse>(path);
  },

  async getTimeline(
    runId: string,
    query?: { afterSeq?: number; cursor?: string; limit?: number },
  ): Promise<GetRunTimelineResponse> {
    const params = new URLSearchParams();
    if (query?.afterSeq !== undefined) params.set("afterSeq", String(query.afterSeq));
    if (query?.cursor) params.set("cursor", query.cursor);
    if (query?.limit !== undefined) params.set("limit", String(query.limit));
    const qs = params.toString();
    const path = qs
      ? `/v1/workflow-runs/${encodeURIComponent(runId)}/timeline?${qs}`
      : `/v1/workflow-runs/${encodeURIComponent(runId)}/timeline`;
    return apiClient.get<GetRunTimelineResponse>(path);
  },

  async cancel(
    runId: string,
    input?: { reason?: string },
  ): Promise<CancelRunResponse> {
    return apiClient.post<typeof input | Record<string, never>, CancelRunResponse>(
      `/v1/workflow-runs/${encodeURIComponent(runId)}/cancel`,
      input ?? {},
    );
  },

  async retry(
    runId: string,
    input?: { nodeIds?: string[] },
  ): Promise<RetryRunResponse> {
    return apiClient.post<typeof input | Record<string, never>, RetryRunResponse>(
      `/v1/workflow-runs/${encodeURIComponent(runId)}/retry`,
      input ?? {},
    );
  },

  async resume(runId: string): Promise<ResumeRunResponse> {
    return apiClient.post<Record<string, never>, ResumeRunResponse>(
      `/v1/workflow-runs/${encodeURIComponent(runId)}/resume`,
      {},
    );
  },
};

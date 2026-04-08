import { apiClient } from "./client";
import type {
  AgentAutomation,
  AgentRunRecord,
  AgentRunStatus,
  AgentRuntimeResult,
  AgentTaskProfileInput,
  SubagentRecord,
} from "./types";

// ─── Request / Response shapes ───

interface StartRunInput {
  task: string;
  model?: string;
  timeoutMs?: number;
  requireReview?: boolean;
  readOnly?: boolean;
  sessionKey?: string;
  executionContext?: {
    surface?: string;
    interactive?: boolean;
    browserPresentationMode?: "auto" | "headless" | "host_chrome_visible";
    packId?: string;
  };
  taskProfile?: AgentTaskProfileInput;
}

interface GetRunResponse {
  run: AgentRunRecord;
}

interface ListRunsResponse {
  items: AgentRunRecord[];
}

interface CancelRunResponse {
  cancelled: boolean;
  runId: string;
}

interface SaveAutomationInput {
  name: string;
  description?: string;
  sourceRunId?: string;
  taskTemplate: string;
  schedule?: {
    type: "cron";
    cron: string;
    timezone?: string;
  };
  enabled?: boolean;
}

interface SaveAutomationResponse {
  automation: AgentAutomation;
}

export interface RunAuditEvent {
  seq: number;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface RunAuditResponse {
  runId: string;
  events: RunAuditEvent[];
}

interface ListSubagentsResponse {
  items: SubagentRecord[];
}

// ─── Agent API ───

export const agentApi = {
  async startRun(input: StartRunInput): Promise<AgentRuntimeResult> {
    const payload = {
      task: input.task,
      model: input.model,
      timeoutMs: input.timeoutMs,
      requireReview: input.requireReview,
      sessionKey: input.sessionKey,
      constraints: input.readOnly ? { readOnly: true } : undefined,
      executionContext: input.executionContext,
      taskProfile: input.taskProfile,
    };
    return apiClient.post<typeof payload, AgentRuntimeResult>("/v1/agent/runs", payload);
  },

  async listRuns(query?: { status?: AgentRunStatus; limit?: number }): Promise<AgentRunRecord[]> {
    const params = new URLSearchParams();
    if (query?.status) params.set("status", query.status);
    if (query?.limit) params.set("limit", String(query.limit));
    const qs = params.toString();
    const path = qs ? `/v1/agent/runs?${qs}` : "/v1/agent/runs";
    const data = await apiClient.get<ListRunsResponse>(path);
    return data.items;
  },

  async getRun(runId: string): Promise<AgentRunRecord> {
    const data = await apiClient.get<GetRunResponse>(`/v1/agent/runs/${encodeURIComponent(runId)}`);
    return data.run;
  },

  async cancelRun(runId: string): Promise<CancelRunResponse> {
    return apiClient.post<Record<string, never>, CancelRunResponse>(
      `/v1/agent/runs/${encodeURIComponent(runId)}/cancel`,
      {},
    );
  },

  async approvePlan(runId: string): Promise<AgentRuntimeResult> {
    return apiClient.post<Record<string, never>, AgentRuntimeResult>(
      `/v1/agent/runs/${encodeURIComponent(runId)}/approve-plan`,
      {},
    );
  },

  async rejectPlan(runId: string): Promise<AgentRuntimeResult> {
    return apiClient.post<Record<string, never>, AgentRuntimeResult>(
      `/v1/agent/runs/${encodeURIComponent(runId)}/reject-plan`,
      {},
    );
  },

  async approveTool(runId: string, toolCallId: string): Promise<{ resolved: boolean }> {
    return apiClient.post<{ toolCallId: string }, { resolved: boolean }>(
      `/v1/agent/runs/${encodeURIComponent(runId)}/approve-tool`,
      { toolCallId },
    );
  },

  async rejectTool(runId: string, toolCallId: string, reason?: string): Promise<{ resolved: boolean }> {
    return apiClient.post<{ toolCallId: string; reason?: string }, { resolved: boolean }>(
      `/v1/agent/runs/${encodeURIComponent(runId)}/reject-tool`,
      { toolCallId, reason },
    );
  },

  async saveAutomation(input: SaveAutomationInput): Promise<AgentAutomation> {
    const data = await apiClient.post<SaveAutomationInput, SaveAutomationResponse>(
      "/v1/agent/automations",
      input,
    );
    return data.automation;
  },

  async listSubagents(runId: string): Promise<SubagentRecord[]> {
    const data = await apiClient.get<ListSubagentsResponse>(
      `/v1/agent/runs/${encodeURIComponent(runId)}/subagents`,
    );
    return data.items;
  },

  async rollbackRun(runId: string): Promise<{ restoredCount: number; errors: Array<{ filePath: string; error: string }> }> {
    return apiClient.post<Record<string, never>, { restoredCount: number; errors: Array<{ filePath: string; error: string }> }>(
      `/v1/agent/runs/${encodeURIComponent(runId)}/rollback`,
      {},
    );
  },

  async getRunAudit(runId: string): Promise<RunAuditResponse> {
    return apiClient.get<RunAuditResponse>(
      `/v1/agent/runs/${encodeURIComponent(runId)}/audit`,
    );
  },
};

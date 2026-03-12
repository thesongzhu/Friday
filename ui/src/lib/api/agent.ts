import { apiClient } from "./client";
import type { AgentRunRecord, AgentRunStatus, AgentAutomation, SubagentRecord } from "./types";

// ─── Request / Response shapes ───

interface StartRunInput {
  task: string;
  model?: string;
  timeoutMs?: number;
  requireReview?: boolean;
  readOnly?: boolean;
  sessionKey?: string;
}

interface StartRunResponse {
  runId: string;
  status: AgentRunStatus;
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

interface ListSubagentsResponse {
  items: SubagentRecord[];
}

// ─── Agent API ───

export const agentApi = {
  async startRun(input: StartRunInput): Promise<StartRunResponse> {
    const payload = {
      task: input.task,
      model: input.model,
      timeoutMs: input.timeoutMs,
      requireReview: input.requireReview,
      sessionKey: input.sessionKey,
      constraints: input.readOnly ? { readOnly: true } : undefined,
    };
    return apiClient.post<typeof payload, StartRunResponse>("/v1/agent/runs", payload);
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
};

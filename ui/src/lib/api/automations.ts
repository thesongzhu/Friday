import { apiClient } from "./client";
import type { AgentAutomationRecord, AgentRuntimeResult } from "./types";

// ─── Request types ───

export interface CreateAutomationInput {
  name: string;
  description?: string;
  sourceRunId?: string;
  taskTemplate: string;
  schedule?: {
    type: "cron";
    cron: string;
    timezone?: string;
  };
  variables?: Record<string, string>;
  skillIds?: string[];
  workflowIds?: string[];
  triggerId?: string;
  enabled?: boolean;
}

export interface UpdateAutomationInput {
  name?: string;
  description?: string;
  taskTemplate?: string;
  schedule?: {
    type: "cron";
    cron: string;
    timezone?: string;
  } | null;
  variables?: Record<string, string>;
  skillIds?: string[];
  workflowIds?: string[];
  triggerId?: string;
  enabled?: boolean;
}

export interface RunAutomationInput {
  taskOverride?: string;
  providerId?: string;
  model?: string;
  timeoutMs?: number;
}

// ─── Response wrappers ───

interface ListAutomationsResponse {
  items: AgentAutomationRecord[];
}

interface GetAutomationResponse {
  automation: AgentAutomationRecord;
}

interface CreateAutomationResponse {
  automation: AgentAutomationRecord;
}

interface UpdateAutomationResponse {
  automation: AgentAutomationRecord;
}

interface DeleteAutomationResponse {
  deleted: true;
  automationId: string;
}

interface RunAutomationResponse {
  result: AgentRuntimeResult;
}

// ─── API ───

export const automationsApi = {
  async list(query?: {
    enabled?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<AgentAutomationRecord[]> {
    const params = new URLSearchParams();
    if (query?.enabled !== undefined) params.set("enabled", String(query.enabled));
    if (query?.limit !== undefined) params.set("limit", String(query.limit));
    if (query?.cursor) params.set("cursor", query.cursor);
    const qs = params.toString();
    const path = qs ? `/v1/agent/automations?${qs}` : "/v1/agent/automations";
    const data = await apiClient.get<ListAutomationsResponse>(path);
    return data.items;
  },

  async create(input: CreateAutomationInput): Promise<AgentAutomationRecord> {
    const data = await apiClient.post<CreateAutomationInput, CreateAutomationResponse>(
      "/v1/agent/automations",
      input,
    );
    return data.automation;
  },

  async get(automationId: string): Promise<AgentAutomationRecord> {
    const data = await apiClient.get<GetAutomationResponse>(
      `/v1/agent/automations/${encodeURIComponent(automationId)}`,
    );
    return data.automation;
  },

  async update(
    automationId: string,
    patch: UpdateAutomationInput,
  ): Promise<AgentAutomationRecord> {
    const data = await apiClient.patch<UpdateAutomationInput, UpdateAutomationResponse>(
      `/v1/agent/automations/${encodeURIComponent(automationId)}`,
      patch,
    );
    return data.automation;
  },

  async remove(
    automationId: string,
  ): Promise<DeleteAutomationResponse> {
    return apiClient.del<DeleteAutomationResponse>(
      `/v1/agent/automations/${encodeURIComponent(automationId)}`,
    );
  },

  async run(
    automationId: string,
    input?: RunAutomationInput,
  ): Promise<AgentRuntimeResult> {
    const data = await apiClient.post<RunAutomationInput | Record<string, never>, RunAutomationResponse>(
      `/v1/agent/automations/${encodeURIComponent(automationId)}/run`,
      input ?? {},
    );
    return data.result;
  },
};

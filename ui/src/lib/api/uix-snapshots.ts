import type { AgentRunRecord } from "./types";
import { apiClient } from "./client";

export interface UixApprovalSummary {
  id: string;
  title: string;
  summary: string;
  createdAt: string;
  actionId?: string;
  approvalRequestId?: string;
  severity?: string;
}

export interface UixAlertSummary {
  id: string;
  title: string;
  summary: string;
  severity: "low" | "medium" | "high" | "critical";
  module: string;
  detectedAt: string;
}

export interface UixScheduledAutomationSummary {
  id: string;
  name: string;
  enabled: boolean;
  schedule?: {
    type: "cron";
    cron: string;
    timezone?: string;
  };
  nextRunAt: string | null;
}

export interface UixHomeSnapshot {
  generatedAt: string;
  runs: AgentRunRecord[];
  pendingApprovals: UixApprovalSummary[];
  scheduledAutomations: UixScheduledAutomationSummary[];
}

export interface UixAssistantInboxSnapshot {
  generatedAt: string;
  approvals: UixApprovalSummary[];
  alerts: UixAlertSummary[];
  recentRuns: AgentRunRecord[];
}

interface UixHomeSnapshotResponse {
  snapshot: UixHomeSnapshot;
}

interface UixAssistantInboxSnapshotResponse {
  snapshot: UixAssistantInboxSnapshot;
}

export const uixSnapshotsApi = {
  async getHome(): Promise<UixHomeSnapshot> {
    const data = await apiClient.get<UixHomeSnapshotResponse>("/v1/uix/home-snapshot");
    return data.snapshot;
  },

  async getAssistantInbox(): Promise<UixAssistantInboxSnapshot> {
    const data = await apiClient.get<UixAssistantInboxSnapshotResponse>("/v1/uix/assistant-inbox-snapshot");
    return data.snapshot;
  },
};

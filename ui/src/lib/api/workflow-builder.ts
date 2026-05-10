import { apiClient } from "./client";
import type {
  FridayWorkflowDraftEntity,
  FridayWorkflowSpecV1,
  FridayWorkflowVisualGraphV1,
  FridayCompiledWorkflowGraphV2,
  FridayWorkflowBuilderValidationReport,
  FridayAcquireWorkflowLockResponse,
  FridayWorkflowEditLock,
  FridayWorkflowTemplateEntity,
  FridayStableWorkflowTemplate,
  AgentTaskProfileId,
} from "./types";

// ─── Response wrappers ───

interface ListDraftsResponse {
  items: FridayWorkflowDraftEntity[];
  nextCursor?: string;
}

interface ListTemplatesResponse {
  items: FridayWorkflowTemplateEntity[];
  stableItems: FridayStableWorkflowTemplate[];
}

interface GetTemplateResponse {
  template: FridayWorkflowTemplateEntity;
}

interface InstantiateTemplateResponse {
  draft: FridayWorkflowDraftEntity;
}

interface CreateDraftResponse {
  draft: FridayWorkflowDraftEntity;
}

interface GetDraftResponse {
  draft: FridayWorkflowDraftEntity;
}

interface SaveDraftResponse {
  draft: FridayWorkflowDraftEntity;
}

interface AutosaveDraftResponse {
  draft: FridayWorkflowDraftEntity | null;
}

interface CompileDraftResponse {
  compiled: FridayCompiledWorkflowGraphV2;
  validation: FridayWorkflowBuilderValidationReport;
}

interface PublishDraftResponse {
  workflowId: string;
  workflowVersionId: string;
  versionNumber: number;
  published: boolean;
  checksum: string;
  validation: FridayWorkflowBuilderValidationReport;
}

interface RenewLockResponse {
  lock: FridayWorkflowEditLock;
}

interface ReleaseLockResponse {
  released: true;
}

// ─── API ───

export const workflowBuilderApi = {
  async listTemplates(query?: { scope?: "global" | "user" }): Promise<ListTemplatesResponse> {
    const params = new URLSearchParams();
    if (query?.scope) params.set("scope", query.scope);
    const qs = params.toString();
    const path = qs
      ? `/v1/workflow-builder/templates?${qs}`
      : "/v1/workflow-builder/templates";
    return apiClient.get<ListTemplatesResponse>(path);
  },

  async getTemplate(templateId: string): Promise<GetTemplateResponse> {
    return apiClient.get<GetTemplateResponse>(
      `/v1/workflow-builder/templates/${encodeURIComponent(templateId)}`,
    );
  },

  async instantiateTemplate(
    templateId: string,
    input: {
      workflowId: string;
      title: string;
      ownerUserId?: string;
      taskProfileId?: AgentTaskProfileId;
    },
  ): Promise<InstantiateTemplateResponse> {
    return apiClient.post<typeof input, InstantiateTemplateResponse>(
      `/v1/workflow-builder/templates/${encodeURIComponent(templateId)}/instantiate`,
      input,
    );
  },

  async listDrafts(
    workflowId: string,
    query?: { cursor?: string; limit?: number },
  ): Promise<ListDraftsResponse> {
    const params = new URLSearchParams();
    if (query?.cursor) params.set("cursor", query.cursor);
    if (query?.limit !== undefined) params.set("limit", String(query.limit));
    const qs = params.toString();
    const path = qs
      ? `/v1/workflows/${encodeURIComponent(workflowId)}/drafts?${qs}`
      : `/v1/workflows/${encodeURIComponent(workflowId)}/drafts`;
    return apiClient.get<ListDraftsResponse>(path);
  },

  async createDraft(
    workflowId: string,
    input: {
      title: string;
      spec: FridayWorkflowSpecV1;
      visual: FridayWorkflowVisualGraphV1;
      baseWorkflowVersionId?: string;
    },
  ): Promise<CreateDraftResponse> {
    return apiClient.post<typeof input, CreateDraftResponse>(
      `/v1/workflows/${encodeURIComponent(workflowId)}/drafts`,
      input,
    );
  },

  async getDraft(
    workflowId: string,
    draftId: string,
  ): Promise<GetDraftResponse> {
    return apiClient.get<GetDraftResponse>(
      `/v1/workflows/${encodeURIComponent(workflowId)}/drafts/${encodeURIComponent(draftId)}`,
    );
  },

  async saveDraft(
    workflowId: string,
    draftId: string,
    input: {
      expectedRevision: number;
      lockToken: string;
      title?: string;
      spec?: FridayWorkflowSpecV1;
      visual?: FridayWorkflowVisualGraphV1;
    },
  ): Promise<SaveDraftResponse> {
    return apiClient.patch<typeof input, SaveDraftResponse>(
      `/v1/workflows/${encodeURIComponent(workflowId)}/drafts/${encodeURIComponent(draftId)}`,
      input,
    );
  },

  async autosaveDraft(
    workflowId: string,
    draftId: string,
    input: {
      lockToken: string;
      spec: FridayWorkflowSpecV1;
      visual: FridayWorkflowVisualGraphV1;
    },
  ): Promise<AutosaveDraftResponse> {
    return apiClient.post<typeof input, AutosaveDraftResponse>(
      `/v1/workflows/${encodeURIComponent(workflowId)}/drafts/${encodeURIComponent(draftId)}/autosave`,
      input,
    );
  },

  async compileDraft(
    workflowId: string,
    draftId: string,
  ): Promise<CompileDraftResponse> {
    return apiClient.post<Record<string, never>, CompileDraftResponse>(
      `/v1/workflows/${encodeURIComponent(workflowId)}/drafts/${encodeURIComponent(draftId)}/compile`,
      {},
    );
  },

  async publishDraft(
    workflowId: string,
    draftId: string,
    input: {
      workflowId: string;
      lockToken: string;
      createdByUserId?: string;
      changeNote?: string;
      publishNow: boolean;
      externalReviewConfirmed?: boolean;
    },
  ): Promise<PublishDraftResponse> {
    return apiClient.post<typeof input, PublishDraftResponse>(
      `/v1/workflows/${encodeURIComponent(workflowId)}/drafts/${encodeURIComponent(draftId)}/publish`,
      input,
    );
  },

  // ─── Lock endpoints ───

  async acquireLock(
    workflowId: string,
    input: {
      ownerUserId: string;
      ownerSessionId?: string;
      ttlSec: number;
    },
  ): Promise<FridayAcquireWorkflowLockResponse> {
    return apiClient.post<typeof input, FridayAcquireWorkflowLockResponse>(
      `/v1/workflows/${encodeURIComponent(workflowId)}/locks/acquire`,
      input,
    );
  },

  async renewLock(
    workflowId: string,
    input: { lockToken: string; ttlSec: number },
  ): Promise<RenewLockResponse> {
    return apiClient.post<typeof input, RenewLockResponse>(
      `/v1/workflows/${encodeURIComponent(workflowId)}/locks/renew`,
      input,
    );
  },

  async releaseLock(
    workflowId: string,
    input: { lockToken: string },
  ): Promise<ReleaseLockResponse> {
    return apiClient.post<typeof input, ReleaseLockResponse>(
      `/v1/workflows/${encodeURIComponent(workflowId)}/locks/release`,
      input,
    );
  },
};

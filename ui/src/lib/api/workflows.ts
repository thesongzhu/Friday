import { apiClient } from "./client";
import type {
  FridayWorkflowEntity,
  FridayWorkflowVersionEntity,
} from "./types";

// ─── Response wrappers ───

interface ListWorkflowsResponse {
  items: FridayWorkflowEntity[];
  nextCursor?: string;
}

interface CreateWorkflowResponse {
  workflow: FridayWorkflowEntity;
  version: FridayWorkflowVersionEntity;
}

interface GetWorkflowResponse {
  workflow: FridayWorkflowEntity;
  latestVersion: FridayWorkflowVersionEntity;
  publishedVersion?: FridayWorkflowVersionEntity;
}

interface UpdateWorkflowResponse {
  workflow: FridayWorkflowEntity;
  version?: FridayWorkflowVersionEntity;
}

interface ArchiveWorkflowResponse {
  archived: true;
}

interface PublishWorkflowResponse {
  publishedVersion: FridayWorkflowVersionEntity;
}

interface ListVersionsResponse {
  items: FridayWorkflowVersionEntity[];
  nextCursor?: string;
}

// ─── API ───

export const workflowsApi = {
  async list(query?: {
    tag?: string;
    archived?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<ListWorkflowsResponse> {
    const params = new URLSearchParams();
    if (query?.tag) params.set("tag", query.tag);
    if (query?.archived !== undefined) params.set("archived", String(query.archived));
    if (query?.cursor) params.set("cursor", query.cursor);
    if (query?.limit !== undefined) params.set("limit", String(query.limit));
    const qs = params.toString();
    const path = qs ? `/v1/workflows?${qs}` : "/v1/workflows";
    return apiClient.get<ListWorkflowsResponse>(path);
  },

  async create(input: {
    slug: string;
    name: string;
    description?: string;
    tags?: string[];
    graph: unknown;
  }): Promise<CreateWorkflowResponse> {
    return apiClient.post<typeof input, CreateWorkflowResponse>(
      "/v1/workflows",
      input,
    );
  },

  async get(workflowId: string): Promise<GetWorkflowResponse> {
    return apiClient.get<GetWorkflowResponse>(
      `/v1/workflows/${encodeURIComponent(workflowId)}`,
    );
  },

  async update(
    workflowId: string,
    patch: {
      expectedRevision: number;
      etag: string;
      name?: string;
      description?: string;
      tags?: string[];
      graph?: unknown;
    },
  ): Promise<UpdateWorkflowResponse> {
    return apiClient.patch<typeof patch, UpdateWorkflowResponse>(
      `/v1/workflows/${encodeURIComponent(workflowId)}`,
      patch,
    );
  },

  async archive(workflowId: string): Promise<ArchiveWorkflowResponse> {
    return apiClient.del<ArchiveWorkflowResponse>(
      `/v1/workflows/${encodeURIComponent(workflowId)}`,
    );
  },

  async publish(
    workflowId: string,
    input?: { versionNumber?: number; changeNote?: string },
  ): Promise<PublishWorkflowResponse> {
    return apiClient.post<typeof input | Record<string, never>, PublishWorkflowResponse>(
      `/v1/workflows/${encodeURIComponent(workflowId)}/publish`,
      input ?? {},
    );
  },

  async listVersions(
    workflowId: string,
    query?: { cursor?: string; limit?: number },
  ): Promise<ListVersionsResponse> {
    const params = new URLSearchParams();
    if (query?.cursor) params.set("cursor", query.cursor);
    if (query?.limit !== undefined) params.set("limit", String(query.limit));
    const qs = params.toString();
    const path = qs
      ? `/v1/workflows/${encodeURIComponent(workflowId)}/versions?${qs}`
      : `/v1/workflows/${encodeURIComponent(workflowId)}/versions`;
    return apiClient.get<ListVersionsResponse>(path);
  },
};

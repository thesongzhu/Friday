import { apiClient } from "./client";
import type {
  FridayMemoryItem,
  FridayMemorySearchResult,
  FridayMemoryPruneResult,
  FridayMemoryType,
} from "./types";

// ─── Response wrappers ───

interface StoreMemoryResponse {
  item: FridayMemoryItem;
}

interface SearchMemoryResponse {
  items: FridayMemorySearchResult[];
}

interface GetMemoryItemResponse {
  item: FridayMemoryItem;
}

interface ListMemoryItemsResponse {
  items: FridayMemoryItem[];
}

interface DeleteMemoryItemResponse {
  deleted: true;
}

interface PruneMemoryResponse {
  result: FridayMemoryPruneResult;
}

// ─── API ───

export const memoryApi = {
  async store(input: {
    namespace: string;
    content: string;
    source?: string;
    key?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    ttlSeconds?: number;
    expiresAt?: string;
    memoryType?: FridayMemoryType;
    confidence?: number;
  }): Promise<FridayMemoryItem> {
    const data = await apiClient.post<typeof input, StoreMemoryResponse>(
      "/v1/memory/store",
      input,
    );
    return data.item;
  },

  async search(input: {
    query: string;
    namespace?: string | string[];
    source?: string | string[];
    tagsAny?: string[];
    tagsAll?: string[];
    includeExpired?: boolean;
    limit?: number;
    minScore?: number;
    weights?: { fts: number; semantic: number };
    memoryType?: FridayMemoryType | FridayMemoryType[];
    boostByConfidence?: boolean;
    boostByAccess?: boolean;
    applyRetentionDecay?: boolean;
    retentionHalfLifeDays?: number;
  }): Promise<FridayMemorySearchResult[]> {
    const data = await apiClient.post<typeof input, SearchMemoryResponse>(
      "/v1/memory/search",
      input,
    );
    return data.items;
  },

  async getItem(id: string): Promise<FridayMemoryItem> {
    const data = await apiClient.get<GetMemoryItemResponse>(
      `/v1/memory/items/${encodeURIComponent(id)}`,
    );
    return data.item;
  },

  async listItems(query?: {
    namespace?: string;
    source?: string;
    includeExpired?: boolean;
    limit?: number;
  }): Promise<FridayMemoryItem[]> {
    const params = new URLSearchParams();
    if (query?.namespace) params.set("namespace", query.namespace);
    if (query?.source) params.set("source", query.source);
    if (query?.includeExpired) params.set("includeExpired", "true");
    if (query?.limit !== undefined) params.set("limit", String(query.limit));
    const qs = params.toString();
    const path = qs ? `/v1/memory/items?${qs}` : "/v1/memory/items";
    const data = await apiClient.get<ListMemoryItemsResponse>(path);
    return data.items;
  },

  async deleteItem(id: string): Promise<void> {
    await apiClient.del<DeleteMemoryItemResponse>(
      `/v1/memory/items/${encodeURIComponent(id)}`,
    );
  },

  async prune(input?: {
    namespace?: string | string[];
    source?: string | string[];
    tagsAny?: string[];
    expiredOnly?: boolean;
    olderThan?: string;
    limit?: number;
    dryRun?: boolean;
  }): Promise<FridayMemoryPruneResult> {
    const data = await apiClient.post<typeof input | Record<string, never>, PruneMemoryResponse>(
      "/v1/memory/prune",
      input ?? {},
    );
    return data.result;
  },
};

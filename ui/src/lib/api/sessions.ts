import { apiClient } from "./client";
import type {
  FridaySessionRecord,
  FridaySessionMessageRecord,
  FridaySessionPruneResult,
  FridaySessionSweepResult,
  FridaySessionForkCreateResult,
  FridaySessionForkMergeResult,
  FridaySessionMemoryExtractionRunResult,
  FridaySessionMemoryExtractionStatus,
  FridaySessionMemoryRetryResult,
  FridaySessionStatus,
} from "./types";

// ─── Response wrappers ───

interface ListSessionsResponse {
  items: FridaySessionRecord[];
}

interface CreateSessionResponse {
  session: FridaySessionRecord;
}

interface GetSessionResponse {
  session: FridaySessionRecord;
}

interface ArchiveSessionResponse {
  session: FridaySessionRecord;
}

interface PruneSessionsResponse {
  result: FridaySessionPruneResult;
}

interface SweepSessionsResponse {
  result: FridaySessionSweepResult;
}

interface ListMessagesResponse {
  items: FridaySessionMessageRecord[];
}

interface CreateMessageResponse {
  message: FridaySessionMessageRecord;
}

interface MemoryNamespaceResponse {
  namespace: string;
}

interface ForkSessionResponse {
  result: FridaySessionForkCreateResult;
}

interface ListForksResponse {
  items: FridaySessionRecord[];
}

interface MergeSessionResponse {
  result: FridaySessionForkMergeResult;
}

interface ExtractMemoryResponse {
  result: FridaySessionMemoryExtractionRunResult;
}

interface RememberMessagesResponse {
  result: FridaySessionMemoryExtractionRunResult;
}

interface ExtractionStatusResponse {
  status: FridaySessionMemoryExtractionStatus;
}

interface RetryExtractionsResponse {
  result: FridaySessionMemoryRetryResult;
}

// ─── Helpers ───

function encodeKey(sessionKey: string): string {
  return encodeURIComponent(sessionKey);
}

// ─── API ───

export const sessionsApi = {
  async list(query?: {
    status?: FridaySessionStatus;
    channel?: string;
    accountId?: string;
    userId?: string;
    limit?: number;
    cursor?: string;
  }): Promise<FridaySessionRecord[]> {
    const params = new URLSearchParams();
    if (query?.status) params.set("status", query.status);
    if (query?.channel) params.set("channel", query.channel);
    if (query?.accountId) params.set("accountId", query.accountId);
    if (query?.userId) params.set("userId", query.userId);
    if (query?.limit !== undefined) params.set("limit", String(query.limit));
    if (query?.cursor) params.set("cursor", query.cursor);
    const qs = params.toString();
    const path = qs ? `/v1/sessions?${qs}` : "/v1/sessions";
    const data = await apiClient.get<ListSessionsResponse>(path);
    return data.items;
  },

  async create(input: {
    channel: string;
    chatId: string;
    userId?: string;
    accountId?: string;
    chatKind?: string;
    metadata?: Record<string, unknown>;
  }): Promise<FridaySessionRecord> {
    const data = await apiClient.post<typeof input, CreateSessionResponse>(
      "/v1/sessions",
      input,
    );
    return data.session;
  },

  async get(sessionKey: string): Promise<FridaySessionRecord> {
    const data = await apiClient.get<GetSessionResponse>(
      `/v1/sessions/${encodeKey(sessionKey)}`,
    );
    return data.session;
  },

  async archive(sessionKey: string): Promise<FridaySessionRecord> {
    const data = await apiClient.post<Record<string, never>, ArchiveSessionResponse>(
      `/v1/sessions/${encodeKey(sessionKey)}/archive`,
      {},
    );
    return data.session;
  },

  async prune(olderThan: string): Promise<FridaySessionPruneResult> {
    const data = await apiClient.post<{ olderThan: string }, PruneSessionsResponse>(
      "/v1/sessions/prune",
      { olderThan },
    );
    return data.result;
  },

  async sweep(): Promise<FridaySessionSweepResult> {
    const data = await apiClient.post<Record<string, never>, SweepSessionsResponse>(
      "/v1/sessions/sweep",
      {},
    );
    return data.result;
  },

  async listMessages(
    sessionKey: string,
    query?: { limit?: number; before?: string },
  ): Promise<FridaySessionMessageRecord[]> {
    const params = new URLSearchParams();
    if (query?.limit !== undefined) params.set("limit", String(query.limit));
    if (query?.before) params.set("before", query.before);
    const qs = params.toString();
    const base = `/v1/sessions/${encodeKey(sessionKey)}/messages`;
    const path = qs ? `${base}?${qs}` : base;
    const data = await apiClient.get<ListMessagesResponse>(path);
    return data.items;
  },

  async createMessage(
    sessionKey: string,
    input: {
      role: string;
      content: unknown;
      contentText?: string;
      tokenCount?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<FridaySessionMessageRecord> {
    const data = await apiClient.post<typeof input, CreateMessageResponse>(
      `/v1/sessions/${encodeKey(sessionKey)}/messages`,
      input,
    );
    return data.message;
  },

  async getMemoryNamespace(sessionKey: string): Promise<string> {
    const data = await apiClient.get<MemoryNamespaceResponse>(
      `/v1/sessions/${encodeKey(sessionKey)}/memory-namespace`,
    );
    return data.namespace;
  },

  async fork(
    sessionKey: string,
    input?: {
      taskId?: string;
      inheritMessageCount?: number;
      forkFromMessageId?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<FridaySessionForkCreateResult> {
    const data = await apiClient.post<typeof input | Record<string, never>, ForkSessionResponse>(
      `/v1/sessions/${encodeKey(sessionKey)}/fork`,
      input ?? {},
    );
    return data.result;
  },

  async listForks(
    sessionKey: string,
    query?: { status?: FridaySessionStatus; limit?: number },
  ): Promise<FridaySessionRecord[]> {
    const params = new URLSearchParams();
    if (query?.status) params.set("status", query.status);
    if (query?.limit !== undefined) params.set("limit", String(query.limit));
    const qs = params.toString();
    const base = `/v1/sessions/${encodeKey(sessionKey)}/forks`;
    const path = qs ? `${base}?${qs}` : base;
    const data = await apiClient.get<ListForksResponse>(path);
    return data.items;
  },

  async merge(
    sessionKey: string,
    input: {
      forkSessionKey: string;
      summary: string;
      archiveFork?: boolean;
      idempotencyKey?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<FridaySessionForkMergeResult> {
    const data = await apiClient.post<typeof input, MergeSessionResponse>(
      `/v1/sessions/${encodeKey(sessionKey)}/merge`,
      input,
    );
    return data.result;
  },

  async extractMemory(
    sessionKey: string,
    input?: {
      trigger?: "auto" | "manual" | "retry";
      mode?: "queue" | "inline";
      batchSize?: number;
      maxBatches?: number;
    },
  ): Promise<FridaySessionMemoryExtractionRunResult> {
    const data = await apiClient.post<typeof input | Record<string, never>, ExtractMemoryResponse>(
      `/v1/sessions/${encodeKey(sessionKey)}/memory/extract`,
      input ?? {},
    );
    return data.result;
  },

  async rememberMessages(
    sessionKey: string,
    input: { messageIds: string[]; mode?: "queue" | "inline" },
  ): Promise<FridaySessionMemoryExtractionRunResult> {
    const data = await apiClient.post<typeof input, RememberMessagesResponse>(
      `/v1/sessions/${encodeKey(sessionKey)}/memory/remember`,
      input,
    );
    return data.result;
  },

  async getExtractionStatus(
    sessionKey: string,
  ): Promise<FridaySessionMemoryExtractionStatus> {
    const data = await apiClient.get<ExtractionStatusResponse>(
      `/v1/sessions/${encodeKey(sessionKey)}/memory/extraction`,
    );
    return data.status;
  },

  async retryExtractions(
    sessionKey?: string,
  ): Promise<FridaySessionMemoryRetryResult> {
    const data = await apiClient.post<{ sessionKey?: string }, RetryExtractionsResponse>(
      "/v1/sessions/memory/extraction/retry",
      sessionKey ? { sessionKey } : {},
    );
    return data.result;
  },
};

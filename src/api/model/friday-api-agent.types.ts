import type {
  FridayAgentContextCostSummary,
  FridayAgentExecutionContext,
  FridayAgentRunRecord,
  FridayAgentRunStatus,
  FridayAgentTaskProfileInput,
  FridayResolvedAgentTaskProfile,
} from "#agent";
import type { FridayPaginationQuery } from "./friday-api-common.types.js";

export interface FridayStartAgentRunRequest {
  task: string;
  taskPrompt?: string;
  marketplaceListingId?: string;
  providerId?: string;
  requestedProviderId?: string;
  model?: string;
  requestedModel?: string;
  replyToMessageId?: string;
  sessionKey?: string;
  timezone?: string;
  timeoutMs?: number;
  requireReview?: boolean;
  constraints?: { readOnly?: boolean };
  taskProfile?: FridayAgentTaskProfileInput;
  executionContext?: FridayAgentExecutionContext;
}

export interface FridayAgentRunExecutionResponse {
  runId: string;
  status: FridayAgentRunStatus;
  response: string;
  toolCallCount: number;
  durationMs: number;
  usageInput: number;
  usageOutput: number;
  images?: string[];
  finalResponse?: string;
  contextCostSummary?: FridayAgentContextCostSummary;
  taskProfile?: FridayResolvedAgentTaskProfile;
}

export interface FridayStartAgentRunResponse extends FridayAgentRunExecutionResponse {
  eventStreamAvailable: true;
}

export interface FridayListAgentRunsQuery extends FridayPaginationQuery {
  status?: FridayAgentRunStatus;
}

export interface FridayListAgentRunsResponse {
  items: FridayAgentRunRecord[];
}

export interface FridayGetAgentRunResponse {
  run: FridayAgentRunRecord;
}

export interface FridayCancelAgentRunResponse {
  cancelled: boolean;
  runId: string;
}

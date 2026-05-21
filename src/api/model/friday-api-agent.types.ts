import type {
  FridayAgentContextCostSummary,
  FridayAgentExecutionContext,
  FridayAgentRunConstraints,
  FridayAgentRunRecord,
  FridayAgentRunStatus,
  FridayAgentTaskProfileInput,
  FridayAgentUnifiedTaskStateSnapshot,
  FridayResolvedAgentTaskProfile,
} from "#agent";
import type { FridayPaginationQuery } from "./friday-api-common.types.js";

export interface FridayStartAgentRunRequest {
  task: string;
  taskPrompt?: string;
  providerId?: string;
  requestedProviderId?: string;
  model?: string;
  requestedModel?: string;
  replyToMessageId?: string;
  sessionKey?: string;
  timezone?: string;
  timeoutMs?: number;
  requireReview?: boolean;
  constraints?: FridayAgentRunConstraints;
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

export interface FridayAgentRunWithUnifiedTaskState extends FridayAgentRunRecord {
  unifiedTaskState: FridayAgentUnifiedTaskStateSnapshot;
}

export interface FridayListAgentRunsResponse {
  items: FridayAgentRunWithUnifiedTaskState[];
}

export interface FridayGetAgentRunResponse {
  run: FridayAgentRunWithUnifiedTaskState;
}

export interface FridayCancelAgentRunResponse {
  cancelled: boolean;
  runId: string;
}

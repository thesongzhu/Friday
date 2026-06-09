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
  /**
   * execrun-replacement S-F-compose (DARK): the explicit, positive, per-run grant of the
   * Rust read-tool set. Additive + optional — every existing caller omits it. When the
   * default-OFF `routeAgentRunViaRust` flag is on, ONLY a request that positively grants
   * exactly the 4 Rust read tools (read_file/list_dir/stat_file/search) can qualify for the
   * Rust read-only route. Absent ⇒ disqualified ⇒ today's unchanged 503. Never derived from
   * readOnly — this is the independent clause-4 gate.
   */
  allowedRustRouteTools?: string[];
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

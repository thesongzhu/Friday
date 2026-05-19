import type { FridaySqliteLayer } from "#state";
import type { FridayProviderTenantContext } from "#providers";
import type { FridaySessionService } from "#sessions";
import type { FridayAgentMessage } from "../model/friday-agent.types.js";
import type {
  FridayAgentConversationContext,
  FridayAgentRuntimeResult,
} from "../runtime/friday-agent-runtime.types.js";
import type { FridayAgentEventEmitter } from "../runtime/friday-agent-event-emitter.js";
import type { FridayAgentTaskProfileInput } from "../runtime/friday-agent-task-profile.js";
import type { FridayAgentRunConstraints } from "../model/friday-agent.types.js";
import type {
  FridaySubagentProfileId,
  FridaySubagentProfileInput,
} from "./friday-subagent-profile.js";

// ─── Sub-agent run status ───

export type FridaySubagentRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type FridaySubagentSpawnMode = "fresh" | "fork";

// ─── Sub-agent outcome (result summary) ───

export interface FridaySubagentOutcome {
  status: "completed" | "failed" | "cancelled";
  response: string;
  toolCallCount: number;
  durationMs: number;
  usageInput: number;
  usageOutput: number;
  images?: string[];
}

// ─── Sub-agent spawn input (from tool) ───

export interface FridaySubagentSpawnInput {
  task: string;
  label?: string;
  model?: string;
  profile?: FridaySubagentProfileId;
  timeoutMs?: number;
  mode?: FridaySubagentSpawnMode;
  inheritMessageCount?: number;
  forkFromMessageId?: string;
}

// ─── Sub-agent run record (persisted in SQLite) ───

export interface FridaySubagentRunRecord {
  id: string;
  parentRunId: string;
  parentSessionKey: string;
  childRunId: string;
  childSessionKey: string;
  task: string;
  label?: string;
  model?: string;
  mode: FridaySubagentSpawnMode;
  forkedFromMessageId?: string;
  inheritedMessageCount?: number;
  depth: number;
  status: FridaySubagentRunStatus;
  outcome?: FridaySubagentOutcome;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  /** Session key of the original requester (for lifecycle queries). */
  requesterSessionKey?: string;
  /** Root run ID (the original top-level run). */
  rootRunId?: string;
  /** Whether cleanup has been requested for this subagent run. */
  cleanupRequested?: boolean;
  /** ISO timestamp after which this run record may be archived. */
  archivalDeadline?: string;
}

// ─── Sub-agent context (passed through executeRun) ───

export interface FridaySubagentContext {
  /** Current nesting depth (0 = top-level run, 1 = first sub-agent, etc.) */
  depth: number;
  /** Run ID of the immediate parent */
  parentRunId: string;
  /** Session key of the immediate parent */
  parentSessionKey: string;
  /** Root-level run ID (the original top-level run) */
  rootRunId: string;
  /** Parent run timezone when known. */
  timezone?: string;
}

// ─── Detached spawn result ───

export interface FridaySubagentDetachedResult {
  subagentId: string;
  childRunId: string;
  childSessionKey: string;
  status: "accepted";
  statusSnapshot: FridaySubagentRunStatus;
  outcome?: FridaySubagentOutcome;
  mode: FridaySubagentSpawnMode;
  forkedFromMessageId?: string;
  inheritedMessageCount?: number;
  detached: true;
  awaited: false;
}

// ─── Registry interface ───

export interface FridaySubagentRegistry {
  /** Spawn a child run. Blocks until child completes. Returns outcome. */
  spawn(input: FridaySubagentRegistrySpawnInput): Promise<FridaySubagentOutcome>;
  /** Spawn a child run in detached mode. Returns immediately with accepted metadata. */
  spawnDetached(input: FridaySubagentRegistrySpawnInput): Promise<FridaySubagentDetachedResult>;
  /** Wait for in-flight detached children to settle before shutdown. */
  drain(timeoutMs?: number): Promise<void>;
  /** Start a detached child run (called internally after spawnDetached). */
  startRun(subagentId: string): Promise<FridaySubagentOutcome>;
  /** Wait for a sub-agent to complete (poll until terminal status). */
  waitForCompletion(subagentId: string, timeoutMs?: number): Promise<FridaySubagentOutcome>;
  /** Finalize a sub-agent record (set cleanup flags, archival deadline). */
  finalize(subagentId: string, opts?: { archivalDeadline?: string }): void;
  /** Cleanup completed/failed sub-agent records older than archival deadline. */
  cleanup(beforeIso?: string): number;
  /** Resume or fail pending/running subagents on boot. */
  resumeOnBoot(): number;
  /** List sub-agent runs for a given parent run. */
  listByParentRunId(parentRunId: string): FridaySubagentRunRecord[];
  /** Get a sub-agent run record by its ID. */
  getById(id: string): FridaySubagentRunRecord | null;
  /** List all sub-agent runs (with optional filters). */
  list(filters?: FridaySubagentListFilters): FridaySubagentRunRecord[];
  /** Get count of currently running sub-agents for a parent. */
  activeCountForParent(parentRunId: string): number;
}

export interface FridaySubagentRegistrySpawnInput {
  task: string;
  taskPrompt?: string;
  label?: string;
  providerId?: string;
  model?: string;
  profile?: FridaySubagentProfileId | FridaySubagentProfileInput;
  timezone?: string;
  timeoutMs?: number;
  mode?: FridaySubagentSpawnMode;
  inheritMessageCount?: number;
  forkFromMessageId?: string;
  conversationContext?: FridayAgentConversationContext;
  tenantContext?: FridayProviderTenantContext;
  parentRunId: string;
  parentSessionKey: string;
  depth: number;
  rootRunId: string;
  constraints?: FridayAgentRunConstraints;
  disabledToolNames?: string[];
  principalId?: string;
  signal: AbortSignal;
}

export interface FridaySubagentListFilters {
  parentRunId?: string;
  status?: FridaySubagentRunStatus;
  requesterSessionKey?: string;
  rootRunId?: string;
  limit?: number;
  cursor?: string;
}

// ─── Factory deps ───

export interface CreateFridaySubagentRegistryDeps {
  db: FridaySqliteLayer;
  createChildRuntime: (params: CreateChildRuntimeParams) => {
    executeRun: (params: {
      task: string;
      historyMessages?: FridayAgentMessage[];
      taskPrompt?: string;
      sessionKey: string;
      runId?: string;
      providerId?: string;
      model?: string;
      modelSelectionSourceOverride?: "inherited";
      timezone?: string;
      timeoutMs?: number;
      conversationContext?: FridayAgentConversationContext;
      tenantContext?: FridayProviderTenantContext;
      signal?: AbortSignal;
      constraints?: FridayAgentRunConstraints;
      disabledToolNames?: string[];
      principalId?: string;
      taskProfile?: FridayAgentTaskProfileInput;
    }) => Promise<FridayAgentRuntimeResult>;
  };
  eventEmitter: FridayAgentEventEmitter;
  idGenerator: () => string;
  nowIso: () => string;
  sessionService?: FridaySessionService;
  userRulesContextProvider?: (input: {
    task: string;
    parentSessionKey: string;
    depth: number;
    mode: FridaySubagentSpawnMode;
    surface: "subagent";
  }) => string | null | Promise<string | null>;
}

export interface CreateChildRuntimeParams {
  providerId?: string;
  model?: string;
  systemPrompt: string;
  depth: number;
  rootRunId: string;
}

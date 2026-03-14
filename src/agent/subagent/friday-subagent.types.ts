import type { FridaySqliteLayer } from "#state";
import type { FridayAgentRuntimeResult } from "../runtime/friday-agent-runtime.types.js";
import type { FridayAgentEventEmitter } from "../runtime/friday-agent-event-emitter.js";
import type { FridayAgentRunConstraints } from "../model/friday-agent.types.js";

// ─── Sub-agent run status ───

export type FridaySubagentRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

// ─── Sub-agent outcome (result summary) ───

export interface FridaySubagentOutcome {
  status: "completed" | "failed" | "cancelled";
  response: string;
  toolCallCount: number;
  durationMs: number;
  usageInput: number;
  usageOutput: number;
}

// ─── Sub-agent spawn input (from tool) ───

export interface FridaySubagentSpawnInput {
  task: string;
  label?: string;
  model?: string;
  timeoutMs?: number;
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
  detached: true;
  awaited: false;
}

// ─── Registry interface ───

export interface FridaySubagentRegistry {
  /** Spawn a child run. Blocks until child completes. Returns outcome. */
  spawn(input: FridaySubagentRegistrySpawnInput): Promise<FridaySubagentOutcome>;
  /** Spawn a child run in detached mode. Returns immediately with accepted metadata. */
  spawnDetached(input: FridaySubagentRegistrySpawnInput): FridaySubagentDetachedResult;
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
  label?: string;
  model?: string;
  timezone?: string;
  timeoutMs?: number;
  parentRunId: string;
  parentSessionKey: string;
  depth: number;
  rootRunId: string;
  constraints?: FridayAgentRunConstraints;
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
      sessionKey: string;
      runId?: string;
      timezone?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      constraints?: FridayAgentRunConstraints;
    }) => Promise<FridayAgentRuntimeResult>;
  };
  eventEmitter: FridayAgentEventEmitter;
  idGenerator: () => string;
  nowIso: () => string;
}

export interface CreateChildRuntimeParams {
  model?: string;
  systemPrompt: string;
  depth: number;
  rootRunId: string;
}

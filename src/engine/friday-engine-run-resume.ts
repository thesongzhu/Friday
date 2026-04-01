/**
 * Engine Run Resume — Initiative A.6
 *
 * Provides persistence hooks and resume capability for engine runs.
 * Leverages the existing `FridayAgentRunEventRepository` and
 * `FridayAgentRunRepository` — does not introduce new tables.
 *
 * Resume reads the latest durable run record, reconstructs a
 * `FridayEngineRunInput`, and re-enters the engine. This decouples
 * resume from session history replay.
 */

import type { FridayAgentRunRecord, FridayAgentRunStatus } from "../agent/model/friday-agent.types.js";
import type { FridayAgentRunEventRecord } from "../agent/persistence/friday-agent-run-event-repository.js";
import type { FridayEngineRunInput, FridayRunTerminalStatus } from "./friday-orchestration-engine.types.js";

// ─── Narrow repository interfaces (avoid coupling to Database type) ───

export interface FridayEngineRunRecordReader {
  getById(id: string): FridayAgentRunRecord | null;
}

export interface FridayEngineRunEventReader {
  list(runId: string, afterSeq?: number): FridayAgentRunEventRecord[];
}

// ─── Resume result ───

export interface FridayEngineResumeResult {
  /** Whether the run was found and is resumable. */
  resumable: boolean;
  /** Reconstructed engine input (present when resumable). */
  input?: FridayEngineRunInput;
  /** The persisted run record snapshot. */
  record?: FridayAgentRunRecord;
  /** Reason the run is not resumable (present when !resumable). */
  reason?: string;
}

// ─── Resumable status set ───

const RESUMABLE_STATUSES = new Set<FridayAgentRunStatus>([
  "awaiting_clarification",
  "awaiting_plan_approval",
  "pending",
  "planning",
]);

const TERMINAL_STATUSES = new Set<FridayAgentRunStatus>([
  "completed",
  "failed",
  "failed_tests",
  "cancelled",
]);

// ─── Factory ───

export interface CreateFridayEngineRunResumeDeps {
  runRecordReader: FridayEngineRunRecordReader;
  runEventReader?: FridayEngineRunEventReader;
}

export function createFridayEngineRunResume(deps: CreateFridayEngineRunResumeDeps) {
  const { runRecordReader } = deps;

  /**
   * Attempt to reconstruct a resumable `FridayEngineRunInput` from
   * a persisted run record.
   */
  function tryResume(runId: string): FridayEngineResumeResult {
    const record = runRecordReader.getById(runId);
    if (!record) {
      return { resumable: false, reason: `Run ${runId} not found.` };
    }

    if (TERMINAL_STATUSES.has(record.status)) {
      return {
        resumable: false,
        record,
        reason: `Run ${runId} is already in terminal status: ${record.status}.`,
      };
    }

    if (!RESUMABLE_STATUSES.has(record.status)) {
      return {
        resumable: false,
        record,
        reason: `Run ${runId} is in non-resumable status: ${record.status}.`,
      };
    }

    const input: FridayEngineRunInput = {
      task: record.task,
      runId: record.id,
      sessionKey: record.sessionKey,
      providerId: record.providerId,
      model: record.model,
      constraints: record.constraints,
    };

    return { resumable: true, input, record };
  }

  /**
   * Check whether a run is in a terminal state.
   */
  function isTerminal(runId: string): boolean {
    const record = runRecordReader.getById(runId);
    return record ? TERMINAL_STATUSES.has(record.status) : true;
  }

  /**
   * Map a persisted `FridayAgentRunStatus` to the engine's terminal
   * status type. Returns undefined for non-terminal statuses.
   */
  function toTerminalStatus(status: FridayAgentRunStatus): FridayRunTerminalStatus | undefined {
    switch (status) {
      case "completed":
        return "completed";
      case "failed":
        return "failed";
      case "cancelled":
        return "cancelled";
      case "awaiting_clarification":
        return "awaiting_clarification";
      case "awaiting_plan_approval":
        return "awaiting_plan_approval";
      case "failed_tests":
        return "failed_tests";
      default:
        return undefined;
    }
  }

  return { tryResume, isTerminal, toTerminalStatus };
}

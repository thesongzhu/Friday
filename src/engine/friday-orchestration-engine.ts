/**
 * Concrete Orchestration Engine — Initiative A-WIRE.
 *
 * Composes the turn preparer, run executor, and run resume into a
 * single `FridayOrchestrationEngine` implementation.
 *
 * Entry adapters (API runtime, channel bootstrap) instantiate this
 * once and delegate all run orchestration through it.
 */

import type {
  FridayEngineRunInput,
  FridayEngineRunResult,
  FridayOrchestrationEngine,
} from "./friday-orchestration-engine.types.js";
import type {
  CreateFridayEngineTurnPreparerDeps,
  FridayEngineTurnPreparerSessionDeps,
} from "./friday-engine-turn-preparer.js";
import { createFridayEngineTurnPreparer } from "./friday-engine-turn-preparer.js";
import type { CreateFridayEngineRunExecutorDeps } from "./friday-engine-run-executor.js";
import { createFridayEngineRunExecutor } from "./friday-engine-run-executor.js";
import type { CreateFridayEngineRunResumeDeps } from "./friday-engine-run-resume.js";
import { createFridayEngineRunResume } from "./friday-engine-run-resume.js";

// ─── Factory deps ───

export interface CreateFridayOrchestrationEngineDeps {
  turnPreparerDeps: CreateFridayEngineTurnPreparerDeps;
  runExecutorDeps: CreateFridayEngineRunExecutorDeps;
  resumeDeps?: CreateFridayEngineRunResumeDeps;
  /**
   * Callback to mark stale (in-flight) runs as failed on boot.
   * Returns the count of runs marked.
   */
  markStaleRunsFailed?: () => number;
}

// ─── Factory ───

export function createFridayOrchestrationEngine(
  deps: CreateFridayOrchestrationEngineDeps,
): FridayOrchestrationEngine {
  const turnPreparer = createFridayEngineTurnPreparer(deps.turnPreparerDeps);
  const runExecutor = createFridayEngineRunExecutor(deps.runExecutorDeps);
  const runResume = deps.resumeDeps
    ? createFridayEngineRunResume(deps.resumeDeps)
    : undefined;

  async function executeRun(input: FridayEngineRunInput): Promise<FridayEngineRunResult> {
    const prepared = await turnPreparer.prepare({
      task: input.task,
      runId: input.runId,
      sessionKey: input.sessionKey,
      replyToMessageId: input.replyToMessageId,
      constraints: input.constraints,
      persistTaskMessage: !input.taskAlreadyInHistory,
      taskAlreadyInHistory: input.taskAlreadyInHistory,
      idempotencyPrefix: input.idempotencyPrefix,
    });

    return runExecutor.execute(input, prepared);
  }

  async function resumeRun(
    runId: string,
    patch?: Partial<FridayEngineRunInput>,
  ): Promise<FridayEngineRunResult> {
    if (!runResume) {
      return {
        runId,
        status: "failed",
        toolCallCount: 0,
        durationMs: 0,
        error: {
          category: "internal_error",
          message: "Run resume is not configured.",
          retryable: false,
        },
      };
    }

    const resumeResult = runResume.tryResume(runId);
    if (!resumeResult.resumable || !resumeResult.input) {
      return {
        runId,
        status: "failed",
        toolCallCount: 0,
        durationMs: 0,
        error: {
          category: "internal_error",
          message: resumeResult.reason ?? "Run is not resumable.",
          retryable: false,
        },
      };
    }

    const mergedInput: FridayEngineRunInput = {
      ...resumeResult.input,
      ...patch,
      runId, // always preserve original runId
    };

    return executeRun(mergedInput);
  }

  async function cancelRun(runId: string): Promise<void> {
    // Cancel is a no-op if resume deps are absent — the caller (API runtime)
    // manages abort controllers externally.
    if (!runResume) return;
    // The existing agent runtime abort controller mechanism handles actual
    // cancellation; this method exists for interface completeness.
  }

  function resumeStaleRunsOnBoot(): number {
    return deps.markStaleRunsFailed?.() ?? 0;
  }

  return { executeRun, resumeRun, cancelRun, resumeStaleRunsOnBoot };
}

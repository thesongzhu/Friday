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

function isPublicIsolatedEngineRun(
  constraints: FridayEngineRunInput["constraints"],
): boolean {
  return constraints?.readOnly === true
    && constraints.operationalMode === "restricted"
    && constraints.dataSensitivity === "public";
}

export function createFridayOrchestrationEngine(
  deps: CreateFridayOrchestrationEngineDeps,
): FridayOrchestrationEngine {
  const turnPreparer = createFridayEngineTurnPreparer(deps.turnPreparerDeps);
  const runExecutor = createFridayEngineRunExecutor(deps.runExecutorDeps);
  const runResume = deps.resumeDeps
    ? createFridayEngineRunResume(deps.resumeDeps)
    : undefined;

  async function executeRun(input: FridayEngineRunInput): Promise<FridayEngineRunResult> {
    const publicIsolatedRun = isPublicIsolatedEngineRun(input.constraints);
    const sanitizedInput = publicIsolatedRun
      ? { ...input, sessionKey: undefined }
      : input;
    const prepared = await turnPreparer.prepare({
      task: sanitizedInput.task,
      taskPrompt: sanitizedInput.taskPrompt,
      runId: sanitizedInput.runId,
      sessionKey: sanitizedInput.sessionKey,
      replyToMessageId: sanitizedInput.replyToMessageId,
      constraints: sanitizedInput.constraints,
      persistTaskMessage: !sanitizedInput.taskAlreadyInHistory,
      taskAlreadyInHistory: sanitizedInput.taskAlreadyInHistory,
      idempotencyPrefix: sanitizedInput.idempotencyPrefix,
      skipPrivateSessionContext: publicIsolatedRun,
    });

    return runExecutor.execute(sanitizedInput, prepared);
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

  /**
   * Cancel a run by `runId`.
   *
   * **B4 truth-labeling note (this is an intentional no-op for interface
   * completeness):** the orchestration engine does NOT itself maintain an
   * abort-controller registry for in-flight runs. The actual cancellation
   * is handled upstream by:
   * - `src/api/runtime/friday-api-runtime.ts` — request-scoped
   *   AbortController per agent run
   * - `src/agent/runtime/friday-agent-runtime.ts` — internal abort
   *   propagation through tool calls
   *
   * Calling this method has no observable side effect on the run unless
   * one of those upstream layers wires through. The method exists so the
   * `FridayOrchestrationEngine` shape matches the consumer expectation
   * (callers may check for the method's presence). A future
   * "centralize-cancellation" slice could wire this through a registry;
   * until then it remains a documented no-op.
   */
  async function cancelRun(runId: string): Promise<void> {
    void runId;
    if (!runResume) return;
    // No-op by design — see JSDoc above.
  }

  function resumeStaleRunsOnBoot(): number {
    return deps.markStaleRunsFailed?.() ?? 0;
  }

  return { executeRun, resumeRun, cancelRun, resumeStaleRunsOnBoot };
}

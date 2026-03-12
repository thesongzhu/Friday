import type { FridayWorkflowExecutionService } from "#workflows";

// ─── Types ───

export interface CreateFridayWorkflowTimeoutJobDeps {
  executionService: FridayWorkflowExecutionService;
  nowIso: () => string;
}

export interface FridayWorkflowTimeoutJob {
  run(): Promise<FridayWorkflowTimeoutJobResult>;
}

export interface FridayWorkflowTimeoutJobResult {
  leasesReaped: number;
  runsTimedOut: number;
  nodesTimedOut: number;
}

// ─── Factory ───

export function createFridayWorkflowTimeoutJob(
  deps: CreateFridayWorkflowTimeoutJobDeps,
): FridayWorkflowTimeoutJob {
  return {
    async run() {
      const nowIso = deps.nowIso();

      // 1. Reap expired leases (existing)
      const leasesReaped = await deps.executionService.reapExpiredLeases();

      // 2. Sweep timed-out runs (check run deadline_at / runTimeoutMs)
      const runsTimedOut = await deps.executionService.sweepTimedOutRuns(nowIso);

      // 3. Sweep timed-out nodes (check node timeout_ms)
      const nodesTimedOut = await deps.executionService.sweepTimedOutNodes(nowIso);

      return { leasesReaped, runsTimedOut, nodesTimedOut };
    },
  };
}

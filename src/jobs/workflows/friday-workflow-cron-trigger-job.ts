import type { FridayWorkflowTriggerService } from "#workflows";

// ─── Types ───

export interface CreateFridayWorkflowCronTriggerJobDeps {
  triggerService: FridayWorkflowTriggerService;
  nowIso: () => string;
}

export interface FridayWorkflowCronTriggerJob {
  run(): Promise<FridayWorkflowCronTriggerJobResult>;
}

export interface FridayWorkflowCronTriggerJobResult {
  runsStarted: number;
}

// ─── Factory ───

export function createFridayWorkflowCronTriggerJob(
  deps: CreateFridayWorkflowCronTriggerJobDeps,
): FridayWorkflowCronTriggerJob {
  return {
    async run(): Promise<FridayWorkflowCronTriggerJobResult> {
      const nowIso = deps.nowIso();
      const runsStarted = await deps.triggerService.tickCron(nowIso);
      return { runsStarted };
    },
  };
}

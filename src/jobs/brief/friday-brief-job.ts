import type { FridayBriefRunRecord, FridayBriefService } from "#brief";

export interface FridayBriefJobResult {
  run: FridayBriefRunRecord;
}

export interface CreateFridayBriefJobDeps {
  briefService: FridayBriefService;
}

export interface FridayBriefJob {
  run(): Promise<FridayBriefJobResult>;
}

export function createFridayBriefJob(deps: CreateFridayBriefJobDeps): FridayBriefJob {
  return {
    async run() {
      const run = await deps.briefService.runOnce({ triggeredBy: "scheduled" });
      return { run };
    },
  };
}

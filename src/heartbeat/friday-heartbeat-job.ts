import type { FridayHeartbeatRunner, FridayHeartbeatRunResult } from "./friday-heartbeat.types.js";

export interface CreateFridayHeartbeatJobDeps {
  runner: FridayHeartbeatRunner;
}

export interface FridayHeartbeatJob {
  run(): Promise<FridayHeartbeatRunResult>;
}

export function createFridayHeartbeatJob(
  deps: CreateFridayHeartbeatJobDeps,
): FridayHeartbeatJob {
  return {
    async run(): Promise<FridayHeartbeatRunResult> {
      return deps.runner.runOnce();
    },
  };
}


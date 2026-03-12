import type { FridaySessionSweepResult } from "#sessions";

export interface FridaySessionLifecycleJobResult {
  sweep: FridaySessionSweepResult;
  extractionsQueued: number;
  idledSessionKeys: string[];
}

import type { FridaySessionMemoryExtractionRunResult } from "#sessions";

export interface FridaySessionMemoryExtractionWorkerResult {
  processedJobs: number;
  completedJobs: number;
  failedJobs: number;
  results: FridaySessionMemoryExtractionRunResult[];
}

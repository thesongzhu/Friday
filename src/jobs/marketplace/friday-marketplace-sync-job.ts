import type { FridayMarketplaceCacheService, FridayMarketplaceSyncService } from "#skills";
import { computeFridayBackoff } from "#utilities";
import type {
  FridayMarketplaceSyncJobConfig,
  FridayMarketplaceSyncJobResult,
} from "./friday-marketplace-sync.types.js";
import { FRIDAY_DEFAULT_SYNC_JOB_CONFIG } from "./friday-marketplace-sync.types.js";

// ─── Interface ───

export interface FridayMarketplaceSyncJob {
  /** Run a single sync cycle. */
  runOnce(): Promise<FridayMarketplaceSyncJobResult>;
  /** Start the periodic sync loop. */
  start(): void;
  /** Stop the periodic sync loop. */
  stop(): void;
  /** Whether the job loop is currently active. */
  isRunning(): boolean;
}

// ─── Dependencies ───

export interface CreateMarketplaceSyncJobDeps {
  syncService: FridayMarketplaceSyncService;
  cacheService: FridayMarketplaceCacheService;
  config?: FridayMarketplaceSyncJobConfig;
}

// ─── Factory ───

export function createFridayMarketplaceSyncJob(
  deps: CreateMarketplaceSyncJobDeps,
): FridayMarketplaceSyncJob {
  const config = deps.config ?? FRIDAY_DEFAULT_SYNC_JOB_CONFIG;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let consecutiveFailures = 0;

  function computeDelay(): number {
    if (consecutiveFailures === 0) {
      const jitter = Math.floor(Math.random() * config.jitterMs);
      return config.intervalMs + jitter;
    }
    // Use shared backoff utility for exponential backoff on failures.
    // consecutiveFailures is 1-based (incremented after each failure), so
    // we pass it directly as the zero-based attempt index: after 1 failure
    // → attempt 1 → base*2^1, providing meaningful backoff from the start.
    return computeFridayBackoff(consecutiveFailures, {
      baseMs: config.intervalMs,
      maxMs: config.maxBackoffMs,
      jitterFactor: config.jitterMs / config.intervalMs,
    });
  }

  async function runCycle(): Promise<void> {
    if (!running) return;

    try {
      await job.runOnce();
      consecutiveFailures = 0;
    } catch {
      consecutiveFailures++;
    }

    if (running) {
      timer = setTimeout(() => void runCycle(), computeDelay());
    }
  }

  const job: FridayMarketplaceSyncJob = {
    async runOnce() {
      // Prune stale cache entries first
      deps.cacheService.pruneStaleEntries();

      // Sync all enabled sources
      const results = await deps.syncService.syncAllSources();

      const allErrors: string[] = [];
      let sourcesSucceeded = 0;
      let totalSkillsSynced = 0;
      let totalVersionsSynced = 0;

      for (const r of results) {
        if (r.errors.length === 0) {
          sourcesSucceeded++;
        }
        allErrors.push(...r.errors);
        totalSkillsSynced += r.skillsSynced;
        totalVersionsSynced += r.versionsSynced;
      }

      return {
        sourcesAttempted: results.length,
        sourcesSucceeded,
        totalSkillsSynced,
        totalVersionsSynced,
        errors: allErrors,
      };
    },

    start() {
      if (running) return;
      running = true;
      consecutiveFailures = 0;
      // Start first cycle after a small initial delay
      timer = setTimeout(() => void runCycle(), 1000);
    },

    stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },

    isRunning() {
      return running;
    },
  };

  return job;
}

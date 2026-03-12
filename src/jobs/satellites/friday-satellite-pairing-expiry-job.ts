/**
 * Satellite Pairing Expiry Job — Expires stale pairing requests and
 * cleans up resolved requests after a retention period.
 *
 * @module jobs/satellites/friday-satellite-pairing-expiry-job
 */

// ─── Configuration ───

export interface FridaySatellitePairingExpiryConfig {
  /** How often to run the expiry sweep (ms). */
  readonly intervalMs: number;
  /** Jitter to spread load (ms). */
  readonly jitterMs: number;
  /** Retention period for resolved requests before deletion (ms). */
  readonly resolvedRetentionMs: number;
}

export const DEFAULT_PAIRING_EXPIRY_CONFIG: FridaySatellitePairingExpiryConfig = {
  intervalMs: 5 * 60 * 1000, // 5 minutes
  jitterMs: 10_000, // 10 seconds
  resolvedRetentionMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};

// ─── Result ───

export interface FridaySatellitePairingExpiryResult {
  readonly requestsExpired: number;
  readonly requestsCleaned: number;
  readonly errors: string[];
}

// ─── Deps ───

export interface FridaySatellitePairingExpiryDeps {
  readonly nowIso: () => string;
  readonly config?: FridaySatellitePairingExpiryConfig;

  /** List pending pairing requests that have expired. */
  readonly listPendingExpiredBefore: (
    before: string,
  ) => Promise<ReadonlyArray<{ requestId: string; satelliteId: string }>>;

  /** Mark a pairing request as expired. */
  readonly expirePairingRequest: (requestId: string) => Promise<void>;

  /** Delete resolved (approved/rejected/expired) requests older than a cutoff. */
  readonly deleteResolvedBefore: (before: string) => Promise<number>;
}

// ─── Interface ───

export interface FridaySatellitePairingExpiryJob {
  runOnce(): Promise<FridaySatellitePairingExpiryResult>;
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

// ─── Factory ───

export function createFridaySatellitePairingExpiryJob(
  deps: FridaySatellitePairingExpiryDeps,
): FridaySatellitePairingExpiryJob {
  const config = deps.config ?? DEFAULT_PAIRING_EXPIRY_CONFIG;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  async function runCycle(): Promise<void> {
    if (!running) return;
    try {
      await job.runOnce();
    } catch {
      // continue
    }
    if (running) {
      const jitter = Math.floor(Math.random() * config.jitterMs);
      timer = setTimeout(() => void runCycle(), config.intervalMs + jitter);
    }
  }

  const job: FridaySatellitePairingExpiryJob = {
    async runOnce() {
      const result: {
        requestsExpired: number;
        requestsCleaned: number;
        errors: string[];
      } = { requestsExpired: 0, requestsCleaned: 0, errors: [] };

      const now = deps.nowIso();

      // Phase 1: Expire pending requests past their expiry time
      try {
        const expired = await deps.listPendingExpiredBefore(now);
        for (const req of expired) {
          try {
            await deps.expirePairingRequest(req.requestId);
            result.requestsExpired++;
          } catch (err) {
            result.errors.push(
              `Failed to expire request ${req.requestId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } catch (err) {
        result.errors.push(
          `Failed to list expired requests: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Phase 2: Clean up old resolved requests
      try {
        const cutoff = new Date(
          new Date(now).getTime() - config.resolvedRetentionMs,
        ).toISOString();
        result.requestsCleaned = await deps.deleteResolvedBefore(cutoff);
      } catch (err) {
        result.errors.push(
          `Failed to clean resolved requests: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return result;
    },

    start() {
      if (running) return;
      running = true;
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

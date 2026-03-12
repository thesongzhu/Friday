/**
 * Satellite Offline Sweep Job — Detects and marks satellites that haven't
 * sent a heartbeat within the configured threshold.
 *
 * @module jobs/satellites/friday-satellite-offline-sweep-job
 */

// ─── Configuration ───

export interface FridaySatelliteOfflineSweepConfig {
  /** How often to run the sweep (ms). */
  readonly intervalMs: number;
  /** Jitter to spread load (ms). */
  readonly jitterMs: number;
  /** Threshold in ms after which a satellite is considered offline. */
  readonly offlineThresholdMs: number;
  /** Threshold in ms after which a satellite is considered degraded. */
  readonly degradedThresholdMs: number;
}

export const DEFAULT_OFFLINE_SWEEP_CONFIG: FridaySatelliteOfflineSweepConfig = {
  intervalMs: 60_000, // 1 minute
  jitterMs: 5_000, // 5 seconds
  offlineThresholdMs: 90_000, // 90 seconds
  degradedThresholdMs: 30_000, // 30 seconds
};

// ─── Result ───

export interface FridaySatelliteOfflineSweepResult {
  readonly satellitesChecked: number;
  readonly markedDegraded: number;
  readonly markedOffline: number;
  readonly errors: string[];
}

// ─── Deps ───

export interface FridaySatelliteOfflineSweepDeps {
  readonly nowIso: () => string;
  readonly config?: FridaySatelliteOfflineSweepConfig;

  /** List satellites with "online" or "degraded" status. */
  readonly listActiveSatellites: () => Promise<ReadonlyArray<{
    id: string;
    pairingStatus: string;
    lastSeenAt: string | null;
  }>>;

  /** Update a satellite's pairing status. */
  readonly updateSatelliteStatus: (
    satelliteId: string,
    status: string,
  ) => Promise<void>;
}

// ─── Interface ───

export interface FridaySatelliteOfflineSweepJob {
  runOnce(): Promise<FridaySatelliteOfflineSweepResult>;
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

// ─── Factory ───

export function createFridaySatelliteOfflineSweepJob(
  deps: FridaySatelliteOfflineSweepDeps,
): FridaySatelliteOfflineSweepJob {
  const config = deps.config ?? DEFAULT_OFFLINE_SWEEP_CONFIG;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  async function runCycle(): Promise<void> {
    if (!running) return;
    try {
      await job.runOnce();
    } catch {
      // continue on failure
    }
    if (running) {
      const jitter = Math.floor(Math.random() * config.jitterMs);
      timer = setTimeout(() => void runCycle(), config.intervalMs + jitter);
    }
  }

  const job: FridaySatelliteOfflineSweepJob = {
    async runOnce() {
      const result: {
        satellitesChecked: number;
        markedDegraded: number;
        markedOffline: number;
        errors: string[];
      } = {
        satellitesChecked: 0,
        markedDegraded: 0,
        markedOffline: 0,
        errors: [],
      };

      const satellites = await deps.listActiveSatellites();
      const nowMs = new Date(deps.nowIso()).getTime();

      for (const sat of satellites) {
        result.satellitesChecked++;

        if (!sat.lastSeenAt) {
          // Never seen — mark offline
          try {
            await deps.updateSatelliteStatus(sat.id, "offline");
            result.markedOffline++;
          } catch (err) {
            result.errors.push(`Failed to mark ${sat.id} offline: ${err instanceof Error ? err.message : String(err)}`);
          }
          continue;
        }

        const lastSeenMs = new Date(sat.lastSeenAt).getTime();
        const elapsedMs = nowMs - lastSeenMs;

        if (elapsedMs > config.offlineThresholdMs) {
          if (sat.pairingStatus !== "offline") {
            try {
              await deps.updateSatelliteStatus(sat.id, "offline");
              result.markedOffline++;
            } catch (err) {
              result.errors.push(`Failed to mark ${sat.id} offline: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } else if (elapsedMs > config.degradedThresholdMs) {
          if (sat.pairingStatus !== "degraded") {
            try {
              await deps.updateSatelliteStatus(sat.id, "degraded");
              result.markedDegraded++;
            } catch (err) {
              result.errors.push(`Failed to mark ${sat.id} degraded: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
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

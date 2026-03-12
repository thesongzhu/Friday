import type { FridaySqliteLayer } from "#state";
import type { FridaySessionService } from "#sessions";
import type { FridaySessionMemoryExtractionService } from "#sessions";
import type { FridaySessionLifecycleJobResult } from "./friday-session-lifecycle-job.types.js";

// ─── Interface ───

export interface FridaySessionLifecycleJob {
  run(): Promise<FridaySessionLifecycleJobResult>;
}

// ─── Deps ───

export interface CreateFridaySessionLifecycleJobDeps {
  db: FridaySqliteLayer;
  sessionService: FridaySessionService;
  extractionService: FridaySessionMemoryExtractionService;
  nowIso: () => string;
}

// ─── Factory ───

export function createFridaySessionLifecycleJob(
  deps: CreateFridaySessionLifecycleJobDeps,
): FridaySessionLifecycleJob {
  return {
    async run() {
      // 1. Capture sessions that are currently active (will become idle candidates)
      const activeSessions = await deps.sessionService.listSessions({ status: "active" });
      const activeKeysBefore = new Set(activeSessions.map((s) => s.key));

      // 2. Run lifecycle sweep (active→idle, idle→archived, etc.)
      const sweep = await deps.sessionService.sweepLifecycle();

      // 3. Find sessions that transitioned to idle this run
      const idledSessionKeys: string[] = [];
      if (sweep.idledCount > 0) {
        const nowIdleSessions = await deps.sessionService.listSessions({ status: "idle" });
        for (const s of nowIdleSessions) {
          if (activeKeysBefore.has(s.key)) {
            idledSessionKeys.push(s.key);
          }
        }
      }

      // 4. Enqueue auto-extraction for newly idle sessions
      let extractionsQueued = 0;
      for (const key of idledSessionKeys) {
        try {
          const result = await deps.extractionService.extractFromSession(key, {
            trigger: "auto",
            mode: "queue",
          });
          if (result.queued) {
            extractionsQueued++;
          }
        } catch {
          // Best-effort; extraction failures don't break lifecycle
        }
      }

      return {
        sweep,
        extractionsQueued,
        idledSessionKeys,
      };
    },
  };
}

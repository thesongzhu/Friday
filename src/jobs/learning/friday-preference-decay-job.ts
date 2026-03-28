/**
 * P2-01: Scheduled job to run preference fact confidence decay.
 * Prevents stale preferences from persisting at high confidence
 * when users are inactive for extended periods.
 */

export interface FridayPreferenceDecayJobResult {
  updatedCount: number;
}

export interface FridayPreferenceDecayJob {
  run(nowOverride?: string): FridayPreferenceDecayJobResult;
}

export interface CreatePreferenceDecayJobDeps {
  factService: { runDecay: (input: { nowIso?: string }) => { updated: number } };
  nowIso: () => string;
}

export function createFridayPreferenceDecayJob(
  deps: CreatePreferenceDecayJobDeps,
): FridayPreferenceDecayJob {
  return {
    run(nowOverride?) {
      const nowIso = nowOverride ?? deps.nowIso();
      const result = deps.factService.runDecay({ nowIso });
      return { updatedCount: result.updated };
    },
  };
}

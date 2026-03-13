import type {
  CreateFridaySkillExecutorDeps,
  FridaySkillExecuteRequest,
  FridaySkillNodeRuntimeContext,
} from "./friday-skill-executor.types.js";

function toJsonRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => cloneJson(item))
    .filter((item): item is Record<string, unknown> => item != null && typeof item === "object" && !Array.isArray(item));
}

function toJsonRecordOrNull(value: unknown): Record<string, unknown> | null {
  const cloned = cloneJson(value);
  if (cloned == null || typeof cloned !== "object" || Array.isArray(cloned)) {
    return null;
  }
  return cloned as Record<string, unknown>;
}

function cloneJson<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createFridaySkillReadonlyRuntimeContext(
  deps: Pick<CreateFridaySkillExecutorDeps, "getSelfHealingService" | "getSystemService">,
  request: Pick<FridaySkillExecuteRequest, "userId">,
): Omit<FridaySkillNodeRuntimeContext, "ai"> | undefined {
  const runtimeContext: Omit<FridaySkillNodeRuntimeContext, "ai"> = {};
  const systemService = deps.getSystemService?.();
  const selfHealingService = deps.getSelfHealingService?.();

  if (systemService) {
    runtimeContext.system = {
      async getSnapshot(): Promise<Record<string, unknown>> {
        return toJsonRecordOrNull(await systemService.getState()) ?? {};
      },
    };
  }

  if (selfHealingService) {
    runtimeContext.diagnosis = {
      async listIssueCards(limit?: number): Promise<Record<string, unknown>[]> {
        return toJsonRecordArray(selfHealingService.listIssueCards({
          userId: request.userId,
          limit,
        }));
      },
      async listIncidents(limit?: number): Promise<Record<string, unknown>[]> {
        return toJsonRecordArray(selfHealingService.listIncidents({
          userId: request.userId,
          limit,
        }));
      },
      async getIncident(incidentId: string): Promise<Record<string, unknown> | null> {
        return toJsonRecordOrNull(selfHealingService.getIncident({ incidentId }));
      },
    };
    runtimeContext.autofix = {
      async listActions(limit?: number, status?: string): Promise<Record<string, unknown>[]> {
        return toJsonRecordArray(selfHealingService.listActions({
          userId: request.userId,
          limit,
          status,
        }));
      },
      async getAction(actionId: string): Promise<Record<string, unknown> | null> {
        return toJsonRecordOrNull(selfHealingService.getAction({ actionId }));
      },
    };
  }

  return Object.keys(runtimeContext).length > 0 ? runtimeContext : undefined;
}

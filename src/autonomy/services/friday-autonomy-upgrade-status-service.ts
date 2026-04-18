import type { FridayAutonomyImpactCensusService } from "./friday-autonomy-impact-census-service.js";
import type { FridayAutonomyUpgradePlannerService } from "./friday-autonomy-upgrade-planner-service.js";
import type { FridayAutonomySubjectKind, FridayAutonomySubjectRecord } from "../model/friday-autonomy-subject.types.js";
import type { FridayUpgradeImpactFinding } from "../model/friday-autonomy-impact.types.js";
import type {
  FridayAutonomyUpgradeStrategy,
  FridayAutonomyVerificationStage,
} from "../model/friday-autonomy-promotion.types.js";
import type { FridayAutonomyCompatibilityStatus } from "../model/friday-autonomy-upgrade.types.js";

export interface FridayAutonomyUpgradeStatusRecord extends FridayAutonomySubjectRecord {
  recordedCompatibilityStatus: FridayAutonomyCompatibilityStatus;
  derivedCompatibilityStatus: FridayAutonomyCompatibilityStatus;
  requiresAdaptation: boolean;
  statusDrift: boolean;
  findings: FridayUpgradeImpactFinding[];
  strategy: FridayAutonomyUpgradeStrategy;
  nextStage: FridayAutonomyVerificationStage;
  reasons: string[];
  blockerAction?: string;
}

export interface FridayAutonomyUpgradeStatusQuery {
  kind?: FridayAutonomySubjectKind;
  id?: string;
}

export interface FridayAutonomyUpgradeStatusService {
  list(query?: FridayAutonomyUpgradeStatusQuery): FridayAutonomyUpgradeStatusRecord[];
  get(kind: FridayAutonomySubjectKind, id: string): FridayAutonomyUpgradeStatusRecord | null;
}

export interface CreateFridayAutonomyUpgradeStatusServiceDeps {
  census: Pick<FridayAutonomyImpactCensusService, "list">;
  planner: Pick<FridayAutonomyUpgradePlannerService, "listDecisions">;
}

export function createFridayAutonomyUpgradeStatusService(
  deps: CreateFridayAutonomyUpgradeStatusServiceDeps,
): FridayAutonomyUpgradeStatusService {
  function readAll(): FridayAutonomyUpgradeStatusRecord[] {
    const decisions = new Map<string, ReturnType<CreateFridayAutonomyUpgradeStatusServiceDeps["planner"]["listDecisions"]>[number]>(
      deps.planner.listDecisions().map((decision) => [`${decision.subjectKind}:${decision.subjectId}`, decision] as const),
    );

    return deps.census.list().map((snapshot) => {
      const key = `${snapshot.subject.kind}:${snapshot.subject.id}`;
      const decision = decisions.get(key);

      return {
        ...snapshot.subject,
        recordedCompatibilityStatus: snapshot.recordedCompatibilityStatus,
        derivedCompatibilityStatus: snapshot.derivedCompatibilityStatus,
        requiresAdaptation: snapshot.requiresAdaptation,
        statusDrift: snapshot.statusDrift,
        findings: snapshot.findings,
        strategy: decision?.strategy ?? "noop",
        nextStage: decision?.nextStage ?? "detect",
        reasons: decision?.reasons ?? [],
        blockerAction: decision?.blockerAction,
      };
    });
  }

  function matchesQuery(
    item: FridayAutonomyUpgradeStatusRecord,
    query: FridayAutonomyUpgradeStatusQuery | undefined,
  ): boolean {
    if (!query) {
      return true;
    }
    if (query.kind && item.kind !== query.kind) {
      return false;
    }
    if (query.id && item.id !== query.id) {
      return false;
    }
    return true;
  }

  return {
    list(query) {
      return readAll().filter((item) => matchesQuery(item, query));
    },

    get(kind, id) {
      return this.list({ kind, id })[0] ?? null;
    },
  };
}

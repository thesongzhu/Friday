import type { FridayAutonomyImpactCensusService } from "./friday-autonomy-impact-census-service.js";
import type { FridayPromotionDecision } from "../model/friday-autonomy-promotion.types.js";
import type { FridayUpgradeImpactSnapshot } from "../model/friday-autonomy-impact.types.js";

export interface FridayAutonomyUpgradePlannerService {
  listDecisions(): FridayPromotionDecision[];
}

export interface CreateFridayAutonomyUpgradePlannerServiceDeps {
  census: Pick<FridayAutonomyImpactCensusService, "list">;
}

export function createFridayAutonomyUpgradePlannerService(
  deps: CreateFridayAutonomyUpgradePlannerServiceDeps,
): FridayAutonomyUpgradePlannerService {
  return {
    listDecisions() {
      return deps.census.list().map(buildDecisionForSnapshot);
    },
  };
}

function buildDecisionForSnapshot(snapshot: FridayUpgradeImpactSnapshot): FridayPromotionDecision {
  const failingFindings = snapshot.findings.filter((finding) => !finding.passed);
  const reasons = failingFindings.map((finding) => finding.message);

  if (snapshot.derivedCompatibilityStatus === "compatible") {
    return {
      subjectKind: snapshot.subject.kind,
      subjectId: snapshot.subject.id,
      recordedCompatibilityStatus: snapshot.recordedCompatibilityStatus,
      derivedCompatibilityStatus: snapshot.derivedCompatibilityStatus,
      strategy: "noop",
      nextStage: "shadow",
      reasons: reasons.length > 0 ? reasons : ["Impact census found no blocking drift."],
    };
  }

  if (snapshot.derivedCompatibilityStatus === "blocked") {
    const credentialsBlocked = failingFindings.some((finding) =>
      finding.id === "channel_credentials" || finding.id === "provider_credentials"
    );
    const runtimeCompatibilityBlocked = failingFindings.some((finding) =>
      finding.id === "api_version_supported" || finding.id === "min_hub_version"
    );

    return {
      subjectKind: snapshot.subject.kind,
      subjectId: snapshot.subject.id,
      recordedCompatibilityStatus: snapshot.recordedCompatibilityStatus,
      derivedCompatibilityStatus: snapshot.derivedCompatibilityStatus,
      strategy: runtimeCompatibilityBlocked
        ? snapshot.subject.kind === "skill" || snapshot.subject.kind === "workflow"
          ? "regenerate"
          : "deprecate"
        : "patch",
      nextStage: "adapt",
      reasons,
      blockerAction: credentialsBlocked
        ? "Configure real credentials before replay or canary."
        : runtimeCompatibilityBlocked
          ? "Adapt the subject for the current hub/runtime contract before replay."
          : "Patch the blocking runtime/config drift before replay.",
    };
  }

  return {
    subjectKind: snapshot.subject.kind,
    subjectId: snapshot.subject.id,
    recordedCompatibilityStatus: snapshot.recordedCompatibilityStatus,
    derivedCompatibilityStatus: snapshot.derivedCompatibilityStatus,
    strategy: snapshot.subject.kind === "skill" || snapshot.subject.kind === "workflow"
      ? "regenerate"
      : "patch",
    nextStage: "adapt",
    reasons,
  };
}

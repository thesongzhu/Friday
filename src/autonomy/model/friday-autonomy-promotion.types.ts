import type { FridayAutonomySubjectKind } from "./friday-autonomy-subject.types.js";
import type { FridayAutonomyCompatibilityStatus } from "./friday-autonomy-upgrade.types.js";

export type FridayAutonomyUpgradeStrategy = "noop" | "patch" | "regenerate" | "deprecate";

export type FridayAutonomyVerificationStage =
  | "detect"
  | "adapt"
  | "replay"
  | "shadow"
  | "canary"
  | "promoted"
  | "rollback";

export interface FridayPromotionDecision {
  subjectKind: FridayAutonomySubjectKind;
  subjectId: string;
  recordedCompatibilityStatus: FridayAutonomyCompatibilityStatus;
  derivedCompatibilityStatus: FridayAutonomyCompatibilityStatus;
  strategy: FridayAutonomyUpgradeStrategy;
  nextStage: FridayAutonomyVerificationStage;
  reasons: string[];
  blockerAction?: string;
}

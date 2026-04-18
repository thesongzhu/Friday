import type { FridayAutonomySubjectRecord } from "./friday-autonomy-subject.types.js";
import type { FridayAutonomyCompatibilityStatus } from "./friday-autonomy-upgrade.types.js";

export type FridayUpgradeImpactSeverity = "info" | "warning" | "blocking";

export interface FridayUpgradeImpactFinding {
  id: string;
  severity: FridayUpgradeImpactSeverity;
  passed: boolean;
  message: string;
  actualValue?: string | number | boolean | null;
  expectedValue?: string | number | boolean | null;
  details?: Record<string, unknown>;
}

export interface FridayUpgradeImpactSnapshot {
  subject: FridayAutonomySubjectRecord;
  recordedCompatibilityStatus: FridayAutonomyCompatibilityStatus;
  derivedCompatibilityStatus: FridayAutonomyCompatibilityStatus;
  requiresAdaptation: boolean;
  statusDrift: boolean;
  findings: FridayUpgradeImpactFinding[];
}

export interface FridayAutonomyImpactCensusContext {
  hubVersion: string;
  supportedApiVersions: string[];
}

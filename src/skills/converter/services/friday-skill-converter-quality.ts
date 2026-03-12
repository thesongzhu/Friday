import type { FridaySkillValidationIssue } from "../../validation/friday-skill-validation.types.js";
import type { FridaySkillConversionQualitySummary } from "./friday-skill-converter-service.types.js";

export function summarizeFridaySkillConversionQuality(
  validation: Array<{ skillId: string; ok: boolean; issues: FridaySkillValidationIssue[] }>,
): FridaySkillConversionQualitySummary {
  const noDrafts = validation.length === 0;
  const totalDrafts = noDrafts ? 1 : validation.length;
  const passedDrafts = noDrafts ? 1 : validation.filter((item) => item.ok).length;

  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;

  for (const item of validation) {
    for (const issue of item.issues) {
      if (issue.severity === "error") {
        errorCount += 1;
      } else if (issue.severity === "warning") {
        warningCount += 1;
      } else {
        infoCount += 1;
      }
    }
  }

  const rawScore = 100 - (errorCount * 25) - (warningCount * 5) - infoCount;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));
  const status: FridaySkillConversionQualitySummary["status"] =
    score >= 85 ? "high" : score >= 60 ? "medium" : "low";

  return {
    score,
    status,
    draftPassRate: Number((passedDrafts / totalDrafts).toFixed(2)),
    issueCounts: {
      error: errorCount,
      warning: warningCount,
      info: infoCount,
    },
  };
}

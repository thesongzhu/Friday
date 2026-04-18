import { describe, expect, it } from "vitest";

import { createFridayAutonomyUpgradeStatusService } from "../../../src/autonomy/services/friday-autonomy-upgrade-status-service.js";

describe("createFridayAutonomyUpgradeStatusService", () => {
  it("flattens census snapshots with planner decisions and supports filtering", () => {
    const service = createFridayAutonomyUpgradeStatusService({
      census: {
        list: () => [
          {
            subject: {
              kind: "workflow",
              id: "wf-1",
              displayName: "Workflow 1",
              status: "published",
              activeVersion: "2",
              compatibilityStatus: "compatible",
              promotionChannel: "canary",
              shadowVersionId: "wf-1-v2",
              canaryStats: {
                sampleSize: 3,
                successCount: 2,
                failureCount: 1,
                rollbackCount: 0,
              },
            },
            recordedCompatibilityStatus: "compatible" as const,
            derivedCompatibilityStatus: "adaptation_required" as const,
            requiresAdaptation: true,
            statusDrift: true,
            findings: [
              {
                id: "workflow_version_gap",
                severity: "warning" as const,
                passed: false,
                message: "Workflow latest version is ahead of published version.",
              },
            ],
          },
        ],
      },
      planner: {
        listDecisions: () => [
          {
            subjectKind: "workflow",
            subjectId: "wf-1",
            recordedCompatibilityStatus: "compatible" as const,
            derivedCompatibilityStatus: "adaptation_required" as const,
            strategy: "regenerate" as const,
            nextStage: "adapt" as const,
            reasons: ["Workflow latest version is ahead of published version."],
          },
        ],
      },
    });

    const all = service.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      kind: "workflow",
      id: "wf-1",
      promotionChannel: "canary",
      derivedCompatibilityStatus: "adaptation_required",
      strategy: "regenerate",
      nextStage: "adapt",
    });

    expect(service.get("workflow", "wf-1")?.shadowVersionId).toBe("wf-1-v2");
    expect(service.list({ kind: "skill" })).toEqual([]);
    expect(service.list({ kind: "workflow", id: "wf-1" })).toHaveLength(1);
  });
});

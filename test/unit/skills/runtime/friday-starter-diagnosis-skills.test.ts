import { describe, expect, it } from "vitest";

describe("bundled diagnosis and recovery starter skills", () => {
  it("runs system-health-snapshot against readonly runtime context", async () => {
    const { execute } = await import("../../../../skills/system-health-snapshot/index.mjs");

    const result = await execute({}, {
      system: {
        getSnapshot: async () => ({
          capturedAt: "2026-03-13T00:00:00.000Z",
          workspaceRoot: "/tmp/workspace",
          platform: "darwin",
          health: { status: "degraded", reasons: ["companion stale"] },
          companion: { status: "degraded" },
          browser: { activeMode: "headless", targetBrowser: "Google Chrome" },
          approvalsSummary: { total: 1, highRiskAllowed: 0 },
          remoteDevicesSummary: { total: 1, active: 1 },
          remoteSessionsSummary: { total: 1, active: 1 },
        }),
      },
    });

    expect(result.summary).toContain("health is degraded");
    expect(result.nextStep).toContain("autofix-readiness-review");
    expect(result.details.healthStatus).toBe("degraded");
  });

  it("runs review-open-issues against diagnosis context", async () => {
    const { execute } = await import("../../../../skills/review-open-issues/index.mjs");

    const result = await execute({}, {
      diagnosis: {
        listIssueCards: async () => [{
          id: "issue-1",
          kind: "approval_required",
          incidentId: "incident-1",
          title: "Approval required",
          summary: "A rollback-backed fix is waiting.",
          severity: "high",
          createdAt: "2026-03-13T00:00:00.000Z",
        }],
        listIncidents: async () => [{
          incident: {
            incidentId: "incident-1",
            category: "workflow",
            severity: "high",
            status: "open",
          },
          summary: {
            rootCauseSummary: "Workflow publish step failed.",
            autoFixEligible: true,
          },
        }],
        getIncident: async () => null,
      },
    });

    expect(result.summary).toContain("open issue card");
    expect(result.nextStep).toContain("autofix-readiness-review");
    expect(result.details.issueCounts.approval_required).toBe(1);
  });

  it("runs autofix-readiness-review against readonly autofix context", async () => {
    const { execute } = await import("../../../../skills/autofix-readiness-review/index.mjs");

    const result = await execute({}, {
      autofix: {
        listActions: async () => [{
          action: {
            actionId: "action-1",
            incidentId: "incident-1",
            riskTier: 2,
            status: "planned",
          },
          risk: {
            requiresApproval: true,
            autoApplyAllowed: false,
          },
          evidence: {
            selectedPlan: {
              title: "Disable broken workflow",
              summary: "Disable the workflow before retrying deploy.",
            },
          },
          approval: {
            status: "pending",
          },
        }],
        getAction: async () => null,
      },
    });

    expect(result.summary).toContain("planned auto-fix action");
    expect(result.nextStep).toContain("approval");
    expect(result.details.approvalRequiredCount).toBe(1);
  });

  it("runs failed-deploy-recovery-brief against diagnosis and autofix context", async () => {
    const { execute } = await import("../../../../skills/failed-deploy-recovery-brief/index.mjs");

    const result = await execute({}, {
      diagnosis: {
        listIssueCards: async () => [{
          id: "issue-1",
          kind: "approval_required",
          incidentId: "incident-1",
          actionId: "action-1",
          title: "Workflow deploy approval",
          summary: "A deploy recovery fix is queued.",
          severity: "high",
          createdAt: "2026-03-13T00:00:00.000Z",
        }],
        listIncidents: async () => [{
          incident: {
            incidentId: "incident-1",
            category: "workflow",
            severity: "high",
            status: "open",
            signature: "deploy failed",
          },
          summary: {
            rootCauseSummary: "The deploy workflow failed during publish.",
            autoFixEligible: true,
          },
        }],
        getIncident: async () => null,
      },
      autofix: {
        getAction: async () => ({
          action: {
            actionId: "action-1",
            incidentId: "incident-1",
            riskTier: 2,
            status: "planned",
          },
          risk: {
            requiresApproval: true,
            autoApplyAllowed: false,
          },
          evidence: {
            selectedPlan: {
              title: "Rollback deploy gate",
              summary: "Rollback the deploy gate before retry.",
            },
          },
          approval: {
            status: "pending",
          },
        }),
        listActions: async () => [],
      },
    });

    expect(result.summary).toContain("Failed deploy recovery");
    expect(result.nextStep).toContain("approval");
    expect(result.details.recommendedTemplateId).toBe("recover-failed-deploy");
  });
});

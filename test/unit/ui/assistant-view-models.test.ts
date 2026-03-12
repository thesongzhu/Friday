import { describe, expect, it } from "vitest";
import {
  buildAssistantIssuePlaybook,
  buildAssistantRecoveryPaths,
  buildAssistantQuickActions,
  describeIntentConfidence,
  summarizeActionStatus,
  summarizeSkillEvidence,
  toneForIssue,
} from "../../../ui/src/lib/assistant/view-models";
import { buildFleetHref } from "../../../ui/src/lib/fleet/view-models";
import { buildObservabilityHref } from "../../../ui/src/lib/observability/view-models";
import type {
  FridayFixPlanRecord,
  FridayIssueCard,
  FridayWorkflowOverview,
} from "@friday-operator-client";
import type {
  FridayFleetSatelliteCard,
  FridayPendingSatellitePairingRequest,
  SkillCatalogItem,
  SkillGenerationEvidence,
} from "../../../ui/src/lib/api/types";

describe("assistant view models", () => {
  it("keeps beginner intent confidence labels simple", () => {
    expect(describeIntentConfidence(null)).toBe("Waiting for a goal.");
    expect(
      describeIntentConfidence({
        intent: "generate_skill",
        confidence: 0.92,
        summary: "Generate a skill",
        routeTarget: "/assistant",
        suggestedTemplateIds: ["generate-skill"],
      }),
    ).toBe("High confidence");
    expect(
      describeIntentConfidence({
        intent: "general_help",
        confidence: 0.5,
        summary: "Needs clarification",
        routeTarget: "/assistant",
        suggestedTemplateIds: [],
      }),
    ).toBe("Needs clarification");
  });

  it("maps issue cards to clear severity tones", () => {
    const failedFix: FridayIssueCard = {
      id: "issue-1",
      kind: "failed_fix",
      incidentId: "incident-1",
      title: "Fix failed",
      summary: "Rollback needed",
      severity: "high",
      status: "open",
      createdAt: "2026-03-07T10:00:00.000Z",
      routeTarget: "/assistant",
    };

    expect(toneForIssue(failedFix)).toBe("danger");
    expect(
      toneForIssue({
        ...failedFix,
        id: "issue-2",
        kind: "approval_required",
      }),
    ).toBe("warning");
  });

  it("summarizes auto-fix lifecycle without builder jargon", () => {
    const action: FridayFixPlanRecord = {
      action: {
        actionId: "action-1",
        incidentId: "incident-1",
        userId: "user-1",
        riskTier: 2,
        plan: {
          title: "Update provider config",
          summary: "Switch to the fallback provider",
          steps: [],
          evidence: {
            fingerprint: "fp-1",
            matchedLessonIds: [],
            diagnosisId: "diagnosis-1",
            recurrenceCount: 1,
          },
        },
        status: "planned",
        outcome: null,
        createdAt: "2026-03-07T10:00:00.000Z",
        updatedAt: "2026-03-07T10:00:00.000Z",
      },
      summary: {
        actionId: "action-1",
        incidentId: "incident-1",
        title: "Update provider config",
        summary: "Switch to the fallback provider",
        riskTier: 2,
        status: "planned",
        outcome: null,
        requiresApproval: true,
        autoApplyAllowed: false,
        rollbackPlanAvailable: true,
        createdAt: "2026-03-07T10:00:00.000Z",
        updatedAt: "2026-03-07T10:00:00.000Z",
      },
      approval: {
        requestId: "approval-1",
        actionId: "action-1",
        userId: "user-1",
        description: "Approve fix",
        riskTier: 2,
        plan: {
          title: "Update provider config",
          summary: "Switch to the fallback provider",
          steps: [],
          evidence: {
            fingerprint: "fp-1",
            matchedLessonIds: [],
            diagnosisId: "diagnosis-1",
            recurrenceCount: 1,
          },
        },
        requestedAt: "2026-03-07T10:00:00.000Z",
        expiresAt: "2026-03-07T11:00:00.000Z",
        status: "pending",
        createdAt: "2026-03-07T10:00:00.000Z",
        updatedAt: "2026-03-07T10:00:00.000Z",
      },
      evidence: {
        rootCauseSummary: "Fallback provider disabled",
        selectedPlan: {
          title: "Update provider config",
          summary: "Switch to the fallback provider",
          stepCount: 1,
          rollbackPlanAvailable: true,
        },
        riskTier: 2,
        executionResult: {
          status: "planned",
          outcome: null,
        },
        rollbackResult: {
          available: true,
          rollbackAttempted: false,
          rollbackSucceeded: false,
        },
        acceptanceResult: {
          passed: false,
          reason: "Pending approval",
        },
      },
    };

    expect(summarizeActionStatus(action)).toBe("Awaiting approval");
  });

  it("summarizes skill evidence into approval-ready language", () => {
    const evidence: SkillGenerationEvidence = {
      sessionId: "session-1",
      validationSummary: {
        ok: true,
        repaired: false,
        repairAttempts: 0,
        issueCount: 0,
      },
      repairSummary: {
        attempted: false,
        attempts: 0,
      },
      executableTestSummary: {
        ok: true,
        executable: true,
        issues: [],
        durationMs: 45,
      },
      approvalReadiness: {
        ready: true,
        reason: "Draft passed validation and explicit self-test",
      },
    };

    expect(summarizeSkillEvidence(evidence)).toBe("Ready to approve and save.");
  });

  it("prioritizes quick assistant actions for issue, workflow, fleet, and alert recovery", () => {
    const issues: FridayIssueCard[] = [
      {
        id: "issue-approval",
        kind: "approval_required",
        incidentId: "incident-1",
        title: "Approve fallback provider fix",
        summary: "Friday can switch to the fallback provider after approval.",
        severity: "high",
        status: "open",
        createdAt: "2026-03-08T10:00:00.000Z",
        routeTarget: "/assistant",
      },
    ];
    const workflowOverviews: FridayWorkflowOverview[] = [
      {
        workflow: { id: "wf-1", slug: "release", name: "Release", state: "active" },
        latestDraft: { draftId: "draft-1", revision: 3, createdAt: "2026-03-08T10:00:00.000Z", updatedAt: "2026-03-08T10:00:00.000Z" },
        publishedVersion: null,
        recentRuns: [],
        latestRun: { runId: "run-1", workflowVersionId: "ver-1", status: "failed", startedAt: "2026-03-08T09:00:00.000Z" },
        latestRunNodeTimeline: [],
        latestEvidenceExports: [],
        versionHistory: [],
      },
    ];
    const catalogItems: SkillCatalogItem[] = [
      {
        sourceId: "catalog",
        skillId: "skill-1",
        skillName: "Release Notes",
        summary: "Draft release notes automatically.",
        installed: false,
        latestVersion: "1.0.0",
        signatureValid: true,
        trustScore: 91,
      },
    ];
    const degradedSatellites: FridayFleetSatelliteCard[] = [
      {
        satelliteId: "sat-1",
        type: "macos",
        displayName: "Build Node",
        pairingStatus: "offline",
        trustLevel: "trusted",
        trustScore: 82,
        trustBand: "medium",
        healthScore: 41,
        healthState: "degraded",
        lastSeenAt: "2026-03-08T09:30:00.000Z",
        tags: [],
        alerts: [],
      },
    ];
    const pairingRequests: FridayPendingSatellitePairingRequest[] = [
      {
        requestId: "request-1",
        satelliteId: "sat-2",
        displayName: "Studio Mac",
        type: "macos",
        pairingCode: "PAIR-123",
        createdAt: "2026-03-08T10:00:00.000Z",
        expiresAt: "2026-03-08T10:10:00.000Z",
      },
    ];

    const actions = buildAssistantQuickActions({
      issues,
      workflowOverviews,
      catalogItems,
      degradedSatellites,
      pairingRequests,
      alerts: [
        {
          id: "alert-1",
          ruleId: "rule-1",
          ruleName: "API availability",
          severity: "critical",
          status: "firing",
          summary: "API availability dropped below threshold",
          module: "api",
          detectedAt: "2026-03-08T09:50:00.000Z",
          notifiedChannelCount: 1,
          currentEscalationTier: 1,
        },
      ],
    });

    expect(actions.map((action) => action.kind)).toEqual([
      "issue",
      "workflow",
      "skill",
      "fleet",
      "alert",
    ]);
    expect(actions.find((action) => action.kind === "fleet")?.title).toContain("Approve or reject");
  });

  it("builds recovery paths in the order of user-facing urgency", () => {
    const paths = buildAssistantRecoveryPaths({
      issues: [
        {
          id: "issue-approval",
          kind: "approval_required",
          incidentId: "incident-1",
          title: "Approve fallback provider fix",
          summary: "Friday is waiting on a repair approval.",
          severity: "high",
          status: "open",
          createdAt: "2026-03-08T10:00:00.000Z",
          routeTarget: "/assistant",
        },
      ],
      workflowOverviews: [
        {
          workflow: { id: "wf-1", slug: "release", name: "Release", state: "active" },
          latestDraft: { draftId: "draft-1", revision: 3, createdAt: "2026-03-08T10:00:00.000Z", updatedAt: "2026-03-08T10:00:00.000Z" },
          publishedVersion: null,
          recentRuns: [],
          latestRun: { runId: "run-1", workflowVersionId: "ver-1", status: "failed", startedAt: "2026-03-08T09:00:00.000Z" },
          latestRunNodeTimeline: [],
          latestEvidenceExports: [],
          versionHistory: [],
        },
      ],
      degradedSatellites: [
        {
          satelliteId: "sat-1",
          type: "macos",
          displayName: "Build Node",
          pairingStatus: "offline",
          trustLevel: "trusted",
          trustScore: 82,
          trustBand: "medium",
          healthScore: 41,
          healthState: "degraded",
          lastSeenAt: "2026-03-08T09:30:00.000Z",
          tags: [],
          alerts: [],
        },
      ],
      alerts: [
        {
          id: "alert-1",
          ruleId: "rule-1",
          ruleName: "API availability",
          severity: "critical",
          status: "firing",
          summary: "API availability dropped below threshold",
          module: "api",
          detectedAt: "2026-03-08T09:50:00.000Z",
          notifiedChannelCount: 1,
          currentEscalationTier: 1,
        },
      ],
    });

    expect(paths.map((path) => path.kind)).toEqual([
      "approval",
      "fleet",
      "alert",
      "workflow",
    ]);
    expect(paths[0]?.routeTarget).toBe("/assistant");
    expect(paths[1]?.routeTarget).toBe(buildFleetHref("sat-1", "recovery"));
    expect(paths[2]?.routeTarget).toBe(
      buildObservabilityHref({ focus: "alerts", alertId: "alert-1" }),
    );
    expect(paths[3]?.routeTarget).toBe("/workflows?workflowId=wf-1&focus=recovery");
  });

  it("turns issue cards into direct next-step playbooks", () => {
    const approvalIssue: FridayIssueCard = {
      id: "issue-approval",
      kind: "approval_required",
      incidentId: "incident-1",
      actionId: "action-1",
      title: "Approve fallback provider fix",
      summary: "Friday is waiting on a repair approval.",
      severity: "high",
      status: "open",
      createdAt: "2026-03-08T10:00:00.000Z",
      routeTarget: "/assistant",
    };

    const playbook = buildAssistantIssuePlaybook({
      issue: approvalIssue,
      action: {
        action: {
          actionId: "action-1",
          incidentId: "incident-1",
          userId: "user-1",
          riskTier: 2,
          plan: {
            title: "Approve fallback provider fix",
            summary: "Switch to the fallback provider",
            steps: [],
            evidence: {
              fingerprint: "fp-1",
              matchedLessonIds: [],
              diagnosisId: "diagnosis-1",
              recurrenceCount: 1,
            },
          },
          status: "planned",
          outcome: null,
          createdAt: "2026-03-07T10:00:00.000Z",
          updatedAt: "2026-03-07T10:00:00.000Z",
        },
        summary: {
          actionId: "action-1",
          incidentId: "incident-1",
          title: "Approve fallback provider fix",
          summary: "Switch to the fallback provider",
          riskTier: 2,
          status: "planned",
          outcome: null,
          requiresApproval: true,
          autoApplyAllowed: false,
          rollbackPlanAvailable: true,
          createdAt: "2026-03-07T10:00:00.000Z",
          updatedAt: "2026-03-07T10:00:00.000Z",
        },
        approval: null,
        evidence: {
          rootCauseSummary: "Fallback provider disabled",
          selectedPlan: {
            title: "Update provider config",
            summary: "Switch to the fallback provider",
            stepCount: 1,
            rollbackPlanAvailable: true,
          },
          riskTier: 2,
          executionResult: {
            status: "planned",
            outcome: null,
          },
          rollbackResult: {
            available: true,
            rollbackAttempted: false,
            rollbackSucceeded: false,
          },
          acceptanceResult: {
            passed: false,
            reason: "Pending approval",
          },
        },
      },
    });

    expect(playbook.primaryLabel).toBe("Approve fix");
    expect(playbook.primaryRouteTarget).toBe("/assistant");
    expect(playbook.secondaryRouteTarget).toBe(
      buildObservabilityHref({ focus: "alerts", issueId: "issue-approval" }),
    );
  });
});

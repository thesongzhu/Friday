import { describe, it, expect } from "vitest";
import {
  toFridayDiagnosisSummary,
  toFridayFixPlanRecord,
  toFridayDiagnosisIncidentRecord,
} from "../../../../../src/api/http/routes/friday-self-healing-route-mappers.js";
import type { FridayIncidentDiagnosisDetails, FridaySelfHealingActionDetails } from "#learning";

const NOW = "2025-06-15T10:00:00.000Z";

function makeIncidentDetails(
  overrides?: Partial<FridayIncidentDiagnosisDetails>,
): FridayIncidentDiagnosisDetails {
  return {
    incident: {
      incidentId: "inc-001",
      userId: "test-user",
      ts: NOW,
      category: "tool",
      severity: "medium",
      signature: "sig-abc",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    },
    diagnosis: {
      id: "diag-001",
      incidentId: "inc-001",
      errorFingerprint: "sig-abc",
      confidence: 0.9,
      diagnosis: { summary: "Tool timed out", suggestedFixes: ["Increase timeout"] },
      createdAt: NOW,
      updatedAt: NOW,
    },
    lesson: null,
    action: null,
    recurrenceCount: 2,
    autoFixEligible: true,
    ...overrides,
  };
}

function makeActionDetails(): FridaySelfHealingActionDetails {
  return {
    action: {
      actionId: "action-001",
      incidentId: "inc-001",
      diagnosisId: "diag-001",
      userId: "test-user",
      plan: {
        title: "Retry with timeout",
        summary: "Increase timeout to 30s",
        steps: [{ stepId: "s1", kind: "retry_node", target: "tool", payload: {}, verify: { method: "error_absent", timeoutMs: 5000 } }],
        evidence: { fingerprint: "sig-abc", matchedLessonIds: [], diagnosisId: "diag-001", recurrenceCount: 1 },
      },
      riskTier: "low",
      outcome: "success",
      rollbackOutcome: undefined,
      status: "applied",
      executedAt: NOW,
      completedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    },
    approval: null,
    risk: {
      requiresApproval: false,
      autoApplyAllowed: true,
      riskTier: "low",
      reasons: [],
    },
    evidence: {
      rootCauseSummary: "Tool timed out",
      selectedPlan: {
        title: "Retry with timeout",
        summary: "Increase timeout to 30s",
        stepCount: 1,
        rollbackPlanAvailable: false,
      },
      executionResult: {
        stepsSucceeded: 1,
        stepsFailed: 0,
        rollbackSucceeded: false,
      },
      acceptanceResult: {
        passed: true,
        reason: "Error absent after fix",
      },
    },
  };
}

describe("friday-self-healing-route-mappers", () => {
  describe("toFridayDiagnosisSummary", () => {
    it("maps incident details to diagnosis summary", () => {
      const details = makeIncidentDetails();
      const summary = toFridayDiagnosisSummary(details);

      expect(summary.incidentId).toBe("inc-001");
      expect(summary.diagnosisId).toBe("diag-001");
      expect(summary.confidence).toBe(0.9);
      expect(summary.rootCauseSummary).toBe("Tool timed out");
      expect(summary.suggestedFixes).toEqual(["Increase timeout"]);
      expect(summary.recurrenceCount).toBe(2);
      expect(summary.autoFixEligible).toBe(true);
    });

    it("includes loopRunId when provided", () => {
      const details = makeIncidentDetails();
      const summary = toFridayDiagnosisSummary(details, "loop-001");
      expect(summary.loopRunId).toBe("loop-001");
    });

    it("falls back to signature when no diagnosis summary", () => {
      const details = makeIncidentDetails({
        diagnosis: {
          id: "diag-002",
          incidentId: "inc-001",
          errorFingerprint: "sig-abc",
          confidence: 0.5,
          diagnosis: {},
          createdAt: NOW,
          updatedAt: NOW,
        },
      });
      const summary = toFridayDiagnosisSummary(details);
      expect(summary.rootCauseSummary).toBe("sig-abc");
    });

    it("returns empty arrays when no suggested fixes or matched lessons", () => {
      const details = makeIncidentDetails({
        diagnosis: {
          id: "diag-003",
          incidentId: "inc-001",
          errorFingerprint: "sig-abc",
          confidence: 0.5,
          diagnosis: { summary: "Unknown error" },
          createdAt: NOW,
          updatedAt: NOW,
        },
      });
      const summary = toFridayDiagnosisSummary(details);
      expect(summary.suggestedFixes).toEqual([]);
      expect(summary.matchedLessonIds).toEqual([]);
    });

    it("extracts matchedLessonIds from lesson when diagnosis has none", () => {
      const details = makeIncidentDetails({
        lesson: {
          id: "lesson-001",
          fingerprint: "sig-abc",
          title: "Lesson learned",
          cause: "timeout",
          fix: "increase timeout",
          mitigation: {},
          sourceIncidentId: "inc-001",
          createdAt: NOW,
          updatedAt: NOW,
        },
      });
      const summary = toFridayDiagnosisSummary(details);
      expect(summary.matchedLessonIds).toEqual(["lesson-001"]);
    });
  });

  describe("toFridayFixPlanRecord", () => {
    it("maps action details to fix plan record", () => {
      const actionDetails = makeActionDetails();
      const record = toFridayFixPlanRecord(actionDetails);

      expect(record.summary.actionId).toBe("action-001");
      expect(record.summary.title).toBe("Retry with timeout");
      expect(record.summary.riskTier).toBe("low");
      expect(record.summary.outcome).toBe("success");
      expect(record.summary.requiresApproval).toBe(false);
      expect(record.summary.autoApplyAllowed).toBe(true);
      expect(record.summary.rollbackPlanAvailable).toBe(false);
      expect(record.evidence.rootCauseSummary).toBe("Tool timed out");
    });

    it("includes loopRunId in summary", () => {
      const record = toFridayFixPlanRecord(makeActionDetails(), "loop-002");
      expect(record.summary.loopRunId).toBe("loop-002");
    });
  });

  describe("toFridayDiagnosisIncidentRecord", () => {
    it("maps full incident record with no action", () => {
      const details = makeIncidentDetails();
      const record = toFridayDiagnosisIncidentRecord(details);

      expect(record.incident.incidentId).toBe("inc-001");
      expect(record.diagnosis).not.toBeNull();
      expect(record.summary.incidentId).toBe("inc-001");
      expect(record.action).toBeNull();
    });

    it("maps full incident record with action", () => {
      const actionDetails = makeActionDetails();
      const details = makeIncidentDetails({ action: actionDetails });
      const record = toFridayDiagnosisIncidentRecord(details);

      expect(record.action).not.toBeNull();
      expect(record.action!.summary.actionId).toBe("action-001");
    });

    it("passes loopRunIds through to sub-records", () => {
      const actionDetails = makeActionDetails();
      const details = makeIncidentDetails({ action: actionDetails });
      const record = toFridayDiagnosisIncidentRecord(details, {
        incidentLoopRunId: "loop-inc",
        actionLoopRunId: "loop-act",
      });

      expect(record.summary.loopRunId).toBe("loop-inc");
      expect(record.action!.summary.loopRunId).toBe("loop-act");
    });
  });
});

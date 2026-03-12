import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayAutoFixRiskAssessmentService } from "#learning";
import { createFridayAutoFixActionRepository } from "#learning";
import { createFridayErrorIncidentRepository } from "#learning";
import type { FridayAutoFixRiskAssessmentService } from "#learning";
import type { FridayAutoFixActionRepository } from "#learning";
import type { FridayErrorIncidentEntity } from "#learning";
import type { FridayAutoFixPlan } from "#learning";

describe("FridayAutoFixRiskAssessmentService", () => {
  let db: FridaySqliteLayer;
  let service: FridayAutoFixRiskAssessmentService;
  let actionRepo: FridayAutoFixActionRepository;
  const NOW = "2025-06-15T10:00:00.000Z";

  const baseIncident: FridayErrorIncidentEntity = {
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
  };

  function makePlan(stepKind: string): FridayAutoFixPlan {
    return {
      title: `Plan with ${stepKind}`,
      summary: "Test plan",
      steps: [
        {
          stepId: "step-001",
          kind: stepKind as FridayAutoFixPlan["steps"][number]["kind"],
          target: "target",
          payload: {},
        },
      ],
      evidence: {
        fingerprint: "sig-abc",
        matchedLessonIds: [],
        diagnosisId: "diag-001",
        recurrenceCount: 1,
      },
    };
  }

  beforeEach(() => {
    db = createTestDb();
    actionRepo = createFridayAutoFixActionRepository();
    service = createFridayAutoFixRiskAssessmentService({ db, actionRepo });
  });

  afterEach(() => {
    db.close();
  });

  it("assigns Tier 0 for retry_node steps", () => {
    const result = service.assess({
      incident: baseIncident,
      plan: makePlan("retry_node"),
      nowIso: NOW,
    });
    expect(result.riskTier).toBe(0);
    expect(result.autoApplyAllowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it("assigns Tier 0 for switch_model_fallback", () => {
    const result = service.assess({
      incident: baseIncident,
      plan: makePlan("switch_model_fallback"),
      nowIso: NOW,
    });
    expect(result.riskTier).toBe(0);
  });

  it("assigns Tier 0 for trim_payload", () => {
    const result = service.assess({
      incident: baseIncident,
      plan: makePlan("trim_payload"),
      nowIso: NOW,
    });
    expect(result.riskTier).toBe(0);
  });

  it("assigns Tier 1 for apply_config_patch", () => {
    const result = service.assess({
      incident: baseIncident,
      plan: makePlan("apply_config_patch"),
      nowIso: NOW,
    });
    expect(result.riskTier).toBe(1);
    expect(result.autoApplyAllowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it("assigns Tier 1 for grant_permission", () => {
    const result = service.assess({
      incident: baseIncident,
      plan: makePlan("grant_permission"),
      nowIso: NOW,
    });
    expect(result.riskTier).toBe(1);
  });

  it("assigns Tier 2 for disable_skill", () => {
    const result = service.assess({
      incident: baseIncident,
      plan: makePlan("disable_skill"),
      nowIso: NOW,
    });
    expect(result.riskTier).toBe(2);
    expect(result.autoApplyAllowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
  });

  it("assigns Tier 2 for pause_workflow", () => {
    const result = service.assess({
      incident: baseIncident,
      plan: makePlan("pause_workflow"),
      nowIso: NOW,
    });
    expect(result.riskTier).toBe(2);
    expect(result.requiresApproval).toBe(true);
  });

  it("escalates to Tier 2 for high severity incidents", () => {
    const highSev = { ...baseIncident, severity: "high" as const };
    const result = service.assess({
      incident: highSev,
      plan: makePlan("retry_node"),
      nowIso: NOW,
    });
    expect(result.riskTier).toBe(2);
    expect(result.requiresApproval).toBe(true);
    expect(result.reasons).toContain(
      "High severity incident escalates to Tier 2",
    );
  });

  it("provides reasons for risk assessment", () => {
    const result = service.assess({
      incident: baseIncident,
      plan: makePlan("retry_node"),
      nowIso: NOW,
    });
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("uses the highest tier when plan has mixed step kinds", () => {
    const mixedPlan: FridayAutoFixPlan = {
      ...makePlan("retry_node"),
      steps: [
        { stepId: "s1", kind: "retry_node", target: "t", payload: {} },
        { stepId: "s2", kind: "disable_skill", target: "t", payload: {} },
      ],
    };

    const result = service.assess({
      incident: baseIncident,
      plan: mixedPlan,
      nowIso: NOW,
    });
    expect(result.riskTier).toBe(2);
    expect(result.requiresApproval).toBe(true);
  });

  describe("rollback-rate escalation (24h rolling window)", () => {
    function seedIncident(id: string) {
      const incidentRepo = createFridayErrorIncidentRepository();
      incidentRepo.insert(db.writer, {
        incidentId: id,
        userId: "test-user",
        ts: NOW,
        category: "tool",
        severity: "medium",
        signature: `sig-${id}`,
        context: {},
        autoFixEligible: true,
        status: "open",
        createdAt: NOW,
        updatedAt: NOW,
      });
    }

    it("escalates to Tier 2 when 24h rollback rate > 30%", () => {
      // Seed incidents for FK constraints
      for (let i = 1; i <= 10; i++) {
        seedIncident(`inc-esc-${i}`);
      }

      const plan = makePlan("retry_node");
      // Create 10 actions: 4 rolled back, 3 applied within 24h → rollback rate = 4/7 = 57%
      const recentTime = "2025-06-15T08:00:00.000Z"; // 2h before NOW
      for (let i = 1; i <= 4; i++) {
        actionRepo.insert(db.writer, {
          actionId: `action-rb-${i}`,
          incidentId: `inc-esc-${i}`,
          userId: "test-user",
          riskTier: 0,
          plan,
          status: "planned",
          outcome: null,
          createdAt: recentTime,
          updatedAt: recentTime,
        });
        // Mark rolled back
        actionRepo.markRolledBack(db.writer, `action-rb-${i}`, recentTime);
      }
      for (let i = 5; i <= 7; i++) {
        actionRepo.insert(db.writer, {
          actionId: `action-ok-${i}`,
          incidentId: `inc-esc-${i}`,
          userId: "test-user",
          riskTier: 0,
          plan,
          status: "planned",
          outcome: null,
          createdAt: recentTime,
          updatedAt: recentTime,
        });
        // Mark applied
        actionRepo.markApplied(db.writer, `action-ok-${i}`, "success", recentTime);
      }

      const result = service.assess({
        incident: baseIncident,
        plan: makePlan("retry_node"),
        nowIso: NOW,
      });
      expect(result.riskTier).toBe(2);
      expect(result.requiresApproval).toBe(true);
      expect(result.reasons.some((r) => r.includes("rollback rate"))).toBe(true);
    });

    it("does NOT escalate when rollback rate <= 30%", () => {
      // Seed incidents
      for (let i = 1; i <= 10; i++) {
        seedIncident(`inc-ok-${i}`);
      }

      const plan = makePlan("retry_node");
      const recentTime = "2025-06-15T08:00:00.000Z";
      // 1 rolled back, 9 applied → rate = 1/10 = 10%
      actionRepo.insert(db.writer, {
        actionId: "action-rb-1",
        incidentId: "inc-ok-1",
        userId: "test-user",
        riskTier: 0,
        plan,
        status: "planned",
        outcome: null,
        createdAt: recentTime,
        updatedAt: recentTime,
      });
      actionRepo.markRolledBack(db.writer, "action-rb-1", recentTime);

      for (let i = 2; i <= 10; i++) {
        actionRepo.insert(db.writer, {
          actionId: `action-ok-${i}`,
          incidentId: `inc-ok-${i}`,
          userId: "test-user",
          riskTier: 0,
          plan,
          status: "planned",
          outcome: null,
          createdAt: recentTime,
          updatedAt: recentTime,
        });
        actionRepo.markApplied(db.writer, `action-ok-${i}`, "success", recentTime);
      }

      const result = service.assess({
        incident: baseIncident,
        plan: makePlan("retry_node"),
        nowIso: NOW,
      });
      expect(result.riskTier).toBe(0);
      expect(result.autoApplyAllowed).toBe(true);
    });
  });

  describe("1h spike escalation", () => {
    function seedIncident(id: string) {
      const incidentRepo = createFridayErrorIncidentRepository();
      incidentRepo.insert(db.writer, {
        incidentId: id,
        userId: "test-user",
        ts: NOW,
        category: "tool",
        severity: "medium",
        signature: `sig-${id}`,
        context: {},
        autoFixEligible: true,
        status: "open",
        createdAt: NOW,
        updatedAt: NOW,
      });
    }

    it("escalates to Tier 2 when 1h rollbacks > 3x 24h hourly baseline", () => {
      // Seed incidents
      for (let i = 1; i <= 80; i++) {
        seedIncident(`inc-spike-${i}`);
      }

      const plan = makePlan("retry_node");

      // We need: rollback rate ≤ 30% (so the 24h rate check doesn't fire first)
      // but 1h spike > 3x baseline.
      //
      // Strategy: 
      // - 24h: 6 rollbacks spread over 24h + 60 applied = rollback rate 6/66 ≈ 9%
      // - 1h: 4 of those 6 rollbacks are in the last hour
      // - baseline = 6/24 = 0.25 rollbacks/hour
      // - 1h actual = 4 rollbacks
      // - 4 > 3 * 0.25 = 0.75 → spike triggered
      
      // 2 rollbacks at ~12h ago (outside 1h)
      for (let i = 1; i <= 2; i++) {
        const time = new Date(new Date(NOW).getTime() - 12 * 60 * 60 * 1000).toISOString();
        actionRepo.insert(db.writer, {
          actionId: `action-old-rb-${i}`,
          incidentId: `inc-spike-${i}`,
          userId: "test-user",
          riskTier: 0,
          plan,
          status: "planned",
          outcome: null,
          createdAt: time,
          updatedAt: time,
        });
        actionRepo.markRolledBack(db.writer, `action-old-rb-${i}`, time);
      }

      // 4 rollbacks at 15 min ago (inside 1h)
      for (let i = 3; i <= 6; i++) {
        const time = new Date(new Date(NOW).getTime() - 15 * 60 * 1000).toISOString();
        actionRepo.insert(db.writer, {
          actionId: `action-recent-rb-${i}`,
          incidentId: `inc-spike-${i}`,
          userId: "test-user",
          riskTier: 0,
          plan,
          status: "planned",
          outcome: null,
          createdAt: time,
          updatedAt: time,
        });
        actionRepo.markRolledBack(db.writer, `action-recent-rb-${i}`, time);
      }

      // 60 applied actions spread over 24h (to keep rollback rate low)
      for (let i = 7; i <= 66; i++) {
        const hoursAgo = Math.floor((i - 7) / 3); // Spread across hours
        const time = new Date(new Date(NOW).getTime() - hoursAgo * 60 * 60 * 1000).toISOString();
        actionRepo.insert(db.writer, {
          actionId: `action-ok-${i}`,
          incidentId: `inc-spike-${i}`,
          userId: "test-user",
          riskTier: 0,
          plan,
          status: "planned",
          outcome: null,
          createdAt: time,
          updatedAt: time,
        });
        actionRepo.markApplied(db.writer, `action-ok-${i}`, "success", time);
      }

      const result = service.assess({
        incident: baseIncident,
        plan: makePlan("retry_node"),
        nowIso: NOW,
      });
      expect(result.riskTier).toBe(2);
      expect(result.reasons.some((r) => r.includes("spike"))).toBe(true);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayApprovalExpiryJob } from "#jobs";
import { createFridayApprovalWorkflowService } from "#learning";
import { createFridayApprovalRequestRepository } from "#learning";
import { createFridayAutoFixActionRepository } from "#learning";
import { createFridayErrorIncidentRepository } from "#learning";
import type { FridayApprovalExpiryJob } from "#jobs";
import type { FridayAutoFixPlan } from "#learning";

describe("FridayApprovalExpiryJob", () => {
  let db: FridaySqliteLayer;
  let job: FridayApprovalExpiryJob;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";
  const PAST = "2025-06-14T10:00:00.000Z";

  const basePlan: FridayAutoFixPlan = {
    title: "Auto-fix: disable skill",
    summary: "Disable the broken skill",
    steps: [
      { stepId: "step-001", kind: "disable_skill", target: "skill-x", payload: {} },
    ],
    evidence: {
      fingerprint: "sig-abc",
      matchedLessonIds: [],
      diagnosisId: "diag-001",
      recurrenceCount: 1,
    },
  };

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();

    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, {
      incidentId: "inc-001",
      userId: "test-user",
      ts: NOW,
      category: "tool",
      severity: "high",
      signature: "sig-abc",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const actionRepo = createFridayAutoFixActionRepository();
    actionRepo.insert(db.writer, {
      actionId: "action-001",
      incidentId: "inc-001",
      userId: "test-user",
      riskTier: 2,
      plan: basePlan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const approvalRepo = createFridayApprovalRequestRepository();
    const approvalService = createFridayApprovalWorkflowService({
      db,
      approvalRepo,
      actionRepo,
      idGenerator: idGen,
    });

    // Create an expired approval request
    approvalService.createRequestForAction({
      action: {
        actionId: "action-001",
        incidentId: "inc-001",
        userId: "test-user",
        riskTier: 2,
        plan: basePlan,
        status: "planned",
        outcome: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      description: "Approve this",
      nowIso: PAST,
      expiresAt: PAST, // Already expired
    });

    job = createFridayApprovalExpiryJob({
      approvalService,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("expires pending requests that are past expiry", () => {
    const result = job.run();
    expect(result.expiredCount).toBe(1);
    expect(result.expired).toHaveLength(1);
    expect(result.expired[0]!.status).toBe("expired");
  });

  it("marks linked actions as rejected", () => {
    job.run();

    const actionRepo = createFridayAutoFixActionRepository();
    const action = actionRepo.getById(db.writer, "action-001");
    expect(action!.status).toBe("rejected");
  });

  it("returns empty when no expired requests exist", () => {
    // Run once to expire
    job.run();
    // Run again — nothing left
    const result = job.run();
    expect(result.expiredCount).toBe(0);
    expect(result.expired).toHaveLength(0);
  });

  it("accepts a nowOverride parameter", () => {
    // Use a time before the expiry — should not expire
    const result = job.run("2025-06-13T10:00:00.000Z");
    expect(result.expiredCount).toBe(0);
  });
});

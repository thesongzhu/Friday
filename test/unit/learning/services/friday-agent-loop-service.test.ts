import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFridayAgentLoopRepository,
  createFridayAgentLoopService,
} from "#learning";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../../helpers/friday-test-db.helper.js";

const NOW = "2026-03-07T12:00:00.000Z";

function buildIncidentDetails(input?: {
  incidentId?: string;
  actionId?: string;
  riskTier?: 0 | 1 | 2;
  approvalPending?: boolean;
  fingerprint?: string;
  includeRollback?: boolean;
  includeVerify?: boolean;
}) {
  const incidentId = input?.incidentId ?? "incident-1";
  const actionId = input?.actionId ?? "action-1";
  const riskTier = input?.riskTier ?? 0;
  const includeRollback = input?.includeRollback ?? true;
  const includeVerify = input?.includeVerify ?? true;
  const fingerprint = input?.fingerprint ?? "fp-1";
  return {
    incident: {
      incidentId,
      userId: "user-1",
      ts: NOW,
      category: "workflow" as const,
      severity: "high" as const,
      signature: fingerprint,
      context: {},
      autoFixEligible: true,
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    },
    diagnosis: {
      id: `diag-${incidentId}`,
      incidentId,
      errorFingerprint: fingerprint,
      confidence: 0.9,
      diagnosis: { summary: "workflow deploy failed" },
      createdAt: NOW,
      updatedAt: NOW,
    },
    lesson: null,
    action: {
      action: {
        actionId,
        incidentId,
        userId: "user-1",
        riskTier,
        plan: {
          title: "Apply fix",
          summary: "Apply the fix and verify the workflow",
          steps: includeVerify
            ? [{ stepId: "step-1", kind: "patch", target: "workflow", payload: {}, verify: { method: "run-check", timeoutMs: 1000 } }]
            : [{ stepId: "step-1", kind: "patch", target: "workflow", payload: {} }],
          rollbackPlan: includeRollback
            ? {
              summary: "Restore the prior workflow state",
              steps: [{ stepId: "rollback-1", kind: "restore", target: "workflow", payload: {} }],
            }
            : undefined,
          evidence: {
            fingerprint,
            matchedLessonIds: [],
            diagnosisId: `diag-${incidentId}`,
            recurrenceCount: 1,
          },
        },
        rollbackPlan: includeRollback
          ? {
            summary: "Restore the prior workflow state",
            steps: [{ stepId: "rollback-1", kind: "restore", target: "workflow", payload: {} }],
          }
          : undefined,
        status: "planned" as const,
        outcome: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      incident: null,
      diagnosis: null,
      approval: riskTier >= 2
        ? {
          requestId: `approval-${actionId}`,
          actionId,
          userId: "user-1",
          description: "Approve fix",
          riskTier: 2 as const,
          plan: {
            title: "Apply fix",
            summary: "Apply the fix and verify the workflow",
            steps: [],
            evidence: {
              fingerprint,
              matchedLessonIds: [],
              diagnosisId: `diag-${incidentId}`,
              recurrenceCount: 1,
            },
          },
          requestedAt: NOW,
          expiresAt: NOW,
          status: input?.approvalPending === false ? "approved" as const : "pending" as const,
          createdAt: NOW,
          updatedAt: NOW,
        }
        : null,
      lesson: null,
      risk: {
        riskTier,
        reasons: riskTier >= 2 ? ["approval required"] : [],
        requiresApproval: riskTier >= 2,
        autoApplyAllowed: riskTier < 2,
      },
      evidence: {
        rootCauseSummary: "workflow deploy failed",
        selectedPlan: {
          title: "Apply fix",
          summary: "Apply the fix and verify the workflow",
          stepCount: 1,
          rollbackPlanAvailable: includeRollback,
        },
        riskTier,
        approvalTrail: riskTier >= 2 ? {
          requestId: `approval-${actionId}`,
          status: input?.approvalPending === false ? "approved" as const : "pending" as const,
        } : undefined,
        executionResult: {
          status: "planned" as const,
          outcome: null,
        },
        rollbackResult: {
          available: includeRollback,
          rollbackAttempted: false,
          rollbackSucceeded: false,
        },
        acceptanceResult: {
          passed: false,
          reason: "Pending verification",
        },
      },
    },
    recurrenceCount: 1,
    autoFixEligible: true,
  };
}

describe("createFridayAgentLoopService", () => {
  let db: FridaySqliteLayer | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  function createSubject(details = buildIncidentDetails(), executionResult = {
    success: true,
    verificationPassed: true,
    rollbackAttempted: false,
    rollbackSucceeded: false,
  }) {
    db = createTestDb();
    const loopRepo = createFridayAgentLoopRepository();
    const observability = {
      recordAgentLoopEvent: vi.fn(async () => undefined),
    };

    const service = createFridayAgentLoopService({
      db,
      idGenerator: (() => {
        let counter = 0;
        return () => `loop-id-${++counter}`;
      })(),
      nowIso: () => NOW,
      loopRepo,
      incidentRepo: {} as never,
      diagnosisRepo: {} as never,
      actionRepo: {} as never,
      lessonRepo: {} as never,
      approvalService: {
        reject: vi.fn(async () => undefined),
      } as never,
      executionService: {
        execute: vi.fn(async () => ({
          action: details.action.action,
          ...executionResult,
        })),
      } as never,
      dispatcher: {
        runApprovedAction: vi.fn(async () => ({
          action: details.action.action,
          ...executionResult,
        })),
      } as never,
      selfHealing: {
        getIncident: vi.fn(({ incidentId }: { incidentId: string }) => incidentId === details.incident.incidentId ? details : null),
        getAction: vi.fn(({ actionId }: { actionId: string }) => actionId === details.action.action.actionId ? details.action : null),
      } as never,
      observability: observability as never,
      publishEvent: {
        publish: vi.fn(),
      },
    });

    return { service, loopRepo, observability };
  }

  it("auto-executes low-risk fixes and verifies the run", async () => {
    const { service } = createSubject(buildIncidentDetails({ riskTier: 0 }));

    const [run] = await service.handleProcessResults({
      results: [{
        incidentsCreated: [{ incidentId: "incident-1" } as never],
        diagnosisCreated: [],
      }],
      correlationId: "corr-1",
    });

    expect(run?.run.status).toBe("verified");
    expect(run?.run.verificationPassed).toBe(true);
  });

  it("waits for approval on high-risk fixes", async () => {
    const { service } = createSubject(buildIncidentDetails({ riskTier: 2, approvalPending: true }));

    const [run] = await service.handleProcessResults({
      results: [{
        incidentsCreated: [{ incidentId: "incident-1" } as never],
        diagnosisCreated: [],
      }],
    });

    expect(run?.run.status).toBe("awaiting_approval");
    expect(run?.run.haltReason).toBe("approval_required");
  });

  it("forces final approval for destructive expert-mode repairs even at low risk tier", async () => {
    const details = buildIncidentDetails({ riskTier: 0 });
    details.action.action.plan.title = "Delete stale production secret";
    details.action.action.plan.summary = "Delete the production secret after validating the replacement path.";
    details.action.evidence.selectedPlan.title = details.action.action.plan.title;
    details.action.evidence.selectedPlan.summary = details.action.action.plan.summary;

    const { service } = createSubject(details);
    service.updateExpertMode({
      expertModeEnabled: true,
      expertModeUserIds: ["user-1"],
      expertModeWorkspaceIds: ["default-workspace"],
      expertModeEnvironments: ["test"],
    });

    const [run] = await service.handleProcessResults({
      results: [{
        incidentsCreated: [{ incidentId: "incident-1" } as never],
        diagnosisCreated: [],
      }],
    });

    expect(run?.run.expertModeEnabled).toBe(true);
    expect(run?.run.riskClass).toBe("destructive_or_sensitive");
    expect(run?.run.requiresFinalApproval).toBe(true);
    expect(run?.run.status).toBe("awaiting_approval");
    expect(run?.run.haltReason).toBe("approval_required");
  });

  it("halts when the failure budget is already exhausted for a fingerprint", async () => {
    const details = buildIncidentDetails({ riskTier: 0, fingerprint: "fp-budget" });
    const { service, loopRepo } = createSubject(details);
    service.updatePolicy({ maxAttemptsPerFingerprint: 1 });
    db!.withWriteTransaction((writer) => {
      loopRepo.insertRun(writer, {
        loopRunId: "existing-run",
        userId: "user-1",
        incidentId: "incident-old",
        actionId: "action-old",
        fingerprint: "fp-budget",
        trigger: "incident_opened",
        status: "failed",
        riskTier: 0,
        approvalRequired: false,
        attemptNumber: 1,
        rollbackAttempted: false,
        rollbackSucceeded: false,
        createdAt: NOW,
        updatedAt: NOW,
      });
    });

    const [run] = await service.handleProcessResults({
      results: [{
        incidentsCreated: [{ incidentId: "incident-1" } as never],
        diagnosisCreated: [],
      }],
    });

    expect(run?.run.status).toBe("halted");
    expect(run?.run.haltReason).toBe("failure_budget_exhausted");
  });

  it("resumes eligible cooldown runs and re-executes them", async () => {
    const details = buildIncidentDetails({ riskTier: 0, fingerprint: "fp-cooldown" });
    const { service, loopRepo } = createSubject(details);

    db!.withWriteTransaction((writer) => {
      loopRepo.insertRun(writer, {
        loopRunId: "cooldown-run-1",
        userId: "user-1",
        incidentId: details.incident.incidentId,
        actionId: details.action.action.actionId,
        fingerprint: "fp-cooldown",
        trigger: "incident_opened",
        status: "cooldown",
        riskTier: 0,
        approvalRequired: false,
        attemptNumber: 1,
        verificationPassed: false,
        rollbackAttempted: false,
        rollbackSucceeded: false,
        cooldownUntil: "2026-03-07T11:59:00.000Z",
        createdAt: NOW,
        updatedAt: NOW,
      });
    });

    const [run] = await service.resumeCooldownRuns({ nowIso: NOW });

    expect(run).toBeDefined();
    expect(run?.run.loopRunId).toBe("cooldown-run-1");
    expect(run?.run.attemptNumber).toBe(2);
    expect(run?.run.trigger).toBe("cooldown_elapsed");
    expect(run?.run.status).toBe("verified");
    expect(run?.run.verificationPassed).toBe(true);
  });

  it("moves eligible cooldown runs back to paused when the policy is paused", async () => {
    const details = buildIncidentDetails({ riskTier: 0, fingerprint: "fp-paused" });
    const { service, loopRepo } = createSubject(details);
    service.updatePolicy({ paused: true });

    db!.withWriteTransaction((writer) => {
      loopRepo.insertRun(writer, {
        loopRunId: "cooldown-run-2",
        userId: "user-1",
        incidentId: details.incident.incidentId,
        actionId: details.action.action.actionId,
        fingerprint: "fp-paused",
        trigger: "incident_opened",
        status: "cooldown",
        riskTier: 0,
        approvalRequired: false,
        attemptNumber: 1,
        verificationPassed: false,
        rollbackAttempted: false,
        rollbackSucceeded: false,
        cooldownUntil: "2026-03-07T11:59:00.000Z",
        createdAt: NOW,
        updatedAt: NOW,
      });
    });

    const [run] = await service.resumeCooldownRuns({ nowIso: NOW });

    expect(run).toBeDefined();
    expect(run?.run.status).toBe("paused");
    expect(run?.run.haltReason).toBe("policy_paused");
    expect(run?.run.cooldownUntil).toBeUndefined();
  });
});

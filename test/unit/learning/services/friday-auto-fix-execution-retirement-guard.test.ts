import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import {
  createFridayAutoFixExecutionService,
  createFridayAutoFixRollbackService,
  createFridayAutoFixActionRepository,
  createFridayErrorIncidentRepository,
  createFridayDiagnosisRecordRepository,
} from "#learning";
import type {
  FridayAutoFixActionEntity,
  FridayAutoFixActionRepository,
  FridayAutoFixExecutionService,
  FridayAutoFixPlan,
  StepExecutor,
} from "#learning";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

/**
 * TS Runtime Retirement — METHOD-level guard for the auto-fix EXECUTOR (G1).
 *
 * The autofix-execution route surface (`autofix.actions.execute`/`run.ready`/
 * `rollback`) is advertised retired and was guarded at the HTTP route layer
 * (`friday-auto-fix-routes.ts`, `allowTestOnlyAutoFixExecution`). But the live
 * self-healing loop reaches the mutating executor OFF-route:
 * `selfHealing.reportStructuredFailure` (workflow deploy-catch + hub-bootstrap
 * workflow-failure hook) → rule-based planner → agent-loop `executeRun` →
 * `executionService.execute()`. The dispatcher and approval-workflow also call
 * `execute()` directly. Default autofix policy is permissive
 * (`autoApplyLowRisk:true`, `paused:false`), so this path was firing-capable on
 * a default prod hub today (bounded to tier<2 reversible actions).
 *
 * These tests prove the guard now lives on the METHOD: in default/live config
 * (test-oracle flag unset) `execute()` fails closed BEFORE any state read,
 * executor side effect, rollback, or lesson-extraction provider call. With the
 * explicit test-oracle flag enabled the legacy path still works.
 */

const RETIRED_CODE = "TS_RUNTIME_AUTOFIX_EXECUTION_RETIRED";
const NOW = "2026-06-10T00:00:00.000Z";

describe("FridayAutoFixExecutionService TS-retirement method guard", () => {
  let db: FridaySqliteLayer;
  let actionRepo: FridayAutoFixActionRepository;
  let executorCalls: string[];

  const plan: FridayAutoFixPlan = {
    title: "Auto-fix: retry node",
    summary: "Retry the failed operation",
    steps: [
      {
        stepId: "step-001",
        kind: "retry_node",
        target: "tool",
        payload: {},
        verify: { method: "error_absent", timeoutMs: 5000 },
      },
    ],
    evidence: {
      fingerprint: "sig-guard",
      matchedLessonIds: [],
      diagnosisId: "diag-guard",
      recurrenceCount: 1,
    },
  };

  // Booby-trapped executor: if the guard ever lets execution proceed while the
  // flag is unset, this records the call so the side-effect assertion fails.
  const boobyTrappedExecutor: StepExecutor = (step) => {
    executorCalls.push(step.stepId);
    const payload = step.payload as Record<string, unknown> | null;
    if (payload && typeof payload === "object") {
      payload._retryRequested = true;
    }
    return true;
  };

  beforeEach(() => {
    db = createTestDb();
    executorCalls = [];

    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, {
      incidentId: "inc-guard",
      userId: "test-user",
      ts: NOW,
      category: "tool",
      severity: "medium",
      signature: "sig-guard",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    diagnosisRepo.insert(db.writer, {
      id: "diag-guard",
      incidentId: "inc-guard",
      errorFingerprint: "sig-guard",
      confidence: 0.8,
      diagnosis: { summary: "test" },
      createdAt: NOW,
      updatedAt: NOW,
    });

    actionRepo = createFridayAutoFixActionRepository();
    const action: FridayAutoFixActionEntity = {
      actionId: "action-guard",
      incidentId: "inc-guard",
      userId: "test-user",
      riskTier: 0,
      plan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    actionRepo.insert(db.writer, action);
  });

  afterEach(() => {
    db.close();
  });

  function buildService(allowTestOnlyAutoFixExecution?: boolean): FridayAutoFixExecutionService {
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const rollbackService = createFridayAutoFixRollbackService({
      db,
      actionRepo,
      nowIso: () => NOW,
      stepExecutors: { retry_node: boobyTrappedExecutor },
    });
    return createFridayAutoFixExecutionService({
      db,
      actionRepo,
      incidentRepo,
      diagnosisRepo,
      rollbackService,
      nowIso: () => NOW,
      stepExecutors: { retry_node: boobyTrappedExecutor },
      ...(allowTestOnlyAutoFixExecution === undefined
        ? {}
        : { allowTestOnlyAutoFixExecution }),
    });
  }

  function actionStatus(): string | undefined {
    return db.withReadConnection((reader) =>
      actionRepo.getById(reader, "action-guard")?.status);
  }

  it("execute() fails closed by default: throws 503 fail_closed and runs no executor / mutates nothing", async () => {
    const service = buildService();

    let caught: unknown;
    try {
      await service.execute("action-guard");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FridayDomainError);
    const domainError = caught as FridayDomainError;
    expect(domainError.code).toBe(RETIRED_CODE);
    expect(domainError.httpStatus).toBe(503);
    expect(domainError.details?.classification).toBe("fail_closed");

    // Zero side effects: no executor call, action still 'planned'.
    expect(executorCalls).toEqual([]);
    expect(actionStatus()).toBe("planned");
  });

  it("execute() fails closed with the flag explicitly false (same zero side effects)", async () => {
    const service = buildService(false);

    await expect(service.execute("action-guard")).rejects.toMatchObject({
      code: RETIRED_CODE,
      httpStatus: 503,
    });
    expect(executorCalls).toEqual([]);
    expect(actionStatus()).toBe("planned");
  });

  it("execute() runs the legacy path when the test-oracle flag is exactly true", async () => {
    const service = buildService(true);

    const result = await service.execute("action-guard");

    expect(result.success).toBe(true);
    expect(result.verificationPassed).toBe(true);
    expect(executorCalls).toEqual(["step-001"]);
    expect(actionStatus()).toBe("applied");
  });

  it("guard fires before the action read: a non-existent actionId still throws the retirement 503, not NOT_FOUND", async () => {
    const service = buildService();

    await expect(service.execute("does-not-exist")).rejects.toMatchObject({
      code: RETIRED_CODE,
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayAutoFixExecutionService } from "#learning";
import { createFridayAutoFixRollbackService } from "#learning";
import { createFridayAutoFixActionRepository } from "#learning";
import { createFridayErrorIncidentRepository } from "#learning";
import { createFridayDiagnosisRecordRepository } from "#learning";
import { createFridayLearnedLessonRepository } from "#learning";
import { createFridayAutoFixLessonExtractionService } from "#learning";
import type { FridayAutoFixExecutionService } from "#learning";
import type { FridayAutoFixActionEntity, FridayAutoFixPlan } from "#learning";
import type { FridayAutoFixActionRepository } from "#learning";
import type { FridayAutoFixStepKind, StepExecutor } from "#learning";

describe("FridayAutoFixExecutionService", () => {
  let db: FridaySqliteLayer;
  let service: FridayAutoFixExecutionService;
  const NOW = "2025-06-15T10:00:00.000Z";

  const basePlan: FridayAutoFixPlan = {
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
      fingerprint: "sig-abc",
      matchedLessonIds: [],
      diagnosisId: "diag-001",
      recurrenceCount: 1,
    },
  };

  const markerByKind: Partial<Record<FridayAutoFixStepKind, string>> = {
    retry_node: "_retryRequested",
    switch_model_fallback: "_modelFallbackRequested",
    trim_payload: "_trimRequested",
    apply_config_patch: "_configPatchApplied",
    grant_permission: "_permissionGranted",
    disable_skill: "_skillDisabled",
    pause_workflow: "_workflowPaused",
    regenerate_skill: "_skillRegenerated",
  };

  const timestampMarkerByKind: Partial<Record<FridayAutoFixStepKind, string>> = {
    retry_node: "_retryAt",
    switch_model_fallback: "_fallbackAt",
    apply_config_patch: "_appliedAt",
    grant_permission: "_grantedAt",
    disable_skill: "_disabledAt",
    pause_workflow: "_pausedAt",
    regenerate_skill: "_regeneratedAt",
  };

  function markerExecutor(kind: FridayAutoFixStepKind): StepExecutor {
    return (step) => {
      if (!step.target) return false;
      const payload = step.payload as Record<string, unknown> | null;
      const marker = markerByKind[kind];
      if (payload && typeof payload === "object" && marker) {
        payload[marker] = true;
        const timestampMarker = timestampMarkerByKind[kind];
        if (timestampMarker) {
          payload[timestampMarker] = NOW;
        }
        // Phase 14.5B module_28b: the default verifier for apply_config_patch
        // now requires a real config revision returned by configManager. The
        // parameterized marker test simulates a verified repair by recording
        // a deterministic non-zero revision; the real hub executor sets the
        // same field from configManager.applyPatch.
        if (kind === "apply_config_patch") {
          payload._configPatchRevision = 1;
        }
      }
      return true;
    };
  }

  function setupDeps() {
    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, {
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
    });

    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    diagnosisRepo.insert(db.writer, {
      id: "diag-001",
      incidentId: "inc-001",
      errorFingerprint: "sig-abc",
      confidence: 0.8,
      diagnosis: { summary: "test" },
      createdAt: NOW,
      updatedAt: NOW,
    });

    const actionRepo = createFridayAutoFixActionRepository();
    return { incidentRepo, diagnosisRepo, actionRepo };
  }

  beforeEach(() => {
    db = createTestDb();
    const { incidentRepo, diagnosisRepo, actionRepo } = setupDeps();
    const rollbackService = createFridayAutoFixRollbackService({
      db,
      actionRepo,
      nowIso: () => NOW,
    });
    service = createFridayAutoFixExecutionService({
      db,
      actionRepo,
      incidentRepo,
      diagnosisRepo,
      rollbackService,
      nowIso: () => NOW,
      stepExecutors: {
        retry_node: markerExecutor("retry_node"),
      },
    });

    // Insert a planned action
    const action: FridayAutoFixActionEntity = {
      actionId: "action-001",
      incidentId: "inc-001",
      userId: "test-user",
      riskTier: 0,
      plan: basePlan,
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

  it("executes a Tier 0 action successfully", async () => {
    const result = await service.execute("action-001");
    expect(result.success).toBe(true);
    expect(result.verificationPassed).toBe(true);
    expect(result.action.status).toBe("applied");
    expect(result.action.outcome).toBe("success");
    expect(result.rollbackAttempted).toBe(false);
  });

  it.each([
    {
      kind: "retry_node" as const,
      target: "tool",
      payload: {},
      riskTier: 0,
      marker: "_retryRequested",
      timestampMarker: "_retryAt",
    },
    {
      kind: "switch_model_fallback" as const,
      target: "llm-route",
      payload: {},
      riskTier: 1,
      marker: "_modelFallbackRequested",
      timestampMarker: "_fallbackAt",
    },
    {
      kind: "trim_payload" as const,
      target: "workflow-node",
      payload: {},
      riskTier: 0,
      marker: "_trimRequested",
    },
    {
      kind: "apply_config_patch" as const,
      target: "runtime-config",
      payload: { key: "value" },
      riskTier: 1,
      marker: "_configPatchApplied",
      timestampMarker: "_appliedAt",
    },
    {
      kind: "grant_permission" as const,
      target: "filesystem:/tmp",
      payload: { permission: "write" },
      riskTier: 1,
      marker: "_permissionGranted",
      timestampMarker: "_grantedAt",
    },
    {
      kind: "pause_workflow" as const,
      target: "workflow-123",
      payload: {},
      riskTier: 2,
      marker: "_workflowPaused",
      timestampMarker: "_pausedAt",
    },
  ])("executes and verifies injected step kind '$kind'", async ({
    kind,
    target,
    payload,
    riskTier,
    marker,
    timestampMarker,
  }) => {
    const actionRepo = createFridayAutoFixActionRepository();
    const incidentId = `inc-${kind}`;
    const diagnosisId = `diag-${kind}`;
    const actionId = `action-${kind}`;

    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, {
      incidentId,
      userId: "test-user",
      ts: NOW,
      category: "tool",
      severity: "medium",
      signature: `sig-${kind}`,
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    diagnosisRepo.insert(db.writer, {
      id: diagnosisId,
      incidentId,
      errorFingerprint: `sig-${kind}`,
      confidence: 0.8,
      diagnosis: { summary: `test ${kind}` },
      createdAt: NOW,
      updatedAt: NOW,
    });

    actionRepo.insert(db.writer, {
      actionId,
      incidentId,
      userId: "test-user",
      riskTier,
      plan: {
        title: `Auto-fix: ${kind}`,
        summary: `Execute ${kind}`,
        steps: [
          {
            stepId: `step-${kind}`,
            kind,
            target,
            payload: { ...payload },
            verify: { method: "error_absent", timeoutMs: 5_000 },
          },
        ],
        rollbackPlan: riskTier >= 1 || kind === "switch_model_fallback"
          ? {
              summary: `Rollback ${kind}`,
              steps: [
                {
                  stepId: `rollback-${kind}`,
                  kind,
                  target,
                  payload: kind === "switch_model_fallback"
                    ? {
                        revert: true,
                        restoreProviderId: "provider-primary",
                        restoreModel: "model-primary",
                      }
                    : { revert: true },
                },
              ],
            }
          : undefined,
        evidence: {
          fingerprint: `sig-${kind}`,
          matchedLessonIds: [],
          diagnosisId,
          recurrenceCount: 1,
        },
      },
      rollbackPlan: riskTier >= 1
        ? {
            summary: `Rollback ${kind}`,
            steps: [
              {
                stepId: `rollback-${kind}`,
                kind,
                target,
                payload: { revert: true },
              },
            ],
          }
        : undefined,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const executionService = createFridayAutoFixExecutionService({
      db,
      actionRepo,
      incidentRepo,
      diagnosisRepo,
      rollbackService: createFridayAutoFixRollbackService({
        db,
        actionRepo,
        nowIso: () => NOW,
      }),
      nowIso: () => NOW,
      stepExecutors: {
        [kind]: markerExecutor(kind),
      },
    });

    const result = await executionService.execute(actionId);
    const updated = actionRepo.getById(db.writer, actionId);
    const persistedPayload = updated?.plan.steps[0]?.payload as Record<string, unknown> | undefined;

    expect(result.success).toBe(true);
    expect(result.verificationPassed).toBe(true);
    expect(result.action.status).toBe("applied");
    expect(result.action.outcome).toBe("success");
    expect(persistedPayload?.[marker]).toBe(true);
    if (timestampMarker) {
      expect(typeof persistedPayload?.[timestampMarker]).toBe("string");
    }
  });

  it("fails closed when an external-state step has no injected executor", async () => {
    const actionRepo = createFridayAutoFixActionRepository();
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    incidentRepo.insert(db.writer, {
      incidentId: "inc-no-executor",
      userId: "test-user",
      ts: NOW,
      category: "config",
      severity: "medium",
      signature: "sig-no-executor",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });
    diagnosisRepo.insert(db.writer, {
      id: "diag-no-executor",
      incidentId: "inc-no-executor",
      errorFingerprint: "sig-no-executor",
      confidence: 0.8,
      diagnosis: { summary: "test" },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const plan: FridayAutoFixPlan = {
      title: "Auto-fix: config patch",
      summary: "Patch config",
      steps: [
        {
          stepId: "step-no-executor",
          kind: "apply_config_patch",
          target: "runtime-config",
          payload: { key: "value" },
          verify: { method: "error_absent", timeoutMs: 5000 },
        },
      ],
      rollbackPlan: {
        summary: "Rollback config patch",
        steps: [
          {
            stepId: "rollback-no-executor",
            kind: "apply_config_patch",
            target: "runtime-config",
            payload: { revert: true },
          },
        ],
      },
      evidence: {
        fingerprint: "sig-no-executor",
        matchedLessonIds: [],
        diagnosisId: "diag-no-executor",
        recurrenceCount: 1,
      },
    };
    actionRepo.insert(db.writer, {
      actionId: "action-no-executor",
      incidentId: "inc-no-executor",
      userId: "test-user",
      riskTier: 1,
      plan,
      rollbackPlan: plan.rollbackPlan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const executionService = createFridayAutoFixExecutionService({
      db,
      actionRepo,
      incidentRepo,
      diagnosisRepo,
      rollbackService: createFridayAutoFixRollbackService({
        db,
        actionRepo,
        nowIso: () => NOW,
      }),
      nowIso: () => NOW,
    });

    const result = await executionService.execute("action-no-executor");

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("has no executor");
    expect(result.action.status).toBe("applied");
    expect(result.action.outcome).toBe("failed");
  });

  it("Phase 14.5B module_28b: default apply_config_patch verifier rejects diagnostic-only payloads without _configPatchRevision", async () => {
    const actionRepo = createFridayAutoFixActionRepository();
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    incidentRepo.insert(db.writer, {
      incidentId: "inc-no-revision",
      userId: "test-user",
      ts: NOW,
      category: "config",
      severity: "medium",
      signature: "sig-no-revision",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });
    diagnosisRepo.insert(db.writer, {
      id: "diag-no-revision",
      incidentId: "inc-no-revision",
      errorFingerprint: "sig-no-revision",
      confidence: 0.8,
      diagnosis: { summary: "test" },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const plan: FridayAutoFixPlan = {
      title: "Auto-fix: config patch",
      summary: "Patch config",
      steps: [
        {
          stepId: "step-no-revision",
          kind: "apply_config_patch",
          target: "runtime-config",
          payload: { key: "value" },
          verify: { method: "config_reload_valid", timeoutMs: 5000 },
        },
      ],
      rollbackPlan: {
        summary: "Rollback config patch",
        steps: [
          {
            stepId: "rollback-no-revision",
            kind: "apply_config_patch",
            target: "runtime-config",
            payload: { revert: true },
          },
        ],
      },
      evidence: {
        fingerprint: "sig-no-revision",
        matchedLessonIds: [],
        diagnosisId: "diag-no-revision",
        recurrenceCount: 1,
      },
    };
    actionRepo.insert(db.writer, {
      actionId: "action-no-revision",
      incidentId: "inc-no-revision",
      userId: "test-user",
      riskTier: 1,
      plan,
      rollbackPlan: plan.rollbackPlan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    // Inject an executor that sets _configPatchApplied=true but NO revision,
    // mirroring the prior diagnostic_marker shortcut. The default verifier
    // must refuse this payload so the action cannot finalize as a verified
    // repair.
    const executionService = createFridayAutoFixExecutionService({
      db,
      actionRepo,
      incidentRepo,
      diagnosisRepo,
      rollbackService: createFridayAutoFixRollbackService({
        db,
        actionRepo,
        nowIso: () => NOW,
        stepExecutors: {
          apply_config_patch: async (step) => {
            const payload = step.payload as Record<string, unknown>;
            payload._configPatchRolledBack = true;
            return true;
          },
        },
      }),
      nowIso: () => NOW,
      stepExecutors: {
        apply_config_patch: async (step) => {
          const payload = step.payload as Record<string, unknown>;
          payload._configPatchApplied = true;
          payload._configPatchMode = "diagnostic_only";
          return true;
        },
      },
    });

    const result = await executionService.execute("action-no-revision");

    expect(result.verificationPassed).toBe(false);
    expect(result.rollbackAttempted).toBe(true);
    expect(result.action.status).toBe("rolled_back");
    expect(result.action.outcome).toBe("failed");
  });

  it("honors injected executors and verifiers for supported kinds", async () => {
    const actionRepo = createFridayAutoFixActionRepository();
    actionRepo.insert(db.writer, {
      actionId: "action-disable-001",
      incidentId: "inc-001",
      userId: "test-user",
      riskTier: 0,
      plan: {
        title: "Disable skill",
        summary: "Disable skill-x",
        steps: [
          {
            stepId: "step-disable-001",
            kind: "disable_skill",
            target: "skill-x",
            payload: {},
            verify: { method: "error_absent", timeoutMs: 5000 },
          },
        ],
        evidence: {
          fingerprint: "sig-abc",
          matchedLessonIds: [],
          diagnosisId: "diag-001",
          recurrenceCount: 1,
        },
      },
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const executed: string[] = [];
    const verified: string[] = [];
    const overrideService = createFridayAutoFixExecutionService({
      db,
      actionRepo,
      incidentRepo: createFridayErrorIncidentRepository(),
      diagnosisRepo: createFridayDiagnosisRecordRepository(),
      rollbackService: createFridayAutoFixRollbackService({
        db,
        actionRepo,
        nowIso: () => NOW,
      }),
      nowIso: () => NOW,
      stepExecutors: {
        disable_skill: async (step) => {
          executed.push(step.stepId);
          return true;
        },
      },
      stepVerifiers: {
        disable_skill: async (step) => {
          verified.push(step.stepId);
          return true;
        },
      },
    });

    const result = await overrideService.execute("action-disable-001");

    expect(result.success).toBe(true);
    expect(executed).toEqual(["step-disable-001"]);
    expect(verified).toEqual(["step-disable-001"]);
  });

  it("fails closed when an injected executor rejects a step kind", async () => {
    const failClosedService = createFridayAutoFixExecutionService({
      db,
      actionRepo: createFridayAutoFixActionRepository(),
      incidentRepo: createFridayErrorIncidentRepository(),
      diagnosisRepo: createFridayDiagnosisRecordRepository(),
      rollbackService: createFridayAutoFixRollbackService({
        db,
        actionRepo: createFridayAutoFixActionRepository(),
        nowIso: () => NOW,
      }),
      nowIso: () => NOW,
      stepExecutors: {
        retry_node: async () => false,
      },
    });

    const result = await failClosedService.execute("action-001");

    expect(result.success).toBe(false);
    expect(result.rollbackAttempted).toBe(false);
    expect(result.action.status).toBe("applied");
    expect(result.action.outcome).toBe("failed");
    expect(result.errorMessage).toContain("failed during execution");
  });

  it("marks incident as mitigated on success", async () => {
    await service.execute("action-001");

    const incidentRepo = createFridayErrorIncidentRepository();
    const incidents = incidentRepo.listByUser(db.writer, {
      userId: "test-user",
      status: "mitigated",
    });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.incidentId).toBe("inc-001");
  });

  it("marks diagnosis as resolved on success", async () => {
    await service.execute("action-001");

    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const records = diagnosisRepo.listByFingerprint(db.writer, "sig-abc");
    expect(records[0]!.resolvedAt).toBe(NOW);
  });

  it("extracts a learned lesson and resolves the incident after successful execution", async () => {
    const lessonRepo = createFridayLearnedLessonRepository();
    const lessonService = createFridayAutoFixLessonExtractionService({
      db,
      lessonRepo,
      incidentRepo: createFridayErrorIncidentRepository(),
      diagnosisRepo: createFridayDiagnosisRecordRepository(),
      idGenerator: () => "lesson-001",
    });
    const actionRepo = createFridayAutoFixActionRepository();
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const lessonAwareService = createFridayAutoFixExecutionService({
      db,
      actionRepo,
      incidentRepo,
      diagnosisRepo,
      lessonExtractionService: lessonService,
      rollbackService: createFridayAutoFixRollbackService({
        db,
        actionRepo,
        nowIso: () => NOW,
      }),
      nowIso: () => NOW,
      stepExecutors: {
        retry_node: markerExecutor("retry_node"),
      },
    });

    const result = await lessonAwareService.execute("action-001");
    expect(result.success).toBe(true);

    const lesson = lessonRepo.getByFingerprint(db.writer, "sig-abc");
    expect(lesson).not.toBeNull();
    expect(lesson!.sourceIncidentId).toBe("inc-001");

    const incident = incidentRepo.getById(db.writer, "inc-001");
    expect(incident?.status).toBe("resolved");
  });

  it("throws for nonexistent action", async () => {
    await expect(service.execute("nonexistent")).rejects.toThrow(
      "Action nonexistent not found",
    );
  });

  it("throws for non-planned action", async () => {
    const actionRepo = createFridayAutoFixActionRepository();
    actionRepo.markApplied(db.writer, "action-001", "success", NOW);

    await expect(service.execute("action-001")).rejects.toThrow(
      "expected 'planned'",
    );
  });

  it("rejects Tier 1 action without rollback plan", async () => {
    const actionRepo = createFridayAutoFixActionRepository();
    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, {
      incidentId: "inc-002",
      userId: "test-user",
      ts: NOW,
      category: "config",
      severity: "medium",
      signature: "sig-cfg",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const tier1Plan: FridayAutoFixPlan = {
      ...basePlan,
      steps: [
        {
          stepId: "step-002",
          kind: "apply_config_patch",
          target: "config",
          payload: {},
        },
      ],
    };

    actionRepo.insert(db.writer, {
      actionId: "action-002",
      incidentId: "inc-002",
      userId: "test-user",
      riskTier: 1,
      plan: tier1Plan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const result = await service.execute("action-002");
    expect(result.success).toBe(false);
    expect(result.action.status).toBe("rejected");
    expect(result.errorMessage).toContain("rollback plan");
  });

  it("allows approved-style Tier 2 retry actions to execute without a rollback plan", async () => {
    const actionRepo = createFridayAutoFixActionRepository();
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();

    incidentRepo.insert(db.writer, {
      incidentId: "inc-003",
      userId: "test-user",
      ts: NOW,
      category: "workflow",
      severity: "high",
      signature: "sig-workflow",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });

    diagnosisRepo.insert(db.writer, {
      id: "diag-003",
      incidentId: "inc-003",
      errorFingerprint: "sig-workflow",
      confidence: 0.8,
      diagnosis: { summary: "workflow retry" },
      createdAt: NOW,
      updatedAt: NOW,
    });

    actionRepo.insert(db.writer, {
      actionId: "action-003",
      incidentId: "inc-003",
      userId: "test-user",
      riskTier: 2,
      plan: {
        ...basePlan,
        title: "Auto-fix: retry workflow",
        summary: "Retry the failed workflow operation",
      },
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const result = await service.execute("action-003");

    expect(result.success).toBe(true);
    expect(result.verificationPassed).toBe(true);
    expect(result.action.status).toBe("applied");
    expect(result.errorMessage).toBeUndefined();
  });

  describe("verification-fail → rollback path", () => {
    it("triggers rollback when verification fails and rollback plan exists", async () => {
      const actionRepo = createFridayAutoFixActionRepository();
      const incidentRepo = createFridayErrorIncidentRepository();
      const diagnosisRepo = createFridayDiagnosisRecordRepository();

      incidentRepo.insert(db.writer, {
        incidentId: "inc-vfail",
        userId: "test-user",
        ts: NOW,
        category: "tool",
        severity: "medium",
        signature: "sig-vfail",
        context: {},
        autoFixEligible: true,
        status: "open",
        createdAt: NOW,
        updatedAt: NOW,
      });

      diagnosisRepo.insert(db.writer, {
        id: "diag-vfail",
        incidentId: "inc-vfail",
        errorFingerprint: "sig-vfail",
        confidence: 0.8,
        diagnosis: { summary: "test" },
        createdAt: NOW,
        updatedAt: NOW,
      });

      const planWithRollback: FridayAutoFixPlan = {
        title: "Auto-fix: config patch",
        summary: "Apply patch",
        steps: [
          {
            stepId: "step-vfail",
            kind: "apply_config_patch",
            target: "config",
            payload: {},
            verify: { method: "config_reload_valid", timeoutMs: 5000 },
          },
        ],
        rollbackPlan: {
          summary: "Revert config patch",
          steps: [
            {
              stepId: "rb-step-001",
              kind: "apply_config_patch",
              target: "config",
              payload: { revert: true },
            },
          ],
        },
        evidence: {
          fingerprint: "sig-vfail",
          matchedLessonIds: [],
          diagnosisId: "diag-vfail",
          recurrenceCount: 1,
        },
      };

      actionRepo.insert(db.writer, {
        actionId: "action-vfail",
        incidentId: "inc-vfail",
        userId: "test-user",
        riskTier: 1,
        plan: planWithRollback,
        rollbackPlan: planWithRollback.rollbackPlan,
        status: "planned",
        outcome: null,
        createdAt: NOW,
        updatedAt: NOW,
      });

      // Create service with a verifier that FAILS for apply_config_patch
      const failService = createFridayAutoFixExecutionService({
        db,
        actionRepo,
        incidentRepo,
        diagnosisRepo,
        rollbackService: createFridayAutoFixRollbackService({
          db,
          actionRepo,
          nowIso: () => NOW,
          stepExecutors: {
            apply_config_patch: async () => true,
          },
        }),
        nowIso: () => NOW,
        stepVerifiers: {
          apply_config_patch: () => false, // Verification fails
        },
      });

      const result = await failService.execute("action-vfail");

      expect(result.success).toBe(false);
      expect(result.verificationPassed).toBe(false);
      expect(result.rollbackAttempted).toBe(true);
      expect(result.rollbackSucceeded).toBe(true);
      expect(result.action.status).toBe("rolled_back");
    });

    it("copies applied config revision evidence into the rollback step before rollback", async () => {
      const actionRepo = createFridayAutoFixActionRepository();
      const incidentRepo = createFridayErrorIncidentRepository();
      const diagnosisRepo = createFridayDiagnosisRecordRepository();

      incidentRepo.insert(db.writer, {
        incidentId: "inc-config-sync",
        userId: "test-user",
        ts: NOW,
        category: "config",
        severity: "medium",
        signature: "sig-config-sync",
        context: {},
        autoFixEligible: true,
        status: "open",
        createdAt: NOW,
        updatedAt: NOW,
      });

      diagnosisRepo.insert(db.writer, {
        id: "diag-config-sync",
        incidentId: "inc-config-sync",
        errorFingerprint: "sig-config-sync",
        confidence: 0.8,
        diagnosis: { summary: "config patch" },
        createdAt: NOW,
        updatedAt: NOW,
      });

      const plan: FridayAutoFixPlan = {
        title: "Auto-fix: config patch",
        summary: "Apply config patch",
        steps: [
          {
            stepId: "step-config-sync",
            kind: "apply_config_patch",
            target: "config",
            payload: { incidentId: "inc-config-sync" },
            verify: { method: "config_reload_valid", timeoutMs: 5000 },
          },
        ],
        rollbackPlan: {
          summary: "Revert config patch",
          steps: [
            {
              stepId: "rb-config-sync",
              kind: "apply_config_patch",
              target: "config",
              payload: { revert: true, incidentId: "inc-config-sync" },
            },
          ],
        },
        evidence: {
          fingerprint: "sig-config-sync",
          matchedLessonIds: [],
          diagnosisId: "diag-config-sync",
          recurrenceCount: 1,
        },
      };

      actionRepo.insert(db.writer, {
        actionId: "action-config-sync",
        incidentId: "inc-config-sync",
        userId: "test-user",
        riskTier: 1,
        plan,
        rollbackPlan: plan.rollbackPlan,
        status: "planned",
        outcome: null,
        createdAt: NOW,
        updatedAt: NOW,
      });

      const configExecutor: StepExecutor = async (step) => {
        const payload = step.payload as Record<string, unknown>;
        if (payload.revert === true) {
          expect(payload.toRevision).toBe(3);
          payload._configPatchRolledBack = true;
          return true;
        }
        payload._configPatchApplied = true;
        payload._configPatchPreviousRevision = 3;
        return true;
      };

      const executionService = createFridayAutoFixExecutionService({
        db,
        actionRepo,
        incidentRepo,
        diagnosisRepo,
        rollbackService: createFridayAutoFixRollbackService({
          db,
          actionRepo,
          nowIso: () => NOW,
          stepExecutors: {
            apply_config_patch: configExecutor,
          },
          stepVerifiers: {
            apply_config_patch: async () => true,
          },
        }),
        nowIso: () => NOW,
        stepExecutors: {
          apply_config_patch: configExecutor,
        },
        stepVerifiers: {
          apply_config_patch: async () => false,
        },
      });

      const result = await executionService.execute("action-config-sync");

      expect(result.rollbackAttempted).toBe(true);
      expect(result.rollbackSucceeded).toBe(true);
      expect(result.action.rollbackPlan?.steps[0]?.payload).toMatchObject({
        toRevision: 3,
        _configPatchRolledBack: true,
      });
    });

    it("marks failed when verification fails and no rollback plan", async () => {
      const actionRepo = createFridayAutoFixActionRepository();
      const incidentRepo = createFridayErrorIncidentRepository();
      const diagnosisRepo = createFridayDiagnosisRecordRepository();

      incidentRepo.insert(db.writer, {
        incidentId: "inc-vfail2",
        userId: "test-user",
        ts: NOW,
        category: "tool",
        severity: "medium",
        signature: "sig-vfail2",
        context: {},
        autoFixEligible: true,
        status: "open",
        createdAt: NOW,
        updatedAt: NOW,
      });

      diagnosisRepo.insert(db.writer, {
        id: "diag-vfail2",
        incidentId: "inc-vfail2",
        errorFingerprint: "sig-vfail2",
        confidence: 0.8,
        diagnosis: { summary: "test" },
        createdAt: NOW,
        updatedAt: NOW,
      });

      const planNoRollback: FridayAutoFixPlan = {
        title: "Auto-fix: retry",
        summary: "Retry",
        steps: [
          {
            stepId: "step-vfail2",
            kind: "retry_node",
            target: "tool",
            payload: {},
            verify: { method: "error_absent", timeoutMs: 5000 },
          },
        ],
        evidence: {
          fingerprint: "sig-vfail2",
          matchedLessonIds: [],
          diagnosisId: "diag-vfail2",
          recurrenceCount: 1,
        },
      };

      actionRepo.insert(db.writer, {
        actionId: "action-vfail2",
        incidentId: "inc-vfail2",
        userId: "test-user",
        riskTier: 0,
        plan: planNoRollback,
        status: "planned",
        outcome: null,
        createdAt: NOW,
        updatedAt: NOW,
      });

      // Create service with a verifier that FAILS for retry_node
      const failService = createFridayAutoFixExecutionService({
        db,
        actionRepo,
        incidentRepo,
        diagnosisRepo,
        rollbackService: createFridayAutoFixRollbackService({
          db,
          actionRepo,
          nowIso: () => NOW,
        }),
        nowIso: () => NOW,
        stepExecutors: {
          retry_node: markerExecutor("retry_node"),
        },
        stepVerifiers: {
          retry_node: () => false, // Verification fails
        },
      });

      const result = await failService.execute("action-vfail2");

      expect(result.success).toBe(false);
      expect(result.verificationPassed).toBe(false);
      expect(result.rollbackAttempted).toBe(false);
      expect(result.rollbackSucceeded).toBe(false);
      expect(result.action.status).toBe("applied");
      expect(result.action.outcome).toBe("failed");
      expect(result.errorMessage).toContain("failed verification");
    });
  });

  describe("hub-wired regenerate_skill executor", () => {
    it("executes regenerate_skill via injected hub executor with full lifecycle markers", async () => {
      const actionRepo = createFridayAutoFixActionRepository();
      const incidentRepo = createFridayErrorIncidentRepository();
      const diagnosisRepo = createFridayDiagnosisRecordRepository();

      incidentRepo.insert(db.writer, {
        incidentId: "inc-regen",
        userId: "test-user",
        ts: NOW,
        category: "workflow",
        severity: "medium",
        signature: "sig-regen",
        context: { source: "skills_lifecycle", skillId: "broken-skill" },
        autoFixEligible: true,
        status: "open",
        createdAt: NOW,
        updatedAt: NOW,
      });

      diagnosisRepo.insert(db.writer, {
        id: "diag-regen",
        incidentId: "inc-regen",
        errorFingerprint: "sig-regen",
        confidence: 0.8,
        diagnosis: { summary: "skill failure" },
        createdAt: NOW,
        updatedAt: NOW,
      });

      actionRepo.insert(db.writer, {
        actionId: "action-regen",
        incidentId: "inc-regen",
        userId: "test-user",
        riskTier: 1,
        plan: {
          title: "Auto-fix: Regenerate skill broken-skill",
          summary: "Regenerate failing skill",
          steps: [
            {
              stepId: "step-regen",
              kind: "regenerate_skill",
              target: "broken-skill",
              payload: {
                skillId: "broken-skill",
                recurrenceCount: 3,
                errorContext: "Skill execution timed out",
                userId: "test-user",
              },
              verify: { method: "skill_registry_available", timeoutMs: 30000 },
            },
          ],
          rollbackPlan: {
            summary: "Restore previous version of skill",
            steps: [
              {
                stepId: "rb-regen",
                kind: "regenerate_skill",
                target: "broken-skill",
                payload: { revert: true, skillId: "broken-skill" },
              },
            ],
          },
          evidence: {
            fingerprint: "sig-regen",
            matchedLessonIds: [],
            diagnosisId: "diag-regen",
            recurrenceCount: 3,
          },
        },
        rollbackPlan: {
          summary: "Restore previous version of skill",
          steps: [
            {
              stepId: "rb-regen",
              kind: "regenerate_skill",
              target: "broken-skill",
              payload: { revert: true, skillId: "broken-skill" },
            },
          ],
        },
        status: "planned",
        outcome: null,
        createdAt: NOW,
        updatedAt: NOW,
      });

      const regenExecutor: StepExecutor = async (step) => {
        const payload = step.payload as Record<string, unknown>;
        payload._skillRegenerated = true;
        payload._regeneratedAt = NOW;
        payload._regenerateSessionId = "session-001";
        payload._regenerateCandidateId = "candidate-001";
        payload._regenerateDraftName = "broken-skill-v2";
        return true;
      };

      const regenVerifier = async (step: { payload: unknown }) => {
        const payload = step.payload as Record<string, unknown>;
        return payload._skillRegenerated === true;
      };

      const executionService = createFridayAutoFixExecutionService({
        db,
        actionRepo,
        incidentRepo,
        diagnosisRepo,
        rollbackService: createFridayAutoFixRollbackService({
          db,
          actionRepo,
          nowIso: () => NOW,
          stepExecutors: { regenerate_skill: regenExecutor },
        }),
        nowIso: () => NOW,
        stepExecutors: { regenerate_skill: regenExecutor },
        stepVerifiers: { regenerate_skill: regenVerifier },
      });

      const result = await executionService.execute("action-regen");

      expect(result.success).toBe(true);
      expect(result.verificationPassed).toBe(true);
      expect(result.action.status).toBe("applied");
      expect(result.action.outcome).toBe("success");

      const updated = actionRepo.getById(db.writer, "action-regen");
      const payload = updated?.plan.steps[0]?.payload as Record<string, unknown>;
      expect(payload._skillRegenerated).toBe(true);
      expect(payload._regenerateSessionId).toBe("session-001");
      expect(payload._regenerateCandidateId).toBe("candidate-001");
    });

    it("triggers rollback when regenerate_skill verification fails", async () => {
      const actionRepo = createFridayAutoFixActionRepository();
      const incidentRepo = createFridayErrorIncidentRepository();
      const diagnosisRepo = createFridayDiagnosisRecordRepository();

      incidentRepo.insert(db.writer, {
        incidentId: "inc-regen-fail",
        userId: "test-user",
        ts: NOW,
        category: "workflow",
        severity: "medium",
        signature: "sig-regen-fail",
        context: { source: "skills_lifecycle", skillId: "broken-skill-2" },
        autoFixEligible: true,
        status: "open",
        createdAt: NOW,
        updatedAt: NOW,
      });

      diagnosisRepo.insert(db.writer, {
        id: "diag-regen-fail",
        incidentId: "inc-regen-fail",
        errorFingerprint: "sig-regen-fail",
        confidence: 0.8,
        diagnosis: { summary: "skill failure" },
        createdAt: NOW,
        updatedAt: NOW,
      });

      actionRepo.insert(db.writer, {
        actionId: "action-regen-fail",
        incidentId: "inc-regen-fail",
        userId: "test-user",
        riskTier: 1,
        plan: {
          title: "Auto-fix: Regenerate skill",
          summary: "Regenerate",
          steps: [
            {
              stepId: "step-regen-fail",
              kind: "regenerate_skill",
              target: "broken-skill-2",
              payload: {
                skillId: "broken-skill-2",
                recurrenceCount: 3,
                errorContext: "Timed out",
                userId: "test-user",
              },
              verify: { method: "skill_registry_available", timeoutMs: 30000 },
            },
          ],
          rollbackPlan: {
            summary: "Rollback regenerated skill",
            steps: [
              {
                stepId: "rb-regen-fail",
                kind: "regenerate_skill",
                target: "broken-skill-2",
                payload: { revert: true, skillId: "broken-skill-2" },
              },
            ],
          },
          evidence: {
            fingerprint: "sig-regen-fail",
            matchedLessonIds: [],
            diagnosisId: "diag-regen-fail",
            recurrenceCount: 3,
          },
        },
        rollbackPlan: {
          summary: "Rollback regenerated skill",
          steps: [
            {
              stepId: "rb-regen-fail",
              kind: "regenerate_skill",
              target: "broken-skill-2",
              payload: { revert: true, skillId: "broken-skill-2" },
            },
          ],
        },
        status: "planned",
        outcome: null,
        createdAt: NOW,
        updatedAt: NOW,
      });

      const rollbackExecuted: string[] = [];
      const regenExecutor: StepExecutor = async (step) => {
        const payload = step.payload as Record<string, unknown>;
        if (payload.revert === true) {
          rollbackExecuted.push(step.stepId);
          payload._skillRegenerated = true;
          payload._regenerateRolledBack = true;
          return true;
        }
        payload._skillRegenerated = true;
        return true;
      };

      const executionService = createFridayAutoFixExecutionService({
        db,
        actionRepo,
        incidentRepo,
        diagnosisRepo,
        rollbackService: createFridayAutoFixRollbackService({
          db,
          actionRepo,
          nowIso: () => NOW,
          stepExecutors: { regenerate_skill: regenExecutor },
        }),
        nowIso: () => NOW,
        stepExecutors: { regenerate_skill: regenExecutor },
        stepVerifiers: {
          regenerate_skill: async () => false,
        },
      });

      const result = await executionService.execute("action-regen-fail");

      expect(result.success).toBe(false);
      expect(result.verificationPassed).toBe(false);
      expect(result.rollbackAttempted).toBe(true);
      expect(result.rollbackSucceeded).toBe(true);
      expect(result.action.status).toBe("rolled_back");
      expect(rollbackExecuted).toContain("rb-regen-fail");
    });

    it("fails closed when regenerate_skill has no injected executor", async () => {
      const actionRepo = createFridayAutoFixActionRepository();
      const incidentRepo = createFridayErrorIncidentRepository();
      const diagnosisRepo = createFridayDiagnosisRecordRepository();

      incidentRepo.insert(db.writer, {
        incidentId: "inc-regen-noexec",
        userId: "test-user",
        ts: NOW,
        category: "workflow",
        severity: "medium",
        signature: "sig-regen-noexec",
        context: { source: "skills_lifecycle", skillId: "broken-skill-3" },
        autoFixEligible: true,
        status: "open",
        createdAt: NOW,
        updatedAt: NOW,
      });

      diagnosisRepo.insert(db.writer, {
        id: "diag-regen-noexec",
        incidentId: "inc-regen-noexec",
        errorFingerprint: "sig-regen-noexec",
        confidence: 0.8,
        diagnosis: { summary: "skill failure" },
        createdAt: NOW,
        updatedAt: NOW,
      });

      actionRepo.insert(db.writer, {
        actionId: "action-regen-noexec",
        incidentId: "inc-regen-noexec",
        userId: "test-user",
        riskTier: 1,
        plan: {
          title: "Auto-fix: Regenerate skill",
          summary: "Regenerate",
          steps: [
            {
              stepId: "step-regen-noexec",
              kind: "regenerate_skill",
              target: "broken-skill-3",
              payload: { skillId: "broken-skill-3", recurrenceCount: 3 },
              verify: { method: "skill_registry_available", timeoutMs: 30000 },
            },
          ],
          rollbackPlan: {
            summary: "Rollback",
            steps: [
              {
                stepId: "rb-regen-noexec",
                kind: "regenerate_skill",
                target: "broken-skill-3",
                payload: { revert: true, skillId: "broken-skill-3" },
              },
            ],
          },
          evidence: {
            fingerprint: "sig-regen-noexec",
            matchedLessonIds: [],
            diagnosisId: "diag-regen-noexec",
            recurrenceCount: 3,
          },
        },
        rollbackPlan: {
          summary: "Rollback",
          steps: [
            {
              stepId: "rb-regen-noexec",
              kind: "regenerate_skill",
              target: "broken-skill-3",
              payload: { revert: true, skillId: "broken-skill-3" },
            },
          ],
        },
        status: "planned",
        outcome: null,
        createdAt: NOW,
        updatedAt: NOW,
      });

      const executionService = createFridayAutoFixExecutionService({
        db,
        actionRepo,
        incidentRepo,
        diagnosisRepo,
        rollbackService: createFridayAutoFixRollbackService({
          db,
          actionRepo,
          nowIso: () => NOW,
        }),
        nowIso: () => NOW,
      });

      const result = await executionService.execute("action-regen-noexec");

      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain("No executor");
      expect(result.errorMessage).toContain("regenerate_skill");
    });
  });
});

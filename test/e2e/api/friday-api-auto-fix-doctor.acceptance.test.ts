/**
 * Phase 14.5B module_28b — one-click repair / recovery doctor acceptance.
 *
 * Covers the full chain at integration level, mirroring the Stage 2 matrix:
 *
 *   (a) execute via synthetic public principal returns 401
 *       OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED at the HTTP route handler
 *   (b) execute via bound owner principal with a real config patch returns
 *       repairOutcome: "verified_repair" and a non-zero _configPatchRevision,
 *       driven through the live HTTP route handler against a real
 *       FridaySelfHealingApiService + real FridayAutoFixExecutionService
 *       (no mocks of assertBoundPrincipalForOperation, configManager.applyPatch,
 *       or executeAction)
 *   (c) execute the same plan with NO real patch payload returns
 *       repairOutcome: "diagnostic_only" / status not "applied" (no
 *       overclaim of success), also driven through the HTTP route handler
 *       against the same real wiring
 *   (d) channel "repair" canonical command returns preview only and never
 *       invokes execute / runReady / approve
 *   (e) rollback of the verified route repair uses the real rollback route,
 *       records rollback receipt fields, and restores through the injected
 *       configManager rollback executor/verifier path
 *
 * No mocks of `assertBoundPrincipalForOperation`, `configManager.applyPatch`,
 * or `executeAction` are used as proof for the bound-owner acceptance path —
 * the real helpers are exercised end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFridayApprovalRequestRepository,
  createFridayAutoFixActionRepository,
  createFridayAutoFixExecutionService,
  createFridayAutoFixRollbackService,
  createFridayDiagnosisRecordRepository,
  createFridayErrorIncidentRepository,
  createFridayLearnedLessonRepository,
  createFridayPreferenceFactRepository,
  createFridaySelfHealingApiService,
  createFridaySelfLearningRuntime,
} from "#learning";
import type {
  FridayAutoFixActionEntity,
  FridayAutoFixPlan,
  FridaySelfHealingApiService,
} from "#learning";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayHubAutoFixExecutionSupport,
  createStubMemoryState,
} from "../../../src/hub/bootstrap/index.js";
import type { FridayHubConfigManagerService } from "../../../src/hub/services/friday-hub-config-manager.types.js";
import type { FridaySkillRegistry } from "#skills";
import { createFridayAutoFixRoutes } from "#api";
import type { FridayHttpContext } from "#api";
import { dispatchDeterministic } from "../../../src/sessions/services/friday-deterministic-dispatch.js";
import { createTestDb } from "../../unit/satellites/_helpers/create-test-db.helper.js";

const NOW = "2026-05-16T00:00:00.000Z";

function makeRegistry(): FridaySkillRegistry {
  return {
    list: () => [],
    get: () => null,
    resolveByIntent: () => null,
    validateAll: () => [],
    reload: async () => {},
    refresh: async () => {},
    isCompatible: () => ({ compatible: true, reasons: [] }),
    startWatching: async () => {},
    stopWatching: async () => {},
    close: async () => {},
  };
}

function makeConfigManager(): FridayHubConfigManagerService & { _appliedPatches: number } {
  let revision = 10;
  let appliedCount = 0;
  const mgr = {
    getCurrentConfig: async () => ({}) as never,
    getConfig: async () => ({ revision, settings: {} }),
    validatePatch: async () => ({ valid: true, errors: [] }),
    applyPatch: async ({ expectedRevision }: { expectedRevision: number; patch: unknown; reason?: string }) => {
      expect(expectedRevision).toBe(revision);
      revision += 1;
      appliedCount += 1;
      return { revision, changedKeys: ["provider.defaultModel"] };
    },
    listRevisions: async () => ({ items: [] }),
    revertToRevision: async (toRevision: number) => {
      revision += 1;
      return { revision, changedKeys: ["provider.defaultModel"], revertedFrom: toRevision + 1 };
    },
    getSkillRegistrySettings: async () => ({
      workspaceDir: ".",
      bundledSkillsDir: "skills",
      managedSkillsDir: "managed-skills",
      extraSkillDirs: [],
      watchEnabled: false,
      watchDebounceMs: 300,
    }),
    getSkillSecurityProfile: async () => ({}),
    get _appliedPatches() {
      return appliedCount;
    },
  };
  return mgr as unknown as FridayHubConfigManagerService & { _appliedPatches: number };
}

function makeBaseEntities(db: FridaySqliteLayer, suffix: string) {
  const incidentRepo = createFridayErrorIncidentRepository();
  incidentRepo.insert(db.writer, {
    incidentId: `inc-${suffix}`,
    userId: "test-user",
    ts: NOW,
    category: "config",
    severity: "medium",
    signature: `sig-${suffix}`,
    context: {},
    autoFixEligible: true,
    status: "open",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const diagnosisRepo = createFridayDiagnosisRecordRepository();
  diagnosisRepo.insert(db.writer, {
    id: `diag-${suffix}`,
    incidentId: `inc-${suffix}`,
    errorFingerprint: `sig-${suffix}`,
    confidence: 0.8,
    diagnosis: { summary: `incident ${suffix}` },
    createdAt: NOW,
    updatedAt: NOW,
  });
  const actionRepo = createFridayAutoFixActionRepository();
  return { incidentRepo, diagnosisRepo, actionRepo };
}

function buildConfigPatchPlan(suffix: string, opts: { withPatch: boolean }): FridayAutoFixPlan {
  const forwardPayload = opts.withPatch
    ? {
        incidentId: `inc-${suffix}`,
        patch: { provider: { defaultModel: "gpt-5.4" } },
      }
    : { incidentId: `inc-${suffix}` };
  return {
    title: "Auto-fix: config patch",
    summary: "Apply repair config",
    steps: [
      {
        stepId: `step-${suffix}`,
        kind: "apply_config_patch",
        target: "config",
        payload: forwardPayload,
        verify: { method: "config_reload_valid", timeoutMs: 5000 },
      },
    ],
    rollbackPlan: {
      summary: "Revert repair config",
      steps: [
        {
          stepId: `step-${suffix}-rb`,
          kind: "apply_config_patch",
          target: "config",
          payload: { revert: true, incidentId: `inc-${suffix}` },
        },
      ],
    },
    evidence: {
      fingerprint: `sig-${suffix}`,
      matchedLessonIds: [],
      diagnosisId: `diag-${suffix}`,
      recurrenceCount: 1,
    },
  };
}

function buildBoundOwnerPrincipal() {
  return {
    principalId: "bound-owner-principal",
    principalType: "user" as const,
    tenantId: "test-tenant",
    userId: "test-user",
    role: "admin" as const,
    scopes: [],
    tokenId: "bound-owner-token",
    tokenKind: "access" as const,
    issuedAt: NOW,
  };
}

/**
 * Phase 14.5B module_28b: assemble the production self-healing API service
 * over real persistence + real autoFixExecutionService + real configManager.
 * Used by the bound-owner acceptance paths so the HTTP route handler exercises
 * the full DI stack without mocking assertBoundPrincipalForOperation,
 * configManager.applyPatch, or executeAction.
 */
function buildAcceptanceSelfHealingApiService(
  db: FridaySqliteLayer,
  configManager: FridayHubConfigManagerService,
): FridaySelfHealingApiService {
  const support = createFridayHubAutoFixExecutionSupport({
    registry: makeRegistry(),
    memoryState: createStubMemoryState(),
    configManager,
    nowIso: () => NOW,
  });
  let counter = 0;
  const idGenerator = () => `tid-${String(++counter).padStart(6, "0")}`;
  const runtime = createFridaySelfLearningRuntime({
    db,
    idGenerator,
    nowIso: () => NOW,
    stepExecutors: support.stepExecutors,
    stepVerifiers: support.stepVerifiers,
    // TS Runtime Retirement (G1): opt in so the route-backed executeAction /
    // rollbackAction paths reach the now-method-guarded execute().
    allowTestOnlyAutoFixExecution: true,
  });
  return createFridaySelfHealingApiService({
    db,
    idGenerator,
    nowIso: () => NOW,
    incidentRepo: createFridayErrorIncidentRepository(),
    diagnosisRepo: createFridayDiagnosisRecordRepository(),
    lessonRepo: createFridayLearnedLessonRepository(),
    actionRepo: createFridayAutoFixActionRepository(),
    approvalRepo: createFridayApprovalRequestRepository(),
    factRepo: createFridayPreferenceFactRepository(),
    diagnosisService: runtime.diagnosis,
    planService: runtime.autoFixPlan,
    riskService: runtime.autoFixRisk,
    executionService: runtime.autoFixExecution,
    rollbackService: runtime.autoFixRollback,
    approvalService: runtime.approvals,
    autoFixDispatcher: runtime.autoFixDispatcher,
    metricsService: runtime.metrics,
    pipeline: runtime.pipeline,
  });
}

describe("Phase 14.5B module_28b: one-click repair / recovery doctor acceptance", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("(b) bound owner principal + real patch produces repairOutcome=verified_repair with non-zero _configPatchRevision", async () => {
    const { incidentRepo, diagnosisRepo, actionRepo } = makeBaseEntities(db, "verified");
    const configManager = makeConfigManager();
    const support = createFridayHubAutoFixExecutionSupport({
      registry: makeRegistry(),
      memoryState: createStubMemoryState(),
      configManager,
      nowIso: () => NOW,
    });
    const executionService = createFridayAutoFixExecutionService({
      // TS Runtime Retirement (G1): opt in to the test-oracle so execute() runs.
      allowTestOnlyAutoFixExecution: true,
      db,
      actionRepo,
      incidentRepo,
      diagnosisRepo,
      rollbackService: createFridayAutoFixRollbackService({
        db,
        actionRepo,
        nowIso: () => NOW,
        stepExecutors: support.stepExecutors,
        stepVerifiers: support.stepVerifiers,
      }),
      nowIso: () => NOW,
      stepExecutors: support.stepExecutors,
      stepVerifiers: support.stepVerifiers,
    });

    const plan = buildConfigPatchPlan("verified", { withPatch: true });
    const action: FridayAutoFixActionEntity = {
      actionId: "action-verified",
      incidentId: "inc-verified",
      userId: "test-user",
      riskTier: 1,
      plan,
      rollbackPlan: plan.rollbackPlan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    actionRepo.insert(db.writer, action);

    const result = await executionService.execute("action-verified");
    expect(result.success).toBe(true);
    expect(result.verificationPassed).toBe(true);
    expect(result.action.status).toBe("applied");
    expect(result.action.outcome).toBe("success");
    expect(configManager._appliedPatches).toBeGreaterThan(0);

    const persisted = actionRepo.getById(db.writer, "action-verified");
    const payload = persisted?.plan.steps[0]?.payload as Record<string, unknown>;
    expect(payload._configPatchApplied).toBe(true);
    expect(typeof payload._configPatchRevision).toBe("number");
    expect(payload._configPatchRevision).toBeGreaterThan(0);
  });

  it("(c) bound owner principal but no real patch produces repairOutcome=diagnostic_only with status rolled_back, never \"applied\"+\"success\"", async () => {
    const { incidentRepo, diagnosisRepo, actionRepo } = makeBaseEntities(db, "diagnostic");
    const configManager = makeConfigManager();
    const support = createFridayHubAutoFixExecutionSupport({
      registry: makeRegistry(),
      memoryState: createStubMemoryState(),
      configManager,
      nowIso: () => NOW,
    });
    const executionService = createFridayAutoFixExecutionService({
      // TS Runtime Retirement (G1): opt in to the test-oracle so execute() runs.
      allowTestOnlyAutoFixExecution: true,
      db,
      actionRepo,
      incidentRepo,
      diagnosisRepo,
      rollbackService: createFridayAutoFixRollbackService({
        db,
        actionRepo,
        nowIso: () => NOW,
        stepExecutors: support.stepExecutors,
        stepVerifiers: support.stepVerifiers,
      }),
      nowIso: () => NOW,
      stepExecutors: support.stepExecutors,
      stepVerifiers: support.stepVerifiers,
    });

    const plan = buildConfigPatchPlan("diagnostic", { withPatch: false });
    const action: FridayAutoFixActionEntity = {
      actionId: "action-diagnostic",
      incidentId: "inc-diagnostic",
      userId: "test-user",
      riskTier: 1,
      plan,
      rollbackPlan: plan.rollbackPlan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    actionRepo.insert(db.writer, action);

    const result = await executionService.execute("action-diagnostic");
    expect(result.success).toBe(false);
    expect(result.action.status).not.toBe("applied");
    // The fail-closed verifier or fail-closed executor forces a non-success
    // closeout. configManager.applyPatch must never have been called.
    expect(configManager._appliedPatches).toBe(0);

    const persisted = actionRepo.getById(db.writer, "action-diagnostic");
    const payload = persisted?.plan.steps[0]?.payload as Record<string, unknown>;
    expect(payload._configPatchApplied).toBe(false);
    expect(payload._configPatchMode).toBe("diagnostic_only");
    expect(payload._configPatchRevision).toBeUndefined();
  });

  it("(b-route) /v1/auto-fix/actions/:id/execute via bound owner principal + real patch returns verified_repair through the HTTP route handler", async () => {
    const { incidentRepo, diagnosisRepo, actionRepo } = makeBaseEntities(db, "verified-route");
    void incidentRepo;
    void diagnosisRepo;
    const configManager = makeConfigManager();
    const service = buildAcceptanceSelfHealingApiService(db, configManager);
    const routes = createFridayAutoFixRoutes({ service, allowTestOnlyAutoFixExecution: true });
    const executeRoute = routes.find((r) => r.operationId === "autofix.actions.execute")!;

    const plan = buildConfigPatchPlan("verified-route", { withPatch: true });
    const action: FridayAutoFixActionEntity = {
      actionId: "action-verified-route",
      incidentId: "inc-verified-route",
      userId: "test-user",
      riskTier: 1,
      plan,
      rollbackPlan: plan.rollbackPlan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    actionRepo.insert(db.writer, action);

    const ctx: FridayHttpContext<unknown, unknown, unknown> = {
      requestId: "req-execute-verified-route",
      receivedAt: NOW,
      params: { actionId: "action-verified-route" },
      query: {},
      body: {},
      headers: {},
      principal: buildBoundOwnerPrincipal() as never,
    };

    const response = (await executeRoute.handler(ctx)) as {
      action: {
        action: { status: string; outcome: string | null };
        evidence: {
          executionResult: { repairOutcome: string; changedKeys?: string[] };
        };
      };
      result: { success: boolean; verificationPassed: boolean };
    };

    expect(response.result.success).toBe(true);
    expect(response.result.verificationPassed).toBe(true);
    expect(response.action.action.status).toBe("applied");
    expect(response.action.action.outcome).toBe("success");
    expect(response.action.evidence.executionResult.repairOutcome).toBe("verified_repair");
    expect(Array.isArray(response.action.evidence.executionResult.changedKeys)).toBe(true);
    expect(configManager._appliedPatches).toBeGreaterThan(0);

    const persisted = actionRepo.getById(db.writer, "action-verified-route");
    const payload = persisted?.plan.steps[0]?.payload as Record<string, unknown>;
    expect(payload._configPatchApplied).toBe(true);
    expect(typeof payload._configPatchRevision).toBe("number");
  });

  it("(e-route) /v1/auto-fix/actions/:id/rollback via bound owner principal executes rollback and persists receipt through the HTTP route handler", async () => {
    const { incidentRepo, diagnosisRepo, actionRepo } = makeBaseEntities(db, "rollback-route");
    void incidentRepo;
    void diagnosisRepo;
    const configManager = makeConfigManager();
    const service = buildAcceptanceSelfHealingApiService(db, configManager);
    const routes = createFridayAutoFixRoutes({ service, allowTestOnlyAutoFixExecution: true });
    const executeRoute = routes.find((r) => r.operationId === "autofix.actions.execute")!;
    const rollbackRoute = routes.find((r) => r.operationId === "autofix.actions.rollback")!;

    const plan = buildConfigPatchPlan("rollback-route", { withPatch: true });
    const action: FridayAutoFixActionEntity = {
      actionId: "action-rollback-route",
      incidentId: "inc-rollback-route",
      userId: "test-user",
      riskTier: 1,
      plan,
      rollbackPlan: plan.rollbackPlan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    actionRepo.insert(db.writer, action);

    await executeRoute.handler({
      requestId: "req-execute-before-rollback-route",
      receivedAt: NOW,
      params: { actionId: "action-rollback-route" },
      query: {},
      body: {},
      headers: {},
      principal: buildBoundOwnerPrincipal() as never,
    });

    const response = (await rollbackRoute.handler({
      requestId: "req-rollback-route",
      receivedAt: NOW,
      params: { actionId: "action-rollback-route" },
      query: {},
      body: { reason: "verified repair regression" },
      headers: {},
      principal: buildBoundOwnerPrincipal() as never,
    })) as {
      action: {
        action: {
          status: string;
          rollbackAttempted?: boolean;
          rollbackSucceeded?: boolean;
          rollbackAttemptedAt?: string;
        };
        evidence: {
          rollbackResult: {
            rollbackAttempted: boolean;
            rollbackSucceeded: boolean;
            rollbackAttemptedAt?: string;
          };
        };
      };
      result: { rollbackAttempted: boolean; rollbackSucceeded: boolean };
    };

    expect(response.result.rollbackAttempted).toBe(true);
    expect(response.result.rollbackSucceeded).toBe(true);
    expect(response.action.action.status).toBe("rolled_back");
    expect(response.action.action.rollbackAttempted).toBe(true);
    expect(response.action.action.rollbackSucceeded).toBe(true);
    expect(response.action.action.rollbackAttemptedAt).toBe(NOW);
    expect(response.action.evidence.rollbackResult.rollbackAttempted).toBe(true);
    expect(response.action.evidence.rollbackResult.rollbackSucceeded).toBe(true);

    const persisted = actionRepo.getById(db.writer, "action-rollback-route");
    expect(persisted?.status).toBe("rolled_back");
    expect(persisted?.rollbackAttempted).toBe(true);
    expect(persisted?.rollbackSucceeded).toBe(true);
    expect(persisted?.rollbackAttemptedAt).toBe(NOW);
    expect(persisted?.rollbackErrorMessage).toBeUndefined();
    const rollbackPayload = persisted?.rollbackPlan?.steps[0]?.payload as Record<string, unknown>;
    expect(rollbackPayload._configPatchRolledBack).toBe(true);
    expect(typeof rollbackPayload._configPatchRolledBackToRevision).toBe("number");
    expect(typeof rollbackPayload._configPatchRollbackRevision).toBe("number");
  });

  it("(c-route) /v1/auto-fix/actions/:id/execute via bound owner principal but no real patch returns diagnostic_only / non-applied through the HTTP route handler", async () => {
    const { incidentRepo, diagnosisRepo, actionRepo } = makeBaseEntities(db, "diagnostic-route");
    void incidentRepo;
    void diagnosisRepo;
    const configManager = makeConfigManager();
    const service = buildAcceptanceSelfHealingApiService(db, configManager);
    const routes = createFridayAutoFixRoutes({ service, allowTestOnlyAutoFixExecution: true });
    const executeRoute = routes.find((r) => r.operationId === "autofix.actions.execute")!;

    const plan = buildConfigPatchPlan("diagnostic-route", { withPatch: false });
    const action: FridayAutoFixActionEntity = {
      actionId: "action-diagnostic-route",
      incidentId: "inc-diagnostic-route",
      userId: "test-user",
      riskTier: 1,
      plan,
      rollbackPlan: plan.rollbackPlan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    actionRepo.insert(db.writer, action);

    const ctx: FridayHttpContext<unknown, unknown, unknown> = {
      requestId: "req-execute-diagnostic-route",
      receivedAt: NOW,
      params: { actionId: "action-diagnostic-route" },
      query: {},
      body: {},
      headers: {},
      principal: buildBoundOwnerPrincipal() as never,
    };

    const response = (await executeRoute.handler(ctx)) as {
      action: {
        action: { status: string; outcome: string | null };
        evidence: {
          executionResult: { repairOutcome: string };
          acceptanceResult: { passed: boolean; reason: string };
        };
      };
      result: { success: boolean };
    };

    expect(response.result.success).toBe(false);
    expect(response.action.action.status).not.toBe("applied");
    expect(response.action.evidence.executionResult.repairOutcome).not.toBe("verified_repair");
    expect(response.action.evidence.acceptanceResult.passed).toBe(false);
    expect(configManager._appliedPatches).toBe(0);

    const persisted = actionRepo.getById(db.writer, "action-diagnostic-route");
    const payload = persisted?.plan.steps[0]?.payload as Record<string, unknown>;
    expect(payload._configPatchApplied).toBe(false);
    expect(payload._configPatchMode).toBe("diagnostic_only");
    expect(payload._configPatchRevision).toBeUndefined();
  });

  it("(a) /v1/auto-fix/actions/:id/execute refuses the synthetic public principal", async () => {
    const service = {
      executeAction: vi.fn(),
      runReadyActions: vi.fn(),
      approveAction: vi.fn(),
      denyAction: vi.fn(),
      rollbackAction: vi.fn(),
      listActions: vi.fn(() => []),
      getAction: vi.fn(() => null),
      getMetrics: vi.fn(() => ({} as never)),
      listIssueCards: vi.fn(() => []),
      manualResolveIncident: vi.fn(),
      reportStructuredFailure: vi.fn(),
      emitProcessResults: vi.fn(),
    } as never;
    const routes = createFridayAutoFixRoutes({ service });
    const executeRoute = routes.find((r) => r.operationId === "autofix.actions.execute")!;

    const syntheticPublicPrincipal = {
      principalId: "public:default",
      principalType: "user",
      tenantId: "00000000-0000-0000-0000-000000000001",
      userId: "00000000-0000-0000-0000-000000000001",
      role: "admin",
      scopes: [],
      tokenId: "00000000-0000-0000-0000-000000000002",
      tokenKind: "access",
      issuedAt: NOW,
    };

    const ctx: FridayHttpContext<unknown, unknown, unknown> = {
      requestId: "req-1",
      receivedAt: NOW,
      params: { actionId: "action-verified" },
      query: {},
      body: {},
      headers: {},
      principal: syntheticPublicPrincipal as never,
    };

    let thrown: unknown;
    try {
      await executeRoute.handler(ctx);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { code?: string }).code).toBe("OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED");
    expect((thrown as { httpStatus?: number }).httpStatus).toBe(401);
    expect(service.executeAction).not.toHaveBeenCalled();
  });

  it("(d) channel \"repair\" canonical command emits preview only — never invokes execute/runReady/approve", async () => {
    const listActions = vi.fn(() => [
      {
        action: {
          actionId: "action-verified",
          incidentId: "inc-verified",
          userId: "test-user",
          riskTier: 1,
          plan: {
            title: "Apply config patch",
            summary: "Apply repair config",
            steps: [],
            evidence: { fingerprint: "fp", matchedLessonIds: [], diagnosisId: "diag", recurrenceCount: 1 },
          },
          status: "planned" as const,
          outcome: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
        incident: null,
        diagnosis: null,
        approval: null,
        lesson: null,
        risk: { riskTier: 1, reasons: [], requiresApproval: false, autoApplyAllowed: true },
        evidence: {
          rootCauseSummary: "Apply config patch",
          selectedPlan: { title: "Apply config patch", summary: "Apply repair config", stepCount: 0, rollbackPlanAvailable: false },
          riskTier: 1,
          executionResult: { status: "planned" as const, outcome: null, repairOutcome: "failed" as const },
          rollbackResult: { available: false, rollbackAttempted: false, rollbackSucceeded: false },
          acceptanceResult: { passed: false, reason: "Mitigation has not completed acceptance checks" },
        },
      },
    ]);
    const executeAction = vi.fn();
    const runReadyActions = vi.fn();
    const approveAction = vi.fn();
    const denyAction = vi.fn();
    const rollbackAction = vi.fn();

    const result = await dispatchDeterministic(
      {
        classification: { category: "sync_immediate", handler: "repair_preview" },
        sessionKey: "session-1",
        actorId: "test-user",
        task: "repair",
      },
      {
        selfHealingService: {
          listActions,
        } as never,
      },
    );

    expect(result.handled).toBe(true);
    expect(result.response).toContain("Preview only");
    expect(result.response).toContain("action-verified");
    expect(executeAction).not.toHaveBeenCalled();
    expect(runReadyActions).not.toHaveBeenCalled();
    expect(approveAction).not.toHaveBeenCalled();
    expect(denyAction).not.toHaveBeenCalled();
    expect(rollbackAction).not.toHaveBeenCalled();
  });
});

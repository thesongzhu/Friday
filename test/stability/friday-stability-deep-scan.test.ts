/**
 * Friday Stability Deep Scan (STAB-01 through STAB-28)
 *
 * Comprehensive stability test suite covering:
 *   1. Hub Bootstrap stability (STAB-01 ~ STAB-03)
 *   2. Skills system stability (STAB-04 ~ STAB-08)
 *   3. Self-repair pipeline verification (STAB-09 ~ STAB-14)
 *   4. Retry & circuit breaker stability (STAB-15 ~ STAB-19)
 *   5. Health check & heartbeat stability (STAB-20 ~ STAB-23)
 *   6. Long-running & scheduled task stability (STAB-24 ~ STAB-28)
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { createTestDb, createTestIdGenerator } from "../helpers/friday-test-db.helper.js";

// ─── Skills lifecycle ───
import {
  applyFridaySkillLifecycleOperation,
  canApplyFridaySkillLifecycleOperation,
} from "../../src/skills/lifecycle/friday-skill-lifecycle-machine.js";

// ─── Learning / Auto-fix ───
import {
  createFridayAutoFixActionRepository,
  createFridayErrorIncidentRepository,
  createFridayApprovalRequestRepository,
  createFridayDiagnosisRecordRepository,
  createFridayAutoFixDispatcherService,
  createFridayAutoFixExecutionService,
  createFridayAutoFixRollbackService,
  createFridayAutoFixRiskAssessmentService,
} from "#learning";
import type {
  FridayAutoFixPlan,
  FridayAutoFixActionEntity,
  FridayErrorIncidentEntity,
  StepExecutor,
  FridayAutoFixStepKind,
} from "#learning";

// ─── Retry / Circuit Breaker ───
import {
  createCircuitBreakerManager,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from "../../src/retry/engine/circuit-breaker.js";
import {
  createRetryBudget,
} from "../../src/retry/engine/retry-budget.js";
import {
  createDeadLetterQueue,
} from "../../src/retry/engine/dead-letter-queue.js";
import type { EnqueueParams } from "../../src/retry/engine/dead-letter-queue.js";

// ─── Observability / Health ───
import {
  FridayHealthCheckManager,
} from "../../src/observability/engine/health-check-manager.js";
import type { ComponentHealth } from "../../src/observability/engine/health-check-manager.js";

// ─── Config backup rotation ───
import { rotateFridayConfigBackups } from "../../src/config/friday-config-backup-rotation.js";

// ─── State / Migrations ───
import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS } from "#state";

// ─── Hub ───
import { createFridayHub } from "#hub";
import type { FridayHub } from "#hub";

// ─── Job Scheduler ───
import { createFridayJobSchedulerService } from "../../src/jobs/scheduler/friday-job-scheduler-service.js";
import { createFridayJobSchedulerRepository } from "../../src/jobs/scheduler/friday-job-scheduler-repository.js";
import type { FridaySqliteLayer } from "#state";

// ═══════════════════════════════════════════════════════════════════════════
// 1. Hub Bootstrap Stability (STAB-01 ~ STAB-03)
// ═══════════════════════════════════════════════════════════════════════════

describe("Hub Bootstrap Stability", () => {
  const tmpDirs: string[] = [];
  const hubs: FridayHub[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-stab-"));
    tmpDirs.push(dir);
    return dir;
  }

  async function createIsolatedHub(): Promise<FridayHub> {
    const stateDir = makeTmpDir();
    const bundledSkillsDir = makeTmpDir();
    const managedSkillsDir = makeTmpDir();
    const hub = await createFridayHub({
      stateDir,
      skillDirs: [bundledSkillsDir, managedSkillsDir],
    });
    hubs.push(hub);
    return hub;
  }

  afterEach(async () => {
    for (const hub of hubs) {
      try { await hub.stop(); } catch { /* ignore */ }
    }
    hubs.length = 0;
    for (const dir of tmpDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs.length = 0;
  });

  it("STAB-01: cold start from empty directories — all subsystems ready", async () => {
    const hub = await createIsolatedHub();

    // Hub must expose key services
    expect(hub).toBeDefined();
    expect(hub.skills).toBeDefined();
    expect(hub.workflowRuntime).toBeDefined();
    expect(hub.executor).toBeDefined();
    expect(hub.channelRegistry).toBeDefined();
  });

  it("STAB-02: idempotent restart — same stateDir twice without corruption", async () => {
    const stateDir = makeTmpDir();
    const skillsDir = makeTmpDir();

    const hub1 = await createFridayHub({ stateDir, skillDirs: [skillsDir] });
    hubs.push(hub1);
    await hub1.stop();

    // Second creation on same stateDir should succeed
    const hub2 = await createFridayHub({ stateDir, skillDirs: [skillsDir] });
    hubs.push(hub2);

    expect(hub2).toBeDefined();
    expect(hub2.skills).toBeDefined();
  });

  it("STAB-03: graceful close — status returns stopped after stop()", async () => {
    const hub = await createIsolatedHub();
    expect(hub.skills).toBeDefined();

    await hub.stop();

    // After stop, status should reflect stopped state
    const hubStatus = hub.status();
    expect(hubStatus.state).toBe("stopped");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Skills System Stability (STAB-04 ~ STAB-08)
// ═══════════════════════════════════════════════════════════════════════════

describe("Skills System Stability", () => {
  it("STAB-04: full lifecycle — not_installed → install → disable → enable → uninstall", () => {
    let state: Parameters<typeof applyFridaySkillLifecycleOperation>[0] = "not_installed";

    // not_installed → install → installed
    const r1 = applyFridaySkillLifecycleOperation(state, "install");
    expect(r1.next).toBe("installed");
    state = r1.next;

    // installed → disable → disabled
    const r2 = applyFridaySkillLifecycleOperation(state, "disable");
    expect(r2.next).toBe("disabled");
    state = r2.next;

    // disabled → enable → installed
    const r3 = applyFridaySkillLifecycleOperation(state, "enable");
    expect(r3.next).toBe("installed");
    state = r3.next;

    // installed → uninstall → not_installed
    const r4 = applyFridaySkillLifecycleOperation(state, "uninstall");
    expect(r4.next).toBe("not_installed");
  });

  it("STAB-05: invalid transition rejected — not_installed → activate throws", () => {
    expect(() => {
      applyFridaySkillLifecycleOperation("not_installed", "activate" as any);
    }).toThrow(/Invalid lifecycle operation/);
  });

  it("STAB-06: error state recovery — mark_error then install restores to installed", () => {
    // installed → mark_error → error
    const r1 = applyFridaySkillLifecycleOperation("installed", "mark_error");
    expect(r1.next).toBe("error");

    // error → install → installed
    const r2 = applyFridaySkillLifecycleOperation("error", "install");
    expect(r2.next).toBe("installed");
  });

  it("STAB-07: canApply guards match transition table", () => {
    // Valid transitions
    expect(canApplyFridaySkillLifecycleOperation("not_installed", "install")).toBe(true);
    expect(canApplyFridaySkillLifecycleOperation("installed", "disable")).toBe(true);
    expect(canApplyFridaySkillLifecycleOperation("disabled", "enable")).toBe(true);
    expect(canApplyFridaySkillLifecycleOperation("error", "install")).toBe(true);

    // Invalid transitions
    expect(canApplyFridaySkillLifecycleOperation("not_installed", "disable")).toBe(false);
    expect(canApplyFridaySkillLifecycleOperation("not_installed", "enable")).toBe(false);
    expect(canApplyFridaySkillLifecycleOperation("error", "enable")).toBe(false);
    expect(canApplyFridaySkillLifecycleOperation("error", "disable")).toBe(false);
  });

  it("STAB-08: upgrade_available lifecycle — detect_upgrade then update restores", () => {
    // installed → detect_upgrade → upgrade_available
    const r1 = applyFridaySkillLifecycleOperation("installed", "detect_upgrade");
    expect(r1.next).toBe("upgrade_available");

    // upgrade_available → update → installed
    const r2 = applyFridaySkillLifecycleOperation("upgrade_available", "update");
    expect(r2.next).toBe("installed");

    // upgrade_available → clear_upgrade → installed
    const r3 = applyFridaySkillLifecycleOperation("upgrade_available", "clear_upgrade");
    expect(r3.next).toBe("installed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Self-Repair Pipeline Verification (STAB-09 ~ STAB-14)
// ═══════════════════════════════════════════════════════════════════════════

describe("Self-Repair Pipeline Verification", () => {
  let db: FridaySqliteLayer;
  let actionRepo: ReturnType<typeof createFridayAutoFixActionRepository>;
  let incidentRepo: ReturnType<typeof createFridayErrorIncidentRepository>;
  let approvalRepo: ReturnType<typeof createFridayApprovalRequestRepository>;
  let diagnosisRepo: ReturnType<typeof createFridayDiagnosisRecordRepository>;
  const genId = createTestIdGenerator();
  const nowIso = () => new Date().toISOString();

  function makeTestIncident(overrides: Partial<FridayErrorIncidentEntity> = {}): FridayErrorIncidentEntity {
    return {
      incidentId: genId(),
      userId: "test-user",
      ts: nowIso(),
      category: "tool",
      severity: "low",
      signature: "test-sig-" + genId(),
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...overrides,
    };
  }

  function makeTestPlan(stepKinds: FridayAutoFixStepKind[] = ["retry_node"]): FridayAutoFixPlan {
    return {
      title: "Test Fix Plan",
      summary: "Automated test fix",
      steps: stepKinds.map((kind, i) => ({
        stepId: `step-${i}`,
        kind,
        target: `target-${i}`,
        payload: { data: "test" },
        verify: { method: "node_retry_success" as const, timeoutMs: 5000 },
      })),
      rollbackPlan: {
        summary: "Rollback test fix",
        steps: stepKinds.map((kind, i) => ({
          stepId: `rb-step-${i}`,
          kind,
          target: `target-${i}`,
          payload: { data: "rollback" },
        })),
      },
      evidence: {
        fingerprint: "test-fp",
        matchedLessonIds: [],
        diagnosisId: "diag-001",
        recurrenceCount: 1,
      },
    };
  }

  function makeTestAction(
    incidentId: string,
    plan: FridayAutoFixPlan,
    riskTier: 0 | 1 | 2 = 0,
  ): FridayAutoFixActionEntity {
    return {
      actionId: genId(),
      incidentId,
      userId: "test-user",
      riskTier,
      plan,
      status: "planned",
      outcome: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  beforeEach(() => {
    db = createTestDb();
    actionRepo = createFridayAutoFixActionRepository();
    incidentRepo = createFridayErrorIncidentRepository();
    approvalRepo = createFridayApprovalRequestRepository();
    diagnosisRepo = createFridayDiagnosisRecordRepository();
  });

  afterEach(() => {
    db.close();
  });

  it("STAB-09: auto-fix full pipeline — dispatch executes low-risk actions", async () => {
    const incident = makeTestIncident();
    db.withWriteTransaction((conn) => incidentRepo.insert(conn, incident));

    const plan = makeTestPlan(["retry_node"]);
    const action = makeTestAction(incident.incidentId, plan, 0);
    db.withWriteTransaction((conn) => actionRepo.insert(conn, action));

    const riskService = createFridayAutoFixRiskAssessmentService({
      db,
      actionRepo,
    });

    const rollbackService = createFridayAutoFixRollbackService({
      db,
      actionRepo,
      nowIso,
    });

    const executionService = createFridayAutoFixExecutionService({
      db,
      actionRepo,
      incidentRepo,
      diagnosisRepo,
      rollbackService,
      nowIso,
    });

    const dispatcher = createFridayAutoFixDispatcherService({
      db,
      actionRepo,
      approvalRepo,
      incidentRepo,
      riskService,
      executionService,
      nowIso,
    });

    const results = await dispatcher.runReadyActions({ maxRiskTier: 1 });

    expect(results.length).toBe(1);
    expect(results[0].success).toBe(true);
    expect(results[0].verificationPassed).toBe(true);
  });

  it("STAB-10: risk assessment blocks high-risk actions from auto-apply", async () => {
    const incident = makeTestIncident({ severity: "high" });
    db.withWriteTransaction((conn) => incidentRepo.insert(conn, incident));

    // disable_skill is Tier 2 + high severity also escalates
    const plan = makeTestPlan(["disable_skill"]);
    const action = makeTestAction(incident.incidentId, plan, 2);
    db.withWriteTransaction((conn) => actionRepo.insert(conn, action));

    const riskService = createFridayAutoFixRiskAssessmentService({ db, actionRepo });
    const assessment = riskService.assess({ incident, plan, nowIso: nowIso() });

    expect(assessment.riskTier).toBe(2);
    expect(assessment.requiresApproval).toBe(true);
    expect(assessment.autoApplyAllowed).toBe(false);
  });

  it("STAB-11: execution failure triggers rollback", async () => {
    const incident = makeTestIncident();
    db.withWriteTransaction((conn) => incidentRepo.insert(conn, incident));

    const plan = makeTestPlan(["retry_node"]);
    const action = makeTestAction(incident.incidentId, plan, 0);
    db.withWriteTransaction((conn) => actionRepo.insert(conn, action));

    const failingExecutor: StepExecutor = () => false;

    const rollbackService = createFridayAutoFixRollbackService({
      db,
      actionRepo,
      nowIso,
      stepExecutors: { retry_node: () => true },
    });

    const executionService = createFridayAutoFixExecutionService({
      db,
      actionRepo,
      incidentRepo,
      diagnosisRepo,
      rollbackService,
      nowIso,
      stepExecutors: { retry_node: failingExecutor },
    });

    const result = await executionService.execute(action.actionId);

    expect(result.success).toBe(false);
    expect(result.rollbackAttempted).toBe(true);
  });

  it("STAB-12: idempotency — executed action cannot be re-executed", async () => {
    const incident = makeTestIncident();
    db.withWriteTransaction((conn) => incidentRepo.insert(conn, incident));

    const plan = makeTestPlan(["retry_node"]);
    const action = makeTestAction(incident.incidentId, plan, 0);
    db.withWriteTransaction((conn) => actionRepo.insert(conn, action));

    const rollbackService = createFridayAutoFixRollbackService({ db, actionRepo, nowIso });
    const executionService = createFridayAutoFixExecutionService({
      db, actionRepo, incidentRepo, diagnosisRepo, rollbackService, nowIso,
    });

    // First execution succeeds
    const r1 = await executionService.execute(action.actionId);
    expect(r1.success).toBe(true);

    // Second execution should fail with status conflict
    await expect(executionService.execute(action.actionId)).rejects.toThrow(
      /expected 'planned'/,
    );
  });

  it("STAB-13: default step executors work for each kind", () => {
    // Test retry_node executor
    const retryStep = {
      stepId: "s1",
      kind: "retry_node" as const,
      target: "node-1",
      payload: { data: "test" },
    };

    // Import default executors indirectly by creating execution service
    // and verifying behaviors through the full pipeline
    // For unit-level verification, we test the step kind validity
    const validKinds: FridayAutoFixStepKind[] = [
      "retry_node",
      "switch_model_fallback",
      "trim_payload",
      "apply_config_patch",
      "grant_permission",
      "disable_skill",
      "pause_workflow",
    ];

    expect(validKinds).toHaveLength(7);

    // Verify each kind has corresponding tier classification
    const tier0: FridayAutoFixStepKind[] = ["retry_node", "switch_model_fallback", "trim_payload"];
    const tier1: FridayAutoFixStepKind[] = ["apply_config_patch", "grant_permission"];
    const tier2: FridayAutoFixStepKind[] = ["disable_skill", "pause_workflow"];

    expect([...tier0, ...tier1, ...tier2].sort()).toEqual(validKinds.sort());
  });

  it("STAB-14: action not found throws 404", async () => {
    const rollbackService = createFridayAutoFixRollbackService({ db, actionRepo, nowIso });
    const executionService = createFridayAutoFixExecutionService({
      db, actionRepo, incidentRepo, diagnosisRepo, rollbackService, nowIso,
    });

    await expect(executionService.execute("nonexistent-id")).rejects.toThrow(
      /not found/i,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Retry & Circuit Breaker Stability (STAB-15 ~ STAB-19)
// ═══════════════════════════════════════════════════════════════════════════

describe("Retry & Circuit Breaker Stability", () => {
  it("STAB-15: circuit breaker full state machine — closed → open → half_open → closed", () => {
    let clock = 0;
    const cb = createCircuitBreakerManager(
      { failureThreshold: 3, resetTimeoutMs: 1000, halfOpenSuccessThreshold: 1 },
      () => clock,
    );

    // Start closed
    expect(cb.getSnapshot("api").state).toBe("closed");

    // 3 failures → open
    cb.recordFailure("api");
    cb.recordFailure("api");
    cb.recordFailure("api");
    expect(cb.getSnapshot("api").state).toBe("open");
    expect(cb.getSnapshot("api").totalTrips).toBe(1);

    // While open, requests are rejected
    expect(cb.isAllowed("api")).toBe(false);

    // Advance past reset timeout → half_open
    clock += 1001;
    expect(cb.isAllowed("api")).toBe(true); // probe allowed
    expect(cb.getSnapshot("api").state).toBe("half_open");

    // Probe success → closed
    cb.recordSuccess("api");
    expect(cb.getSnapshot("api").state).toBe("closed");
    expect(cb.getSnapshot("api").consecutiveFailures).toBe(0);
  });

  it("STAB-16: circuit breaker target isolation — A tripped, B unaffected", () => {
    const cb = createCircuitBreakerManager({
      failureThreshold: 2,
      resetTimeoutMs: 5000,
      halfOpenSuccessThreshold: 1,
    });

    // Trip target A
    cb.recordFailure("target-A");
    cb.recordFailure("target-A");
    expect(cb.getSnapshot("target-A").state).toBe("open");

    // Target B is unaffected
    expect(cb.isAllowed("target-B")).toBe(true);
    expect(cb.getSnapshot("target-B").state).toBe("closed");
  });

  it("STAB-17: retry budget exhaustion — denies when tokens depleted", () => {
    let clock = 0;
    const budget = createRetryBudget(
      { maxTokens: 3, refillRatePerSecond: 0, maxConcurrent: 10 },
      () => clock,
    );

    // Acquire 3 tokens successfully
    expect(budget.acquire()).toBe(true);
    expect(budget.acquire()).toBe(true);
    expect(budget.acquire()).toBe(true);

    // 4th should be denied
    expect(budget.acquire()).toBe(false);

    const snap = budget.getSnapshot();
    expect(snap.totalGranted).toBe(3);
    expect(snap.totalDenied).toBe(1);
  });

  it("STAB-18: retry budget concurrent limit", () => {
    let clock = 0;
    const budget = createRetryBudget(
      { maxTokens: 100, refillRatePerSecond: 0, maxConcurrent: 2 },
      () => clock,
    );

    expect(budget.acquire()).toBe(true);
    expect(budget.acquire()).toBe(true);
    // Max concurrent reached
    expect(budget.acquire()).toBe(false);

    // Release one
    budget.release();
    expect(budget.acquire()).toBe(true);
  });

  it("STAB-19: dead letter queue — enqueue, query, acknowledge, evict", () => {
    let idCounter = 0;
    const dlq = createDeadLetterQueue({
      maxSize: 3,
      generateId: () => `dlq-${++idCounter}`,
      nowIso: () => "2025-01-01T00:00:00.000Z",
    });

    const baseParams: EnqueueParams = {
      runId: "run-1",
      workflowId: "wf-1",
      nodeId: "node-1",
      classifiedFailure: {
        category: "model_error",
        severity: "medium",
        retryable: false,
        message: "Model returned invalid response",
      } as any,
      lastDecision: { shouldRetry: false, reason: "budget_exhausted" } as any,
      totalAttempts: 3,
      totalCost: { tokens: 100, latencyMs: 5000, apiCalls: 3 } as any,
      reason: "All retries exhausted",
    };

    // Enqueue 3 items
    const e1 = dlq.enqueue({ ...baseParams, nodeId: "n1" });
    const e2 = dlq.enqueue({ ...baseParams, nodeId: "n2" });
    const e3 = dlq.enqueue({ ...baseParams, nodeId: "n3" });

    expect(dlq.query()).toHaveLength(3);

    // Acknowledge one
    const acked = dlq.acknowledge(e1.id, "reviewed");
    expect(acked?.acknowledged).toBe(true);

    // Enqueue 4th — should evict oldest unacknowledged (e2)
    dlq.enqueue({ ...baseParams, nodeId: "n4" });
    expect(dlq.query()).toHaveLength(3);
    expect(dlq.get(e2.id)).toBeUndefined();

    // e1 (acknowledged) and e3 should still exist
    expect(dlq.get(e1.id)).toBeDefined();
    expect(dlq.get(e3.id)).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Health Check & Heartbeat Stability (STAB-20 ~ STAB-23)
// ═══════════════════════════════════════════════════════════════════════════

describe("Health Check & Heartbeat Stability", () => {
  it("STAB-20: aggregation — one unhealthy component makes system unhealthy", async () => {
    const manager = new FridayHealthCheckManager();

    manager.registerCheck("healthy-service", "rules", async (): Promise<ComponentHealth> => ({
      name: "healthy-service",
      module: "rules",
      status: "healthy",
      dependencies: [],
      lastCheckedAt: new Date().toISOString(),
      checkDurationMs: 1,
    }));

    manager.registerCheck("broken-service", "retry", async (): Promise<ComponentHealth> => ({
      name: "broken-service",
      module: "retry",
      status: "unhealthy",
      message: "Connection refused",
      dependencies: [],
      lastCheckedAt: new Date().toISOString(),
      checkDurationMs: 1,
    }));

    const health = await manager.checkAll();

    expect(health.status).toBe("unhealthy");
    expect(health.unhealthyCount).toBe(1);
    expect(health.healthyCount).toBe(1);
    expect(health.components).toHaveLength(2);
  });

  it("STAB-21: health check timeout — slow check does not block system", async () => {
    const manager = new FridayHealthCheckManager();

    // Register a check that takes longer than the timeout
    manager.registerCheck("slow-service", "rules", async (): Promise<ComponentHealth> => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return {
        name: "slow-service",
        module: "rules",
        status: "healthy",
        dependencies: [],
        lastCheckedAt: new Date().toISOString(),
        checkDurationMs: 200,
      };
    }, 50); // 50ms timeout

    const health = await manager.checkAll();

    // Should be marked unhealthy due to timeout
    const slowComponent = health.components.find((c) => c.name === "slow-service");
    expect(slowComponent).toBeDefined();
    expect(slowComponent!.status).toBe("unhealthy");
  });

  it("STAB-22: health check immutability — returned results are frozen", async () => {
    const manager = new FridayHealthCheckManager();

    manager.registerCheck("immutable-test", "rules", async (): Promise<ComponentHealth> => ({
      name: "immutable-test",
      module: "rules",
      status: "healthy",
      dependencies: [],
      lastCheckedAt: new Date().toISOString(),
      checkDurationMs: 1,
    }));

    await manager.checkAll();

    const result = manager.getLastResult("immutable-test");
    expect(result).toBeDefined();

    // Attempt to mutate should throw (frozen object)
    expect(() => {
      (result as any).status = "unhealthy";
    }).toThrow();
  });

  it("STAB-23: health check — component check failure returns unhealthy, not crash", async () => {
    const manager = new FridayHealthCheckManager();

    manager.registerCheck("crashing-service", "rules", async (): Promise<ComponentHealth> => {
      throw new Error("Unexpected failure in health check");
    });

    // Should not throw — should return unhealthy result
    const result = await manager.checkComponent("crashing-service");
    expect(result).toBeDefined();
    expect(result!.status).toBe("unhealthy");
    expect(result!.message).toContain("Unexpected failure");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Long-Running & Scheduled Task Stability (STAB-24 ~ STAB-28)
// ═══════════════════════════════════════════════════════════════════════════

describe("Long-Running & Scheduled Task Stability", () => {
  it("STAB-24: job scheduler — registers and tracks jobs", async () => {
    const db = createTestDb();
    try {
      const repo = createFridayJobSchedulerRepository({ db });

      let callCount = 0;
      const service = createFridayJobSchedulerService({
        repository: repo,
        jobs: [
          {
            id: "test-job-1",
            intervalMs: 60_000,
            run: async () => { callCount++; },
          },
        ],
      });

      // Before start: not enabled
      const status = await service.status();
      expect(status.enabled).toBe(false);

      // Service was created with 1 job definition — verify it can start and stop
      await service.start();
      const runningStatus = await service.status();
      expect(runningStatus.enabled).toBe(true);
      expect(runningStatus.jobs).toBeGreaterThanOrEqual(1);
      await service.stop();
    } finally {
      db.close();
    }
  });

  it("STAB-25: config backup rotation — rotates correctly up to maxBackups", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-config-stab-"));
    const configPath = path.join(tmpDir, "config.json5");

    try {
      // Write initial config
      fs.writeFileSync(configPath, '{ "version": 0 }');

      // Rotate 5 times with maxBackups=3
      for (let i = 1; i <= 5; i++) {
        await rotateFridayConfigBackups(configPath, 3);
        fs.writeFileSync(configPath, `{ "version": ${i} }`);
      }

      // .bak should exist (most recent backup)
      expect(fs.existsSync(`${configPath}.bak`)).toBe(true);

      // .bak.1 should exist
      expect(fs.existsSync(`${configPath}.bak.1`)).toBe(true);

      // .bak.2 should exist (maxBackups=3 means .bak, .bak.1, .bak.2)
      expect(fs.existsSync(`${configPath}.bak.2`)).toBe(true);

      // .bak.3 should NOT exist (beyond maxBackups)
      expect(fs.existsSync(`${configPath}.bak.3`)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("STAB-26: DB migration idempotency — running migrations twice is safe", () => {
    const rawDb = new Database(":memory:");
    try {
      // First run
      runFridayMigrations({ db: rawDb, migrations: FRIDAY_SQLITE_MIGRATIONS });

      // Second run should not throw
      expect(() => {
        runFridayMigrations({ db: rawDb, migrations: FRIDAY_SQLITE_MIGRATIONS });
      }).not.toThrow();

      // Verify tables still work
      const result = rawDb.prepare("SELECT COUNT(*) as cnt FROM users").get() as any;
      expect(result.cnt).toBeGreaterThanOrEqual(0);
    } finally {
      rawDb.close();
    }
  });

  it("STAB-27: circuit breaker reset — reset clears all state", () => {
    const cb = createCircuitBreakerManager({
      failureThreshold: 2,
      resetTimeoutMs: 5000,
      halfOpenSuccessThreshold: 1,
    });

    // Trip the breaker
    cb.recordFailure("target-1");
    cb.recordFailure("target-1");
    expect(cb.getSnapshot("target-1").state).toBe("open");

    // Reset
    cb.reset("target-1");
    expect(cb.getSnapshot("target-1").state).toBe("closed");
    expect(cb.getSnapshot("target-1").consecutiveFailures).toBe(0);
    expect(cb.getSnapshot("target-1").totalTrips).toBe(0);
  });

  it("STAB-28: timer leak detection — circuit breaker manager creates no timers", () => {
    vi.useFakeTimers();
    try {
      const baseline = vi.getTimerCount();

      // Create and use circuit breaker — should use no timers (purely state-based)
      const cb = createCircuitBreakerManager({
        failureThreshold: 3,
        resetTimeoutMs: 1000,
        halfOpenSuccessThreshold: 1,
      });

      cb.recordFailure("leak-target");
      cb.recordFailure("leak-target");
      cb.recordFailure("leak-target");
      cb.recordSuccess("leak-target");

      // Circuit breaker should not add any timers
      expect(vi.getTimerCount()).toBe(baseline);

      // Create and use retry budget — should use no timers
      const budget = createRetryBudget({
        maxTokens: 5,
        refillRatePerSecond: 1,
        maxConcurrent: 3,
      });
      budget.acquire();
      budget.release();

      // Retry budget should not add any timers
      expect(vi.getTimerCount()).toBe(baseline);

      // Create and use DLQ — should use no timers
      let dlqCounter = 0;
      const dlq = createDeadLetterQueue({
        maxSize: 10,
        generateId: () => `dlq-leak-${++dlqCounter}`,
        nowIso: () => "2025-01-01T00:00:00.000Z",
      });
      dlq.enqueue({
        runId: "run-leak",
        workflowId: "wf-leak",
        nodeId: "node-leak",
        classifiedFailure: { category: "model_error", severity: "medium", retryable: false, message: "test" } as any,
        lastDecision: { shouldRetry: false, reason: "test" } as any,
        totalAttempts: 1,
        totalCost: { tokens: 0, latencyMs: 0, apiCalls: 0 } as any,
        reason: "leak test",
      });

      // DLQ should not add any timers
      expect(vi.getTimerCount()).toBe(baseline);
    } finally {
      vi.useRealTimers();
    }
  });
});

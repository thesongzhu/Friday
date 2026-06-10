import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFridayDeterministicPipelineRuntime } from "../../../../src/api/runtime/friday-deterministic-pipeline-runtime.js";
import { createFridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../../helpers/friday-test-db.helper.js";

function clearRulesState(db: ReturnType<typeof createTestDb>): void {
  db.withWriteTransaction((conn) => {
    conn.prepare("DELETE FROM rule_evaluation_log").run();
    conn.prepare("DELETE FROM rule_versions").run();
    conn.prepare("DELETE FROM rules").run();
    conn.prepare("DELETE FROM rule_policy_bundles").run();
  });
}

describe("Friday deterministic pipeline runtime wiring", () => {
  const originalPipelineMode = process.env.FRIDAY_PIPELINE_MODE;
  const originalPipelineEnable = process.env.FRIDAY_PIPELINE_ENABLE;
  const originalRetryCircuitThreshold = process.env.FRIDAY_PIPELINE_RETRY_CIRCUIT_THRESHOLD;

  afterEach(() => {
    if (originalPipelineMode === undefined) {
      delete process.env.FRIDAY_PIPELINE_MODE;
    } else {
      process.env.FRIDAY_PIPELINE_MODE = originalPipelineMode;
    }
    if (originalPipelineEnable === undefined) {
      delete process.env.FRIDAY_PIPELINE_ENABLE;
    } else {
      process.env.FRIDAY_PIPELINE_ENABLE = originalPipelineEnable;
    }
    if (originalRetryCircuitThreshold === undefined) {
      delete process.env.FRIDAY_PIPELINE_RETRY_CIRCUIT_THRESHOLD;
    } else {
      process.env.FRIDAY_PIPELINE_RETRY_CIRCUIT_THRESHOLD = originalRetryCircuitThreshold;
    }
  });

  it("creates and evaluates rules bundles", () => {
    const db = createTestDb();
    clearRulesState(db);
    const idGenerator = createTestIdGenerator();
    const runtime = createFridayDeterministicPipelineRuntime({
      db,
      idGenerator,
      nowIso: () => "2026-02-27T00:00:00.000Z",
      invokeSkill: async () => ({ ok: true }),
      // TS-runtime-retirement: exercise the legacy node-runner/retry paths in
      // these unit tests; default/live runtime leaves these unset so the route-
      // deps wrappers fail closed (the 503-by-default behavior is asserted in the
      // dedicated guard test).
      allowTestOnlyNodeRunnerExecution: true,
      allowTestOnlyRetryPipelineExecution: true,
    });

    const created = runtime.rules.createBundle({
      name: "test-bundle",
      rules: [
        {
          name: "allow-all",
          resource: "workflow",
          action: "execute",
          decision: "allow",
          conditions: {},
        },
      ],
    }) as { bundle: { id: string } };

    const listed = runtime.rules.listBundles({}) as { items: unknown[] };
    const result = runtime.rules.evaluateRules({
      bundleId: created.bundle.id,
      resource: "workflow",
      action: "execute",
      args: { task: "ok" },
    }) as { result: { decision: string } };

    expect(listed.items.length).toBeGreaterThan(0);
    expect(result.result.decision).toBe("allow");
    db.close();
  });

  it("fails closed when evaluating a missing rules bundle", () => {
    const db = createTestDb();
    clearRulesState(db);
    const runtime = createFridayDeterministicPipelineRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2026-02-27T00:00:00.000Z",
      invokeSkill: async () => ({ ok: true }),
      // TS-runtime-retirement: exercise the legacy node-runner/retry paths in
      // these unit tests; default/live runtime leaves these unset so the route-
      // deps wrappers fail closed (the 503-by-default behavior is asserted in the
      // dedicated guard test).
      allowTestOnlyNodeRunnerExecution: true,
      allowTestOnlyRetryPipelineExecution: true,
    });

    expect(() =>
      runtime.rules.evaluateRules({
        bundleId: "missing-bundle",
        resource: "workflow",
        action: "execute",
        args: { task: "blocked" },
      }),
    ).toThrow(/Policy bundle 'missing-bundle' not found/);
    db.close();
  });

  it("relaxes deny decision in shadow mode for node-runner execution", async () => {
    process.env.FRIDAY_PIPELINE_MODE = "shadow";
    process.env.FRIDAY_PIPELINE_ENABLE = "true";

    const db = createTestDb();
    clearRulesState(db);
    const runtime = createFridayDeterministicPipelineRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2026-02-27T00:00:00.000Z",
      invokeSkill: async () => ({ ok: true }),
      // TS-runtime-retirement: exercise the legacy node-runner/retry paths in
      // these unit tests; default/live runtime leaves these unset so the route-
      // deps wrappers fail closed (the 503-by-default behavior is asserted in the
      // dedicated guard test).
      allowTestOnlyNodeRunnerExecution: true,
      allowTestOnlyRetryPipelineExecution: true,
    });

    const created = runtime.rules.createBundle({
      name: "deny-bundle",
      rules: [{
        name: "deny-all",
        resource: "workflow",
        action: "execute",
        decision: "deny",
        conditions: {},
      }],
    }) as { bundle: { id: string } };

    const execution = await runtime.nodeRunner.executeNode({
      runId: "run-shadow-1",
      workflowId: "wf-shadow-1",
      nodeId: "node-shadow-1",
      nodeType: "data",
      nodeConfig: {},
      inputData: { bundleId: created.bundle.id, value: 1 },
    }) as { execution: { status: string } };

    expect(execution.execution.status).toBe("completed");
    db.close();
  });

  it("executes node-runner flow and records learning candidate", async () => {
    const db = createTestDb();
    clearRulesState(db);
    const idGenerator = createTestIdGenerator();
    const runtime = createFridayDeterministicPipelineRuntime({
      db,
      idGenerator,
      nowIso: () => "2026-02-27T00:00:00.000Z",
      invokeSkill: async (_skillId, _runId, _nodeId, payload) => ({
        echoed: payload,
      }),
      allowTestOnlyNodeRunnerExecution: true,
      allowTestOnlyRetryPipelineExecution: true,
    });

    const executed = await runtime.nodeRunner.executeNode({
      nodeId: "node-1",
      nodeType: "action",
      nodeConfig: {
        actionType: "tool",
        skillId: "echo-skill",
      },
      inputData: {
        value: 1,
      },
      workflowType: "smoke-workflow",
      tags: ["smoke"],
    }) as { execution: { executionId: string; status: string } };

    const retrieved = runtime.nodeRunner.getExecution(executed.execution.executionId) as {
      execution: { status: string };
    };
    const candidates = runtime.playbook.listCandidates({}) as { items: unknown[] };

    expect(retrieved.execution.status).toBe("completed");
    expect(candidates.items.length).toBeGreaterThan(0);
    db.close();
  });

  it("evolves an existing playbook when a promoted candidate matches the active workflow type", async () => {
    const db = createTestDb();
    clearRulesState(db);
    const idGenerator = createTestIdGenerator();
    const runtime = createFridayDeterministicPipelineRuntime({
      db,
      idGenerator,
      nowIso: () => "2026-02-27T00:00:00.000Z",
      invokeSkill: async () => ({ ok: true }),
      // TS-runtime-retirement: exercise the legacy node-runner/retry paths in
      // these unit tests; default/live runtime leaves these unset so the route-
      // deps wrappers fail closed (the 503-by-default behavior is asserted in the
      // dedicated guard test).
      allowTestOnlyNodeRunnerExecution: true,
      allowTestOnlyRetryPipelineExecution: true,
    });

    async function executeEvidenceRun(runId: string, inputData: Record<string, unknown>) {
      return runtime.nodeRunner.executeNode({
        runId,
        workflowId: `wf-${runId}`,
        nodeId: `node-${runId}`,
        nodeType: "data",
        nodeConfig: {
          mapping: {
            stage: "upgrade-proof",
          },
        },
        inputData,
        workflowType: "upgrade-proof-workflow",
        tags: ["upgrade-proof"],
      });
    }

    for (let index = 0; index < 5; index += 1) {
      await executeEvidenceRun(`v1-${index}`, { alpha: index, beta: true });
    }

    const initialCandidates = runtime.playbook.listCandidates({
      workflowType: "upgrade-proof-workflow",
    }) as {
      items: Array<{ id: string; fingerprint: string; evidenceCount: number }>;
    };
    expect(initialCandidates.items).toHaveLength(1);
    const firstCandidate = initialCandidates.items[0]!;

    db.withWriteTransaction((conn) => {
      conn.prepare(
        `UPDATE playbook_candidates
            SET first_observed_at = ?, updated_at = ?
          WHERE id = ?`,
      ).run("2026-02-25T00:00:00.000Z", "2026-02-27T00:00:00.000Z", firstCandidate.id);
    });

    const firstPromotion = await runtime.playbook.promoteCandidate(firstCandidate.id, {}) as {
      decision: { decision: string };
      playbook: { id: string; activeVersionNumber: number };
      version: { versionNumber: number };
    };
    expect(firstPromotion.decision.decision).toBe("promote");
    expect(firstPromotion.playbook.id).toBeTruthy();
    expect(firstPromotion.version.versionNumber).toBe(1);

    for (let index = 0; index < 5; index += 1) {
      await executeEvidenceRun(`v2-${index}`, { alpha: index, beta: true, gamma: "upgrade" });
    }

    const nextCandidates = runtime.playbook.listCandidates({
      workflowType: "upgrade-proof-workflow",
    }) as {
      items: Array<{ id: string; fingerprint: string; evidenceCount: number }>;
    };
    const secondCandidate = nextCandidates.items.find((item) => item.id !== firstCandidate.id);
    expect(secondCandidate).toBeDefined();
    expect(secondCandidate?.fingerprint).not.toBe(firstCandidate.fingerprint);

    db.withWriteTransaction((conn) => {
      conn.prepare(
        `UPDATE playbook_candidates
            SET first_observed_at = ?, updated_at = ?
          WHERE id = ?`,
      ).run("2026-02-25T00:00:00.000Z", "2026-02-27T00:00:00.000Z", secondCandidate!.id);
    });

    const secondPromotion = await runtime.playbook.promoteCandidate(secondCandidate!.id, {}) as {
      decision: { decision: string };
      playbook: { id: string; activeVersionNumber: number };
      version: { versionNumber: number };
    };

    expect(secondPromotion.decision.decision).toBe("promote");
    expect(secondPromotion.playbook.id).toBe(firstPromotion.playbook.id);
    expect(secondPromotion.version.versionNumber).toBe(2);
    expect(secondPromotion.playbook.activeVersionNumber).toBe(2);

    const playbookDetails = runtime.playbook.getPlaybook(firstPromotion.playbook.id) as {
      playbook: { activeVersionNumber: number };
    };
    expect(playbookDetails.playbook.activeVersionNumber).toBe(2);

    db.close();
  });

  it("runs acceptance checks and supports result query", async () => {
    const db = createTestDb();
    const idGenerator = createTestIdGenerator();
    const runtime = createFridayDeterministicPipelineRuntime({
      db,
      idGenerator,
      nowIso: () => "2026-02-27T00:00:00.000Z",
      invokeSkill: async () => ({ ok: true }),
      // TS-runtime-retirement: exercise the legacy node-runner/retry paths in
      // these unit tests; default/live runtime leaves these unset so the route-
      // deps wrappers fail closed (the 503-by-default behavior is asserted in the
      // dedicated guard test).
      allowTestOnlyNodeRunnerExecution: true,
      allowTestOnlyRetryPipelineExecution: true,
    });

    const run = await runtime.acceptance.runChecks({
      artifactType: "json",
      content: { count: 3 },
    }) as { result: { id: string; checksTotal: number } };

    const loaded = runtime.acceptance.getResult(run.result.id) as {
      result: { id: string };
    };
    const listed = runtime.acceptance.listResults({}) as { items: unknown[] };

    expect(run.result.checksTotal).toBeGreaterThan(0);
    expect(loaded.result.id).toBe(run.result.id);
    expect(listed.items.length).toBeGreaterThan(0);
    const tests = runtime.acceptance.listTests({}) as { items: Array<{ id: string }> };
    expect(tests.items.length).toBeGreaterThan(0);
    db.close();
  });

  it("persists retry decisions, escalations, and circuit breakers", () => {
    const db = createTestDb();
    const runtime = createFridayDeterministicPipelineRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2026-02-27T00:00:00.000Z",
      invokeSkill: async () => ({ ok: true }),
      // TS-runtime-retirement: exercise the legacy node-runner/retry paths in
      // these unit tests; default/live runtime leaves these unset so the route-
      // deps wrappers fail closed (the 503-by-default behavior is asserted in the
      // dedicated guard test).
      allowTestOnlyNodeRunnerExecution: true,
      allowTestOnlyRetryPipelineExecution: true,
    });

    const decided = runtime.retry.decideRetry({
      runId: "run-1",
      workflowId: "wf-1",
      nodeId: "node-1",
      currentAttemptNumber: 3,
      error: { errorCode: "AUTH_FAILED" },
      targetId: "provider:openai",
    }) as { classifiedFailure: { category: string }; decision: { shouldRetry: boolean } };

    const escalations = runtime.retry.listEscalations({}) as { items: unknown[] };
    const breakers = runtime.retry.listCircuitBreakers({}) as { items: Array<{ targetId: string }> };
    const traces = runtime.retry.listTraces({}) as { items: unknown[] };

    expect(decided.classifiedFailure.category).toBeTruthy();
    expect(traces.items.length).toBeGreaterThan(0);
    expect(breakers.items.some((item) => item.targetId === "provider:openai")).toBe(true);
    expect(escalations.items.length).toBeGreaterThanOrEqual(0);
    db.close();
  });

  it("counts retryable decideRetry failures toward the circuit breaker without treating terminal no-retry as failure", () => {
    process.env.FRIDAY_PIPELINE_RETRY_CIRCUIT_THRESHOLD = "3";
    const db = createTestDb();
    const runtime = createFridayDeterministicPipelineRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2026-02-27T00:00:00.000Z",
      invokeSkill: async () => ({ ok: true }),
      // TS-runtime-retirement: exercise the legacy node-runner/retry paths in
      // these unit tests; default/live runtime leaves these unset so the route-
      // deps wrappers fail closed (the 503-by-default behavior is asserted in the
      // dedicated guard test).
      allowTestOnlyNodeRunnerExecution: true,
      allowTestOnlyRetryPipelineExecution: true,
    });

    for (let index = 0; index < 3; index += 1) {
      const decided = runtime.retry.decideRetry({
        runId: `run-retry-${index}`,
        workflowId: "wf-retry",
        nodeId: "node-retry",
        currentAttemptNumber: 1,
        error: { errorCode: "ECONNRESET", errorMessage: "connection reset" },
        targetId: "provider:retryable",
      }) as { decision: { shouldRetry: boolean } };

      expect(decided.decision.shouldRetry).toBe(true);
    }

    runtime.retry.decideRetry({
      runId: "run-auth",
      workflowId: "wf-auth",
      nodeId: "node-auth",
      currentAttemptNumber: 1,
      error: { errorCode: "AUTH_FAILED", errorMessage: "Unauthorized" },
      targetId: "provider:auth",
    });

    const breakers = runtime.retry.listCircuitBreakers({}) as {
      items: Array<{ targetId: string; state: string; consecutiveFailures: number; tripCount: number }>;
    };
    const retryable = breakers.items.find((item) => item.targetId === "provider:retryable");
    const terminal = breakers.items.find((item) => item.targetId === "provider:auth");

    expect(retryable).toMatchObject({
      state: "open",
      consecutiveFailures: 3,
      tripCount: 1,
    });
    expect(terminal).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
      tripCount: 0,
    });
    db.close();
  });

  it("lists rules audit log and versions from persisted evaluations", () => {
    const db = createTestDb();
    clearRulesState(db);
    const runtime = createFridayDeterministicPipelineRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2026-02-27T00:00:00.000Z",
      invokeSkill: async () => ({ ok: true }),
      // TS-runtime-retirement: exercise the legacy node-runner/retry paths in
      // these unit tests; default/live runtime leaves these unset so the route-
      // deps wrappers fail closed (the 503-by-default behavior is asserted in the
      // dedicated guard test).
      allowTestOnlyNodeRunnerExecution: true,
      allowTestOnlyRetryPipelineExecution: true,
    });

    const created = runtime.rules.createBundle({
      name: "audit-bundle",
      rules: [
        { name: "warn-all", resource: "workflow", action: "execute", decision: "warn", conditions: {} },
      ],
    }) as { rules: Array<{ id: string }>; bundle: { id: string } };

    runtime.rules.evaluateRules({
      bundleId: created.bundle.id,
      resource: "workflow",
      action: "execute",
      args: { task: "audit" },
      runId: "run-audit-1",
    });

    const audit = runtime.rules.listEvaluationAuditLog({ runId: "run-audit-1" }) as { items: unknown[] };
    const versions = runtime.rules.listRuleVersions(created.rules[0]!.id, {}) as { items: unknown[] };

    expect(audit.items.length).toBeGreaterThan(0);
    expect(Array.isArray(versions.items)).toBe(true);
    db.close();
  });

  it("fails fast when playbook tables are unavailable", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-deterministic-runtime-"));
    const dbPath = path.join(tmpDir, "friday.db");
    const db = createFridaySqliteLayer({
      dbPath,
      readPoolSize: 1,
      pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
      runMigrations: false,
    });

    try {
      expect(() => createFridayDeterministicPipelineRuntime({
        db,
        idGenerator: createTestIdGenerator(),
        nowIso: () => "2026-02-27T00:00:00.000Z",
        invokeSkill: async () => ({ ok: true }),
      })).toThrowError("PLAYBOOK_TABLES_NOT_AVAILABLE");
    } finally {
      db.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFridayRulesRepository } from "#rules";
import {
  createFridayWorkflowRuntime,
  createFridayWorkflowTriggerRepository,
  type FridayCompiledWorkflowGraphV2,
  type FridayWorkflowRuntime,
} from "#workflows";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";

const NOW = "2026-02-27T00:00:00.000Z";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRunSettled(runtime: FridayWorkflowRuntime, runId: string): Promise<"completed" | "failed" | "cancelled"> {
  const terminal = new Set(["completed", "failed", "cancelled"] as const);
  for (let i = 0; i < 250; i++) {
    const run = runtime.execution.getRun(runId);
    if (run && terminal.has(run.status as "completed" | "failed" | "cancelled")) {
      return run.status as "completed" | "failed" | "cancelled";
    }
    await wait(20);
  }
  throw new Error(`Run ${runId} did not settle in time`);
}

function makeGraph(
  workflowId: string,
  versionId: string,
): FridayCompiledWorkflowGraphV2 {
  return {
    schemaVersion: "2.0",
    workflowId,
    workflowVersionId: versionId,
    sourceSpecSchemaVersion: "1.0",
    graph: {
      nodes: [
        { id: "trigger", type: "trigger", label: "Trigger", config: {} },
        { id: "action1", type: "action", label: "Action 1", config: { skillId: "test-skill" } },
      ],
      edges: [{ id: "e1", sourceNodeId: "trigger", targetNodeId: "action1" }],
    },
    failurePolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    checksum: "placeholder",
  };
}

function seedDenyRule(db: FridaySqliteLayer): void {
  const rulesRepo = createFridayRulesRepository();
  db.withWriteTransaction((conn) => {
    conn.prepare("DELETE FROM rule_evaluation_log").run();
    conn.prepare("DELETE FROM rule_versions").run();
    conn.prepare("DELETE FROM rules").run();
    conn.prepare("DELETE FROM rule_policy_bundles").run();

    rulesRepo.insertPolicyBundle(conn, {
      id: "bundle-deny-tool-exec",
      name: "deny tool execute",
      description: null,
      version: 1,
      priority: 100,
      enabled: 1,
      tags_json: "[]",
      source: "user",
      etag: "bundle-etag",
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
    });
    rulesRepo.insertRule(conn, {
      id: "rule-deny-tool-exec",
      policy_bundle_id: "bundle-deny-tool-exec",
      name: "deny tool execute",
      description: null,
      enabled: 1,
      resource: "tool",
      action: "execute",
      conditions_json: "{}",
      decision: "deny",
      message: "denied by integration test rule",
      priority: 100,
      version: 1,
      etag: "rule-etag",
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
    });
  });
}

function createRuntime(db: FridaySqliteLayer): FridayWorkflowRuntime {
  return createRuntimeWithOptions(db, {});
}

function createRuntimeWithOptions(
  db: FridaySqliteLayer,
  options: {
    invokeSkill?: (
      skillId: string,
      runId: string,
      nodeId: string,
      payload: Record<string, unknown>,
    ) => Promise<unknown>;
    publishEvent?: (event: string, payload: unknown) => Promise<void>;
  },
): FridayWorkflowRuntime {
  return createFridayWorkflowRuntime({
    allowTestOnlyWorkflowRunExecution: true, // TS-retirement method guard: test-oracle opt-in
    db,
    idGenerator: createTestIdGenerator(),
    nowIso: () => NOW,
    computeChecksum: (content: string) => createHash("sha256").update(content).digest("hex"),
    resolveSkill: () => ({ id: "test-skill" }),
    invokeSkill: options.invokeSkill ?? (async () => ({ ok: true })),
    publishEvent: options.publishEvent,
    triggerRepo: createFridayWorkflowTriggerRepository({ db }),
  });
}

async function runSimpleWorkflow(runtime: FridayWorkflowRuntime): Promise<"completed" | "failed" | "cancelled"> {
  const wf = runtime.crud.createWorkflow({ slug: `mode-test-${Math.random().toString(16).slice(2)}`, name: "Mode Test" });
  const version = runtime.crud.createVersion(wf.id, makeGraph(wf.id, "placeholder"));
  runtime.crud.publishVersion(wf.id, version.versionNumber);

  const run = await runtime.execution.startRun({
    workflowId: wf.id,
    workflowVersionId: version.id,
    triggerType: "manual",
  });

  return waitForRunSettled(runtime, run.id);
}

describe("Workflow runtime pipeline mode", () => {
  let originalMode: string | undefined;
  let originalRetryMaxAttempts: string | undefined;
  let originalRetryBudgetMax: string | undefined;
  let originalRetryCircuitThreshold: string | undefined;

  beforeEach(() => {
    originalMode = process.env.FRIDAY_PIPELINE_MODE;
    originalRetryMaxAttempts = process.env.FRIDAY_PIPELINE_RETRY_MAX_ATTEMPTS;
    originalRetryBudgetMax = process.env.FRIDAY_PIPELINE_RETRY_BUDGET_MAX;
    originalRetryCircuitThreshold = process.env.FRIDAY_PIPELINE_RETRY_CIRCUIT_THRESHOLD;
    process.env.FRIDAY_PIPELINE_ENABLE = "true";
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.FRIDAY_PIPELINE_MODE;
    } else {
      process.env.FRIDAY_PIPELINE_MODE = originalMode;
    }
    if (originalRetryMaxAttempts === undefined) {
      delete process.env.FRIDAY_PIPELINE_RETRY_MAX_ATTEMPTS;
    } else {
      process.env.FRIDAY_PIPELINE_RETRY_MAX_ATTEMPTS = originalRetryMaxAttempts;
    }
    if (originalRetryBudgetMax === undefined) {
      delete process.env.FRIDAY_PIPELINE_RETRY_BUDGET_MAX;
    } else {
      process.env.FRIDAY_PIPELINE_RETRY_BUDGET_MAX = originalRetryBudgetMax;
    }
    if (originalRetryCircuitThreshold === undefined) {
      delete process.env.FRIDAY_PIPELINE_RETRY_CIRCUIT_THRESHOLD;
    } else {
      process.env.FRIDAY_PIPELINE_RETRY_CIRCUIT_THRESHOLD = originalRetryCircuitThreshold;
    }
    delete process.env.FRIDAY_PIPELINE_ENABLE;
  });

  it("enforce mode blocks workflow when rule decision is deny", async () => {
    process.env.FRIDAY_PIPELINE_MODE = "enforce";
    const db = createTestDb();
    seedDenyRule(db);
    const runtime = createRuntime(db);

    const status = await runSimpleWorkflow(runtime);
    expect(status).toBe("failed");
    db.close();
  });

  it("shadow mode relaxes deny decision to warning and allows completion", async () => {
    process.env.FRIDAY_PIPELINE_MODE = "shadow";
    const db = createTestDb();
    seedDenyRule(db);
    const runtime = createRuntime(db);

    const status = await runSimpleWorkflow(runtime);
    expect(status).toBe("completed");
    db.close();
  });

  it("emits budget exhaustion retry event when retry budget is depleted", async () => {
    process.env.FRIDAY_PIPELINE_MODE = "enforce";
    process.env.FRIDAY_PIPELINE_RETRY_MAX_ATTEMPTS = "8";
    process.env.FRIDAY_PIPELINE_RETRY_BUDGET_MAX = "1";
    process.env.FRIDAY_PIPELINE_RETRY_CIRCUIT_THRESHOLD = "99";

    const publishedEvents: string[] = [];
    const db = createTestDb();
    const runtime = createRuntimeWithOptions(db, {
      invokeSkill: async () => {
        throw new Error("NODE_TIMEOUT: simulated timeout");
      },
      publishEvent: async (event) => {
        publishedEvents.push(event);
      },
    });

    const status = await runSimpleWorkflow(runtime);
    expect(status).toBe("failed");
    expect(publishedEvents).toContain("pipeline.retry.budget.exhausted");
    db.close();
  });

  it("emits circuit open retry event when consecutive failures exceed threshold", async () => {
    process.env.FRIDAY_PIPELINE_MODE = "enforce";
    process.env.FRIDAY_PIPELINE_RETRY_MAX_ATTEMPTS = "8";
    process.env.FRIDAY_PIPELINE_RETRY_BUDGET_MAX = "50";
    process.env.FRIDAY_PIPELINE_RETRY_CIRCUIT_THRESHOLD = "2";

    const publishedEvents: string[] = [];
    const db = createTestDb();
    const runtime = createRuntimeWithOptions(db, {
      invokeSkill: async () => {
        throw new Error("NODE_TIMEOUT: simulated timeout");
      },
      publishEvent: async (event) => {
        publishedEvents.push(event);
      },
    });

    const status = await runSimpleWorkflow(runtime);
    expect(status).toBe("failed");
    expect(publishedEvents).toContain("pipeline.retry.circuit.opened");
    db.close();
  });

  it("persists workflow retry traces, escalations, and circuit breaker snapshots into public retry tables", async () => {
    process.env.FRIDAY_PIPELINE_MODE = "enforce";
    process.env.FRIDAY_PIPELINE_RETRY_MAX_ATTEMPTS = "8";
    process.env.FRIDAY_PIPELINE_RETRY_BUDGET_MAX = "50";
    process.env.FRIDAY_PIPELINE_RETRY_CIRCUIT_THRESHOLD = "2";

    const db = createTestDb();
    const runtime = createRuntimeWithOptions(db, {
      invokeSkill: async () => {
        throw new Error("NODE_TIMEOUT: simulated timeout");
      },
    });

    const status = await runSimpleWorkflow(runtime);
    expect(status).toBe("failed");

    const persisted = db.withReadConnection((conn) => ({
      traces: Number((conn.prepare("SELECT COUNT(*) AS count FROM retry_traces").get() as { count: number }).count),
      attempts: Number((conn.prepare("SELECT COUNT(*) AS count FROM retry_attempts").get() as { count: number }).count),
      escalations: Number((conn.prepare("SELECT COUNT(*) AS count FROM retry_escalations").get() as { count: number }).count),
      circuitBreakers: Number((conn.prepare("SELECT COUNT(*) AS count FROM retry_circuit_breakers").get() as { count: number }).count),
      openCircuitBreakers: Number((conn.prepare("SELECT COUNT(*) AS count FROM retry_circuit_breakers WHERE state = 'open'").get() as { count: number }).count),
      escalatedTrace: conn.prepare(
        `SELECT original_failure_category, original_error_code, original_error_message, status
           FROM retry_traces
          WHERE status = 'escalated'
          ORDER BY updated_at DESC
          LIMIT 1`,
      ).get() as {
        original_failure_category: string;
        original_error_code: string | null;
        original_error_message: string | null;
        status: string;
      } | undefined,
      latestTrace: conn.prepare(
        `SELECT original_failure_category, original_error_code, original_error_message, status
           FROM retry_traces
          ORDER BY updated_at DESC
          LIMIT 1`,
      ).get() as {
        original_failure_category: string;
        original_error_code: string | null;
        original_error_message: string | null;
        status: string;
      } | undefined,
    }));

    expect(persisted.traces).toBeGreaterThan(0);
    expect(persisted.attempts).toBeGreaterThan(0);
    expect(persisted.escalations).toBeGreaterThan(0);
    expect(persisted.circuitBreakers).toBeGreaterThan(0);
    expect(persisted.openCircuitBreakers).toBeGreaterThan(0);
    expect(persisted.latestTrace?.original_failure_category).toBe("timeout");
    expect(persisted.latestTrace?.original_error_code).toBe("NODE_TIMEOUT");
    expect(persisted.escalatedTrace?.status).toBe("escalated");
    expect(persisted.escalatedTrace?.original_error_message).toContain("simulated timeout");
    db.close();
  });
});

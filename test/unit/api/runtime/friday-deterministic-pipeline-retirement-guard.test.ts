import { afterEach, describe, expect, it } from "vitest";

import { FridayDomainError } from "#errors";
import { createFridayDeterministicPipelineRuntime } from "../../../../src/api/runtime/friday-deterministic-pipeline-runtime.js";
import { createTestDb, createTestIdGenerator } from "../../../helpers/friday-test-db.helper.js";

/**
 * TS Runtime Retirement — METHOD-level guards for the deterministic-pipeline
 * route-deps wrappers (orphan off-route leak audit, 2026-06-10; F3.4 top-priority
 * node.runner.execute + retry.*).
 *
 * These guard the route-deps WRAPPERS (`nodeRunner.executeNode`, `retry.*`) that
 * this runtime returns — NOT the shared engine the live workflow runtime uses.
 * In default/live config (flags unset) the wrappers fail closed; with the test-
 * oracle flags they run the legacy path. Reads (get/list wrappers) stay live.
 */

const NODE_RETIRED = "TS_RUNTIME_NODE_RUNNER_EXECUTION_RETIRED";
const RETRY_RETIRED = "TS_RUNTIME_RETRY_PIPELINE_RETIRED";

function clearRulesState(db: ReturnType<typeof createTestDb>): void {
  db.withWriteTransaction((conn) => {
    conn.prepare("DELETE FROM rule_evaluation_log").run();
    conn.prepare("DELETE FROM rule_versions").run();
    conn.prepare("DELETE FROM rules").run();
    conn.prepare("DELETE FROM rule_policy_bundles").run();
  });
}

describe("Friday deterministic pipeline runtime TS-retirement method guards", () => {
  let openDbs: Array<ReturnType<typeof createTestDb>> = [];

  afterEach(() => {
    for (const db of openDbs) db.close();
    openDbs = [];
  });

  function buildRuntime(flags?: {
    allowTestOnlyNodeRunnerExecution?: boolean;
    allowTestOnlyRetryPipelineExecution?: boolean;
  }) {
    const db = createTestDb();
    clearRulesState(db);
    openDbs.push(db);
    return createFridayDeterministicPipelineRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2026-06-10T00:00:00.000Z",
      invokeSkill: async () => ({ ok: true }),
      ...(flags ?? {}),
    });
  }

  it("node.runner.execute fails closed by default: rejects with 503 fail_closed", async () => {
    const runtime = buildRuntime();
    await expect(
      runtime.nodeRunner.executeNode({ nodeId: "n-1", nodeType: "action", nodeConfig: {}, inputData: {} }),
    ).rejects.toMatchObject({ code: NODE_RETIRED, httpStatus: 503 });
  });

  it("retry.* mutations fail closed by default: 503 fail_closed", () => {
    const runtime = buildRuntime();
    const calls: Array<() => unknown> = [
      () => runtime.retry.createPolicy({ name: "p" }),
      () => runtime.retry.updatePolicy("p-1", { etag: "e" }),
      () => runtime.retry.deletePolicy("p-1", { etag: "e" }),
      () => runtime.retry.classifyFailure({ error: { errorCode: "X" } }),
      () => runtime.retry.decideRetry({ error: { errorCode: "X" } }),
      () => runtime.retry.acknowledgeEscalation("esc-1"),
    ];
    for (const call of calls) {
      expect(call).toThrow(expect.objectContaining({ code: RETRY_RETIRED, httpStatus: 503 }));
    }
  });

  it("node-runner and retry guards are independent (a retry flag does not open node-runner)", async () => {
    const runtime = buildRuntime({ allowTestOnlyRetryPipelineExecution: true });
    // retry classify is reachable now...
    expect(() => runtime.retry.classifyFailure({ error: { errorCode: "X" } })).not.toThrow();
    // ...but node-runner still fails closed (its own flag is unset).
    await expect(
      runtime.nodeRunner.executeNode({ nodeId: "n-1", nodeType: "action", nodeConfig: {}, inputData: {} }),
    ).rejects.toMatchObject({ code: NODE_RETIRED, httpStatus: 503 });
  });

  it("reads (retry.listPolicies) stay live without any flag", () => {
    const runtime = buildRuntime();
    const listed = runtime.retry.listPolicies({}) as { items: unknown[] };
    expect(Array.isArray(listed.items)).toBe(true);
  });

  it("wrappers run when the test-oracle flags are enabled (legacy path preserved)", async () => {
    const runtime = buildRuntime({
      allowTestOnlyNodeRunnerExecution: true,
      allowTestOnlyRetryPipelineExecution: true,
    });
    const created = runtime.retry.createPolicy({ name: "p" }) as { policy: { id: string } };
    expect(created.policy.id).toBeTruthy();
    const executed = (await runtime.nodeRunner.executeNode({
      nodeId: "n-1",
      nodeType: "data",
      nodeConfig: {},
      inputData: { value: 1 },
    })) as { execution: { status: string } };
    expect(executed.execution.status).toBeTruthy();
  });
});

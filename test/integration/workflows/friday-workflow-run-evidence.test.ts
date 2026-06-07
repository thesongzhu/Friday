import { createHash } from "node:crypto";
import * as fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  for (let i = 0; i < 250; i += 1) {
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
        { id: "action-success", type: "action", label: "Action Success", config: { skillId: "test-skill" } },
        { id: "action-fail", type: "action", label: "Action Fail", config: { skillId: "test-skill" } },
      ],
      edges: [
        { id: "edge-1", sourceNodeId: "trigger", targetNodeId: "action-success" },
        { id: "edge-2", sourceNodeId: "action-success", targetNodeId: "action-fail" },
      ],
    },
    failurePolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    checksum: "placeholder",
  };
}

function createRuntime(db: FridaySqliteLayer): FridayWorkflowRuntime {
  return createFridayWorkflowRuntime({
    allowTestOnlyWorkflowRunExecution: true, // TS-retirement method guard: test-oracle opt-in
    db,
    idGenerator: createTestIdGenerator(),
    nowIso: () => NOW,
    computeChecksum: (content: string) => createHash("sha256").update(content).digest("hex"),
    resolveSkill: () => ({ id: "test-skill" }),
    invokeSkill: async (_skillId, _runId, nodeId) => {
      if (nodeId === "action-success") {
        return { ok: true, data: ["sample"] };
      }
      if (nodeId === "action-fail") {
        throw new Error("NODE_TIMEOUT: evidence integration test timeout");
      }
      return { ok: true };
    },
    triggerRepo: createFridayWorkflowTriggerRepository({ db }),
  });
}

async function runFailureFlow(runtime: FridayWorkflowRuntime): Promise<string> {
  const workflow = runtime.crud.createWorkflow({
    slug: `evidence-test-${Math.random().toString(16).slice(2)}`,
    name: "Evidence Test",
  });
  const version = runtime.crud.createVersion(workflow.id, makeGraph(workflow.id, "placeholder"));
  runtime.crud.publishVersion(workflow.id, version.versionNumber);

  const run = await runtime.execution.startRun({
    workflowId: workflow.id,
    workflowVersionId: version.id,
    triggerType: "manual",
  });
  const status = await waitForRunSettled(runtime, run.id);
  expect(status).toBe("failed");
  return run.id;
}

describe("Workflow runtime run evidence export", () => {
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
    process.env.FRIDAY_PIPELINE_MODE = "enforce";
    process.env.FRIDAY_PIPELINE_RETRY_MAX_ATTEMPTS = "3";
    process.env.FRIDAY_PIPELINE_RETRY_BUDGET_MAX = "10";
    process.env.FRIDAY_PIPELINE_RETRY_CIRCUIT_THRESHOLD = "99";
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

  it("exports run-level evidence that links acceptance, retry, and playbook traces", async () => {
    const db = createTestDb();
    const runtime = createRuntime(db);

    const runId = await runFailureFlow(runtime);
    const evidence = runtime.evidence.getRunEvidence(runId);

    expect(evidence.run?.id).toBe(runId);
    expect(evidence.summary.totalEvents).toBeGreaterThan(0);
    expect(evidence.summary.retryTraceCount).toBeGreaterThan(0);
    expect(evidence.summary.playbookTraceCount).toBeGreaterThan(0);
    expect(evidence.acceptance.events.some((event) => event.event === "pipeline.acceptance.passed")).toBe(true);
    expect(evidence.retry.traces.some((trace) => trace.nodeId === "action-fail")).toBe(true);
    expect(evidence.correlation.items.some((row) => row.nodeId === "action-fail" && row.retryTraceCount > 0)).toBe(true);

    const phases = new Set(evidence.playbook.traces.map((trace) => trace.phase));
    expect(phases.has("intake")).toBe(true);
    expect(phases.has("feedback")).toBe(true);

    db.close();
  });

  it("supports correlated query filtering by module/event/node/attempt", async () => {
    const db = createTestDb();
    const runtime = createRuntime(db);

    const runId = await runFailureFlow(runtime);
    const filtered = runtime.evidence.getRunEvidence(runId, {
      modules: ["retry"],
      eventNames: ["pipeline.retry.attempted", "pipeline.retry.exhausted"],
      nodeId: "action-fail",
      attempt: 1,
      limit: 10,
    });

    expect(filtered.summary.totalEvents).toBeGreaterThan(0);
    expect(filtered.acceptance.events).toHaveLength(0);
    expect(filtered.playbook.traces).toHaveLength(0);
    expect(filtered.events.every((event) => event.module === "retry")).toBe(true);
    expect(filtered.events.every((event) => event.correlation.nodeId === "action-fail")).toBe(true);
    expect(filtered.events.every((event) => event.correlation.attempt === 1)).toBe(true);
    expect(filtered.retry.traces.every((trace) => trace.nodeId === "action-fail")).toBe(true);
    expect(filtered.retry.traces.every((trace) => trace.attempt === 1)).toBe(true);

    db.close();
  });

  it("persists evidence events/traces and can export/reload evidence snapshots", async () => {
    const db = createTestDb();
    const runtime1 = createRuntime(db);

    const runId = await runFailureFlow(runtime1);
    const firstRead = runtime1.evidence.getRunEvidence(runId);
    expect(firstRead.summary.totalEvents).toBeGreaterThan(0);
    expect(firstRead.summary.retryTraceCount).toBeGreaterThan(0);
    expect(firstRead.summary.playbookTraceCount).toBeGreaterThan(0);

    const persistedCounts = db.withReadConnection((conn) => ({
      events: (conn.prepare("SELECT COUNT(*) AS count FROM workflow_run_pipeline_events WHERE run_id = ?").get(runId) as { count: number }).count,
      retryTraces: (conn.prepare("SELECT COUNT(*) AS count FROM workflow_run_retry_traces WHERE run_id = ?").get(runId) as { count: number }).count,
      playbookTraces: (conn.prepare("SELECT COUNT(*) AS count FROM workflow_run_playbook_traces WHERE run_id = ?").get(runId) as { count: number }).count,
    }));
    expect(persistedCounts.events).toBeGreaterThan(0);
    expect(persistedCounts.retryTraces).toBeGreaterThan(0);
    expect(persistedCounts.playbookTraces).toBeGreaterThan(0);

    const runtime2 = createRuntime(db);
    const persistedRead = runtime2.evidence.getRunEvidence(runId);
    expect(persistedRead.summary.totalEvents).toBeGreaterThan(0);
    expect(persistedRead.summary.retryTraceCount).toBeGreaterThan(0);
    expect(persistedRead.summary.playbookTraceCount).toBeGreaterThan(0);

    const exported = runtime2.evidence.exportRunEvidence(runId, {
      modules: ["retry", "acceptance"],
      nodeId: "action-fail",
    });
    expect(exported.export.persisted).toBe(true);
    expect(exported.export.filePersisted).toBe(true);
    expect(exported.export.uri.startsWith("file://")).toBe(true);
    expect(exported.export.query.modules).toEqual(["retry", "acceptance"]);
    expect(exported.evidence.summary.totalEvents).toBeGreaterThan(0);

    const exportFilePath = exported.export.uri.replace("file://", "");
    expect(fs.existsSync(exportFilePath)).toBe(true);

    const listed = runtime2.evidence.listRunEvidenceExports(runId, 10);
    expect(listed.some((item) => item.exportId === exported.export.exportId)).toBe(true);

    const loaded = runtime2.evidence.getRunEvidenceExport(runId, exported.export.exportId);
    expect(loaded).not.toBeNull();
    expect(loaded!.export.checksum).toBe(exported.export.checksum);
    expect(loaded!.export.filePersisted).toBe(true);
    expect(loaded!.evidence.query.nodeId).toBe("action-fail");

    const downloaded = runtime2.evidence.downloadRunEvidenceExport(runId, exported.export.exportId);
    expect(downloaded).not.toBeNull();
    expect(downloaded!.file.exists).toBe(true);
    expect(downloaded!.file.path).toBe(exportFilePath);
    expect(downloaded!.content.length).toBeGreaterThan(0);
    expect(createHash("sha256").update(downloaded!.content).digest("hex")).toBe(
      exported.export.checksum,
    );

    db.close();
  });
});

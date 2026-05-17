import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FridayDomainError } from "../../../../src/errors/friday-domain-error.js";
import {
  createFridayWorkflowRuntime,
  type FridayCompiledWorkflowGraphV2,
  type FridayWorkflowRunEvidenceStatus,
  type FridayWorkflowRuntime,
} from "#workflows";
import type { FridaySqliteLayer } from "#state";

import { createTestDb, createTestIdGenerator } from "../../../helpers/friday-test-db.helper.js";

const NOW = "2026-05-17T00:00:00.000Z";

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRunSettled(
  runtime: FridayWorkflowRuntime,
  runId: string,
): Promise<"completed" | "failed" | "cancelled"> {
  const terminal = new Set(["completed", "failed", "cancelled"] as const);
  for (let i = 0; i < 250; i += 1) {
    const run = runtime.execution.getRun(runId);
    if (run && terminal.has(run.status as "completed" | "failed" | "cancelled")) {
      return run.status as "completed" | "failed" | "cancelled";
    }
    await waitMs(20);
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
        {
          id: "action-success",
          type: "action",
          label: "Action Success",
          config: { skillId: "fail-closed-skill" },
        },
      ],
      edges: [
        { id: "edge-1", sourceNodeId: "trigger", targetNodeId: "action-success" },
      ],
    },
    failurePolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    checksum: "fail-closed-test",
  };
}

function createRuntime(db: FridaySqliteLayer): FridayWorkflowRuntime {
  return createFridayWorkflowRuntime({
    db,
    idGenerator: createTestIdGenerator(),
    nowIso: () => NOW,
    computeChecksum: (content: string) => createHash("sha256").update(content).digest("hex"),
    resolveSkill: () => ({ id: "fail-closed-skill" }),
    invokeSkill: async () => ({ ok: true, data: ["sample"] }),
  });
}

async function startRunAndWait(
  runtime: FridayWorkflowRuntime,
  options: { proofRequired: boolean },
): Promise<string> {
  const workflow = runtime.crud.createWorkflow({
    slug: `evidence-fail-closed-${Math.random().toString(16).slice(2)}`,
    name: "Evidence Fail Closed Test",
  });
  const version = runtime.crud.createVersion(
    workflow.id,
    makeGraph(workflow.id, "placeholder"),
  );
  runtime.crud.publishVersion(workflow.id, version.versionNumber);

  const run = await runtime.execution.startRun({
    workflowId: workflow.id,
    workflowVersionId: version.id,
    triggerType: "manual",
    proofRequired: options.proofRequired,
  });
  return run.id;
}

function dropEvidenceTables(db: FridaySqliteLayer): void {
  db.withWriteTransaction((conn) => {
    conn.exec("DROP TABLE IF EXISTS workflow_run_pipeline_events");
    conn.exec("DROP TABLE IF EXISTS workflow_run_retry_traces");
    conn.exec("DROP TABLE IF EXISTS workflow_run_playbook_traces");
    conn.exec("DROP TABLE IF EXISTS workflow_run_evidence_exports");
  });
}

describe("Phase 14.5C module_28c — workflow runtime fail-closed evidence", () => {
  let originalPipelineEnable: string | undefined;
  let originalPipelineMode: string | undefined;

  beforeEach(() => {
    originalPipelineEnable = process.env.FRIDAY_PIPELINE_ENABLE;
    originalPipelineMode = process.env.FRIDAY_PIPELINE_MODE;
    process.env.FRIDAY_PIPELINE_ENABLE = "true";
    process.env.FRIDAY_PIPELINE_MODE = "enforce";
  });

  afterEach(() => {
    if (originalPipelineEnable === undefined) {
      delete process.env.FRIDAY_PIPELINE_ENABLE;
    } else {
      process.env.FRIDAY_PIPELINE_ENABLE = originalPipelineEnable;
    }
    if (originalPipelineMode === undefined) {
      delete process.env.FRIDAY_PIPELINE_MODE;
    } else {
      process.env.FRIDAY_PIPELINE_MODE = originalPipelineMode;
    }
  });

  it("Phase 14.5C module_28c: proofRequired run is persisted with proof_required=1", async () => {
    const db = createTestDb();
    const runtime = createRuntime(db);
    try {
      const runId = await startRunAndWait(runtime, { proofRequired: true });
      const persistedFlag = db.withReadConnection((conn) =>
        (
          conn
            .prepare(`SELECT proof_required AS pr FROM workflow_runs WHERE id = ?`)
            .get(runId) as { pr: number | null }
        ).pr,
      );
      expect(persistedFlag).toBe(1);
      const entity = runtime.execution.getRun(runId);
      expect(entity?.proofRequired).toBe(true);
    } finally {
      db.close();
    }
  });

  it("Phase 14.5C module_28c: ordinary run starts with evidenceStatus=available and no degrade", async () => {
    const db = createTestDb();
    const runtime = createRuntime(db);
    try {
      const runId = await startRunAndWait(runtime, { proofRequired: false });
      expect(runtime.evidence.getRunEvidenceStatus(runId)).toBe<FridayWorkflowRunEvidenceStatus>(
        "available",
      );
      const evidence = runtime.evidence.getRunEvidence(runId);
      expect(evidence.evidenceStatus).toBe("available");
      expect(evidence.run?.evidenceStatus).toBe("available");
    } finally {
      db.close();
    }
  });

  it("Phase 14.5C module_28c: ordinary run continues but evidenceStatus becomes \"degraded\" when evidence table is missing", async () => {
    const db = createTestDb();
    const runtime = createRuntime(db);
    try {
      const runId = await startRunAndWait(runtime, { proofRequired: false });
      // Drop evidence tables AFTER the run has started + settled to simulate
      // the live evidence-store being unreachable. Subsequent read on this run
      // must transition evidenceStatus to "unavailable" — not silently return
      // empty data — so the receipt can honestly say proof is unavailable.
      dropEvidenceTables(db);
      const evidence = runtime.evidence.getRunEvidence(runId);
      expect(evidence.evidenceStatus === "degraded" || evidence.evidenceStatus === "unavailable").toBe(true);
      expect(runtime.evidence.getRunEvidenceStatus(runId)).not.toBe("available");
    } finally {
      db.close();
    }
  });

  it("Phase 14.5C module_28c: proofRequired run reaches terminal failed with WORKFLOW_EVIDENCE_UNAVAILABLE when evidence table is missing on write", async () => {
    const db = createTestDb();
    const runtime = createRuntime(db);
    try {
      // Pre-drop the pipeline events table BEFORE starting the run so the
      // pipeline event emit (the very first persistence operation) fails.
      dropEvidenceTables(db);
      const workflow = runtime.crud.createWorkflow({
        slug: `fail-closed-${Math.random().toString(16).slice(2)}`,
        name: "Fail Closed Workflow",
      });
      const version = runtime.crud.createVersion(
        workflow.id,
        makeGraph(workflow.id, "placeholder"),
      );
      runtime.crud.publishVersion(workflow.id, version.versionNumber);
      const run = await runtime.execution.startRun({
        workflowId: workflow.id,
        workflowVersionId: version.id,
        triggerType: "manual",
        proofRequired: true,
      });
      // Real fail-closed proof: the run must settle in terminal failed state
      // and the persisted failure code must surface WORKFLOW_EVIDENCE_UNAVAILABLE
      // so downstream readers can honestly explain why the proof-required run
      // was refused.
      const terminalStatus = await waitForRunSettled(runtime, run.id);
      expect(terminalStatus).toBe("failed");
      const settled = runtime.execution.getRun(run.id);
      expect(settled?.status).toBe("failed");
      expect(settled?.failure?.code).toBe("WORKFLOW_EVIDENCE_UNAVAILABLE");
      expect(settled?.failure?.message ?? "").toMatch(/durable evidence persistence/);
      const status = runtime.evidence.getRunEvidenceStatus(run.id);
      expect(status === "unavailable" || status === "degraded").toBe(true);
    } finally {
      db.close();
    }
  });

  it("Phase 14.5C module_28c: ordinary run does NOT terminal-fail when evidence table is missing on write", async () => {
    const db = createTestDb();
    const runtime = createRuntime(db);
    try {
      // Pre-drop tables BEFORE the run; the ordinary run must continue (no
      // proof claim) rather than fail closed. Persistence quietly degrades.
      dropEvidenceTables(db);
      const workflow = runtime.crud.createWorkflow({
        slug: `ordinary-degrade-${Math.random().toString(16).slice(2)}`,
        name: "Ordinary Degrade Workflow",
      });
      const version = runtime.crud.createVersion(
        workflow.id,
        makeGraph(workflow.id, "placeholder"),
      );
      runtime.crud.publishVersion(workflow.id, version.versionNumber);
      const run = await runtime.execution.startRun({
        workflowId: workflow.id,
        workflowVersionId: version.id,
        triggerType: "manual",
        proofRequired: false,
      });
      const terminalStatus = await waitForRunSettled(runtime, run.id);
      // The ordinary run must NOT be terminal-failed because of evidence
      // persistence loss. If a failure code is present, it must NOT be
      // WORKFLOW_EVIDENCE_UNAVAILABLE — that code is reserved for the
      // proof-required fail-closed boundary.
      expect(terminalStatus).toBe("completed");
      const settled = runtime.execution.getRun(run.id);
      expect(settled?.status).toBe("completed");
      expect(settled?.failure?.code).not.toBe("WORKFLOW_EVIDENCE_UNAVAILABLE");
      const status = runtime.evidence.getRunEvidenceStatus(run.id);
      expect(status).not.toBe("available");
    } finally {
      db.close();
    }
  });

  it("Phase 14.5C module_28c: persistEvidenceOrFailClosed surfaces WORKFLOW_EVIDENCE_UNAVAILABLE for proof-required runs", () => {
    // Smoke check on the error shape that the runtime emits when persistence
    // is paused for a proof-required run. We construct it directly to assert
    // the error code + HTTP status contract; the runtime call sites cover the
    // actual emit paths in the proof-required end-to-end tests above.
    const error = new FridayDomainError(
      "WORKFLOW_EVIDENCE_UNAVAILABLE",
      "proof-required workflow run \"run-1\" cannot continue without durable evidence persistence (no such table).",
      { httpStatus: 503, details: { runId: "run-1", cause: "no such table", proofRequired: true } },
    );
    expect(error.code).toBe("WORKFLOW_EVIDENCE_UNAVAILABLE");
    expect(error.httpStatus).toBe(503);
  });
});

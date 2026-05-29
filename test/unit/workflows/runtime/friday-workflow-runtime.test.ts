import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FridayDomainError } from "../../../../src/errors/friday-domain-error.js";
import {
  createFridayWorkflowRuntime,
  type FridayCompiledWorkflowGraphV2,
  type FridayWorkflowRunEvidenceStatus,
  type FridayWorkflowRuntime,
} from "#workflows";
import { FRIDAY_FS_WRITE_TARGET_ARG_KEY } from "../../../../src/workflows/runtime/friday-workflow-fs-write-verifier.js";
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
    // Read-only (informational) skill: this suite tests evidence-PERSISTENCE
    // fail-closed, not side-effect verification, so the action node is a benign
    // read skill (audit C: read/receive grants → informational → verified, so the
    // node-acceptance classifier does not downgrade these runs).
    resolveSkill: () => ({ id: "fail-closed-skill", manifest: { permissions: { grants: [{ action: "read" }] } } }),
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

// ─── Audit C Stage 2A: filesystem-write evidence → verified (real fs delta) ───

/**
 * End-to-end through the REAL runtime (no mock of the verifier): a workflow node
 * declares a binding write target; a faithful write-class skill fixture ACTUALLY
 * writes that file; the runtime re-reads + checksums the declared target and
 * upgrades the node's deferred `proof_pending` to `verified`, which flows to the
 * run-level `getRunCompletionVerification`. Negative cases prove the run stays
 * `proof_pending` whenever a genuine, in-scope, non-self-receipt fs delta is
 * absent.
 */
describe("audit C Stage 2A — runtime fs-write verification (real fs delta → verified)", () => {
  let envEnable: string | undefined;
  let envMode: string | undefined;
  let workspaceDir: string;
  let skillDir: string;

  beforeEach(() => {
    envEnable = process.env.FRIDAY_PIPELINE_ENABLE;
    envMode = process.env.FRIDAY_PIPELINE_MODE;
    process.env.FRIDAY_PIPELINE_ENABLE = "true";
    process.env.FRIDAY_PIPELINE_MODE = "enforce";
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "s2a-rt-ws-"));
    skillDir = fs.mkdtempSync(path.join(os.tmpdir(), "s2a-rt-skill-"));
  });
  afterEach(() => {
    if (envEnable === undefined) delete process.env.FRIDAY_PIPELINE_ENABLE; else process.env.FRIDAY_PIPELINE_ENABLE = envEnable;
    if (envMode === undefined) delete process.env.FRIDAY_PIPELINE_MODE; else process.env.FRIDAY_PIPELINE_MODE = envMode;
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(skillDir, { recursive: true, force: true });
  });

  // A faithful write-class skill manifest: read + write, scoped to `out` under
  // the workspace, NO send/connect/capture/execute (a valid fs-write candidate).
  const writeManifest = (extraActions: string[] = []) => ({
    permissions: {
      grants: [
        { resource: "filesystem", action: "read" },
        { resource: "filesystem", action: "write", selectors: { pathPrefixes: ["${workspaceDir}/out"] } },
        ...extraActions.map((a) => ({ action: a })),
      ],
    },
  });

  type SkillSpec = {
    manifest: ReturnType<typeof writeManifest>;
    /** What the invocation actually does — controls the real fs delta. */
    behavior:
      | { kind: "write-target" } // honestly writes the declared target file
      | { kind: "lie" } // returns a receipt but writes NOTHING
      | { kind: "write-elsewhere"; rel: string } // writes a DIFFERENT file
      | { kind: "self-receipt" }; // writes the target AND returns it as its own artifact uri
  };

  function buildRuntime(specs: Record<string, SkillSpec>): FridayWorkflowRuntime {
    return createFridayWorkflowRuntime({
      db: createTestDb(),
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      computeChecksum: (c) => createHash("sha256").update(c).digest("hex"),
      workspaceDir,
      resolveSkill: (skillId) =>
        specs[skillId] ? { id: skillId, skillDir, manifest: specs[skillId]!.manifest } : null,
      invokeSkill: async (skillId, _runId, _nodeId, payload) => {
        const spec = specs[skillId];
        if (!spec) return { ok: true };
        // The binding target reaches the skill as a LITERAL absolute path (it
        // transits the node executor's `resolveArgs` untouched — it is not
        // `$`-prefixed). The skill resolves its own write location from it.
        const declared = String(payload[FRIDAY_FS_WRITE_TARGET_ARG_KEY] ?? "");
        const resolveDeclared = (d: string) => (path.isAbsolute(d) ? d : path.join(workspaceDir, d));
        switch (spec.behavior.kind) {
          case "write-target": {
            const abs = resolveDeclared(declared);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, JSON.stringify({ wrote: true, at: NOW }), "utf8");
            return { summary: "wrote managed doc", details: { changedPath: declared } };
          }
          case "lie":
            // Returns a plausible receipt but writes NOTHING.
            return { summary: "wrote managed doc", details: { changedPath: declared, runPath: path.join(workspaceDir, "out", "receipt.json") } };
          case "write-elsewhere": {
            const abs = resolveDeclared(spec.behavior.rel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, "elsewhere", "utf8");
            return { summary: "wrote elsewhere" };
          }
          case "self-receipt": {
            const abs = resolveDeclared(declared);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, JSON.stringify({ receipt: true }), "utf8");
            // The skill RETURNS the declared target as its own artifact — circular.
            return { summary: "wrote receipt", details: { runPath: abs } };
          }
        }
      },
    });
  }

  function graph(
    workflowId: string,
    nodes: Array<{ id: string; skillId: string; target?: string }>,
  ): FridayCompiledWorkflowGraphV2 {
    const actionNodes = nodes.map((n) => ({
      id: n.id,
      type: "action" as const,
      label: n.id,
      config: { skillId: n.skillId, args: n.target ? { [FRIDAY_FS_WRITE_TARGET_ARG_KEY]: n.target } : {} },
    }));
    const edges = actionNodes.map((n, i) => ({
      id: `e${i}`,
      sourceNodeId: i === 0 ? "trigger" : actionNodes[i - 1]!.id,
      targetNodeId: n.id,
    }));
    return {
      schemaVersion: "2.0",
      workflowId,
      workflowVersionId: "placeholder",
      sourceSpecSchemaVersion: "1.0",
      graph: {
        nodes: [{ id: "trigger", type: "trigger", label: "Trigger", config: {} }, ...actionNodes],
        edges,
      },
      failurePolicy: { onFailure: "fail_fast", notifyUser: false },
      tests: [],
      checksum: "s2a-rt",
    };
  }

  async function runAndGetVerification(
    runtime: FridayWorkflowRuntime,
    nodes: Array<{ id: string; skillId: string; target?: string }>,
  ): Promise<{ status: string; verification: string; runId: string }> {
    const wf = runtime.crud.createWorkflow({ slug: `s2a-${Math.random().toString(16).slice(2)}`, name: "s2a" });
    const v = runtime.crud.createVersion(wf.id, graph(wf.id, nodes));
    runtime.crud.publishVersion(wf.id, v.versionNumber);
    const run = await runtime.execution.startRun({ workflowId: wf.id, workflowVersionId: v.id, triggerType: "manual" });
    const status = await waitForRunSettled(runtime, run.id);
    return { status, verification: runtime.evidence.getRunCompletionVerification(run.id), runId: run.id };
  }

  it("POSITIVE: skill honestly writes the declared target → run completion verified", async () => {
    const runtime = buildRuntime({ "doc-writer": { manifest: writeManifest(), behavior: { kind: "write-target" } } });
    const r = await runAndGetVerification(runtime, [
      { id: "act", skillId: "doc-writer", target: path.join(workspaceDir, "out", "report.json") },
    ]);
    expect(r.status).toBe("completed");
    expect(r.verification).toBe("verified");
    // Real fs delta really happened.
    expect(fs.existsSync(path.join(workspaceDir, "out", "report.json"))).toBe(true);
  });

  it("NEGATIVE: skill lies (writes nothing) → proof_pending", async () => {
    const runtime = buildRuntime({ "doc-writer": { manifest: writeManifest(), behavior: { kind: "lie" } } });
    const r = await runAndGetVerification(runtime, [
      { id: "act", skillId: "doc-writer", target: path.join(workspaceDir, "out", "report.json") },
    ]);
    expect(r.status).toBe("completed");
    expect(r.verification).toBe("proof_pending");
    expect(fs.existsSync(path.join(workspaceDir, "out", "report.json"))).toBe(false);
  });

  it("NEGATIVE: skill writes a DIFFERENT file than the declared target → proof_pending", async () => {
    const runtime = buildRuntime({
      "doc-writer": { manifest: writeManifest(), behavior: { kind: "write-elsewhere", rel: path.join(workspaceDir, "out", "other.json") } },
    });
    const r = await runAndGetVerification(runtime, [
      { id: "act", skillId: "doc-writer", target: path.join(workspaceDir, "out", "report.json") },
    ]);
    expect(r.verification).toBe("proof_pending");
  });

  it("REFUSE: out-of-scope declared target (outside the manifest write scope) → proof_pending", async () => {
    const runtime = buildRuntime({ "doc-writer": { manifest: writeManifest(), behavior: { kind: "write-target" } } });
    const r = await runAndGetVerification(runtime, [
      // Target is under `escape/`, NOT the declared `out/` write scope.
      { id: "act", skillId: "doc-writer", target: path.join(workspaceDir, "escape", "report.json") },
    ]);
    expect(r.verification).toBe("proof_pending");
  });

  it("REFUSE: skill self-receipt (target == returned artifact uri) → proof_pending", async () => {
    const runtime = buildRuntime({ "doc-writer": { manifest: writeManifest(), behavior: { kind: "self-receipt" } } });
    const r = await runAndGetVerification(runtime, [
      { id: "act", skillId: "doc-writer", target: path.join(workspaceDir, "out", "report.json") },
    ]);
    expect(r.verification).toBe("proof_pending");
  });

  it("NOT A CANDIDATE: write+send skill stays proof_pending (never verified)", async () => {
    const runtime = buildRuntime({
      "doc-sender": { manifest: writeManifest(["send"]), behavior: { kind: "write-target" } },
    });
    const r = await runAndGetVerification(runtime, [
      { id: "act", skillId: "doc-sender", target: path.join(workspaceDir, "out", "report.json") },
    ]);
    expect(r.verification).toBe("proof_pending");
  });

  it("INERT: write skill with no declared binding target stays proof_pending", async () => {
    const runtime = buildRuntime({ "doc-writer": { manifest: writeManifest(), behavior: { kind: "write-target" } } });
    const r = await runAndGetVerification(runtime, [{ id: "act", skillId: "doc-writer" }]);
    expect(r.verification).toBe("proof_pending");
  });

  it("MIXED RUN: verified fs-write + a send-class node → run aggregate proof_pending (worst-wins)", async () => {
    const runtime = buildRuntime({
      "doc-writer": { manifest: writeManifest(), behavior: { kind: "write-target" } },
      "sender": { manifest: { permissions: { grants: [{ action: "send" }] } } as ReturnType<typeof writeManifest>, behavior: { kind: "lie" } },
    });
    const r = await runAndGetVerification(runtime, [
      { id: "fswrite", skillId: "doc-writer", target: path.join(workspaceDir, "out", "report.json") },
      { id: "send", skillId: "sender" },
    ]);
    expect(r.status).toBe("completed");
    expect(r.verification).toBe("proof_pending");
    // The fs-write itself really happened — the run is only proof_pending
    // because of the co-resident send node (worst-wins), not the fs node.
    expect(fs.existsSync(path.join(workspaceDir, "out", "report.json"))).toBe(true);
  });

  it("!pipelineEnabled: an fs-write candidate run is proof_pending (legacy path, no re-read)", async () => {
    process.env.FRIDAY_PIPELINE_ENABLE = "false";
    const runtime = buildRuntime({ "doc-writer": { manifest: writeManifest(), behavior: { kind: "write-target" } } });
    const r = await runAndGetVerification(runtime, [
      { id: "act", skillId: "doc-writer", target: path.join(workspaceDir, "out", "report.json") },
    ]);
    expect(r.verification).toBe("proof_pending");
  });
});

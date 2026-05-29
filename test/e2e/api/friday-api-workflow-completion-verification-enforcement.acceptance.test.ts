/**
 * Audit C part-2 acceptance test — RUN-LEVEL completion-verification
 * enforcement, end-to-end against the real workflow runtime and the real task
 * workflow service (no mocks of the verifier path).
 *
 * Proves the enforcement is real, not merely a label:
 *  - a side-effect run (a node whose skill declares a side-effecting grant, or
 *    whose skill cannot be resolved — fail-closed) settles `completed` with
 *    healthy persistence (`evidenceStatus === "available"`) yet a
 *    `proof_pending` completion, and verifyClaim REFUSES a workflow_run_evidence
 *    ref pointing at it with the DISTINCT code
 *    TASK_WORKFLOW_CLAIM_WORKFLOW_RUN_COMPLETION_UNVERIFIED (409) — never the
 *    persistence code;
 *  - a read-only (informational) run is `verified` and verifyClaim SUCCEEDS
 *    (no over-blocking);
 *  - the mid-flight time-of-check race is closed at the source: a run that has
 *    not terminally `completed` reads non-verified, so verifyClaim refuses it.
 *
 * The lookups are wired exactly as the hub bootstrap wires them.
 */

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FridayDomainError } from "../../../src/errors/friday-domain-error.js";
import {
  createFridayTaskWorkflowRepository,
  createFridayTaskWorkflowService,
} from "../../../src/task-workflows/index.js";
import {
  createFridayWorkflowRuntime,
  type FridayCompiledWorkflowGraphV2,
  type FridayWorkflowRuntime,
} from "#workflows";
import type { FridaySqliteLayer } from "#state";

import {
  createTestDb,
  createTestIdGenerator,
} from "../../helpers/friday-test-db.helper.js";

const NOW = "2026-05-29T00:00:00.000Z";

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settle(runtime: FridayWorkflowRuntime, runId: string): Promise<string> {
  for (let i = 0; i < 250; i += 1) {
    const run = runtime.execution.getRun(runId);
    if (run && ["completed", "failed", "cancelled"].includes(run.status)) return run.status;
    await waitMs(20);
  }
  throw new Error(`run ${runId} did not settle`);
}

// Skill manifests keyed by id: `side-effect-skill` declares a side-effecting
// `send` grant; `read-only-skill` declares only `read`. `invokeSkill` returns a
// plausible non-empty output so the ONLY thing keeping the side-effect run from
// "verified" is the declared capability, not the (untrusted) output.
// `side-effect-skill` declares a side-effecting `send` grant; `read-only-skill`
// and `blocking-read-skill` declare only `read` (informational). The blocking
// skill is classified `verified`-eligible but its invocation blocks forever, so
// the run never settles — used to prove the mid-flight fail-closed behavior.
const MANIFESTS: Record<string, { permissions: { grants: Array<{ action: string }> } }> = {
  "side-effect-skill": { permissions: { grants: [{ action: "send" }] } },
  "read-only-skill": { permissions: { grants: [{ action: "read" }] } },
  "blocking-read-skill": { permissions: { grants: [{ action: "read" }] } },
};
const BLOCKING_SKILL_ID = "blocking-read-skill";

function graph(workflowId: string, skillId: string): FridayCompiledWorkflowGraphV2 {
  return {
    schemaVersion: "2.0",
    workflowId,
    workflowVersionId: "placeholder",
    sourceSpecSchemaVersion: "1.0",
    graph: {
      nodes: [
        { id: "trigger", type: "trigger", label: "Trigger", config: {} },
        { id: "act", type: "action", label: "Act", config: { skillId } },
      ],
      edges: [{ id: "e1", sourceNodeId: "trigger", targetNodeId: "act" }],
    },
    failurePolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    checksum: "c-part2-enforce",
  };
}

function publish(runtime: FridayWorkflowRuntime, slug: string, skillId: string): { workflowId: string; versionId: string } {
  const wf = runtime.crud.createWorkflow({ slug, name: slug });
  const v = runtime.crud.createVersion(wf.id, graph(wf.id, skillId));
  runtime.crud.publishVersion(wf.id, v.versionNumber);
  return { workflowId: wf.id, versionId: v.id };
}

describe("Audit C part-2: workflow completion-verification run-level enforcement", () => {
  let envEnable: string | undefined;
  let envMode: string | undefined;
  let release: (() => void) | null = null;

  beforeEach(() => {
    envEnable = process.env.FRIDAY_PIPELINE_ENABLE;
    envMode = process.env.FRIDAY_PIPELINE_MODE;
    process.env.FRIDAY_PIPELINE_ENABLE = "true";
    process.env.FRIDAY_PIPELINE_MODE = "enforce";
  });
  afterEach(() => {
    release?.();
    release = null;
    if (envEnable === undefined) delete process.env.FRIDAY_PIPELINE_ENABLE; else process.env.FRIDAY_PIPELINE_ENABLE = envEnable;
    if (envMode === undefined) delete process.env.FRIDAY_PIPELINE_MODE; else process.env.FRIDAY_PIPELINE_MODE = envMode;
  });

  function buildRuntime(db: FridaySqliteLayer, opts?: { gate?: Promise<void> }): FridayWorkflowRuntime {
    return createFridayWorkflowRuntime({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      computeChecksum: (c) => createHash("sha256").update(c).digest("hex"),
      resolveSkill: (skillId) => (MANIFESTS[skillId] ? { id: skillId, manifest: MANIFESTS[skillId] } : null),
      invokeSkill: async (skillId: string) => {
        if (skillId === BLOCKING_SKILL_ID && opts?.gate) await opts.gate;
        return { ok: true, sent: true };
      },
    });
  }

  function buildService(db: FridaySqliteLayer, runtime: FridayWorkflowRuntime) {
    let nextId = 0;
    return createFridayTaskWorkflowService({
      db,
      repository: createFridayTaskWorkflowRepository(),
      idGenerator: () => {
        nextId += 1;
        return `tw-id-${String(nextId).padStart(6, "0")}`;
      },
      nowIso: () => NOW,
      // Wired exactly as the hub bootstrap wires both orthogonal lookups.
      getWorkflowRunEvidenceStatus: (runId) => runtime.evidence.getRunEvidenceStatus(runId),
      getWorkflowRunCompletionVerification: (runId) => runtime.evidence.getRunCompletionVerification(runId),
    });
  }

  function attachAndVerify(
    service: ReturnType<typeof buildService>,
    runId: string,
    claimText: string,
  ): { error: FridayDomainError | null; verifiedStatus?: string } {
    const tw = service.create({
      charter: "audit C part-2 completion enforcement",
      taskKind: "general",
      contextPackage: { allowedFiles: ["src/x.ts"], allowedTools: [], allowedApis: [], boundaryIds: ["api.task_workflows.core"] },
    });
    const claim = service.draftClaim(tw.id, { claimText, claimKind: "runtime_evidence" });
    service.attachEvidenceRef(tw.id, claim.id, {
      refKind: "workflow_run_evidence",
      refId: runId,
      refSource: "workflow_run_evidence",
    });
    try {
      const verified = service.verifyClaim(tw.id, claim.id, { verifierVerdict: "fresh-read" });
      return { error: null, verifiedStatus: verified.status };
    } catch (error) {
      return { error: error as FridayDomainError };
    }
  }

  it("side-effect run: completed + evidence available + completion proof_pending; verifyClaim REFUSED with the DISTINCT code", async () => {
    const db = createTestDb();
    const runtime = buildRuntime(db);
    const service = buildService(db, runtime);
    try {
      const { workflowId, versionId } = publish(runtime, "ce-side-effect", "side-effect-skill");
      const run = await runtime.execution.startRun({ workflowId, workflowVersionId: versionId, triggerType: "manual" });
      expect(await settle(runtime, run.id)).toBe("completed");

      // Orthogonality: persistence healthy, completion not verified.
      expect(runtime.evidence.getRunEvidenceStatus(run.id)).toBe("available");
      expect(runtime.evidence.getRunCompletionVerification(run.id)).toBe("proof_pending");

      const { error } = attachAndVerify(service, run.id, "claim backed by side-effect run");
      expect(error).toBeInstanceOf(FridayDomainError);
      expect(error?.code).toBe("TASK_WORKFLOW_CLAIM_WORKFLOW_RUN_COMPLETION_UNVERIFIED");
      expect(error?.httpStatus).toBe(409);
      // DISTINCT from the persistence refusal — never "persistence degraded".
      expect(error?.code).not.toBe("TASK_WORKFLOW_CLAIM_WORKFLOW_RUN_EVIDENCE_UNAVAILABLE");
    } finally {
      db.close();
    }
  });

  it("fail-closed: unresolved-skill action run is also proof_pending → verifyClaim refused", async () => {
    const db = createTestDb();
    const runtime = buildRuntime(db);
    const service = buildService(db, runtime);
    try {
      const { workflowId, versionId } = publish(runtime, "ce-unresolved", "ghost-skill"); // not in MANIFESTS
      const run = await runtime.execution.startRun({ workflowId, workflowVersionId: versionId, triggerType: "manual" });
      await settle(runtime, run.id);
      expect(runtime.evidence.getRunCompletionVerification(run.id)).toBe("proof_pending");
      const { error } = attachAndVerify(service, run.id, "claim backed by unresolved-skill run");
      expect(error?.code).toBe("TASK_WORKFLOW_CLAIM_WORKFLOW_RUN_COMPLETION_UNVERIFIED");
    } finally {
      db.close();
    }
  });

  it("read-only run: completion verified → verifyClaim SUCCEEDS (no over-blocking)", async () => {
    const db = createTestDb();
    const runtime = buildRuntime(db);
    const service = buildService(db, runtime);
    try {
      const { workflowId, versionId } = publish(runtime, "ce-read-only", "read-only-skill");
      const run = await runtime.execution.startRun({ workflowId, workflowVersionId: versionId, triggerType: "manual" });
      expect(await settle(runtime, run.id)).toBe("completed");
      expect(runtime.evidence.getRunCompletionVerification(run.id)).toBe("verified");
      const { error, verifiedStatus } = attachAndVerify(service, run.id, "claim backed by read-only run");
      expect(error).toBeNull();
      expect(verifiedStatus).toBe("verified");
    } finally {
      db.close();
    }
  });

  it("mid-flight TOCTOU closed: a run that has NOT terminally completed reads non-verified → verifyClaim refused", async () => {
    const db = createTestDb();
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((res) => {
      releaseGate = res;
    });
    release = releaseGate; // ensure afterEach unblocks even if an assertion throws
    const runtime = buildRuntime(db, { gate });
    const service = buildService(db, runtime);
    try {
      // A read-only-classified run, but its action node blocks forever (mid-flight).
      const { workflowId, versionId } = publish(runtime, "ce-midflight", BLOCKING_SKILL_ID);
      const run = await runtime.execution.startRun({ workflowId, workflowVersionId: versionId, triggerType: "manual" });
      await waitMs(80); // let the run start; the action node is now blocked, run NOT terminal.

      const liveRun = runtime.execution.getRun(run.id);
      expect(liveRun?.status).not.toBe("completed"); // genuinely mid-flight
      // Fail-closed at the source: a non-settled run is never "verified".
      expect(runtime.evidence.getRunCompletionVerification(run.id)).not.toBe("verified");

      const { error } = attachAndVerify(service, run.id, "claim backed by still-executing run");
      expect(error).toBeInstanceOf(FridayDomainError);
      expect(error?.code).toBe("TASK_WORKFLOW_CLAIM_WORKFLOW_RUN_COMPLETION_UNVERIFIED");

      releaseGate();
      await settle(runtime, run.id);
    } finally {
      releaseGate();
      db.close();
    }
  });
});

/**
 * Phase 14.5D module_28d acceptance test — end-to-end rollback matrix
 * closeout receipt proof.
 *
 * Drives the real workflow runtime + real task-workflow service (no mocks
 * of `createFridayTaskWorkflowService`, its repository, or the closeout
 * gate evaluators). Each scenario exercises one rollback class through
 * the live closeout path:
 *   * reversible_local — verified claim backed by agent_run_event refs.
 *   * compensating_action_required — verified claim backed by a
 *     workflow_run_evidence ref to a healthy upstream run.
 *   * non_reversible_external — verified claim with an external
 *     manual_external ref planted via the repository (the verify path
 *     only accepts evidence-bearing refs; the disclosure path is what
 *     14.5D module_28d productizes).
 *   * not_applicable — workflow with no verified/blocked claims.
 *
 * Mirrors Stage 2 Slice 6.5 of
 * `PHASE_14_5D_STAGE_2_SCOPE_RECONCILIATION_MATRIX_2026-05-17.md`.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

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

const NOW = "2026-05-17T05:00:00.000Z";

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
          config: { skillId: "rollback-matrix-skill" },
        },
      ],
      edges: [
        { id: "edge-1", sourceNodeId: "trigger", targetNodeId: "action-success" },
      ],
    },
    failurePolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    checksum: "acceptance-test-rollback-matrix",
  };
}

function createRuntime(db: FridaySqliteLayer): FridayWorkflowRuntime {
  return createFridayWorkflowRuntime({
    db,
    idGenerator: createTestIdGenerator(),
    nowIso: () => NOW,
    computeChecksum: (content) => createHash("sha256").update(content).digest("hex"),
    resolveSkill: () => ({ id: "rollback-matrix-skill" }),
    invokeSkill: async () => ({ ok: true }),
  });
}

async function publishWorkflowAndGetVersionId(
  runtime: FridayWorkflowRuntime,
  slug: string,
): Promise<{ workflowId: string; versionId: string }> {
  const workflow = runtime.crud.createWorkflow({ slug, name: slug });
  const version = runtime.crud.createVersion(
    workflow.id,
    makeGraph(workflow.id, "placeholder"),
  );
  runtime.crud.publishVersion(workflow.id, version.versionNumber);
  return { workflowId: workflow.id, versionId: version.id };
}

describe("Phase 14.5D module_28d: rollback matrix closeout receipt acceptance", () => {
  it(
    "(a) not_applicable when no verified or blocked claims exist on the workflow",
    async () => {
      const db = createTestDb();
      const runtime = createRuntime(db);
      const taskWorkflowRepository = createFridayTaskWorkflowRepository();
      let nextId = 0;
      const taskWorkflowService = createFridayTaskWorkflowService({
        db,
        repository: taskWorkflowRepository,
        idGenerator: () => {
          nextId += 1;
          return `tw-rm-${String(nextId).padStart(6, "0")}`;
        },
        nowIso: () => NOW,
        getWorkflowRunEvidenceStatus: (runId) =>
          runtime.evidence.getRunEvidenceStatus(runId),
      });
      try {
        const tw = taskWorkflowService.create({
          charter: "rollback matrix not_applicable path",
          taskKind: "general",
          contextPackage: {
            allowedFiles: ["src/x.ts"],
            allowedTools: [],
            allowedApis: [],
            boundaryIds: ["api.task_workflows.core"],
          },
        });
        const receipt = taskWorkflowService.closeout(tw.id);
        expect(receipt.rollbackClass).toBe("not_applicable");
        expect(receipt.compensatingAction).toBeNull();
        expect(receipt.nonReversibleReason).toBeNull();
        const gate = receipt.gateOutcomes.find(
          (g) => g.gateId === "rollback_class_disclosure_required",
        );
        expect(gate?.status).toBe("pass");
      } finally {
        db.close();
      }
    },
  );

  it(
    "(b) reversible_local when verified claim is backed by an agent_run_event ref",
    async () => {
      const db = createTestDb();
      const runtime = createRuntime(db);
      const taskWorkflowRepository = createFridayTaskWorkflowRepository();
      let nextId = 0;
      const taskWorkflowService = createFridayTaskWorkflowService({
        db,
        repository: taskWorkflowRepository,
        idGenerator: () => {
          nextId += 1;
          return `tw-rm-${String(nextId).padStart(6, "0")}`;
        },
        nowIso: () => NOW,
        getWorkflowRunEvidenceStatus: (runId) =>
          runtime.evidence.getRunEvidenceStatus(runId),
      });
      try {
        const tw = taskWorkflowService.create({
          charter: "rollback matrix reversible_local path",
          taskKind: "general",
          contextPackage: {
            allowedFiles: ["src/x.ts"],
            allowedTools: [],
            allowedApis: [],
            boundaryIds: ["api.task_workflows.core"],
          },
        });
        const claim = taskWorkflowService.draftClaim(tw.id, {
          claimText: "verified by local agent run event",
          claimKind: "runtime_evidence",
        });
        taskWorkflowService.attachEvidenceRef(tw.id, claim.id, {
          refKind: "agent_run.event",
          refId: "agent-evt-rev-1",
          refSource: "agent_run_event",
        });
        taskWorkflowService.verifyClaim(tw.id, claim.id, {
          verifierVerdict: "fresh-read agent_run_event evidence",
        });
        const receipt = taskWorkflowService.closeout(tw.id);
        expect(receipt.rollbackClass).toBe("reversible_local");
        expect(receipt.compensatingAction).toBeNull();
        expect(receipt.nonReversibleReason).toBeNull();
        const gate = receipt.gateOutcomes.find(
          (g) => g.gateId === "rollback_class_disclosure_required",
        );
        expect(gate?.status).toBe("pass");
        expect(receipt.status).toBe("complete");
      } finally {
        db.close();
      }
    },
  );

  it(
    "(c) compensating_action_required when verified claim is backed by a workflow_run_evidence ref to a healthy run",
    async () => {
      const db = createTestDb();
      const runtime = createRuntime(db);
      const taskWorkflowRepository = createFridayTaskWorkflowRepository();
      let nextId = 0;
      const taskWorkflowService = createFridayTaskWorkflowService({
        db,
        repository: taskWorkflowRepository,
        idGenerator: () => {
          nextId += 1;
          return `tw-rm-${String(nextId).padStart(6, "0")}`;
        },
        nowIso: () => NOW,
        getWorkflowRunEvidenceStatus: (runId) =>
          runtime.evidence.getRunEvidenceStatus(runId),
      });
      try {
        const { workflowId, versionId } = await publishWorkflowAndGetVersionId(
          runtime,
          "rollback-matrix-comp",
        );
        const healthyRun = await runtime.execution.startRun({
          workflowId,
          workflowVersionId: versionId,
          triggerType: "manual",
          proofRequired: false,
        });
        await waitMs(80);
        const tw = taskWorkflowService.create({
          charter: "rollback matrix compensating_action_required path",
          taskKind: "general",
          contextPackage: {
            allowedFiles: ["src/x.ts"],
            allowedTools: [],
            allowedApis: [],
            boundaryIds: ["api.task_workflows.core"],
          },
        });
        const claim = taskWorkflowService.draftClaim(tw.id, {
          claimText: "verified by workflow_run_evidence",
          claimKind: "runtime_evidence",
        });
        taskWorkflowService.attachEvidenceRef(tw.id, claim.id, {
          refKind: "workflow_run_evidence",
          refId: healthyRun.id,
          refSource: "workflow_run_evidence",
        });
        taskWorkflowService.verifyClaim(tw.id, claim.id, {
          verifierVerdict: "fresh-read healthy workflow_run",
        });
        const receipt = taskWorkflowService.closeout(tw.id);
        expect(receipt.rollbackClass).toBe("compensating_action_required");
        expect(receipt.compensatingAction).toMatch(/workflow_run_evidence/);
        expect(receipt.nonReversibleReason).toBeNull();
        const gate = receipt.gateOutcomes.find(
          (g) => g.gateId === "rollback_class_disclosure_required",
        );
        expect(gate?.status).toBe("pass");
      } finally {
        db.close();
      }
    },
  );

  it(
    "(d) non_reversible_external when verified claim references manual_external evidence (closeout disclosure boundary)",
    async () => {
      const db = createTestDb();
      const runtime = createRuntime(db);
      const taskWorkflowRepository = createFridayTaskWorkflowRepository();
      let nextId = 0;
      const taskWorkflowService = createFridayTaskWorkflowService({
        db,
        repository: taskWorkflowRepository,
        idGenerator: () => {
          nextId += 1;
          return `tw-rm-${String(nextId).padStart(6, "0")}`;
        },
        nowIso: () => NOW,
        getWorkflowRunEvidenceStatus: (runId) =>
          runtime.evidence.getRunEvidenceStatus(runId),
      });
      try {
        const tw = taskWorkflowService.create({
          charter: "rollback matrix non_reversible_external path",
          taskKind: "general",
          contextPackage: {
            allowedFiles: ["src/x.ts"],
            allowedTools: [],
            allowedApis: [],
            boundaryIds: ["api.task_workflows.core"],
          },
        });
        const claim = taskWorkflowService.draftClaim(tw.id, {
          claimText: "verified by agent run plus external action",
          claimKind: "runtime_evidence",
        });
        // Attach a compatible ref so verifyClaim succeeds via the service.
        taskWorkflowService.attachEvidenceRef(tw.id, claim.id, {
          refKind: "agent_run.event",
          refId: "agent-evt-pre-ext",
          refSource: "agent_run_event",
        });
        taskWorkflowService.verifyClaim(tw.id, claim.id, {
          verifierVerdict: "fresh-read pre-external evidence",
        });
        // Plant a manual_external ref through the repository to model the
        // closeout-time disclosure surface (verify path keeps the
        // evidence-bearing-claim-kind invariant via attachEvidenceRef).
        db.withWriteTransaction((conn) => {
          taskWorkflowRepository.insertEvidenceRef(conn, {
            id: "plant-ext-acc-1",
            workflowId: tw.id,
            claimId: claim.id,
            refKind: "external.message",
            refId: "ext-msg-acc-1",
            refHash: null,
            refSource: "manual_external",
            createdAt: NOW,
          });
          taskWorkflowRepository.incrementEvidenceRefCount(conn, claim.id, NOW);
        });
        const receipt = taskWorkflowService.closeout(tw.id);
        expect(receipt.rollbackClass).toBe("non_reversible_external");
        expect(receipt.nonReversibleReason).toMatch(/manual_external/);
        expect(receipt.compensatingAction).toBeNull();
        const gate = receipt.gateOutcomes.find(
          (g) => g.gateId === "rollback_class_disclosure_required",
        );
        expect(gate?.status).toBe("pass");
      } finally {
        db.close();
      }
    },
  );

  it(
    "(e) rollback fields round-trip through the repository after closeout",
    async () => {
      const db = createTestDb();
      const runtime = createRuntime(db);
      const taskWorkflowRepository = createFridayTaskWorkflowRepository();
      let nextId = 0;
      const taskWorkflowService = createFridayTaskWorkflowService({
        db,
        repository: taskWorkflowRepository,
        idGenerator: () => {
          nextId += 1;
          return `tw-rm-${String(nextId).padStart(6, "0")}`;
        },
        nowIso: () => NOW,
        getWorkflowRunEvidenceStatus: (runId) =>
          runtime.evidence.getRunEvidenceStatus(runId),
      });
      try {
        const tw = taskWorkflowService.create({
          charter: "rollback matrix persistence roundtrip",
          taskKind: "general",
          contextPackage: {
            allowedFiles: ["src/x.ts"],
            allowedTools: [],
            allowedApis: [],
            boundaryIds: ["api.task_workflows.core"],
          },
        });
        const claim = taskWorkflowService.draftClaim(tw.id, {
          claimText: "rollback fields persistence",
          claimKind: "runtime_evidence",
        });
        taskWorkflowService.attachEvidenceRef(tw.id, claim.id, {
          refKind: "agent_run.event",
          refId: "agent-evt-persist",
          refSource: "agent_run_event",
        });
        taskWorkflowService.verifyClaim(tw.id, claim.id, {
          verifierVerdict: "fresh-read for persistence",
        });
        const written = taskWorkflowService.closeout(tw.id);
        const reloaded = db.withReadConnection((conn) =>
          taskWorkflowRepository.getLatestCloseoutReceipt(conn, tw.id),
        );
        expect(reloaded).not.toBeNull();
        expect(reloaded!.rollbackClass).toBe(written.rollbackClass);
        expect(reloaded!.compensatingAction).toBe(written.compensatingAction);
        expect(reloaded!.nonReversibleReason).toBe(written.nonReversibleReason);
      } finally {
        db.close();
      }
    },
  );
});

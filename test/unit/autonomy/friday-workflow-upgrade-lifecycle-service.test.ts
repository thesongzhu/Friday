import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import type { FridaySqliteLayer } from "#state";
import { createFridayWorkflowCrudService, createFridayWorkflowRepository, type FridayCompiledWorkflowGraphV2 } from "#workflows";

import { createFridayWorkflowUpgradeLifecycleService } from "../../../src/autonomy/services/friday-workflow-upgrade-lifecycle-service.js";
import { createTestDb, createTestIdGenerator } from "../workflows/_helpers/create-test-db.helper.js";

describe("FridayWorkflowUpgradeLifecycleService", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createHarness() {
    const idGenerator = createTestIdGenerator();
    const workflowRepo = createFridayWorkflowRepository({ db });
    const workflowCrud = createFridayWorkflowCrudService({
      db,
      workflowRepo,
      idGenerator,
      nowIso: () => "2026-04-17T22:00:00.000Z",
      computeChecksum: (content: string) => createHash("sha256").update(content).digest("hex"),
      computeEtag: () => idGenerator().slice(0, 16),
    });

    const service = createFridayWorkflowUpgradeLifecycleService({
      db,
      workflowRepo,
      workflowCrud,
      nowIso: () => "2026-04-17T22:00:00.000Z",
    });

    return { workflowCrud, workflowRepo, service };
  }

  function makeGraph(workflowId: string, workflowVersionId: string, message: string): FridayCompiledWorkflowGraphV2 {
    return {
      schemaVersion: "2.0",
      workflowId,
      workflowVersionId,
      sourceSpecSchemaVersion: "1.0",
      graph: {
        nodes: [
          { id: "trigger", type: "trigger", label: "Trigger", config: {} },
          {
            id: "output",
            type: "data",
            label: "Output",
            config: {
              mapping: {
                message,
              },
            },
          },
        ],
        edges: [{ id: "edge-1", sourceNodeId: "trigger", targetNodeId: "output" }],
      },
      failurePolicy: { onFailure: "fail_fast", notifyUser: false },
      tests: [],
      checksum: "placeholder",
    };
  }

  it("tracks workflow upgrade lifecycle through shadow, canary, promote, and rollback", () => {
    const { workflowCrud, workflowRepo, service } = createHarness();

    const { workflow } = workflowCrud.createWorkflowWithVersion(
      { slug: "wf-upgrade", name: "WF Upgrade" },
      makeGraph("wf-upgrade", "wf-upgrade-v1", "version one"),
    );
    const versionTwo = workflowCrud.createVersion(
      workflow.id,
      makeGraph(workflow.id, "wf-upgrade-v2", "version two"),
    );

    const shadowed = service.registerShadowVersion({
      workflowId: workflow.id,
      workflowVersionId: versionTwo.id,
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
    });
    expect(shadowed.promotionChannel).toBe("shadow");
    expect(shadowed.shadowVersionId).toBe(versionTwo.id);

    const canary = service.recordCanaryResult({
      workflowId: workflow.id,
      success: true,
      evaluatedAt: "2026-04-17T22:01:00.000Z",
    });
    expect(canary.promotionChannel).toBe("canary");
    expect(canary.canaryStats?.sampleSize).toBe(1);
    expect(canary.canaryStats?.successCount).toBe(1);

    const promoted = service.promote({
      workflowId: workflow.id,
      versionNumber: versionTwo.versionNumber,
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
    });
    expect(promoted.promotionChannel).toBe("active");
    expect(promoted.lastVerifiedAt).toBe("2026-04-17T22:00:00.000Z");
    expect(promoted.lastVerifiedRuntimeVersion).toBe("f27377c");

    const activeWorkflow = db.withReadConnection((conn) => workflowRepo.getWorkflowById(conn, workflow.id));
    expect(activeWorkflow?.publishedVersionNumber).toBe(2);

    const rolledBack = service.rollback({
      workflowId: workflow.id,
      targetVersionNumber: 1,
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
    });
    expect(rolledBack.promotionChannel).toBe("rolled_back");
    expect(rolledBack.compatibilityStatus).toBe("adaptation_required");
    expect(rolledBack.shadowVersionId).toBeUndefined();
    expect(rolledBack.canaryStats?.rollbackCount).toBe(1);

    const rolledBackWorkflow = db.withReadConnection((conn) => workflowRepo.getWorkflowById(conn, workflow.id));
    expect(rolledBackWorkflow?.publishedVersionNumber).toBe(1);
  });
});

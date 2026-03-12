import { describe, expect, it, vi } from "vitest";
import type { FridayWorkflowBuilderRuntime, FridayWorkflowRuntime } from "#workflows";
import { createFridayWorkflowProductService } from "../../../src/workflows/services/friday-workflow-product-service.js";

const NOW = "2026-03-07T12:00:00.000Z";

function makeDeps() {
  const workflow = {
    id: "wf-1",
    slug: "release-flow",
    name: "Release Flow",
    description: "Deploy the release workflow",
    tags: ["release"],
    latestVersionNumber: 1,
    publishedVersionNumber: 1,
    isArchived: false,
    revision: 1,
    etag: "wf-etag",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const draft = {
    draftId: "draft-1",
    workflowId: "wf-1",
    title: "Release Draft",
    status: "active",
    revision: 1,
    spec: {
      schemaVersion: "1.0",
      workflowId: "wf-1",
      name: "Release Flow",
      description: "Deploy the release workflow",
      trigger: { type: "manual" },
      inputs: [],
      startStepId: "step-1",
      steps: [{ id: "step-1", type: "tool_call" }],
      edges: [],
      outputs: [],
      tests: [],
    },
    visual: {
      schemaVersion: "1.0",
      workflowId: "wf-1",
      viewport: { x: 0, y: 0, zoom: 1 },
      panelLayout: { leftOpen: true, rightOpen: true, bottomOpen: false },
      nodes: [{ nodeId: "step-1", x: 100, y: 120 }],
      edges: [],
    },
    createdAt: NOW,
    updatedAt: NOW,
    autosave: { enabled: true, intervalMs: 30000 },
  };
  const publishedVersion = {
    id: "version-1",
    workflowId: "wf-1",
    versionNumber: 1,
    checksum: "checksum-1",
    createdByUserId: "user-1",
    isPublished: true,
    changeNote: "Initial publish",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const run = {
    id: "run-1",
    workflowId: "wf-1",
    workflowVersionId: "version-1",
    triggerType: "manual",
    status: "completed",
    startedAt: NOW,
    finishedAt: NOW,
  };

  const builderRuntime = {
    drafts: {
      getDraft: vi.fn(() => draft),
      listDrafts: vi.fn(() => [draft]),
      createDraft: vi.fn(),
    },
    collaboration: {
      acquireLock: vi.fn(() => ({
        acquired: true,
        lock: {
          workflowId: "wf-1",
          lockToken: "lock-1",
          ownerUserId: "user-1",
          acquiredAt: NOW,
          heartbeatAt: NOW,
          expiresAt: NOW,
        },
      })),
      releaseLock: vi.fn(),
    },
    compositor: {
      compileDraft: vi.fn(() => ({
        compiled: { graph: { nodes: [], edges: [] } },
        validation: { valid: true, issues: [], generatedAt: NOW },
      })),
      publishDraft: vi.fn(() => ({
        workflowId: "wf-1",
        workflowVersionId: "version-1",
        versionNumber: 2,
        published: true,
        checksum: "checksum-2",
        validation: { valid: true, issues: [], generatedAt: NOW },
      })),
    },
    importExport: {
      exportDraft: vi.fn(() => ({
        bundleSchemaVersion: "1.0",
        exportedAt: NOW,
        source: { type: "draft", id: "draft-1", workflowId: "wf-1" },
        workflow: { name: "Release Flow" },
        spec: draft.spec,
        visual: draft.visual,
        checksum: "bundle-checksum",
      })),
    },
  } as unknown as FridayWorkflowBuilderRuntime;

  const workflowRuntime = {
    crud: {
      getWorkflow: vi.fn(() => workflow),
      listVersions: vi.fn(() => [publishedVersion]),
      getPublishedVersion: vi.fn(() => publishedVersion),
      getVersion: vi.fn(() => publishedVersion),
      getWorkflowBySlug: vi.fn(() => null),
      createWorkflow: vi.fn(),
    },
    execution: {
      startRun: vi.fn(async () => run),
      listRuns: vi.fn(() => [run]),
      getRunNodes: vi.fn(() => [
        {
          nodeId: "step-1",
          attempt: 1,
          status: "completed",
          updatedAt: NOW,
          finishedAt: NOW,
        },
      ]),
    },
    triggers: {
      syncPublishedVersionTriggers: vi.fn(async () => undefined),
    },
    evidence: {
      listRunEvidenceExports: vi.fn(() => []),
    },
  } as unknown as FridayWorkflowRuntime;

  const observability = {
    observeAsync: vi.fn(async (_input, work: () => Promise<unknown>) => await work()),
  };
  const selfHealing = {
    reportStructuredFailure: vi.fn(() => ({
      incidentsCreated: [{ incidentId: "incident-1" }],
    })),
  };

  return {
    service: createFridayWorkflowProductService({
      builderRuntime,
      workflowRuntime,
      observability: observability as never,
      selfHealing: selfHealing as never,
      db: { withReadConnection: (fn) => fn({} as never) },
      idGenerator: () => "id-1",
      nowIso: () => NOW,
    }),
    builderRuntime,
    workflowRuntime,
    observability,
    selfHealing,
  };
}

describe("createFridayWorkflowProductService", () => {
  it("deploys a draft through compile, publish, run, and export", async () => {
    const { service, builderRuntime, workflowRuntime, observability } = makeDeps();

    const deployment = await service.deployDraft({
      workflowId: "wf-1",
      draftId: "draft-1",
      actorUserId: "user-1",
      runNow: true,
      resyncTriggers: true,
      includeExport: true,
    });

    expect(builderRuntime.compositor.compileDraft).toHaveBeenCalledWith("draft-1");
    expect(builderRuntime.compositor.publishDraft).toHaveBeenCalled();
    expect(workflowRuntime.triggers.syncPublishedVersionTriggers).toHaveBeenCalledWith("wf-1");
    expect(workflowRuntime.execution.startRun).toHaveBeenCalled();
    expect(builderRuntime.importExport.exportDraft).toHaveBeenCalledWith("draft-1");
    expect(observability.observeAsync).toHaveBeenCalled();
    expect(deployment.workflowVersionId).toBe("version-1");
    expect(deployment.run?.id).toBe("run-1");
    expect(deployment.exportBundle?.checksum).toBe("bundle-checksum");
  });

  it("reports structured failures when deploy compilation is blocked", async () => {
    const { service, builderRuntime, selfHealing } = makeDeps();
    vi.mocked(builderRuntime.compositor.compileDraft).mockReturnValueOnce({
      compiled: { graph: { nodes: [], edges: [] } },
      validation: {
        valid: false,
        issues: [{ code: "INVALID", stage: "graph_compile", severity: "error", message: "bad graph" }],
        generatedAt: NOW,
      },
    });

    await expect(
      service.deployDraft({
        workflowId: "wf-1",
        draftId: "draft-1",
        actorUserId: "user-1",
      }),
    ).rejects.toThrow("compile successfully");

    expect(selfHealing.reportStructuredFailure).toHaveBeenCalled();
  });

  it("builds overview and visualization from the same workflow truth", () => {
    const { service } = makeDeps();

    const overview = service.getOverview({ workflowId: "wf-1", recentRunLimit: 4 });
    const visualization = service.getVisualization({ workflowId: "wf-1", draftId: "draft-1", timelineLimit: 8 });

    expect(overview.workflow.id).toBe("wf-1");
    expect(overview.latestDraft?.draftId).toBe("draft-1");
    expect(visualization.workflow.id).toBe("wf-1");
    expect(visualization.draft?.draftId).toBe("draft-1");
    expect(visualization.nodeTimeline[0]?.nodeId).toBe("step-1");
  });
});

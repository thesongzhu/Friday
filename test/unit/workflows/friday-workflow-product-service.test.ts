import { describe, expect, it, vi } from "vitest";
import type { FridayWorkflowBuilderRuntime, FridayWorkflowRuntime } from "#workflows";
import { createFridayWorkflowProductService } from "../../../src/workflows/services/friday-workflow-product-service.js";

const NOW = "2026-03-07T12:00:00.000Z";

function makeDeps() {
  let approvalRecord:
    | {
      sessionId: string;
      workflowId: string;
      workflowVersionId: string;
      savedAt: string;
    }
    | null = null;
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
    graphJson: {
      schemaVersion: "2.0",
      workflowId: "wf-1",
      workflowVersionId: "version-1",
      sourceSpecSchemaVersion: "1.0",
      graph: {
        nodes: [
          {
            id: "step-1",
            type: "action",
            label: "step-1",
            config: {},
          },
        ],
        edges: [],
      },
      failurePolicy: {
        onFailure: "fail_fast",
        notifyUser: true,
      },
      tests: [],
      checksum: "compiled-checksum-1",
    },
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

  const workflowGenerator = {
    getSession: vi.fn(async () => null),
  };

  return {
    service: createFridayWorkflowProductService({
      builderRuntime,
      workflowRuntime,
      workflowGenerator: workflowGenerator as never,
      observability: observability as never,
      selfHealing: selfHealing as never,
      db: {
        withReadConnection: (fn) => fn({
          prepare: vi.fn(() => ({
            get: vi.fn((namespace?: string, key?: string) => {
              if (
                namespace === "workflow-generator-approval"
                && key === approvalRecord?.sessionId
              ) {
                return {
                  id: "approval-row-1",
                  value_json: JSON.stringify(approvalRecord),
                };
              }
              return undefined;
            }),
          })),
        } as never),
        withWriteTransaction: (fn) => fn({
          prepare: vi.fn(() => ({
            get: vi.fn((namespace?: string, key?: string) => {
              if (
                namespace === "workflow-generator-approval"
                && key === approvalRecord?.sessionId
              ) {
                return {
                  id: "approval-row-1",
                  value_json: JSON.stringify(approvalRecord),
                };
              }
              return undefined;
            }),
            run: vi.fn(
              (
                _id: string,
                namespace: string,
                key: string,
                valueJson: string,
              ) => {
                if (namespace === "workflow-generator-approval") {
                  approvalRecord = JSON.parse(valueJson) as {
                    sessionId: string;
                    workflowId: string;
                    workflowVersionId: string;
                    savedAt: string;
                  };
                }
              },
            ),
          })),
        } as never),
      },
      idGenerator: () => "id-1",
      nowIso: () => NOW,
    }),
    builderRuntime,
    workflowRuntime,
    observability,
    selfHealing,
    workflowGenerator,
    setApprovalRecord: (record: typeof approvalRecord) => {
      approvalRecord = record;
    },
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

  it("surfaces latest run failure details and node error messages in overview", () => {
    const { service, workflowRuntime } = makeDeps();
    vi.mocked(workflowRuntime.execution.listRuns).mockReturnValueOnce([
      {
        id: "run-failed-1",
        workflowId: "wf-1",
        workflowVersionId: "version-1",
        triggerType: "manual",
        status: "failed",
        startedAt: NOW,
        finishedAt: NOW,
        failure: {
          code: "WORKFLOW_FAILED",
          message: "Unsupported start node",
          details: { nodeId: "step-1" },
        },
      },
    ] as never);
    vi.mocked(workflowRuntime.execution.getRunNodes).mockReturnValueOnce([
      {
        nodeId: "step-1",
        attempt: 1,
        status: "failed",
        updatedAt: NOW,
        finishedAt: NOW,
        error: {
          code: "WORKFLOW_FAILED",
          message: "Unsupported start node",
        },
      },
    ] as never);

    const overview = service.getOverview({ workflowId: "wf-1", recentRunLimit: 4 });

    expect(overview.latestRun?.failure).toEqual({
      code: "WORKFLOW_FAILED",
      message: "Unsupported start node",
      details: { nodeId: "step-1" },
    });
    expect(overview.latestRunNodeTimeline[0]).toMatchObject({
      nodeId: "step-1",
      status: "failed",
      message: "Unsupported start node",
    });
  });

  it("restores a deployable draft from a saved workflow generator session", async () => {
    const { service, builderRuntime, workflowGenerator } = makeDeps();
    vi.mocked(workflowGenerator.getSession).mockResolvedValueOnce({
      session: {
        sessionId: "session-1",
        userId: "user-1",
        channel: "assistant",
        status: "saved",
        goal: "Deploy release flow",
        requirementsSummary: "{}",
        openQuestions: [],
        decisions: [],
        workflowId: "wf-1",
        workflowVersionId: "version-1",
        createdAt: NOW,
        updatedAt: NOW,
      },
      turns: [],
    });
    vi.mocked(builderRuntime.drafts.createDraft).mockReturnValueOnce({
      draftId: "draft-restored",
      workflowId: "wf-1",
      title: "Release Flow Draft",
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
    } as never);

    const result = await service.materializeGeneratedSession({
      sessionId: "session-1",
      actorUserId: "user-1",
    });

    expect(builderRuntime.drafts.createDraft).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: "wf-1",
      ownerUserId: "user-1",
    }));
    expect(result.workflowId).toBe("wf-1");
    expect(result.draftId).toBe("draft-restored");
    expect(result.deployReady).toBe(true);
    expect(result.summary).toContain("restored");
  });

  it("restores a deployable draft from the saved approval record when session identity is stale", async () => {
    const { service, builderRuntime, workflowGenerator, setApprovalRecord } = makeDeps();
    vi.mocked(workflowGenerator.getSession).mockResolvedValueOnce({
      session: {
        sessionId: "session-1",
        userId: "user-1",
        channel: "assistant",
        status: "generating",
        goal: "Deploy release flow",
        requirementsSummary: "{}",
        openQuestions: [],
        decisions: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
      turns: [],
    });
    setApprovalRecord({
      sessionId: "session-1",
      workflowId: "wf-1",
      workflowVersionId: "version-1",
      savedAt: NOW,
    });
    vi.mocked(builderRuntime.drafts.createDraft).mockReturnValueOnce({
      draftId: "draft-restored",
      workflowId: "wf-1",
      title: "Release Flow Draft",
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
    } as never);

    const result = await service.materializeGeneratedSession({
      sessionId: "session-1",
      actorUserId: "user-1",
    });

    expect(builderRuntime.drafts.createDraft).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: "wf-1",
      ownerUserId: "user-1",
    }));
    expect(result.workflowId).toBe("wf-1");
    expect(result.draftId).toBe("draft-restored");
    expect(result.summary).toContain("saved workflow");
  });
});

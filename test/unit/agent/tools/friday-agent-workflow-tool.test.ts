import { describe, it, expect, vi } from "vitest";
import {
  createFridayAgentWorkflowListTool,
  createFridayAgentWorkflowTool,
} from "#agent";
import type {
  FridayWorkflowCrudService,
  FridayWorkflowEntity,
  FridayWorkflowExecutionService,
  FridayWorkflowRunEntity,
} from "#workflows";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function makeRunEntity(
  overrides?: Partial<FridayWorkflowRunEntity>,
): FridayWorkflowRunEntity {
  return {
    id: "wf-run-1",
    workflowId: "wf-1",
    workflowVersionId: "wf-v-1",
    status: "queued",
    triggerType: "agent",
    startedAt: "2026-02-19T00:00:00.000Z",
    createdAt: "2026-02-19T00:00:00.000Z",
    updatedAt: "2026-02-19T00:00:00.000Z",
    ...overrides,
  };
}

function mockExecutionService(
  runEntity?: FridayWorkflowRunEntity,
  error?: Error,
): FridayWorkflowExecutionService {
  return {
    setDistributedDispatcher: vi.fn(),
    startRun: error
      ? vi.fn().mockRejectedValue(error)
      : vi.fn().mockResolvedValue(runEntity ?? makeRunEntity()),
    resumeRun: vi.fn(),
    cancelRun: vi.fn(),
    retryRun: vi.fn(),
    getRun: vi.fn().mockReturnValue(null),
    listRuns: vi.fn().mockReturnValue([]),
    listActiveRuns: vi.fn().mockReturnValue([]),
    getRunNodes: vi.fn().mockReturnValue([]),
    recoverActiveRuns: vi.fn().mockResolvedValue(0),
    reportRemoteNodeResult: vi.fn(),
    reapExpiredLeases: vi.fn().mockResolvedValue(0),
    sweepTimedOutRuns: vi.fn().mockResolvedValue(0),
    sweepTimedOutNodes: vi.fn().mockResolvedValue(0),
  };
}

function makeWorkflowEntity(
  overrides?: Partial<FridayWorkflowEntity>,
): FridayWorkflowEntity {
  return {
    id: "wf-1",
    slug: "daily-cleanup",
    name: "Daily cleanup",
    description: "Clean old workspace files after approval",
    tags: ["cleanup", "workspace"],
    latestVersionNumber: 2,
    publishedVersionNumber: 1,
    isArchived: false,
    revision: 1,
    etag: "etag-1",
    compatibilityStatus: "compatible",
    promotionChannel: "active",
    createdAt: "2026-02-19T00:00:00.000Z",
    updatedAt: "2026-02-19T00:00:00.000Z",
    ...overrides,
  };
}

function mockCrudService(
  workflows: FridayWorkflowEntity[] = [makeWorkflowEntity()],
  error?: Error,
): FridayWorkflowCrudService {
  return {
    createWorkflow: vi.fn(),
    getWorkflow: vi.fn(),
    getWorkflowBySlug: vi.fn(),
    listWorkflows: error
      ? vi.fn().mockImplementation(() => {
        throw error;
      })
      : vi.fn().mockReturnValue(workflows),
    updateWorkflow: vi.fn(),
    updateWorkflowWithGraph: vi.fn(),
    archiveWorkflow: vi.fn(),
    createWorkflowWithVersion: vi.fn(),
    createVersion: vi.fn(),
    publishVersion: vi.fn(),
    getVersion: vi.fn(),
    listVersions: vi.fn(),
    getPublishedVersion: vi.fn(),
  } as unknown as FridayWorkflowCrudService;
}

describe("FridayAgentWorkflowTool", () => {
  // ─── Tool definition ───

  it("has correct name and parameters", () => {
    const svc = mockExecutionService();
    const tool = createFridayAgentWorkflowTool({ workflowExecutionService: svc });

    expect(tool.name).toBe("workflow_run");
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toBeDefined();
  });

  // ─── Successful start ───

  it("starts a workflow and returns run info", async () => {
    const svc = mockExecutionService();
    const tool = createFridayAgentWorkflowTool({ workflowExecutionService: svc });

    const result = await tool.execute(
      { workflowId: "wf-1" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      runId: "wf-run-1",
      status: "queued",
    });
  });

  // ─── Passes correct parameters ───

  it("passes workflowId, versionId, and input to startRun", async () => {
    const svc = mockExecutionService();
    const tool = createFridayAgentWorkflowTool({ workflowExecutionService: svc });

    await tool.execute(
      {
        workflowId: "wf-2",
        versionId: "v-2",
        input: { temperature: 72 },
      },
      signal(),
    );

    expect(svc.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf-2",
        workflowVersionId: "v-2",
        triggerType: "agent",
        triggerPayload: { temperature: 72 },
        context: { temperature: 72 },
      }),
    );
  });

  // ─── No versionId defaults to undefined ───

  it("omits versionId when not provided", async () => {
    const svc = mockExecutionService();
    const tool = createFridayAgentWorkflowTool({ workflowExecutionService: svc });

    await tool.execute({ workflowId: "wf-1" }, signal());

    expect(svc.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowVersionId: undefined,
      }),
    );
  });

  // ─── Error handling ───

  it("returns error when startRun throws", async () => {
    const svc = mockExecutionService(
      undefined,
      new Error("Workflow has no published version"),
    );
    const tool = createFridayAgentWorkflowTool({ workflowExecutionService: svc });

    const result = await tool.execute(
      { workflowId: "bad-wf" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("bad-wf");
    expect(result.content).toContain("no published version");
  });

  // ─── Missing required param ───

  it("throws on missing workflowId", async () => {
    const svc = mockExecutionService();
    const tool = createFridayAgentWorkflowTool({ workflowExecutionService: svc });

    await expect(
      tool.execute({ workflowId: "" }, signal()),
    ).rejects.toThrow("workflowId is required");
  });

  // ─── Non-object input is ignored ───

  it("ignores non-object input", async () => {
    const svc = mockExecutionService();
    const tool = createFridayAgentWorkflowTool({ workflowExecutionService: svc });

    await tool.execute(
      { workflowId: "wf-1", input: "not-an-object" },
      signal(),
    );

    expect(svc.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerPayload: undefined,
      }),
    );
  });
});

describe("FridayAgentWorkflowListTool", () => {
  it("lists published non-archived workflows without starting a run", async () => {
    const svc = mockCrudService([
      makeWorkflowEntity({ id: "published-wf", publishedVersionNumber: 1 }),
      makeWorkflowEntity({ id: "draft-wf", publishedVersionNumber: undefined }),
    ]);
    const tool = createFridayAgentWorkflowListTool({ workflowCrudService: svc });

    const result = await tool.execute({ tag: "cleanup", limit: 10 }, signal());

    expect(result.isError).toBeUndefined();
    expect(svc.listWorkflows).toHaveBeenCalledWith({
      tag: "cleanup",
      limit: 30,
      archived: false,
    });
    const parsed = JSON.parse(result.content) as {
      count: number;
      workflows: Array<{ id: string; publishedVersionNumber?: number }>;
    };
    expect(parsed.count).toBe(1);
    expect(parsed.workflows).toEqual([
      expect.objectContaining({
        id: "published-wf",
        publishedVersionNumber: 1,
      }),
    ]);
  });

  it("can include draft and archived workflows when explicitly requested", async () => {
    const svc = mockCrudService([
      makeWorkflowEntity({ id: "draft-wf", publishedVersionNumber: undefined, isArchived: true }),
    ]);
    const tool = createFridayAgentWorkflowListTool({ workflowCrudService: svc });

    const result = await tool.execute(
      { publishedOnly: false, includeArchived: true, limit: 2, cursor: "5" },
      signal(),
    );

    expect(svc.listWorkflows).toHaveBeenCalledWith({
      limit: 2,
      archived: undefined,
      cursor: "5",
    });
    const parsed = JSON.parse(result.content) as { workflows: Array<{ id: string; isArchived: boolean }> };
    expect(parsed.workflows).toEqual([
      expect.objectContaining({ id: "draft-wf", isArchived: true }),
    ]);
  });

  it("caps limit and returns an error result when listing fails", async () => {
    const svc = mockCrudService([], new Error("database unavailable"));
    const tool = createFridayAgentWorkflowListTool({ workflowCrudService: svc });

    const result = await tool.execute({ limit: 100 }, signal());

    expect(svc.listWorkflows).toHaveBeenCalledWith({
      limit: 50,
      archived: false,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("database unavailable");
  });
});

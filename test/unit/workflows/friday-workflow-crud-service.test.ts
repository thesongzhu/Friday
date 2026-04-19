import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "#state";
import { createFridayWorkflowRepository } from "#workflows";
import { createFridayWorkflowCrudService } from "#workflows";
import type { FridayCompiledWorkflowGraphV2 } from "#workflows";
import { parseGraphJson } from "#workflows";
import { createTestDb, createTestIdGenerator } from "./_helpers/create-test-db.helper.js";

describe("FridayWorkflowCrudService", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createService() {
    const idGen = createTestIdGenerator();
    return createFridayWorkflowCrudService({
      db,
      workflowRepo: createFridayWorkflowRepository({ db }),
      idGenerator: idGen,
      nowIso: () => NOW,
      computeChecksum: (content: string) =>
        createHash("sha256").update(content).digest("hex"),
      computeEtag: () => idGen().slice(0, 16),
    });
  }

  function makeValidGraph(
    workflowId = "wf-1",
    versionId = "wv-1",
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
            id: "action1",
            type: "action",
            label: "Action 1",
            config: { skillId: "test-skill" },
          },
        ],
        edges: [
          { id: "e1", sourceNodeId: "trigger", targetNodeId: "action1" },
        ],
      },
      failurePolicy: { onFailure: "fail_fast", notifyUser: false },
      tests: [],
      checksum: "placeholder",
    };
  }

  it("creates a workflow with correct defaults", () => {
    const service = createService();
    const entity = service.createWorkflow({
      slug: "my-workflow",
      name: "My Workflow",
      description: "A test workflow",
    });

    expect(entity.slug).toBe("my-workflow");
    expect(entity.name).toBe("My Workflow");
    expect(entity.revision).toBe(1);
    expect(entity.isArchived).toBe(false);
    expect(entity.latestVersionNumber).toBe(1);
  });

  it("gets workflow by id", () => {
    const service = createService();
    const created = service.createWorkflow({ slug: "s", name: "N" });
    const fetched = service.getWorkflow(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
  });

  it("gets workflow by slug", () => {
    const service = createService();
    service.createWorkflow({ slug: "my-slug", name: "N" });
    const fetched = service.getWorkflowBySlug("my-slug");
    expect(fetched).not.toBeNull();
    expect(fetched!.slug).toBe("my-slug");
  });

  it("returns null for missing workflow", () => {
    const service = createService();
    expect(service.getWorkflow("nonexistent")).toBeNull();
  });

  it("updates workflow with correct revision", () => {
    const service = createService();
    const created = service.createWorkflow({ slug: "s", name: "N" });

    const updated = service.updateWorkflow({
      workflowId: created.id,
      expectedRevision: created.revision,
      etag: created.etag,
      name: "Updated",
    });

    expect(updated.name).toBe("Updated");
    expect(updated.revision).toBe(2);
  });

  it("throws WORKFLOW_VERSION_CONFLICT on wrong revision", () => {
    const service = createService();
    const created = service.createWorkflow({ slug: "s", name: "N" });

    expect(() =>
      service.updateWorkflow({
        workflowId: created.id,
        expectedRevision: 99,
        etag: created.etag,
        name: "Updated",
      }),
    ).toThrow("WORKFLOW_VERSION_CONFLICT");
  });

  it("archives workflow", () => {
    const service = createService();
    const created = service.createWorkflow({ slug: "s", name: "N" });
    service.archiveWorkflow(created.id, "admin");

    const fetched = service.getWorkflow(created.id);
    expect(fetched).toBeNull();
  });

  it("creates version with valid graph", () => {
    const service = createService();
    const wf = service.createWorkflow({ slug: "s", name: "N" });

    const version = service.createVersion(wf.id, makeValidGraph(wf.id));
    expect(version.versionNumber).toBe(2); // incremented from 1
    expect(version.checksum).toBeTruthy();
  });

  it("rejects version with invalid graph", () => {
    const service = createService();
    const wf = service.createWorkflow({ slug: "s", name: "N" });

    const invalidGraph = makeValidGraph(wf.id);
    invalidGraph.graph.nodes = []; // empty graph

    expect(() => service.createVersion(wf.id, invalidGraph)).toThrow();
  });

  it("normalizes raw authoring graphs so kind/data/from-to survive read and run surfaces", () => {
    const service = createService();
    const { workflow, version } = service.createWorkflowWithVersion(
      { slug: "raw-graph", name: "Raw Graph" },
      {
        nodes: [
          { id: "start", kind: "start", data: {} },
          { id: "transform-1", kind: "transform", data: { mapping: { ok: true } } },
        ],
        edges: [{ from: "start", to: "transform-1" }],
      },
    );

    expect(workflow.slug).toBe("raw-graph");

    const parsed = parseGraphJson(version.graphJson);
    expect(parsed.graph.nodes).toEqual([
      { id: "start", type: "trigger", label: "start", config: {} },
      {
        id: "transform-1",
        type: "data",
        label: "transform-1",
        config: { mapping: { ok: true } },
      },
    ]);
    expect(parsed.graph.edges).toEqual([
      {
        id: "edge-1:start:transform-1:success",
        sourceNodeId: "start",
        targetNodeId: "transform-1",
        sourcePort: undefined,
        targetPort: undefined,
        condition: undefined,
        priority: undefined,
      },
    ]);
  });

  it("rejects compiled graphs with unsupported node types before they are persisted", () => {
    const service = createService();
    expect(() =>
      service.createWorkflowWithVersion(
        { slug: "bad-node-type", name: "Bad Node Type" },
        {
          ...makeValidGraph(),
          graph: {
            nodes: [
              { id: "start", type: "start" as never, label: "Start", config: {} },
              { id: "next", type: "action", label: "Next", config: { skillId: "test-skill" } },
            ],
            edges: [{ id: "e1", sourceNodeId: "start", targetNodeId: "next" }],
          },
        },
      ),
    ).toThrow(/Unsupported workflow node type 'start'/);
  });

  it("publishes a version", () => {
    const service = createService();
    const wf = service.createWorkflow({ slug: "s", name: "N" });
    const version = service.createVersion(wf.id, makeValidGraph(wf.id));

    const published = service.publishVersion(wf.id, version.versionNumber);
    expect(published.isPublished).toBe(true);
  });

  it("only one version published at a time", () => {
    const service = createService();
    const wf = service.createWorkflow({ slug: "s", name: "N" });

    const v1 = service.createVersion(wf.id, makeValidGraph(wf.id));
    service.publishVersion(wf.id, v1.versionNumber);

    const v2 = service.createVersion(wf.id, makeValidGraph(wf.id));
    service.publishVersion(wf.id, v2.versionNumber);

    // v1 should no longer be published
    const fetched = service.getVersion(v1.id);
    expect(fetched!.isPublished).toBe(false);

    const current = service.getPublishedVersion(wf.id);
    expect(current!.versionNumber).toBe(v2.versionNumber);
  });

  it("lists workflows with filters", () => {
    const service = createService();
    service.createWorkflow({ slug: "s1", name: "A", tags: ["api"] });
    service.createWorkflow({ slug: "s2", name: "B", tags: ["ui"] });
    service.createWorkflow({ slug: "s3", name: "C", tags: ["api"] });

    const apiOnly = service.listWorkflows({ tag: "api" });
    expect(apiOnly).toHaveLength(2);

    const all = service.listWorkflows();
    expect(all).toHaveLength(3);
  });

  // ─── E2E Fix: Version numbering ───

  it("createWorkflowWithVersion assigns versionNumber = 1 for the initial version", () => {
    const service = createService();
    const { workflow, version } = service.createWorkflowWithVersion(
      { slug: "versioned-wf", name: "Versioned WF" },
      makeValidGraph(),
    );

    expect(workflow.slug).toBe("versioned-wf");
    expect(version.versionNumber).toBe(1);
  });

  it("subsequent createVersion after createWorkflowWithVersion increments from 1", () => {
    const service = createService();
    const { workflow, version: v1 } = service.createWorkflowWithVersion(
      { slug: "inc-wf", name: "Inc WF" },
      makeValidGraph(),
    );

    expect(v1.versionNumber).toBe(1);

    const v2 = service.createVersion(workflow.id, makeValidGraph());
    expect(v2.versionNumber).toBe(2);
  });
});

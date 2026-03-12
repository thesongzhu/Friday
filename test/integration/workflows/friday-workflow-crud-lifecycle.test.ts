import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayWorkflowRepository,
  createFridayWorkflowCrudService,
} from "#workflows";
import type { FridayCompiledWorkflowGraphV2, FridayWorkflowCrudService } from "#workflows";
import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";

describe("Workflow CRUD Lifecycle (Integration)", () => {
  let db: FridaySqliteLayer;
  let service: FridayWorkflowCrudService;
  const NOW = "2026-02-18T10:00:00.000Z";

  function createService(): FridayWorkflowCrudService {
    const idGen = createTestIdGenerator();
    return createFridayWorkflowCrudService({
      db,
      workflowRepo: createFridayWorkflowRepository({ db }),
      idGenerator: idGen,
      nowIso: () => NOW,
      computeChecksum: (content: string) =>
        createHash("sha256").update(content).digest("hex"),
      computeEtag: () => createTestIdGenerator()().slice(0, 16),
    });
  }

  function makeGraph(
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

  beforeEach(() => {
    db = createTestDb();
    service = createService();
  });

  afterEach(() => {
    db.close();
  });

  // ─── Create workflow, version, publish ───

  describe("create → version → publish lifecycle", () => {
    it("creates workflow, creates version, and publishes", () => {
      const wf = service.createWorkflow({
        slug: "my-workflow",
        name: "My Workflow",
        description: "Test workflow",
      });

      expect(wf.slug).toBe("my-workflow");
      expect(wf.name).toBe("My Workflow");
      expect(wf.isArchived).toBe(false);

      const version = service.createVersion(wf.id, makeGraph(wf.id));
      expect(version.versionNumber).toBe(2);
      expect(version.checksum).toBeTruthy();

      const published = service.publishVersion(wf.id, version.versionNumber);
      expect(published.isPublished).toBe(true);

      const current = service.getPublishedVersion(wf.id);
      expect(current).not.toBeNull();
      expect(current!.versionNumber).toBe(version.versionNumber);
    });
  });

  // ─── List workflows, get by ID ───

  describe("list and get", () => {
    it("lists all workflows", () => {
      service.createWorkflow({ slug: "wf-1", name: "WF 1" });
      service.createWorkflow({ slug: "wf-2", name: "WF 2" });
      service.createWorkflow({ slug: "wf-3", name: "WF 3" });

      const all = service.listWorkflows();
      expect(all).toHaveLength(3);
    });

    it("gets workflow by ID", () => {
      const created = service.createWorkflow({ slug: "by-id", name: "By ID" });
      const fetched = service.getWorkflow(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
    });

    it("gets workflow by slug", () => {
      service.createWorkflow({ slug: "by-slug", name: "By Slug" });
      const fetched = service.getWorkflowBySlug("by-slug");
      expect(fetched).not.toBeNull();
      expect(fetched!.slug).toBe("by-slug");
    });

    it("returns null for nonexistent workflow", () => {
      expect(service.getWorkflow("nonexistent")).toBeNull();
    });
  });

  // ─── Archive workflow ───

  describe("archive workflow", () => {
    it("archives a workflow (excluded from default listing)", () => {
      const wf = service.createWorkflow({ slug: "archive-me", name: "Archive" });
      service.archiveWorkflow(wf.id, "admin");

      // getWorkflow by ID returns null for archived
      const fetched = service.getWorkflow(wf.id);
      expect(fetched).toBeNull();

      // listWorkflows with default excludes archived
      const all = service.listWorkflows();
      expect(all).toHaveLength(0);
    });
  });

  // ─── Version listing ───

  describe("version listing", () => {
    it("lists all versions of a workflow", () => {
      const wf = service.createWorkflow({ slug: "versioned", name: "V" });

      service.createVersion(wf.id, makeGraph(wf.id));
      service.createVersion(wf.id, makeGraph(wf.id));

      const versions = service.listVersions(wf.id);
      expect(versions).toHaveLength(2);
    });

    it("each version has incrementing version number", () => {
      const wf = service.createWorkflow({ slug: "inc", name: "Inc" });
      const v2 = service.createVersion(wf.id, makeGraph(wf.id));
      const v3 = service.createVersion(wf.id, makeGraph(wf.id));

      expect(v2.versionNumber).toBe(2);
      expect(v3.versionNumber).toBe(3);
    });

    it("only one version is published at a time", () => {
      const wf = service.createWorkflow({ slug: "single-pub", name: "SP" });
      const v2 = service.createVersion(wf.id, makeGraph(wf.id));
      const v3 = service.createVersion(wf.id, makeGraph(wf.id));

      service.publishVersion(wf.id, v2.versionNumber);
      service.publishVersion(wf.id, v3.versionNumber);

      const v2Fetched = service.getVersion(v2.id);
      expect(v2Fetched!.isPublished).toBe(false);

      const published = service.getPublishedVersion(wf.id);
      expect(published!.versionNumber).toBe(v3.versionNumber);
    });
  });
});

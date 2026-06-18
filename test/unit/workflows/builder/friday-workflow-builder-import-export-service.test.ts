import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "#state";
import { createFridayWorkflowBuilderImportExportService } from "#workflows";
import { createFridayWorkflowBuilderDraftService } from "#workflows";
import { createFridayWorkflowBuilderValidationService } from "#workflows";
import { createFridayWorkflowBuilderDraftRepository } from "#workflows";
import { createFridayWorkflowBuilderLockRepository } from "#workflows";
import { createFridayWorkflowBuilderCollaborationService } from "#workflows";
import { createFridayWorkflowCompiler } from "#workflows";
import { createFridayWorkflowValidator } from "#workflows";
import type { FridayWorkflowSpecBundleV1 } from "#workflows";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.helper.js";
import { createTestSpec, createTestVisual } from "./_helpers/create-test-spec.helper.js";

describe("FridayWorkflowBuilderImportExportService", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-06-15T10:00:00.000Z";
  const computeChecksum = (content: string) =>
    createHash("sha256").update(content).digest("hex");

  beforeEach(() => {
    db = createTestDb();
    seedWorkflow("wf-1");
    seedWorkflow("wf-original");
    seedWorkflow("wf-imported");
    seedWorkflow("wf-new");
  });

  afterEach(() => {
    db.close();
  });

  function createServices() {
    const idGen = createTestIdGenerator();
    const lockRepo = createFridayWorkflowBuilderLockRepository();
    const collaborationService = createFridayWorkflowBuilderCollaborationService({
      db,
      lockRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
    const draftService = createFridayWorkflowBuilderDraftService({
      db,
      draftRepo: createFridayWorkflowBuilderDraftRepository(),
      collaborationService,
      idGenerator: idGen,
      nowIso: () => NOW,
      computeChecksum,
    });
    const compiler = createFridayWorkflowCompiler({
      computeChecksum,
      idGenerator: idGen,
    });
    const validator = createFridayWorkflowValidator();
    const validationService = createFridayWorkflowBuilderValidationService({
      compiler,
      validator,
      nowIso: () => NOW,
      idGenerator: idGen,
    });
    const importExportService = createFridayWorkflowBuilderImportExportService({
      db,
      draftService,
      validationService,
      computeChecksum,
      nowIso: () => NOW,
      idGenerator: idGen,
    });

    return { draftService, importExportService };
  }

  function seedWorkflow(workflowId: string): void {
    db.writer
      .prepare(
        `INSERT INTO workflows (id, slug, name, latest_version_number, is_archived, revision, etag, created_at, updated_at)
         VALUES (?, ?, ?, 1, 0, 1, ?, ?, ?)`,
      )
      .run(
        workflowId,
        `test-${workflowId}`,
        `Test ${workflowId}`,
        `etag-${workflowId}`,
        NOW,
        NOW,
      );
  }

  it("exports a draft as a bundle", () => {
    const { draftService, importExportService } = createServices();

    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "Export Test",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
    });

    const bundle = importExportService.exportDraft(draft.draftId);

    expect(bundle.bundleSchemaVersion).toBe("1.0");
    expect(bundle.source.type).toBe("draft");
    expect(bundle.source.workflowId).toBe("wf-1");
    expect(bundle.spec.workflowId).toBe("wf-1");
    expect(bundle.checksum).toBeTruthy();
    expect(bundle.draft).toBeDefined();
    expect(bundle.draft!.draftId).toBe(draft.draftId);
  });

  it("export checksum is deterministic", () => {
    const { draftService, importExportService } = createServices();

    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "Checksum Test",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
    });

    const bundle1 = importExportService.exportDraft(draft.draftId);
    const bundle2 = importExportService.exportDraft(draft.draftId);

    expect(bundle1.checksum).toBe(bundle2.checksum);
  });

  it("exports a workflow version as a bundle", () => {
    const { importExportService } = createServices();

    const bundle = importExportService.exportWorkflowVersion({
      workflowId: "wf-1",
      versionId: "wv-1",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
      slug: "my-wf",
      name: "My Workflow",
      description: "A workflow",
      tags: ["test"],
    });

    expect(bundle.source.type).toBe("workflow_version");
    expect(bundle.workflow.slug).toBe("my-wf");
  });

  it("imports a valid bundle", () => {
    const { draftService, importExportService } = createServices();

    // Create and export
    const draft = draftService.createDraft({
      workflowId: "wf-original",
      title: "Original",
      spec: createTestSpec({ workflowId: "wf-original" }),
      visual: createTestVisual("wf-original"),
    });
    const bundle = importExportService.exportDraft(draft.draftId);

    // Import into different workflow
    const result = importExportService.importBundle(bundle, "wf-imported", "test-user");

    expect(result.draft.workflowId).toBe("wf-imported");
    expect(result.draft.spec.workflowId).toBe("wf-imported");
    expect(result.draft.visual.workflowId).toBe("wf-imported");
    expect(result.draft.status).toBe("active");
    expect(result.warnings.length).toBe(0);
  });

  it("rejects bundle with bad schema version", () => {
    const { importExportService } = createServices();

    const bundle = {
      bundleSchemaVersion: "99.0",
      exportedAt: NOW,
      source: { type: "draft" as const, id: "d1", workflowId: "wf-1" },
      workflow: { name: "Test" },
      spec: createTestSpec(),
      visual: createTestVisual(),
      checksum: "abc",
    } as unknown as FridayWorkflowSpecBundleV1;

    expect(() =>
      importExportService.importBundle(bundle, "wf-new"),
    ).toThrow("Expected schema version '1.0'");
  });

  it("rejects checksum mismatch by default", () => {
    const { draftService, importExportService } = createServices();

    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "Tampered",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
    });
    const bundle = importExportService.exportDraft(draft.draftId);

    // Tamper with the bundle
    bundle.checksum = "tampered-checksum";

    expect(() =>
      importExportService.importBundle(bundle, "wf-new"),
    ).toThrow("Bundle checksum mismatch");
  });

  it("allows checksum mismatch with force flag", () => {
    const { draftService, importExportService } = createServices();

    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "Tampered",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
    });
    const bundle = importExportService.exportDraft(draft.draftId);

    // Tamper with the bundle
    bundle.checksum = "tampered-checksum";

    const result = importExportService.importBundle(bundle, "wf-new", undefined, { force: true });
    expect(result.warnings.some((w) => w.includes("checksum mismatch"))).toBe(true);
    expect(result.draft).toBeDefined();
  });

  it("throws on export of nonexistent draft", () => {
    const { importExportService } = createServices();
    expect(() => importExportService.exportDraft("nonexistent")).toThrow("Draft not found");
  });
});

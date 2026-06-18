import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "#state";
import { createFridayWorkflowBuilderRuntime } from "#workflows";
import { createFridayWorkflowCrudService } from "#workflows";
import { createFridayWorkflowRepository } from "#workflows";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.helper.js";
import { createTestSpec, createTestVisual } from "./_helpers/create-test-spec.helper.js";

describe("FridayWorkflowBuilderRuntime", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-06-15T10:00:00.000Z";
  const computeChecksum = (content: string) =>
    createHash("sha256").update(content).digest("hex");

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createRuntime() {
    const idGen = createTestIdGenerator();
    const workflowRepo = createFridayWorkflowRepository({ db });
    const crudService = createFridayWorkflowCrudService({
      db,
      workflowRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
      computeChecksum,
      computeEtag: () => idGen().slice(0, 16),
    });

    return {
      runtime: createFridayWorkflowBuilderRuntime({
        db,
        crudService,
        idGenerator: idGen,
        nowIso: () => NOW,
        computeChecksum,
      }),
      crudService,
    };
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

  it("exposes all expected services", () => {
    const { runtime } = createRuntime();

    expect(runtime.drafts).toBeDefined();
    expect(runtime.templates).toBeDefined();
    expect(runtime.validation).toBeDefined();
    expect(runtime.testRunner).toBeDefined();
    expect(runtime.collaboration).toBeDefined();
    expect(runtime.importExport).toBeDefined();
    expect(runtime.compositor).toBeDefined();
  });

  it("services are functional and wired correctly", () => {
    const { runtime } = createRuntime();
    seedWorkflow("wf-rt");

    // Create a draft via runtime
    const draft = runtime.drafts.createDraft({
      workflowId: "wf-rt",
      title: "Runtime Test",
      spec: createTestSpec({ workflowId: "wf-rt" }),
      visual: createTestVisual("wf-rt"),
    });

    expect(draft.draftId).toBeTruthy();

    // Validate it
    const report = runtime.validation.validateDraft(draft);
    expect(report.valid).toBe(true);

    // List templates
    const templates = runtime.templates.listTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(3);
  });

  it("full lifecycle: draft → lock → save → validate → compile → publish", () => {
    const { runtime, crudService } = createRuntime();

    // 1. Create workflow
    const workflow = crudService.createWorkflow({
      slug: "lifecycle-wf",
      name: "Lifecycle Workflow",
    });

    // 2. Create draft
    const draft = runtime.drafts.createDraft({
      workflowId: workflow.id,
      title: "Lifecycle Draft",
      spec: createTestSpec({ workflowId: workflow.id }),
      visual: createTestVisual(workflow.id),
      ownerUserId: "test-user",
    });

    // 3. Acquire lock
    const lockResult = runtime.collaboration.acquireLock({
      workflowId: workflow.id,
      ownerUserId: "test-user",
      ttlSec: 300,
    });
    expect(lockResult.acquired).toBe(true);

    // 4. Save draft
    const saved = runtime.drafts.saveDraft({
      draftId: draft.draftId,
      expectedRevision: 1,
      lockToken: lockResult.lock!.lockToken,
      title: "Updated Title",
    });
    expect(saved.revision).toBe(2);

    // 5. Validate
    const report = runtime.validation.validateDraft(saved);
    expect(report.valid).toBe(true);

    // 6. Compile
    const compiled = runtime.compositor.compileDraft(draft.draftId);
    expect(compiled.compiled.schemaVersion).toBe("2.0");

    // 7. Publish
    const published = runtime.compositor.publishDraft({
      draftId: draft.draftId,
      workflowId: workflow.id,
      lockToken: lockResult.lock!.lockToken,
      publishNow: true,
    });
    expect(published.published).toBe(true);

    // 8. Release lock
    runtime.collaboration.releaseLock(workflow.id, lockResult.lock!.lockToken);
    const lock = runtime.collaboration.getLock(workflow.id);
    expect(lock).toBeNull();
  });

  it("template instantiation creates a functional draft", () => {
    const { runtime } = createRuntime();
    seedWorkflow("wf-from-template");

    const draft = runtime.templates.instantiateTemplate(
      "builtin-simple-action",
      "wf-from-template",
      "From Template",
    );

    // Should be a valid draft
    const report = runtime.validation.validateDraft(draft);
    expect(report.valid).toBe(true);

    // Draft should be fetchable
    const fetched = runtime.drafts.getDraft(draft.draftId);
    expect(fetched).not.toBeNull();
  });

  it("import/export roundtrip works", () => {
    const { runtime } = createRuntime();
    seedWorkflow("wf-export");
    seedWorkflow("wf-imported");

    // Create and export
    const original = runtime.drafts.createDraft({
      workflowId: "wf-export",
      title: "Export Me",
      spec: createTestSpec({ workflowId: "wf-export" }),
      visual: createTestVisual("wf-export"),
    });
    const bundle = runtime.importExport.exportDraft(original.draftId);

    // Import into new workflow
    const importResult = runtime.importExport.importBundle(bundle, "wf-imported");
    expect(importResult.draft.workflowId).toBe("wf-imported");

    // Validate imported draft
    const report = runtime.validation.validateDraft(importResult.draft);
    expect(report.valid).toBe(true);
  });
});

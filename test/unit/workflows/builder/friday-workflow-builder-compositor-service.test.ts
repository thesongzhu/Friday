import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "#state";
import { createFridayWorkflowBuilderCompositorService } from "#workflows";
import { createFridayWorkflowBuilderDraftService } from "#workflows";
import { createFridayWorkflowBuilderValidationService } from "#workflows";
import { createFridayWorkflowBuilderCollaborationService } from "#workflows";
import { createFridayWorkflowBuilderDraftRepository } from "#workflows";
import { createFridayWorkflowBuilderLockRepository } from "#workflows";
import { createFridayWorkflowBuilderSpecVersionRepository } from "#workflows";
import { createFridayWorkflowCompiler } from "#workflows";
import { createFridayWorkflowValidator } from "#workflows";
import { createFridayWorkflowCrudService } from "#workflows";
import { createFridayWorkflowRepository } from "#workflows";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.helper.js";
import { createTestSpec, createTestVisual } from "./_helpers/create-test-spec.helper.js";

describe("FridayWorkflowBuilderCompositorService", () => {
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

  function createAllServices() {
    const idGen = createTestIdGenerator();
    const lockRepo = createFridayWorkflowBuilderLockRepository();
    const draftRepo = createFridayWorkflowBuilderDraftRepository();
    const specVersionRepo = createFridayWorkflowBuilderSpecVersionRepository();

    const compiler = createFridayWorkflowCompiler({
      computeChecksum,
      idGenerator: idGen,
    });
    const validator = createFridayWorkflowValidator();

    const collaborationService = createFridayWorkflowBuilderCollaborationService({
      db,
      lockRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    const draftService = createFridayWorkflowBuilderDraftService({
      db,
      draftRepo,
      collaborationService,
      idGenerator: idGen,
      nowIso: () => NOW,
      computeChecksum,
    });

    const validationService = createFridayWorkflowBuilderValidationService({
      compiler,
      validator,
      nowIso: () => NOW,
      idGenerator: idGen,
    });

    const workflowRepo = createFridayWorkflowRepository({ db });
    const crudService = createFridayWorkflowCrudService({
      db,
      workflowRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
      computeChecksum,
      computeEtag: () => idGen().slice(0, 16),
    });

    const compositorService = createFridayWorkflowBuilderCompositorService({
      db,
      compiler,
      crudService,
      draftService,
      draftRepo,
      validationService,
      collaborationService,
      specVersionRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
      computeChecksum,
    });

    return {
      draftService,
      collaborationService,
      compositorService,
      crudService,
      specVersionRepo,
    };
  }

  it("compiles a valid draft", () => {
    const { draftService, compositorService } = createAllServices();

    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "Test Draft",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
    });

    const result = compositorService.compileDraft(draft.draftId);

    expect(result.compiled).toBeDefined();
    expect(result.compiled.schemaVersion).toBe("2.0");
    expect(result.validation.valid).toBe(true);
  });

  it("throws when compiling nonexistent draft", () => {
    const { compositorService } = createAllServices();
    expect(() => compositorService.compileDraft("nonexistent")).toThrow("Draft not found");
  });

  it("publish blocks when validation fails", () => {
    const { draftService, collaborationService, compositorService } = createAllServices();

    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "Invalid Draft",
      spec: createTestSpec({ workflowId: "wf-1", name: "" }), // invalid
      visual: createTestVisual("wf-1"),
      ownerUserId: "test-user",
    });

    const lockResult = collaborationService.acquireLock({
      workflowId: "wf-1",
      ownerUserId: "test-user",
      ttlSec: 300,
    });

    const result = compositorService.publishDraft({
      draftId: draft.draftId,
      workflowId: "wf-1",
      lockToken: lockResult.lock!.lockToken,
      publishNow: true,
    });

    expect(result.published).toBe(false);
    expect(result.validation.valid).toBe(false);
    expect(result.workflowVersionId).toBe("");
  });

  it("publishes a valid draft and creates a version", () => {
    const {
      draftService,
      collaborationService,
      compositorService,
      crudService,
    } = createAllServices();

    // Create a workflow first
    const workflow = crudService.createWorkflow({
      slug: "my-wf",
      name: "My Workflow",
    });

    const draft = draftService.createDraft({
      workflowId: workflow.id,
      title: "Publish Draft",
      spec: createTestSpec({ workflowId: workflow.id }),
      visual: createTestVisual(workflow.id),
      ownerUserId: "test-user",
    });

    const lockResult = collaborationService.acquireLock({
      workflowId: workflow.id,
      ownerUserId: "test-user",
      ttlSec: 300,
    });

    const result = compositorService.publishDraft({
      draftId: draft.draftId,
      workflowId: workflow.id,
      lockToken: lockResult.lock!.lockToken,
      publishNow: true,
      createdByUserId: "test-user",
      changeNote: "Initial publish",
    });

    expect(result.published).toBe(true);
    expect(result.workflowVersionId).toBeTruthy();
    expect(result.versionNumber).toBeGreaterThan(0);
    expect(result.checksum).toBeTruthy();
    expect(result.validation.valid).toBe(true);

    // Verify the version exists
    const version = crudService.getVersion(result.workflowVersionId);
    expect(version).not.toBeNull();
    expect(version!.isPublished).toBe(true);
  });

  it("creates version without publishing when publishNow is false", () => {
    const {
      draftService,
      collaborationService,
      compositorService,
      crudService,
    } = createAllServices();

    const workflow = crudService.createWorkflow({
      slug: "my-wf",
      name: "My Workflow",
    });

    const draft = draftService.createDraft({
      workflowId: workflow.id,
      title: "Draft Only",
      spec: createTestSpec({ workflowId: workflow.id }),
      visual: createTestVisual(workflow.id),
      ownerUserId: "test-user",
    });

    const lockResult = collaborationService.acquireLock({
      workflowId: workflow.id,
      ownerUserId: "test-user",
      ttlSec: 300,
    });

    const result = compositorService.publishDraft({
      draftId: draft.draftId,
      workflowId: workflow.id,
      lockToken: lockResult.lock!.lockToken,
      publishNow: false,
    });

    expect(result.published).toBe(false);
    expect(result.workflowVersionId).toBeTruthy();

    const version = crudService.getVersion(result.workflowVersionId);
    expect(version).not.toBeNull();
    expect(version!.isPublished).toBe(false);
  });

  it("stores source spec snapshot on publish", () => {
    const {
      draftService,
      collaborationService,
      compositorService,
      crudService,
      specVersionRepo,
    } = createAllServices();

    const workflow = crudService.createWorkflow({
      slug: "my-wf",
      name: "My Workflow",
    });

    const draft = draftService.createDraft({
      workflowId: workflow.id,
      title: "Spec Snapshot Test",
      spec: createTestSpec({ workflowId: workflow.id }),
      visual: createTestVisual(workflow.id),
      ownerUserId: "test-user",
    });

    const lockResult = collaborationService.acquireLock({
      workflowId: workflow.id,
      ownerUserId: "test-user",
      ttlSec: 300,
    });

    const result = compositorService.publishDraft({
      draftId: draft.draftId,
      workflowId: workflow.id,
      lockToken: lockResult.lock!.lockToken,
      publishNow: true,
    });

    const specVersion = db.withReadConnection((readerDb) =>
      specVersionRepo.getByVersionId(readerDb, result.workflowVersionId),
    );

    expect(specVersion).not.toBeNull();
    expect(specVersion!.workflowId).toBe(workflow.id);
    expect(specVersion!.spec.schemaVersion).toBe("1.0");
  });

  it("publish rejects mismatched workflowId", () => {
    const {
      draftService,
      collaborationService,
      compositorService,
      crudService,
    } = createAllServices();

    // Create two workflows
    const wfA = crudService.createWorkflow({ slug: "wf-a", name: "Workflow A" });
    const wfB = crudService.createWorkflow({ slug: "wf-b", name: "Workflow B" });

    // Draft belongs to workflow A
    const draft = draftService.createDraft({
      workflowId: wfA.id,
      title: "Draft for A",
      spec: createTestSpec({ workflowId: wfA.id }),
      visual: createTestVisual(wfA.id),
      ownerUserId: "test-user",
    });

    // Lock workflow B (different from draft's workflow)
    const lockResult = collaborationService.acquireLock({
      workflowId: wfB.id,
      ownerUserId: "test-user",
      ttlSec: 300,
    });

    // Attempt to publish draft against workflow B → should throw mismatch
    expect(() =>
      compositorService.publishDraft({
        draftId: draft.draftId,
        workflowId: wfB.id,
        lockToken: lockResult.lock!.lockToken,
        publishNow: true,
      }),
    ).toThrow("Draft does not belong to the specified workflow");
  });

  it("publish requires a lock", () => {
    const { draftService, compositorService } = createAllServices();

    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "No Lock",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
    });

    expect(() =>
      compositorService.publishDraft({
        draftId: draft.draftId,
        workflowId: "wf-1",
        lockToken: "bad-token",
        publishNow: true,
      }),
    ).toThrow();
  });
});

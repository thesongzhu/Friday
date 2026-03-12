import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridayWorkflowBuilderDraftRepository } from "#workflows";
import type { FridayWorkflowDraftEntity } from "#workflows";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.helper.js";
import { createTestSpec, createTestVisual } from "./_helpers/create-test-spec.helper.js";

describe("FridayWorkflowBuilderDraftRepository", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function makeDraft(overrides?: Partial<FridayWorkflowDraftEntity>): FridayWorkflowDraftEntity {
    return {
      draftId: "draft-1",
      workflowId: "wf-1",
      ownerUserId: "test-user",
      title: "My Draft",
      status: "active",
      revision: 1,
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
      createdAt: NOW,
      updatedAt: NOW,
      autosave: { enabled: true, intervalMs: 30000 },
      ...overrides,
    };
  }

  it("creates and retrieves a draft", () => {
    const repo = createFridayWorkflowBuilderDraftRepository();
    const draft = makeDraft();

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, draft);
    });

    const fetched = db.withReadConnection((readerDb) => repo.getById(readerDb, "draft-1"));
    expect(fetched).not.toBeNull();
    expect(fetched!.draftId).toBe("draft-1");
    expect(fetched!.title).toBe("My Draft");
    expect(fetched!.status).toBe("active");
    expect(fetched!.revision).toBe(1);
  });

  it("returns null for missing draft", () => {
    const repo = createFridayWorkflowBuilderDraftRepository();
    const fetched = db.withReadConnection((readerDb) => repo.getById(readerDb, "nonexistent"));
    expect(fetched).toBeNull();
  });

  it("lists drafts by workflow", () => {
    const repo = createFridayWorkflowBuilderDraftRepository();

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, makeDraft({ draftId: "draft-1", workflowId: "wf-1" }));
      repo.create(writerDb, makeDraft({ draftId: "draft-2", workflowId: "wf-1" }));
      repo.create(writerDb, makeDraft({ draftId: "draft-3", workflowId: "wf-2" }));
    });

    const wf1Drafts = db.withReadConnection((readerDb) => repo.listByWorkflow(readerDb, "wf-1"));
    expect(wf1Drafts).toHaveLength(2);

    const wf2Drafts = db.withReadConnection((readerDb) => repo.listByWorkflow(readerDb, "wf-2"));
    expect(wf2Drafts).toHaveLength(1);
  });

  it("lists drafts by status", () => {
    const repo = createFridayWorkflowBuilderDraftRepository();

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, makeDraft({ draftId: "draft-1", status: "active" }));
      repo.create(writerDb, makeDraft({ draftId: "draft-2", workflowId: "wf-2", status: "archived" }));
    });

    const activeDrafts = db.withReadConnection((readerDb) => repo.listByStatus(readerDb, "active"));
    expect(activeDrafts).toHaveLength(1);
    expect(activeDrafts[0]!.draftId).toBe("draft-1");
  });

  it("updates a draft", () => {
    const repo = createFridayWorkflowBuilderDraftRepository();
    const draft = makeDraft();

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, draft);
    });

    const updated = { ...draft, title: "Updated Title", revision: 2, updatedAt: "2025-06-15T11:00:00.000Z" };
    db.withWriteTransaction((writerDb) => {
      repo.update(writerDb, updated);
    });

    const fetched = db.withReadConnection((readerDb) => repo.getById(readerDb, "draft-1"));
    expect(fetched!.title).toBe("Updated Title");
    expect(fetched!.revision).toBe(2);
  });

  it("throws on update of missing draft", () => {
    const repo = createFridayWorkflowBuilderDraftRepository();
    const draft = makeDraft({ draftId: "nonexistent" });

    expect(() =>
      db.withWriteTransaction((writerDb) => repo.update(writerDb, draft)),
    ).toThrow("DRAFT_NOT_FOUND");
  });

  it("updates draft status", () => {
    const repo = createFridayWorkflowBuilderDraftRepository();
    const draft = makeDraft();

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, draft);
      repo.updateStatus(writerDb, "draft-1", "archived", "2025-06-15T12:00:00.000Z");
    });

    const fetched = db.withReadConnection((readerDb) => repo.getById(readerDb, "draft-1"));
    expect(fetched!.status).toBe("archived");
  });

  it("stores namespace and key correctly", () => {
    const repo = createFridayWorkflowBuilderDraftRepository();
    const draft = makeDraft();

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, draft);
    });

    // Verify raw row
    const row = db.withReadConnection((readerDb) =>
      readerDb
        .prepare("SELECT namespace, key FROM memory_items WHERE id = ?")
        .get("draft-1"),
    ) as { namespace: string; key: string };

    expect(row.namespace).toBe("workflow_builder_drafts");
    expect(row.key).toBe("wf-1:draft-1");
  });

  it("round-trips JSON correctly", () => {
    const repo = createFridayWorkflowBuilderDraftRepository();
    const draft = makeDraft();
    draft.spec.inputs = [{ key: "test_input", type: "string", required: true }];

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, draft);
    });

    const fetched = db.withReadConnection((readerDb) => repo.getById(readerDb, "draft-1"));
    expect(fetched!.spec.inputs).toHaveLength(1);
    expect(fetched!.spec.inputs[0]!.key).toBe("test_input");
  });
});

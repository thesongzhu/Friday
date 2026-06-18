import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridayWorkflowBuilderDraftRepository } from "#workflows";
import type { FridayWorkflowDraftEntity } from "#workflows";
import { createTestDb } from "../_helpers/create-test-db.helper.js";
import { createTestSpec, createTestVisual } from "./_helpers/create-test-spec.helper.js";

describe("FridayWorkflowBuilderDraftRepository", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    seedWorkflow("wf-1");
    seedWorkflow("wf-2");
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

  function insertLegacyDraft(draft: FridayWorkflowDraftEntity): void {
    db.writer
      .prepare(
        `INSERT INTO memory_items (id, namespace, key, value_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        draft.draftId,
        "workflow_builder_drafts",
        `${draft.workflowId}:${draft.draftId}`,
        JSON.stringify(draft),
        draft.createdAt,
        draft.updatedAt,
      );
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

  it("stores new drafts in the workflow builder table without writing memory_items", () => {
    const repo = createFridayWorkflowBuilderDraftRepository();
    const draft = makeDraft({
      autosave: { enabled: true, intervalMs: 45000, lastSavedAt: "2025-06-15T10:30:00.000Z" },
      publishedVersionId: "version-1",
      sourceReview: {
        source: "external",
        sourceUrl: "https://example.com/spec",
        requiresReviewBeforePublish: true,
        confirmedAt: "2025-06-15T10:15:00.000Z",
      },
    });

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, draft);
    });

    const row = db.withReadConnection((readerDb) =>
      readerDb
        .prepare(
          `SELECT draft_id, workflow_id, published_workflow_version_id, autosave_last_saved_at, source_review_json
           FROM workflow_builder_drafts WHERE draft_id = ?`,
        )
        .get("draft-1"),
    ) as {
      draft_id: string;
      workflow_id: string;
      published_workflow_version_id: string | null;
      autosave_last_saved_at: string | null;
      source_review_json: string | null;
    };

    const memoryRowCount = db.withReadConnection((readerDb) =>
      readerDb
        .prepare("SELECT COUNT(*) AS count FROM memory_items WHERE namespace = ?")
        .get("workflow_builder_drafts"),
    ) as { count: number };

    expect(row.draft_id).toBe("draft-1");
    expect(row.workflow_id).toBe("wf-1");
    expect(row.published_workflow_version_id).toBe("version-1");
    expect(row.autosave_last_saved_at).toBe("2025-06-15T10:30:00.000Z");
    expect(JSON.parse(row.source_review_json ?? "{}")).toMatchObject({
      source: "external",
      sourceUrl: "https://example.com/spec",
      requiresReviewBeforePublish: true,
    });
    expect(memoryRowCount.count).toBe(0);
  });

  it("reads legacy memory_items drafts and updates them into the dedicated table", () => {
    const repo = createFridayWorkflowBuilderDraftRepository();
    const legacyDraft = makeDraft({
      draftId: "legacy-draft",
      title: "Legacy Draft",
      updatedAt: "2025-06-15T09:00:00.000Z",
    });
    insertLegacyDraft(legacyDraft);

    const fetched = db.withReadConnection((readerDb) => repo.getById(readerDb, "legacy-draft"));
    expect(fetched!.title).toBe("Legacy Draft");

    db.withWriteTransaction((writerDb) => {
      repo.update(writerDb, {
        ...legacyDraft,
        title: "Promoted Draft",
        revision: 2,
        updatedAt: "2025-06-15T11:00:00.000Z",
      });
    });

    const dedicatedRow = db.withReadConnection((readerDb) =>
      readerDb
        .prepare("SELECT title, revision FROM workflow_builder_drafts WHERE draft_id = ?")
        .get("legacy-draft"),
    ) as { title: string; revision: number };
    const memoryRowCount = db.withReadConnection((readerDb) =>
      readerDb
        .prepare("SELECT COUNT(*) AS count FROM memory_items WHERE namespace = ?")
        .get("workflow_builder_drafts"),
    ) as { count: number };

    expect(dedicatedRow.title).toBe("Promoted Draft");
    expect(dedicatedRow.revision).toBe(2);
    expect(memoryRowCount.count).toBe(1);
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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridayWorkflowConflictService,
  FridayConflictServiceError,
} from "#api";
import type { FridayWorkflowConflictService } from "#api";

describe("FridayWorkflowConflictService", () => {
  let db: FridaySqliteLayer;
  let service: FridayWorkflowConflictService;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  /** Seed a parent workflow so FK constraints are satisfied. */
  function seedWorkflow(workflowId: string) {
    db.writer.prepare(
      `INSERT OR IGNORE INTO workflows (id, slug, name, latest_version_number, is_archived, revision, etag, created_at, updated_at)
       VALUES (?, ?, ?, 1, 0, 1, 'etag', ?, ?)`,
    ).run(workflowId, `slug-${workflowId}`, `Workflow ${workflowId}`, NOW, NOW);
  }

  function insertLock(workflowId: string, lockToken: string, ownerUserId: string, expiresAt = "2025-06-16T10:00:00.000Z") {
    seedWorkflow(workflowId);
    db.writer.prepare(
      `INSERT INTO workflow_locks (workflow_id, lock_token, owner_user_id, acquired_at, heartbeat_at, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(workflowId, lockToken, ownerUserId, NOW, NOW, expiresAt, NOW, NOW);
  }

  function insertDraft(draftId: string, workflowId: string, revision = 1) {
    seedWorkflow(workflowId);
    db.writer.prepare(
      `INSERT OR IGNORE INTO workflow_builder_drafts (draft_id, workflow_id, title, status, revision, spec_json, visual_json, created_at, updated_at)
       VALUES (?, ?, 'Test Draft', 'active', ?, '{}', '{}', ?, ?)`,
    ).run(draftId, workflowId, revision, NOW, NOW);
  }

  /** Seed workflow + draft so FK constraints on workflow_conflicts are satisfied. */
  function seedConflictParents(workflowId: string, draftId: string) {
    seedWorkflow(workflowId);
    insertDraft(draftId, workflowId);
  }

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
    service = createFridayWorkflowConflictService({
      db,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  // ─── detectConflict ───

  it("returns null when no base version provided", () => {
    const result = service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-1",
      headWorkflowVersionId: "v2",
      summary: "test conflict",
    });
    expect(result).toBeNull();
  });

  it("returns null when base matches head (no divergence)", () => {
    const result = service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-1",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v1",
      summary: "no conflict",
    });
    expect(result).toBeNull();
  });

  it("detects conflict when base differs from head", () => {
    seedConflictParents("wf-1", "draft-1");
    const result = service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-1",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v2",
      summary: "Someone published v2 while editing from v1",
    });

    expect(result).not.toBeNull();
    expect(result!.conflictId).toBeTruthy();
    expect(result!.workflowId).toBe("wf-1");
    expect(result!.draftId).toBe("draft-1");
    expect(result!.kind).toBe("revision_conflict");
    expect(result!.status).toBe("open");
    expect(result!.baseWorkflowVersionId).toBe("v1");
    expect(result!.headWorkflowVersionId).toBe("v2");
    expect(result!.detectedAt).toBe(NOW);
  });

  it("persists conflict to database", () => {
    seedConflictParents("wf-1", "draft-1");
    service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-1",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v2",
      summary: "persisted conflict",
    });

    const row = db.writer
      .prepare("SELECT * FROM workflow_conflicts WHERE workflow_id = 'wf-1'")
      .get() as { status: string } | undefined;
    expect(row).toBeTruthy();
    expect(row!.status).toBe("open");
  });

  // ─── listConflicts ───

  it("lists conflicts for a workflow", () => {
    seedConflictParents("wf-1", "draft-1");
    seedConflictParents("wf-1", "draft-2");
    seedConflictParents("wf-2", "draft-3");
    service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-1",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v2",
      summary: "conflict 1",
    });
    service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-2",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v3",
      summary: "conflict 2",
    });
    service.detectConflict({
      workflowId: "wf-2",
      draftId: "draft-3",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v2",
      summary: "conflict for different workflow",
    });

    const conflicts = service.listConflicts("wf-1");
    expect(conflicts).toHaveLength(2);
  });

  it("filters conflicts by status", () => {
    insertLock("wf-1", "lock-1", "user-1");
    insertDraft("draft-1", "wf-1", 1);

    const conflict = service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-1",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v2",
      summary: "to be resolved",
    })!;

    service.resolveConflict(
      conflict.conflictId,
      {
        resolution: { strategy: "accept_local" },
        lockToken: "lock-1",
        expectedDraftRevision: 1,
      },
      "user-1",
    );

    seedConflictParents("wf-1", "draft-2");
    service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-2",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v3",
      summary: "still open",
    });

    const openConflicts = service.listConflicts("wf-1", "open");
    expect(openConflicts).toHaveLength(1);
    expect(openConflicts[0].status).toBe("open");

    const resolved = service.listConflicts("wf-1", "resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].status).toBe("resolved");
  });

  // ─── getConflict ───

  it("returns a conflict by ID", () => {
    seedConflictParents("wf-1", "draft-1");
    const created = service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-1",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v2",
      summary: "get by id",
    })!;

    const retrieved = service.getConflict(created.conflictId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.conflictId).toBe(created.conflictId);
  });

  it("returns null for unknown conflict ID", () => {
    const result = service.getConflict("nonexistent");
    expect(result).toBeNull();
  });

  // ─── resolveConflict ───

  it("resolves an open conflict with accept_local strategy", () => {
    insertLock("wf-1", "lock-1", "user-1");
    insertDraft("draft-1", "wf-1", 1);

    const conflict = service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-1",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v2",
      summary: "resolve me",
    })!;

    const result = service.resolveConflict(
      conflict.conflictId,
      {
        resolution: { strategy: "accept_local" },
        lockToken: "lock-1",
        expectedDraftRevision: 1,
      },
      "user-1",
    );

    expect(result.conflict.status).toBe("resolved");
    expect(result.conflict.resolvedAt).toBe(NOW);
    expect(result.conflict.resolvedByUserId).toBe("user-1");
    expect(result.draft).toBeTruthy();
    expect(result.draft.draftId).toBe("draft-1");
  });

  it("throws NOT_FOUND for unknown conflict", () => {
    expect(() =>
      service.resolveConflict(
        "nonexistent",
        {
          resolution: { strategy: "accept_local" },
          lockToken: "lock-1",
          expectedDraftRevision: 1,
        },
        "user-1",
      ),
    ).toThrow(FridayConflictServiceError);

    try {
      service.resolveConflict(
        "nonexistent",
        {
          resolution: { strategy: "accept_local" },
          lockToken: "lock-1",
          expectedDraftRevision: 1,
        },
        "user-1",
      );
    } catch (err) {
      expect((err as FridayConflictServiceError).code).toBe("CONFLICT_NOT_FOUND");
    }
  });

  it("throws ALREADY_RESOLVED for already resolved conflict", () => {
    insertLock("wf-1", "lock-1", "user-1");
    insertLock("wf-1", "lock-2", "user-2");
    insertDraft("draft-1", "wf-1", 1);

    const conflict = service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-1",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v2",
      summary: "resolve twice",
    })!;

    service.resolveConflict(
      conflict.conflictId,
      {
        resolution: { strategy: "accept_local" },
        lockToken: "lock-1",
        expectedDraftRevision: 1,
      },
      "user-1",
    );

    expect(() =>
      service.resolveConflict(
        conflict.conflictId,
        {
          resolution: { strategy: "accept_remote" },
          lockToken: "lock-2",
          expectedDraftRevision: 2,
        },
        "user-2",
      ),
    ).toThrow(FridayConflictServiceError);

    try {
      service.resolveConflict(
        conflict.conflictId,
        {
          resolution: { strategy: "accept_remote" },
          lockToken: "lock-2",
          expectedDraftRevision: 2,
        },
        "user-2",
      );
    } catch (err) {
      expect((err as FridayConflictServiceError).code).toBe("ALREADY_RESOLVED");
    }
  });

  it("draft revision is incremented after resolution", () => {
    insertLock("wf-1", "lock-1", "user-1");
    insertDraft("draft-1", "wf-1", 5);

    const conflict = service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-1",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v2",
      summary: "revision test",
    })!;

    const result = service.resolveConflict(
      conflict.conflictId,
      {
        resolution: { strategy: "accept_local" },
        lockToken: "lock-1",
        expectedDraftRevision: 5,
      },
      "user-1",
    );

    expect(result.draft.revision).toBe(6);
  });
});

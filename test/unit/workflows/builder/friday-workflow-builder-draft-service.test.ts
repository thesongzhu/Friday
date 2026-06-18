import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "#state";
import { createFridayWorkflowBuilderDraftService } from "#workflows";
import { createFridayWorkflowBuilderDraftRepository } from "#workflows";
import { createFridayWorkflowBuilderLockRepository } from "#workflows";
import { createFridayWorkflowBuilderCollaborationService } from "#workflows";
import type { FridayWorkflowBuilderCollaborationService } from "#workflows";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.helper.js";
import { createTestSpec, createTestVisual } from "./_helpers/create-test-spec.helper.js";

describe("FridayWorkflowBuilderDraftService", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-06-15T10:00:00.000Z";
  const computeChecksum = (content: string) =>
    createHash("sha256").update(content).digest("hex");

  beforeEach(() => {
    db = createTestDb();
    seedWorkflow("wf-1");
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

    return { draftService, collaborationService };
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

  it("creates a draft", () => {
    const { draftService } = createServices();
    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "My Draft",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
      ownerUserId: "test-user",
    });

    expect(draft.title).toBe("My Draft");
    expect(draft.status).toBe("active");
    expect(draft.revision).toBe(1);
    expect(draft.autosave.enabled).toBe(true);
  });

  it("gets a draft by id", () => {
    const { draftService } = createServices();
    const created = draftService.createDraft({
      workflowId: "wf-1",
      title: "My Draft",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
    });

    const fetched = draftService.getDraft(created.draftId);
    expect(fetched).not.toBeNull();
    expect(fetched!.draftId).toBe(created.draftId);
  });

  it("lists drafts by workflow", () => {
    const { draftService } = createServices();
    draftService.createDraft({
      workflowId: "wf-1",
      title: "Draft 1",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
    });
    draftService.createDraft({
      workflowId: "wf-1",
      title: "Draft 2",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
    });

    const drafts = draftService.listDrafts("wf-1");
    expect(drafts).toHaveLength(2);
  });

  it("save requires lock", () => {
    const { draftService } = createServices();
    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "My Draft",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
    });

    expect(() =>
      draftService.saveDraft({
        draftId: draft.draftId,
        expectedRevision: 1,
        lockToken: "bad-token",
        title: "Updated",
      }),
    ).toThrow();
  });

  it("saves draft with valid lock and revision", () => {
    const { draftService, collaborationService } = createServices();
    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "My Draft",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
      ownerUserId: "test-user",
    });

    const lockResult = collaborationService.acquireLock({
      workflowId: "wf-1",
      ownerUserId: "test-user",
      ttlSec: 300,
    });

    const saved = draftService.saveDraft({
      draftId: draft.draftId,
      expectedRevision: 1,
      lockToken: lockResult.lock!.lockToken,
      title: "Updated Title",
    });

    expect(saved.title).toBe("Updated Title");
    expect(saved.revision).toBe(2);
  });

  it("save throws on revision conflict", () => {
    const { draftService, collaborationService } = createServices();
    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "My Draft",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
      ownerUserId: "test-user",
    });

    const lockResult = collaborationService.acquireLock({
      workflowId: "wf-1",
      ownerUserId: "test-user",
      ttlSec: 300,
    });

    expect(() =>
      draftService.saveDraft({
        draftId: draft.draftId,
        expectedRevision: 99, // wrong revision
        lockToken: lockResult.lock!.lockToken,
        title: "Updated",
      }),
    ).toThrow("Draft version conflict");
  });

  it("autosave skips when content unchanged", () => {
    const { draftService, collaborationService } = createServices();
    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "My Draft",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
      ownerUserId: "test-user",
    });

    const lockResult = collaborationService.acquireLock({
      workflowId: "wf-1",
      ownerUserId: "test-user",
      ttlSec: 300,
    });

    const result = draftService.autosaveDraft({
      draftId: draft.draftId,
      lockToken: lockResult.lock!.lockToken,
      spec: draft.spec,
      visual: draft.visual,
    });

    expect(result).toBeNull(); // no-op
  });

  it("autosave saves when content changed", () => {
    const { draftService, collaborationService } = createServices();
    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "My Draft",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
      ownerUserId: "test-user",
    });

    const lockResult = collaborationService.acquireLock({
      workflowId: "wf-1",
      ownerUserId: "test-user",
      ttlSec: 300,
    });

    const modifiedSpec = { ...draft.spec, name: "Modified Name" };
    const result = draftService.autosaveDraft({
      draftId: draft.draftId,
      lockToken: lockResult.lock!.lockToken,
      spec: modifiedSpec,
      visual: draft.visual,
    });

    expect(result).not.toBeNull();
    expect(result!.spec.name).toBe("Modified Name");
    expect(result!.autosave.lastSavedAt).toBe(NOW);
  });

  it("archives a draft", () => {
    const { draftService, collaborationService } = createServices();
    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "To Archive",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
      ownerUserId: "test-user",
    });

    const lockResult = collaborationService.acquireLock({
      workflowId: "wf-1",
      ownerUserId: "test-user",
      ttlSec: 300,
    });

    draftService.archiveDraft(draft.draftId, lockResult.lock!.lockToken);

    const fetched = draftService.getDraft(draft.draftId);
    expect(fetched!.status).toBe("archived");
  });

  it("save with expired lock fails atomically", () => {
    const { draftService, collaborationService } = createServices();
    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "My Draft",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
      ownerUserId: "test-user",
    });

    // Acquire a lock with a very short TTL — but since our test uses a fixed NOW,
    // we need a lock whose expiresAt is already in the past. We can simulate this by
    // acquiring a lock, then using a collaboration service whose nowIso is after expiry.
    const lockResult = collaborationService.acquireLock({
      workflowId: "wf-1",
      ownerUserId: "test-user",
      ttlSec: 1, // 1 second TTL
    });

    // Create a new draft service with a nowIso well past the lock expiry
    const idGen = createTestIdGenerator();
    const lockRepo = createFridayWorkflowBuilderLockRepository();
    const expiredNow = "2099-01-01T00:00:00.000Z";
    const collaborationService2 = createFridayWorkflowBuilderCollaborationService({
      db,
      lockRepo,
      idGenerator: idGen,
      nowIso: () => expiredNow,
    });
    const draftService2 = createFridayWorkflowBuilderDraftService({
      db,
      draftRepo: createFridayWorkflowBuilderDraftRepository(),
      collaborationService: collaborationService2,
      idGenerator: idGen,
      nowIso: () => expiredNow,
      computeChecksum: (content) => createHash("sha256").update(content).digest("hex"),
    });

    expect(() =>
      draftService2.saveDraft({
        draftId: draft.draftId,
        expectedRevision: 1,
        lockToken: lockResult.lock!.lockToken,
        title: "Should fail",
      }),
    ).toThrow("Lock has expired");
  });

  it("autosave with expired lock fails atomically", () => {
    const { draftService, collaborationService } = createServices();
    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "My Draft",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
      ownerUserId: "test-user",
    });

    const lockResult = collaborationService.acquireLock({
      workflowId: "wf-1",
      ownerUserId: "test-user",
      ttlSec: 1,
    });

    const idGen = createTestIdGenerator();
    const lockRepo = createFridayWorkflowBuilderLockRepository();
    const expiredNow = "2099-01-01T00:00:00.000Z";
    const collaborationService2 = createFridayWorkflowBuilderCollaborationService({
      db,
      lockRepo,
      idGenerator: idGen,
      nowIso: () => expiredNow,
    });
    const draftService2 = createFridayWorkflowBuilderDraftService({
      db,
      draftRepo: createFridayWorkflowBuilderDraftRepository(),
      collaborationService: collaborationService2,
      idGenerator: idGen,
      nowIso: () => expiredNow,
      computeChecksum: (content) => createHash("sha256").update(content).digest("hex"),
    });

    expect(() =>
      draftService2.autosaveDraft({
        draftId: draft.draftId,
        lockToken: lockResult.lock!.lockToken,
        spec: { ...draft.spec, name: "Changed" },
        visual: draft.visual,
      }),
    ).toThrow("Lock has expired");
  });

  it("archive with expired lock fails atomically", () => {
    const { draftService, collaborationService } = createServices();
    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "My Draft",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
      ownerUserId: "test-user",
    });

    const lockResult = collaborationService.acquireLock({
      workflowId: "wf-1",
      ownerUserId: "test-user",
      ttlSec: 1,
    });

    const idGen = createTestIdGenerator();
    const lockRepo = createFridayWorkflowBuilderLockRepository();
    const expiredNow = "2099-01-01T00:00:00.000Z";
    const collaborationService2 = createFridayWorkflowBuilderCollaborationService({
      db,
      lockRepo,
      idGenerator: idGen,
      nowIso: () => expiredNow,
    });
    const draftService2 = createFridayWorkflowBuilderDraftService({
      db,
      draftRepo: createFridayWorkflowBuilderDraftRepository(),
      collaborationService: collaborationService2,
      idGenerator: idGen,
      nowIso: () => expiredNow,
      computeChecksum: (content) => createHash("sha256").update(content).digest("hex"),
    });

    expect(() =>
      draftService2.archiveDraft(draft.draftId, lockResult.lock!.lockToken),
    ).toThrow("Lock has expired");
  });

  it("forks a draft", () => {
    const { draftService } = createServices();
    const original = draftService.createDraft({
      workflowId: "wf-1",
      title: "Original",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
    });

    const forked = draftService.forkDraft(original.draftId, "Forked Draft");

    expect(forked.draftId).not.toBe(original.draftId);
    expect(forked.title).toBe("Forked Draft");
    expect(forked.workflowId).toBe("wf-1");
    expect(forked.revision).toBe(1);
    expect(forked.status).toBe("active");
    expect(forked.spec.name).toBe(original.spec.name);
  });

  describe("lock assertion atomicity", () => {
    it("uses assertLockOnConnection (writer) not assertLock (read pool) in saveDraft", () => {
      const idGen = createTestIdGenerator();
      const lockRepo = createFridayWorkflowBuilderLockRepository();
      const collaborationService = createFridayWorkflowBuilderCollaborationService({
        db,
        lockRepo,
        idGenerator: idGen,
        nowIso: () => NOW,
      });

      // Spy on both methods
      const assertLockSpy = vi.spyOn(collaborationService, "assertLock");
      const assertLockOnConnectionSpy = vi.spyOn(collaborationService, "assertLockOnConnection");

      const draftService = createFridayWorkflowBuilderDraftService({
        db,
        draftRepo: createFridayWorkflowBuilderDraftRepository(),
        collaborationService,
        idGenerator: idGen,
        nowIso: () => NOW,
        computeChecksum,
      });

      const draft = draftService.createDraft({
        workflowId: "wf-1",
        title: "Atomic Test",
        spec: createTestSpec({ workflowId: "wf-1" }),
        visual: createTestVisual("wf-1"),
        ownerUserId: "test-user",
      });

      const lockResult = collaborationService.acquireLock({
        workflowId: "wf-1",
        ownerUserId: "test-user",
        ttlSec: 300,
      });

      draftService.saveDraft({
        draftId: draft.draftId,
        expectedRevision: 1,
        lockToken: lockResult.lock!.lockToken,
        title: "Updated",
      });

      // assertLockOnConnection should be called (atomic, uses writer connection)
      expect(assertLockOnConnectionSpy).toHaveBeenCalledTimes(1);
      // assertLock (read pool) should NOT be called
      expect(assertLockSpy).not.toHaveBeenCalled();
    });

    it("uses assertLockOnConnection (writer) not assertLock (read pool) in autosaveDraft", () => {
      const idGen = createTestIdGenerator();
      const lockRepo = createFridayWorkflowBuilderLockRepository();
      const collaborationService = createFridayWorkflowBuilderCollaborationService({
        db,
        lockRepo,
        idGenerator: idGen,
        nowIso: () => NOW,
      });

      const assertLockSpy = vi.spyOn(collaborationService, "assertLock");
      const assertLockOnConnectionSpy = vi.spyOn(collaborationService, "assertLockOnConnection");

      const draftService = createFridayWorkflowBuilderDraftService({
        db,
        draftRepo: createFridayWorkflowBuilderDraftRepository(),
        collaborationService,
        idGenerator: idGen,
        nowIso: () => NOW,
        computeChecksum,
      });

      const draft = draftService.createDraft({
        workflowId: "wf-1",
        title: "Atomic Test",
        spec: createTestSpec({ workflowId: "wf-1" }),
        visual: createTestVisual("wf-1"),
        ownerUserId: "test-user",
      });

      const lockResult = collaborationService.acquireLock({
        workflowId: "wf-1",
        ownerUserId: "test-user",
        ttlSec: 300,
      });

      // Reset spies after acquireLock (which doesn't use these methods, but be safe)
      assertLockSpy.mockClear();
      assertLockOnConnectionSpy.mockClear();

      draftService.autosaveDraft({
        draftId: draft.draftId,
        lockToken: lockResult.lock!.lockToken,
        spec: { ...draft.spec, name: "Changed" },
        visual: draft.visual,
      });

      expect(assertLockOnConnectionSpy).toHaveBeenCalledTimes(1);
      expect(assertLockSpy).not.toHaveBeenCalled();
    });

    it("uses assertLockOnConnection (writer) not assertLock (read pool) in archiveDraft", () => {
      const idGen = createTestIdGenerator();
      const lockRepo = createFridayWorkflowBuilderLockRepository();
      const collaborationService = createFridayWorkflowBuilderCollaborationService({
        db,
        lockRepo,
        idGenerator: idGen,
        nowIso: () => NOW,
      });

      const assertLockSpy = vi.spyOn(collaborationService, "assertLock");
      const assertLockOnConnectionSpy = vi.spyOn(collaborationService, "assertLockOnConnection");

      const draftService = createFridayWorkflowBuilderDraftService({
        db,
        draftRepo: createFridayWorkflowBuilderDraftRepository(),
        collaborationService,
        idGenerator: idGen,
        nowIso: () => NOW,
        computeChecksum,
      });

      const draft = draftService.createDraft({
        workflowId: "wf-1",
        title: "Atomic Test",
        spec: createTestSpec({ workflowId: "wf-1" }),
        visual: createTestVisual("wf-1"),
        ownerUserId: "test-user",
      });

      const lockResult = collaborationService.acquireLock({
        workflowId: "wf-1",
        ownerUserId: "test-user",
        ttlSec: 300,
      });

      assertLockSpy.mockClear();
      assertLockOnConnectionSpy.mockClear();

      draftService.archiveDraft(draft.draftId, lockResult.lock!.lockToken);

      expect(assertLockOnConnectionSpy).toHaveBeenCalledTimes(1);
      expect(assertLockSpy).not.toHaveBeenCalled();
    });

    it("assertLockOnConnection receives the writer db, not a read-pool connection", () => {
      const idGen = createTestIdGenerator();
      const lockRepo = createFridayWorkflowBuilderLockRepository();
      const collaborationService = createFridayWorkflowBuilderCollaborationService({
        db,
        lockRepo,
        idGenerator: idGen,
        nowIso: () => NOW,
      });

      let writerDbFromTransaction: unknown = null;
      let dbPassedToAssert: unknown = null;

      // Intercept assertLockOnConnection to capture the db argument
      const origAssert = collaborationService.assertLockOnConnection.bind(collaborationService);
      collaborationService.assertLockOnConnection = (connDb, workflowId, lockToken) => {
        dbPassedToAssert = connDb;
        return origAssert(connDb, workflowId, lockToken);
      };

      // Intercept withWriteTransaction to capture the writer db
      const origTx = db.withWriteTransaction.bind(db);
      db.withWriteTransaction = <T>(fn: (writerDb: import("better-sqlite3").Database) => T): T => {
        return origTx((writerDb) => {
          writerDbFromTransaction = writerDb;
          return fn(writerDb);
        });
      };

      const draftRepo = createFridayWorkflowBuilderDraftRepository();
      const draftService = createFridayWorkflowBuilderDraftService({
        db,
        draftRepo,
        collaborationService,
        idGenerator: idGen,
        nowIso: () => NOW,
        computeChecksum,
      });

      const draft = draftService.createDraft({
        workflowId: "wf-1",
        title: "Connection Test",
        spec: createTestSpec({ workflowId: "wf-1" }),
        visual: createTestVisual("wf-1"),
        ownerUserId: "test-user",
      });

      const lockResult = collaborationService.acquireLock({
        workflowId: "wf-1",
        ownerUserId: "test-user",
        ttlSec: 300,
      });

      // Reset captures before the call we care about
      writerDbFromTransaction = null;
      dbPassedToAssert = null;

      draftService.saveDraft({
        draftId: draft.draftId,
        expectedRevision: 1,
        lockToken: lockResult.lock!.lockToken,
        title: "Connection Verified",
      });

      // The db passed to assertLockOnConnection must be the SAME object
      // as the writer db from the transaction
      expect(dbPassedToAssert).not.toBeNull();
      expect(writerDbFromTransaction).not.toBeNull();
      expect(dbPassedToAssert).toBe(writerDbFromTransaction);
    });
  });
});

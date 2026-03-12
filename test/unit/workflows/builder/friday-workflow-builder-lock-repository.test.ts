import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridayWorkflowBuilderLockRepository } from "#workflows";
import type { FridayWorkflowEditLock } from "#workflows";
import { createTestDb } from "../_helpers/create-test-db.helper.js";

describe("FridayWorkflowBuilderLockRepository", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function makeLock(overrides?: Partial<FridayWorkflowEditLock>): FridayWorkflowEditLock {
    return {
      workflowId: "wf-1",
      lockToken: "lock-token-1",
      ownerUserId: "test-user",
      acquiredAt: "2025-06-15T10:00:00.000Z",
      heartbeatAt: "2025-06-15T10:00:00.000Z",
      expiresAt: "2025-06-15T10:30:00.000Z",
      ...overrides,
    };
  }

  it("sets and gets a lock", () => {
    const repo = createFridayWorkflowBuilderLockRepository();
    const lock = makeLock();

    db.withWriteTransaction((writerDb) => {
      repo.setLock(writerDb, lock);
    });

    const fetched = db.withReadConnection((readerDb) => repo.getLock(readerDb, "wf-1"));
    expect(fetched).not.toBeNull();
    expect(fetched!.lockToken).toBe("lock-token-1");
    expect(fetched!.ownerUserId).toBe("test-user");
  });

  it("returns null for no lock", () => {
    const repo = createFridayWorkflowBuilderLockRepository();
    const fetched = db.withReadConnection((readerDb) => repo.getLock(readerDb, "nonexistent"));
    expect(fetched).toBeNull();
  });

  it("updates an existing lock (upsert)", () => {
    const repo = createFridayWorkflowBuilderLockRepository();
    const lock1 = makeLock();

    db.withWriteTransaction((writerDb) => {
      repo.setLock(writerDb, lock1);
    });

    const lock2 = makeLock({
      lockToken: "lock-token-2",
      ownerUserId: "user-2",
      heartbeatAt: "2025-06-15T10:15:00.000Z",
    });

    db.withWriteTransaction((writerDb) => {
      repo.setLock(writerDb, lock2);
    });

    const fetched = db.withReadConnection((readerDb) => repo.getLock(readerDb, "wf-1"));
    expect(fetched!.lockToken).toBe("lock-token-2");
    expect(fetched!.ownerUserId).toBe("user-2");
  });

  it("deletes a lock", () => {
    const repo = createFridayWorkflowBuilderLockRepository();

    db.withWriteTransaction((writerDb) => {
      repo.setLock(writerDb, makeLock());
    });

    db.withWriteTransaction((writerDb) => {
      repo.deleteLock(writerDb, "wf-1");
    });

    const fetched = db.withReadConnection((readerDb) => repo.getLock(readerDb, "wf-1"));
    expect(fetched).toBeNull();
  });

  it("stores lock in hub_settings with correct key", () => {
    const repo = createFridayWorkflowBuilderLockRepository();

    db.withWriteTransaction((writerDb) => {
      repo.setLock(writerDb, makeLock());
    });

    const row = db.withReadConnection((readerDb) =>
      readerDb
        .prepare("SELECT key, revision FROM hub_settings WHERE key = ?")
        .get("workflow_builder_lock:wf-1"),
    ) as { key: string; revision: number } | undefined;

    expect(row).not.toBeUndefined();
    expect(row!.key).toBe("workflow_builder_lock:wf-1");
    expect(row!.revision).toBe(1);
  });

  it("increments revision on update", () => {
    const repo = createFridayWorkflowBuilderLockRepository();

    db.withWriteTransaction((writerDb) => {
      repo.setLock(writerDb, makeLock());
    });

    db.withWriteTransaction((writerDb) => {
      repo.setLock(writerDb, makeLock({ lockToken: "renewed" }));
    });

    const row = db.withReadConnection((readerDb) =>
      readerDb
        .prepare("SELECT revision FROM hub_settings WHERE key = ?")
        .get("workflow_builder_lock:wf-1"),
    ) as { revision: number };

    expect(row.revision).toBe(2);
  });
});

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

  it("stores lock in workflow_locks with the expected persisted fields", () => {
    const repo = createFridayWorkflowBuilderLockRepository();

    db.withWriteTransaction((writerDb) => {
      repo.setLock(writerDb, makeLock());
    });

    const row = db.withReadConnection((readerDb) =>
      readerDb
        .prepare(
          `SELECT workflow_id, lock_token, owner_user_id, owner_session_id, acquired_at, heartbeat_at, expires_at
           FROM workflow_locks
           WHERE workflow_id = ?`,
        )
        .get("wf-1"),
    ) as
      | {
          workflow_id: string;
          lock_token: string;
          owner_user_id: string;
          owner_session_id: string | null;
          acquired_at: string;
          heartbeat_at: string;
          expires_at: string;
        }
      | undefined;

    expect(row).not.toBeUndefined();
    expect(row!.workflow_id).toBe("wf-1");
    expect(row!.lock_token).toBe("lock-token-1");
    expect(row!.owner_user_id).toBe("test-user");
    expect(row!.owner_session_id).toBeNull();
    expect(row!.acquired_at).toBe("2025-06-15T10:00:00.000Z");
    expect(row!.heartbeat_at).toBe("2025-06-15T10:00:00.000Z");
    expect(row!.expires_at).toBe("2025-06-15T10:30:00.000Z");
  });

  it("replaces the persisted row on update", () => {
    const repo = createFridayWorkflowBuilderLockRepository();

    db.withWriteTransaction((writerDb) => {
      repo.setLock(writerDb, makeLock());
    });

    db.withWriteTransaction((writerDb) => {
      repo.setLock(
        writerDb,
        makeLock({
          lockToken: "renewed",
          ownerSessionId: "session-2",
          heartbeatAt: "2025-06-15T10:15:00.000Z",
        }),
      );
    });

    const rows = db.withReadConnection((readerDb) =>
      readerDb
        .prepare(
          `SELECT lock_token, owner_session_id, heartbeat_at
           FROM workflow_locks
           WHERE workflow_id = ?
           ORDER BY updated_at DESC`,
        )
        .all("wf-1"),
    ) as Array<{
      lock_token: string;
      owner_session_id: string | null;
      heartbeat_at: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      lock_token: "renewed",
      owner_session_id: "session-2",
      heartbeat_at: "2025-06-15T10:15:00.000Z",
    });
  });
});

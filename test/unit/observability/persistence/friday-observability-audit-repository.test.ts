import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";

import { createFridayObservabilityAuditRepository } from "../../../../src/observability/persistence/friday-observability-audit-repository.js";
import type {
  FridayAuditEntry,
  FridayRetentionCheckpoint,
} from "../../../../src/observability/model/friday-observability.types.js";
import { createTestDb } from "../../workflows/_helpers/create-test-db.helper.js";

describe("FridayObservabilityAuditRepository", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridayObservabilityAuditRepository({ db });
  }

  function makeEntry(
    overrides?: Partial<FridayAuditEntry>,
  ): FridayAuditEntry {
    return {
      id: "audit-1",
      sequenceNumber: 1,
      actor: {
        type: "user",
        id: "user-1",
        displayName: "Alice",
      },
      actionCategory: "create",
      action: "rules.create",
      resource: {
        type: "rule",
        id: "rule-1",
        displayName: "Rule 1",
      },
      outcome: "success",
      description: "Created rule-1",
      module: "rules",
      integrityHash: "hash-1",
      previousHash: null,
      recordedAt: "2026-04-19T09:00:00.000Z",
      ...overrides,
    };
  }

  function makeCheckpoint(
    overrides?: Partial<FridayRetentionCheckpoint>,
  ): FridayRetentionCheckpoint {
    return {
      id: "checkpoint-1",
      lastDeletedSequenceNumber: 1,
      boundaryHash: "hash-1",
      firstRetainedSequenceNumber: 2,
      createdAt: "2026-04-19T09:30:00.000Z",
      reason: "retention policy",
      ...overrides,
    };
  }

  it("persists and reloads audit entries in sequence order", () => {
    const repo = createRepo();

    repo.appendEntry(
      makeEntry({
        id: "audit-2",
        sequenceNumber: 2,
        integrityHash: "hash-2",
        previousHash: "hash-1",
        action: "rules.update",
        metadata: { nested: { enabled: true } },
      }),
    );
    repo.appendEntry(makeEntry());

    const snapshot = repo.loadSnapshot();

    expect(snapshot.entries.map((entry) => entry.sequenceNumber)).toEqual([1, 2]);
    expect(snapshot.entries[1]!.metadata).toEqual({ nested: { enabled: true } });
    expect(snapshot.checkpoints).toEqual([]);
  });

  it("records retention checkpoints and removes deleted audit entries atomically", () => {
    const repo = createRepo();

    repo.appendEntry(makeEntry());
    repo.appendEntry(
      makeEntry({
        id: "audit-2",
        sequenceNumber: 2,
        integrityHash: "hash-2",
        previousHash: "hash-1",
      }),
    );
    repo.appendEntry(
      makeEntry({
        id: "audit-3",
        sequenceNumber: 3,
        integrityHash: "hash-3",
        previousHash: "hash-2",
      }),
    );

    repo.recordRetention(
      makeCheckpoint({
        lastDeletedSequenceNumber: 2,
        boundaryHash: "hash-2",
        firstRetainedSequenceNumber: 3,
      }),
    );

    const snapshot = repo.loadSnapshot();
    expect(snapshot.entries.map((entry) => entry.sequenceNumber)).toEqual([3]);
    expect(snapshot.checkpoints).toHaveLength(1);
    expect(snapshot.checkpoints[0]).toMatchObject({
      lastDeletedSequenceNumber: 2,
      boundaryHash: "hash-2",
      firstRetainedSequenceNumber: 3,
    });
  });
});

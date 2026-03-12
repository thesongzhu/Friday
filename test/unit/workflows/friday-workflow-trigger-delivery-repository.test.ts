import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayWorkflowTriggerDeliveryRepository,
  createFridayWorkflowTriggerRepository,
  createFridayWorkflowRepository,
  createFridayWorkflowRunRepository,
} from "#workflows";
import { createTestDb } from "./_helpers/create-test-db.helper.js";

describe("FridayWorkflowTriggerDeliveryRepository", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    // Seed workflow, version, trigger registration
    const wfRepo = createFridayWorkflowRepository({ db });
    const triggerRepo = createFridayWorkflowTriggerRepository({ db });
    db.withWriteTransaction((conn) => {
      wfRepo.insertWorkflow(conn, "wf-1", { slug: "test-wf", name: "Test WF" }, "etag-1", NOW);
      wfRepo.insertVersion(conn, "wv-1", "wf-1", 1, "cs1", "{}", undefined, undefined, NOW);
    });
    triggerRepo.upsertManyForVersion([
      {
        id: "tr-1",
        workflowId: "wf-1",
        workflowVersionId: "wv-1",
        triggerNodeId: "node-trigger-1",
        triggerType: "cron",
        enabled: true,
        cronExpression: "0 * * * *",
        cronTimezone: "UTC",
        dedupeWindowSec: 300,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridayWorkflowTriggerDeliveryRepository({ db, nowIso: () => NOW });
  }

  // ─── tryInsert ───

  it("inserts a delivery successfully", () => {
    const repo = createRepo();
    const inserted = repo.tryInsert({
      id: "del-1",
      triggerRegistrationId: "tr-1",
      dedupeKey: "key-1",
      status: "accepted",
      deliveredAt: NOW,
    });
    expect(inserted).toBe(true);
  });

  it("returns false on duplicate dedupe key", () => {
    const repo = createRepo();
    repo.tryInsert({
      id: "del-1",
      triggerRegistrationId: "tr-1",
      dedupeKey: "key-1",
      status: "accepted",
      deliveredAt: NOW,
    });

    const duplicate = repo.tryInsert({
      id: "del-2",
      triggerRegistrationId: "tr-1",
      dedupeKey: "key-1",
      status: "accepted",
      deliveredAt: NOW,
    });
    expect(duplicate).toBe(false);
  });

  it("allows same dedupe key on different trigger registrations", () => {
    const repo = createRepo();
    const triggerRepo = createFridayWorkflowTriggerRepository({ db });

    triggerRepo.upsertManyForVersion([
      {
        id: "tr-2",
        workflowId: "wf-1",
        workflowVersionId: "wv-1",
        triggerNodeId: "node-trigger-2",
        triggerType: "webhook",
        enabled: true,
        webhookPathToken: "tok-2",
        dedupeWindowSec: 300,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);

    const first = repo.tryInsert({
      id: "del-1",
      triggerRegistrationId: "tr-1",
      dedupeKey: "same-key",
      status: "accepted",
      deliveredAt: NOW,
    });
    expect(first).toBe(true);

    const second = repo.tryInsert({
      id: "del-2",
      triggerRegistrationId: "tr-2",
      dedupeKey: "same-key",
      status: "accepted",
      deliveredAt: NOW,
    });
    expect(second).toBe(true);
  });

  it("throws on duplicate id (primary key violation is not treated as dedupe)", () => {
    const repo = createRepo();
    repo.tryInsert({
      id: "del-1",
      triggerRegistrationId: "tr-1",
      dedupeKey: "key-1",
      status: "accepted",
      deliveredAt: NOW,
    });

    // Same id, different dedupe key — should throw, not return false
    expect(() =>
      repo.tryInsert({
        id: "del-1",
        triggerRegistrationId: "tr-1",
        dedupeKey: "key-2",
        status: "accepted",
        deliveredAt: NOW,
      }),
    ).toThrow("UNIQUE constraint failed");
  });

  // ─── markAccepted ───

  it("marks delivery as accepted with run_id", () => {
    const repo = createRepo();
    const runRepo = createFridayWorkflowRunRepository();

    // Seed a run for FK
    db.withWriteTransaction((conn) => {
      runRepo.insertRun(conn, {
        id: "run-1",
        workflowId: "wf-1",
        workflowVersionId: "wv-1",
        status: "queued",
        triggerType: "cron",
        startedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      });
    });

    repo.tryInsert({
      id: "del-1",
      triggerRegistrationId: "tr-1",
      dedupeKey: "key-1",
      status: "accepted",
      deliveredAt: NOW,
    });

    repo.markAccepted("tr-1", "key-1", "run-1");

    const delivery = repo.getByDedupeKey("tr-1", "key-1");
    expect(delivery).not.toBeNull();
    expect(delivery!.status).toBe("accepted");
    expect(delivery!.runId).toBe("run-1");
  });

  // ─── markFailed ───

  it("marks delivery as failed with error details", () => {
    const repo = createRepo();
    repo.tryInsert({
      id: "del-1",
      triggerRegistrationId: "tr-1",
      dedupeKey: "key-1",
      status: "accepted",
      deliveredAt: NOW,
    });

    repo.markFailed("tr-1", "key-1", "TRIGGER_EXEC_FAILED", "Some error occurred");

    const delivery = repo.getByDedupeKey("tr-1", "key-1");
    expect(delivery).not.toBeNull();
    expect(delivery!.status).toBe("failed");
    expect(delivery!.errorCode).toBe("TRIGGER_EXEC_FAILED");
    expect(delivery!.errorMessage).toBe("Some error occurred");
  });

  // ─── getByDedupeKey (implementation-only helper) ───

  it("returns null for non-existent dedupe key", () => {
    const repo = createRepo();
    const result = repo.getByDedupeKey("tr-1", "missing");
    expect(result).toBeNull();
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayWorkflowTriggerRepository,
  createFridayWorkflowRepository,
} from "#workflows";
import type {
  FridayWorkflowTriggerRegistrationEntity,
} from "#workflows";
import { createTestDb } from "./_helpers/create-test-db.helper.js";

describe("FridayWorkflowTriggerRepository", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";
  const LATER = "2025-01-15T11:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    // Seed a workflow + version for FK constraints
    const wfRepo = createFridayWorkflowRepository({ db });
    db.withWriteTransaction((conn) => {
      wfRepo.insertWorkflow(conn, "wf-1", { slug: "test-wf", name: "Test WF" }, "etag-1", NOW);
      wfRepo.insertVersion(conn, "wv-1", "wf-1", 1, "cs1", "{}", undefined, undefined, NOW);
    });
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridayWorkflowTriggerRepository({ db });
  }

  function makeCronTrigger(overrides?: Partial<FridayWorkflowTriggerRegistrationEntity>): FridayWorkflowTriggerRegistrationEntity {
    return {
      id: "tr-1",
      workflowId: "wf-1",
      workflowVersionId: "wv-1",
      triggerNodeId: "node-trigger-1",
      triggerType: "cron",
      enabled: true,
      cronExpression: "0 * * * *",
      cronTimezone: "UTC",
      dedupeWindowSec: 300,
      nextFireAt: "2025-01-15T11:00:00.000Z",
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  function makeWebhookTrigger(overrides?: Partial<FridayWorkflowTriggerRegistrationEntity>): FridayWorkflowTriggerRegistrationEntity {
    return {
      id: "tr-2",
      workflowId: "wf-1",
      workflowVersionId: "wv-1",
      triggerNodeId: "node-trigger-2",
      triggerType: "webhook",
      enabled: true,
      webhookPathToken: "abc123token",
      dedupeWindowSec: 300,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  function makeEventTrigger(overrides?: Partial<FridayWorkflowTriggerRegistrationEntity>): FridayWorkflowTriggerRegistrationEntity {
    return {
      id: "tr-3",
      workflowId: "wf-1",
      workflowVersionId: "wv-1",
      triggerNodeId: "node-trigger-3",
      triggerType: "event",
      enabled: true,
      eventSource: "plugin:slack",
      eventName: "message.received",
      dedupeWindowSec: 300,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  // ─── upsertManyForVersion ───

  it("inserts trigger registrations", () => {
    const repo = createRepo();
    repo.upsertManyForVersion([makeCronTrigger()]);

    const list = repo.listByWorkflow("wf-1");
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("tr-1");
    expect(list[0]!.triggerType).toBe("cron");
    expect(list[0]!.enabled).toBe(true);
    expect(list[0]!.cronExpression).toBe("0 * * * *");
  });

  it("upserts on conflict (same version + node)", () => {
    const repo = createRepo();
    repo.upsertManyForVersion([makeCronTrigger({ cronExpression: "0 * * * *" })]);

    // Upsert with changed cron
    repo.upsertManyForVersion([
      makeCronTrigger({ id: "tr-1-new", cronExpression: "*/5 * * * *", updatedAt: LATER }),
    ]);

    const list = repo.listByWorkflow("wf-1");
    expect(list).toHaveLength(1);
    expect(list[0]!.cronExpression).toBe("*/5 * * * *");
  });

  it("inserts multiple triggers in one call", () => {
    const repo = createRepo();
    repo.upsertManyForVersion([
      makeCronTrigger(),
      makeWebhookTrigger(),
      makeEventTrigger(),
    ]);

    const list = repo.listByWorkflow("wf-1");
    expect(list).toHaveLength(3);
  });

  // ─── listDueCron ───

  it("returns due cron triggers", () => {
    const repo = createRepo();
    repo.upsertManyForVersion([
      makeCronTrigger({ nextFireAt: "2025-01-15T09:00:00.000Z" }), // due
      makeWebhookTrigger(), // not cron
    ]);

    const due = repo.listDueCron("2025-01-15T10:00:00.000Z", 10);
    expect(due).toHaveLength(1);
    expect(due[0]!.triggerType).toBe("cron");
  });

  it("excludes disabled cron triggers", () => {
    const repo = createRepo();
    repo.upsertManyForVersion([
      makeCronTrigger({ enabled: false, nextFireAt: "2025-01-15T09:00:00.000Z" }),
    ]);

    const due = repo.listDueCron("2025-01-15T10:00:00.000Z", 10);
    expect(due).toHaveLength(0);
  });

  it("excludes cron triggers with null next_fire_at", () => {
    const repo = createRepo();
    repo.upsertManyForVersion([
      makeCronTrigger({ nextFireAt: undefined }),
    ]);

    const due = repo.listDueCron("2025-01-15T12:00:00.000Z", 10);
    expect(due).toHaveLength(0);
  });

  it("respects limit on due cron query", () => {
    const repo = createRepo();
    const wfRepo = createFridayWorkflowRepository({ db });

    // Need a second version for uniqueness constraint
    db.withWriteTransaction((conn) => {
      wfRepo.insertVersion(conn, "wv-2", "wf-1", 2, "cs2", "{}", undefined, undefined, NOW);
    });
    repo.upsertManyForVersion([
      makeCronTrigger({ id: "tr-a", nextFireAt: "2025-01-15T09:00:00.000Z" }),
      makeCronTrigger({
        id: "tr-b",
        workflowVersionId: "wv-2",
        triggerNodeId: "node-trigger-1",
        nextFireAt: "2025-01-15T09:30:00.000Z",
      }),
    ]);

    const due = repo.listDueCron("2025-01-15T10:00:00.000Z", 1);
    expect(due).toHaveLength(1);
  });

  // ─── getByWebhookToken ───

  it("finds trigger by webhook token", () => {
    const repo = createRepo();
    repo.upsertManyForVersion([makeWebhookTrigger()]);

    const found = repo.getByWebhookToken("abc123token");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("tr-2");
    expect(found!.webhookPathToken).toBe("abc123token");
  });

  it("returns null for unknown webhook token", () => {
    const repo = createRepo();
    const found = repo.getByWebhookToken("unknown");
    expect(found).toBeNull();
  });

  it("excludes disabled webhook triggers", () => {
    const repo = createRepo();
    repo.upsertManyForVersion([makeWebhookTrigger({ enabled: false })]);

    const found = repo.getByWebhookToken("abc123token");
    expect(found).toBeNull();
  });

  // ─── listByEvent ───

  it("finds triggers by event source and name", () => {
    const repo = createRepo();
    repo.upsertManyForVersion([makeEventTrigger()]);

    const found = repo.listByEvent("plugin:slack", "message.received");
    expect(found).toHaveLength(1);
    expect(found[0]!.eventSource).toBe("plugin:slack");
  });

  it("returns empty for non-matching event", () => {
    const repo = createRepo();
    repo.upsertManyForVersion([makeEventTrigger()]);

    const found = repo.listByEvent("plugin:slack", "user.joined");
    expect(found).toHaveLength(0);
  });

  // ─── markFired ───

  it("updates last_fired_at and next_fire_at", () => {
    const repo = createRepo();
    repo.upsertManyForVersion([makeCronTrigger()]);

    repo.markFired("tr-1", LATER, "2025-01-15T12:00:00.000Z");

    const list = repo.listByWorkflow("wf-1");
    expect(list[0]!.lastFiredAt).toBe(LATER);
    expect(list[0]!.nextFireAt).toBe("2025-01-15T12:00:00.000Z");
  });

  it("clears next_fire_at when not provided", () => {
    const repo = createRepo();
    repo.upsertManyForVersion([makeCronTrigger()]);

    repo.markFired("tr-1", LATER);

    const list = repo.listByWorkflow("wf-1");
    expect(list[0]!.nextFireAt).toBeUndefined();
  });

  // ─── setEnabled ───

  it("disables a trigger", () => {
    const repo = createRepo();
    repo.upsertManyForVersion([makeCronTrigger()]);

    repo.setEnabled("tr-1", false, LATER);

    const list = repo.listByWorkflow("wf-1");
    expect(list[0]!.enabled).toBe(false);
  });

  it("re-enables a trigger", () => {
    const repo = createRepo();
    repo.upsertManyForVersion([makeCronTrigger({ enabled: false })]);

    repo.setEnabled("tr-1", true, LATER);

    const list = repo.listByWorkflow("wf-1");
    expect(list[0]!.enabled).toBe(true);
  });

  // ─── deleteByWorkflowVersion ───

  it("deletes all triggers for a workflow version", () => {
    const repo = createRepo();
    repo.upsertManyForVersion([
      makeCronTrigger(),
      makeWebhookTrigger(),
    ]);

    repo.deleteByWorkflowVersion("wv-1");

    const list = repo.listByWorkflow("wf-1");
    expect(list).toHaveLength(0);
  });

  // ─── Constraint: unique webhook_path_token ───

  it("enforces unique webhook_path_token", () => {
    const repo = createRepo();
    const wfRepo = createFridayWorkflowRepository({ db });

    db.withWriteTransaction((conn) => {
      wfRepo.insertVersion(conn, "wv-2", "wf-1", 2, "cs2", "{}", undefined, undefined, NOW);
    });

    repo.upsertManyForVersion([makeWebhookTrigger()]);

    // Second trigger with same webhook token on different version should fail
    expect(() =>
      repo.upsertManyForVersion([
        makeWebhookTrigger({
          id: "tr-dup",
          workflowVersionId: "wv-2",
          triggerNodeId: "node-trigger-2",
          webhookPathToken: "abc123token",
        }),
      ]),
    ).toThrow();
  });
});

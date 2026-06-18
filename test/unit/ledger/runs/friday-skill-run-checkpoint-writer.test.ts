import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import type { FridaySkillRunSnapshot } from "#ledger";
import type { FridayLearningEventAppendInput } from "#ledger";
import { createFridaySkillRunCheckpointWriter } from "#ledger";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

describe("FridaySkillRunCheckpointWriter", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  const baseSnapshot: FridaySkillRunSnapshot = {
    runId: "run-001",
    skillId: "skill-timer",
    version: "1.0.0",
    status: "running",
    currentStepId: "step-1",
    attemptsByStep: { "step-1": 1 },
    state: { counter: 0 },
    startedAt: NOW,
    updatedAt: NOW,
    sessionId: "session-1",
    userId: "test-user",
    channel: "discord",
    lastTransitionAt: NOW,
  };

  const baseEvent: FridayLearningEventAppendInput = {
    eventId: "evt-001",
    ts: NOW,
    userId: "test-user",
    kind: "workflow_outcome",
    payload: { result: "success" },
  };

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createWriter() {
    return createFridaySkillRunCheckpointWriter({ db });
  }

  it("persists run snapshot without learning event", () => {
    const writer = createWriter();
    const result = writer.persistCheckpoint({ run: baseSnapshot });

    expect(result.runPersisted).toBe(true);
    expect(result.eventInserted).toBeUndefined();

    const row = db.writer
      .prepare("SELECT value_json FROM skill_run_snapshots WHERE run_id = 'run-001'")
      .get() as { value_json: string };
    expect(row).toBeTruthy();
    const parsed = JSON.parse(row.value_json);
    expect(parsed.runId).toBe("run-001");

    const memoryRows = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM memory_items WHERE namespace = 'skill_runs'")
      .get() as { cnt: number };
    expect(memoryRows.cnt).toBe(0);
  });

  it("persists run snapshot with learning event atomically", () => {
    const writer = createWriter();
    const result = writer.persistCheckpoint({
      run: baseSnapshot,
      learningEvent: baseEvent,
    });

    expect(result.runPersisted).toBe(true);
    expect(result.eventInserted).toBe(true);

    const runRow = db.writer
      .prepare("SELECT * FROM skill_run_snapshots WHERE run_id = 'run-001'")
      .get();
    expect(runRow).toBeTruthy();

    const eventRow = db.writer
      .prepare("SELECT * FROM learning_events WHERE event_id = 'evt-001'")
      .get();
    expect(eventRow).toBeTruthy();
  });

  it("learning event is idempotent on duplicate eventId", () => {
    const writer = createWriter();

    writer.persistCheckpoint({
      run: baseSnapshot,
      learningEvent: baseEvent,
    });

    const result = writer.persistCheckpoint({
      run: { ...baseSnapshot, updatedAt: "2025-01-15T10:01:00.000Z" },
      learningEvent: baseEvent, // same eventId
    });

    expect(result.eventInserted).toBe(false);

    // Only one event row
    const count = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM learning_events WHERE event_id = 'evt-001'")
      .get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it("updates run snapshot on repeated persist", () => {
    const writer = createWriter();

    writer.persistCheckpoint({ run: baseSnapshot });

    const updatedSnapshot: FridaySkillRunSnapshot = {
      ...baseSnapshot,
      status: "completed",
      updatedAt: "2025-01-15T10:05:00.000Z",
    };

    writer.persistCheckpoint({ run: updatedSnapshot });

    const row = db.writer
      .prepare("SELECT value_json FROM skill_run_snapshots WHERE run_id = 'run-001'")
      .get() as { value_json: string };
    const parsed = JSON.parse(row.value_json);
    expect(parsed.status).toBe("completed");
  });

  it("rolls back run snapshot when learning event insert fails (FK violation)", () => {
    const writer = createWriter();

    // Use an invalid user_id that violates FK constraint on learning_events
    const badEvent: FridayLearningEventAppendInput = {
      eventId: "evt-bad",
      ts: NOW,
      userId: "nonexistent-user-fk-violation",
      kind: "workflow_outcome",
      payload: { result: "fail" },
    };

    expect(() =>
      writer.persistCheckpoint({
        run: { ...baseSnapshot, runId: "run-rollback" },
        learningEvent: badEvent,
      }),
    ).toThrow(); // FK violation

    // Verify run snapshot was NOT persisted (rolled back)
    const runRow = db.writer
      .prepare(
        "SELECT * FROM skill_run_snapshots WHERE run_id = 'run-rollback'",
      )
      .get();
    expect(runRow).toBeUndefined();

    // Verify event was NOT persisted
    const eventRow = db.writer
      .prepare("SELECT * FROM learning_events WHERE event_id = 'evt-bad'")
      .get();
    expect(eventRow).toBeUndefined();
  });

  it("atomic commit: both run and event persist together", () => {
    const writer = createWriter();

    // First checkpoint with event
    writer.persistCheckpoint({
      run: baseSnapshot,
      learningEvent: baseEvent,
    });

    // Second checkpoint with different run and event
    const result = writer.persistCheckpoint({
      run: { ...baseSnapshot, runId: "run-002" },
      learningEvent: { ...baseEvent, eventId: "evt-002" },
    });

    expect(result.runPersisted).toBe(true);
    expect(result.eventInserted).toBe(true);

    // Both runs should exist
    const runs = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM skill_run_snapshots")
      .get() as { cnt: number };
    expect(runs.cnt).toBe(2);

    // Both events should exist
    const events = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM learning_events")
      .get() as { cnt: number };
    expect(events.cnt).toBe(2);
  });
});

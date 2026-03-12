import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import type { FridaySkillRunSnapshot } from "#ledger";
import { createFridaySkillRunStore } from "#ledger";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

describe("FridaySkillRunStore", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  interface TestState {
    counter: number;
    items: string[];
  }

  const baseSnapshot: FridaySkillRunSnapshot<TestState> = {
    runId: "run-001",
    skillId: "skill-timer",
    version: "1.0.0",
    status: "running",
    currentStepId: "step-1",
    attemptsByStep: { "step-1": 1 },
    state: { counter: 0, items: ["a", "b"] },
    startedAt: NOW,
    updatedAt: NOW,
    sessionId: "session-1",
    userId: "test-user",
    channel: "discord",
    lastTransitionAt: NOW,
  };

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createStore() {
    return createFridaySkillRunStore({ db });
  }

  it("upsertRun and getRun roundtrip", () => {
    const store = createStore();
    store.upsertRun(baseSnapshot);

    const retrieved = store.getRun<TestState>("run-001");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.runId).toBe("run-001");
    expect(retrieved!.status).toBe("running");
    expect(retrieved!.state.counter).toBe(0);
    expect(retrieved!.state.items).toEqual(["a", "b"]);
    expect(retrieved!.sessionId).toBe("session-1");
    expect(retrieved!.userId).toBe("test-user");
    expect(retrieved!.channel).toBe("discord");
  });

  it("upsertRun updates existing run", () => {
    const store = createStore();
    store.upsertRun(baseSnapshot);

    const updated: FridaySkillRunSnapshot<TestState> = {
      ...baseSnapshot,
      status: "completed",
      state: { counter: 5, items: ["a", "b", "c"] },
      updatedAt: "2025-01-15T10:05:00.000Z",
    };
    store.upsertRun(updated);

    const retrieved = store.getRun<TestState>("run-001");
    expect(retrieved!.status).toBe("completed");
    expect(retrieved!.state.counter).toBe(5);
  });

  it("getRun returns null for nonexistent run", () => {
    const store = createStore();
    const result = store.getRun("nonexistent");
    expect(result).toBeNull();
  });

  it("listRuns returns all runs", () => {
    const store = createStore();
    store.upsertRun(baseSnapshot);
    store.upsertRun({ ...baseSnapshot, runId: "run-002", updatedAt: "2025-01-15T10:01:00.000Z" });

    const runs = store.listRuns();
    expect(runs).toHaveLength(2);
  });

  it("listRuns filters by skillId", () => {
    const store = createStore();
    store.upsertRun(baseSnapshot);
    store.upsertRun({ ...baseSnapshot, runId: "run-002", skillId: "skill-other" });

    const runs = store.listRuns({ skillId: "skill-timer" });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.skillId).toBe("skill-timer");
  });

  it("listRuns filters by status", () => {
    const store = createStore();
    store.upsertRun(baseSnapshot);
    store.upsertRun({
      ...baseSnapshot,
      runId: "run-002",
      status: "completed",
    });

    const runs = store.listRuns({ status: "running" });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.runId).toBe("run-001");
  });

  it("listRuns filters by userId", () => {
    const store = createStore();
    store.upsertRun(baseSnapshot);
    store.upsertRun({
      ...baseSnapshot,
      runId: "run-002",
      userId: "other-user",
    });

    const runs = store.listRuns({ userId: "test-user" });
    expect(runs).toHaveLength(1);
  });

  it("listRuns respects limit", () => {
    const store = createStore();
    for (let i = 1; i <= 5; i++) {
      store.upsertRun({
        ...baseSnapshot,
        runId: `run-${String(i).padStart(3, "0")}`,
        updatedAt: `2025-01-15T10:0${i}:00.000Z`,
      });
    }

    const runs = store.listRuns({ limit: 3 });
    expect(runs).toHaveLength(3);
  });

  it("pruneTerminalRunsBefore deletes old completed/failed/cancelled runs", () => {
    const store = createStore();
    // Old completed
    store.upsertRun({
      ...baseSnapshot,
      runId: "run-old-completed",
      status: "completed",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    // Old failed
    store.upsertRun({
      ...baseSnapshot,
      runId: "run-old-failed",
      status: "failed",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    // Recent completed
    store.upsertRun({
      ...baseSnapshot,
      runId: "run-new-completed",
      status: "completed",
      updatedAt: "2025-01-15T10:00:00.000Z",
    });
    // Active running
    store.upsertRun({
      ...baseSnapshot,
      runId: "run-active",
      status: "running",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });

    const deleted = store.pruneTerminalRunsBefore("2025-01-01T00:00:00.000Z");
    expect(deleted).toBe(2); // old completed + old failed

    const remaining = store.listRuns();
    expect(remaining).toHaveLength(2);
  });

  it("preserves metadata field", () => {
    const store = createStore();
    const withMeta: FridaySkillRunSnapshot<TestState> = {
      ...baseSnapshot,
      metadata: { priority: "high", tags: ["urgent"] },
    };
    store.upsertRun(withMeta);

    const retrieved = store.getRun<TestState>("run-001");
    expect(retrieved!.metadata).toEqual({ priority: "high", tags: ["urgent"] });
  });
});

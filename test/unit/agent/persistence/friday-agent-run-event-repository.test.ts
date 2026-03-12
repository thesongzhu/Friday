import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayAgentRunEventRepository, createFridayAgentRunRepository } from "#agent";

describe("FridayAgentRunEventRepository", () => {
  let db: FridaySqliteLayer;
  let idGenerator: () => string;
  const NOW = "2026-02-20T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGenerator = createTestIdGenerator();
  });

  afterEach(() => {
    db.close();
  });

  function seedRun(runId: string): void {
    const runRepo = createFridayAgentRunRepository();
    db.withWriteTransaction((writer) =>
      runRepo.create(writer, {
        id: runId,
        task: "test task",
        sessionKey: `agent:run:${runId}`,
        maxAttempts: 3,
        nowIso: NOW,
      }),
    );
  }

  // ─── append + list ───

  it("appends and lists events in sequence order", () => {
    const repo = createFridayAgentRunEventRepository();
    const runId = "run-001";
    seedRun(runId);

    db.withWriteTransaction((writer) => {
      repo.append(writer, {
        eventId: idGenerator(),
        runId,
        seq: 1,
        eventName: "agent.run.started",
        payload: { runId, task: "test" },
        emittedAt: NOW,
        createdAt: NOW,
      });
      repo.append(writer, {
        eventId: idGenerator(),
        runId,
        seq: 2,
        eventName: "agent.run.planning",
        payload: { runId, message: "planning" },
        emittedAt: NOW,
        createdAt: NOW,
      });
      repo.append(writer, {
        eventId: idGenerator(),
        runId,
        seq: 3,
        eventName: "agent.run.executing",
        payload: { runId, step: 1, description: "turn 1" },
        emittedAt: NOW,
        createdAt: NOW,
      });
    });

    const events = db.withReadConnection((reader) =>
      repo.list(reader, runId),
    );

    expect(events).toHaveLength(3);
    expect(events[0].seq).toBe(1);
    expect(events[1].seq).toBe(2);
    expect(events[2].seq).toBe(3);
    expect(events[0].eventName).toBe("agent.run.started");
    expect(events[2].eventName).toBe("agent.run.executing");
  });

  it("list with afterSeq filters correctly", () => {
    const repo = createFridayAgentRunEventRepository();
    const runId = "run-002";
    seedRun(runId);

    db.withWriteTransaction((writer) => {
      for (let i = 1; i <= 5; i++) {
        repo.append(writer, {
          eventId: idGenerator(),
          runId,
          seq: i,
          eventName: `event-${String(i)}`,
          payload: { runId, i },
          emittedAt: NOW,
          createdAt: NOW,
        });
      }
    });

    const afterSeq3 = db.withReadConnection((reader) =>
      repo.list(reader, runId, 3),
    );

    expect(afterSeq3).toHaveLength(2);
    expect(afterSeq3[0].seq).toBe(4);
    expect(afterSeq3[1].seq).toBe(5);
  });

  it("preserves payload JSON round-trip", () => {
    const repo = createFridayAgentRunEventRepository();
    const runId = "run-003";
    seedRun(runId);

    const payload = { runId, nested: { key: "value" }, arr: [1, 2, 3] };
    db.withWriteTransaction((writer) =>
      repo.append(writer, {
        eventId: idGenerator(),
        runId,
        seq: 1,
        eventName: "test.event",
        payload,
        emittedAt: NOW,
        createdAt: NOW,
      }),
    );

    const events = db.withReadConnection((reader) =>
      repo.list(reader, runId),
    );

    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual(payload);
  });

  it("returns empty array for non-existent run", () => {
    const repo = createFridayAgentRunEventRepository();

    const events = db.withReadConnection((reader) =>
      repo.list(reader, "nonexistent"),
    );

    expect(events).toHaveLength(0);
  });

  it("sequence is monotonically increasing per run", () => {
    const repo = createFridayAgentRunEventRepository();
    const runId = "run-004";
    seedRun(runId);

    db.withWriteTransaction((writer) => {
      for (let i = 1; i <= 10; i++) {
        repo.append(writer, {
          eventId: idGenerator(),
          runId,
          seq: i,
          eventName: `event-${String(i)}`,
          payload: { i },
          emittedAt: NOW,
          createdAt: NOW,
        });
      }
    });

    const events = db.withReadConnection((reader) =>
      repo.list(reader, runId),
    );

    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
    }
  });
});

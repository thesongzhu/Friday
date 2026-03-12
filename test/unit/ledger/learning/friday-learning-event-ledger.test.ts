import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import type { FridayLearningEventAppendInput } from "#ledger";
import { createFridayLearningEventLedger } from "#ledger";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

describe("FridayLearningEventLedger", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  const baseEvent: FridayLearningEventAppendInput = {
    eventId: "evt-001",
    ts: NOW,
    userId: "test-user",
    kind: "user_message",
    payload: { text: "hello world" },
  };

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createLedger() {
    return createFridayLearningEventLedger({ db });
  }

  it("appends event and returns inserted=true", () => {
    const ledger = createLedger();
    const result = ledger.appendEvent(baseEvent);
    expect(result.inserted).toBe(true);
  });

  it("is idempotent on duplicate eventId", () => {
    const ledger = createLedger();
    ledger.appendEvent(baseEvent);
    const result = ledger.appendEvent(baseEvent);
    expect(result.inserted).toBe(false);

    // Only one row in DB
    const count = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM learning_events")
      .get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it("appendBatch inserts multiple events", () => {
    const ledger = createLedger();
    const events: FridayLearningEventAppendInput[] = [
      { ...baseEvent, eventId: "evt-001" },
      { ...baseEvent, eventId: "evt-002", kind: "assistant_message" },
      { ...baseEvent, eventId: "evt-003", kind: "tool_result" },
    ];

    const results = ledger.appendBatch(events);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.inserted)).toBe(true);
  });

  it("appendBatch is idempotent for duplicates in batch", () => {
    const ledger = createLedger();
    ledger.appendEvent(baseEvent); // pre-insert

    const results = ledger.appendBatch([
      baseEvent, // duplicate
      { ...baseEvent, eventId: "evt-002" }, // new
    ]);

    expect(results[0]!.inserted).toBe(false);
    expect(results[1]!.inserted).toBe(true);
  });

  it("listByUser returns events for user", () => {
    const ledger = createLedger();
    ledger.appendEvent(baseEvent);
    ledger.appendEvent({ ...baseEvent, eventId: "evt-002", ts: "2025-01-15T10:01:00.000Z" });

    const events = ledger.listByUser({ userId: "test-user" });
    expect(events).toHaveLength(2);
    // Most recent first
    expect(events[0]!.eventId).toBe("evt-002");
  });

  it("listByUser filters by kind", () => {
    const ledger = createLedger();
    ledger.appendEvent({ ...baseEvent, eventId: "evt-001", kind: "user_message" });
    ledger.appendEvent({ ...baseEvent, eventId: "evt-002", kind: "assistant_message" });
    ledger.appendEvent({ ...baseEvent, eventId: "evt-003", kind: "tool_result" });

    const events = ledger.listByUser({
      userId: "test-user",
      kinds: ["user_message", "tool_result"],
    });
    expect(events).toHaveLength(2);
  });

  it("listByUser filters by time range", () => {
    const ledger = createLedger();
    ledger.appendEvent({ ...baseEvent, eventId: "evt-001", ts: "2025-01-15T09:00:00.000Z" });
    ledger.appendEvent({ ...baseEvent, eventId: "evt-002", ts: "2025-01-15T10:00:00.000Z" });
    ledger.appendEvent({ ...baseEvent, eventId: "evt-003", ts: "2025-01-15T11:00:00.000Z" });

    const events = ledger.listByUser({
      userId: "test-user",
      fromTs: "2025-01-15T09:30:00.000Z",
      toTs: "2025-01-15T10:30:00.000Z",
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventId).toBe("evt-002");
  });

  it("listByUser respects limit", () => {
    const ledger = createLedger();
    for (let i = 1; i <= 5; i++) {
      ledger.appendEvent({
        ...baseEvent,
        eventId: `evt-${String(i).padStart(3, "0")}`,
        ts: `2025-01-15T10:0${i}:00.000Z`,
      });
    }

    const events = ledger.listByUser({ userId: "test-user", limit: 2 });
    expect(events).toHaveLength(2);
  });

  it("pruneBefore deletes old events", () => {
    const ledger = createLedger();
    ledger.appendEvent({ ...baseEvent, eventId: "old-1", ts: "2024-01-01T00:00:00.000Z" });
    ledger.appendEvent({ ...baseEvent, eventId: "old-2", ts: "2024-06-01T00:00:00.000Z" });
    ledger.appendEvent({ ...baseEvent, eventId: "new-1", ts: "2025-01-15T10:00:00.000Z" });

    const deleted = ledger.pruneBefore("2025-01-01T00:00:00.000Z");
    expect(deleted).toBe(2);

    const remaining = ledger.listByUser({ userId: "test-user" });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.eventId).toBe("new-1");
  });

  it("stores and retrieves payload correctly", () => {
    const ledger = createLedger();
    const payload = { text: "test", nested: { key: "value" }, arr: [1, 2, 3] };
    ledger.appendEvent({ ...baseEvent, payload });

    const events = ledger.listByUser({ userId: "test-user" });
    expect(events[0]!.payload).toEqual(payload);
  });

  it("handles optional sessionId and runId", () => {
    const ledger = createLedger();
    ledger.appendEvent({
      eventId: "evt-no-session",
      ts: NOW,
      userId: "test-user",
      kind: "error_incident",
      payload: { error: "something" },
    });

    const events = ledger.listByUser({ userId: "test-user" });
    expect(events[0]!.sessionId).toBeUndefined();
    expect(events[0]!.runId).toBeUndefined();
  });
});

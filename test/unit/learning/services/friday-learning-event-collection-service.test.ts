import { describe, it, expect } from "vitest";
import { createFridayLearningEventCollectionService } from "#learning";
import type { FridayLearningEventAppendInput } from "#ledger";

describe("FridayLearningEventCollectionService", () => {
  const NOW = "2025-06-15T10:00:00.000Z";

  function makeEvent(
    overrides?: Partial<FridayLearningEventAppendInput>,
  ): FridayLearningEventAppendInput {
    return {
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_message",
      payload: {},
      ...overrides,
    };
  }

  function createMockLedger() {
    const appendedEvents: FridayLearningEventAppendInput[] = [];
    return {
      ledger: {
        appendEvent(event: FridayLearningEventAppendInput) {
          appendedEvents.push(event);
          return { inserted: true };
        },
        appendBatch(events: FridayLearningEventAppendInput[]) {
          appendedEvents.push(...events);
          return events.map((e) => ({ eventId: e.eventId, inserted: true }));
        },
      },
      appendedEvents,
    };
  }

  it("collects a single event via ledger", () => {
    const { ledger, appendedEvents } = createMockLedger();
    const service = createFridayLearningEventCollectionService({ ledger });

    const result = service.collect(makeEvent());
    expect(result.inserted).toBe(true);
    expect(appendedEvents).toHaveLength(1);
    expect(appendedEvents[0]!.eventId).toBe("evt-001");
  });

  it("collects a batch of events via ledger", () => {
    const { ledger, appendedEvents } = createMockLedger();
    const service = createFridayLearningEventCollectionService({ ledger });

    const events = [
      makeEvent({ eventId: "evt-001" }),
      makeEvent({ eventId: "evt-002", kind: "user_correction" }),
      makeEvent({ eventId: "evt-003", kind: "workflow_outcome" }),
    ];

    const results = service.collectBatch(events);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.inserted)).toBe(true);
    expect(appendedEvents).toHaveLength(3);
  });

  it("returns empty array for empty batch", () => {
    const { ledger } = createMockLedger();
    const service = createFridayLearningEventCollectionService({ ledger });

    const results = service.collectBatch([]);
    expect(results).toHaveLength(0);
  });

  it("preserves event payload without modification", () => {
    const { ledger, appendedEvents } = createMockLedger();
    const service = createFridayLearningEventCollectionService({ ledger });

    const payload = { correctedField: "language", newValue: "Python" };
    service.collect(makeEvent({ payload }));

    expect(appendedEvents[0]!.payload).toEqual(payload);
  });
});

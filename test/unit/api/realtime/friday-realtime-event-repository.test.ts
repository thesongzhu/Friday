import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridayRealtimeEventRepository,
  type FridayRealtimeEventRepository,
} from "#api";
import type { FridayRealtimeEventEnvelope } from "#api";

describe("FridayRealtimeEventRepository", () => {
  let db: FridaySqliteLayer;
  let repo: FridayRealtimeEventRepository;
  const NOW = "2025-06-15T10:00:00.000Z";

  function makeEnvelope(
    overrides: Partial<FridayRealtimeEventEnvelope> = {},
  ): FridayRealtimeEventEnvelope {
    return {
      eventId: overrides.eventId ?? "evt-1",
      streamId: overrides.streamId ?? "workflow:wf-1",
      seq: overrides.seq ?? 1,
      event: overrides.event ?? "workflow.updated",
      payload: overrides.payload ?? { workflowId: "wf-1", revision: 1, etag: "abc" },
      emittedAt: overrides.emittedAt ?? NOW,
      correlationId: overrides.correlationId,
      stateVersion: overrides.stateVersion,
    };
  }

  beforeEach(() => {
    db = createTestDb();
    repo = createFridayRealtimeEventRepository();
  });

  afterEach(() => {
    db.close();
  });

  it("appends and retrieves an event by stream", () => {
    const env = makeEnvelope();
    db.withWriteTransaction((w) => repo.append(w, env));

    const events = db.withReadConnection((r) => repo.listByStream(r, "workflow:wf-1", 10));
    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe("evt-1");
    expect(events[0].event).toBe("workflow.updated");
    expect(events[0].payload).toEqual({ workflowId: "wf-1", revision: 1, etag: "abc" });
  });

  it("redacts secret-shaped content before storing payload_json", () => {
    db.withWriteTransaction((w) =>
      repo.append(
        w,
        makeEnvelope({
          event: "workflow.run.failed",
          payload: {
            runId: "run-1",
            error: {
              code: "NODE_EXECUTION_FAILED",
              message: "request failed with Authorization: Bearer sk-a5-realtime-repo-canary",
            },
          },
        }),
      ),
    );

    const stored = db.withReadConnection((reader) =>
      reader
        .prepare("SELECT payload_json FROM realtime_events WHERE event_id = ?")
        .get("evt-1") as { payload_json: string },
    );
    const events = db.withReadConnection((r) =>
      repo.listByStream(r, "workflow:wf-1", 10),
    );
    const serialized = JSON.stringify(events[0].payload);

    expect(stored.payload_json).not.toContain("sk-a5-realtime-repo-canary");
    expect(serialized).not.toContain("sk-a5-realtime-repo-canary");
    expect(serialized).toContain("[REDACTED]");
  });

  it("getNextSeq returns 1 for empty stream", () => {
    const seq = db.withReadConnection((r) => repo.getNextSeq(r, "workflow:wf-1"));
    expect(seq).toBe(1);
  });

  it("getNextSeq returns max+1 after appending events", () => {
    db.withWriteTransaction((w) => {
      repo.append(w, makeEnvelope({ seq: 1 }));
      repo.append(w, makeEnvelope({ eventId: "evt-2", seq: 2 }));
      repo.append(w, makeEnvelope({ eventId: "evt-3", seq: 3 }));
    });
    const seq = db.withReadConnection((r) => repo.getNextSeq(r, "workflow:wf-1"));
    expect(seq).toBe(4);
  });

  it("listAfterSeq returns events after the given seq", () => {
    db.withWriteTransaction((w) => {
      repo.append(w, makeEnvelope({ eventId: "evt-1", seq: 1 }));
      repo.append(w, makeEnvelope({ eventId: "evt-2", seq: 2 }));
      repo.append(w, makeEnvelope({ eventId: "evt-3", seq: 3 }));
    });

    const events = db.withReadConnection((r) =>
      repo.listAfterSeq(r, "workflow:wf-1", 1, 10),
    );
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(2);
    expect(events[1].seq).toBe(3);
  });

  it("listAfterSeq respects limit", () => {
    db.withWriteTransaction((w) => {
      for (let i = 1; i <= 5; i++) {
        repo.append(w, makeEnvelope({ eventId: `evt-${i}`, seq: i }));
      }
    });

    const events = db.withReadConnection((r) =>
      repo.listAfterSeq(r, "workflow:wf-1", 0, 2),
    );
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(1);
    expect(events[1].seq).toBe(2);
  });

  it("listByStream limits results", () => {
    db.withWriteTransaction((w) => {
      for (let i = 1; i <= 5; i++) {
        repo.append(w, makeEnvelope({ eventId: `evt-${i}`, seq: i }));
      }
    });

    const events = db.withReadConnection((r) =>
      repo.listByStream(r, "workflow:wf-1", 3),
    );
    expect(events).toHaveLength(3);
  });

  it("events from different streams are isolated", () => {
    db.withWriteTransaction((w) => {
      repo.append(w, makeEnvelope({ streamId: "workflow:wf-1", seq: 1 }));
      repo.append(
        w,
        makeEnvelope({ eventId: "evt-2", streamId: "workflow:wf-2", seq: 1 }),
      );
    });

    const events1 = db.withReadConnection((r) =>
      repo.listByStream(r, "workflow:wf-1", 10),
    );
    const events2 = db.withReadConnection((r) =>
      repo.listByStream(r, "workflow:wf-2", 10),
    );
    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
  });

  it("deleteOlderThan removes old events", () => {
    db.withWriteTransaction((w) => {
      repo.append(
        w,
        makeEnvelope({ eventId: "evt-old", seq: 1, emittedAt: "2025-06-14T00:00:00.000Z" }),
      );
      repo.append(
        w,
        makeEnvelope({ eventId: "evt-new", seq: 2, emittedAt: "2025-06-15T12:00:00.000Z" }),
      );
    });

    const deleted = db.withWriteTransaction((w) =>
      repo.deleteOlderThan(w, "2025-06-15T00:00:00.000Z"),
    );
    expect(deleted).toBe(1);

    const remaining = db.withReadConnection((r) =>
      repo.listByStream(r, "workflow:wf-1", 10),
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].eventId).toBe("evt-new");
  });

  it("getLatestSeq returns 0 for empty stream", () => {
    const seq = db.withReadConnection((r) => repo.getLatestSeq(r, "workflow:wf-1"));
    expect(seq).toBe(0);
  });

  it("getLatestSeq returns max seq", () => {
    db.withWriteTransaction((w) => {
      repo.append(w, makeEnvelope({ eventId: "evt-1", seq: 1 }));
      repo.append(w, makeEnvelope({ eventId: "evt-2", seq: 5 }));
    });
    const seq = db.withReadConnection((r) => repo.getLatestSeq(r, "workflow:wf-1"));
    expect(seq).toBe(5);
  });

  it("preserves correlationId and stateVersion", () => {
    const env = makeEnvelope({
      correlationId: "corr-123",
      stateVersion: { workflow: 5, fleet: 2, security: 1 },
    });
    db.withWriteTransaction((w) => repo.append(w, env));

    const events = db.withReadConnection((r) =>
      repo.listByStream(r, "workflow:wf-1", 10),
    );
    expect(events[0].correlationId).toBe("corr-123");
    expect(events[0].stateVersion).toEqual({ workflow: 5, fleet: 2, security: 1 });
  });

  it("handles missing correlationId and stateVersion", () => {
    const env = makeEnvelope({ correlationId: undefined, stateVersion: undefined });
    db.withWriteTransaction((w) => repo.append(w, env));

    const events = db.withReadConnection((r) =>
      repo.listByStream(r, "workflow:wf-1", 10),
    );
    expect(events[0].correlationId).toBeUndefined();
    expect(events[0].stateVersion).toBeUndefined();
  });
});

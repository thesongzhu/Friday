import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridayRealtimeSubscriptionService,
  type FridayRealtimeSubscriptionService,
  createFridayRealtimeEventRepository,
  createFridayRealtimeCheckpointRepository,
} from "#api";
import type { FridayAuthPrincipal } from "#api";
import type {
  FridayRealtimeSubscription,
  FridayRealtimeEventEnvelope,
  FridayRealtimeTopic,
} from "#api";

describe("FridayRealtimeSubscriptionService", () => {
  let db: FridaySqliteLayer;
  let service: FridayRealtimeSubscriptionService;
  const NOW = "2025-06-15T10:00:00.000Z";
  const EPOCH = 1;

  const adminPrincipal: FridayAuthPrincipal = {
    principalType: "user",
    principalId: "user-1",
    userId: "user-1",
    role: "admin",
    scopes: [
      "workflow.read",
      "workflow.write",
      "fleet.read",
      "security.read",
      "satellite.read",
      "diagnosis.read",
      "session.read",
    ],
    tokenId: "tok-1",
    tokenKind: "access",
    issuedAt: NOW,
  };

  const viewerPrincipal: FridayAuthPrincipal = {
    principalType: "user",
    principalId: "user-2",
    userId: "user-2",
    role: "viewer",
    scopes: ["workflow.read", "fleet.read"],
    tokenId: "tok-2",
    tokenKind: "access",
    issuedAt: NOW,
  };

  function makeSub(overrides: Partial<FridayRealtimeSubscription> = {}): FridayRealtimeSubscription {
    return {
      subscriptionId: overrides.subscriptionId ?? "sub-1",
      streamId: overrides.streamId ?? "workflow:wf-1",
      topic: overrides.topic ?? "workflow",
      ...overrides,
    };
  }

  beforeEach(() => {
    db = createTestDb();
    const eventRepo = createFridayRealtimeEventRepository();
    const checkpointRepo = createFridayRealtimeCheckpointRepository();
    service = createFridayRealtimeSubscriptionService({
      db,
      eventRepo,
      checkpointRepo,
      nowIso: () => NOW,
      currentEpoch: EPOCH,
    });
  });

  afterEach(() => {
    db.close();
  });

  // ─── Subscription validation ───

  it("accepts subscriptions when principal has required scope", () => {
    const result = service.validateSubscriptions(
      [makeSub({ topic: "workflow" })],
      adminPrincipal,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it("rejects subscription for unknown topic", () => {
    const result = service.validateSubscriptions(
      [makeSub({ topic: "bogus" as unknown as FridayRealtimeTopic })],
      adminPrincipal,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].code).toBe("UNKNOWN_TOPIC");
  });

  it("rejects subscription when principal lacks required scope", () => {
    const restrictedPrincipal: FridayAuthPrincipal = {
      ...adminPrincipal,
      scopes: ["workflow.read"],
    };

    const result = service.validateSubscriptions(
      [makeSub({ topic: "security", subscriptionId: "sub-sec" })],
      restrictedPrincipal,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].code).toBe("INSUFFICIENT_SCOPE");
  });

  it("validates mixed subscriptions (some accepted, some rejected)", () => {
    const restrictedPrincipal: FridayAuthPrincipal = {
      ...adminPrincipal,
      scopes: ["workflow.read"],
    };

    const result = service.validateSubscriptions(
      [
        makeSub({ subscriptionId: "sub-wf", topic: "workflow" }),
        makeSub({ subscriptionId: "sub-fleet", topic: "fleet" }),
      ],
      restrictedPrincipal,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].subscriptionId).toBe("sub-wf");
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].subscriptionId).toBe("sub-fleet");
  });

  it("accepts fleet topic for viewer with fleet.read scope", () => {
    const result = service.validateSubscriptions(
      [makeSub({ topic: "fleet", streamId: "fleet:global" })],
      viewerPrincipal,
    );
    expect(result.accepted).toHaveLength(1);
  });

  // ─── Topic → Stream binding validation ───

  it("rejects subscription with invalid stream binding", () => {
    // topic "workflow" should only allow streams starting with "workflow:"
    const result = service.validateSubscriptions(
      [makeSub({ topic: "workflow", streamId: "fleet:global", subscriptionId: "sub-bad" })],
      adminPrincipal,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].code).toBe("INVALID_STREAM_BINDING");
  });

  it("rejects satellite topic with workflow: stream prefix", () => {
    const result = service.validateSubscriptions(
      [makeSub({ topic: "satellite", streamId: "workflow:wf-1", subscriptionId: "sub-wrong" })],
      adminPrincipal,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].code).toBe("INVALID_STREAM_BINDING");
  });

  it("accepts fleet topic with fleet: stream prefix", () => {
    const result = service.validateSubscriptions(
      [makeSub({ topic: "fleet", streamId: "fleet:global", subscriptionId: "sub-fleet" })],
      viewerPrincipal,
    );
    expect(result.accepted).toHaveLength(1);
  });

  // ─── Stream authorization ───

  it("isStreamAuthorized returns true for subscribed stream", () => {
    const subs = new Map<string, FridayRealtimeSubscription>();
    subs.set("sub-1", makeSub({ subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" }));
    expect(service.isStreamAuthorized(adminPrincipal, "workflow:wf-1", subs)).toBe(true);
  });

  it("isStreamAuthorized returns false for non-subscribed stream", () => {
    const subs = new Map<string, FridayRealtimeSubscription>();
    subs.set("sub-1", makeSub({ subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" }));
    expect(service.isStreamAuthorized(adminPrincipal, "workflow:wf-2", subs)).toBe(false);
  });

  it("isStreamAuthorized falls back to scope check when no subscriptions map", () => {
    expect(service.isStreamAuthorized(adminPrincipal, "workflow:wf-1")).toBe(true);
    expect(service.isStreamAuthorized(viewerPrincipal, "security:global")).toBe(false);
  });

  // ─── Cursor HMAC ───

  it("generateCursor returns deterministic HMAC", () => {
    const cursor1 = service.generateCursor("workflow:wf-1", 5, 1);
    const cursor2 = service.generateCursor("workflow:wf-1", 5, 1);
    expect(cursor1).toBe(cursor2);
    expect(cursor1.length).toBeGreaterThan(0);
  });

  it("verifyCursor validates correct cursor", () => {
    const cursor = service.generateCursor("workflow:wf-1", 5, 1);
    expect(service.verifyCursor(cursor, "workflow:wf-1", 5, 1)).toBe(true);
  });

  it("verifyCursor rejects tampered cursor", () => {
    const cursor = service.generateCursor("workflow:wf-1", 5, 1);
    expect(service.verifyCursor(cursor + "x", "workflow:wf-1", 5, 1)).toBe(false);
  });

  it("verifyCursor rejects cursor for different stream", () => {
    const cursor = service.generateCursor("workflow:wf-1", 5, 1);
    expect(service.verifyCursor(cursor, "workflow:wf-2", 5, 1)).toBe(false);
  });

  it("verifyCursor rejects cursor for different seq", () => {
    const cursor = service.generateCursor("workflow:wf-1", 5, 1);
    expect(service.verifyCursor(cursor, "workflow:wf-1", 6, 1)).toBe(false);
  });

  it("verifyCursor rejects cursor for different epoch", () => {
    const cursor = service.generateCursor("workflow:wf-1", 5, 1);
    expect(service.verifyCursor(cursor, "workflow:wf-1", 5, 2)).toBe(false);
  });

  // ─── Pull events ───

  it("pullEvents returns events after given seq", () => {
    const eventRepo = createFridayRealtimeEventRepository();
    db.withWriteTransaction((w) => {
      eventRepo.append(w, {
        eventId: "evt-1",
        streamId: "workflow:wf-1",
        seq: 1,
        event: "workflow.updated",
        payload: { workflowId: "wf-1", revision: 1, etag: "a" },
        emittedAt: NOW,
      });
      eventRepo.append(w, {
        eventId: "evt-2",
        streamId: "workflow:wf-1",
        seq: 2,
        event: "workflow.updated",
        payload: { workflowId: "wf-1", revision: 2, etag: "b" },
        emittedAt: NOW,
      });
    });

    const events = service.pullEvents("workflow:wf-1", 1, 10);
    expect(events).toHaveLength(1);
    expect(events[0].seq).toBe(2);
  });

  it("pullEvents returns empty for nonexistent stream", () => {
    const events = service.pullEvents("workflow:nonexistent", 0, 10);
    expect(events).toHaveLength(0);
  });

  // ─── Ack ───

  it("ackEvent succeeds with matching epoch", () => {
    const result = service.ackEvent("user-1", "workflow:wf-1", 5, EPOCH);
    expect(result.accepted).toBe(true);
  });

  it("ackEvent fails with mismatched epoch", () => {
    const result = service.ackEvent("user-1", "workflow:wf-1", 5, EPOCH + 1);
    expect(result.accepted).toBe(false);
  });

  it("ack is monotonic — lower seq does not overwrite higher", () => {
    service.ackEvent("user-1", "workflow:wf-1", 10, EPOCH);
    service.ackEvent("user-1", "workflow:wf-1", 5, EPOCH);

    const checkpoint = service.getCheckpoint("user-1", "workflow:wf-1");
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.lastAckedSeq).toBe(10);
  });

  it("ack updates to higher seq", () => {
    service.ackEvent("user-1", "workflow:wf-1", 5, EPOCH);
    service.ackEvent("user-1", "workflow:wf-1", 10, EPOCH);

    const checkpoint = service.getCheckpoint("user-1", "workflow:wf-1");
    expect(checkpoint!.lastAckedSeq).toBe(10);
  });

  // ─── Checkpoint ───

  it("getCheckpoint returns null for unknown principal+stream", () => {
    const checkpoint = service.getCheckpoint("unknown", "unknown-stream");
    expect(checkpoint).toBeNull();
  });

  it("getCheckpoint returns stored checkpoint after ack", () => {
    service.ackEvent("user-1", "workflow:wf-1", 7, EPOCH, "cursor-abc");

    const checkpoint = service.getCheckpoint("user-1", "workflow:wf-1");
    expect(checkpoint).toEqual({
      lastAckedSeq: 7,
      epoch: EPOCH,
      cursor: "cursor-abc",
    });
  });

  it("checkpoints from different principals are isolated", () => {
    service.ackEvent("user-1", "workflow:wf-1", 10, EPOCH);
    service.ackEvent("user-2", "workflow:wf-1", 5, EPOCH);

    const cp1 = service.getCheckpoint("user-1", "workflow:wf-1");
    const cp2 = service.getCheckpoint("user-2", "workflow:wf-1");
    expect(cp1!.lastAckedSeq).toBe(10);
    expect(cp2!.lastAckedSeq).toBe(5);
  });
});

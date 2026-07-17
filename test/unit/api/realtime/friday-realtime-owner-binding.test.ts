/**
 * SEC-EVENT-REDACTION-001 / P0#2 — canonical-hub-owner binding for the realtime
 * event plane.
 *
 * Before this slice, `realtime_events` had no owner column and the read surfaces
 * (validateSubscriptions / isStreamAuthorized / pull) authorized by topic-prefix +
 * scope ALONE, so a second authenticated principal holding the same topic scope
 * could subscribe/pull ANY stream by knowing/guessing its id — a cross-principal
 * read of the owner's events. These tests reproduce the Advisor's exact probe:
 * principal A (canonical owner) emits an event on a PII-shaped stream id; principal
 * B (a different principal with the IDENTICAL scope) must be DENIED.
 *
 * The pre-fix vulnerability is documented directly: a service constructed WITHOUT
 * the owner resolver (legacy) authorizes B; a service constructed WITH it (the
 * production wiring) denies B.
 */

import { describe, it, expect } from "vitest";

import type { FridaySqliteLayer } from "#state";
import {
  createFridayRealtimeEventBus,
  createFridayRealtimeEventRepository,
  createFridayRealtimeCheckpointRepository,
  createFridayRealtimeSubscriptionService,
} from "#api";
import type { FridayAuthPrincipal } from "#api";
import type { FridayRealtimeSubscription } from "#api";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

const CANONICAL_OWNER = "admin-001";
const NOW = "2026-02-25T12:00:00.000Z";
const CURRENT_EPOCH = 1;

// A PII-shaped stream id — the Advisor's exact probe value.
const PII_STREAM = "execution:alice@example.com";

function principal(userId: string): FridayAuthPrincipal {
  return {
    principalType: "user",
    principalId: userId,
    userId,
    role: "admin",
    scopes: ["execution.read"],
    tokenId: `tok-${userId}`,
    tokenKind: "access",
    issuedAt: NOW,
  };
}

function subscription(streamId: string): FridayRealtimeSubscription {
  return {
    subscriptionId: "sub-1",
    streamId,
    topic: "execution",
  };
}

function seedEvent(db: FridaySqliteLayer, ownerResolver?: () => string): void {
  const eventRepo = createFridayRealtimeEventRepository({ resolveOwnerId: ownerResolver });
  let seq = 0;
  const bus = createFridayRealtimeEventBus({
    idGenerator: () => `evt-${++seq}`,
    nowIso: () => NOW,
    db,
    eventRepo,
  });
  bus.publish(PII_STREAM, "execution.node.completed" as never, {
    executionId: "alice@example.com",
    runId: "run-1",
    nodeId: "n",
    attempt: 1,
    durationMs: 5,
  } as never);
}

function makeService(
  db: FridaySqliteLayer,
  resolveCanonicalOwnerId?: () => string | null | undefined,
) {
  return createFridayRealtimeSubscriptionService({
    db,
    eventRepo: createFridayRealtimeEventRepository({
      resolveOwnerId: resolveCanonicalOwnerId
        ? () => resolveCanonicalOwnerId() as string
        : undefined,
    }),
    checkpointRepo: createFridayRealtimeCheckpointRepository(),
    nowIso: () => NOW,
    currentEpoch: CURRENT_EPOCH,
    resolveCanonicalOwnerId,
  });
}

describe("realtime owner-binding — canonical-hub-owner gate (P0#2)", () => {
  it("PRE-FIX (legacy, no owner gate): a DIFFERENT principal is authorized — documents the cross-principal vulnerability", () => {
    const db = createTestDb();
    try {
      const legacy = makeService(db); // no resolveCanonicalOwnerId → gate inactive
      // A different principal (B) with the same scope passes authz on the owner's stream.
      expect(legacy.isStreamAuthorized(principal("admin-002"), PII_STREAM)).toBe(true);
      const validated = legacy.validateSubscriptions([subscription(PII_STREAM)], principal("admin-002"));
      expect(validated.accepted).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("FIX: the canonical owner (A) CAN subscribe, authorize, and pull its own stream", () => {
    const db = createTestDb();
    try {
      seedEvent(db, () => CANONICAL_OWNER);
      const svc = makeService(db, () => CANONICAL_OWNER);
      const a = principal(CANONICAL_OWNER);

      expect(svc.isStreamAuthorized(a, PII_STREAM)).toBe(true);
      const validated = svc.validateSubscriptions([subscription(PII_STREAM)], a);
      expect(validated.accepted).toHaveLength(1);
      expect(validated.rejected).toHaveLength(0);

      const events = svc.pullEvents(PII_STREAM, 0, 50);
      expect(events).toHaveLength(1);
      expect(events[0].streamId).toBe(PII_STREAM);
    } finally {
      db.close();
    }
  });

  it("FIX: a DIFFERENT principal (B) with the SAME scope is DENIED subscribe + authorize (Advisor's cross-principal probe)", () => {
    const db = createTestDb();
    try {
      seedEvent(db, () => CANONICAL_OWNER);
      const svc = makeService(db, () => CANONICAL_OWNER);
      const b = principal("admin-002");

      // Denied at every route/WS gate.
      expect(svc.isStreamAuthorized(b, PII_STREAM)).toBe(false);
      const validated = svc.validateSubscriptions([subscription(PII_STREAM)], b);
      expect(validated.accepted).toHaveLength(0);
      expect(validated.rejected).toHaveLength(1);
      expect(validated.rejected[0].code).toBe("NOT_CANONICAL_OWNER");
    } finally {
      db.close();
    }
  });

  it("FIX: at-rest owner_id is stamped, and an owner-scoped read excludes NULL-owner (fail-closed sentinel) rows", () => {
    const db = createTestDb();
    try {
      // One row owned by the canonical owner, one legacy/unowned (resolver → undefined → NULL).
      seedEvent(db, () => CANONICAL_OWNER);
      const unownedRepo = createFridayRealtimeEventRepository({ resolveOwnerId: () => undefined });
      db.withWriteTransaction((w) =>
        unownedRepo.append(w, {
          eventId: "evt-null",
          streamId: PII_STREAM,
          seq: 2,
          event: "execution.node.completed" as never,
          payload: { executionId: "alice@example.com" } as never,
          emittedAt: NOW,
          correlationId: undefined,
          stateVersion: undefined,
        }),
      );

      // Raw column check: the owner is persisted.
      const owners = db.withReadConnection((r) =>
        r
          .prepare("SELECT event_id, owner_id FROM realtime_events WHERE stream_id = ? ORDER BY seq")
          .all(PII_STREAM) as Array<{ event_id: string; owner_id: string | null }>,
      );
      expect(owners.find((o) => o.event_id === "evt-1")?.owner_id).toBe(CANONICAL_OWNER);
      expect(owners.find((o) => o.event_id === "evt-null")?.owner_id).toBe(null);

      // Owner-scoped read returns ONLY the owned row; the NULL-owner sentinel is excluded.
      const svc = makeService(db, () => CANONICAL_OWNER);
      const events = svc.pullEvents(PII_STREAM, 0, 50);
      expect(events).toHaveLength(1);
      expect(events[0].eventId).toBe("evt-1");
    } finally {
      db.close();
    }
  });

  it("FIX: a configured-but-unresolvable canonical owner FAILS CLOSED (denies everyone)", () => {
    const db = createTestDb();
    try {
      seedEvent(db, () => CANONICAL_OWNER);
      const svc = makeService(db, () => null); // resolver present but blank/unresolvable
      expect(svc.isStreamAuthorized(principal(CANONICAL_OWNER), PII_STREAM)).toBe(false);
      expect(svc.pullEvents(PII_STREAM, 0, 50)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("migration v106: realtime_events has an owner_id column", () => {
    const db = createTestDb();
    try {
      const cols = db.withReadConnection((r) =>
        r.prepare("PRAGMA table_info(realtime_events)").all() as Array<{ name: string }>,
      );
      expect(cols.map((c) => c.name)).toContain("owner_id");
    } finally {
      db.close();
    }
  });
});

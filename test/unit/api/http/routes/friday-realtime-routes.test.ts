import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridayRealtimeRoutes,
  createFridayRealtimeSubscriptionService,
  createFridayRealtimeEventRepository,
  createFridayRealtimeCheckpointRepository,
} from "#api";
import type { FridayAuthPrincipal } from "#api";

describe("FridayRealtimeRoutes", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-06-15T10:00:00.000Z";
  const EPOCH = 1;

  const adminPrincipal: FridayAuthPrincipal = {
    principalType: "user",
    principalId: "user-1",
    userId: "user-1",
    role: "admin",
    scopes: ["workflow.read", "fleet.read", "satellite.read"],
    tokenId: "tok-1",
    tokenKind: "access",
    issuedAt: NOW,
  };

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function makeRoutes() {
    const eventRepo = createFridayRealtimeEventRepository();
    const checkpointRepo = createFridayRealtimeCheckpointRepository();
    const subscriptionService = createFridayRealtimeSubscriptionService({
      db,
      eventRepo,
      checkpointRepo,
      nowIso: () => NOW,
      currentEpoch: EPOCH,
      cursorSecret: "test-secret",
    });
    return createFridayRealtimeRoutes({ subscriptionService, currentEpoch: EPOCH });
  }

  it("registers 3 realtime routes", () => {
    const routes = makeRoutes();
    expect(routes).toHaveLength(3);
  });

  it("POST /v1/realtime/subscriptions requires auth", () => {
    const routes = makeRoutes();
    const route = routes.find((r) => r.operationId === "realtime.subscribe");
    expect(route).toBeDefined();
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.read", "fleet.read", "satellite.read", "security.read", "diagnosis.read", "session.read"] });
    expect(route!.rateLimitPolicyId).toBe("realtime.subscribe");
  });

  it("POST /v1/realtime/pull requires auth", () => {
    const routes = makeRoutes();
    const route = routes.find((r) => r.operationId === "realtime.pull");
    expect(route).toBeDefined();
    expect(route!.rateLimitPolicyId).toBe("realtime.pull");
  });

  it("POST /v1/realtime/ack requires auth", () => {
    const routes = makeRoutes();
    const route = routes.find((r) => r.operationId === "realtime.ack");
    expect(route).toBeDefined();
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.read", "fleet.read", "satellite.read", "security.read", "diagnosis.read", "session.read"] });
  });

  it("pull rejects unauthorized stream", async () => {
    const routes = makeRoutes();
    const route = routes.find((r) => r.operationId === "realtime.pull")!;
    const restrictedPrincipal: FridayAuthPrincipal = {
      ...adminPrincipal,
      scopes: ["fleet.read"], // no workflow.read
    };
    await expect(
      route.handler({
        requestId: "req-1",
        receivedAt: NOW,
        params: {},
        query: {},
        body: { streamId: "workflow:wf-1", afterSeq: 0, limit: 10 },
        headers: {},
        principal: restrictedPrincipal,
      }),
    ).rejects.toThrow(/Not authorized/);
  });

  it("ack rejects unauthorized stream", async () => {
    const routes = makeRoutes();
    const route = routes.find((r) => r.operationId === "realtime.ack")!;
    const restrictedPrincipal: FridayAuthPrincipal = {
      ...adminPrincipal,
      scopes: ["fleet.read"],
    };
    await expect(
      route.handler({
        requestId: "req-1",
        receivedAt: NOW,
        params: {},
        query: {},
        body: { streamId: "workflow:wf-1", seq: 1, epoch: EPOCH },
        headers: {},
        principal: restrictedPrincipal,
      }),
    ).rejects.toThrow(/Not authorized/);
  });

  it("pull serves persisted events as the HTTP fallback queue after a client was offline", async () => {
    const eventRepo = createFridayRealtimeEventRepository();
    const checkpointRepo = createFridayRealtimeCheckpointRepository();
    db.withWriteTransaction((w) => {
      eventRepo.append(w, {
        eventId: "evt-offline-1",
        streamId: "workflow:wf-1",
        seq: 1,
        event: "workflow.updated",
        payload: { workflowId: "wf-1", revision: 1, etag: "etag-1" },
        emittedAt: NOW,
      });
      eventRepo.append(w, {
        eventId: "evt-offline-2",
        streamId: "workflow:wf-1",
        seq: 2,
        event: "workflow.updated",
        payload: { workflowId: "wf-1", revision: 2, etag: "etag-2" },
        emittedAt: NOW,
      });
    });
    const subscriptionService = createFridayRealtimeSubscriptionService({
      db,
      eventRepo,
      checkpointRepo,
      nowIso: () => NOW,
      currentEpoch: EPOCH,
      cursorSecret: "test-secret",
    });
    const route = createFridayRealtimeRoutes({ subscriptionService, currentEpoch: EPOCH })
      .find((r) => r.operationId === "realtime.pull")!;

    const result = await route.handler({
      requestId: "req-1",
      receivedAt: NOW,
      params: {},
      query: {},
      body: { streamId: "workflow:wf-1", afterSeq: 0, limit: 10 },
      headers: {},
      principal: adminPrincipal,
    }) as { items: Array<{ seq: number; eventId: string }>; streamId: string; epoch: number };

    expect(result.streamId).toBe("workflow:wf-1");
    expect(result.epoch).toBe(EPOCH);
    expect(result.items.map((item) => item.eventId)).toEqual(["evt-offline-1", "evt-offline-2"]);
  });
});

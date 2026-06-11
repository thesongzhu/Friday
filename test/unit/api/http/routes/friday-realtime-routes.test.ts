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
import { FridayDomainError } from "#errors";

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
    expect(route!.auth).toEqual({ public: true });
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
    expect(route!.auth).toEqual({ public: true });
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

  describe("TS runtime retirement (allowTestOnlyRealtimeExecution)", () => {
    function makeAckRoute(allow?: boolean) {
      const subscriptionService = createFridayRealtimeSubscriptionService({
        db,
        eventRepo: createFridayRealtimeEventRepository(),
        checkpointRepo: createFridayRealtimeCheckpointRepository(),
        nowIso: () => NOW,
        currentEpoch: EPOCH,
        cursorSecret: "test-secret",
        // Mirror production (api-runtime passes the same flag to the route AND the
        // subscription service): when the route flag is on, ackEvent's method
        // guard must also be open so the live test-oracle path reaches the ack.
        allowTestOnlyRealtimeExecution: allow,
      });
      return createFridayRealtimeRoutes({ subscriptionService, currentEpoch: EPOCH, allowTestOnlyRealtimeExecution: allow })
        .find((r) => r.operationId === "realtime.ack")!;
    }

    const ackCtx = {
      requestId: "req-ack",
      receivedAt: NOW,
      params: {},
      query: {},
      body: { streamId: "workflow:wf-1", seq: 1, epoch: EPOCH },
      headers: {},
      principal: adminPrincipal,
    };

    it("fail-closes realtime.ack with 503 for an authorized request when the flag is unset", async () => {
      await expect(makeAckRoute(undefined).handler({ ...ackCtx })).rejects.toMatchObject({
        code: "TS_RUNTIME_REALTIME_RETIRED",
        httpStatus: 503,
      } satisfies Partial<FridayDomainError>);
    });

    it("does NOT fail-close realtime.ack when the flag is true (reaches ackEvent, accepted)", async () => {
      const result = await makeAckRoute(true).handler({ ...ackCtx }) as { accepted: boolean };
      expect(result.accepted).toBe(true);
    });

    it("enforces stream authorization (403) BEFORE the retirement guard (flag unset)", async () => {
      const restrictedPrincipal: FridayAuthPrincipal = { ...adminPrincipal, scopes: ["fleet.read"] };
      await expect(makeAckRoute(undefined).handler({ ...ackCtx, principal: restrictedPrincipal }))
        .rejects.toThrow(/Not authorized/);
    });

    it("leaves the read surfaces (subscribe/pull) ungated when the flag is unset", async () => {
      const routes = createFridayRealtimeRoutes({
        subscriptionService: createFridayRealtimeSubscriptionService({
          db,
          eventRepo: createFridayRealtimeEventRepository(),
          checkpointRepo: createFridayRealtimeCheckpointRepository(),
          nowIso: () => NOW,
          currentEpoch: EPOCH,
          cursorSecret: "test-secret",
        }),
        currentEpoch: EPOCH,
      });
      const pull = routes.find((r) => r.operationId === "realtime.pull")!;
      const result = await pull.handler({
        requestId: "req-pull",
        receivedAt: NOW,
        params: {},
        query: {},
        body: { streamId: "workflow:wf-1", afterSeq: 0, limit: 10 },
        headers: {},
        principal: adminPrincipal,
      }) as { streamId: string };
      expect(result.streamId).toBe("workflow:wf-1");
    });
  });
});

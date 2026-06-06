import { beforeEach, describe, expect, it, vi } from "vitest";
import { FridayDomainError } from "#errors";
import type { FridayHttpContext, FridayRouteDefinition } from "#api";
import { createFridaySatelliteRuntimeRoutes } from "#api";

describe("FridaySatelliteRuntimeRoutes", () => {
  const NOW = "2026-03-07T12:00:00.000Z";
  let routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[];
  const deps = {
    recordHeartbeat: vi.fn(async (input) => ({
      accepted: true as const,
      now: input.ts,
      expectedIntervalMs: 15_000,
      status: "online",
    })),
    updateCapabilities: vi.fn(async () => ({ accepted: true })),
    pullSync: vi.fn(async () => ({
      streamId: "fleet",
      events: [],
      queueItems: [],
      nextCursor: undefined,
    })),
    pushSync: vi.fn(async () => ({
      acceptedAcks: [],
      acceptedNodeResults: [],
      conflicts: [],
    })),
    pollCommands: vi.fn(async () => []),
    ackCommand: vi.fn(async () => ({ acked: true })),
    reportCommandResult: vi.fn(async () => undefined),
    pullEvents: vi.fn(async () => []),
    getCheckpoint: vi.fn(async () => ({ lastAckedSeq: 4, epoch: 1, cursor: "cursor-1" })),
    // Test-oracle: exercise the real TypeScript runtime logic in these unit
    // tests. Default/live hub wiring leaves this unset so the surfaces fail-close
    // (see the TS-runtime-retirement regression block below).
    allowTestOnlySatelliteRuntimeExecution: true,
  };

  function makeCtx(
    satelliteId: string,
    overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {},
  ): FridayHttpContext<unknown, unknown, unknown> {
    return {
      requestId: "req-1",
      receivedAt: NOW,
      params: { satelliteId },
      query: {},
      body: {},
      headers: {},
      principal: {
        principalType: "satellite",
        principalId: satelliteId,
        tokenId: "token-1",
        tokenKind: "satellite",
        scopes: ["satellite.write"],
        issuedAt: NOW,
      },
      ...overrides,
    };
  }

  function findRoute(operationId: string) {
    return routes.find((route) => route.operationId === operationId)!;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    routes = createFridaySatelliteRuntimeRoutes(deps);
  });

  it("registers the runtime route surface", () => {
    expect(routes.map((route) => route.operationId)).toEqual([
      "satellites.heartbeat",
      "satellites.capabilities.update",
      "satellites.sync.pull",
      "satellites.sync.push",
      "satellites.commands.poll",
      "satellites.commands.ack",
      "satellites.events.poll",
    ]);
  });

  it("records heartbeats for the authenticated satellite", async () => {
    const route = findRoute("satellites.heartbeat");
    const result = await route.handler(
      makeCtx("sat-1", {
        body: {
          ts: NOW,
          queueDepth: 3,
          activeRuns: 1,
        },
      }),
    );

    expect(deps.recordHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        satelliteId: "sat-1",
        ts: NOW,
        queueDepth: 3,
        activeRuns: 1,
      }),
    );
    expect(result).toMatchObject({ accepted: true, status: "online" });
  });

  it("rejects capability reports with missing keys as a validation error", async () => {
    const route = findRoute("satellites.capabilities.update");
    await expect(
      route.handler(
        makeCtx("sat-1", {
          body: {
            revision: 1,
            generatedAt: NOW,
            runtime: { os: "darwin", arch: "arm64", appVersion: "1.0.0", nodeVersion: "22.0.0" },
            capabilities: [{ kind: "shell", available: true }],
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      httpStatus: 400,
    } satisfies Partial<FridayDomainError>);
    expect(deps.updateCapabilities).not.toHaveBeenCalled();
  });

  it("forwards valid capability reports", async () => {
    const route = findRoute("satellites.capabilities.update");
    const result = await route.handler(
      makeCtx("sat-1", {
        body: {
          revision: 2,
          generatedAt: NOW,
          runtime: { os: "darwin", arch: "arm64", appVersion: "1.0.0", nodeVersion: "22.0.0" },
          capabilities: [{ key: "shell", available: true, metadata: { transport: "http-poll" } }],
        },
      }),
    );

    expect(deps.updateCapabilities).toHaveBeenCalledWith({
      satelliteId: "sat-1",
      revision: 2,
      generatedAt: NOW,
      runtime: { os: "darwin", arch: "arm64", appVersion: "1.0.0", nodeVersion: "22.0.0" },
      capabilities: [{ key: "shell", available: true, metadata: { transport: "http-poll" } }],
    });
    expect(result).toEqual({ accepted: true });
  });

  it("rejects satellite principal mismatch", async () => {
    const route = findRoute("satellites.sync.pull");
    await expect(
      route.handler(
        makeCtx("sat-1", {
          params: { satelliteId: "sat-2" },
          body: { streamId: "fleet", lastAckedSeq: 0 },
        }),
      ),
    ).rejects.toMatchObject({ code: "SATELLITE_PRINCIPAL_MISMATCH", httpStatus: 403 });
  });

  it("forwards sync node results for offline completion replay", async () => {
    const route = findRoute("satellites.sync.push");
    await route.handler(
      makeCtx("sat-1", {
        body: {
          acks: [{ streamId: "outbox", seq: 10, epoch: 1 }],
          nodeResults: [
            {
              runId: "run-1",
              nodeId: "node-1",
              attemptId: "attempt-1",
              attempt: 1,
              status: "completed",
              output: { ok: true },
            },
          ],
        },
      }),
    );

    expect(deps.pushSync).toHaveBeenCalledWith({
      satelliteId: "sat-1",
      acks: [{ streamId: "outbox", seq: 10, epoch: 1 }],
      localEvents: undefined,
      nodeResults: [
        {
          runId: "run-1",
          nodeId: "node-1",
          attemptId: "attempt-1",
          attempt: 1,
          status: "completed",
          output: { ok: true },
        },
      ],
    });
  });

  it("decodes leased workflow commands for poll", async () => {
    deps.pollCommands.mockResolvedValueOnce([
      {
        id: "cmd-1",
        seq: 1,
        messageType: "workflow.node.execute",
        payload: Buffer.from(JSON.stringify({ runId: "run-1", nodeId: "node-1" }), "utf8").toString("base64"),
      },
    ]);

    const route = findRoute("satellites.commands.poll");
    const result = await route.handler(
      makeCtx("sat-1", {
        body: { limit: 10, leaseMs: 30_000 },
      }),
    );

    expect(deps.pollCommands).toHaveBeenCalledWith({
      satelliteId: "sat-1",
      limit: 10,
      leaseMs: 30_000,
    });
    expect(result).toEqual({
      commands: [
        {
          id: "cmd-1",
          seq: 1,
          messageType: "workflow.node.execute",
          payload: { runId: "run-1", nodeId: "node-1" },
        },
      ],
    });
  });

  it("accepts terminal command results before ack and tolerates post-result ack miss", async () => {
    deps.ackCommand.mockResolvedValueOnce({ acked: false });

    const route = findRoute("satellites.commands.ack");
    const result = await route.handler(
      makeCtx("sat-1", {
        params: { satelliteId: "sat-1", commandId: "cmd-1" },
        body: {
          status: "completed",
          runId: "run-1",
          nodeId: "node-1",
          attemptId: "attempt-1",
          attempt: 1,
          output: { ok: true },
        },
      }),
    );

    expect(deps.reportCommandResult).toHaveBeenCalledWith(
      expect.objectContaining({
        satelliteId: "sat-1",
        commandId: "cmd-1",
        runId: "run-1",
        nodeId: "node-1",
        attemptId: "attempt-1",
        attempt: 1,
        status: "completed",
      }),
    );
    expect(result).toEqual({ acked: false, resultAccepted: true });
  });

  it("rejects non-terminal ack when the command is not leased", async () => {
    deps.ackCommand.mockResolvedValueOnce({ acked: false });

    const route = findRoute("satellites.commands.ack");
    await expect(
      route.handler(
        makeCtx("sat-1", {
          params: { satelliteId: "sat-1", commandId: "cmd-2" },
          body: { status: "received" },
        }),
      ),
    ).rejects.toMatchObject({
      code: "SATELLITE_COMMAND_NOT_LEASED",
      httpStatus: 409,
    } satisfies Partial<FridayDomainError>);
  });

  it("returns realtime events with checkpoint state", async () => {
    deps.pullEvents.mockResolvedValueOnce([
      {
        eventId: "evt-1",
        seq: 5,
        streamId: "fleet",
        event: "fleet.summary.updated",
        emittedAt: NOW,
        payload: { totals: { satellites: 1 } },
      },
    ]);

    const route = findRoute("satellites.events.poll");
    const result = await route.handler(
      makeCtx("sat-1", {
        body: { streamId: "fleet", afterSeq: 4, limit: 10 },
      }),
    );

    expect(deps.getCheckpoint).toHaveBeenCalledWith({
      principalId: "sat-1",
      streamId: "fleet",
    });
    expect(result).toMatchObject({
      streamId: "fleet",
      checkpoint: { lastAckedSeq: 4, epoch: 1, cursor: "cursor-1" },
      events: [{ seq: 5, event: "fleet.summary.updated" }],
    });
  });

  describe("TS runtime retirement (allowTestOnlySatelliteRuntimeExecution unset)", () => {
    const retiredDeps = {
      recordHeartbeat: vi.fn(async () => ({ accepted: true as const, now: NOW, expectedIntervalMs: 15_000, status: "online" })),
      updateCapabilities: vi.fn(async () => ({ accepted: true })),
      pullSync: vi.fn(async () => ({ streamId: "fleet", events: [], queueItems: [], nextCursor: undefined })),
      pushSync: vi.fn(async () => ({ acceptedAcks: [], acceptedNodeResults: [], conflicts: [] })),
      pollCommands: vi.fn(async () => []),
      ackCommand: vi.fn(async () => ({ acked: true })),
      reportCommandResult: vi.fn(async () => undefined),
      pullEvents: vi.fn(async () => []),
      getCheckpoint: vi.fn(async () => ({ lastAckedSeq: 4, epoch: 1, cursor: "cursor-1" })),
      // allowTestOnlySatelliteRuntimeExecution intentionally unset → fail-closed.
    };
    let retiredRoutes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[];

    beforeEach(() => {
      vi.clearAllMocks();
      retiredRoutes = createFridaySatelliteRuntimeRoutes(retiredDeps);
    });

    function retiredRoute(operationId: string) {
      return retiredRoutes.find((route) => route.operationId === operationId)!;
    }

    const cases: Array<{ op: string; body: Record<string, unknown>; service: keyof typeof retiredDeps }> = [
      { op: "satellites.heartbeat", body: { ts: NOW }, service: "recordHeartbeat" },
      { op: "satellites.capabilities.update", body: { revision: 1, generatedAt: NOW, capabilities: [{ key: "shell", available: true }] }, service: "updateCapabilities" },
      { op: "satellites.sync.pull", body: { streamId: "fleet", lastAckedSeq: 0 }, service: "pullSync" },
      { op: "satellites.sync.push", body: { acks: [] }, service: "pushSync" },
      { op: "satellites.commands.poll", body: { limit: 10 }, service: "pollCommands" },
      { op: "satellites.commands.ack", body: { status: "completed", runId: "r", nodeId: "n", attemptId: "a", attempt: 1 }, service: "ackCommand" },
    ];

    for (const { op, body, service } of cases) {
      it(`fail-closes ${op} with 503 and never calls the service`, async () => {
        await expect(
          retiredRoute(op).handler(makeCtx("sat-1", { params: { satelliteId: "sat-1", commandId: "cmd-1" }, body })),
        ).rejects.toMatchObject({
          code: "TS_RUNTIME_SATELLITE_RUNTIME_RETIRED",
          httpStatus: 503,
        } satisfies Partial<FridayDomainError>);
        expect(retiredDeps[service]).not.toHaveBeenCalled();
        if (op === "satellites.commands.ack") {
          expect(retiredDeps.reportCommandResult).not.toHaveBeenCalled();
        }
      });
    }

    it("validates the request body (400) before the retirement guard (heartbeat missing ts)", async () => {
      await expect(
        retiredRoute("satellites.heartbeat").handler(makeCtx("sat-1", { body: {} })),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR", httpStatus: 400 } satisfies Partial<FridayDomainError>);
      expect(retiredDeps.recordHeartbeat).not.toHaveBeenCalled();
    });

    it("still serves the read-only events poll (compat_shim, not gated by retirement)", async () => {
      const result = await retiredRoute("satellites.events.poll").handler(
        makeCtx("sat-1", { body: { streamId: "fleet", afterSeq: 0, limit: 10 } }),
      );
      expect(retiredDeps.pullEvents).toHaveBeenCalled();
      expect(result).toMatchObject({ streamId: "fleet" });
    });
  });
});

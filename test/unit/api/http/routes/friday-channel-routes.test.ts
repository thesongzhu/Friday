import { describe, expect, it, vi } from "vitest";

import { createFridayChannelRoutes, type FridayChannelRoutesDeps } from "#api";

const NOW = "2026-04-08T12:00:00.000Z";

function createDeps(): FridayChannelRoutesDeps {
  return {
    registry: {
      listViews: vi.fn(() => [
        {
          kind: "telegram",
          running: true,
          status: "connected",
          health: {
            state: "connected",
            restartCount: 1,
            credentialStatus: "configured",
          },
          allowlist: {
            hasAllowedUsers: false,
            allowedUsersCount: 0,
            hasAllowedChats: false,
            allowedChatsCount: 0,
          },
        },
      ]),
      describe: vi.fn((kind: string) => (kind === "telegram"
        ? {
            kind: "telegram",
            running: true,
            status: "connected",
            health: {
              state: "connected",
              restartCount: 1,
              credentialStatus: "configured",
            },
            allowlist: {
              hasAllowedUsers: false,
              allowedUsersCount: 0,
              hasAllowedChats: false,
              allowedChatsCount: 0,
            },
          }
        : undefined)),
    } as unknown as FridayChannelRoutesDeps["registry"],
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    receivedAt: NOW,
    params: {},
    query: {},
    body: {},
    headers: {},
    principal: {
      principalType: "user",
      principalId: "user-1",
      userId: "user-1",
      scopes: ["agent.run"],
      tokenId: "token-1",
      tokenKind: "access",
      issuedAt: NOW,
    },
    ...overrides,
  };
}

describe("createFridayChannelRoutes", () => {
  it("registers channel list and detail routes", () => {
    const routes = createFridayChannelRoutes(createDeps());
    expect(routes.map((route) => route.operationId)).toEqual(["channels.list", "channels.get"]);
    expect(routes.map((route) => route.path)).toEqual(["/v1/channels", "/v1/channels/:kind"]);
  });

  it("returns channel views", async () => {
    const deps = createDeps();
    const routes = createFridayChannelRoutes(deps);
    const route = routes.find((item) => item.operationId === "channels.list");
    const result = await route!.handler(makeCtx() as never);

    expect(deps.registry.listViews).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      items: [
        {
          kind: "telegram",
          running: true,
          health: {
            state: "connected",
            credentialStatus: "configured",
          },
        },
      ],
    });
  });

  it("returns a specific channel view", async () => {
    const deps = createDeps();
    const routes = createFridayChannelRoutes(deps);
    const route = routes.find((item) => item.operationId === "channels.get");
    const result = await route!.handler(makeCtx({ params: { kind: "telegram" } }) as never);

    expect(deps.registry.describe).toHaveBeenCalledWith("telegram");
    expect(result).toMatchObject({
      channel: {
        kind: "telegram",
        running: true,
      },
    });
  });

  it("throws when the channel is missing", async () => {
    const routes = createFridayChannelRoutes(createDeps());
    const route = routes.find((item) => item.operationId === "channels.get");

    await expect(route!.handler(makeCtx({ params: { kind: "missing" } }) as never)).rejects.toMatchObject({
      code: "CHANNEL_NOT_FOUND",
      httpStatus: 404,
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFridayChannelRoutes,
  hydrateChannelPersonaStore,
  resetChannelPersonaStore,
  type FridayChannelRoutesDeps,
} from "#api";

const NOW = "2026-04-08T12:00:00.000Z";

function createDeps(): FridayChannelRoutesDeps {
  return {
    nowIso: () => NOW,
    persistPersona: vi.fn(),
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
  beforeEach(() => {
    resetChannelPersonaStore();
  });

  it("registers channel list and detail routes", () => {
    const routes = createFridayChannelRoutes(createDeps());
    expect(routes.map((route) => route.operationId)).toEqual(["channels.list", "channels.get", "channels.persona.get", "channels.persona.update"]);
    expect(routes.map((route) => route.path)).toEqual(["/v1/channels", "/v1/channels/:kind", "/v1/channels/:kind/persona", "/v1/channels/:kind/persona"]);
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

  it("returns null persona when none is configured", async () => {
    const routes = createFridayChannelRoutes(createDeps());
    const route = routes.find((item) => item.operationId === "channels.persona.get");
    const result = await route!.handler(makeCtx({ params: { kind: "telegram" } }) as never);

    expect(result).toEqual({
      kind: "telegram",
      persona: null,
    });
  });

  it("stores and returns a channel persona", async () => {
    const routes = createFridayChannelRoutes(createDeps());
    const updateRoute = routes.find((item) => item.operationId === "channels.persona.update");
    const getRoute = routes.find((item) => item.operationId === "channels.persona.get");

    const updateResult = await updateRoute!.handler(makeCtx({
      params: { kind: "telegram" },
      body: {
        persona: "A concise operator persona",
        systemPrompt: "",
      },
    }) as never);
    const getResult = await getRoute!.handler(makeCtx({ params: { kind: "telegram" } }) as never);

    expect(updateResult).toMatchObject({
      kind: "telegram",
      persona: {
        persona: "A concise operator persona",
        systemPrompt: "",
        updatedAt: NOW,
      },
    });
    expect(getResult).toMatchObject({
      kind: "telegram",
      persona: {
        persona: "A concise operator persona",
        systemPrompt: "",
        updatedAt: NOW,
      },
    });
  });

  it("clears a stored channel persona when both fields are empty", async () => {
    const routes = createFridayChannelRoutes(createDeps());
    const updateRoute = routes.find((item) => item.operationId === "channels.persona.update");
    const getRoute = routes.find((item) => item.operationId === "channels.persona.get");

    await updateRoute!.handler(makeCtx({
      params: { kind: "telegram" },
      body: {
        persona: "Temporary persona",
        systemPrompt: "Temporary system prompt",
      },
    }) as never);
    const clearResult = await updateRoute!.handler(makeCtx({
      params: { kind: "telegram" },
      body: {
        persona: "",
        systemPrompt: "",
      },
    }) as never);
    const getResult = await getRoute!.handler(makeCtx({ params: { kind: "telegram" } }) as never);

    expect(clearResult).toEqual({
      kind: "telegram",
      persona: null,
      cleared: true,
    });
    expect(getResult).toEqual({
      kind: "telegram",
      persona: null,
    });
  });

  it("hydrates persisted personas into the runtime store", async () => {
    hydrateChannelPersonaStore({
      telegram: {
        persona: "Persisted persona",
        systemPrompt: "Persisted system prompt",
        updatedAt: NOW,
      },
    });
    const routes = createFridayChannelRoutes(createDeps());
    const route = routes.find((item) => item.operationId === "channels.persona.get");
    const result = await route!.handler(makeCtx({ params: { kind: "telegram" } }) as never);

    expect(result).toEqual({
      kind: "telegram",
      persona: {
        persona: "Persisted persona",
        systemPrompt: "Persisted system prompt",
        updatedAt: NOW,
      },
    });
  });

  it("persists persona updates through the configured callback", async () => {
    const deps = createDeps();
    const routes = createFridayChannelRoutes(deps);
    const updateRoute = routes.find((item) => item.operationId === "channels.persona.update");

    await updateRoute!.handler(makeCtx({
      params: { kind: "telegram" },
      body: {
        persona: "Persist me",
        systemPrompt: "",
      },
    }) as never);

    expect(deps.persistPersona).toHaveBeenCalledWith("telegram", {
      persona: "Persist me",
      systemPrompt: "",
      updatedAt: NOW,
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

  it("rejects persona reads for an unregistered channel kind", async () => {
    const routes = createFridayChannelRoutes(createDeps());
    const route = routes.find((item) => item.operationId === "channels.persona.get");

    await expect(route!.handler(makeCtx({ params: { kind: "missing" } }) as never)).rejects.toMatchObject({
      code: "CHANNEL_NOT_FOUND",
      httpStatus: 404,
    });
  });

  it("rejects persona writes for an unregistered channel kind", async () => {
    const deps = createDeps();
    const routes = createFridayChannelRoutes(deps);
    const route = routes.find((item) => item.operationId === "channels.persona.update");

    await expect(route!.handler(makeCtx({
      params: { kind: "missing" },
      body: {
        persona: "Nope",
        systemPrompt: "",
      },
    }) as never)).rejects.toMatchObject({
      code: "CHANNEL_NOT_FOUND",
      httpStatus: 404,
    });

    expect(deps.persistPersona).not.toHaveBeenCalled();
  });
});

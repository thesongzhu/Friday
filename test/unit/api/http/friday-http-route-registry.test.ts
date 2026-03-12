import { describe, expect, it } from "vitest";

import { createFridayHttpRouteRegistry } from "#api";

import type { FridayRouteEntry } from "#api";

function createRoute(
  operationId: string,
  path: string,
  method: FridayRouteEntry["method"] = "GET",
): FridayRouteEntry {
  return {
    operationId,
    method,
    path,
    auth: { public: true },
    async handler() {
      return { operationId };
    },
  };
}

describe("FridayHttpRouteRegistry", () => {
  it("prefers a static route over a parameter route regardless of registration order", () => {
    const routes = createFridayHttpRouteRegistry();
    routes.register(createRoute("providers.get", "/v1/providers/:providerId"));
    routes.register(createRoute("providers.usage.get", "/v1/providers/usage"));

    const match = routes.findRoute("GET", "/v1/providers/usage");

    expect(match?.operationId).toBe("providers.usage.get");
  });

  it("prefers the route with the earlier static discriminator when two parameterised patterns overlap", () => {
    const routes = createFridayHttpRouteRegistry();
    routes.register(createRoute("sessions.messages.list", "/v1/sessions/:sessionKey/messages"));
    routes.register(createRoute("sessions.usage.metric", "/v1/sessions/usage/:metric"));

    const match = routes.findRoute("GET", "/v1/sessions/usage/messages");

    expect(match?.operationId).toBe("sessions.usage.metric");
  });

  it("preserves registration order when matching patterns are equally specific", () => {
    const routes = createFridayHttpRouteRegistry();
    routes.register(createRoute("resources.first", "/v1/resources/:id"));
    routes.register(createRoute("resources.second", "/v1/resources/:slug"));

    const match = routes.findRoute("GET", "/v1/resources/example");

    expect(match?.operationId).toBe("resources.first");
  });

  it("rejects non-canonical operationIds", () => {
    const routes = createFridayHttpRouteRegistry();

    let thrown: unknown;
    try {
      routes.register(createRoute("providers.listVersions", "/v1/providers/versions"));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "ROUTE_INVALID_OPERATION_ID",
    });
  });

  it("accepts canonical operationIds that replaced the old legacy names", () => {
    const routes = createFridayHttpRouteRegistry();

    expect(() => {
      routes.register(createRoute("agent.runs.cancel", "/v1/agent/runs/:runId/cancel"));
    }).not.toThrow();
  });
});

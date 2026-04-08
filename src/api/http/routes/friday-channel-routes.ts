import { FridayDomainError } from "#errors";
import type { FridayChannelRegistry } from "#channels";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";

export interface FridayChannelRoutesDeps {
  registry: FridayChannelRegistry;
}

export function createFridayChannelRoutes(
  deps: FridayChannelRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "channels.list",
      method: "GET",
      path: "/v1/channels",
      auth: { public: false, anyOfScopes: ["agent.run", "diagnosis.read", "hub.admin"] },
      async handler() {
        return { items: deps.registry.listViews() };
      },
    },
    {
      operationId: "channels.get",
      method: "GET",
      path: "/v1/channels/:kind",
      auth: { public: false, anyOfScopes: ["agent.run", "diagnosis.read", "hub.admin"] },
      async handler(ctx) {
        const kind = String((ctx.params as Record<string, unknown>).kind ?? "").trim();
        const channel = deps.registry.describe(kind);
        if (!channel) {
          throw new FridayDomainError("CHANNEL_NOT_FOUND", `Channel "${kind}" is not registered`, {
            httpStatus: 404,
          });
        }
        return { channel };
      },
    },
  ];
}

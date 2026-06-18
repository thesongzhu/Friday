import type { FridayFleetDashboardService } from "../fleet/friday-fleet-dashboard-service.types.js";
import type { FridayHttpRouteRegistry } from "../http/friday-http-route-registry.js";
import { createFridayHealthRoutes } from "../http/routes/friday-health-routes.js";
import { createFridayTuiRoutes } from "../http/routes/friday-tui-routes.js";
import type { CreateFridayApiRuntimeDeps } from "./friday-api-runtime.types.js";
import { getFridayExecutionIsolationStatus } from "../../skills/executor/friday-execution-isolation-status.js";

type FridayApiRuntimeBaseRouteDeps = Pick<
  CreateFridayApiRuntimeDeps,
  | "channelWebhooks"
  | "db"
  | "enabledChannelKinds"
  | "mcpServer"
  | "packaging"
  | "pluginRuntimeMode"
  | "searchHealth"
  | "supportedChannelKinds"
  | "systemHealth"
  | "capabilitySnapshotGetter"
>;

export interface InstallFridayApiRuntimeBaseRoutesInput {
  routes: FridayHttpRouteRegistry;
  deps: FridayApiRuntimeBaseRouteDeps;
  fleet: FridayFleetDashboardService;
  serverVersion: string;
}

export function installFridayApiRuntimeBaseRoutes(input: InstallFridayApiRuntimeBaseRoutesInput): void {
  const { deps, fleet, routes, serverVersion } = input;

  // Health routes must stay first: liveness endpoints are public and used by probes.
  for (const route of createFridayHealthRoutes({
    version: serverVersion,
    getCapabilities: async () => {
      const searchHealth = typeof deps.searchHealth === "function"
        ? await Promise.resolve(deps.searchHealth())
        : deps.searchHealth;
      const systemHealth = typeof deps.systemHealth === "function"
        ? await Promise.resolve(deps.systemHealth())
        : deps.systemHealth;
      const enabledChannelKinds = typeof deps.enabledChannelKinds === "function"
        ? await Promise.resolve(deps.enabledChannelKinds())
        : deps.enabledChannelKinds;

      let runtimeSnapshot: Awaited<ReturnType<NonNullable<typeof deps.capabilitySnapshotGetter>>> | undefined;
      if (deps.capabilitySnapshotGetter) {
        try {
          runtimeSnapshot = await Promise.resolve(deps.capabilitySnapshotGetter({ readOnly: false }));
        } catch {
          runtimeSnapshot = undefined;
        }
      }

      return {
        schemaVersion: "1.0" as const,
        plugins: {
          runtimeMode: deps.pluginRuntimeMode ?? "stub",
        },
        channels: {
          supportedKinds: deps.supportedChannelKinds ?? [],
          enabledKinds: enabledChannelKinds ?? [],
          webhookEndpoints: {
            line: deps.channelWebhooks?.lineWebhookRelay?.isListening() === true,
            whatsapp: deps.channelWebhooks?.whatsappWebhookRelay?.isListening() === true,
            lark: deps.channelWebhooks?.larkWebhookRelay?.isListening() === true,
            telegram: deps.channelWebhooks?.telegramWebhookRelay?.isListening() === true,
          },
        },
        mcp: {
          enabled: deps.mcpServer !== undefined,
        },
        packaging: {
          enabled: deps.packaging !== undefined,
        },
        executionIsolation: getFridayExecutionIsolationStatus(),
        search: searchHealth ?? {
          provider: "duckduckgo_html",
          latestness: "unverified" as const,
        },
        ...(runtimeSnapshot?.runtime ? { runtime: runtimeSnapshot.runtime } : {}),
        system: systemHealth ?? {
          enabled: false,
          remoteMode: "unavailable" as const,
          companionReadiness: "unavailable" as const,
        },
      };
    },
  })) {
    routes.register(route);
  }

  for (const route of createFridayTuiRoutes({
    db: deps.db,
    version: serverVersion,
    fleetService: fleet,
  })) {
    routes.register(route);
  }
}

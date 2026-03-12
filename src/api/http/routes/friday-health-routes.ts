/**
 * Health check route — public, no auth.
 *
 * Returns `{ status: "ok", version, uptime }` for liveness probes
 * (Docker, load balancers, monitoring).
 */

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";

// ─── Types ───

export interface FridayHealthRoutesDeps {
  version: string;
  getUptimeSeconds?: () => number;
  getCapabilities?: () => {
    schemaVersion: "1.0";
    auth: {
      allowPasswordlessLocalLogin: boolean;
      allowLocalBypassLogin: boolean;
    };
    plugins: {
      runtimeMode: "stub" | "full";
      marketplaceAvailable: boolean;
    };
    marketplace: {
      commerceEnabled: boolean;
      skillSourceEnabled: boolean;
      pluginMarketplaceEnabled: boolean;
    };
    channels: {
      supportedKinds: string[];
      enabledKinds: string[];
    };
    system: {
      enabled: boolean;
      remoteMode: "trusted_private_network" | "disabled" | "unavailable";
    };
  };
}

// ─── Factory ───

export function createFridayHealthRoutes(
  deps: FridayHealthRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  const startTime = Date.now();

  return [
    {
      operationId: "health.check",
      method: "GET",
      path: "/v1/health",
      auth: { public: true },
      async handler() {
        const uptimeSeconds = deps.getUptimeSeconds
          ? deps.getUptimeSeconds()
          : Math.floor((Date.now() - startTime) / 1000);

        return {
          status: "ok",
          version: deps.version,
          uptime: uptimeSeconds,
          capabilities: deps.getCapabilities
            ? deps.getCapabilities()
            : {
                schemaVersion: "1.0" as const,
                auth: {
                  allowPasswordlessLocalLogin: false,
                  allowLocalBypassLogin: false,
                },
                plugins: {
                  runtimeMode: "stub" as const,
                  marketplaceAvailable: false,
                },
                marketplace: {
                  commerceEnabled: false,
                  skillSourceEnabled: false,
                  pluginMarketplaceEnabled: false,
                },
                channels: {
                  supportedKinds: [],
                  enabledKinds: [],
                },
                system: {
                  enabled: false,
                  remoteMode: "unavailable" as const,
                },
              },
        };
      },
    },
  ];
}

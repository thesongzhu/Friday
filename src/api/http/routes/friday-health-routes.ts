/**
 * Health check route — public, no auth.
 *
 * Returns `{ status: "ok", version, uptime }` for liveness probes
 * (Docker, load balancers, monitoring).
 */

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";

// ─── Types ───

export interface FridayHealthCapabilities {
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
  search: {
    provider: string;
    latestness: "provider_backed" | "unverified";
    warning?: string;
  };
  system: {
    enabled: boolean;
    remoteMode: "trusted_private_network" | "disabled" | "unavailable";
    healthStatus?: "healthy" | "degraded" | "safe_mode" | "unavailable";
    companionConnected?: boolean;
    companionReadiness?: "ready" | "degraded" | "unavailable";
    reasons?: string[];
    warning?: string;
  };
}

export interface FridayHealthRoutesDeps {
  version: string;
  getUptimeSeconds?: () => number;
  getCapabilities?: () => FridayHealthCapabilities | Promise<FridayHealthCapabilities>;
}

// ─── Factory ───

export function createFridayHealthRoutes(
  deps: FridayHealthRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  const startTime = Date.now();
  const defaultCapabilities: FridayHealthCapabilities = {
    schemaVersion: "1.0",
    auth: {
      allowPasswordlessLocalLogin: false,
      allowLocalBypassLogin: false,
    },
    plugins: {
      runtimeMode: "stub",
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
    search: {
      provider: "duckduckgo_html",
      latestness: "unverified",
    },
    system: {
      enabled: false,
      remoteMode: "unavailable",
      companionReadiness: "unavailable",
    },
  };

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
        const capabilities = deps.getCapabilities
          ? await deps.getCapabilities()
          : defaultCapabilities;

        return {
          status: "ok",
          version: deps.version,
          uptime: uptimeSeconds,
          capabilities,
        };
      },
    },
  ];
}

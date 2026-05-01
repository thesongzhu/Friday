/**
 * Health check route — public, no auth.
 *
 * Returns `{ status: "ok", version, uptime }` for liveness probes
 * (Docker, load balancers, monitoring).
 */

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { FridayRuntimeCapabilityMatrix } from "#providers";

// ─── Types ───

export interface FridayHealthCapabilities {
  schemaVersion: "1.0";
  plugins: {
    runtimeMode: "stub" | "full";
  };
  channels: {
    supportedKinds: string[];
    enabledKinds: string[];
    webhookEndpoints?: {
      line: boolean;
      whatsapp: boolean;
      lark: boolean;
    };
  };
  mcp?: {
    enabled: boolean;
  };
  packaging?: {
    enabled: boolean;
  };
  search: {
    provider: string;
    latestness: "provider_backed" | "unverified";
    warning?: string;
  };
  runtime?: FridayRuntimeCapabilityMatrix;
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
    plugins: {
      runtimeMode: "stub",
    },
    channels: {
      supportedKinds: [],
      enabledKinds: [],
      webhookEndpoints: {
        line: false,
        whatsapp: false,
        lark: false,
      },
    },
    mcp: {
      enabled: false,
    },
    packaging: {
      enabled: false,
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

  async function buildHealthPayload(includeCapabilities: boolean) {
    const uptimeSeconds = deps.getUptimeSeconds
      ? deps.getUptimeSeconds()
      : Math.floor((Date.now() - startTime) / 1000);
    if (!includeCapabilities) {
      return {
        status: "ok",
        version: deps.version,
        uptime: uptimeSeconds,
      };
    }
    const capabilities = deps.getCapabilities
      ? await deps.getCapabilities()
      : defaultCapabilities;
    return {
      status: "ok",
      version: deps.version,
      uptime: uptimeSeconds,
      capabilities,
    };
  }

  return [
    {
      operationId: "health.check",
      method: "GET",
      path: "/v1/health",
      auth: { public: true },
      async handler() {
        return buildHealthPayload(false);
      },
    },
    {
      operationId: "health.capabilities",
      method: "GET",
      path: "/v1/health/capabilities",
      auth: { public: false, anyOfScopes: ["session.read"] },
      async handler() {
        return buildHealthPayload(true);
      },
    },
  ];
}

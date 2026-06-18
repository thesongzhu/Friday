/**
 * Health check route — public, no auth.
 *
 * Returns `{ status: "ok", version, uptime }` for liveness probes
 * (Docker, load balancers, monitoring).
 */

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { FridayRuntimeCapabilityMatrix } from "#providers";
import type { FridayExecutionIsolationStatus } from "../../../skills/executor/friday-execution-isolation-status.js";

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
  executionIsolation?: FridayExecutionIsolationStatus;
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
    executionIsolation: {
      schemaVersion: "1.0",
      disposition: "open_no_os_sandbox",
      osSandbox: false,
      surfaces: {
        "skill.shell": {
          boundary: "logical_guards_only",
          osSandbox: false,
          defaultLive: false,
          notes: "Shell skills use host child_process.spawn with cwd/env/timeout/output guards; no kernel sandbox is applied.",
        },
        "skill.python": {
          boundary: "logical_guards_only",
          osSandbox: false,
          defaultLive: false,
          notes: "Python skills share the shell executor boundary and are not isolated by an OS sandbox.",
        },
        "skill.node": {
          boundary: "disabled_in_production_unisolated_test_harness_only",
          osSandbox: false,
          defaultLive: false,
          notes: "Non-bundled Node skills dynamically import in-process modules; FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS=true is accepted only by the test harness, never as a production live unlock.",
        },
        "skill.node.bundled_system": {
          boundary: "in_process_trusted",
          osSandbox: false,
          defaultLive: true,
          notes: "Bundled system Node skills may run without the unisolated env gate, but still execute in the hub process.",
        },
        "plugin.entrypoint": {
          boundary: "retired_by_default_dynamic_import_when_enabled",
          osSandbox: false,
          defaultLive: false,
          notes: "Plugin lifecycle routes are retired by default; enabled plugin entrypoints are dynamic imports, not OS-isolated processes.",
        },
        "agent.exec": {
          boundary: "logical_workspace_guard_host_spawn",
          osSandbox: false,
          defaultLive: true,
          notes: "Agent exec uses host spawn with workspace, shell, timeout, and output controls; no OS sandbox is applied.",
        },
      },
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
      auth: { public: true },
      async handler() {
        return buildHealthPayload(true);
      },
    },
  ];
}

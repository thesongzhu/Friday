import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import {
  errorResult,
  jsonResult,
  readStringParam,
} from "./friday-agent-tool-helpers.js";
import type { FridayGatewayService } from "../../hub/services/friday-gateway-service.js";

// ─── Constants ───

type GatewayAction = "status" | "restart" | "config_get" | "config_set" | "update";

const VALID_ACTIONS = new Set<GatewayAction>([
  "status",
  "restart",
  "config_get",
  "config_set",
  "update",
]);

// ─── Types ───

export interface CreateFridayAgentGatewayToolOptions {
  gatewayService: FridayGatewayService;
}

// ─── Factory ───

export function createFridayAgentGatewayTool(
  options: CreateFridayAgentGatewayToolOptions,
): FridayAgentToolDefinition {
  const { gatewayService } = options;

  return {
    name: "gateway",
    description:
      "Manage the Friday gateway service. " +
      "Actions: status (health/version), restart (restart the gateway process), " +
      "config_get (read a config key), config_set (write a config key), " +
      "update (trigger a gateway update).",
    parameters: {
      properties: {
        action: {
          type: "string",
          enum: ["status", "restart", "config_get", "config_set", "update"],
          description: "Gateway action to perform.",
        },
        key: {
          type: "string",
          description: "Config key (required for config_get/config_set).",
        },
        value: {
          description: "Config value to set (required for config_set). Any JSON value.",
        },
      },
      required: ["action"],
    },

    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const action = readStringParam(args, "action", { required: true }) as GatewayAction;

      if (!VALID_ACTIONS.has(action)) {
        return errorResult(
          `Invalid action "${action}". Valid: ${Array.from(VALID_ACTIONS).join(", ")}`,
        );
      }

      try {
        switch (action) {
          case "status":
            return await handleStatus(signal);
          case "restart":
            return await handleRestart(signal);
          case "config_get":
            return await handleConfigGet(args, signal);
          case "config_set":
            return await handleConfigSet(args, signal);
          case "update":
            return await handleUpdate(signal);
          default:
            return errorResult(`Unknown gateway action: ${action as string}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("aborted") || message.includes("abort")) {
          return errorResult("Gateway action aborted.");
        }
        return errorResult(`Gateway error: ${message}`);
      }
    },
  };

  // ─── Action handlers ───

  async function handleStatus(signal: AbortSignal): Promise<FridayAgentToolResult> {
    const status = await gatewayService.status(signal);
    return jsonResult({
      healthy: status.healthy,
      version: status.version,
      uptime: status.uptime,
      pid: status.pid,
      url: status.url,
    });
  }

  async function handleRestart(signal: AbortSignal): Promise<FridayAgentToolResult> {
    const result = await gatewayService.restart(signal);
    if (!result.success) {
      return errorResult(`Gateway restart failed: ${result.message}`);
    }
    return jsonResult({
      success: true,
      message: result.message,
    });
  }

  async function handleConfigGet(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const key = readStringParam(args, "key", { required: true });
    const entry = await gatewayService.configGet(key, signal);

    if (!entry) {
      return errorResult(`Config key "${key}" not found.`);
    }

    return jsonResult({
      key: entry.key,
      value: entry.value,
    });
  }

  async function handleConfigSet(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const key = readStringParam(args, "key", { required: true });
    const value = args.value;

    if (value === undefined) {
      return errorResult("'value' is required for config_set action.");
    }

    const result = await gatewayService.configSet(key, value, signal);
    if (!result.success) {
      return errorResult(`Failed to set config key "${key}".`);
    }

    return jsonResult({
      key: result.key,
      value: result.value,
      success: true,
    });
  }

  async function handleUpdate(signal: AbortSignal): Promise<FridayAgentToolResult> {
    const result = await gatewayService.update(signal);
    if (!result.success) {
      return errorResult(`Gateway update failed: ${result.message}`);
    }

    return jsonResult({
      success: true,
      message: result.message,
      version: result.version,
    });
  }
}

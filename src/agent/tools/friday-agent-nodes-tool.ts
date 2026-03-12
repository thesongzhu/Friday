import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import {
  errorResult,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";
import type { FridayNodesService } from "../../nodes/friday-nodes-service.js";

// ─── Constants ───

type NodesAction = "discover" | "get" | "control";

const VALID_ACTIONS = new Set<NodesAction>(["discover", "get", "control"]);
const DEFAULT_CONTROL_TIMEOUT_MS = 30_000;

// ─── Types ───

export interface CreateFridayAgentNodesToolOptions {
  nodesService: FridayNodesService;
}

// ─── Factory ───

export function createFridayAgentNodesTool(
  options: CreateFridayAgentNodesToolOptions,
): FridayAgentToolDefinition {
  const { nodesService } = options;

  return {
    name: "nodes",
    description:
      "Interact with paired devices/nodes. " +
      "Actions: discover (list all known nodes), get (get info about a specific node), " +
      "control (send a command to a node).",
    parameters: {
      properties: {
        action: {
          type: "string",
          enum: ["discover", "get", "control"],
          description: "Node action to perform.",
        },
        nodeId: {
          type: "string",
          description: "Node identifier (required for get/control).",
        },
        command: {
          type: "string",
          description: "Command to send (required for control action).",
        },
        args: {
          type: "object",
          description: "Arguments for the control command (optional).",
        },
        timeoutMs: {
          type: "number",
          description: `Timeout for control command in ms (default: ${DEFAULT_CONTROL_TIMEOUT_MS}).`,
        },
      },
      required: ["action"],
    },

    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const action = readStringParam(args, "action", { required: true }) as NodesAction;

      if (!VALID_ACTIONS.has(action)) {
        return errorResult(
          `Invalid action "${action}". Valid: ${Array.from(VALID_ACTIONS).join(", ")}`,
        );
      }

      try {
        switch (action) {
          case "discover":
            return await handleDiscover(signal);
          case "get":
            return await handleGet(args, signal);
          case "control":
            return await handleControl(args, signal);
          default:
            return errorResult(`Unknown nodes action: ${action as string}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("aborted") || message.includes("abort")) {
          return errorResult("Nodes action aborted.");
        }
        return errorResult(`Nodes error: ${message}`);
      }
    },
  };

  // ─── Action handlers ───

  async function handleDiscover(signal: AbortSignal): Promise<FridayAgentToolResult> {
    const nodes = await nodesService.discover(signal);
    return jsonResult({
      count: nodes.length,
      nodes: nodes.map((n) => ({
        nodeId: n.nodeId,
        name: n.name,
        kind: n.kind,
        status: n.status,
        lastSeen: n.lastSeen,
      })),
    });
  }

  async function handleGet(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const nodeId = readStringParam(args, "nodeId", { required: true });
    const node = await nodesService.get(nodeId, signal);

    if (!node) {
      return errorResult(`Node "${nodeId}" not found.`);
    }

    return jsonResult({
      nodeId: node.nodeId,
      name: node.name,
      kind: node.kind,
      status: node.status,
      lastSeen: node.lastSeen,
      metadata: node.metadata,
    });
  }

  async function handleControl(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const nodeId = readStringParam(args, "nodeId", { required: true });
    const command = readStringParam(args, "command", { required: true });
    const timeoutMs =
      readNumberParam(args, "timeoutMs", { integer: true }) ?? DEFAULT_CONTROL_TIMEOUT_MS;

    // Read args as a plain object
    const controlArgs =
      args.args && typeof args.args === "object" && !Array.isArray(args.args)
        ? (args.args as Record<string, unknown>)
        : undefined;

    const result = await nodesService.control(nodeId, command, controlArgs, timeoutMs, signal);

    if (!result.success) {
      return errorResult(
        `Control command "${command}" failed on node "${nodeId}": ${result.error ?? "Unknown error"}`,
      );
    }

    return jsonResult({
      nodeId: result.nodeId,
      command: result.command,
      success: result.success,
      response: result.response,
      durationMs: result.durationMs,
    });
  }
}

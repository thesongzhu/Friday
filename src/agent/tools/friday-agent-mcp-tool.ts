import {
  isFridayMcpAdapterError,
} from "../mcp/friday-mcp-adapter.js";
import type { FridayMcpAdapter } from "../mcp/friday-mcp-adapter.types.js";
import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import {
  errorResult,
  jsonResult,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

type McpAction =
  | "list_servers"
  | "list_server_states"
  | "list_tools"
  | "search_tools"
  | "call_tool"
  | "list_resources"
  | "read_resource"
  | "list_prompts"
  | "get_prompt";

const VALID_ACTIONS = new Set<McpAction>([
  "list_servers",
  "list_server_states",
  "list_tools",
  "search_tools",
  "call_tool",
  "list_resources",
  "read_resource",
  "list_prompts",
  "get_prompt",
]);

export interface CreateFridayAgentMcpToolOptions {
  mcpAdapter: FridayMcpAdapter;
  getServerAvailability?: FridayMcpServerAvailabilityResolver;
}

export interface FridayMcpServerAvailability {
  available: boolean;
  reason?: string;
  promotionChannel?: string;
  compatibilityStatus?: string;
}

export type FridayMcpServerAvailabilityResolver = (serverId: string) => FridayMcpServerAvailability;

const MCP_SERVER_NOT_PROMOTED = "MCP_SERVER_NOT_PROMOTED";

export function createFridayAgentMcpTool(
  options: CreateFridayAgentMcpToolOptions,
): FridayAgentToolDefinition {
  const { mcpAdapter, getServerAvailability } = options;

  return {
    name: "mcp",
    description:
      "Bridge to promoted external MCP servers. " +
      "Actions: list_servers, list_server_states, list_tools, search_tools, call_tool, list_resources, read_resource, list_prompts, get_prompt.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "list_servers",
            "list_server_states",
            "list_tools",
            "search_tools",
            "call_tool",
            "list_resources",
            "read_resource",
            "list_prompts",
            "get_prompt",
          ],
          description: "MCP action to execute.",
        },
        serverId: {
          type: "string",
          description: "Configured MCP server id. Optional for list operations, required for targeted calls.",
        },
        toolName: {
          type: "string",
          description: "MCP tool name. Required for call_tool.",
        },
        query: {
          type: "string",
          description: "Search query for MCP tool discovery. Used by search_tools.",
        },
        promptName: {
          type: "string",
          description: "MCP prompt name. Required for get_prompt.",
        },
        uri: {
          type: "string",
          description: "MCP resource URI. Required for read_resource.",
        },
        args: {
          type: "object",
          description: "Arguments for tool calls or prompt retrieval.",
          additionalProperties: true,
        },
      },
      required: ["action"],
      additionalProperties: false,
    },

    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      try {
        const action = readStringParam(args, "action", { required: true }) as McpAction;
        if (!VALID_ACTIONS.has(action)) {
          return errorResult(
            `Invalid action "${action}". Valid: ${Array.from(VALID_ACTIONS).join(", ")}`,
          );
        }

        switch (action) {
          case "list_servers":
            return handleListServers();
          case "list_server_states":
            return handleListServerStates();
          case "list_tools":
            return await handleListTools(args, signal);
          case "search_tools":
            return await handleSearchTools(args, signal);
          case "call_tool":
            return await handleCallTool(args, signal);
          case "list_resources":
            return await handleListResources(args, signal);
          case "read_resource":
            return await handleReadResource(args, signal);
          case "list_prompts":
            return await handleListPrompts(args, signal);
          case "get_prompt":
            return await handleGetPrompt(args, signal);
          default:
            return errorResult(`Unsupported action: ${action as string}`);
        }
      } catch (error) {
        if (isFridayMcpAdapterError(error)) {
          return errorResult(
            `MCP error [${error.code}]: ${error.message}`,
            {
              errorCode: error.code,
              routeId: error.routeId,
              correlationId: error.correlationId,
            },
          );
        }

        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("aborted") || message.includes("abort")) {
          return errorResult("MCP request aborted.", {
            errorCode: "MCP_REQUEST_ABORTED",
          });
        }
        return errorResult(`MCP error: ${message}`, {
          errorCode: "MCP_UNHANDLED_ERROR",
        });
      }
    },
  };

  function handleListServers(): FridayAgentToolResult {
    const servers = mcpAdapter.listServers().map((server) => {
      const availability = resolveAvailability(server.id);
      return {
        id: server.id,
        transport: server.transport ?? "stdio",
        availability,
        ...(availability.available
          ? {
              command: server.command,
              args: server.args ?? [],
              cwd: server.cwd ?? null,
              url: server.url ?? null,
              timeoutMs: server.timeoutMs ?? null,
              policy: server.policy ?? null,
            }
          : {}),
      };
    });

    return jsonResult({
      count: servers.length,
      items: servers,
    });
  }

  function handleListServerStates(): FridayAgentToolResult {
    const states = mcpAdapter.listServerStates().map((state) => ({
      ...state,
      availability: resolveAvailability(state.serverId),
    }));
    return jsonResult({
      count: states.length,
      items: states,
    });
  }

  async function handleListTools(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const serverId = readStringParam(args, "serverId");
    const targets = resolveTargetServers(serverId);
    if (targets instanceof Error) {
      return unavailableResult(targets.message, serverId);
    }
    const tools = serverId
      ? await mcpAdapter.listTools({ serverId, signal })
      : (await Promise.all(targets.map((target) => mcpAdapter.listTools({ serverId: target, signal })))).flat();
    return jsonResult({
      count: tools.length,
      items: tools,
    });
  }

  async function handleSearchTools(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const serverId = readStringParam(args, "serverId");
    const query = readStringParam(args, "query", { required: true });
    const targets = resolveTargetServers(serverId);
    if (targets instanceof Error) {
      return unavailableResult(targets.message, serverId);
    }
    const tools = serverId
      ? await mcpAdapter.searchTools({ query, serverId, signal })
      : (await Promise.all(targets.map((target) => mcpAdapter.searchTools({ query, serverId: target, signal })))).flat();
    return jsonResult({
      count: tools.length,
      items: tools,
    });
  }

  async function handleCallTool(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const serverId = readStringParam(args, "serverId", { required: true });
    const toolName = readStringParam(args, "toolName", { required: true });
    const availability = resolveAvailability(serverId);
    if (!availability.available) {
      return unavailableResult(buildUnavailableMessage(serverId, availability), serverId);
    }
    const callArgs = readArgs(args);
    if (callArgs instanceof Error) {
      return errorResult(callArgs.message);
    }

    const result = await mcpAdapter.callTool({
      serverId,
      toolName,
      args: callArgs,
      signal,
    });

    if (result.isError) {
      return errorResult(
        result.content || `MCP tool ${toolName} returned an error`,
        {
          errorCode: "MCP_TOOL_RESULT_ERROR",
        },
      );
    }

    return jsonResult({
      serverId,
      toolName,
      content: result.content,
      raw: result.raw,
    });
  }

  async function handleListResources(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const serverId = readStringParam(args, "serverId");
    const targets = resolveTargetServers(serverId);
    if (targets instanceof Error) {
      return unavailableResult(targets.message, serverId);
    }
    const resources = serverId
      ? await mcpAdapter.listResources({ serverId, signal })
      : (await Promise.all(targets.map((target) => mcpAdapter.listResources({ serverId: target, signal })))).flat();
    return jsonResult({
      count: resources.length,
      items: resources,
    });
  }

  async function handleReadResource(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const serverId = readStringParam(args, "serverId", { required: true });
    const uri = readStringParam(args, "uri", { required: true });
    const availability = resolveAvailability(serverId);
    if (!availability.available) {
      return unavailableResult(buildUnavailableMessage(serverId, availability), serverId);
    }
    const result = await mcpAdapter.readResource({
      serverId,
      uri,
      signal,
    });

    return jsonResult({
      serverId,
      uri,
      content: result.content,
      raw: result.raw,
    });
  }

  async function handleListPrompts(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const serverId = readStringParam(args, "serverId");
    const targets = resolveTargetServers(serverId);
    if (targets instanceof Error) {
      return unavailableResult(targets.message, serverId);
    }
    const prompts = serverId
      ? await mcpAdapter.listPrompts({ serverId, signal })
      : (await Promise.all(targets.map((target) => mcpAdapter.listPrompts({ serverId: target, signal })))).flat();
    return jsonResult({
      count: prompts.length,
      items: prompts,
    });
  }

  async function handleGetPrompt(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const serverId = readStringParam(args, "serverId", { required: true });
    const name = readStringParam(args, "promptName", { required: true });
    const availability = resolveAvailability(serverId);
    if (!availability.available) {
      return unavailableResult(buildUnavailableMessage(serverId, availability), serverId);
    }
    const promptArgs = readArgs(args);
    if (promptArgs instanceof Error) {
      return errorResult(promptArgs.message);
    }

    const result = await mcpAdapter.getPrompt({
      serverId,
      name,
      args: promptArgs,
      signal,
    });

    return jsonResult({
      serverId,
      name,
      content: result.content,
      raw: result.raw,
    });
  }

  function resolveAvailability(serverId: string): FridayMcpServerAvailability {
    return getServerAvailability?.(serverId) ?? {
      available: false,
      promotionChannel: "none",
      compatibilityStatus: "unknown",
      reason: "MCP server lifecycle availability gate is unavailable.",
    };
  }

  function resolveTargetServers(serverId: string | undefined): string[] | Error {
    if (serverId) {
      const availability = resolveAvailability(serverId);
      return availability.available
        ? [serverId]
        : new Error(buildUnavailableMessage(serverId, availability));
    }
    return mcpAdapter
      .listServers()
      .map((server) => server.id)
      .filter((id) => resolveAvailability(id).available);
  }

  function buildUnavailableMessage(serverId: string, availability: FridayMcpServerAvailability): string {
    return `MCP server "${serverId}" is not available to the agent because it has not completed lifecycle promote` +
      (availability.promotionChannel ? ` (promotionChannel=${availability.promotionChannel})` : "") +
      (availability.reason ? `: ${availability.reason}` : ".");
  }

  function unavailableResult(message: string, serverId?: string): FridayAgentToolResult {
    return errorResult(message, {
      errorCode: MCP_SERVER_NOT_PROMOTED,
      routeId: "mcp.agent.lifecycle_availability",
      correlationId: serverId ? `mcp.agent:${serverId}:not_promoted` : "mcp.agent:not_promoted",
    });
  }
}

function readArgs(args: Record<string, unknown>): Record<string, unknown> | Error {
  const raw = args.args;
  if (raw === undefined) {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return new Error("args must be an object when provided");
  }
  return raw as Record<string, unknown>;
}

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
  | "list_tools"
  | "call_tool"
  | "list_resources"
  | "read_resource"
  | "list_prompts"
  | "get_prompt";

const VALID_ACTIONS = new Set<McpAction>([
  "list_servers",
  "list_tools",
  "call_tool",
  "list_resources",
  "read_resource",
  "list_prompts",
  "get_prompt",
]);

export interface CreateFridayAgentMcpToolOptions {
  mcpAdapter: FridayMcpAdapter;
}

export function createFridayAgentMcpTool(
  options: CreateFridayAgentMcpToolOptions,
): FridayAgentToolDefinition {
  const { mcpAdapter } = options;

  return {
    name: "mcp",
    description:
      "Bridge to external MCP servers. " +
      "Actions: list_servers, list_tools, call_tool, list_resources, read_resource, list_prompts, get_prompt.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "list_servers",
            "list_tools",
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
          case "list_tools":
            return await handleListTools(args, signal);
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
    const servers = mcpAdapter.listServers().map((server) => ({
      id: server.id,
      transport: server.transport ?? "stdio",
      command: server.command,
      args: server.args ?? [],
      cwd: server.cwd ?? null,
      url: server.url ?? null,
      timeoutMs: server.timeoutMs ?? null,
      policy: server.policy ?? null,
    }));

    return jsonResult({
      count: servers.length,
      items: servers,
    });
  }

  async function handleListTools(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<FridayAgentToolResult> {
    const serverId = readStringParam(args, "serverId");
    const tools = await mcpAdapter.listTools({ serverId, signal });
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
    const resources = await mcpAdapter.listResources({ serverId, signal });
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
    const prompts = await mcpAdapter.listPrompts({ serverId, signal });
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

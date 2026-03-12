import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";

export interface FridayMcpServerToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface FridayMcpServerResourceDescriptor {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface FridayMcpServerPromptDescriptor {
  name: string;
  description?: string;
}

export interface FridayMcpServerRoutesDeps {
  serverInfo?: {
    name?: string;
    version?: string;
    instructions?: string;
  };
  listTools(signal?: AbortSignal): Promise<FridayMcpServerToolDescriptor[]> | FridayMcpServerToolDescriptor[];
  callTool(input: {
    name: string;
    args?: Record<string, unknown>;
    signal?: AbortSignal;
    routeId?: string;
    correlationId?: string;
    requestId?: string;
  }): Promise<{
    content: string;
    isError?: boolean;
    errorCode?: string;
    routeId?: string;
    correlationId?: string;
    raw?: unknown;
  }>;
  listResources?(input?: {
    signal?: AbortSignal;
    routeId?: string;
    correlationId?: string;
    requestId?: string;
  }): Promise<FridayMcpServerResourceDescriptor[]> | FridayMcpServerResourceDescriptor[];
  readResource?(input: {
    uri: string;
    signal?: AbortSignal;
    routeId?: string;
    correlationId?: string;
    requestId?: string;
  }): Promise<{
    contents: Array<{
      uri?: string;
      mimeType?: string;
      text?: string;
      blob?: string;
    }>;
  }>;
  listPrompts?(input?: {
    signal?: AbortSignal;
    routeId?: string;
    correlationId?: string;
    requestId?: string;
  }): Promise<FridayMcpServerPromptDescriptor[]> | FridayMcpServerPromptDescriptor[];
  getPrompt?(input: {
    name: string;
    args?: Record<string, unknown>;
    signal?: AbortSignal;
    routeId?: string;
    correlationId?: string;
    requestId?: string;
  }): Promise<{
    description?: string;
    messages: Array<{
      role: "system" | "user" | "assistant";
      content: Array<{
        type: "text";
        text: string;
      }>;
    }>;
  }>;
}

type JsonRpcId = string | number | null;

type Route = FridayRouteDefinition<unknown, Record<string, string>, unknown, unknown>;

const MCP_PROTOCOL_VERSION = "2024-11-05";
const MCP_SERVER_ROUTE_ID = "mcp.server.rpc";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asId(value: unknown): JsonRpcId {
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return null;
}

function makeJsonRpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function makeJsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data ? { data } : {}),
    },
  };
}

function toCorrelationId(requestId: string, method: string, id: JsonRpcId): string {
  const idPart = id === null ? "null" : String(id);
  return `mcp.server:${requestId}:${method}:${idPart}`;
}

function makeErrorData(input: {
  requestId: string;
  routeId: string;
  correlationId: string;
  errorCode: string;
  message?: string;
}): Record<string, unknown> {
  return {
    requestId: input.requestId,
    routeId: input.routeId,
    correlationId: input.correlationId,
    errorCode: input.errorCode,
    ...(input.message ? { message: input.message } : {}),
  };
}

function extractErrorCode(error: unknown): string {
  const code = asRecord(error).code;
  return typeof code === "string" && code.trim().length > 0
    ? code
    : "MCP_SERVER_INTERNAL_ERROR";
}

function extractErrorRouteId(error: unknown): string | undefined {
  const routeId = asRecord(error).routeId;
  return typeof routeId === "string" && routeId.trim().length > 0
    ? routeId
    : undefined;
}

function extractErrorCorrelationId(error: unknown): string | undefined {
  const correlationId = asRecord(error).correlationId;
  return typeof correlationId === "string" && correlationId.trim().length > 0
    ? correlationId
    : undefined;
}

export function createFridayMcpServerRoutes(
  deps: FridayMcpServerRoutesDeps,
): Route[] {
  return [
    {
      operationId: "mcp.server.rpc",
      method: "POST",
      path: "/v1/mcp",
      auth: { public: false, anyOfScopes: ["agent.run"] },
      handler: async (ctx) => {
        const request = asRecord(ctx.body);
        const id = asId(request.id);
        const method = typeof request.method === "string" ? request.method : "";
        const routeId = MCP_SERVER_ROUTE_ID;
        const correlationId = toCorrelationId(ctx.requestId, method || "unknown", id);
        const params = asRecord(request.params);

        if (!method) {
          return {
            status: 200,
            body: makeJsonRpcError(
              id,
              -32600,
              "Invalid request: method is required",
              makeErrorData({
                requestId: ctx.requestId,
                routeId,
                correlationId,
                errorCode: "MCP_SERVER_INVALID_REQUEST",
              }),
            ),
          };
        }

        try {
          switch (method) {
            case "initialize": {
              return {
                status: 200,
                body: makeJsonRpcResult(id, {
                  protocolVersion: MCP_PROTOCOL_VERSION,
                  serverInfo: {
                    name: deps.serverInfo?.name ?? "friday",
                    version: deps.serverInfo?.version ?? "1.0.0",
                  },
                  capabilities: {
                    tools: { listChanged: false },
                    resources: { listChanged: false },
                    prompts: { listChanged: false },
                  },
                  ...(deps.serverInfo?.instructions
                    ? { instructions: deps.serverInfo.instructions }
                    : {}),
                }),
              };
            }
            case "notifications/initialized": {
              return {
                status: 200,
                body: makeJsonRpcResult(id, {}),
              };
            }
            case "tools/list": {
              const tools = await deps.listTools();
              return {
                status: 200,
                body: makeJsonRpcResult(id, {
                  tools: tools.map((tool) => ({
                    name: tool.name,
                    ...(tool.description ? { description: tool.description } : {}),
                    inputSchema: tool.inputSchema,
                  })),
                }),
              };
            }
            case "tools/call": {
              const name = typeof params.name === "string" ? params.name.trim() : "";
              if (!name) {
                return {
                  status: 200,
                  body: makeJsonRpcError(
                    id,
                    -32602,
                    "Invalid params: name is required",
                    makeErrorData({
                      requestId: ctx.requestId,
                      routeId,
                      correlationId,
                      errorCode: "MCP_SERVER_INVALID_PARAMS",
                    }),
                  ),
                };
              }
              const rawArgs = params.arguments;
              const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
                ? rawArgs as Record<string, unknown>
                : {};

              const toolResult = await deps.callTool({
                name,
                args,
                routeId,
                correlationId,
                requestId: ctx.requestId,
              });

              return {
                status: 200,
                body: makeJsonRpcResult(id, {
                  content: [{ type: "text", text: toolResult.content }],
                  isError: toolResult.isError === true,
                  ...(toolResult.isError === true
                    ? {
                        error: makeErrorData({
                          requestId: ctx.requestId,
                          routeId: toolResult.routeId ?? routeId,
                          correlationId: toolResult.correlationId ?? correlationId,
                          errorCode: toolResult.errorCode ?? "MCP_SERVER_TOOL_ERROR",
                          message: toolResult.content,
                        }),
                      }
                    : {}),
                  ...(toolResult.raw !== undefined ? { raw: toolResult.raw } : {}),
                }),
              };
            }
            case "resources/list": {
              const resources = deps.listResources
                ? await deps.listResources({
                    routeId,
                    correlationId,
                    requestId: ctx.requestId,
                  })
                : [];
              return {
                status: 200,
                body: makeJsonRpcResult(id, { resources }),
              };
            }
            case "resources/read": {
              if (!deps.readResource) {
                return {
                  status: 200,
                  body: makeJsonRpcError(id, -32601, "Method not found"),
                };
              }
              const uri = typeof params.uri === "string" ? params.uri.trim() : "";
              if (!uri) {
                return {
                  status: 200,
                  body: makeJsonRpcError(
                    id,
                    -32602,
                    "Invalid params: uri is required",
                    makeErrorData({
                      requestId: ctx.requestId,
                      routeId,
                      correlationId,
                      errorCode: "MCP_SERVER_INVALID_PARAMS",
                    }),
                  ),
                };
              }
              const result = await deps.readResource({
                uri,
                routeId,
                correlationId,
                requestId: ctx.requestId,
              });
              return {
                status: 200,
                body: makeJsonRpcResult(id, {
                  contents: result.contents,
                }),
              };
            }
            case "prompts/list": {
              const prompts = deps.listPrompts
                ? await deps.listPrompts({
                    routeId,
                    correlationId,
                    requestId: ctx.requestId,
                  })
                : [];
              return {
                status: 200,
                body: makeJsonRpcResult(id, { prompts }),
              };
            }
            case "prompts/get": {
              if (!deps.getPrompt) {
                return {
                  status: 200,
                  body: makeJsonRpcError(id, -32601, "Method not found"),
                };
              }
              const name = typeof params.name === "string" ? params.name.trim() : "";
              if (!name) {
                return {
                  status: 200,
                  body: makeJsonRpcError(
                    id,
                    -32602,
                    "Invalid params: name is required",
                    makeErrorData({
                      requestId: ctx.requestId,
                      routeId,
                      correlationId,
                      errorCode: "MCP_SERVER_INVALID_PARAMS",
                    }),
                  ),
                };
              }
              const rawArgs = params.arguments;
              const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
                ? rawArgs as Record<string, unknown>
                : {};
              const prompt = await deps.getPrompt({
                name,
                args,
                routeId,
                correlationId,
                requestId: ctx.requestId,
              });
              return {
                status: 200,
                body: makeJsonRpcResult(id, {
                  ...(prompt.description ? { description: prompt.description } : {}),
                  messages: prompt.messages,
                }),
              };
            }
            default:
              return {
                status: 200,
                body: makeJsonRpcError(id, -32601, "Method not found"),
              };
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const errorRouteId = extractErrorRouteId(error) ?? routeId;
          const errorCorrelationId = extractErrorCorrelationId(error) ?? correlationId;
          return {
            status: 200,
            body: makeJsonRpcError(
              id,
              -32603,
              "Internal error",
              makeErrorData({
                requestId: ctx.requestId,
                routeId: errorRouteId,
                correlationId: errorCorrelationId,
                errorCode: extractErrorCode(error),
                message,
              }),
            ),
          };
        }
      },
    },
  ];
}

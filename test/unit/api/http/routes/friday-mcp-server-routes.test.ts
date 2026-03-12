import { describe, expect, it, vi } from "vitest";

import {
  createFridayMcpServerRoutes,
  type FridayMcpServerRoutesDeps,
} from "#api";

const NOW = "2026-03-05T00:00:00.000Z";

function createDeps(): FridayMcpServerRoutesDeps {
  return {
    serverInfo: {
      name: "friday",
      version: "0.3.1",
    },
    listTools: vi.fn().mockResolvedValue([
      {
        name: "echo",
        description: "Echo text",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
        },
      },
    ]),
    callTool: vi.fn().mockResolvedValue({
      content: "ok",
      isError: false,
      raw: { value: "ok" },
    }),
    listResources: vi.fn().mockResolvedValue([
      {
        uri: "friday://status",
        name: "status",
      },
    ]),
    readResource: vi.fn().mockResolvedValue({
      contents: [{ uri: "friday://status", text: "{\"ok\":true}" }],
    }),
    listPrompts: vi.fn().mockResolvedValue([
      {
        name: "friday_tool_call",
        description: "tool prompt",
      },
    ]),
    getPrompt: vi.fn().mockResolvedValue({
      description: "prompt",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    }),
  };
}

function buildCtx(body: unknown) {
  return {
    params: {},
    query: {},
    body,
    headers: {},
    principal: {
      principalType: "user",
      principalId: "tenant-1",
      tokenId: "token-1",
      tokenKind: "access",
      scopes: ["agent.run"],
      issuedAt: NOW,
    },
    requestId: "req-1",
    receivedAt: NOW,
  } as const;
}

describe("createFridayMcpServerRoutes", () => {
  it("registers MCP JSON-RPC route", () => {
    const routes = createFridayMcpServerRoutes(createDeps());
    expect(routes).toHaveLength(1);
    expect(routes[0]?.operationId).toBe("mcp.server.rpc");
    expect(routes[0]?.path).toBe("/v1/mcp");
  });

  it("handles initialize", async () => {
    const routes = createFridayMcpServerRoutes(createDeps());
    const route = routes[0]!;
    const response = await route.handler(buildCtx({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
      },
    }) as never);

    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(body.result).toBeDefined();
    expect((body.result as Record<string, unknown>).protocolVersion).toBe("2024-11-05");
  });

  it("proxies tools/list and tools/call", async () => {
    const deps = createDeps();
    const routes = createFridayMcpServerRoutes(deps);
    const route = routes[0]!;

    const listResponse = await route.handler(buildCtx({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }) as never);
    expect(listResponse.status).toBe(200);
    expect(deps.listTools).toHaveBeenCalledTimes(1);

    const callResponse = await route.handler(buildCtx({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "echo",
        arguments: { text: "hello" },
      },
    }) as never);
    expect(callResponse.status).toBe(200);
    expect(deps.callTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "echo",
      args: { text: "hello" },
      routeId: "mcp.server.rpc",
      requestId: "req-1",
      correlationId: "mcp.server:req-1:tools/call:3",
    }));
  });

  it("validates required params", async () => {
    const routes = createFridayMcpServerRoutes(createDeps());
    const route = routes[0]!;

    const response = await route.handler(buildCtx({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {},
    }) as never);

    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect((body.error as Record<string, unknown>).code).toBe(-32602);
    expect((body.error as Record<string, unknown>).data).toMatchObject({
      requestId: "req-1",
      routeId: "mcp.server.rpc",
      errorCode: "MCP_SERVER_INVALID_PARAMS",
    });
  });

  it("proxies resources and prompts endpoints", async () => {
    const deps = createDeps();
    const routes = createFridayMcpServerRoutes(deps);
    const route = routes[0]!;

    const resourcesResponse = await route.handler(buildCtx({
      jsonrpc: "2.0",
      id: 5,
      method: "resources/list",
      params: {},
    }) as never);
    expect(resourcesResponse.status).toBe(200);
    expect(deps.listResources).toHaveBeenCalledWith(expect.objectContaining({
      routeId: "mcp.server.rpc",
      requestId: "req-1",
      correlationId: "mcp.server:req-1:resources/list:5",
    }));

    const readResourceResponse = await route.handler(buildCtx({
      jsonrpc: "2.0",
      id: 6,
      method: "resources/read",
      params: {
        uri: "friday://status",
      },
    }) as never);
    expect(readResourceResponse.status).toBe(200);
    expect(deps.readResource).toHaveBeenCalledWith(expect.objectContaining({
      uri: "friday://status",
      routeId: "mcp.server.rpc",
      requestId: "req-1",
      correlationId: "mcp.server:req-1:resources/read:6",
    }));

    const promptsResponse = await route.handler(buildCtx({
      jsonrpc: "2.0",
      id: 7,
      method: "prompts/list",
      params: {},
    }) as never);
    expect(promptsResponse.status).toBe(200);
    expect(deps.listPrompts).toHaveBeenCalledWith(expect.objectContaining({
      routeId: "mcp.server.rpc",
      requestId: "req-1",
      correlationId: "mcp.server:req-1:prompts/list:7",
    }));

    const promptGetResponse = await route.handler(buildCtx({
      jsonrpc: "2.0",
      id: 8,
      method: "prompts/get",
      params: {
        name: "friday_tool_call",
        arguments: { toolName: "echo" },
      },
    }) as never);
    expect(promptGetResponse.status).toBe(200);
    expect(deps.getPrompt).toHaveBeenCalledWith(expect.objectContaining({
      name: "friday_tool_call",
      args: { toolName: "echo" },
      routeId: "mcp.server.rpc",
      requestId: "req-1",
      correlationId: "mcp.server:req-1:prompts/get:8",
    }));
  });

  it("returns method not found for unsupported method", async () => {
    const routes = createFridayMcpServerRoutes(createDeps());
    const route = routes[0]!;

    const response = await route.handler(buildCtx({
      jsonrpc: "2.0",
      id: 8,
      method: "unsupported/method",
      params: {},
    }) as never);

    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect((body.error as Record<string, unknown>).code).toBe(-32601);
  });

  it("maps handler exceptions to JSON-RPC internal error", async () => {
    const deps = createDeps();
    deps.callTool = vi.fn().mockRejectedValue(new Error("boom"));
    const routes = createFridayMcpServerRoutes(deps);
    const route = routes[0]!;

    const response = await route.handler(buildCtx({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "echo",
        arguments: {},
      },
    }) as never);

    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect((body.error as Record<string, unknown>).code).toBe(-32603);
    expect((body.error as Record<string, unknown>).data).toMatchObject({
      requestId: "req-1",
      routeId: "mcp.server.rpc",
      errorCode: "MCP_SERVER_INTERNAL_ERROR",
      correlationId: "mcp.server:req-1:tools/call:9",
    });
  });

  it("returns normalized tool error metadata when tool reports isError", async () => {
    const deps = createDeps();
    deps.callTool = vi.fn().mockResolvedValue({
      content: "tool denied",
      isError: true,
      errorCode: "MCP_SERVER_TOOL_NOT_EXPOSED",
      routeId: "mcp.server.rpc",
      correlationId: "corr-1",
      raw: { reason: "allowlist" },
    });
    const routes = createFridayMcpServerRoutes(deps);
    const route = routes[0]!;

    const response = await route.handler(buildCtx({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "echo",
        arguments: {},
      },
    }) as never);

    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    const result = body.result as Record<string, unknown>;
    expect(result.isError).toBe(true);
    expect(result.error).toMatchObject({
      requestId: "req-1",
      routeId: "mcp.server.rpc",
      correlationId: "corr-1",
      errorCode: "MCP_SERVER_TOOL_NOT_EXPOSED",
      message: "tool denied",
    });
  });
});

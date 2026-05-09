import { describe, it, expect, vi } from "vitest";

import { createFridayAgentMcpTool } from "#agent";
import type { FridayMcpAdapter } from "../../../../src/agent/mcp/friday-mcp-adapter.types.js";

function makeAdapter(): FridayMcpAdapter {
  return {
    listServers: vi.fn().mockReturnValue([
      {
        id: "filesystem",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      },
    ]),
    listServerStates: vi.fn().mockReturnValue([
      {
        serverId: "filesystem",
        transport: "stdio",
        state: "deferred",
        lazyDiscovery: true,
      },
    ]),
    listTools: vi.fn().mockResolvedValue([
      {
        serverId: "filesystem",
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      },
    ]),
    searchTools: vi.fn().mockResolvedValue([
      {
        serverId: "filesystem",
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      },
    ]),
    callTool: vi.fn().mockResolvedValue({
      content: "ok",
      isError: false,
      raw: { content: [{ type: "text", text: "ok" }] },
    }),
    listResources: vi.fn().mockResolvedValue([
      {
        serverId: "filesystem",
        uri: "file:///tmp/a.txt",
        name: "a.txt",
      },
    ]),
    readResource: vi.fn().mockResolvedValue({
      content: "hello",
      raw: { contents: [{ text: "hello" }] },
    }),
    listPrompts: vi.fn().mockResolvedValue([
      {
        serverId: "filesystem",
        name: "summarize",
      },
    ]),
    getPrompt: vi.fn().mockResolvedValue({
      content: "Summarize this file.",
      raw: {
        messages: [{ role: "user", content: [{ type: "text", text: "Summarize this file." }] }],
      },
    }),
  };
}

function createPromotedMcpTool(adapter: FridayMcpAdapter) {
  return createFridayAgentMcpTool({
    mcpAdapter: adapter,
    getServerAvailability: () => ({ available: true, promotionChannel: "active" }),
  });
}

describe("createFridayAgentMcpTool", () => {
  it("lists configured MCP servers", async () => {
    const adapter = makeAdapter();
    const tool = createPromotedMcpTool(adapter);

    const result = await tool.execute({ action: "list_servers" }, new AbortController().signal);
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content) as { count: number; items: Array<{ id: string; transport: string }> };
    expect(payload.count).toBe(1);
    expect(payload.items[0]?.id).toBe("filesystem");
    expect(payload.items[0]?.transport).toBe("stdio");
  });

  it("lists MCP server discovery states", async () => {
    const adapter = makeAdapter();
    const tool = createPromotedMcpTool(adapter);

    const result = await tool.execute({ action: "list_server_states" }, new AbortController().signal);
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content) as { count: number; items: Array<{ state: string }> };
    expect(payload.count).toBe(1);
    expect(payload.items[0]?.state).toBe("deferred");
  });

  it("lists MCP tools for a server filter", async () => {
    const adapter = makeAdapter();
    const tool = createPromotedMcpTool(adapter);

    const result = await tool.execute(
      { action: "list_tools", serverId: "filesystem" },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(adapter.listTools).toHaveBeenCalledWith({
      serverId: "filesystem",
      signal: expect.any(AbortSignal),
    });
    const payload = JSON.parse(result.content) as { count: number; items: Array<{ name: string }> };
    expect(payload.count).toBe(1);
    expect(payload.items[0]?.name).toBe("read_file");
  });

  it("searches MCP tools without loading full prompt/resource results", async () => {
    const adapter = makeAdapter();
    const tool = createPromotedMcpTool(adapter);

    const result = await tool.execute(
      { action: "search_tools", serverId: "filesystem", query: "read" },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(adapter.searchTools).toHaveBeenCalledWith({
      query: "read",
      serverId: "filesystem",
      signal: expect.any(AbortSignal),
    });
  });

  it("calls an MCP tool with args", async () => {
    const adapter = makeAdapter();
    const tool = createPromotedMcpTool(adapter);

    const result = await tool.execute(
      {
        action: "call_tool",
        serverId: "filesystem",
        toolName: "read_file",
        args: { path: "/tmp/a.txt" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(adapter.callTool).toHaveBeenCalledWith({
      serverId: "filesystem",
      toolName: "read_file",
      args: { path: "/tmp/a.txt" },
      signal: expect.any(AbortSignal),
    });
  });

  it("blocks MCP tool calls for configured servers that are not lifecycle-promoted", async () => {
    const adapter = makeAdapter();
    const tool = createFridayAgentMcpTool({
      mcpAdapter: adapter,
      getServerAvailability: () => ({
        available: false,
        promotionChannel: "shadow",
        reason: "MCP server must complete lifecycle promote before agent use.",
      }),
    });

    const result = await tool.execute(
      {
        action: "call_tool",
        serverId: "filesystem",
        toolName: "read_file",
        args: { path: "/tmp/a.txt" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("MCP_SERVER_NOT_PROMOTED");
    expect(adapter.callTool).not.toHaveBeenCalled();
  });

  it("fails closed when no MCP lifecycle availability resolver is provided", async () => {
    const adapter = makeAdapter();
    const tool = createFridayAgentMcpTool({ mcpAdapter: adapter });

    const result = await tool.execute(
      {
        action: "call_tool",
        serverId: "filesystem",
        toolName: "read_file",
        args: { path: "/tmp/a.txt" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("MCP_SERVER_NOT_PROMOTED");
    expect(result.content).toContain("availability gate is unavailable");
    expect(adapter.callTool).not.toHaveBeenCalled();
  });

  it("filters discovery actions to lifecycle-promoted servers only", async () => {
    const adapter = makeAdapter();
    adapter.listServers = vi.fn().mockReturnValue([
      {
        id: "filesystem",
        transport: "stdio",
        command: "npx",
      },
      {
        id: "candidate",
        transport: "stdio",
        command: "node",
      },
    ]);
    const tool = createFridayAgentMcpTool({
      mcpAdapter: adapter,
      getServerAvailability: (serverId) => ({
        available: serverId === "filesystem",
        promotionChannel: serverId === "filesystem" ? "active" : "shadow",
      }),
    });

    const result = await tool.execute(
      { action: "list_tools" },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(adapter.listTools).toHaveBeenCalledTimes(1);
    expect(adapter.listTools).toHaveBeenCalledWith({
      serverId: "filesystem",
      signal: expect.any(AbortSignal),
    });
  });

  it("lists and reads MCP resources", async () => {
    const adapter = makeAdapter();
    const tool = createPromotedMcpTool(adapter);

    const listResult = await tool.execute(
      { action: "list_resources", serverId: "filesystem" },
      new AbortController().signal,
    );
    expect(listResult.isError).toBeUndefined();

    const readResult = await tool.execute(
      { action: "read_resource", serverId: "filesystem", uri: "file:///tmp/a.txt" },
      new AbortController().signal,
    );
    expect(readResult.isError).toBeUndefined();
    expect(adapter.readResource).toHaveBeenCalledWith({
      serverId: "filesystem",
      uri: "file:///tmp/a.txt",
      signal: expect.any(AbortSignal),
    });
  });

  it("lists and gets MCP prompts", async () => {
    const adapter = makeAdapter();
    const tool = createPromotedMcpTool(adapter);

    const listResult = await tool.execute(
      { action: "list_prompts", serverId: "filesystem" },
      new AbortController().signal,
    );
    expect(listResult.isError).toBeUndefined();

    const getResult = await tool.execute(
      {
        action: "get_prompt",
        serverId: "filesystem",
        promptName: "summarize",
        args: { style: "short" },
      },
      new AbortController().signal,
    );
    expect(getResult.isError).toBeUndefined();
    expect(adapter.getPrompt).toHaveBeenCalledWith({
      serverId: "filesystem",
      name: "summarize",
      args: { style: "short" },
      signal: expect.any(AbortSignal),
    });
  });

  it("returns validation error when args is not an object", async () => {
    const adapter = makeAdapter();
    const tool = createPromotedMcpTool(adapter);

    const result = await tool.execute(
      {
        action: "call_tool",
        serverId: "filesystem",
        toolName: "read_file",
        args: "bad",
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("args must be an object");
  });

  it("maps adapter errors into tool error metadata", async () => {
    const adapter = makeAdapter();
    const mcpError = new Error("Tool is forbidden") as Error & {
      code: string;
      routeId: string;
      correlationId: string;
    };
    mcpError.code = "MCP_POLICY_TOOL_FORBIDDEN";
    mcpError.routeId = "mcp.adapter.tools.call";
    mcpError.correlationId = "filesystem:tools.call.read_file:abc";
    adapter.callTool = vi.fn().mockRejectedValue(mcpError);

    const tool = createPromotedMcpTool(adapter);
    const result = await tool.execute(
      {
        action: "call_tool",
        serverId: "filesystem",
        toolName: "read_file",
        args: { path: "/tmp/a.txt" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("MCP_POLICY_TOOL_FORBIDDEN");
    expect(result.routeId).toBe("mcp.adapter.tools.call");
    expect(result.correlationId).toBe("filesystem:tools.call.read_file:abc");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFridayMcpAdapter,
  FRIDAY_MCP_ADAPTER_ERROR_CODES,
  isFridayMcpAdapterError,
} from "#agent";

const dnsMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  resolve6: vi.fn(),
}));

vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return {
    ...actual,
    resolve: dnsMocks.resolve,
    resolve6: dnsMocks.resolve6,
  };
});

function jsonRpcResponse(id: number, result: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function okHttpResponse(body: string) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => body,
  };
}

describe("createFridayMcpAdapter — runtime adversarial behavior", () => {
  beforeEach(() => {
    dnsMocks.resolve.mockImplementation((hostname: string, rrtypeOrCallback: unknown, maybeCallback?: unknown) => {
      const callback = typeof rrtypeOrCallback === "function" ? rrtypeOrCallback : maybeCallback;
      if (typeof callback === "function") {
        const addresses = hostname === "private.example.test" ? ["10.0.0.12"] : ["203.0.113.10"];
        (callback as (err: NodeJS.ErrnoException | null, addresses: string[]) => void)(null, addresses);
      }
      return undefined;
    });
    dnsMocks.resolve6.mockImplementation((hostname: string, rrtypeOrCallback: unknown, maybeCallback?: unknown) => {
      void hostname;
      const callback = typeof rrtypeOrCallback === "function" ? rrtypeOrCallback : maybeCallback;
      if (typeof callback === "function") {
        (callback as (err: NodeJS.ErrnoException | null, addresses: string[]) => void)(null, []);
      }
      return undefined;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("denies non-allowlisted tool calls with policy error metadata", async () => {
    const adapter = createFridayMcpAdapter({
      servers: [
        {
          id: "sandbox",
          transport: "stdio",
          command: "node",
          policy: {
            toolAllowlist: ["echo"],
          },
        },
      ],
    });

    await expect(adapter.callTool({
      serverId: "sandbox",
      toolName: "exec",
      args: { cmd: "ls" },
    })).rejects.toSatisfy((error: unknown) => {
      if (!isFridayMcpAdapterError(error)) {
        return false;
      }
      expect(error.code).toBe(FRIDAY_MCP_ADAPTER_ERROR_CODES.POLICY_TOOL_FORBIDDEN);
      expect(error.routeId).toBe("mcp.adapter.tools.call");
      expect(error.correlationId.startsWith("sandbox:tools.call.exec:")).toBe(true);
      expect(error.details).toMatchObject({
        serverId: "sandbox",
        toolName: "exec",
      });
      return true;
    });
  });

  it("tracks discovery state transitions for lazy MCP servers", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        id?: number;
        method?: string;
      };

      if (payload.method === "initialize") {
        return okHttpResponse(jsonRpcResponse(payload.id ?? 1, { protocolVersion: "2024-11-05" }));
      }
      if (payload.method === "tools/list") {
        return okHttpResponse(jsonRpcResponse(payload.id ?? 2, {
          tools: [{ name: "search", description: "Search docs", inputSchema: { type: "object" } }],
        }));
      }
      return okHttpResponse("{}");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const adapter = createFridayMcpAdapter({
      servers: [
        {
          id: "lazy-http",
          transport: "http",
          url: "https://mcp.example.com/rpc",
          // Explicit high-risk opt-in so discovered tools are exposed; without
          // it the adapter fails closed and exposes nothing.
          policy: { allowAllTools: true },
        },
      ],
    });

    expect(adapter.listServerStates()[0]?.state).toBe("deferred");
    await adapter.searchTools({ query: "search", serverId: "lazy-http" });
    expect(adapter.listServerStates()[0]?.state).toBe("loaded");
    expect(adapter.listServerStates()[0]?.toolCount).toBe(1);
  });

  it("fails closed: an external server with no allowlist and no opt-in exposes no tools", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method?: string };
      if (payload.method === "initialize") {
        return okHttpResponse(jsonRpcResponse(payload.id ?? 1, { protocolVersion: "2024-11-05" }));
      }
      if (payload.method === "tools/list") {
        return okHttpResponse(jsonRpcResponse(payload.id ?? 2, {
          tools: [{ name: "search", description: "Search docs", inputSchema: { type: "object" } }],
        }));
      }
      if (payload.method === "tools/call") {
        return okHttpResponse(jsonRpcResponse(payload.id ?? 3, {
          content: [{ type: "text", text: "ok" }],
          isError: false,
        }));
      }
      return okHttpResponse("{}");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const adapter = createFridayMcpAdapter({
      servers: [
        { id: "untrusted-http", transport: "http", url: "https://mcp.example.com/rpc" },
      ],
    });

    // Discovery still works, but NO tools are exposed without an explicit
    // allowlist or allowAllTools opt-in.
    const tools = await adapter.listTools({ serverId: "untrusted-http" });
    expect(tools).toEqual([]);

    // Calling any tool is denied with a policy error (not silently allowed).
    await expect(
      adapter.callTool({ serverId: "untrusted-http", toolName: "search", args: {} }),
    ).rejects.toMatchObject({ code: "MCP_POLICY_TOOL_FORBIDDEN" });
  });

  it("enforces local rate limit policy for repeated tool calls", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        id?: number;
        method?: string;
      };

      if (payload.method === "initialize") {
        return okHttpResponse(jsonRpcResponse(payload.id ?? 1, { protocolVersion: "2024-11-05" }));
      }
      if (payload.method === "tools/call") {
        return okHttpResponse(jsonRpcResponse(payload.id ?? 2, {
          content: [{ type: "text", text: "ok" }],
          isError: false,
        }));
      }
      return okHttpResponse("{}");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const adapter = createFridayMcpAdapter({
      servers: [
        {
          id: "remote",
          transport: "http",
          url: "https://mcp.example.com/rpc",
          policy: {
            allowAllTools: true,
            rateLimit: {
              maxCalls: 1,
              windowMs: 60_000,
            },
          },
        },
      ],
    });

    const first = await adapter.callTool({
      serverId: "remote",
      toolName: "search",
      args: { q: "friday" },
    });
    expect(first.isError).toBe(false);
    expect(first.content).toContain("ok");

    await expect(adapter.callTool({
      serverId: "remote",
      toolName: "search",
      args: { q: "friday mcp" },
    })).rejects.toSatisfy((error: unknown) => {
      if (!isFridayMcpAdapterError(error)) {
        return false;
      }
      expect(error.code).toBe(FRIDAY_MCP_ADAPTER_ERROR_CODES.POLICY_RATE_LIMITED);
      expect(error.routeId).toBe("mcp.adapter.tools.call");
      expect(error.details).toMatchObject({
        serverId: "remote",
        toolName: "search",
        maxCalls: 1,
      });
      return true;
    });
  });

  it("recovers on next request after transient HTTP transport failure", async () => {
    let initializeAttempts = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        id?: number;
        method?: string;
      };

      if (payload.method === "initialize") {
        initializeAttempts += 1;
        if (initializeAttempts === 1) {
          throw new Error("simulated network jitter");
        }
        return okHttpResponse(jsonRpcResponse(payload.id ?? 1, { protocolVersion: "2024-11-05" }));
      }

      if (payload.method === "tools/call") {
        return okHttpResponse(jsonRpcResponse(payload.id ?? 2, {
          content: [{ type: "text", text: "recovered" }],
          isError: false,
        }));
      }

      return okHttpResponse("{}");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const adapter = createFridayMcpAdapter({
      servers: [
        {
          id: "unstable-http",
          transport: "http",
          url: "https://unstable.example.com/mcp",
          // Opt in so the call reaches the transport layer (the behavior under
          // test) rather than being blocked by the fail-closed default.
          policy: { allowAllTools: true },
        },
      ],
    });

    await expect(adapter.callTool({
      serverId: "unstable-http",
      toolName: "search",
      args: { q: "first attempt" },
    })).rejects.toSatisfy((error: unknown) => {
      if (!isFridayMcpAdapterError(error)) {
        return false;
      }
      expect(error.code).toBe(FRIDAY_MCP_ADAPTER_ERROR_CODES.REQUEST_FAILED);
      expect(error.routeId).toBe("mcp.adapter.tools.call");
      expect(error.details).toMatchObject({
        serverId: "unstable-http",
        transport: "http",
      });
      return true;
    });

    const second = await adapter.callTool({
      serverId: "unstable-http",
      toolName: "search",
      args: { q: "second attempt" },
    });
    expect(second.isError).toBe(false);
    expect(second.content).toContain("recovered");
  });

  it("rejects oversized HTTP transport responses before full text buffering", async () => {
    const response = new Response("x".repeat(1024 * 1024 + 2), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const textSpy = vi.spyOn(response, "text");
    vi.stubGlobal("fetch", vi.fn(async () => response) as unknown as typeof fetch);

    const adapter = createFridayMcpAdapter({
      servers: [
        {
          id: "huge-http",
          transport: "http",
          url: "https://mcp.example.com/rpc",
        },
      ],
    });

    await expect(adapter.listTools({ serverId: "huge-http" })).rejects.toSatisfy((error: unknown) => {
      if (!isFridayMcpAdapterError(error)) {
        return false;
      }
      expect(error.code).toBe(FRIDAY_MCP_ADAPTER_ERROR_CODES.REQUEST_FAILED);
      expect(error.message).toContain("exceeded maximum size");
      return true;
    });
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("blocks HTTP transport SSRF targets before fetch", async () => {
    const fetchMock = vi.fn(async () => okHttpResponse("{}"));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const adapter = createFridayMcpAdapter({
      servers: [
        {
          id: "metadata-http",
          transport: "http",
          url: "http://169.254.169.254/latest/meta-data",
        },
      ],
    });

    await expect(adapter.listTools({ serverId: "metadata-http" })).rejects.toSatisfy((error: unknown) => {
      if (!isFridayMcpAdapterError(error)) {
        return false;
      }
      expect(error.code).toBe(FRIDAY_MCP_ADAPTER_ERROR_CODES.REQUEST_FAILED);
      expect(error.message).toContain("SSRF");
      expect(error.details).toMatchObject({
        serverId: "metadata-http",
        transport: "http",
      });
      return true;
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks HTTP transport hostnames that resolve to private addresses before fetch", async () => {
    const fetchMock = vi.fn(async () => okHttpResponse("{}"));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const adapter = createFridayMcpAdapter({
      servers: [
        {
          id: "dns-private-http",
          transport: "http",
          url: "https://private.example.test/rpc",
        },
      ],
    });

    await expect(adapter.listTools({ serverId: "dns-private-http" })).rejects.toSatisfy((error: unknown) => {
      if (!isFridayMcpAdapterError(error)) {
        return false;
      }
      expect(error.code).toBe(FRIDAY_MCP_ADAPTER_ERROR_CODES.REQUEST_FAILED);
      expect(error.message).toContain("DNS resolved to private IP");
      expect(error.details).toMatchObject({
        serverId: "dns-private-http",
        transport: "http",
      });
      return true;
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks HTTP transport redirects to private addresses before following them", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const adapter = createFridayMcpAdapter({
      servers: [
        {
          id: "redirect-private-http",
          transport: "http",
          url: "https://mcp.example.com/rpc",
        },
      ],
    });

    await expect(adapter.listTools({ serverId: "redirect-private-http" })).rejects.toSatisfy((error: unknown) => {
      if (!isFridayMcpAdapterError(error)) {
        return false;
      }
      expect(error.code).toBe(FRIDAY_MCP_ADAPTER_ERROR_CODES.REQUEST_FAILED);
      expect(error.message).toContain("SSRF");
      expect(error.details).toMatchObject({
        serverId: "redirect-private-http",
        transport: "http",
      });
      return true;
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("deduplicates repeated read-only resource reads", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        id?: number;
        method?: string;
      };

      if (payload.method === "initialize") {
        return okHttpResponse(jsonRpcResponse(payload.id ?? 1, { protocolVersion: "2024-11-05" }));
      }
      if (payload.method === "resources/read") {
        return okHttpResponse(jsonRpcResponse(payload.id ?? 2, {
          contents: [{ type: "text", text: "same-content" }],
        }));
      }
      return okHttpResponse("{}");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const adapter = createFridayMcpAdapter({
      servers: [
        {
          id: "dedup-http",
          transport: "http",
          url: "https://mcp.example.com/rpc",
        },
      ],
    });

    const first = await adapter.readResource({
      serverId: "dedup-http",
      uri: "file://docs/readme.md",
    });
    const second = await adapter.readResource({
      serverId: "dedup-http",
      uri: "file://docs/readme.md",
    });

    expect(first.content).toContain("same-content");
    expect(second.content).toContain("same-content");
    const methods = fetchMock.mock.calls.map(([, init]) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      return payload.method ?? "unknown";
    });
    expect(methods.filter((method) => method === "resources/read")).toHaveLength(1);
  });
});

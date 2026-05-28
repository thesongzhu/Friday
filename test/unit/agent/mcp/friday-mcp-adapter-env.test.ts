import { describe, it, expect, vi } from "vitest";

import { parseFridayMcpServersFromEnv } from "#agent";

describe("parseFridayMcpServersFromEnv", () => {
  it("returns empty when FRIDAY_MCP_SERVERS is missing", () => {
    const result = parseFridayMcpServersFromEnv({});
    expect(result).toEqual([]);
  });

  it("parses stdio server entries with default transport", () => {
    const result = parseFridayMcpServersFromEnv({
      FRIDAY_MCP_SERVERS: JSON.stringify([
        {
          id: "filesystem",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          cwd: "/home/user",
          timeoutMs: 12345,
          env: {
            NODE_ENV: "production",
            FRIDAY_TEST_TOKEN: "x",
          },
        },
      ]),
    });

    expect(result).toEqual([
      {
        id: "filesystem",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        cwd: "/home/user",
        timeoutMs: 12345,
        env: {
          NODE_ENV: "production",
          FRIDAY_TEST_TOKEN: "x",
        },
      },
    ]);
  });

  it("parses http server entries with policy fields", () => {
    const result = parseFridayMcpServersFromEnv({
      FRIDAY_MCP_SERVERS: JSON.stringify([
        {
          id: "remote-catalog",
          transport: "http",
          url: "https://mcp.example.com/rpc",
          headers: {
            Authorization: "Bearer token",
          },
          policy: {
            toolAllowlist: ["search", "fetch"],
            rateLimit: {
              maxCalls: 3,
              windowMs: 1000,
            },
          },
        },
      ]),
    });

    expect(result).toEqual([
      {
        id: "remote-catalog",
        transport: "http",
        url: "https://mcp.example.com/rpc",
        headers: {
          Authorization: "Bearer token",
        },
        policy: {
          toolAllowlist: ["search", "fetch"],
          rateLimit: {
            maxCalls: 3,
            windowMs: 1000,
          },
        },
      },
    ]);
  });

  it("warns and returns empty for invalid JSON", () => {
    const warn = vi.fn();
    const result = parseFridayMcpServersFromEnv(
      { FRIDAY_MCP_SERVERS: "{bad json" },
      warn,
    );
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("skips invalid entries but keeps valid ones", () => {
    const warn = vi.fn();
    const result = parseFridayMcpServersFromEnv(
      {
        FRIDAY_MCP_SERVERS: JSON.stringify([
          { id: "", command: "npx" },
          { id: "ok", command: "node", args: [1, "a"] },
        ]),
      },
      warn,
    );

    expect(result).toEqual([
      {
        id: "ok",
        transport: "stdio",
        command: "node",
        args: ["a"],
      },
    ]);
    expect(warn).toHaveBeenCalled();
  });

  it("fails closed: drops entries with an unsupported transport instead of stdio fallback", () => {
    const warn = vi.fn();
    const result = parseFridayMcpServersFromEnv(
      {
        FRIDAY_MCP_SERVERS: JSON.stringify([
          { id: "bad-sse", transport: "sse", command: "node" },
          { id: "ok-stdio", command: "node" },
        ]),
      },
      warn,
    );

    // The unsupported-transport entry is rejected, NOT silently run as stdio.
    expect(result.map((s) => s.id)).toEqual(["ok-stdio"]);
    expect(result.some((s) => s.id === "bad-sse")).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("parses an explicit high-risk allowAllTools opt-in", () => {
    const result = parseFridayMcpServersFromEnv({
      FRIDAY_MCP_SERVERS: JSON.stringify([
        { id: "trusted", command: "node", policy: { allowAllTools: true } },
      ]),
    });

    expect(result).toEqual([
      {
        id: "trusted",
        transport: "stdio",
        command: "node",
        policy: { allowAllTools: true },
      },
    ]);
  });

  it("accepts legacy top-level allowTools/rateLimit policy fields", () => {
    const result = parseFridayMcpServersFromEnv({
      FRIDAY_MCP_SERVERS: JSON.stringify([
        {
          id: "legacy",
          command: "node",
          allowTools: ["search"],
          rateLimit: {
            maxCalls: 2,
            windowMs: 500,
          },
        },
      ]),
    });

    expect(result).toEqual([
      {
        id: "legacy",
        transport: "stdio",
        command: "node",
        policy: {
          toolAllowlist: ["search"],
          rateLimit: {
            maxCalls: 2,
            windowMs: 500,
          },
        },
      },
    ]);
  });
});

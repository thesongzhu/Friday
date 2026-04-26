import { describe, expect, it } from "vitest";

import {
  evaluateFridaySkillMcpReadiness,
  listFridayMcpServerReadiness,
} from "../../../../src/agent/mcp/friday-mcp-readiness.js";

describe("friday MCP readiness", () => {
  it("does not mark configured servers connected until discovery loads them", () => {
    const readiness = listFridayMcpServerReadiness({
      servers: [{ id: "filesystem", command: "npx" }],
      serverStates: [{
        serverId: "filesystem",
        transport: "stdio",
        state: "configured",
        lazyDiscovery: true,
      }],
    });

    expect(readiness[0]).toEqual(expect.objectContaining({
      name: "filesystem",
      connected: false,
      authenticated: true,
      state: "configured",
    }));
  });

  it("treats loaded MCP servers as verified for skill requirements", () => {
    const readiness = listFridayMcpServerReadiness({
      servers: [{ id: "filesystem", command: "npx" }],
      serverStates: [{
        serverId: "filesystem",
        transport: "stdio",
        state: "loaded",
        lazyDiscovery: false,
      }],
    });

    expect(readiness[0]?.connected).toBe(true);
    expect(evaluateFridaySkillMcpReadiness({
      manifest: {
        requirements: {
          bins: [],
          env: [],
          config: [],
          os: [],
          mcpServers: [{ name: "filesystem", auth: "connected" }],
        },
      },
      servers: readiness,
    }).ready).toBe(true);
  });

  it("reports configured but undiscovered MCP servers as blockers", () => {
    const result = evaluateFridaySkillMcpReadiness({
      manifest: {
        requirements: {
          bins: [],
          env: [],
          config: [],
          os: [],
          mcpServers: [{ name: "filesystem", auth: "connected" }],
        },
      },
      servers: [{
        name: "filesystem",
        connected: false,
        authenticated: true,
        state: "deferred",
      }],
    });

    expect(result.ready).toBe(false);
    expect(result.blockers[0]).toContain("has not passed MCP discovery");
  });
});

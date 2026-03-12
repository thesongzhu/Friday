import { describe, it, expect, vi } from "vitest";
import { createFridayAgentNodesTool } from "#agent";
import type {
  FridayNodesService,
  FridayNodeInfo,
  FridayNodeControlResult,
} from "../../../../src/nodes/friday-nodes-service.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function makeNode(overrides?: Partial<FridayNodeInfo>): FridayNodeInfo {
  return {
    nodeId: "node-1",
    name: "Living Room Hub",
    kind: "smart-hub",
    status: "online",
    lastSeen: "2026-01-15T12:00:00Z",
    ...overrides,
  };
}

function mockNodesService(
  nodes?: FridayNodeInfo[],
  controlResult?: FridayNodeControlResult,
): FridayNodesService {
  const nodeList = nodes ?? [makeNode()];
  return {
    discover: vi.fn().mockResolvedValue(nodeList),
    get: vi.fn().mockImplementation(async (nodeId: string) => {
      return nodeList.find((n) => n.nodeId === nodeId) ?? null;
    }),
    control: vi.fn().mockResolvedValue(
      controlResult ?? {
        nodeId: "node-1",
        command: "toggle",
        success: true,
        response: { state: "on" },
        durationMs: 42,
      },
    ),
  };
}

describe("FridayAgentNodesTool", () => {
  // ─── Definition ───

  it("has correct name and parameters", () => {
    const tool = createFridayAgentNodesTool({ nodesService: mockNodesService() });
    expect(tool.name).toBe("nodes");
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toBeDefined();
    expect(tool.parameters.required).toContain("action");
  });

  // ─── Discover action ───

  it("discovers all nodes", async () => {
    const svc = mockNodesService([makeNode(), makeNode({ nodeId: "node-2", name: "Kitchen" })]);
    const tool = createFridayAgentNodesTool({ nodesService: svc });

    const result = await tool.execute({ action: "discover" }, signal());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { count: number; nodes: unknown[] };
    expect(parsed.count).toBe(2);
    expect(parsed.nodes).toHaveLength(2);
  });

  // ─── Get action ───

  it("gets a specific node", async () => {
    const svc = mockNodesService();
    const tool = createFridayAgentNodesTool({ nodesService: svc });

    const result = await tool.execute(
      { action: "get", nodeId: "node-1" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.nodeId).toBe("node-1");
    expect(parsed.name).toBe("Living Room Hub");
  });

  it("returns error for unknown node", async () => {
    const svc = mockNodesService();
    const tool = createFridayAgentNodesTool({ nodesService: svc });

    const result = await tool.execute(
      { action: "get", nodeId: "non-existent" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  // ─── Control action ───

  it("sends a control command", async () => {
    const svc = mockNodesService();
    const tool = createFridayAgentNodesTool({ nodesService: svc });

    const result = await tool.execute(
      { action: "control", nodeId: "node-1", command: "toggle", args: { brightness: 80 } },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.success).toBe(true);
    expect(parsed.command).toBe("toggle");
  });

  it("returns error for failed control", async () => {
    const svc = mockNodesService(undefined, {
      nodeId: "node-1",
      command: "bad-cmd",
      success: false,
      error: "Unknown command",
    });
    const tool = createFridayAgentNodesTool({ nodesService: svc });

    const result = await tool.execute(
      { action: "control", nodeId: "node-1", command: "bad-cmd" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown command");
  });

  // ─── Parameter validation ───

  it("returns error for invalid action", async () => {
    const tool = createFridayAgentNodesTool({ nodesService: mockNodesService() });

    const result = await tool.execute({ action: "delete" }, signal());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid action");
  });

  it("returns error on missing nodeId for get", async () => {
    const tool = createFridayAgentNodesTool({ nodesService: mockNodesService() });

    const result = await tool.execute({ action: "get" }, signal());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("nodeId is required");
  });

  it("returns error on missing command for control", async () => {
    const tool = createFridayAgentNodesTool({ nodesService: mockNodesService() });

    const result = await tool.execute(
      { action: "control", nodeId: "node-1" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("command is required");
  });

  // ─── Error handling ───

  it("returns error when service throws", async () => {
    const svc: FridayNodesService = {
      discover: vi.fn().mockRejectedValue(new Error("Network timeout")),
      get: vi.fn(),
      control: vi.fn(),
    };
    const tool = createFridayAgentNodesTool({ nodesService: svc });

    const result = await tool.execute({ action: "discover" }, signal());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Network timeout");
  });
});

import { describe, it, expect, vi } from "vitest";
import { createFridayAgentAgentsListTool } from "#agent";
import type { FridaySubagentRegistry, FridaySubagentRunRecord } from "#agent";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function makeRecord(overrides?: Partial<FridaySubagentRunRecord>): FridaySubagentRunRecord {
  return {
    id: "sub-1",
    task: "Analyze logs and report",
    label: "log-analyzer",
    model: "claude-sonnet-4-20250514",
    status: "completed",
    depth: 1,
    parentRunId: "parent-run-1",
    parentSessionKey: "agent:main",
    childRunId: "child-run-1",
    childSessionKey: "agent:sub:sub-1",
    mode: "fresh",
    durationMs: 5000,
    outcome: {
      status: "completed",
      response: "Analysis complete. Found 3 errors.",
      toolCallCount: 4,
      durationMs: 5000,
      usageInput: 1000,
      usageOutput: 500,
    },
    createdAt: "2026-01-15T12:00:00Z",
    startedAt: "2026-01-15T12:00:01Z",
    completedAt: "2026-01-15T12:00:06Z",
    ...overrides,
  };
}

function mockSubagentRegistry(
  records?: FridaySubagentRunRecord[],
): FridaySubagentRegistry {
  return {
    list: vi.fn().mockReturnValue(records ?? [makeRecord()]),
    spawn: vi.fn(),
    get: vi.fn(),
    cancel: vi.fn(),
    resumeOnBoot: vi.fn().mockReturnValue(0),
  } as unknown as FridaySubagentRegistry;
}

describe("FridayAgentAgentsListTool", () => {
  // ─── Definition ───

  it("has correct name and parameters", () => {
    const tool = createFridayAgentAgentsListTool({
      subagentRegistry: mockSubagentRegistry(),
    });
    expect(tool.name).toBe("agents_list");
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toBeDefined();
  });

  // ─── List all agents (compact) ───

  it("lists agents in compact mode by default", async () => {
    const registry = mockSubagentRegistry([
      makeRecord({ id: "sub-1", createdAt: "2026-01-15T12:00:00Z" }),
      makeRecord({ id: "sub-2", createdAt: "2026-01-15T13:00:00Z" }),
    ]);
    const tool = createFridayAgentAgentsListTool({ subagentRegistry: registry });

    const result = await tool.execute({}, signal());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { count: number; agents: Array<Record<string, unknown>> };
    expect(parsed.count).toBe(2);
    // Sorted newest first
    expect(parsed.agents[0].id).toBe("sub-2");
    expect(parsed.agents[1].id).toBe("sub-1");
    // Compact: no outcome field
    expect(parsed.agents[0]).not.toHaveProperty("outcome");
    expect(parsed.agents[0]).toHaveProperty("mode", "fresh");
  });

  // ─── List with metadata ───

  it("includes metadata when includeMeta is true", async () => {
    const registry = mockSubagentRegistry();
    const tool = createFridayAgentAgentsListTool({ subagentRegistry: registry });

    const result = await tool.execute({ includeMeta: true }, signal());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { count: number; agents: Array<Record<string, unknown>> };
    expect(parsed.agents[0]).toHaveProperty("outcome");
    expect(parsed.agents[0]).toHaveProperty("durationMs");
    expect(parsed.agents[0]).toHaveProperty("parentRunId");
    expect(parsed.agents[0]).toHaveProperty("mode", "fresh");
  });

  // ─── Filter by query ───

  it("filters agents by query", async () => {
    const registry = mockSubagentRegistry([
      makeRecord({ id: "sub-1", task: "Analyze logs" }),
      makeRecord({ id: "sub-2", task: "Generate report" }),
    ]);
    const tool = createFridayAgentAgentsListTool({ subagentRegistry: registry });

    const result = await tool.execute({ query: "report" }, signal());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { count: number; agents: Array<Record<string, unknown>> };
    expect(parsed.count).toBe(1);
    expect(parsed.agents[0].id).toBe("sub-2");
  });

  it("returns empty for non-matching query", async () => {
    const registry = mockSubagentRegistry();
    const tool = createFridayAgentAgentsListTool({ subagentRegistry: registry });

    const result = await tool.execute({ query: "nonexistent-xyz" }, signal());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { count: number };
    expect(parsed.count).toBe(0);
  });

  // ─── Empty list ───

  it("handles empty agent list", async () => {
    const registry = mockSubagentRegistry([]);
    const tool = createFridayAgentAgentsListTool({ subagentRegistry: registry });

    const result = await tool.execute({}, signal());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { count: number };
    expect(parsed.count).toBe(0);
  });

  // ─── Error handling ───

  it("returns error when registry throws", async () => {
    const registry = {
      list: vi.fn().mockImplementation(() => { throw new Error("DB connection lost"); }),
      spawn: vi.fn(),
      get: vi.fn(),
      cancel: vi.fn(),
      resumeOnBoot: vi.fn(),
    } as unknown as FridaySubagentRegistry;
    const tool = createFridayAgentAgentsListTool({ subagentRegistry: registry });

    const result = await tool.execute({}, signal());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("DB connection lost");
  });
});

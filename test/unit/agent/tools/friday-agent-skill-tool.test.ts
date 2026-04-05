import { describe, it, expect, vi } from "vitest";
import { createFridayAgentSkillTool } from "#agent";
import type { FridaySkillExecutor, FridaySkillExecuteResult, FridaySkillRegistry } from "#skills";
import { makeManifest } from "../../skills/_helpers/make-manifest.helper.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function makeResult(
  overrides?: Partial<FridaySkillExecuteResult>,
): FridaySkillExecuteResult {
  return {
    runId: "run-1",
    status: "completed",
    output: { greeting: "hello" },
    stdout: "",
    stderr: "",
    durationMs: 42,
    ...overrides,
  };
}

function mockExecutor(
  result: FridaySkillExecuteResult,
): FridaySkillExecutor {
  return {
    execute: vi.fn().mockReturnValue({
      runId: result.runId,
      result: Promise.resolve(result),
    }),
    cancel: vi.fn(),
  };
}

function mockRegistry(overrides?: { requirements?: ReturnType<typeof makeManifest>["requirements"] }): FridaySkillRegistry {
  const manifest = makeManifest({
    id: "secure-skill",
    requirements: overrides?.requirements,
  });

  return {
    list: vi.fn(() => []),
    get: vi.fn((skillId: string) => {
      if (skillId !== manifest.id) {
        return null;
      }
      return {
        manifest,
        skillDir: "/tmp/secure-skill",
        source: "bundled",
        origin: "bundled",
        status: "installed",
        loaded: {
          skillDir: "/tmp/secure-skill",
          manifest,
          loadMode: "manifest-v2",
          declaredFiles: [],
        },
        validation: {
          ok: true,
          issues: [],
        },
        trust: {
          trustTier: "bundled",
          executionMode: "trusted",
          sandboxPolicy: {
            trustTier: "bundled",
            defaultExecutionMode: "trusted",
            allowedExecutionModes: ["trusted", "restricted"],
          },
        },
      };
    }),
    resolveByIntent: vi.fn(() => null),
    validateAll: vi.fn(() => []),
    reload: vi.fn(),
    refresh: vi.fn(),
    isCompatible: vi.fn(() => ({ compatible: true, reasons: [] })),
    startWatching: vi.fn(),
    stopWatching: vi.fn(),
    close: vi.fn(),
  } as unknown as FridaySkillRegistry;
}

describe("FridayAgentSkillTool", () => {
  // ─── Tool definition ───

  it("has correct name and parameters", () => {
    const executor = mockExecutor(makeResult());
    const tool = createFridayAgentSkillTool({ skillExecutor: executor });

    expect(tool.name).toBe("skill_run");
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toBeDefined();
  });

  // ─── Successful execution ───

  it("returns skill output on success", async () => {
    const executor = mockExecutor(makeResult());
    const tool = createFridayAgentSkillTool({ skillExecutor: executor });

    const result = await tool.execute(
      { skillId: "weather", input: { city: "Seattle" } },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      runId: "run-1",
      status: "completed",
      output: { greeting: "hello" },
      durationMs: 42,
    });
  });

  // ─── Passes correct request to executor ───

  it("passes correct parameters to executor", async () => {
    const executor = mockExecutor(makeResult());
    const tool = createFridayAgentSkillTool({ skillExecutor: executor });

    await tool.execute(
      { skillId: "my-skill", input: { key: "value" }, timeoutMs: 5000 },
      signal(),
    );

    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: "my-skill",
        input: { key: "value" },
        timeoutMs: 5000,
        sessionId: "agent",
        userId: "agent",
        channel: "agent",
      }),
    );
  });

  // ─── Failed skill ───

  it("returns error when skill fails", async () => {
    const executor = mockExecutor(
      makeResult({ status: "failed", stderr: "skill not found" }),
    );
    const tool = createFridayAgentSkillTool({ skillExecutor: executor });

    const result = await tool.execute(
      { skillId: "bad-skill", input: {} },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("bad-skill");
    expect(result.content).toContain("failed");
  });

  // ─── Timeout skill ───

  it("returns error when skill times out", async () => {
    const executor = mockExecutor(
      makeResult({ status: "timeout", stderr: "" }),
    );
    const tool = createFridayAgentSkillTool({ skillExecutor: executor });

    const result = await tool.execute(
      { skillId: "slow-skill", input: {} },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("timeout");
  });

  // ─── Cancelled skill ───

  it("returns error when skill is cancelled", async () => {
    const executor = mockExecutor(
      makeResult({ status: "cancelled", stderr: "" }),
    );
    const tool = createFridayAgentSkillTool({ skillExecutor: executor });

    const result = await tool.execute(
      { skillId: "cancelled-skill", input: {} },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("cancelled");
  });

  it("returns structured blockers instead of executing when required MCP auth is missing", async () => {
    const executor = mockExecutor(makeResult());
    const tool = createFridayAgentSkillTool({
      skillExecutor: executor,
      skillRegistry: mockRegistry({
        requirements: {
          bins: [],
          env: [],
          config: [],
          os: ["darwin", "linux", "win32"],
          mcpServers: [{ name: "github", auth: "authenticated" }],
        },
      }),
      listMcpServerReadiness: () => [
        { name: "github", connected: true, authenticated: false },
      ],
    });

    const result = await tool.execute(
      { skillId: "secure-skill", input: {} },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(JSON.parse(result.content)).toEqual({
      skillId: "secure-skill",
      status: "blocked",
      ready: false,
      blockers: ['Required MCP server "github" is not authenticated.'],
      requirements: {
        mcpServers: [{ name: "github", auth: "authenticated" }],
      },
    });
  });

  // ─── Missing required param ───

  it("throws on missing skillId", async () => {
    const executor = mockExecutor(makeResult());
    const tool = createFridayAgentSkillTool({ skillExecutor: executor });

    await expect(
      tool.execute({ skillId: "", input: {} }, signal()),
    ).rejects.toThrow("skillId is required");
  });

  // ─── Handles non-object input gracefully ───

  it("defaults to empty object for non-object input", async () => {
    const executor = mockExecutor(makeResult());
    const tool = createFridayAgentSkillTool({ skillExecutor: executor });

    await tool.execute(
      { skillId: "test", input: "not-an-object" },
      signal(),
    );

    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ input: {} }),
    );
  });

  // ─── Abort signal cancels skill ───

  it("cancels skill execution on abort", async () => {
    const controller = new AbortController();
    const executor: FridaySkillExecutor = {
      execute: vi.fn().mockReturnValue({
        runId: "run-abort",
        result: new Promise<FridaySkillExecuteResult>(() => {
          // never resolves — simulates long-running skill
        }),
      }),
      cancel: vi.fn(),
    };

    const tool = createFridayAgentSkillTool({ skillExecutor: executor });

    const promise = tool.execute(
      { skillId: "long-skill", input: {} },
      controller.signal,
    );

    // Abort after a short delay
    controller.abort();

    await expect(promise).rejects.toThrow("aborted");
    expect(executor.cancel).toHaveBeenCalledWith("run-abort");
  });
});

import { describe, it, expect, vi } from "vitest";
import { createFridayAgentSubagentTools, FRIDAY_SUBAGENT_ERROR_CODES } from "#agent";
import type {
  FridayAgentConversationContext,
  FridaySubagentRegistry,
  FridaySubagentContext,
  FridaySubagentOutcome,
  FridaySubagentRunRecord,
  FridaySubagentDetachedResult,
} from "#agent";
import { buildFridaySubagentSessionKey } from "#sessions";
import { attachFridayAgentToolExecutionContext } from "../../../../src/agent/runtime/friday-agent-tool-execution-context.js";
import { FridayDomainError } from "#errors";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function signalWithContext(
  overrides?: Partial<{
    runId: string;
    sessionKey: string;
    readOnly: boolean;
    timezone: string;
    taskPrompt: string;
    conversationContext: FridayAgentConversationContext;
    principalId: string;
    tenantContext: {
      hubId: string;
      userId?: string;
      channelKind?: string;
    };
  }>,
): AbortSignal {
  const controller = new AbortController();
  return attachFridayAgentToolExecutionContext(controller.signal, {
    runId: overrides?.runId ?? "live-run-1",
    sessionKey: overrides?.sessionKey ?? "agent:run:live-run-1",
    readOnly: overrides?.readOnly ?? false,
    timezone: overrides?.timezone,
    taskPrompt: overrides?.taskPrompt,
    conversationContext: overrides?.conversationContext,
    principalId: overrides?.principalId,
    tenantContext: overrides?.tenantContext,
  });
}

function makeContext(overrides?: Partial<FridaySubagentContext>): FridaySubagentContext {
  return {
    depth: 0,
    parentRunId: "parent-run-1",
    parentSessionKey: "agent:run:parent-run-1",
    rootRunId: "parent-run-1",
    ...overrides,
  };
}

function makeOutcome(overrides?: Partial<FridaySubagentOutcome>): FridaySubagentOutcome {
  return {
    status: "completed",
    response: "Task completed successfully",
    toolCallCount: 2,
    durationMs: 1000,
    usageInput: 100,
    usageOutput: 50,
    ...overrides,
  };
}

function makeRecord(overrides?: Partial<FridaySubagentRunRecord>): FridaySubagentRunRecord {
  return {
    id: "sub-1",
    parentRunId: "parent-run-1",
    parentSessionKey: "agent:run:parent-run-1",
    childRunId: "child-run-1",
    childSessionKey: buildFridaySubagentSessionKey("agent:run:parent-run-1", "child-run-1"),
    task: "Test task",
    depth: 1,
    status: "completed",
    outcome: makeOutcome(),
    createdAt: "2026-02-19T10:00:00.000Z",
    durationMs: 1000,
    ...overrides,
  };
}

function makeDetachedResult(overrides?: Partial<FridaySubagentDetachedResult>): FridaySubagentDetachedResult {
  return {
    subagentId: "sub-detached-1",
    childRunId: "child-run-detached-1",
    childSessionKey: buildFridaySubagentSessionKey("agent:run:parent-run-1", "child-run-detached-1"),
    status: "accepted",
    statusSnapshot: "pending",
    detached: true,
    awaited: false,
    ...overrides,
  };
}

function mockRegistry(overrides?: Partial<FridaySubagentRegistry>): FridaySubagentRegistry {
  return {
    spawn: vi.fn().mockResolvedValue(makeOutcome()),
    spawnDetached: vi.fn().mockReturnValue(makeDetachedResult()),
    drain: vi.fn().mockResolvedValue(undefined),
    startRun: vi.fn().mockResolvedValue(makeOutcome()),
    waitForCompletion: vi.fn().mockResolvedValue(makeOutcome()),
    finalize: vi.fn(),
    cleanup: vi.fn().mockReturnValue(0),
    resumeOnBoot: vi.fn().mockReturnValue(0),
    listByParentRunId: vi.fn().mockReturnValue([]),
    getById: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
    activeCountForParent: vi.fn().mockReturnValue(0),
    ...overrides,
  };
}

describe("FridayAgentSubagentTools", () => {
  // ─── spawn_subagent (detached default) ───

  describe("spawn_subagent", () => {
    it("returns accepted (detached) result by default", async () => {
      const registry = mockRegistry();
      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext(),
      });

      const spawnTool = tools.find((t) => t.name === "spawn_subagent");
      expect(spawnTool).toBeDefined();

      const result = await spawnTool!.execute({ task: "Do something" }, signal());

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      expect(parsed.status).toBe("accepted");
      expect(parsed.detached).toBe(true);
      expect(parsed.awaited).toBe(false);
      expect(parsed.statusSnapshot).toBe("pending");
      expect(parsed.subagentId).toBe("sub-detached-1");
      expect(parsed.childRunId).toBe("child-run-detached-1");
      expect(parsed.childSessionKey).toBeTruthy();
      expect(registry.spawnDetached).toHaveBeenCalled();
      expect(registry.spawn).not.toHaveBeenCalled();
    });

    it("returns a completed snapshot when the detached child is already done", async () => {
      const completedRecord = makeRecord({
        id: "sub-detached-1",
        childRunId: "child-run-detached-1",
        status: "completed",
        outcome: makeOutcome({ response: "CHILD_OK" }),
      });
      const registry = mockRegistry({
        spawnDetached: vi.fn().mockReturnValue(makeDetachedResult()),
        getById: vi.fn().mockReturnValue(completedRecord),
      });

      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext(),
      });

      const spawnTool = tools.find((t) => t.name === "spawn_subagent")!;
      const result = await spawnTool.execute({ task: "Reply CHILD_OK" }, signal());

      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      expect(parsed.status).toBe("accepted");
      expect(parsed.statusSnapshot).toBe("completed");
      expect(parsed.outcome).toMatchObject({ response: "CHILD_OK" });
      expect(String(parsed.message)).toContain("completion snapshot");
    });

    it("passes through built-in profile selection", async () => {
      const registry = mockRegistry();
      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext(),
      });

      const spawnTool = tools.find((t) => t.name === "spawn_subagent")!;
      const result = await spawnTool.execute(
        { task: "Review the diff for regressions", profile: "review" },
        signal(),
      );

      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      expect(parsed.profile).toBe("review");
      expect(registry.spawnDetached).toHaveBeenCalledWith(expect.objectContaining({
        profile: "review",
      }));
    });

    it("passes principal and tenant context into the spawned subagent input", async () => {
      const registry = mockRegistry();
      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext(),
      });

      const spawnTool = tools.find((t) => t.name === "spawn_subagent")!;
      await spawnTool.execute(
        { task: "Investigate tenant scoped provider issue" },
        signalWithContext({
          principalId: "user-ctx-1",
          tenantContext: {
            hubId: "tenant-a",
            userId: "user-ctx-1",
            channelKind: "agent",
          },
        }),
      );

      expect(registry.spawnDetached).toHaveBeenCalledWith(expect.objectContaining({
        principalId: "user-ctx-1",
        tenantContext: {
          hubId: "tenant-a",
          userId: "user-ctx-1",
          channelKind: "agent",
        },
      }));
    });

    it("returns completed result when wait=true (blocking)", async () => {
      const registry = mockRegistry();
      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext(),
      });

      const spawnTool = tools.find((t) => t.name === "spawn_subagent")!;
      const result = await spawnTool.execute({ task: "Do something", wait: true }, signal());

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      expect(parsed.status).toBe("completed");
      expect(parsed.response).toBe("Task completed successfully");
      expect(registry.spawn).toHaveBeenCalled();
      expect(registry.spawnDetached).not.toHaveBeenCalled();
    });

    it("returns error for failed sub-agent (blocking mode)", async () => {
      const registry = mockRegistry({
        spawn: vi.fn().mockResolvedValue(
          makeOutcome({ status: "failed", response: "Something broke" }),
        ),
      });

      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext(),
      });

      const spawnTool = tools.find((t) => t.name === "spawn_subagent")!;
      const result = await spawnTool.execute({ task: "Fail please", wait: true }, signal());

      expect(result.isError).toBe(true);
      expect(result.content).toContain("failed");
      expect(result.content).toContain("Something broke");
    });

    it("handles depth exceeded error", async () => {
      const registry = mockRegistry({
        spawnDetached: vi.fn().mockImplementation(() => {
          throw new FridayDomainError(
            FRIDAY_SUBAGENT_ERROR_CODES.MAX_DEPTH_EXCEEDED,
            "Sub-agent max depth (3) exceeded at depth 3",
            { httpStatus: 400 },
          );
        }),
      });

      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext(),
      });

      const spawnTool = tools.find((t) => t.name === "spawn_subagent")!;
      const result = await spawnTool.execute({ task: "Too deep" }, signal());

      expect(result.isError).toBe(true);
      expect(result.content).toContain("max depth");
    });

    it("handles concurrency exceeded error", async () => {
      const registry = mockRegistry({
        spawnDetached: vi.fn().mockImplementation(() => {
          throw new FridayDomainError(
            FRIDAY_SUBAGENT_ERROR_CODES.MAX_CONCURRENT_EXCEEDED,
            "Max concurrent sub-agents (5) for parent run parent-run-1",
            { httpStatus: 429 },
          );
        }),
      });

      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext(),
      });

      const spawnTool = tools.find((t) => t.name === "spawn_subagent")!;
      const result = await spawnTool.execute({ task: "Too many" }, signal());

      expect(result.isError).toBe(true);
      expect(result.content).toContain("concurrent");
    });

    it("requires task param", async () => {
      const registry = mockRegistry();
      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext(),
      });

      const spawnTool = tools.find((t) => t.name === "spawn_subagent")!;

      await expect(
        spawnTool.execute({}, signal()),
      ).rejects.toThrow("task is required");
    });

    it("passes optional params", async () => {
      const spawnDetachedFn = vi.fn().mockReturnValue(makeDetachedResult());
      const registry = mockRegistry({ spawnDetached: spawnDetachedFn });

      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext(),
      });

      const spawnTool = tools.find((t) => t.name === "spawn_subagent")!;
      await spawnTool.execute(
        {
          task: "Research API",
          label: "API Research",
          model: "gpt-4o",
          timeoutMs: 60000,
        },
        signal(),
      );

      expect(spawnDetachedFn).toHaveBeenCalledWith(
        expect.objectContaining({
          task: "Research API",
          label: "API Research",
          model: "gpt-4o",
          timeoutMs: 60000,
        }),
      );
    });

    it("uses the current run context from the execution signal and inherits readOnly", async () => {
      const spawnDetachedFn = vi.fn().mockReturnValue(makeDetachedResult());
      const registry = mockRegistry({ spawnDetached: spawnDetachedFn });

      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext({
          parentRunId: "stale-run",
          parentSessionKey: "agent:run:stale-run",
          rootRunId: "stale-run",
        }),
      });

      const spawnTool = tools.find((t) => t.name === "spawn_subagent")!;
      await spawnTool.execute({ task: "Inspect runtime" }, signalWithContext({ readOnly: true }));

      expect(spawnDetachedFn).toHaveBeenCalledWith(
        expect.objectContaining({
          parentRunId: "live-run-1",
          parentSessionKey: "agent:run:live-run-1",
          rootRunId: "live-run-1",
          constraints: { readOnly: true },
        }),
      );
    });

    it("inherits timezone from the current run context", async () => {
      const spawnDetachedFn = vi.fn().mockReturnValue(makeDetachedResult());
      const registry = mockRegistry({ spawnDetached: spawnDetachedFn });

      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext({ timezone: "UTC" }),
      });

      const spawnTool = tools.find((t) => t.name === "spawn_subagent")!;
      await spawnTool.execute(
        { task: "Inspect latest headlines" },
        signalWithContext({ timezone: "America/New_York" }),
      );

      expect(spawnDetachedFn).toHaveBeenCalledWith(
        expect.objectContaining({
          timezone: "America/New_York",
        }),
      );
    });

    it("forwards taskPrompt and conversationContext from the execution signal", async () => {
      const spawnDetachedFn = vi.fn().mockReturnValue(makeDetachedResult());
      const registry = mockRegistry({ spawnDetached: spawnDetachedFn });

      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext(),
      });

      const spawnTool = tools.find((t) => t.name === "spawn_subagent")!;
      await spawnTool.execute(
        { task: "why didn't it connect/open?" },
        signalWithContext({
          taskPrompt: "The user is following up on a specifically referenced earlier exchange.",
          conversationContext: {
            turnKind: "follow_up",
            selectedBlocks: [
              {
                id: "reply:msg-2",
                source: "reply_anchor",
                summary: "assistant: I could not open GitHub because the browser session was not connected.",
                score: 100,
                reason: "Explicit reply target matched a prior session message.",
              },
            ],
            selectionReasons: ["reply_anchor → Explicit reply target matched a prior session message."],
            replyToMessageId: "discord-assistant-2",
          },
        }),
      );

      expect(spawnDetachedFn).toHaveBeenCalledWith(
        expect.objectContaining({
          taskPrompt: "The user is following up on a specifically referenced earlier exchange.",
          conversationContext: expect.objectContaining({
            replyToMessageId: "discord-assistant-2",
          }),
        }),
      );
    });

    it("handles unexpected errors", async () => {
      const registry = mockRegistry({
        spawnDetached: vi.fn().mockImplementation(() => {
          throw new Error("Unexpected boom");
        }),
      });

      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext(),
      });

      const spawnTool = tools.find((t) => t.name === "spawn_subagent")!;
      const result = await spawnTool.execute({ task: "Boom" }, signal());

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Sub-agent spawn failed");
      expect(result.content).toContain("Unexpected boom");
    });
  });

  // ─── list_subagents ───

  describe("list_subagents", () => {
    it("returns records", async () => {
      const records = [
        makeRecord({ id: "sub-1", task: "Task A" }),
        makeRecord({ id: "sub-2", task: "Task B" }),
      ];

      const registry = mockRegistry({
        listByParentRunId: vi.fn().mockReturnValue(records),
      });

      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext(),
      });

      const listTool = tools.find((t) => t.name === "list_subagents")!;
      const result = await listTool.execute({}, signal());

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content) as { count: number; subagents: unknown[] };
      expect(parsed.count).toBe(2);
      expect(parsed.subagents).toHaveLength(2);
    });

    it("filters by status", async () => {
      const records = [
        makeRecord({ id: "sub-1", task: "Task A", status: "completed" }),
        makeRecord({ id: "sub-2", task: "Task B", status: "failed" }),
      ];

      const registry = mockRegistry({
        listByParentRunId: vi.fn().mockReturnValue(records),
      });

      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext(),
      });

      const listTool = tools.find((t) => t.name === "list_subagents")!;
      const result = await listTool.execute({ status: "completed" }, signal());

      const parsed = JSON.parse(result.content) as { count: number; subagents: Array<{ task: string }> };
      expect(parsed.count).toBe(1);
      expect(parsed.subagents[0].task).toBe("Task A");
    });

    it("returns empty array when no records", async () => {
      const registry = mockRegistry({
        listByParentRunId: vi.fn().mockReturnValue([]),
      });

      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext(),
      });

      const listTool = tools.find((t) => t.name === "list_subagents")!;
      const result = await listTool.execute({}, signal());

      const parsed = JSON.parse(result.content) as { count: number; subagents: unknown[] };
      expect(parsed.count).toBe(0);
      expect(parsed.subagents).toHaveLength(0);
    });
  });

  // ─── get_subagent ───

  describe("get_subagent", () => {
    it("returns record details", async () => {
      const record = makeRecord({ id: "sub-42", task: "Find specific" });
      const registry = mockRegistry({
        getById: vi.fn().mockReturnValue(record),
      });

      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext(),
      });

      const getTool = tools.find((t) => t.name === "get_subagent")!;
      const result = await getTool.execute({ subagentId: "sub-42" }, signal());

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      expect(parsed.id).toBe("sub-42");
      expect(parsed.childRunId).toBe("child-run-1");
      expect(parsed.task).toBe("Find specific");
      expect(parsed.status).toBe("completed");
      expect(parsed.outcome).toBeDefined();
    });

    it("returns error for non-existent subagent", async () => {
      const registry = mockRegistry({
        getById: vi.fn().mockReturnValue(null),
      });

      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext(),
      });

      const getTool = tools.find((t) => t.name === "get_subagent")!;
      const result = await getTool.execute({ subagentId: "nonexistent" }, signal());

      expect(result.isError).toBe(true);
      expect(result.content).toContain("not found");
    });

    it("requires subagentId param", async () => {
      const registry = mockRegistry();
      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext(),
      });

      const getTool = tools.find((t) => t.name === "get_subagent")!;
      await expect(getTool.execute({}, signal())).rejects.toThrow("subagentId is required");
    });

    it("returns error when subagent belongs to a different parent run", async () => {
      const otherRecord = makeRecord({
        id: "sub-other",
        parentRunId: "other-run",
        parentSessionKey: "agent:run:other-run",
        task: "Other task",
      });
      const registry = mockRegistry({
        getById: vi.fn().mockReturnValue(otherRecord),
      });

      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext({ parentRunId: "my-run", parentSessionKey: "agent:run:my-run" }),
      });

      const getTool = tools.find((t) => t.name === "get_subagent")!;
      const result = await getTool.execute({ subagentId: "sub-other" }, signal());

      expect(result.isError).toBe(true);
      expect(result.content).toContain("not found");
    });

    it("allows access when parentRunId matches", async () => {
      const ownedRecord = makeRecord({
        id: "sub-owned",
        parentRunId: "my-run",
        parentSessionKey: "agent:run:my-run",
        task: "My task",
      });
      const registry = mockRegistry({
        getById: vi.fn().mockReturnValue(ownedRecord),
      });

      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext({ parentRunId: "my-run", parentSessionKey: "agent:run:my-run" }),
      });

      const getTool = tools.find((t) => t.name === "get_subagent")!;
      const result = await getTool.execute({ subagentId: "sub-owned" }, signal());

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      expect(parsed.id).toBe("sub-owned");
    });

    it("allows access when parentSessionKey matches (different parentRunId)", async () => {
      const record = makeRecord({
        id: "sub-session-match",
        parentRunId: "run-A",
        parentSessionKey: "agent:run:shared-session",
        task: "Session match task",
      });
      const registry = mockRegistry({
        getById: vi.fn().mockReturnValue(record),
      });

      const tools = createFridayAgentSubagentTools({
        registry,
        subagentContext: makeContext({
          parentRunId: "run-B",
          parentSessionKey: "agent:run:shared-session",
        }),
      });

      const getTool = tools.find((t) => t.name === "get_subagent")!;
      const result = await getTool.execute({ subagentId: "sub-session-match" }, signal());

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      expect(parsed.id).toBe("sub-session-match");
    });
  });
});

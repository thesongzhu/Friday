import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridaySubagentRegistry,
  createFridayAgentEventEmitter,
  FRIDAY_SUBAGENT_MAX_DEPTH,
  FRIDAY_SUBAGENT_MAX_CONCURRENT,
  FRIDAY_SUBAGENT_ERROR_CODES,
} from "#agent";
import type {
  FridayAgentRuntimeResult,
  FridayAgentEventEmitter,
  CreateFridaySubagentRegistryDeps,
  CreateChildRuntimeParams,
  FridaySubagentRegistrySpawnInput,
} from "#agent";
import type { FridaySessionService } from "../../../../src/sessions/services/friday-session-service.types.js";
import { buildFridaySubagentSessionKey } from "#sessions";
import { FridayDomainError } from "#errors";

describe("FridaySubagentRegistry", () => {
  let db: FridaySqliteLayer;
  let idGenerator: () => string;
  let eventEmitter: FridayAgentEventEmitter;
  const NOW = "2026-02-19T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGenerator = createTestIdGenerator();
    eventEmitter = createFridayAgentEventEmitter();
  });

  afterEach(() => {
    db.close();
  });

  function makeResult(overrides?: Partial<FridayAgentRuntimeResult>): FridayAgentRuntimeResult {
    return {
      runId: "child-run-1",
      status: "completed",
      response: "Task completed successfully",
      toolCallCount: 2,
      durationMs: 1000,
      usageInput: 100,
      usageOutput: 50,
      ...overrides,
    };
  }

  function mockCreateChildRuntime(result: FridayAgentRuntimeResult) {
    return (_params: CreateChildRuntimeParams) => ({
      executeRun: vi.fn().mockResolvedValue(result),
    });
  }

  function createRegistry(
    overrides?: Partial<CreateFridaySubagentRegistryDeps>,
  ) {
    return createFridaySubagentRegistry({
      db,
      createChildRuntime: mockCreateChildRuntime(makeResult()),
      eventEmitter,
      idGenerator,
      nowIso: () => NOW,
      ...overrides,
    });
  }

  /** Seed a parent agent run so FK constraints are satisfied. */
  function seedParentRun(runId: string) {
    db.writer.prepare(
      `INSERT OR IGNORE INTO friday_agent_runs (id, task, status, session_key, attempt, max_attempts, created_at)
       VALUES (?, 'seed', 'pending', ?, 0, 1, ?)`,
    ).run(runId, `agent:run:${runId}`, NOW);
  }

  function spawnInput(overrides?: Partial<FridaySubagentRegistrySpawnInput>): FridaySubagentRegistrySpawnInput {
    const parentRunId = overrides?.parentRunId ?? "parent-run-1";
    seedParentRun(parentRunId);
    return {
      task: "Do something",
      parentRunId,
      parentSessionKey: "agent:run:parent-run-1",
      mode: "fresh",
      depth: 0,
      rootRunId: "parent-run-1",
      signal: new AbortController().signal,
      ...overrides,
    };
  }

  // ─── spawn ───

  describe("spawn", () => {
    it("completes successfully", async () => {
      const registry = createRegistry();
      const outcome = await registry.spawn(spawnInput());

      expect(outcome.status).toBe("completed");
      expect(outcome.response).toBe("Task completed successfully");
      expect(outcome.toolCallCount).toBe(2);
      expect(outcome.durationMs).toBe(1000);
      expect(outcome.usageInput).toBe(100);
      expect(outcome.usageOutput).toBe(50);
    });

    it("records start and completion in DB", async () => {
      const registry = createRegistry();
      await registry.spawn(spawnInput());

      const records = registry.listByParentRunId("parent-run-1");
      expect(records).toHaveLength(1);
      expect(records[0].status).toBe("completed");
      expect(records[0].startedAt).toBe(NOW);
      expect(records[0].completedAt).toBe(NOW);
      expect(records[0].depth).toBe(1);
      expect(records[0].childRunId).toBeTruthy();
      expect(records[0].childSessionKey).toBe(
        buildFridaySubagentSessionKey("agent:run:parent-run-1", records[0].childRunId),
      );
    });

    it("emits spawned and completed events", async () => {
      const events: Array<{ event: string; payload: unknown }> = [];
      eventEmitter.on("agent.subagent.spawned", (p) =>
        events.push({ event: "spawned", payload: p }),
      );
      eventEmitter.on("agent.subagent.completed", (p) =>
        events.push({ event: "completed", payload: p }),
      );

      const registry = createRegistry();
      await registry.spawn(spawnInput());

      expect(events).toHaveLength(2);
      expect(events[0].event).toBe("spawned");
      expect(events[1].event).toBe("completed");
    });

    it("rejects at max depth", async () => {
      const registry = createRegistry();

      await expect(
        registry.spawn(spawnInput({ depth: FRIDAY_SUBAGENT_MAX_DEPTH })),
      ).rejects.toThrow(FridayDomainError);

      try {
        await registry.spawn(spawnInput({ depth: FRIDAY_SUBAGENT_MAX_DEPTH }));
      } catch (error) {
        expect(error).toBeInstanceOf(FridayDomainError);
        expect((error as FridayDomainError).code).toBe(
          FRIDAY_SUBAGENT_ERROR_CODES.MAX_DEPTH_EXCEEDED,
        );
      }
    });

    it("rejects at max concurrent", async () => {
      // Pre-fill active records to MAX_CONCURRENT
      seedParentRun("parent-run-1");
      const repo = (await import("#agent")).createFridaySubagentRunRepository();
      for (let i = 0; i < FRIDAY_SUBAGENT_MAX_CONCURRENT; i++) {
        db.withWriteTransaction((writer) => {
          const id = idGenerator();
          repo.create(writer, {
            id,
            parentRunId: "parent-run-1",
            parentSessionKey: "agent:run:parent-run-1",
            childRunId: `child-${id}`,
            childSessionKey: buildFridaySubagentSessionKey("agent:run:parent-run-1", `child-${id}`),
            task: `Active task ${String(i)}`,
            depth: 1,
            nowIso: NOW,
          });
          repo.update(writer, { id, status: "running" });
        });
      }

      // Need a fresh idGenerator since the pre-fill used some IDs
      const registry = createFridaySubagentRegistry({
        db,
        createChildRuntime: mockCreateChildRuntime(makeResult()),
        eventEmitter,
        idGenerator,
        nowIso: () => NOW,
      });

      await expect(
        registry.spawn(spawnInput()),
      ).rejects.toThrow(FridayDomainError);

      try {
        await registry.spawn(spawnInput());
      } catch (error) {
        expect(error).toBeInstanceOf(FridayDomainError);
        expect((error as FridayDomainError).code).toBe(
          FRIDAY_SUBAGENT_ERROR_CODES.MAX_CONCURRENT_EXCEEDED,
        );
      }
    });

    it("handles child failure", async () => {
      const failedResult = makeResult({
        status: "failed",
        response: "Something went wrong",
      });

      const registry = createRegistry({
        createChildRuntime: mockCreateChildRuntime(failedResult),
      });

      const outcome = await registry.spawn(spawnInput());

      expect(outcome.status).toBe("failed");
      expect(outcome.response).toBe("Something went wrong");

      const records = registry.listByParentRunId("parent-run-1");
      expect(records[0].status).toBe("failed");
    });

    it("handles child cancellation", async () => {
      const cancelledResult = makeResult({
        status: "cancelled",
        response: "Run was cancelled",
      });

      const registry = createRegistry({
        createChildRuntime: mockCreateChildRuntime(cancelledResult),
      });

      const outcome = await registry.spawn(spawnInput());

      expect(outcome.status).toBe("cancelled");

      const records = registry.listByParentRunId("parent-run-1");
      expect(records[0].status).toBe("cancelled");
    });

    it("handles child runtime exception without rethrowing", async () => {
      const registry = createRegistry({
        createChildRuntime: () => ({
          executeRun: vi.fn().mockRejectedValue(new Error("Runtime exploded")),
        }),
      });

      const outcome = await registry.spawn(spawnInput());

      expect(outcome.status).toBe("failed");
      expect(outcome.response).toContain("Runtime exploded");

      const records = registry.listByParentRunId("parent-run-1");
      expect(records[0].status).toBe("failed");
      expect(records[0].outcome?.response).toContain("Runtime exploded");
    });

    it("passes model override to child runtime", async () => {
      const createChildRuntime = vi.fn().mockReturnValue({
        executeRun: vi.fn().mockResolvedValue(makeResult()),
      });

      const registry = createRegistry({ createChildRuntime });

      await registry.spawn(spawnInput({ model: "gpt-4o" }));

      expect(createChildRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ model: "gpt-4o" }),
      );
    });

    it("marks inherited child runs so model selection is auditable", async () => {
      const executeRun = vi.fn().mockResolvedValue(makeResult());
      const createChildRuntime = vi.fn().mockReturnValue({ executeRun });
      const registry = createRegistry({ createChildRuntime });

      await registry.spawn(spawnInput());

      expect(createChildRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ model: undefined }),
      );
      expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({
        modelSelectionSourceOverride: "inherited",
      }));
    });

    it("passes taskPrompt and conversationContext through to the child executeRun", async () => {
      const executeRun = vi.fn().mockResolvedValue(makeResult());
      const createChildRuntime = vi.fn().mockReturnValue({ executeRun });

      const registry = createRegistry({ createChildRuntime });
      await registry.spawn(spawnInput({
        task: "why didn't it connect/open?",
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
      }));

      expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({
        taskPrompt: "The user is following up on a specifically referenced earlier exchange.",
        conversationContext: expect.objectContaining({
          replyToMessageId: "discord-assistant-2",
        }),
      }));
    });

    it("passes provider and model overrides through to child executeRun", async () => {
      const executeRun = vi.fn().mockResolvedValue(makeResult());
      const createChildRuntime = vi.fn().mockReturnValue({ executeRun });

      const registry = createRegistry({ createChildRuntime });
      await registry.spawn(spawnInput({
        providerId: "provider-openai",
        model: "gpt-4.1",
      }));

      expect(createChildRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: "provider-openai",
          model: "gpt-4.1",
        }),
      );
      expect(executeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: "provider-openai",
          model: "gpt-4.1",
        }),
      );
    });

    it("passes principal and tenant context through to child executeRun", async () => {
      const executeRun = vi.fn().mockResolvedValue(makeResult());
      const createChildRuntime = vi.fn().mockReturnValue({ executeRun });

      const registry = createRegistry({ createChildRuntime });
      await registry.spawn(spawnInput({
        principalId: "user-ctx-1",
        tenantContext: {
          hubId: "tenant-a",
          userId: "user-ctx-1",
          channelKind: "agent",
        },
      }));

      expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({
        principalId: "user-ctx-1",
        tenantContext: {
          hubId: "tenant-a",
          userId: "user-ctx-1",
          channelKind: "agent",
        },
      }));
    });

    it("persists requesterSessionKey and rootRunId", async () => {
      const registry = createRegistry();
      await registry.spawn(spawnInput({ rootRunId: "root-123" }));

      const records = registry.listByParentRunId("parent-run-1");
      expect(records).toHaveLength(1);
      expect(records[0].requesterSessionKey).toBe("agent:run:parent-run-1");
      expect(records[0].rootRunId).toBe("root-123");
    });

    it("uses session forking and persists fork metadata when mode=fork", async () => {
      const executeRun = vi.fn().mockResolvedValue(makeResult());
      const createChildRuntime = vi.fn().mockReturnValue({ executeRun });
      const sessionService: FridaySessionService = {
        forkSession: vi.fn().mockResolvedValue({
          forkSession: { key: "agent:run:forked-child-1" },
          inheritedMessageCount: 5,
          forkedFromMessageId: "msg-42",
        }),
      } as unknown as FridaySessionService;

      const registry = createRegistry({ createChildRuntime, sessionService });
      await registry.spawn(spawnInput({
        mode: "fork",
        inheritMessageCount: 5,
        forkFromMessageId: "msg-42",
      }));

      expect(sessionService.forkSession).toHaveBeenCalledWith("agent:run:parent-run-1", {
        taskId: expect.any(String),
        inheritMessageCount: 5,
        forkFromMessageId: "msg-42",
      });
      const records = registry.listByParentRunId("parent-run-1");
      expect(records[0].mode).toBe("fork");
      expect(records[0].forkedFromMessageId).toBe("msg-42");
      expect(records[0].inheritedMessageCount).toBe(5);
      expect(records[0].childSessionKey).toBe("agent:run:forked-child-1");
      expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({
        sessionKey: "agent:run:forked-child-1",
      }));
    });

    it("loads inherited session messages and passes them to child executeRun in fork mode", async () => {
      const executeRun = vi.fn().mockResolvedValue(makeResult());
      const createChildRuntime = vi.fn().mockReturnValue({ executeRun });
      const sessionService: FridaySessionService = {
        forkSession: vi.fn().mockResolvedValue({
          forkSession: { key: "agent:run:forked-child-ctx" },
          inheritedMessageCount: 2,
          forkedFromMessageId: "msg-parent-2",
        }),
        getMessages: vi.fn().mockResolvedValue([
          {
            id: "msg-1",
            sessionId: "session-1",
            sessionKey: "agent:run:forked-child-ctx",
            sequence: 1,
            role: "user",
            content: "SECRET_CONTEXT_123",
            contentText: "SECRET_CONTEXT_123",
            tokenCount: 3,
            metadata: {},
            memoryExtractStatus: "pending",
            occurredAt: NOW,
            createdAt: NOW,
            updatedAt: NOW,
            inherited: true,
            inheritedFromSessionKey: "agent:run:parent-run-1",
            inheritedFromMessageId: "msg-parent-1",
          },
          {
            id: "msg-2",
            sessionId: "session-1",
            sessionKey: "agent:run:forked-child-ctx",
            sequence: 2,
            role: "assistant",
            content: "ACKNOWLEDGED_CONTEXT",
            contentText: "ACKNOWLEDGED_CONTEXT",
            tokenCount: 2,
            metadata: {},
            memoryExtractStatus: "pending",
            occurredAt: NOW,
            createdAt: NOW,
            updatedAt: NOW,
            inherited: true,
            inheritedFromSessionKey: "agent:run:parent-run-1",
            inheritedFromMessageId: "msg-parent-2",
          },
        ]),
      } as unknown as FridaySessionService;

      const registry = createRegistry({ createChildRuntime, sessionService });
      await registry.spawn(spawnInput({
        mode: "fork",
        inheritMessageCount: 2,
      }));

      expect(sessionService.getMessages).toHaveBeenCalledWith("agent:run:forked-child-ctx", 48);
      expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({
        sessionKey: "agent:run:forked-child-ctx",
        historyMessages: [
          { role: "user", content: "SECRET_CONTEXT_123" },
          { role: "assistant", content: "ACKNOWLEDGED_CONTEXT" },
        ],
      }));
    });

    it("rejects fork mode when session forking is unavailable", async () => {
      const registry = createRegistry();

      await expect(
        registry.spawn(spawnInput({ mode: "fork" })),
      ).rejects.toThrow("fork mode is not available");
    });
  });

  // ─── spawnDetached ───

  describe("spawnDetached", () => {
    it("returns accepted immediately", async () => {
      const registry = createRegistry();
      const result = await registry.spawnDetached(spawnInput());

      expect(result.status).toBe("accepted");
      expect(result.subagentId).toBeTruthy();
      expect(result.childRunId).toBeTruthy();
      expect(result.childSessionKey).toBeTruthy();
      expect(result.childSessionKey).toBe(
        buildFridaySubagentSessionKey("agent:run:parent-run-1", result.childRunId),
      );
    });

    it("creates a pending/running record in DB", async () => {
      const registry = createRegistry();
      const result = await registry.spawnDetached(spawnInput());

      const record = registry.getById(result.subagentId);
      expect(record).toBeTruthy();
      // It may be pending, running, or already completed depending on timing
      expect(["pending", "running", "completed"]).toContain(record?.status);
    });

    it("eventually completes the child run", async () => {
      const registry = createRegistry();
      const result = await registry.spawnDetached(spawnInput());

      // Wait for the detached run to complete
      const outcome = await registry.waitForCompletion(result.subagentId, 5000);
      expect(outcome.status).toBe("completed");
    });

    it("drain waits for detached children to settle", async () => {
      let resolveRun: ((value: FridayAgentRuntimeResult) => void) | undefined;
      const registry = createRegistry({
        createChildRuntime: () => ({
          executeRun: vi.fn().mockReturnValue(new Promise<FridayAgentRuntimeResult>((resolve) => {
            resolveRun = resolve;
          })),
        }),
      });

      await registry.spawnDetached(spawnInput());

      let settled = false;
      const draining = registry.drain(1000).then(() => {
        settled = true;
      });

      await Promise.resolve();
      expect(settled).toBe(false);

      resolveRun?.(makeResult());
      await draining;
      expect(settled).toBe(true);
    });
  });

  // ─── finalize ───

  describe("finalize", () => {
    it("sets cleanup flags on a completed record", async () => {
      const registry = createRegistry();
      await registry.spawn(spawnInput());

      const records = registry.listByParentRunId("parent-run-1");
      const id = records[0].id;

      registry.finalize(id);

      const updated = registry.getById(id);
      expect(updated?.cleanupRequested).toBe(true);
      expect(updated?.archivalDeadline).toBeTruthy();
    });

    it("accepts custom archival deadline", async () => {
      const registry = createRegistry();
      await registry.spawn(spawnInput());

      const records = registry.listByParentRunId("parent-run-1");
      const id = records[0].id;
      const deadline = "2026-12-31T00:00:00.000Z";

      registry.finalize(id, { archivalDeadline: deadline });

      const updated = registry.getById(id);
      expect(updated?.archivalDeadline).toBe(deadline);
    });
  });

  // ─── cleanup ───

  describe("cleanup", () => {
    it("deletes records past archival deadline", async () => {
      const registry = createRegistry();
      await registry.spawn(spawnInput());

      const records = registry.listByParentRunId("parent-run-1");
      const id = records[0].id;

      registry.finalize(id, { archivalDeadline: "2026-01-01T00:00:00.000Z" });

      const deleted = registry.cleanup("2026-06-01T00:00:00.000Z");
      expect(deleted).toBe(1);

      expect(registry.getById(id)).toBeNull();
    });

    it("does not delete records before archival deadline", async () => {
      const registry = createRegistry();
      await registry.spawn(spawnInput());

      const records = registry.listByParentRunId("parent-run-1");
      const id = records[0].id;

      registry.finalize(id, { archivalDeadline: "2027-01-01T00:00:00.000Z" });

      const deleted = registry.cleanup("2026-06-01T00:00:00.000Z");
      expect(deleted).toBe(0);

      expect(registry.getById(id)).not.toBeNull();
    });
  });

  // ─── resumeOnBoot ───

  describe("resumeOnBoot", () => {
    it("marks pending/running as failed on boot", async () => {
      // Create a registry with a runtime that never resolves (simulate crash)
      const neverResolve = () => ({
        executeRun: vi.fn().mockReturnValue(new Promise(() => {})),
      });
      const registry1 = createFridaySubagentRegistry({
        db,
        createChildRuntime: neverResolve,
        eventEmitter,
        idGenerator,
        nowIso: () => NOW,
      });

      // Manually create a "stuck" record by inserting directly
      seedParentRun("parent-run-1");
      const repo = (await import("#agent")).createFridaySubagentRunRepository();
      db.withWriteTransaction((writer) => {
        repo.create(writer, {
          id: "stuck-1",
          parentRunId: "parent-run-1",
          parentSessionKey: "agent:run:parent-run-1",
          childRunId: "child-run-stuck-1",
          childSessionKey: buildFridaySubagentSessionKey("agent:run:parent-run-1", "child-run-stuck-1"),
          task: "Stuck task",
          depth: 1,
          nowIso: NOW,
        });
        repo.update(writer, { id: "stuck-1", status: "running", startedAt: NOW });
      });

      // Create a new registry (simulating reboot) and call resumeOnBoot
      const registry2 = createFridaySubagentRegistry({
        db,
        createChildRuntime: mockCreateChildRuntime(makeResult()),
        eventEmitter,
        idGenerator,
        nowIso: () => NOW,
      });

      const failedCount = registry2.resumeOnBoot();
      expect(failedCount).toBe(1);

      const record = registry2.getById("stuck-1");
      expect(record?.status).toBe("failed");
      expect(record?.outcome?.response).toContain("restarted");
    });

    it("returns 0 when no stale records exist", () => {
      const registry = createRegistry();
      expect(registry.resumeOnBoot()).toBe(0);
    });
  });

  // ─── listByParentRunId ───

  describe("listByParentRunId", () => {
    it("returns correct records after spawning", async () => {
      const registry = createRegistry();
      await registry.spawn(spawnInput({ task: "Task A" }));
      await registry.spawn(spawnInput({ task: "Task B" }));

      const records = registry.listByParentRunId("parent-run-1");
      expect(records).toHaveLength(2);
    });
  });

  // ─── list with extended filters ───

  describe("list", () => {
    it("filters by requesterSessionKey", async () => {
      const registry = createRegistry();
      await registry.spawn(spawnInput({ task: "Task A" }));
      await registry.spawn(spawnInput({
        task: "Task B",
        parentSessionKey: "other:session:key",
        parentRunId: "parent-run-2",
      }));

      const filtered = registry.list({ requesterSessionKey: "agent:run:parent-run-1" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].task).toBe("Task A");
    });

    it("filters by rootRunId", async () => {
      const registry = createRegistry();
      await registry.spawn(spawnInput({ task: "Task A", rootRunId: "root-1" }));
      await registry.spawn(spawnInput({ task: "Task B", rootRunId: "root-2" }));

      const filtered = registry.list({ rootRunId: "root-1" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].task).toBe("Task A");
    });
  });

  // ─── getById ───

  describe("getById", () => {
    it("returns correct record", async () => {
      const registry = createRegistry();
      await registry.spawn(spawnInput({ task: "Find me" }));

      const records = registry.listByParentRunId("parent-run-1");
      const found = registry.getById(records[0].id);

      expect(found).not.toBeNull();
      expect(found?.task).toBe("Find me");
    });

    it("returns null for non-existent id", () => {
      const registry = createRegistry();
      expect(registry.getById("nonexistent")).toBeNull();
    });
  });

  // ─── activeCountForParent ───

  describe("activeCountForParent", () => {
    it("returns correct count during and after spawn", async () => {
      const registry = createRegistry();

      // Before spawn
      expect(registry.activeCountForParent("parent-run-1")).toBe(0);

      // After spawn (completed)
      await registry.spawn(spawnInput());
      expect(registry.activeCountForParent("parent-run-1")).toBe(0);
    });
  });
});

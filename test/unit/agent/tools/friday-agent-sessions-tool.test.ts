import { describe, it, expect, vi } from "vitest";
import { createFridayAgentSessionsTool } from "#agent";
import type { FridaySessionService } from "../../../../src/sessions/services/friday-session-service.types.js";
import type { FridayAgentRuntime, FridayAgentRuntimeResult } from "#agent";
import { attachFridayAgentToolExecutionContext } from "../../../../src/agent/runtime/friday-agent-tool-execution-context.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function signalWithContext(): AbortSignal {
  const controller = new AbortController();
  return attachFridayAgentToolExecutionContext(controller.signal, {
    runId: "run-ctx-1",
    sessionKey: "agent:run:ctx-1",
    readOnly: false,
    timezone: "America/Los_Angeles",
    principalId: "user-ctx-1",
    tenantContext: {
      hubId: "tenant-a",
      userId: "user-ctx-1",
      channelKind: "agent",
    },
  });
}

function makeSessionRecord(overrides?: Record<string, unknown>) {
  return {
    id: "sess-001",
    key: "agent:main:abc",
    channel: "agent",
    accountId: "default",
    chatId: "main",
    status: "active",
    chatKind: "direct",
    memoryNamespace: undefined,
    parentSessionKey: undefined,
    rootSessionKey: undefined,
    forkedFromMessageId: undefined,
    sendPolicy: undefined,
    metadata: {},
    contextInputTokens: 500,
    contextOutputTokens: 200,
    contextTotalTokens: 700,
    messageCount: 5,
    createdAt: "2026-01-15T10:00:00Z",
    updatedAt: "2026-01-15T12:00:00Z",
    lastActivityAt: "2026-01-15T12:00:00Z",
    statusChangedAt: undefined,
    idleAt: undefined,
    archivedAt: undefined,
    prunedAt: undefined,
    ...overrides,
  };
}

function makeMessageRecord(overrides?: Record<string, unknown>) {
  return {
    id: "msg-001",
    sessionId: "sess-001",
    sessionKey: "agent:main:abc",
    sequence: 1,
    role: "user",
    content: "Hello",
    contentText: "Hello",
    tokenCount: 5,
    occurredAt: "2026-01-15T12:00:00Z",
    ...overrides,
  };
}

function mockSessionService(overrides?: Partial<FridaySessionService>): FridaySessionService {
  return {
    createSession: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([makeSessionRecord()]),
    getSession: vi.fn().mockResolvedValue(makeSessionRecord()),
    getOrCreateSession: vi.fn().mockResolvedValue(makeSessionRecord()),
    addMessage: vi.fn().mockResolvedValue(makeMessageRecord()),
    getMessages: vi.fn().mockResolvedValue([makeMessageRecord()]),
    archiveSession: vi.fn(),
    pruneOldSessions: vi.fn(),
    sweepLifecycle: vi.fn(),
    getSessionMemoryNamespace: vi.fn(),
    forkSession: vi.fn(),
    listForks: vi.fn(),
    mergeForkSummary: vi.fn(),
    resetSession: vi.fn(),
    setSendPolicy: vi.fn(),
    evaluateSendPolicy: vi.fn(),
    ...overrides,
  } as unknown as FridaySessionService;
}

function mockAgentRuntime(overrides?: Partial<FridayAgentRuntimeResult>): FridayAgentRuntime {
  return {
    executeRun: vi.fn().mockResolvedValue({
      runId: "run-001",
      status: "completed",
      response: "Here is the answer.",
      toolCallCount: 2,
      durationMs: 3000,
      ...overrides,
    }),
  } as unknown as FridayAgentRuntime;
}

describe("FridayAgentSessionsTool", () => {
  // ─── Definition ───

  it("has correct name and parameters", () => {
    const tool = createFridayAgentSessionsTool({
      sessionService: mockSessionService(),
      agentRuntime: mockAgentRuntime(),
    });
    expect(tool.name).toBe("sessions");
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toBeDefined();
    expect(tool.parameters.required).toContain("action");
  });

  // ─── List action ───

  it("lists sessions", async () => {
    const svc = mockSessionService();
    const tool = createFridayAgentSessionsTool({
      sessionService: svc,
      agentRuntime: mockAgentRuntime(),
    });

    const result = await tool.execute({ action: "list" }, signal());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { count: number; sessions: unknown[] };
    expect(parsed.count).toBe(1);
    expect(svc.listSessions).toHaveBeenCalled();
  });

  it("passes limit to list", async () => {
    const svc = mockSessionService();
    const tool = createFridayAgentSessionsTool({
      sessionService: svc,
      agentRuntime: mockAgentRuntime(),
    });

    await tool.execute({ action: "list", limit: 5 }, signal());

    expect(svc.listSessions).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
  });

  // ─── History action ───

  it("returns message history for a session", async () => {
    const svc = mockSessionService();
    const tool = createFridayAgentSessionsTool({
      sessionService: svc,
      agentRuntime: mockAgentRuntime(),
    });

    const result = await tool.execute(
      { action: "history", sessionId: "agent:main:abc" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { sessionKey: string; messages: unknown[] };
    expect(parsed.sessionKey).toBe("agent:main:abc");
    expect(parsed.messages).toHaveLength(1);
  });

  it("returns error when session not found for history", async () => {
    const svc = mockSessionService({
      getSession: vi.fn().mockResolvedValue(null),
    });
    const tool = createFridayAgentSessionsTool({
      sessionService: svc,
      agentRuntime: mockAgentRuntime(),
    });

    const result = await tool.execute(
      { action: "history", sessionId: "nonexistent" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("returns error when sessionId missing for history", async () => {
    const tool = createFridayAgentSessionsTool({
      sessionService: mockSessionService(),
      agentRuntime: mockAgentRuntime(),
    });

    const result = await tool.execute({ action: "history" }, signal());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("sessionId is required");
  });

  // ─── Send action ───

  it("sends a message and triggers agent run", async () => {
    const svc = mockSessionService();
    const runtime = mockAgentRuntime();
    const tool = createFridayAgentSessionsTool({
      sessionService: svc,
      agentRuntime: runtime,
    });

    const result = await tool.execute(
      { action: "send", sessionId: "agent:main:abc", message: "Tell me a joke" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.sessionKey).toBe("agent:main:abc");
    expect(parsed.messageId).toBe("msg-001");
    expect((parsed.agentRun as Record<string, unknown>).status).toBe("completed");
    expect(svc.addMessage).toHaveBeenCalled();
    expect(runtime.executeRun).toHaveBeenCalled();
  });

  it("passes session history into executeRun during send", async () => {
    const svc = mockSessionService({
      getMessages: vi.fn().mockResolvedValue([
        makeMessageRecord({ id: "msg-older", role: "user", content: "older", contentText: "older" }),
        makeMessageRecord({ id: "msg-assistant", role: "assistant", content: "older reply", contentText: "older reply", sequence: 2 }),
      ]),
    });
    const runtime = mockAgentRuntime();
    const tool = createFridayAgentSessionsTool({
      sessionService: svc,
      agentRuntime: runtime,
    });

    await tool.execute(
      { action: "send", sessionId: "agent:main:abc", message: "Tell me a joke" },
      signal(),
    );

    expect(runtime.executeRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: "agent:main:abc",
      task: "Tell me a joke",
      historyMessages: [
        { role: "user", content: "older" },
        { role: "assistant", content: "older reply" },
      ],
    }));
  });

  it("passes principal and tenant context from tool execution metadata into executeRun", async () => {
    const svc = mockSessionService();
    const runtime = mockAgentRuntime();
    const tool = createFridayAgentSessionsTool({
      sessionService: svc,
      agentRuntime: runtime,
    });

    await tool.execute(
      { action: "send", sessionId: "agent:main:abc", message: "Route with tenant scope" },
      signalWithContext(),
    );

    expect(runtime.executeRun).toHaveBeenCalledWith(expect.objectContaining({
      timezone: "America/Los_Angeles",
      principalId: "user-ctx-1",
      tenantContext: {
        hubId: "tenant-a",
        userId: "user-ctx-1",
        channelKind: "agent",
      },
    }));
  });

  it("returns error when sessionId missing for send", async () => {
    const tool = createFridayAgentSessionsTool({
      sessionService: mockSessionService(),
      agentRuntime: mockAgentRuntime(),
    });

    const result = await tool.execute(
      { action: "send", message: "Hello" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("sessionId is required");
  });

  it("returns error when message missing for send", async () => {
    const tool = createFridayAgentSessionsTool({
      sessionService: mockSessionService(),
      agentRuntime: mockAgentRuntime(),
    });

    const result = await tool.execute(
      { action: "send", sessionId: "agent:main:abc" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("message is required");
  });

  // ─── Spawn action ───

  it("spawns a new session", async () => {
    const svc = mockSessionService();
    const tool = createFridayAgentSessionsTool({
      sessionService: svc,
      agentRuntime: mockAgentRuntime(),
    });

    const result = await tool.execute(
      { action: "spawn", sessionId: "agent:new:123" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.spawned).toBe(true);
    expect(svc.getOrCreateSession).toHaveBeenCalled();
  });

  it("spawns with initial message", async () => {
    const svc = mockSessionService();
    const tool = createFridayAgentSessionsTool({
      sessionService: svc,
      agentRuntime: mockAgentRuntime(),
    });

    const result = await tool.execute(
      { action: "spawn", sessionId: "agent:new:456", message: "Init message" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.messageId).toBeDefined();
    expect(svc.addMessage).toHaveBeenCalled();
  });

  // ─── Parameter validation ───

  it("returns error for invalid action", async () => {
    const tool = createFridayAgentSessionsTool({
      sessionService: mockSessionService(),
      agentRuntime: mockAgentRuntime(),
    });

    const result = await tool.execute({ action: "delete" }, signal());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid action");
  });

  // ─── Lazy runtime getter (Issue 2 fix) ───

  it("accepts agentRuntimeGetter and uses it for send", async () => {
    const runtime = mockAgentRuntime();
    const svc = mockSessionService();
    const tool = createFridayAgentSessionsTool({
      sessionService: svc,
      agentRuntimeGetter: () => runtime,
    });

    const result = await tool.execute(
      { action: "send", sessionId: "agent:main:abc", message: "via getter" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    expect(runtime.executeRun).toHaveBeenCalled();
  });

  it("returns error when runtime getter returns undefined", async () => {
    const svc = mockSessionService();
    const tool = createFridayAgentSessionsTool({
      sessionService: svc,
      agentRuntimeGetter: () => undefined,
    });

    const result = await tool.execute(
      { action: "send", sessionId: "agent:main:abc", message: "no runtime" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not available");
  });

  it("getter takes precedence over direct agentRuntime", async () => {
    const directRuntime = mockAgentRuntime({ response: "direct" });
    const getterRuntime = mockAgentRuntime({ response: "getter" });
    const svc = mockSessionService();
    const tool = createFridayAgentSessionsTool({
      sessionService: svc,
      agentRuntime: directRuntime as unknown as FridayAgentRuntime,
      agentRuntimeGetter: () => getterRuntime as unknown as FridayAgentRuntime,
    });

    await tool.execute(
      { action: "send", sessionId: "agent:main:abc", message: "test" },
      signal(),
    );

    expect(getterRuntime.executeRun).toHaveBeenCalled();
    expect(directRuntime.executeRun).not.toHaveBeenCalled();
  });

  // ─── Error handling ───

  it("returns error when service throws", async () => {
    const svc = mockSessionService({
      listSessions: vi.fn().mockRejectedValue(new Error("DB error")),
    });
    const tool = createFridayAgentSessionsTool({
      sessionService: svc,
      agentRuntime: mockAgentRuntime(),
    });

    const result = await tool.execute({ action: "list" }, signal());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("DB error");
  });
});

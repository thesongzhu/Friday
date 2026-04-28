import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFridayChannelRegistry,
  createFridayChannelSlowTaskNotifier,
  type FridayChannelPlugin,
} from "#channels";
import { createFridayAgentEventEmitter } from "#agent";

function createMockPlugin(kind = "discord"): FridayChannelPlugin {
  return {
    kind,
    init: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    send: vi.fn(async () => ({ messageId: "sent-1" })),
  };
}

describe("FridayChannelSlowTaskNotifier", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not send slow-task updates by default", async () => {
    const registry = createFridayChannelRegistry();
    const plugin = createMockPlugin();
    registry.register(plugin);
    await registry.startAll(() => {});

    const emitter = createFridayAgentEventEmitter();
    createFridayChannelSlowTaskNotifier({
      eventEmitter: emitter,
      channelRegistry: registry,
      channelKind: "discord",
      chatId: "chat-1",
      runId: "run-default",
    });

    emitter.emit("agent.run.progress", {
      runId: "run-default",
      phase: "executing",
      elapsedMs: 121_000,
      activeTool: "browser",
      subagentCount: 1,
      latestSubagentId: "sub-1",
      activeSubagentIds: ["sub-1"],
      etaConfidence: "unavailable",
    });

    await vi.advanceTimersByTimeAsync(180_000);

    expect(plugin.send).not.toHaveBeenCalled();
  });

  it("sends the first slow-task update after the configured delay", async () => {
    const registry = createFridayChannelRegistry();
    const plugin = createMockPlugin();
    registry.register(plugin);
    await registry.startAll(() => {});

    const emitter = createFridayAgentEventEmitter();
    createFridayChannelSlowTaskNotifier({
      eventEmitter: emitter,
      channelRegistry: registry,
      channelKind: "discord",
      chatId: "chat-1",
      runId: "run-1",
      publicRunUrl: "https://friday.example.com/command-center?runId=run-1",
      initialDelayMs: 30_000,
    });

    emitter.emit("agent.run.progress", {
      runId: "run-1",
      phase: "executing",
      elapsedMs: 31_000,
      activeTool: "browser",
      subagentCount: 1,
      latestSubagentId: "sub-1",
      activeSubagentIds: ["sub-1"],
      eta: 45_000,
      etaConfidence: "low",
    });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(plugin.send).toHaveBeenCalledTimes(1);
    expect(plugin.send).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "chat-1",
      text: expect.stringContaining("Still working, elapsed"),
    }));
    expect(plugin.send).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Current: executing (browser)"),
    }));
  });

  it("sends an immediate follow-up when the phase changes after the first notification", async () => {
    const registry = createFridayChannelRegistry();
    const plugin = createMockPlugin();
    registry.register(plugin);
    await registry.startAll(() => {});

    const emitter = createFridayAgentEventEmitter();
    createFridayChannelSlowTaskNotifier({
      eventEmitter: emitter,
      channelRegistry: registry,
      channelKind: "discord",
      chatId: "chat-1",
      runId: "run-2",
      initialDelayMs: 30_000,
    });

    emitter.emit("agent.run.progress", {
      runId: "run-2",
      phase: "executing",
      elapsedMs: 31_000,
      activeTool: "exec",
      subagentCount: 0,
      etaConfidence: "unavailable",
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(plugin.send).toHaveBeenCalledTimes(1);

    emitter.emit("agent.run.progress", {
      runId: "run-2",
      phase: "testing",
      elapsedMs: 46_000,
      subagentCount: 0,
      etaConfidence: "unavailable",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(plugin.send).toHaveBeenCalledTimes(2);
    expect(plugin.send).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining("Current: testing"),
    }));
  });

  it("localizes slow-task updates for Chinese channel requests", async () => {
    const registry = createFridayChannelRegistry();
    const plugin = createMockPlugin("feishu");
    registry.register(plugin);
    await registry.startAll(() => {});

    const emitter = createFridayAgentEventEmitter();
    createFridayChannelSlowTaskNotifier({
      eventEmitter: emitter,
      channelRegistry: registry,
      channelKind: "feishu",
      chatId: "chat-1",
      runId: "run-zh",
      sourceText: "帮我查一下这个问题",
      initialDelayMs: 30_000,
    });

    emitter.emit("agent.run.progress", {
      runId: "run-zh",
      phase: "executing",
      elapsedMs: 31_000,
      subagentCount: 0,
      eta: 45_000,
      etaConfidence: "low",
    });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(plugin.send).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("我还在处理"),
    }));
    expect(plugin.send).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("当前：执行中"),
    }));
    expect(plugin.send).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.not.stringContaining("Still working"),
    }));
  });

  it("stops notifying once the run reaches a terminal state", async () => {
    const registry = createFridayChannelRegistry();
    const plugin = createMockPlugin();
    registry.register(plugin);
    await registry.startAll(() => {});

    const emitter = createFridayAgentEventEmitter();
    createFridayChannelSlowTaskNotifier({
      eventEmitter: emitter,
      channelRegistry: registry,
      channelKind: "discord",
      chatId: "chat-1",
      runId: "run-3",
      initialDelayMs: 30_000,
    });

    emitter.emit("agent.run.progress", {
      runId: "run-3",
      phase: "executing",
      elapsedMs: 31_000,
      subagentCount: 0,
      etaConfidence: "unavailable",
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(plugin.send).toHaveBeenCalledTimes(1);

    emitter.emit("agent.run.completed", {
      runId: "run-3",
      durationMs: 31_000,
      toolCallCount: 1,
      testsPassed: true,
      artifacts: [],
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(plugin.send).toHaveBeenCalledTimes(1);
  });
});

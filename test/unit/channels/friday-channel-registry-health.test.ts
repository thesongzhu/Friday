import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createFridayChannelRegistry,
  type FridayChannelPlugin,
  type FridayChannelMessage,
  type FridayChannelRegistry,
} from "#channels";
import type { FridayChannelStatus } from "../../../../src/channels/friday-channel-adapters.types.js";

function createTestMessage(overrides: Partial<FridayChannelMessage> = {}): FridayChannelMessage {
  return {
    id: "msg-1",
    channelKind: "test",
    senderId: "user-1",
    senderName: "Alice",
    chatId: "chat-1",
    chatType: "group",
    text: "Hello",
    timestamp: Date.now(),
    ...overrides,
  };
}

interface StatusControl {
  currentStatus: FridayChannelStatus;
}

function createMockPluginWithStatus(
  kind: string,
  statusControl: StatusControl,
): FridayChannelPlugin {
  return {
    kind,
    init: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    send: vi.fn(async () => ({ messageId: "sent-1" })),
    adapters: {
      status: {
        status(): FridayChannelStatus {
          return statusControl.currentStatus;
        },
      },
    },
  };
}

function createMockPluginWithLifecycleAndStatus(
  kind: string,
  statusControl: StatusControl,
): FridayChannelPlugin & { _startCount: number } {
  let eventHandler: ((rawEvent: unknown) => void) | null = null;
  let startCount = 0;

  const plugin: FridayChannelPlugin & { _startCount: number } = {
    kind,
    get _startCount() {
      return startCount;
    },
    init: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    send: vi.fn(async () => ({ messageId: "sent-1" })),
    adapters: {
      status: {
        status(): FridayChannelStatus {
          return statusControl.currentStatus;
        },
      },
      lifecycle: {
        async connect(onEvent) {
          eventHandler = onEvent;
          startCount++;
          statusControl.currentStatus = "connected";
        },
        async disconnect() {
          eventHandler = null;
          statusControl.currentStatus = "disconnected";
        },
      },
    },
  };

  return plugin;
}

describe("FridayChannelRegistry Health Monitor", () => {
  let registry: FridayChannelRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = createFridayChannelRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("detects channel reporting 'disconnected' while entry.running=true and auto-restarts", async () => {
    const statusControl: StatusControl = { currentStatus: "connected" };
    const plugin = createMockPluginWithLifecycleAndStatus("discord", statusControl);
    registry.register(plugin);

    const handler = vi.fn();
    await registry.startAll(handler);
    expect(registry.get("discord")!.running).toBe(true);
    expect(plugin._startCount).toBe(1);

    // Start health monitor
    registry.startHealthMonitor(handler, { intervalMs: 100 });

    // Simulate the gateway dropping — status reports disconnected but entry.running is still true
    statusControl.currentStatus = "disconnected";

    // Advance timer to trigger health check
    await vi.advanceTimersByTimeAsync(150);

    // Wait for the restart promise to resolve
    await vi.advanceTimersByTimeAsync(10);

    // Plugin should have been restarted
    expect(plugin._startCount).toBe(2);
    expect(registry.get("discord")!.running).toBe(true);
  });

  it("detects channel reporting 'error' and auto-restarts", async () => {
    const statusControl: StatusControl = { currentStatus: "connected" };
    const plugin = createMockPluginWithLifecycleAndStatus("discord", statusControl);
    registry.register(plugin);

    const handler = vi.fn();
    await registry.startAll(handler);

    registry.startHealthMonitor(handler, { intervalMs: 100 });

    // Simulate error state
    statusControl.currentStatus = "error" as FridayChannelStatus;

    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(10);

    expect(plugin._startCount).toBe(2);
  });

  it("does NOT restart intentionally stopped channels (entry.running=false)", async () => {
    const statusControl: StatusControl = { currentStatus: "connected" };
    const plugin = createMockPluginWithLifecycleAndStatus("discord", statusControl);
    registry.register(plugin);

    const handler = vi.fn();
    await registry.startAll(handler);

    // Intentionally stop
    await registry.stopAll();
    expect(registry.get("discord")!.running).toBe(false);

    // Re-create registry to start fresh health monitor (stopAll cleared it)
    registry = createFridayChannelRegistry();
    const statusControl2: StatusControl = { currentStatus: "disconnected" };
    const plugin2 = createMockPluginWithLifecycleAndStatus("lark", statusControl2);
    registry.register(plugin2);

    // Don't start the channel — it stays running=false
    registry.startHealthMonitor(handler, { intervalMs: 100 });

    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(10);

    // Should not have been started since running=false
    expect(plugin2._startCount).toBe(0);
  });

  it("does NOT restart channels reporting 'connecting'", async () => {
    const statusControl: StatusControl = { currentStatus: "connected" };
    const plugin = createMockPluginWithLifecycleAndStatus("discord", statusControl);
    registry.register(plugin);

    const handler = vi.fn();
    await registry.startAll(handler);
    expect(plugin._startCount).toBe(1);

    registry.startHealthMonitor(handler, { intervalMs: 100 });

    // Channel is reconnecting on its own
    statusControl.currentStatus = "connecting";

    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(10);

    // Should NOT have been restarted — "connecting" means reconnect is in progress
    expect(plugin._startCount).toBe(1);
  });

  it("does NOT restart channels that are 'connected'", async () => {
    const statusControl: StatusControl = { currentStatus: "connected" };
    const plugin = createMockPluginWithLifecycleAndStatus("discord", statusControl);
    registry.register(plugin);

    const handler = vi.fn();
    await registry.startAll(handler);

    registry.startHealthMonitor(handler, { intervalMs: 100 });

    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(10);

    // No restart — channel is healthy
    expect(plugin._startCount).toBe(1);
  });

  it("stopAll() cleans up the health monitor", async () => {
    const statusControl: StatusControl = { currentStatus: "connected" };
    const plugin = createMockPluginWithLifecycleAndStatus("discord", statusControl);
    registry.register(plugin);

    const handler = vi.fn();
    await registry.startAll(handler);

    registry.startHealthMonitor(handler, { intervalMs: 100 });

    // Stop everything (including health monitor)
    await registry.stopAll();

    // Simulate disconnected state
    statusControl.currentStatus = "disconnected";

    // Advance timers — health monitor should be dead
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(10);

    // Only the initial start, no restarts
    expect(plugin._startCount).toBe(1);
  });

  it("stopHealthMonitor() can be called independently", async () => {
    const statusControl: StatusControl = { currentStatus: "connected" };
    const plugin = createMockPluginWithLifecycleAndStatus("discord", statusControl);
    registry.register(plugin);

    const handler = vi.fn();
    await registry.startAll(handler);

    registry.startHealthMonitor(handler, { intervalMs: 100 });
    registry.stopHealthMonitor();

    statusControl.currentStatus = "disconnected";

    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(10);

    expect(plugin._startCount).toBe(1);
  });

  it("does not duplicate restart attempts for the same channel", async () => {
    const statusControl: StatusControl = { currentStatus: "connected" };

    // Create a plugin where lifecycle connect takes a while
    let resolveConnect: (() => void) | null = null;
    let startCount = 0;
    const slowPlugin: FridayChannelPlugin = {
      kind: "slow-discord",
      init: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      send: vi.fn(async () => ({ messageId: "sent-1" })),
      adapters: {
        status: {
          status(): FridayChannelStatus {
            return statusControl.currentStatus;
          },
        },
        lifecycle: {
          async connect(onEvent) {
            startCount++;
            if (startCount > 1) {
              // Second+ call: simulate slow reconnect
              await new Promise<void>((resolve) => {
                resolveConnect = resolve;
              });
            }
            statusControl.currentStatus = "connected";
          },
          async disconnect() {
            statusControl.currentStatus = "disconnected";
          },
        },
      },
    };

    registry.register(slowPlugin);
    const handler = vi.fn();
    await registry.startAll(handler);

    registry.startHealthMonitor(handler, { intervalMs: 100 });

    // Simulate disconnect
    statusControl.currentStatus = "disconnected";

    // First health check triggers restart
    await vi.advanceTimersByTimeAsync(150);

    // Second health check fires while first restart is still pending
    await vi.advanceTimersByTimeAsync(100);

    // Third health check
    await vi.advanceTimersByTimeAsync(100);

    // Should only have attempted restart once (restarting set guards against duplicates)
    expect(startCount).toBe(2); // 1 initial + 1 restart attempt

    // Resolve the pending connect
    if (resolveConnect) resolveConnect();
  });

  it("retries channels that failed during startAllBestEffort", async () => {
    // Simulate a channel that fails on first connect (e.g. network down at boot)
    let connectAttempts = 0;
    const statusControl: StatusControl = { currentStatus: "disconnected" };

    const failingPlugin: FridayChannelPlugin = {
      kind: "discord",
      init: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      send: vi.fn(async () => ({ messageId: "sent-1" })),
      adapters: {
        status: {
          status(): FridayChannelStatus {
            return statusControl.currentStatus;
          },
        },
        lifecycle: {
          async connect() {
            connectAttempts++;
            if (connectAttempts === 1) {
              throw new Error("fetch failed");
            }
            // Second attempt succeeds
            statusControl.currentStatus = "connected";
          },
          async disconnect() {
            statusControl.currentStatus = "disconnected";
          },
        },
      },
    };

    registry.register(failingPlugin);
    const handler = vi.fn();

    // First start fails — channel stays running=false
    const summary = await registry.startAllBestEffort(handler);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0].kind).toBe("discord");
    expect(registry.get("discord")!.running).toBe(false);
    expect(connectAttempts).toBe(1);

    // Start health monitor — should retry failed channels
    registry.startHealthMonitor(handler, { intervalMs: 100 });

    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(10);

    // Second connect attempt should succeed
    expect(connectAttempts).toBe(2);
    expect(registry.get("discord")!.running).toBe(true);
  });

  it("does not retry channels that were never attempted", async () => {
    // Plugin registered but startAllBestEffort never called for it
    const statusControl: StatusControl = { currentStatus: "disconnected" };
    const plugin = createMockPluginWithLifecycleAndStatus("lark", statusControl);
    registry.register(plugin);

    // Don't call startAll or startAllBestEffort — just start health monitor directly
    const handler = vi.fn();
    registry.startHealthMonitor(handler, { intervalMs: 100 });

    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(10);

    // Should NOT have attempted to start — not in failedStart set
    expect(plugin._startCount).toBe(0);
  });

  it("stops retrying failed channel after successful reconnect", async () => {
    let connectAttempts = 0;
    const statusControl: StatusControl = { currentStatus: "disconnected" };

    const failingPlugin: FridayChannelPlugin = {
      kind: "discord",
      init: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      send: vi.fn(async () => ({ messageId: "sent-1" })),
      adapters: {
        status: {
          status(): FridayChannelStatus {
            return statusControl.currentStatus;
          },
        },
        lifecycle: {
          async connect() {
            connectAttempts++;
            if (connectAttempts === 1) {
              throw new Error("fetch failed");
            }
            statusControl.currentStatus = "connected";
          },
          async disconnect() {
            statusControl.currentStatus = "disconnected";
          },
        },
      },
    };

    registry.register(failingPlugin);
    const handler = vi.fn();

    await registry.startAllBestEffort(handler);
    expect(connectAttempts).toBe(1);

    registry.startHealthMonitor(handler, { intervalMs: 100 });

    // First retry succeeds
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(10);
    expect(connectAttempts).toBe(2);
    expect(registry.get("discord")!.running).toBe(true);

    // Subsequent health checks should NOT retry (channel is connected now)
    await vi.advanceTimersByTimeAsync(300);
    expect(connectAttempts).toBe(2); // no additional attempts
  });

  it("handles channels without status adapters gracefully", async () => {
    // Plugin without status adapter — health monitor can't check status, should skip
    const plugin: FridayChannelPlugin = {
      kind: "basic",
      init: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      send: vi.fn(async () => ({ messageId: "sent-1" })),
      // No adapters at all
    };

    registry.register(plugin);
    const handler = vi.fn();
    await registry.startAllBestEffort(handler);

    registry.startHealthMonitor(handler, { intervalMs: 100 });

    await vi.advanceTimersByTimeAsync(500);

    // No restart attempts — status returns undefined, not "disconnected"
    expect(plugin.start).toHaveBeenCalledTimes(1);
  });
});

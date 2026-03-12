import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFridayChannelRegistry,
  type FridayChannelPlugin,
  type FridayChannelMessage,
  type FridayChannelRegistry,
  type FridayChannelAdapters,
  type FridayChannelInboundAdapter,
  type FridayChannelOutboundAdapter,
  type FridayChannelLifecycleAdapter,
  type FridayChannelStatusAdapter,
  type FridayChannelConfigAdapter,
} from "#channels";

// ─── Test Helpers ───

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

function createLegacyPlugin(kind = "legacy"): FridayChannelPlugin {
  return {
    kind,
    init: vi.fn(async () => {}),
    start: vi.fn(async (_onMessage) => {}),
    stop: vi.fn(async () => {}),
    send: vi.fn(async () => ({ messageId: "legacy-sent-1" })),
  };
}

function createAdapterPlugin(
  kind = "adapter",
  adapterOverrides: Partial<FridayChannelAdapters> = {},
): FridayChannelPlugin & { adapters: FridayChannelAdapters } {
  let onEventCallback: ((raw: unknown) => void) | null = null;

  const lifecycle: FridayChannelLifecycleAdapter = {
    connect: vi.fn(async (onEvent) => {
      onEventCallback = onEvent;
    }),
    disconnect: vi.fn(async () => {
      onEventCallback = null;
    }),
  };

  const inbound: FridayChannelInboundAdapter = {
    normalize: vi.fn((rawEvent: unknown) => {
      const raw = rawEvent as Record<string, unknown>;
      if (!raw.id) return null;
      return {
        id: raw.id as string,
        channelKind: kind,
        senderId: (raw.senderId as string) ?? "unknown",
        chatId: (raw.chatId as string) ?? "unknown",
        chatType: "group" as const,
        text: (raw.text as string) ?? "",
        timestamp: Date.now(),
        raw: rawEvent,
      };
    }),
  };

  const outbound: FridayChannelOutboundAdapter = {
    send: vi.fn(async () => ({ messageId: "adapter-sent-1" })),
  };

  const status: FridayChannelStatusAdapter = {
    status: vi.fn().mockReturnValue("connected"),
    diagnostics: vi.fn().mockReturnValue({ uptime: 1000 }),
  };

  const adapters: FridayChannelAdapters = {
    lifecycle,
    inbound,
    outbound,
    status,
    ...adapterOverrides,
  };

  const plugin: FridayChannelPlugin & {
    adapters: FridayChannelAdapters;
    _emitRawEvent: (raw: unknown) => void;
  } = {
    kind,
    init: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    send: vi.fn(async () => ({ messageId: "legacy-fallback" })),
    adapters,
    _emitRawEvent(raw: unknown) {
      onEventCallback?.(raw);
    },
  };

  return plugin;
}

// ─── Tests ───

describe("Channel Registry — Adapter Routing", () => {
  let registry: FridayChannelRegistry;

  beforeEach(() => {
    registry = createFridayChannelRegistry();
  });

  // ─── Lifecycle Adapter ───

  describe("lifecycle adapter", () => {
    it("uses lifecycle.connect instead of plugin.start when adapter present", async () => {
      const plugin = createAdapterPlugin("adapter-ch");
      registry.register(plugin);

      await registry.startAll(() => {});

      expect(plugin.adapters.lifecycle!.connect).toHaveBeenCalled();
      expect(plugin.start).not.toHaveBeenCalled();
      expect(registry.get("adapter-ch")!.running).toBe(true);
    });

    it("uses lifecycle.disconnect instead of plugin.stop when adapter present", async () => {
      const plugin = createAdapterPlugin("adapter-ch");
      registry.register(plugin);

      await registry.startAll(() => {});
      await registry.stopAll();

      expect(plugin.adapters.lifecycle!.disconnect).toHaveBeenCalled();
      expect(plugin.stop).not.toHaveBeenCalled();
      expect(registry.get("adapter-ch")!.running).toBe(false);
    });

    it("uses lifecycle.disconnect on unregister", async () => {
      const plugin = createAdapterPlugin("adapter-ch");
      registry.register(plugin);

      await registry.startAll(() => {});
      await registry.unregister("adapter-ch");

      expect(plugin.adapters.lifecycle!.disconnect).toHaveBeenCalled();
      expect(plugin.stop).not.toHaveBeenCalled();
    });

    it("rolls back adapter-started channels on failure", async () => {
      const goodPlugin = createAdapterPlugin("good");
      const badPlugin = createAdapterPlugin("bad");
      (badPlugin.adapters.lifecycle!.connect as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("connect failed"),
      );

      registry.register(goodPlugin);
      registry.register(badPlugin);

      await expect(registry.startAll(() => {})).rejects.toThrow("Failed to start 1 channel(s)");

      // Good plugin should be rolled back via lifecycle.disconnect
      expect(goodPlugin.adapters.lifecycle!.disconnect).toHaveBeenCalled();
      expect(registry.get("good")!.running).toBe(false);
    });

    it("startAllBestEffort preserves healthy adapter channel when another fails", async () => {
      const goodPlugin = createAdapterPlugin("good");
      const badPlugin = createAdapterPlugin("bad");
      (badPlugin.adapters.lifecycle!.connect as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("connect failed"),
      );

      registry.register(goodPlugin);
      registry.register(badPlugin);

      const summary = await registry.startAllBestEffort(() => {});

      expect(summary.startedKinds).toEqual(["good"]);
      expect(summary.failed).toHaveLength(1);
      expect(summary.failed[0]!.kind).toBe("bad");
      expect(summary.failed[0]!.message).toContain("connect failed");

      expect(registry.get("good")!.running).toBe(true);
      expect(registry.get("bad")!.running).toBe(false);
      expect(goodPlugin.adapters.lifecycle!.disconnect).not.toHaveBeenCalled();
    });
  });

  // ─── Inbound Adapter ───

  describe("inbound adapter", () => {
    it("normalizes raw events through inbound adapter", async () => {
      const plugin = createAdapterPlugin("adapter-ch");
      registry.register(plugin);

      const handler = vi.fn();
      await registry.startAll(handler);

      // Emit a raw event
      (plugin as ReturnType<typeof createAdapterPlugin> & { _emitRawEvent: (raw: unknown) => void })._emitRawEvent({
        id: "raw-1",
        senderId: "user-1",
        chatId: "chat-1",
        text: "Hello from raw",
      });

      expect(plugin.adapters.inbound!.normalize).toHaveBeenCalledWith({
        id: "raw-1",
        senderId: "user-1",
        chatId: "chat-1",
        text: "Hello from raw",
      });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toMatchObject({
        id: "raw-1",
        channelKind: "adapter-ch",
        senderId: "user-1",
      });
    });

    it("drops events when inbound adapter returns null", async () => {
      const plugin = createAdapterPlugin("adapter-ch");
      registry.register(plugin);

      const handler = vi.fn();
      await registry.startAll(handler);

      // Emit an event with no id — our mock normalizer returns null for these
      (plugin as ReturnType<typeof createAdapterPlugin> & { _emitRawEvent: (raw: unknown) => void })._emitRawEvent({
        noId: true,
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it("applies allowlist to adapter-normalized messages", async () => {
      const plugin = createAdapterPlugin("adapter-ch");
      registry.register(plugin, { allowedUsers: ["user-2"] });

      const handler = vi.fn();
      await registry.startAll(handler);

      // Emit event from user-1 (not in allowlist)
      (plugin as ReturnType<typeof createAdapterPlugin> & { _emitRawEvent: (raw: unknown) => void })._emitRawEvent({
        id: "msg-1",
        senderId: "user-1",
        chatId: "chat-1",
        text: "blocked",
      });
      expect(handler).not.toHaveBeenCalled();

      // Emit event from user-2 (in allowlist)
      (plugin as ReturnType<typeof createAdapterPlugin> & { _emitRawEvent: (raw: unknown) => void })._emitRawEvent({
        id: "msg-2",
        senderId: "user-2",
        chatId: "chat-1",
        text: "allowed",
      });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Outbound Adapter ───

  describe("outbound adapter", () => {
    it("sends through outbound adapter when present", async () => {
      const plugin = createAdapterPlugin("adapter-ch");
      registry.register(plugin);
      await registry.startAll(() => {});

      const result = await registry.send("adapter-ch", {
        chatId: "chat-1",
        text: "Hello",
      });

      expect(plugin.adapters.outbound!.send).toHaveBeenCalledWith({
        chatId: "chat-1",
        text: "Hello",
      });
      expect(plugin.send).not.toHaveBeenCalled();
      expect(result.messageId).toBe("adapter-sent-1");
    });

    it("falls back to legacy send when no outbound adapter", async () => {
      const plugin = createAdapterPlugin("adapter-ch", { outbound: undefined });
      registry.register(plugin);
      await registry.startAll(() => {});

      const result = await registry.send("adapter-ch", {
        chatId: "chat-1",
        text: "Hello",
      });

      expect(plugin.send).toHaveBeenCalled();
      expect(result.messageId).toBe("legacy-fallback");
    });
  });

  // ─── Status Adapter ───

  describe("status adapter", () => {
    it("returns status from adapter when present", async () => {
      const plugin = createAdapterPlugin("adapter-ch");
      registry.register(plugin);
      await registry.startAll(() => {});

      const s = registry.status("adapter-ch");
      expect(s).toBe("connected");
      expect(plugin.adapters.status!.status).toHaveBeenCalled();
    });

    it("returns diagnostics from adapter when present", async () => {
      const plugin = createAdapterPlugin("adapter-ch");
      registry.register(plugin);

      const diag = registry.diagnostics("adapter-ch");
      expect(diag).toEqual({ uptime: 1000 });
    });

    it("derives status from running state when no status adapter", async () => {
      const plugin = createLegacyPlugin("legacy-ch");
      registry.register(plugin);

      expect(registry.status("legacy-ch")).toBe("disconnected");

      await registry.startAll(() => {});
      expect(registry.status("legacy-ch")).toBe("connected");
    });

    it("returns disconnected for unknown kind", () => {
      expect(registry.status("nonexistent")).toBe("disconnected");
    });

    it("returns undefined diagnostics for unknown kind", () => {
      expect(registry.diagnostics("nonexistent")).toBeUndefined();
    });

    it("returns undefined diagnostics when no status adapter", () => {
      const plugin = createLegacyPlugin("legacy-ch");
      registry.register(plugin);
      expect(registry.diagnostics("legacy-ch")).toBeUndefined();
    });
  });

  // ─── Mixed Legacy + Adapter Plugins ───

  describe("mixed legacy and adapter plugins", () => {
    it("handles both legacy and adapter plugins in the same registry", async () => {
      const legacyPlugin = createLegacyPlugin("legacy");
      const adapterPlugin = createAdapterPlugin("adapter");

      registry.register(legacyPlugin);
      registry.register(adapterPlugin);

      const handler = vi.fn();
      await registry.startAll(handler);

      // Legacy plugin started via plugin.start
      expect(legacyPlugin.start).toHaveBeenCalled();
      // Adapter plugin started via lifecycle.connect
      expect(adapterPlugin.adapters.lifecycle!.connect).toHaveBeenCalled();

      // Both should be running
      expect(registry.get("legacy")!.running).toBe(true);
      expect(registry.get("adapter")!.running).toBe(true);

      // Send through legacy
      await registry.send("legacy", { chatId: "c", text: "t" });
      expect(legacyPlugin.send).toHaveBeenCalled();

      // Send through adapter
      await registry.send("adapter", { chatId: "c", text: "t" });
      expect(adapterPlugin.adapters.outbound!.send).toHaveBeenCalled();

      // Stop all
      await registry.stopAll();
      expect(legacyPlugin.stop).toHaveBeenCalled();
      expect(adapterPlugin.adapters.lifecycle!.disconnect).toHaveBeenCalled();
    });

    it("routes legacy plugin messages to handler", async () => {
      const legacyPlugin = createLegacyPlugin("legacy");
      registry.register(legacyPlugin);

      const handler = vi.fn();
      await registry.startAll(handler);

      // Simulate legacy plugin calling the handler
      const startCall = (legacyPlugin.start as ReturnType<typeof vi.fn>).mock.calls[0];
      const onMessage = startCall[0] as (msg: FridayChannelMessage) => void;
      const msg = createTestMessage({ channelKind: "legacy" });
      onMessage(msg);

      expect(handler).toHaveBeenCalledWith(msg);
    });
  });

  // ─── Partial Adapter Sets ───

  describe("partial adapter sets", () => {
    it("works with only lifecycle adapter (no inbound)", async () => {
      // When lifecycle is present but inbound is not, raw events are treated as FridayChannelMessage
      const plugin = createAdapterPlugin("partial", { inbound: undefined });
      registry.register(plugin);

      const handler = vi.fn();
      await registry.startAll(handler);

      // Emit a fully-formed FridayChannelMessage as raw event
      const msg = createTestMessage({ channelKind: "partial" });
      (plugin as ReturnType<typeof createAdapterPlugin> & { _emitRawEvent: (raw: unknown) => void })._emitRawEvent(msg);

      expect(handler).toHaveBeenCalledWith(msg);
    });

    it("works with only outbound adapter (no lifecycle)", async () => {
      // Legacy start, but adapter outbound
      const outbound: FridayChannelOutboundAdapter = {
        send: vi.fn(async () => ({ messageId: "adapter-out" })),
      };

      const plugin = createLegacyPlugin("partial-out");
      plugin.adapters = { outbound };
      registry.register(plugin);

      await registry.startAll(() => {});

      // Should use legacy start
      expect(plugin.start).toHaveBeenCalled();

      // But adapter outbound for send
      const result = await registry.send("partial-out", { chatId: "c", text: "t" });
      expect(outbound.send).toHaveBeenCalled();
      expect(result.messageId).toBe("adapter-out");
    });

    it("works with only status adapter", () => {
      const statusAdapter: FridayChannelStatusAdapter = {
        status: vi.fn().mockReturnValue("error"),
        diagnostics: vi.fn().mockReturnValue({ lastError: "timeout" }),
      };

      const plugin = createLegacyPlugin("status-only");
      plugin.adapters = { status: statusAdapter };
      registry.register(plugin);

      expect(registry.status("status-only")).toBe("error");
      expect(registry.diagnostics("status-only")).toEqual({ lastError: "timeout" });
    });
  });
});

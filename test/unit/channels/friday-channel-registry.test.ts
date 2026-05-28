import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFridayChannelRegistry,
  type FridayChannelPlugin,
  type FridayChannelMessage,
  type FridayChannelRegistry,
} from "#channels";

function createMockPlugin(kind = "test", overrides: Partial<FridayChannelPlugin> = {}): FridayChannelPlugin {
  return {
    kind,
    init: vi.fn(async () => {}),
    start: vi.fn(async (onMessage) => {}),
    stop: vi.fn(async () => {}),
    send: vi.fn(async () => ({ messageId: "sent-1" })),
    ...overrides,
  };
}

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

describe("FridayChannelRegistry", () => {
  let registry: FridayChannelRegistry;

  beforeEach(() => {
    registry = createFridayChannelRegistry();
  });

  // ─── Registration ───

  describe("register", () => {
    it("registers a channel plugin", () => {
      const plugin = createMockPlugin("qq");
      registry.register(plugin);
      expect(registry.list()).toEqual(["qq"]);
    });

    it("throws on duplicate kind registration", () => {
      const plugin1 = createMockPlugin("qq");
      const plugin2 = createMockPlugin("qq");
      registry.register(plugin1);
      expect(() => registry.register(plugin2)).toThrow('Channel kind "qq" is already registered');
    });

    it("allows multiple different kinds", () => {
      registry.register(createMockPlugin("qq"));
      registry.register(createMockPlugin("lark"));
      expect(registry.list()).toEqual(["qq", "lark"]);
    });

    it("describes registered channel contracts and diagnostics", () => {
      const plugin = createMockPlugin("discord", {
        contract: {
          coreAuthority: {
            messageRouting: true,
            sessionMirroring: true,
            audit: true,
            evidence: true,
          },
          pluginResponsibilities: {
            config: true,
            auth: true,
            pairing: false,
            outboundDelivery: true,
            threadResolution: true,
            providerRetries: false,
          },
          supports: {
            directMessages: true,
            groupMessages: true,
            threads: true,
            typing: true,
          },
          curatedSkillIds: ["discord-channel-status"],
        },
        adapters: {
          status: {
            status: () => "connected",
            diagnostics: () => ({ mode: "gateway" }),
          },
        },
      });

      registry.register(plugin, { allowedUsers: ["u-1"], allowedChats: ["c-1", "c-2"] });

      expect(registry.describe("discord")).toMatchObject({
        kind: "discord",
        status: "connected",
        health: {
          state: "connected",
          restartCount: 0,
          credentialStatus: "unknown",
        },
        contract: {
          supports: { threads: true },
          curatedSkillIds: ["discord-channel-status"],
        },
        allowlist: {
          hasAllowedUsers: true,
          allowedUsersCount: 1,
          hasAllowedChats: true,
          allowedChatsCount: 2,
        },
      });

      expect(registry.listViews()).toHaveLength(1);
    });
  });

  // ─── Unregistration ───

  describe("unregister", () => {
    it("unregisters a channel plugin", async () => {
      const plugin = createMockPlugin("qq");
      registry.register(plugin);
      await registry.unregister("qq");
      expect(registry.list()).toEqual([]);
    });

    it("stops running plugin on unregister", async () => {
      const plugin = createMockPlugin("qq");
      registry.register(plugin);
      await registry.startAll(() => {});
      await registry.unregister("qq");
      expect(plugin.stop).toHaveBeenCalled();
    });

    it("no-ops for unknown kind", async () => {
      await registry.unregister("nonexistent");
      expect(registry.list()).toEqual([]);
    });
  });

  // ─── Lifecycle ───

  describe("startAll / stopAll", () => {
    it("starts all registered plugins", async () => {
      const p1 = createMockPlugin("qq");
      const p2 = createMockPlugin("lark");
      registry.register(p1);
      registry.register(p2);

      await registry.startAll(() => {});

      expect(p1.start).toHaveBeenCalled();
      expect(p2.start).toHaveBeenCalled();
      expect(registry.get("qq")!.running).toBe(true);
      expect(registry.get("lark")!.running).toBe(true);
    });

    it("stops all running plugins", async () => {
      const p1 = createMockPlugin("qq");
      const p2 = createMockPlugin("lark");
      registry.register(p1);
      registry.register(p2);

      await registry.startAll(() => {});
      await registry.stopAll();

      expect(p1.stop).toHaveBeenCalled();
      expect(p2.stop).toHaveBeenCalled();
      expect(registry.get("qq")!.running).toBe(false);
      expect(registry.get("lark")!.running).toBe(false);
    });

    it("does not start already-running plugins", async () => {
      const plugin = createMockPlugin("qq");
      registry.register(plugin);

      await registry.startAll(() => {});
      await registry.startAll(() => {});

      expect(plugin.start).toHaveBeenCalledTimes(1);
    });

    it("does not stop non-running plugins", async () => {
      const plugin = createMockPlugin("qq");
      registry.register(plugin);

      await registry.stopAll();

      expect(plugin.stop).not.toHaveBeenCalled();
    });

    it("rolls back successful starts when one plugin fails", async () => {
      const goodPlugin = createMockPlugin("qq");
      const badPlugin = createMockPlugin("lark");
      (badPlugin.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Lark connect fail"),
      );

      registry.register(goodPlugin);
      registry.register(badPlugin);

      await expect(registry.startAll(() => {})).rejects.toThrow(
        "Failed to start 1 channel(s)",
      );

      // Good plugin should have been rolled back (stopped)
      expect(goodPlugin.stop).toHaveBeenCalled();
      expect(registry.get("qq")!.running).toBe(false);
    });

    it("startAllBestEffort keeps healthy channels running when one plugin fails", async () => {
      const goodPlugin = createMockPlugin("qq");
      const badPlugin = createMockPlugin("lark");
      (badPlugin.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Lark connect fail"),
      );

      registry.register(goodPlugin);
      registry.register(badPlugin);

      const summary = await registry.startAllBestEffort(() => {});

      expect(summary.startedKinds).toEqual(["qq"]);
      expect(summary.failed).toHaveLength(1);
      expect(summary.failed[0]!.kind).toBe("lark");
      expect(summary.failed[0]!.message).toContain("Lark connect fail");

      expect(registry.get("qq")!.running).toBe(true);
      expect(registry.get("lark")!.running).toBe(false);
      expect(goodPlugin.stop).not.toHaveBeenCalled();
    });
  });

  // ─── Routing ───

  describe("message routing", () => {
    it("routes messages to handler", async () => {
      const plugin = createMockPlugin("qq");
      registry.register(plugin);

      const handler = vi.fn();
      await registry.startAll(handler);

      // Simulate plugin emitting a message via the start callback
      const startCall = (plugin.start as ReturnType<typeof vi.fn>).mock.calls[0];
      const onMessage = startCall[0] as (msg: FridayChannelMessage) => void;

      const msg = createTestMessage({ channelKind: "qq" });
      onMessage(msg);

      expect(handler).toHaveBeenCalledWith(msg);
    });
  });

  // ─── Allowlist ───

  describe("allowlist filtering", () => {
    it("blocks messages from users not in allowedUsers", async () => {
      const plugin = createMockPlugin("qq");
      registry.register(plugin, { allowedUsers: ["user-2"] });

      const handler = vi.fn();
      await registry.startAll(handler);

      const startCall = (plugin.start as ReturnType<typeof vi.fn>).mock.calls[0];
      const onMessage = startCall[0] as (msg: FridayChannelMessage) => void;

      onMessage(createTestMessage({ senderId: "user-1" }));
      expect(handler).not.toHaveBeenCalled();

      onMessage(createTestMessage({ senderId: "user-2" }));
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("blocks messages from chats not in allowedChats", async () => {
      const plugin = createMockPlugin("qq");
      registry.register(plugin, { allowedChats: ["chat-A"] });

      const handler = vi.fn();
      await registry.startAll(handler);

      const startCall = (plugin.start as ReturnType<typeof vi.fn>).mock.calls[0];
      const onMessage = startCall[0] as (msg: FridayChannelMessage) => void;

      onMessage(createTestMessage({ chatId: "chat-B" }));
      expect(handler).not.toHaveBeenCalled();

      onMessage(createTestMessage({ chatId: "chat-A" }));
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("fails closed: a control-capable channel with no allowlist blocks all inbound", async () => {
      // Locked channel policy: a missing allowlist must NOT mean "allow everyone"
      // for control-capable channels (e.g. telegram/discord). Previously this
      // returned true (allow-all) — that was the unsafe direction this flips.
      const plugin = createMockPlugin("telegram");
      registry.register(plugin, {}, { controlCapable: true });

      const handler = vi.fn();
      await registry.startAll(handler);

      const startCall = (plugin.start as ReturnType<typeof vi.fn>).mock.calls[0];
      const onMessage = startCall[0] as (msg: FridayChannelMessage) => void;

      onMessage(createTestMessage());
      expect(handler).not.toHaveBeenCalled();
    });

    it("allows all messages when no allowlist is set for a NON-control channel", async () => {
      // Scope guard: the fail-closed rule is for control-capable channels only.
      // A non-control channel (e.g. the first-party webchat surface) keeps the
      // legacy allow-when-unset behavior.
      const plugin = createMockPlugin("webchat");
      registry.register(plugin); // controlCapable defaults to false

      const handler = vi.fn();
      await registry.startAll(handler);

      const startCall = (plugin.start as ReturnType<typeof vi.fn>).mock.calls[0];
      const onMessage = startCall[0] as (msg: FridayChannelMessage) => void;

      onMessage(createTestMessage());
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("blocks all when allowedUsers is empty array", async () => {
      const plugin = createMockPlugin("qq");
      registry.register(plugin, { allowedUsers: [] });

      const handler = vi.fn();
      await registry.startAll(handler);

      const startCall = (plugin.start as ReturnType<typeof vi.fn>).mock.calls[0];
      const onMessage = startCall[0] as (msg: FridayChannelMessage) => void;

      onMessage(createTestMessage());
      expect(handler).not.toHaveBeenCalled();
    });

    it("allowedGroups mapped to allowedChats filters QQ group messages", async () => {
      // QQ channels use allowedGroups in config, which bootstrap maps to allowedChats.
      // This test verifies the registry correctly filters using allowedChats for group IDs.
      const plugin = createMockPlugin("qq");
      registry.register(plugin, { allowedChats: ["group-A", "group-B"] });

      const handler = vi.fn();
      await registry.startAll(handler);

      const startCall = (plugin.start as ReturnType<typeof vi.fn>).mock.calls[0];
      const onMessage = startCall[0] as (msg: FridayChannelMessage) => void;

      // Group not in allowlist → blocked
      onMessage(createTestMessage({ channelKind: "qq", chatId: "group-C", chatType: "group" }));
      expect(handler).not.toHaveBeenCalled();

      // Group in allowlist → allowed
      onMessage(createTestMessage({ channelKind: "qq", chatId: "group-A", chatType: "group" }));
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("applies both user and chat allowlist together", async () => {
      const plugin = createMockPlugin("qq");
      registry.register(plugin, {
        allowedUsers: ["user-1"],
        allowedChats: ["chat-A"],
      });

      const handler = vi.fn();
      await registry.startAll(handler);

      const startCall = (plugin.start as ReturnType<typeof vi.fn>).mock.calls[0];
      const onMessage = startCall[0] as (msg: FridayChannelMessage) => void;

      // Wrong chat
      onMessage(createTestMessage({ senderId: "user-1", chatId: "chat-B" }));
      expect(handler).not.toHaveBeenCalled();

      // Wrong user
      onMessage(createTestMessage({ senderId: "user-2", chatId: "chat-A" }));
      expect(handler).not.toHaveBeenCalled();

      // Both correct
      onMessage(createTestMessage({ senderId: "user-1", chatId: "chat-A" }));
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Adapter-driven batch normalization ───

  describe("adapter normalizeAll", () => {
    it("awaits normalizeAsync for lifecycle adapter events before routing", async () => {
      let eventHandler: ((rawEvent: unknown) => void) | null = null;

      const plugin: FridayChannelPlugin = {
        kind: "async-test",
        init: vi.fn(async () => {}),
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        send: vi.fn(async () => ({ messageId: "s" })),
        adapters: {
          inbound: {
            normalize: () => null,
            async normalizeAsync(rawEvent: unknown): Promise<FridayChannelMessage | null> {
              const msg = rawEvent as FridayChannelMessage;
              return {
                ...msg,
                text: "normalized async",
                attachments: [
                  {
                    id: "att-1",
                    kind: "image",
                    localPath: "/tmp/friday-channel-attachments/image.png",
                    status: "resolved",
                  },
                ],
              };
            },
          },
          lifecycle: {
            async connect(onEvent) { eventHandler = onEvent; },
            async disconnect() { eventHandler = null; },
          },
        },
      };

      registry.register(plugin);
      const handler = vi.fn();
      await registry.startAll(handler);

      eventHandler!(createTestMessage({ text: "raw" }));

      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      expect(handler.mock.calls[0][0]).toEqual(expect.objectContaining({
        text: "normalized async",
        attachments: [expect.objectContaining({ status: "resolved" })],
      }));
    });

    it("awaits normalizeAllAsync and applies allowlist per normalized message", async () => {
      let eventHandler: ((rawEvent: unknown) => void) | null = null;

      const plugin: FridayChannelPlugin = {
        kind: "async-batch-test",
        init: vi.fn(async () => {}),
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        send: vi.fn(async () => ({ messageId: "s" })),
        adapters: {
          inbound: {
            normalize: () => null,
            async normalizeAllAsync(rawEvent: unknown): Promise<FridayChannelMessage[]> {
              return rawEvent as FridayChannelMessage[];
            },
          },
          lifecycle: {
            async connect(onEvent) { eventHandler = onEvent; },
            async disconnect() { eventHandler = null; },
          },
        },
      };

      registry.register(plugin, { allowedUsers: ["user-1"] });
      const handler = vi.fn();
      await registry.startAll(handler);

      eventHandler!([
        createTestMessage({ senderId: "user-1", text: "Allowed async" }),
        createTestMessage({ senderId: "user-2", text: "Blocked async" }),
      ]);

      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      expect(handler.mock.calls[0][0].text).toBe("Allowed async");
    });

    it("uses normalizeAll to deliver all messages from batch events", async () => {
      // Create a plugin with lifecycle + inbound adapters that simulates batch webhook
      let eventHandler: ((rawEvent: unknown) => void) | null = null;

      const batchPlugin: FridayChannelPlugin = {
        kind: "batch-test",
        init: vi.fn(async () => {}),
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        send: vi.fn(async () => ({ messageId: "s" })),
        adapters: {
          inbound: {
            normalize(rawEvent: unknown): FridayChannelMessage | null {
              // Single-message path: returns first only
              const events = rawEvent as FridayChannelMessage[];
              return events[0] ?? null;
            },
            normalizeAll(rawEvent: unknown): FridayChannelMessage[] {
              // Batch path: returns all
              return rawEvent as FridayChannelMessage[];
            },
          },
          lifecycle: {
            async connect(onEvent) { eventHandler = onEvent; },
            async disconnect() { eventHandler = null; },
          },
        },
      };

      registry.register(batchPlugin);
      const handler = vi.fn();
      await registry.startAll(handler);

      // Simulate a batch event containing 3 messages
      const batchEvent: FridayChannelMessage[] = [
        createTestMessage({ id: "m1", text: "First" }),
        createTestMessage({ id: "m2", text: "Second" }),
        createTestMessage({ id: "m3", text: "Third" }),
      ];

      eventHandler!(batchEvent);

      expect(handler).toHaveBeenCalledTimes(3);
      expect(handler.mock.calls[0][0].text).toBe("First");
      expect(handler.mock.calls[1][0].text).toBe("Second");
      expect(handler.mock.calls[2][0].text).toBe("Third");
    });

    it("falls back to normalize when normalizeAll is not provided", async () => {
      let eventHandler: ((rawEvent: unknown) => void) | null = null;

      const singlePlugin: FridayChannelPlugin = {
        kind: "single-test",
        init: vi.fn(async () => {}),
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        send: vi.fn(async () => ({ messageId: "s" })),
        adapters: {
          inbound: {
            normalize(rawEvent: unknown): FridayChannelMessage | null {
              return rawEvent as FridayChannelMessage;
            },
            // no normalizeAll
          },
          lifecycle: {
            async connect(onEvent) { eventHandler = onEvent; },
            async disconnect() { eventHandler = null; },
          },
        },
      };

      registry.register(singlePlugin);
      const handler = vi.fn();
      await registry.startAll(handler);

      eventHandler!(createTestMessage({ text: "Single" }));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].text).toBe("Single");
    });

    it("applies allowlist to each message in batch", async () => {
      let eventHandler: ((rawEvent: unknown) => void) | null = null;

      const batchPlugin: FridayChannelPlugin = {
        kind: "allowlist-batch",
        init: vi.fn(async () => {}),
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        send: vi.fn(async () => ({ messageId: "s" })),
        adapters: {
          inbound: {
            normalize: () => null,
            normalizeAll(rawEvent: unknown): FridayChannelMessage[] {
              return rawEvent as FridayChannelMessage[];
            },
          },
          lifecycle: {
            async connect(onEvent) { eventHandler = onEvent; },
            async disconnect() { eventHandler = null; },
          },
        },
      };

      // Only allow user-1
      registry.register(batchPlugin, { allowedUsers: ["user-1"] });
      const handler = vi.fn();
      await registry.startAll(handler);

      eventHandler!([
        createTestMessage({ senderId: "user-1", text: "Allowed" }),
        createTestMessage({ senderId: "user-2", text: "Blocked" }),
        createTestMessage({ senderId: "user-1", text: "Also allowed" }),
      ]);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls[0][0].text).toBe("Allowed");
      expect(handler.mock.calls[1][0].text).toBe("Also allowed");
    });
  });

  // ─── Get / Lookup ───

  describe("get", () => {
    it("returns entry for registered kind", () => {
      const plugin = createMockPlugin("qq");
      registry.register(plugin);
      const entry = registry.get("qq");
      expect(entry).toBeDefined();
      expect(entry!.plugin).toBe(plugin);
      expect(entry!.running).toBe(false);
    });

    it("returns undefined for unknown kind", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });
  });

  // ─── Send ───

  describe("send", () => {
    it("sends via the correct channel plugin", async () => {
      const plugin = createMockPlugin("qq");
      registry.register(plugin);
      await registry.startAll(() => {});

      const result = await registry.send("qq", {
        chatId: "chat-1",
        text: "Hello",
      });

      expect(plugin.send).toHaveBeenCalledWith({
        chatId: "chat-1",
        text: "Hello",
      });
      expect(result.messageId).toBe("sent-1");
    });

    it("formats outbound text for plain-text external channels", async () => {
      const plugin = createMockPlugin("lark");
      registry.register(plugin);
      await registry.startAll(() => {});

      await registry.send("lark", {
        chatId: "chat-1",
        text: "**已就绪**\n`**code**`",
      });

      expect(plugin.send).toHaveBeenCalledWith({
        chatId: "chat-1",
        text: "已就绪\n`**code**`",
      });
    });

    it("throws for unregistered kind", async () => {
      await expect(
        registry.send("nonexistent", { chatId: "c", text: "t" }),
      ).rejects.toThrow('Channel kind "nonexistent" is not registered');
    });

    it("throws for non-running channel", async () => {
      registry.register(createMockPlugin("qq"));
      await expect(
        registry.send("qq", { chatId: "c", text: "t" }),
      ).rejects.toThrow('Channel kind "qq" is not running');
    });
  });

  describe("outbound adapter helpers", () => {
    it("calls outbound update adapter when available", async () => {
      const update = vi.fn(async () => ({ messageId: "edited-1" }));
      const plugin: FridayChannelPlugin = {
        kind: "feishu",
        init: vi.fn(async () => {}),
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        send: vi.fn(async () => ({ messageId: "sent-1" })),
        adapters: {
          outbound: {
            send: vi.fn(async () => ({ messageId: "sent-1" })),
            update,
          },
        },
      };

      registry.register(plugin);
      await registry.startAll(() => {});
      await expect(
        registry.update("feishu", "om_progress_1", { chatId: "chat-1", text: "done" }),
      ).resolves.toEqual({ messageId: "edited-1" });

      expect(update).toHaveBeenCalledWith("om_progress_1", { chatId: "chat-1", text: "done" });
    });

    it("formats outbound text before updating external channel messages", async () => {
      const update = vi.fn(async () => ({ messageId: "edited-1" }));
      const plugin: FridayChannelPlugin = {
        kind: "feishu",
        init: vi.fn(async () => {}),
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        send: vi.fn(async () => ({ messageId: "sent-1" })),
        adapters: {
          outbound: {
            send: vi.fn(async () => ({ messageId: "sent-1" })),
            update,
          },
        },
      };

      registry.register(plugin);
      await registry.startAll(() => {});

      await registry.update("feishu", "om_progress_1", {
        chatId: "chat-1",
        text: "**done**",
      });

      expect(update).toHaveBeenCalledWith("om_progress_1", { chatId: "chat-1", text: "done" });
    });

    it("throws when a running channel has no update adapter", async () => {
      const plugin = createMockPlugin("qq");
      registry.register(plugin);
      await registry.startAll(() => {});

      await expect(
        registry.update("qq", "msg-1", { chatId: "chat-1", text: "done" }),
      ).rejects.toThrow('Channel kind "qq" does not support updating sent messages');
    });

    it("calls outbound typing adapter when available", async () => {
      const typing = vi.fn(async () => {});
      const plugin: FridayChannelPlugin = {
        kind: "discord",
        init: vi.fn(async () => {}),
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        send: vi.fn(async () => ({ messageId: "sent-1" })),
        adapters: {
          outbound: {
            send: vi.fn(async () => ({ messageId: "sent-1" })),
            typing,
          },
        },
      };

      registry.register(plugin);
      await registry.startAll(() => {});
      await registry.signalTyping("discord", "chat-typing-1");

      expect(typing).toHaveBeenCalledWith("chat-typing-1");
    });

    it("no-ops when channel has no typing adapter", async () => {
      const plugin = createMockPlugin("qq");
      registry.register(plugin);
      await registry.startAll(() => {});

      await expect(registry.signalTyping("qq", "chat-1")).resolves.toBeUndefined();
    });
  });

  // ─── B1 channel-registry lifecycle precedence ───
  //
  // When a plugin declares both `adapters.lifecycle` AND `plugin.start()`, the
  // registry uses `lifecycle.connect()` exclusively. `plugin.start()` is NOT
  // called by registry-managed activation. Plugins that ship both must keep
  // `start()` as a safe delegate (with a re-entry guard) or a no-op.
  //
  // See:
  //   - FridayChannelPlugin.start docstring in friday-channel.types.ts
  //   - friday-channel-registry.ts buildStartPromise precedence comment
  //   - HANDOFFS/20260524-1240-B1-slice1-qq-pr303-merged.md (QQ unsupported labeling)

  describe("B1 lifecycle precedence: lifecycle.connect() is exclusive", () => {
    it("calls only adapters.lifecycle.connect() — plugin.start() is NOT invoked when both exist", async () => {
      const onConnect = vi.fn(async (_handler: (rawEvent: unknown) => void) => {});
      const onStart = vi.fn(async (_handler: (msg: FridayChannelMessage) => void) => {});
      const plugin = createMockPlugin("with-lifecycle", {
        adapters: {
          lifecycle: {
            connect: onConnect,
            disconnect: async () => {},
          },
        },
        start: onStart,
      });
      registry.register(plugin);

      await registry.startAll(() => {});

      expect(onConnect).toHaveBeenCalledTimes(1);
      expect(onStart).not.toHaveBeenCalled();
    });

    it("falls back to plugin.start() when no adapters.lifecycle is provided", async () => {
      const onStart = vi.fn(async (_handler: (msg: FridayChannelMessage) => void) => {});
      const plugin = createMockPlugin("no-lifecycle", { start: onStart });
      // No adapters.lifecycle.
      registry.register(plugin);

      await registry.startAll(() => {});

      expect(onStart).toHaveBeenCalledTimes(1);
    });

    it("emits an INFO log at register-time when a plugin declares adapters.lifecycle (advises author that start() is bypassed)", () => {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        const plugin = createMockPlugin("with-lifecycle-warn", {
          adapters: {
            lifecycle: {
              connect: async () => {},
              disconnect: async () => {},
            },
          },
        });
        registry.register(plugin);

        expect(infoSpy).toHaveBeenCalledTimes(1);
        const [message] = infoSpy.mock.calls[0]!;
        expect(message).toContain("with-lifecycle-warn");
        expect(message).toContain("lifecycle.connect()");
        expect(message).toContain("plugin.start()");
      } finally {
        infoSpy.mockRestore();
      }
    });

    it("does NOT emit the precedence INFO log when only plugin.start() is provided", () => {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        const plugin = createMockPlugin("legacy-start-only");
        registry.register(plugin);
        // No precedence advisory expected.
        const precedenceLogs = infoSpy.mock.calls.filter(([msg]) =>
          typeof msg === "string" && msg.includes("lifecycle.connect()"),
        );
        expect(precedenceLogs).toHaveLength(0);
      } finally {
        infoSpy.mockRestore();
      }
    });
  });
});

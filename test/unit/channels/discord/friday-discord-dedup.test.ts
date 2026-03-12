/**
 * Discord message deduplication tests — verifies that the same
 * MESSAGE_CREATE event is never processed twice.
 *
 * Covers: gateway reconnect, health monitor restart, rapid re-delivery,
 * and cleanup on disconnect.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFridayDiscordChannel } from "#channels";
import type {
  FridayChannelPlugin,
  FridayChannelMessage,
} from "#channels";
import type {
  DiscordGatewayService,
  DiscordGatewayEvent,
  DiscordGatewayStatusChange,
} from "../../../../src/channels/discord/discord-service.js";

// ─── Mock Services ───

function createMockGateway(): DiscordGatewayService & {
  _onEvent: ((event: DiscordGatewayEvent) => void) | null;
  _onStatusChange: ((status: DiscordGatewayStatusChange) => void) | null;
} {
  let connected = false;
  let onEventFn: ((event: DiscordGatewayEvent) => void) | null = null;
  let onStatusChangeFn: ((status: DiscordGatewayStatusChange) => void) | null = null;

  return {
    get _onEvent() { return onEventFn; },
    get _onStatusChange() { return onStatusChangeFn; },
    async connect(_token, _intents, onEvent, onStatusChange) {
      connected = true;
      onEventFn = onEvent;
      onStatusChangeFn = onStatusChange ?? null;
    },
    async disconnect() {
      connected = false;
      onEventFn = null;
      onStatusChangeFn = null;
    },
    isConnected() { return connected; },
  };
}

function createMockRest() {
  return {
    calls: [] as Array<{ channelId: string; payload: unknown }>,
    typingCalls: [] as string[],
    async sendMessage(_token: string, channelId: string, payload: unknown) {
      this.calls.push({ channelId, payload });
      return { id: `sent-${Date.now()}` };
    },
    async sendTyping(_token: string, channelId: string) {
      this.typingCalls.push(channelId);
    },
  };
}

function makeMessageEvent(id: string, content: string, authorId = "user-1"): DiscordGatewayEvent {
  return {
    op: 0,
    t: "MESSAGE_CREATE",
    s: 1,
    d: {
      id,
      channel_id: "ch-1",
      guild_id: "guild-1",
      author: { id: authorId, username: "testuser", bot: false },
      content,
      timestamp: new Date().toISOString(),
      attachments: [],
      embeds: [],
      mentions: [],
    },
  };
}

const DISCORD_CONFIG = {
  kind: "discord" as const,
  token: "test-token",
  intents: (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15),
  requireMention: false,
};

describe("Discord message deduplication", () => {
  let gateway: ReturnType<typeof createMockGateway>;
  let rest: ReturnType<typeof createMockRest>;
  let plugin: FridayChannelPlugin;

  beforeEach(() => {
    vi.useFakeTimers();
    gateway = createMockGateway();
    rest = createMockRest();
    plugin = createFridayDiscordChannel({ gateway, rest });
    plugin.init(DISCORD_CONFIG);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("processes the first MESSAGE_CREATE normally", async () => {
    const received: FridayChannelMessage[] = [];
    await plugin.adapters!.lifecycle!.connect((event) => {
      const e = event as DiscordGatewayEvent;
      const msg = plugin.adapters!.inbound!.normalize(e);
      if (msg) received.push(msg);
    });

    gateway._onEvent!(makeMessageEvent("msg-1", "Hello"));

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe("Hello");
  });

  it("deduplicates the same message ID sent twice", async () => {
    const received: FridayChannelMessage[] = [];
    await plugin.adapters!.lifecycle!.connect((event) => {
      const e = event as DiscordGatewayEvent;
      const msg = plugin.adapters!.inbound!.normalize(e);
      if (msg) received.push(msg);
    });

    gateway._onEvent!(makeMessageEvent("msg-dup-1", "Hello"));
    gateway._onEvent!(makeMessageEvent("msg-dup-1", "Hello")); // duplicate

    expect(received).toHaveLength(1);
  });

  it("allows different message IDs through", async () => {
    const received: FridayChannelMessage[] = [];
    await plugin.adapters!.lifecycle!.connect((event) => {
      const e = event as DiscordGatewayEvent;
      const msg = plugin.adapters!.inbound!.normalize(e);
      if (msg) received.push(msg);
    });

    gateway._onEvent!(makeMessageEvent("msg-a", "First"));
    gateway._onEvent!(makeMessageEvent("msg-b", "Second"));

    expect(received).toHaveLength(2);
  });

  it("clears seen IDs after TTL expires", async () => {
    const received: FridayChannelMessage[] = [];
    await plugin.adapters!.lifecycle!.connect((event) => {
      const e = event as DiscordGatewayEvent;
      const msg = plugin.adapters!.inbound!.normalize(e);
      if (msg) received.push(msg);
    });

    gateway._onEvent!(makeMessageEvent("msg-ttl", "Hello"));
    expect(received).toHaveLength(1);

    // Advance past TTL (60s)
    vi.advanceTimersByTime(61_000);

    // Same ID should now be accepted again (TTL expired)
    gateway._onEvent!(makeMessageEvent("msg-ttl", "Hello again"));
    expect(received).toHaveLength(2);
  });

  it("clears seen IDs on disconnect", async () => {
    const received: FridayChannelMessage[] = [];
    await plugin.adapters!.lifecycle!.connect((event) => {
      const e = event as DiscordGatewayEvent;
      const msg = plugin.adapters!.inbound!.normalize(e);
      if (msg) received.push(msg);
    });

    gateway._onEvent!(makeMessageEvent("msg-dc", "Before disconnect"));
    expect(received).toHaveLength(1);

    // Disconnect clears the seen set
    await plugin.adapters!.lifecycle!.disconnect();

    // Reconnect
    await plugin.adapters!.lifecycle!.connect((event) => {
      const e = event as DiscordGatewayEvent;
      const msg = plugin.adapters!.inbound!.normalize(e);
      if (msg) received.push(msg);
    });

    // Same message ID should be accepted after reconnect
    gateway._onEvent!(makeMessageEvent("msg-dc", "After reconnect"));
    expect(received).toHaveLength(2);
  });

  it("ignores non-MESSAGE_CREATE events for dedup", async () => {
    const events: unknown[] = [];
    await plugin.adapters!.lifecycle!.connect((event) => {
      events.push(event);
    });

    // Send a non-message event (e.g., READY)
    const readyEvent: DiscordGatewayEvent = { op: 0, t: "READY", s: 1, d: {} };
    gateway._onEvent!(readyEvent);
    gateway._onEvent!(readyEvent); // duplicate READY — should still pass through

    expect(events).toHaveLength(2);
  });

  it("deduplicates across rapid-fire re-delivery", async () => {
    const received: FridayChannelMessage[] = [];
    await plugin.adapters!.lifecycle!.connect((event) => {
      const e = event as DiscordGatewayEvent;
      const msg = plugin.adapters!.inbound!.normalize(e);
      if (msg) received.push(msg);
    });

    // Simulate gateway re-delivering 5 copies of the same message
    for (let i = 0; i < 5; i++) {
      gateway._onEvent!(makeMessageEvent("msg-rapid", "Spammed message"));
    }

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe("Spammed message");
  });
});

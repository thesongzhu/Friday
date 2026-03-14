/**
 * OC-004: Inbound message debouncer for channel messages.
 *
 * Buffers rapid-fire messages from the same author in the same chat,
 * then combines them into a single synthetic message before forwarding
 * to the handler. Bypass for attachments and commands.
 */

import type { FridayChannelMessage } from "./friday-channel.types.js";

// ─── Types ───

export interface FridayChannelInboundDebouncer {
  /** Submit a message. It may be buffered and forwarded after the debounce window. */
  submit(msg: FridayChannelMessage): void;
  /** Flush all pending messages immediately (for shutdown). */
  flush(): void;
  /** Cancel all pending timers (for cleanup). */
  destroy(): void;
}

export interface CreateInboundDebouncerOptions {
  /** Downstream handler to invoke with the (possibly combined) message. */
  handler: (msg: FridayChannelMessage) => void;
  /** Debounce window in ms. 0 = passthrough (no debouncing). */
  windowMs: number;
  /** Bypass debounce for messages with images/attachments. Default: true. */
  bypassForAttachments?: boolean;
  /** Bypass debounce for messages starting with /. Default: true. */
  bypassForCommands?: boolean;
}

// ─── Factory ───

export function createFridayChannelInboundDebouncer(
  options: CreateInboundDebouncerOptions,
): FridayChannelInboundDebouncer {
  const { handler, windowMs } = options;
  const bypassForAttachments = options.bypassForAttachments ?? true;
  const bypassForCommands = options.bypassForCommands ?? true;

  // Passthrough mode when windowMs is 0
  if (windowMs <= 0) {
    return {
      submit(msg) { handler(msg); },
      flush() {},
      destroy() {},
    };
  }

  const buffers = new Map<string, { messages: FridayChannelMessage[]; timer: ReturnType<typeof setTimeout> }>();

  function buildKey(msg: FridayChannelMessage): string {
    return `${msg.channelKind}:${msg.senderId}:${msg.chatId}`;
  }

  function shouldBypass(msg: FridayChannelMessage): boolean {
    if (bypassForAttachments && msg.images && msg.images.length > 0) return true;
    if (bypassForCommands && msg.text.startsWith("/")) return true;
    return false;
  }

  function combineMessages(messages: FridayChannelMessage[]): FridayChannelMessage {
    if (messages.length === 1) return messages[0]!;
    const last = messages[messages.length - 1]!;
    const combinedText = messages.map((m) => m.text).join("\n");
    const combinedImages = messages.flatMap((m) => m.images ?? []);
    const timezone = [...messages].reverse().find((m) => typeof m.timezone === "string" && m.timezone.trim().length > 0)?.timezone;
    return {
      ...last,
      text: combinedText,
      images: combinedImages.length > 0 ? combinedImages : undefined,
      timezone,
    };
  }

  function flushKey(key: string): void {
    const entry = buffers.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    buffers.delete(key);
    handler(combineMessages(entry.messages));
  }

  return {
    submit(msg: FridayChannelMessage): void {
      const key = buildKey(msg);

      if (shouldBypass(msg)) {
        // Flush any pending buffer for this key first, then forward immediately
        if (buffers.has(key)) flushKey(key);
        handler(msg);
        return;
      }

      const existing = buffers.get(key);
      if (existing) {
        existing.messages.push(msg);
        // Reset the timer
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => flushKey(key), windowMs);
      } else {
        const timer = setTimeout(() => flushKey(key), windowMs);
        buffers.set(key, { messages: [msg], timer });
      }
    },

    flush(): void {
      for (const key of [...buffers.keys()]) {
        flushKey(key);
      }
    },

    destroy(): void {
      for (const [, entry] of buffers) {
        clearTimeout(entry.timer);
      }
      buffers.clear();
    },
  };
}

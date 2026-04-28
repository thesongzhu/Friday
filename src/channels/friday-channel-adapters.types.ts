/**
 * Channel Adapter type definitions.
 *
 * Adapters provide a modular, pluggable architecture on top of the existing
 * FridayChannelPlugin interface. Each adapter handles a specific concern:
 * config validation, inbound normalization, outbound formatting, status,
 * and lifecycle/gateway management.
 *
 * Plugins can optionally attach adapters for fine-grained control while
 * maintaining full backward compatibility with the legacy plugin interface.
 */

import type { FridayChannelMessage, FridayChannelSendOptions } from "./friday-channel.types.js";

// ─── Config Adapter ───

/**
 * Validates and normalizes raw configuration for a channel.
 * Returns a strongly-typed config object or throws on invalid input.
 */
export interface FridayChannelConfigAdapter<TConfig = Record<string, unknown>> {
  /** Validate and normalize raw config input. Throws on invalid config. */
  validate(raw: Record<string, unknown>): TConfig;
  /** Return default config values (for documentation/bootstrapping). */
  defaults(): Partial<TConfig>;
}

// ─── Inbound Normalize Adapter ───

/**
 * Normalizes platform-specific inbound events into FridayChannelMessage.
 * Handles the conversion from raw platform payloads to the unified message format.
 */
export interface FridayChannelInboundAdapter {
  /**
   * Normalize a raw platform event into a FridayChannelMessage.
   * Returns null if the event should be ignored (e.g. unsupported event type).
   */
  normalize(rawEvent: unknown): FridayChannelMessage | null;

  /**
   * Normalize a raw platform event asynchronously. Channels that must resolve
   * private platform resources (for example Feishu image_key/file_key) should
   * implement this so the registry can await channel-owned attachment work
   * before routing to Friday.
   */
  normalizeAsync?(rawEvent: unknown): Promise<FridayChannelMessage | null>;

  /**
   * Normalize a raw platform event that may contain multiple messages (batch webhooks).
   * When provided, the registry uses this instead of `normalize` to avoid dropping
   * messages in batch payloads (e.g. WhatsApp, LINE).
   * If not provided, falls back to `normalize` (single message).
   */
  normalizeAll?(rawEvent: unknown): FridayChannelMessage[];

  /**
   * Async batch variant for channels that receive batches and must resolve
   * private platform resources before forwarding messages.
   */
  normalizeAllAsync?(rawEvent: unknown): Promise<FridayChannelMessage[]>;
}

// ─── Outbound Adapter ───

/**
 * Formats and sends outbound messages to the platform.
 * Handles platform-specific serialization and API calls.
 */
export interface FridayChannelOutboundAdapter {
  /**
   * Send a message through the platform.
   * Returns the platform-assigned message ID.
   */
  send(options: FridayChannelSendOptions): Promise<{ messageId: string }>;

  /**
   * Optionally update a message previously sent by this bot.
   * Channels that do not support message editing can omit it.
   */
  update?(messageId: string, options: FridayChannelSendOptions): Promise<{ messageId: string }>;

  /**
   * Optionally signal "typing..." (or equivalent) to a chat.
   * Channels that do not support this can omit it.
   */
  typing?(chatId: string): Promise<void>;
}

// ─── Status Adapter ───

/** Channel connection status. */
export type FridayChannelStatus = "disconnected" | "connecting" | "connected" | "error";

/**
 * Provides current channel status and diagnostics.
 */
export interface FridayChannelStatusAdapter {
  /** Get current connection status. */
  status(): FridayChannelStatus;
  /** Optional diagnostic info (e.g. last error, uptime, latency). */
  diagnostics?(): Record<string, unknown>;
}

// ─── Lifecycle / Gateway Adapter ───

/**
 * Manages connection lifecycle: connect, disconnect, reconnect.
 * Handles gateway/websocket connections and event subscriptions.
 */
export interface FridayChannelLifecycleAdapter {
  /** Open connection to the platform gateway. */
  connect(onEvent: (rawEvent: unknown) => void): Promise<void>;
  /** Gracefully disconnect from the platform gateway. */
  disconnect(): Promise<void>;
  /** Force reconnect (e.g. after token refresh or error recovery). */
  reconnect?(): Promise<void>;
}

// ─── Composite Adapter Set ───

/**
 * A bundle of adapters that a channel plugin can optionally provide.
 * All fields are optional — the registry falls back to legacy plugin methods
 * for any adapter that is not supplied.
 */
export interface FridayChannelAdapters<TConfig = Record<string, unknown>> {
  config?: FridayChannelConfigAdapter<TConfig>;
  inbound?: FridayChannelInboundAdapter;
  outbound?: FridayChannelOutboundAdapter;
  status?: FridayChannelStatusAdapter;
  lifecycle?: FridayChannelLifecycleAdapter;
}

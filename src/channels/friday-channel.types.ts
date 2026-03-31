/**
 * Core channel interface types for the Friday channel plugin system.
 *
 * These are the simplified runtime types used by the channel registry
 * and concrete channel implementations (QQ, Lark, etc.).
 * They complement the richer plugin-layer types in
 * `src/plugins/channels/friday-channel-plugin.types.ts`.
 */

import type { FridayChannelAdapters } from "./friday-channel-adapters.types.js";

export interface FridayChannelCoreAuthority {
  messageRouting: true;
  sessionMirroring: true;
  audit: true;
  evidence: true;
}

export interface FridayChannelPluginResponsibilities {
  config: boolean;
  auth: boolean;
  pairing: boolean;
  outboundDelivery: boolean;
  threadResolution: boolean;
  providerRetries: boolean;
}

export interface FridayChannelSupportProfile {
  directMessages: boolean;
  groupMessages: boolean;
  threads: boolean;
  typing: boolean;
}

/** Tool restriction policy for a channel instance (Initiative H.2). */
export interface FridayChannelToolRestrictions {
  /** If set, only these tools are allowed. Takes precedence over blocklist. */
  allowlist?: string[];
  /** If set, these tools are blocked. Ignored when allowlist is present. */
  blocklist?: string[];
}

export interface FridayChannelCapabilityContract {
  coreAuthority: FridayChannelCoreAuthority;
  pluginResponsibilities: FridayChannelPluginResponsibilities;
  supports: FridayChannelSupportProfile;
  curatedSkillIds?: string[];
  /** Per-channel tool restrictions (Initiative H.2). */
  toolRestrictions?: FridayChannelToolRestrictions;
}

// ─── Inbound Message ───

export interface FridayChannelMessage {
  /** Unique message ID from the source platform. */
  id: string;
  /** Channel plugin kind identifier (e.g. "qq", "lark", "discord"). */
  channelKind: string;
  /** Platform-specific sender identifier. */
  senderId: string;
  /** Optional sender display name. */
  senderName?: string;
  /** Platform-specific conversation/room/group identifier. */
  chatId: string;
  /** Whether this is a direct message or group message. */
  chatType: "direct" | "group";
  /** Message text content. */
  text: string;
  /** Optional image URLs or file paths. */
  images?: string[];
  /** ID of the message being replied to, if any. */
  replyTo?: string;
  /** OC-006: Thread or topic ID for thread-aware session routing. */
  threadId?: string;
  /** Platform-specific raw event payload. */
  raw?: unknown;
  /** Optional sender timezone when the channel can resolve it. */
  timezone?: string;
  /** Unix timestamp in milliseconds. */
  timestamp: number;
}

// ─── Outbound Send Options ───

export interface FridayChannelSendOptions {
  /** Target conversation/room/group identifier. */
  chatId: string;
  /** Text content to send. */
  text: string;
  /** Optional image URLs or file paths to attach. */
  images?: string[];
  /** Optional message ID to reply to. */
  replyTo?: string;
}

// ─── Channel Plugin Interface ───

export interface FridayChannelPlugin {
  /** Channel kind identifier (e.g. "qq", "lark"). */
  readonly kind: string;

  /**
   * Initialize the plugin with configuration.
   * Validates config, resolves credentials, prepares clients.
   */
  init(config: Record<string, unknown>): Promise<void>;

  /**
   * Start receiving messages.
   * Opens gateway/websocket connections and begins message ingestion.
   * Calls `onMessage` for each inbound message.
   */
  start(onMessage: (msg: FridayChannelMessage) => void): Promise<void>;

  /**
   * Stop receiving messages and clean up resources.
   * Closes streams and flushes in-flight state.
   */
  stop(): Promise<void>;

  /**
   * Send a message through this channel.
   * Returns the platform-assigned message ID.
   */
  send(options: FridayChannelSendOptions): Promise<{ messageId: string }>;

  /**
   * Optional contract metadata that makes the channel/core boundary explicit.
   * Core remains authoritative for routing, session mirroring, audit, and evidence.
   */
  contract?: FridayChannelCapabilityContract;

  /**
   * Optional adapter set for modular channel architecture.
   * When present, the registry routes through adapters instead of
   * (or in addition to) the legacy init/start/stop/send methods.
   * All adapters are optional — missing adapters fall back to legacy behavior.
   */
  adapters?: FridayChannelAdapters;
}

// ─── Tool Restriction Helpers (Initiative H.2) ───

/**
 * Apply channel tool restrictions to a list of tool names.
 * Returns the filtered list of allowed tool names.
 */
export function applyChannelToolRestrictions(
  toolNames: string[],
  restrictions: FridayChannelToolRestrictions | undefined,
): string[] {
  if (!restrictions) return toolNames;

  if (restrictions.allowlist && restrictions.allowlist.length > 0) {
    const allowed = new Set(restrictions.allowlist);
    return toolNames.filter((name) => allowed.has(name));
  }

  if (restrictions.blocklist && restrictions.blocklist.length > 0) {
    const blocked = new Set(restrictions.blocklist);
    return toolNames.filter((name) => !blocked.has(name));
  }

  return toolNames;
}

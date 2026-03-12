/**
 * Channel plugin interface types.
 *
 * All channel plugins (bundled core channels like Discord/Telegram and
 * third-party channel plugins) implement FridayChannelPlugin.
 */

// ─── Channel Capabilities ───

export type FridayChannelChatKind = "dm" | "group" | "channel" | "thread";

export interface FridayChannelCapabilities {
  chatKinds: FridayChannelChatKind[];
  supportsTyping?: boolean;
  supportsThreads?: boolean;
  supportsReactions?: boolean;
  supportsEdits?: boolean;
  supportsDeletes?: boolean;
  maxMessageLength?: number;
}

// ─── Inbound Message ───

export interface FridayInboundChannelMessage {
  /** Unique message ID from the source platform. */
  messageId: string;
  /** Channel plugin ID (e.g. "discord", "telegram"). */
  channelId: string;
  /** Platform-specific conversation/room identifier. */
  conversationId: string;
  /** Platform-specific sender identifier. */
  senderId: string;
  /** Optional sender display name. */
  senderName?: string;
  /** Message text content. */
  content: string;
  /** Chat kind of this message. */
  chatKind: FridayChannelChatKind;
  /** ISO 8601 timestamp from the source platform. */
  timestamp: string;
  /** ID of the message being replied to, if any. */
  replyToMessageId?: string;
  /** Optional thread ID. */
  threadId?: string;
  /** Optional attachments. */
  attachments?: FridayChannelAttachment[];
  /** Platform-specific metadata. */
  metadata?: Record<string, unknown>;
}

export interface FridayChannelAttachment {
  id: string;
  filename: string;
  contentType: string;
  url: string;
  size?: number;
}

// ─── Outbound Message ───

export interface FridayChannelSendMessageInput {
  /** Platform-specific conversation/room identifier. */
  conversationId: string;
  /** Text content to send. */
  content: string;
  /** Optional thread ID to reply in. */
  threadId?: string;
  /** Optional ID of message to reply to. */
  replyToMessageId?: string;
  /** Optional attachments. */
  attachments?: FridayChannelOutboundAttachment[];
  /** Platform-specific metadata. */
  metadata?: Record<string, unknown>;
}

export interface FridayChannelOutboundAttachment {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface FridayChannelSendMessageResult {
  /** Platform-assigned ID of the sent message. */
  messageId: string;
  /** ISO 8601 timestamp when the message was delivered. */
  deliveredAt: string;
}

// ─── Delivery Events ───

export type FridayChannelDeliveryEventKind =
  | "delivered"
  | "read"
  | "failed"
  | "edited"
  | "deleted";

export interface FridayChannelDeliveryEvent {
  messageId: string;
  channelId: string;
  conversationId: string;
  kind: FridayChannelDeliveryEventKind;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// ─── Runtime Context (provided to channel plugins by the host) ───

export interface FridayChannelRuntimeContext {
  /** Called by the channel plugin when an inbound message arrives. */
  onInboundMessage(message: FridayInboundChannelMessage): Promise<void>;
  /** Called by the channel plugin when a delivery event occurs. */
  onDeliveryEvent?(event: FridayChannelDeliveryEvent): Promise<void>;
}

// ─── Channel Plugin Interface ───

export interface FridayChannelPlugin {
  /** Plugin-level channel identifier (e.g. "discord", "telegram"). */
  channelId: string;
  /** Capabilities supported by this channel. */
  capabilities: FridayChannelCapabilities;
  /** Start the channel plugin (connect to platform, begin receiving). */
  start(ctx: FridayChannelRuntimeContext): Promise<void>;
  /** Stop the channel plugin (disconnect, cease receiving). */
  stop(ctx: FridayChannelRuntimeContext): Promise<void>;
  /** Send a message through this channel. */
  sendMessage(input: FridayChannelSendMessageInput): Promise<FridayChannelSendMessageResult>;
}

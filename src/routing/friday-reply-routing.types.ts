/**
 * Reply Routing Types — Route context, queued reply, and delivery result
 * types for ensuring replies reach the correct originating channel.
 *
 * @module routing/friday-reply-routing.types
 */

// ─── Route Context ───

/**
 * Captured per-session inbound route context — records where a message
 * originated so outbound replies can be routed back correctly.
 */
export interface FridayReplyRouteContext {
  readonly sessionKey: string;
  readonly channelKind: string;
  readonly channelId: string;
  readonly chatId: string;
  readonly threadId?: string;
  readonly replyToMessageId?: string;
  readonly senderId: string;
  readonly capturedAt: string;
}

// ─── Send Policy ───

export type FridayReplySendPolicy = "allow" | "block" | "queue";

// ─── Queued Reply ───

export interface FridayQueuedReply {
  readonly id: string;
  readonly sessionKey: string;
  readonly channelKind: string;
  readonly channelId: string;
  readonly chatId: string;
  readonly threadId?: string;
  readonly replyToMessageId?: string;
  readonly text: string;
  readonly metadata?: Record<string, unknown>;
  readonly status: "queued" | "delivered" | "failed" | "dead_letter";
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: string;
  readonly nextRetryAt: string;
  readonly lastError?: string;
}

// ─── Delivery Result ───

export type FridayReplyDeliveryResult =
  | { ok: true; messageId: string; deliveredAt: string }
  | { ok: false; error: string; retryable: boolean };

// ─── Destination Resolution ───

export type FridayReplyDestination =
  | { source: "explicit"; channelKind: string; channelId: string; chatId: string; threadId?: string; replyToMessageId?: string }
  | { source: "session_route"; channelKind: string; channelId: string; chatId: string; threadId?: string; replyToMessageId?: string }
  | { source: "fallback"; channelKind: string; channelId: string; chatId: string };

// ─── Configuration ───

export interface FridayReplyRoutingConfig {
  /** Default send policy when none is set on the session. */
  readonly defaultSendPolicy: FridayReplySendPolicy;
  /** Maximum retry attempts for queued replies. */
  readonly maxRetryAttempts: number;
  /** Base delay for exponential backoff (ms). */
  readonly retryBaseDelayMs: number;
  /** Maximum age for queued replies before expiry (ms). */
  readonly queueMaxAgeMs: number;
  /** Drain job interval (ms). */
  readonly drainIntervalMs: number;
  /** Drain job jitter (ms). */
  readonly drainJitterMs: number;
  /** Maximum batch size for drain runs. */
  readonly drainBatchSize: number;
}

export const DEFAULT_REPLY_ROUTING_CONFIG: FridayReplyRoutingConfig = {
  defaultSendPolicy: "allow",
  maxRetryAttempts: 5,
  retryBaseDelayMs: 5_000,
  queueMaxAgeMs: 24 * 60 * 60 * 1000, // 24 hours
  drainIntervalMs: 30_000,
  drainJitterMs: 5_000,
  drainBatchSize: 50,
};

/**
 * Reply Routing Service — Orchestrates outbound reply delivery by resolving
 * the best destination, enforcing send policy, and queuing undeliverable
 * replies for later retry.
 *
 * Resolution priority: explicit override > session route > fallback.
 *
 * @module routing/friday-reply-routing-service
 */

import type {
  FridayQueuedReply,
  FridayReplyDeliveryResult,
  FridayReplyDestination,
  FridayReplyRouteContext,
  FridayReplyRoutingConfig,
  FridayReplySendPolicy,
} from "./friday-reply-routing.types.js";
import { DEFAULT_REPLY_ROUTING_CONFIG } from "./friday-reply-routing.types.js";
import type { FridayReplyRouteRepository } from "./friday-reply-route-repository.js";
import type { FridayReplyQueueRepository } from "./friday-reply-queue-repository.js";

// ─── Deps ───

export interface FridayReplyRoutingServiceDeps {
  readonly routeRepo: FridayReplyRouteRepository;
  readonly queueRepo: FridayReplyQueueRepository;
  readonly config?: FridayReplyRoutingConfig;
  readonly nowIso: () => string;
  readonly generateId: () => string;

  /** Deliver a message to a channel. */
  readonly deliver: (destination: {
    channelKind: string;
    channelId: string;
    chatId: string;
    threadId?: string;
    replyToMessageId?: string;
    text: string;
  }) => Promise<FridayReplyDeliveryResult>;

  /** Resolve the send policy for a session. */
  readonly getSendPolicy: (sessionKey: string) => FridayReplySendPolicy | null;

  /** Fallback destination when no route context exists. */
  readonly fallbackDestination?: {
    channelKind: string;
    channelId: string;
    chatId: string;
  };
}

// ─── Interface ───

export interface FridayReplyRoutingService {
  /** Capture inbound route context for a session. */
  captureRoute(context: Omit<FridayReplyRouteContext, "capturedAt">): void;

  /** Resolve where a reply should go. */
  resolveDestination(
    sessionKey: string,
    explicitOverride?: { channelKind: string; channelId: string; chatId: string; threadId?: string; replyToMessageId?: string },
  ): FridayReplyDestination | null;

  /** Send a reply, respecting send policy and queueing if needed. */
  sendReply(input: {
    sessionKey: string;
    text: string;
    metadata?: Record<string, unknown>;
    explicitOverride?: { channelKind: string; channelId: string; chatId: string; threadId?: string; replyToMessageId?: string };
  }): Promise<FridayReplyDeliveryResult | { ok: false; error: string; queued: true; queuedReplyId: string } | { ok: false; error: string; blocked: true }>;

  /** Get the route context for a session. */
  getRouteContext(sessionKey: string): FridayReplyRouteContext | null;
}

// ─── Factory ───

export function createFridayReplyRoutingService(
  deps: FridayReplyRoutingServiceDeps,
): FridayReplyRoutingService {
  const config = deps.config ?? DEFAULT_REPLY_ROUTING_CONFIG;

  return {
    captureRoute(context) {
      deps.routeRepo.set({
        ...context,
        capturedAt: deps.nowIso(),
      });
    },

    resolveDestination(sessionKey, explicitOverride) {
      // Priority 1: Explicit override
      if (explicitOverride) {
        return {
          source: "explicit",
          channelKind: explicitOverride.channelKind,
          channelId: explicitOverride.channelId,
          chatId: explicitOverride.chatId,
          threadId: explicitOverride.threadId,
          replyToMessageId: explicitOverride.replyToMessageId,
        };
      }

      // Priority 2: Session route context
      const route = deps.routeRepo.get(sessionKey);
      if (route) {
        return {
          source: "session_route",
          channelKind: route.channelKind,
          channelId: route.channelId,
          chatId: route.chatId,
          threadId: route.threadId,
          replyToMessageId: route.replyToMessageId,
        };
      }

      // Priority 3: Fallback
      if (deps.fallbackDestination) {
        return {
          source: "fallback",
          channelKind: deps.fallbackDestination.channelKind,
          channelId: deps.fallbackDestination.channelId,
          chatId: deps.fallbackDestination.chatId,
        };
      }

      return null;
    },

    async sendReply(input) {
      // Resolve destination
      const destination = this.resolveDestination(input.sessionKey, input.explicitOverride);
      if (!destination) {
        return { ok: false, error: "No route found for session", retryable: false };
      }

      // Check send policy
      const policy = deps.getSendPolicy(input.sessionKey) ?? config.defaultSendPolicy;

      if (policy === "block") {
        return { ok: false, error: "Send policy blocked", blocked: true };
      }

      if (policy === "queue") {
        const queuedReply: FridayQueuedReply = {
          id: deps.generateId(),
          sessionKey: input.sessionKey,
          channelKind: destination.channelKind,
          channelId: destination.channelId,
          chatId: destination.chatId,
          threadId: "threadId" in destination ? destination.threadId : undefined,
          replyToMessageId: "replyToMessageId" in destination ? destination.replyToMessageId : undefined,
          text: input.text,
          metadata: input.metadata,
          status: "queued",
          attempts: 0,
          maxAttempts: config.maxRetryAttempts,
          createdAt: deps.nowIso(),
          nextRetryAt: deps.nowIso(),
        };
        deps.queueRepo.enqueue(queuedReply);
        return { ok: false, error: "Send policy requires queueing", queued: true, queuedReplyId: queuedReply.id };
      }

      // Policy is "allow" — deliver immediately
      const result = await deps.deliver({
        channelKind: destination.channelKind,
        channelId: destination.channelId,
        chatId: destination.chatId,
        threadId: "threadId" in destination ? destination.threadId : undefined,
        replyToMessageId: "replyToMessageId" in destination ? destination.replyToMessageId : undefined,
        text: input.text,
      });

      // If delivery failed and retryable, queue it
      if (!result.ok && result.retryable) {
        const queuedReply: FridayQueuedReply = {
          id: deps.generateId(),
          sessionKey: input.sessionKey,
          channelKind: destination.channelKind,
          channelId: destination.channelId,
          chatId: destination.chatId,
          threadId: "threadId" in destination ? destination.threadId : undefined,
          replyToMessageId: "replyToMessageId" in destination ? destination.replyToMessageId : undefined,
          text: input.text,
          metadata: input.metadata,
          status: "queued",
          attempts: 1,
          maxAttempts: config.maxRetryAttempts,
          createdAt: deps.nowIso(),
          nextRetryAt: new Date(new Date(deps.nowIso()).getTime() + config.retryBaseDelayMs).toISOString(),
          lastError: result.error,
        };
        deps.queueRepo.enqueue(queuedReply);
        return { ok: false, error: result.error, queued: true, queuedReplyId: queuedReply.id };
      }

      return result;
    },

    getRouteContext(sessionKey) {
      return deps.routeRepo.get(sessionKey);
    },
  };
}

/**
 * LINE Messaging API service — stubbed interfaces.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

// ─── Types ───

export interface LineWebhookEvent {
  type: "message" | "follow" | "unfollow" | "join" | "leave" | "postback";
  replyToken: string;
  source: {
    type: "user" | "group" | "room";
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  timestamp: number;
  message?: {
    id: string;
    type: "text" | "image" | "video" | "audio" | "file" | "location" | "sticker";
    text?: string;
    contentProvider?: {
      type: "line" | "external";
      originalContentUrl?: string;
    };
  };
}

export interface LineWebhookPayload {
  destination: string;
  events: LineWebhookEvent[];
}

export interface LineSendPayload {
  to: string;
  messages: Array<{
    type: "text";
    text: string;
  }>;
}

export interface LineReplyPayload {
  replyToken: string;
  messages: Array<{
    type: "text";
    text: string;
  }>;
}

// ─── Service Interface ───

export interface LineWebhookListenerService {
  /** Start listening for webhook events. */
  start(
    webhookPath: string,
    channelSecret: string,
    onEvent: (payload: LineWebhookPayload) => void,
  ): Promise<void>;
  /** Stop the webhook listener. */
  stop(): Promise<void>;
  /** Check if listener is running. */
  isListening(): boolean;
  /**
   * Optional HTTP relay entrypoint used by the API runtime route.
   * Returns status metadata so the caller can map to HTTP response codes.
   */
  handleHttpWebhook?(
    rawBody: string,
    signature: string | undefined,
  ): LineWebhookRelayResult;
}

export interface LineWebhookRelayResult {
  accepted: boolean;
  statusCode: number;
  code?: "LINE_SIGNATURE_MISSING" | "LINE_SIGNATURE_INVALID" | "LINE_PAYLOAD_INVALID" | "LINE_LISTENER_INACTIVE";
}

export interface LineApiService {
  /** Send a push message. */
  pushMessage(
    channelAccessToken: string,
    payload: LineSendPayload,
  ): Promise<void>;

  /** Reply to a webhook event. */
  replyMessage(
    channelAccessToken: string,
    payload: LineReplyPayload,
  ): Promise<void>;
}

/**
 * Validate a LINE webhook signature.
 *
 * LINE signs the raw request body with HMAC-SHA256 (key = channel secret)
 * and sends the Base64 digest in `X-Line-Signature`.
 */
export function validateLineWebhookSignature(
  payload: string,
  signature: string,
  channelSecret: string,
): boolean {
  if (!signature || !channelSecret) return false;
  try {
    const expectedBase64 = createHmac("sha256", channelSecret)
      .update(payload, "utf-8")
      .digest("base64");
    const received = Buffer.from(signature, "base64");
    const expected = Buffer.from(expectedBase64, "base64");
    if (received.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(received, expected);
  } catch {
    return false;
  }
}

// ─── Stub Implementations ───

export function createLineWebhookListenerServiceStub(): LineWebhookListenerService {
  let listening = false;

  return {
    async start(_webhookPath, _channelSecret, _onEvent) {
      listening = true;
      // Stub: in production, starts HTTP server with signature validation
    },
    async stop() {
      listening = false;
    },
    isListening() {
      return listening;
    },
    handleHttpWebhook() {
      return {
        accepted: false,
        statusCode: 503,
        code: "LINE_LISTENER_INACTIVE",
      };
    },
  };
}

/**
 * Real in-process LINE webhook relay.
 *
 * The HTTP listener itself lives in the API runtime HTTP server; this relay
 * stores lifecycle state and validates/dispatches inbound webhook payloads.
 */
export function createLineWebhookListenerService(): LineWebhookListenerService {
  let listening = false;
  let currentSecret = "";
  let onEvent: ((payload: LineWebhookPayload) => void) | null = null;

  return {
    async start(_webhookPath, channelSecret, handler) {
      listening = true;
      currentSecret = channelSecret;
      onEvent = handler;
    },
    async stop() {
      listening = false;
      currentSecret = "";
      onEvent = null;
    },
    isListening() {
      return listening;
    },
    handleHttpWebhook(rawBody, signature) {
      if (!listening || !onEvent) {
        return {
          accepted: false,
          statusCode: 503,
          code: "LINE_LISTENER_INACTIVE",
        };
      }
      if (!signature) {
        return {
          accepted: false,
          statusCode: 401,
          code: "LINE_SIGNATURE_MISSING",
        };
      }
      if (!validateLineWebhookSignature(rawBody, signature, currentSecret)) {
        return {
          accepted: false,
          statusCode: 403,
          code: "LINE_SIGNATURE_INVALID",
        };
      }

      try {
        const payload = JSON.parse(rawBody) as LineWebhookPayload;
        onEvent(payload);
        return {
          accepted: true,
          statusCode: 200,
        };
      } catch {
        return {
          accepted: false,
          statusCode: 400,
          code: "LINE_PAYLOAD_INVALID",
        };
      }
    },
  };
}

export function createLineApiServiceStub(): LineApiService {
  return {
    async pushMessage(_channelAccessToken, _payload) {
      // Stub: POST https://api.line.me/v2/bot/message/push
    },
    async replyMessage(_channelAccessToken, _payload) {
      // Stub: POST https://api.line.me/v2/bot/message/reply
    },
  };
}

// ─── Real Implementation ───

/**
 * Create a real LINE Messaging API service that sends push and reply
 * messages via the LINE platform REST endpoints.
 */
export function createLineApiService(): LineApiService {
  /**
   * Shared helper for POSTing JSON to a LINE API endpoint with
   * Bearer authentication.
   */
  async function linePost(
    url: string,
    channelAccessToken: string,
    body: unknown,
  ): Promise<void> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${channelAccessToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "<unreadable>");
      throw new Error(
        `LINE API error: ${response.status} ${response.statusText} — ${errorBody}`,
      );
    }
  }

  return {
    async pushMessage(
      channelAccessToken: string,
      payload: LineSendPayload,
    ): Promise<void> {
      await linePost(
        "https://api.line.me/v2/bot/message/push",
        channelAccessToken,
        payload,
      );
    },

    async replyMessage(
      channelAccessToken: string,
      payload: LineReplyPayload,
    ): Promise<void> {
      await linePost(
        "https://api.line.me/v2/bot/message/reply",
        channelAccessToken,
        payload,
      );
    },
  };
}

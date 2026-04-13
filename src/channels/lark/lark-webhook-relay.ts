/**
 * Lark webhook relay service.
 *
 * The channel plugin owns event normalization/business logic while this relay
 * owns HTTP webhook ingress state and challenge/event dispatch semantics.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface LarkWebhookRelayResult {
  accepted: boolean;
  statusCode: number;
  challenge?: string;
  code?:
    | "LARK_LISTENER_INACTIVE"
    | "LARK_PAYLOAD_INVALID"
    | "LARK_EVENT_IGNORED"
    | "LARK_SIGNATURE_MISSING"
    | "LARK_SIGNATURE_INVALID";
}

export interface LarkWebhookRelayService {
  start(onEvent: (event: Record<string, unknown>) => void): Promise<void>;
  stop(): Promise<void>;
  isListening(): boolean;
  setAppSecret(secret: string): void;
  handleHttpWebhook(
    rawBody: string,
    signatureHeader?: string,
    timestampHeader?: string,
    nonceHeader?: string,
  ): LarkWebhookRelayResult;
}

/**
 * Validate Lark webhook signature using HMAC-SHA256.
 * Lark signs: sha256(timestamp + nonce + appSecret)
 * See: https://open.larksuite.com/document/server-docs/event-subscription-guide/event-subscription-configure-/request-verification
 */
export function validateLarkWebhookSignature(
  timestamp: string,
  nonce: string,
  appSecret: string,
  expectedSignature: string,
): boolean {
  try {
    const content = timestamp + nonce + appSecret;
    const computedHex = createHmac("sha256", "")
      .update(content, "utf-8")
      .digest("hex");

    const computedBuf = Buffer.from(computedHex, "hex");
    const receivedBuf = Buffer.from(expectedSignature, "hex");

    if (computedBuf.length !== receivedBuf.length) {
      return false;
    }
    return timingSafeEqual(computedBuf, receivedBuf);
  } catch {
    return false;
  }
}

export function createLarkWebhookRelayService(): LarkWebhookRelayService {
  let listening = false;
  let onEvent: ((event: Record<string, unknown>) => void) | null = null;
  let appSecret: string | null = null;

  return {
    setAppSecret(secret) {
      appSecret = secret;
    },
    async start(handler) {
      listening = true;
      onEvent = handler;
    },
    async stop() {
      listening = false;
      onEvent = null;
    },
    isListening() {
      return listening;
    },
    handleHttpWebhook(rawBody, signatureHeader, timestampHeader, nonceHeader) {
      if (!listening || !onEvent) {
        return {
          accepted: false,
          statusCode: 503,
          code: "LARK_LISTENER_INACTIVE",
        };
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(rawBody) as Record<string, unknown>;
      } catch (err) {
        console.warn("[friday][lark-webhook-relay] operation failed:", err instanceof Error ? err.message : String(err));
        return {
          accepted: false,
          statusCode: 400,
          code: "LARK_PAYLOAD_INVALID",
        };
      }

      // URL verification challenge event — skip signature check (Lark sends this before signing is active).
      if (payload.type === "url_verification") {
        return {
          accepted: true,
          statusCode: 200,
          challenge: typeof payload.challenge === "string" ? payload.challenge : "",
        };
      }

      // Signature validation: enforce if appSecret is configured.
      if (appSecret && appSecret.length > 0) {
        if (!signatureHeader || !timestampHeader || !nonceHeader) {
          return {
            accepted: false,
            statusCode: 401,
            code: "LARK_SIGNATURE_MISSING",
          };
        }
        if (!validateLarkWebhookSignature(timestampHeader, nonceHeader, appSecret, signatureHeader)) {
          return {
            accepted: false,
            statusCode: 403,
            code: "LARK_SIGNATURE_INVALID",
          };
        }
      }

      const header = payload.header as Record<string, unknown> | undefined;
      const eventType = typeof header?.event_type === "string" ? header.event_type : undefined;
      if (eventType === "im.message.receive_v1") {
        onEvent(payload);
        return {
          accepted: true,
          statusCode: 200,
        };
      }

      return {
        accepted: true,
        statusCode: 200,
        code: "LARK_EVENT_IGNORED",
      };
    },
  };
}

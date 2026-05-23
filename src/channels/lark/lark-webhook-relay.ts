/**
 * Lark webhook relay service.
 *
 * The channel plugin owns event normalization/business logic while this relay
 * owns HTTP webhook ingress state and challenge/event dispatch semantics.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export interface LarkWebhookRelayResult {
  accepted: boolean;
  statusCode: number;
  challenge?: string;
  code?:
    | "LARK_LISTENER_INACTIVE"
    | "LARK_PAYLOAD_INVALID"
    | "LARK_EVENT_IGNORED"
    | "LARK_TOKEN_UNCONFIGURED"
    | "LARK_TOKEN_MISSING"
    | "LARK_TOKEN_INVALID"
    | "LARK_SIGNATURE_MISSING"
    | "LARK_SIGNATURE_INVALID";
}

export interface LarkWebhookRelayService {
  start(onEvent: (event: Record<string, unknown>) => void): Promise<void>;
  stop(): Promise<void>;
  isListening(): boolean;
  setVerificationToken(token?: string): void;
  setEncryptKey(key?: string): void;
  handleHttpWebhook(
    rawBody: string,
    signatureHeader?: string,
    timestampHeader?: string,
    nonceHeader?: string,
  ): LarkWebhookRelayResult;
}

/**
 * Validate Lark webhook signature using the official event callback contract:
 * sha256(timestamp + nonce + encryptKey + rawBody)
 */
export function validateLarkWebhookSignature(
  timestamp: string,
  nonce: string,
  encryptKey: string,
  rawBody: string,
  expectedSignature: string,
): boolean {
  try {
    const normalizedSignature = expectedSignature.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalizedSignature)) {
      return false;
    }

    const content = timestamp + nonce + encryptKey + rawBody;
    const computedHex = createHash("sha256")
      .update(content, "utf-8")
      .digest("hex");

    const computedBuf = Buffer.from(computedHex, "hex");
    const receivedBuf = Buffer.from(normalizedSignature, "hex");

    if (computedBuf.length !== receivedBuf.length) {
      return false;
    }
    return timingSafeEqual(computedBuf, receivedBuf);
  } catch {
    return false;
  }
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function createLarkWebhookRelayService(): LarkWebhookRelayService {
  let listening = false;
  let onEvent: ((event: Record<string, unknown>) => void) | null = null;
  let verificationToken: string | null = null;
  let encryptKey: string | null = null;

  function extractPayloadToken(payload: Record<string, unknown>): string | undefined {
    if (typeof payload.token === "string" && payload.token.length > 0) {
      return payload.token;
    }
    const header = payload.header as Record<string, unknown> | undefined;
    return typeof header?.token === "string" && header.token.length > 0
      ? header.token
      : undefined;
  }

  return {
    setVerificationToken(token) {
      verificationToken = token?.trim() ? token.trim() : null;
    },
    setEncryptKey(key) {
      encryptKey = key?.trim() ? key.trim() : null;
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

      const payloadToken = extractPayloadToken(payload);

      if (payload.type === "url_verification") {
        if (!verificationToken) {
          return {
            accepted: false,
            statusCode: 503,
            code: "LARK_TOKEN_UNCONFIGURED",
          };
        }
        if (!payloadToken) {
          return {
            accepted: false,
            statusCode: 401,
            code: "LARK_TOKEN_MISSING",
          };
        }
        if (!constantTimeStringEqual(payloadToken, verificationToken)) {
          return {
            accepted: false,
            statusCode: 403,
            code: "LARK_TOKEN_INVALID",
          };
        }
        return {
          accepted: true,
          statusCode: 200,
          challenge: typeof payload.challenge === "string" ? payload.challenge : "",
        };
      }

      if (!verificationToken) {
        return {
          accepted: false,
          statusCode: 503,
          code: "LARK_TOKEN_UNCONFIGURED",
        };
      }
      if (!payloadToken) {
        return {
          accepted: false,
          statusCode: 401,
          code: "LARK_TOKEN_MISSING",
        };
      }
      if (!constantTimeStringEqual(payloadToken, verificationToken)) {
        return {
          accepted: false,
          statusCode: 403,
          code: "LARK_TOKEN_INVALID",
        };
      }

      if (encryptKey) {
        if (!signatureHeader || !timestampHeader || !nonceHeader) {
          return {
            accepted: false,
            statusCode: 401,
            code: "LARK_SIGNATURE_MISSING",
          };
        }
        if (!validateLarkWebhookSignature(timestampHeader, nonceHeader, encryptKey, rawBody, signatureHeader)) {
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

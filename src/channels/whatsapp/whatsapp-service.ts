/**
 * WhatsApp Cloud API / Bridge service — stubbed interfaces.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

// ─── Webhook Signature Validation ───

/**
 * Validate a Meta webhook signature using HMAC-SHA256.
 * Meta signs the raw payload body with the App Secret and sends the signature
 * in the `X-Hub-Signature-256` header as `sha256=<hex>`.
 *
 * @param payload  The raw request body string
 * @param signature  The value of the X-Hub-Signature-256 header (e.g. "sha256=abc123...")
 * @param appSecret  The Meta App Secret
 * @returns true if the signature is valid
 */
export function validateWhatsappWebhookSignature(
  payload: string,
  signature: string,
  appSecret: string,
): boolean {
  const expectedPrefix = "sha256=";
  if (!signature.startsWith(expectedPrefix)) {
    return false;
  }

  try {
    const receivedHex = signature.slice(expectedPrefix.length);
    const expectedHex = createHmac("sha256", appSecret)
      .update(payload, "utf-8")
      .digest("hex");

    // Use timing-safe comparison to prevent timing attacks
    const receivedBuf = Buffer.from(receivedHex, "hex");
    const expectedBuf = Buffer.from(expectedHex, "hex");

    // Buffer.from(str, "hex") silently drops non-hex chars, so buffers may
    // differ in length even when the source hex strings don't.  Guard against
    // timingSafeEqual throwing on mismatched lengths.
    if (receivedBuf.length !== expectedBuf.length) {
      return false;
    }

    return timingSafeEqual(receivedBuf, expectedBuf);
  } catch {
    // Defensive: any unexpected error → treat as invalid
    return false;
  }
}

// ─── Types ───

export interface WhatsappWebhookMessage {
  object: "whatsapp_business_account";
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: "whatsapp";
        metadata: {
          display_phone_number: string;
          phone_number_id: string;
        };
        contacts?: Array<{
          profile: { name: string };
          wa_id: string;
        }>;
        messages?: Array<{
          from: string;
          id: string;
          timestamp: string;
          text?: { body: string };
          image?: { id: string; mime_type: string; caption?: string };
          type: "text" | "image" | "audio" | "video" | "document" | "location" | "reaction";
        }>;
        statuses?: Array<{
          id: string;
          status: "delivered" | "read" | "sent" | "failed";
          timestamp: string;
          recipient_id: string;
        }>;
      };
      field: string;
    }>;
  }>;
}

export interface WhatsappSendPayload {
  messaging_product: "whatsapp";
  to: string;
  type: "text";
  text: { body: string };
  context?: { message_id: string };
}

export interface WhatsappSendResponse {
  messages: Array<{ id: string }>;
}

// ─── Service Interface ───

export interface WhatsappWebhookService {
  /** Start listening for webhook events. */
  startWebhook(
    verifyToken: string,
    onEvent: (event: WhatsappWebhookMessage) => void,
  ): Promise<void>;
  /** Stop webhook listener. */
  stopWebhook(): Promise<void>;
  /** Check if webhook is listening. */
  isListening(): boolean;
  /** Optional: set app secret for X-Hub-Signature-256 verification. */
  setAppSecret?(appSecret: string | undefined): void;
  /** Optional: handle Meta GET verification challenge. */
  handleVerificationChallenge?(
    mode: string | undefined,
    token: string | undefined,
    challenge: string | undefined,
  ): WhatsappWebhookVerificationResult;
  /** Optional: handle Meta inbound webhook POST relay. */
  handleHttpWebhook?(
    rawBody: string,
    signature: string | undefined,
  ): WhatsappWebhookRelayResult;
}

export interface WhatsappWebhookVerificationResult {
  accepted: boolean;
  statusCode: number;
  challenge?: string;
  code?: "WHATSAPP_LISTENER_INACTIVE" | "WHATSAPP_VERIFY_FAILED";
}

export interface WhatsappWebhookRelayResult {
  accepted: boolean;
  statusCode: number;
  code?:
    | "WHATSAPP_LISTENER_INACTIVE"
    | "WHATSAPP_SIGNATURE_MISSING"
    | "WHATSAPP_SIGNATURE_INVALID"
    | "WHATSAPP_PAYLOAD_INVALID";
}

export interface WhatsappApiService {
  /** Send a text message via Cloud API. */
  sendMessage(
    accessToken: string,
    phoneNumberId: string,
    payload: WhatsappSendPayload,
  ): Promise<WhatsappSendResponse>;
}

// ─── Stub Implementations ───

export function createWhatsappWebhookServiceStub(): WhatsappWebhookService {
  let listening = false;

  return {
    async startWebhook(_verifyToken, _onEvent) {
      listening = true;
      // Stub: in production, sets up HTTP webhook endpoint
    },
    async stopWebhook() {
      listening = false;
    },
    isListening() {
      return listening;
    },
    setAppSecret() {
      // no-op
    },
    handleVerificationChallenge() {
      return {
        accepted: false,
        statusCode: 503,
        code: "WHATSAPP_LISTENER_INACTIVE",
      };
    },
    handleHttpWebhook() {
      return {
        accepted: false,
        statusCode: 503,
        code: "WHATSAPP_LISTENER_INACTIVE",
      };
    },
  };
}

/**
 * Real in-process WhatsApp webhook relay.
 *
 * The HTTP server route forwards GET/POST webhook requests into this relay.
 * This service stores verification token/app secret and dispatch callback.
 */
export function createWhatsappWebhookService(): WhatsappWebhookService {
  let listening = false;
  let verifyToken = "";
  let appSecret = "";
  let onEvent: ((event: WhatsappWebhookMessage) => void) | null = null;

  return {
    async startWebhook(nextVerifyToken, handler) {
      listening = true;
      verifyToken = nextVerifyToken;
      onEvent = handler;
    },
    async stopWebhook() {
      listening = false;
      verifyToken = "";
      appSecret = "";
      onEvent = null;
    },
    isListening() {
      return listening;
    },
    setAppSecret(nextAppSecret) {
      appSecret = nextAppSecret ?? "";
    },
    handleVerificationChallenge(mode, token, challenge) {
      if (!listening) {
        return {
          accepted: false,
          statusCode: 503,
          code: "WHATSAPP_LISTENER_INACTIVE",
        };
      }
      if (mode === "subscribe" && token === verifyToken) {
        return {
          accepted: true,
          statusCode: 200,
          challenge: challenge ?? "",
        };
      }
      return {
        accepted: false,
        statusCode: 403,
        code: "WHATSAPP_VERIFY_FAILED",
      };
    },
    handleHttpWebhook(rawBody, signature) {
      if (!listening || !onEvent) {
        return {
          accepted: false,
          statusCode: 503,
          code: "WHATSAPP_LISTENER_INACTIVE",
        };
      }

      if (appSecret.length > 0) {
        if (!signature) {
          return {
            accepted: false,
            statusCode: 401,
            code: "WHATSAPP_SIGNATURE_MISSING",
          };
        }
        if (!validateWhatsappWebhookSignature(rawBody, signature, appSecret)) {
          return {
            accepted: false,
            statusCode: 403,
            code: "WHATSAPP_SIGNATURE_INVALID",
          };
        }
      }

      try {
        const payload = JSON.parse(rawBody) as WhatsappWebhookMessage;
        onEvent(payload);
        return {
          accepted: true,
          statusCode: 200,
        };
      } catch {
        return {
          accepted: false,
          statusCode: 400,
          code: "WHATSAPP_PAYLOAD_INVALID",
        };
      }
    },
  };
}

export function createWhatsappApiServiceStub(): WhatsappApiService {
  return {
    async sendMessage(_accessToken, _phoneNumberId, _payload) {
      // Stub: POST https://graph.facebook.com/v18.0/{phoneNumberId}/messages
      return { messages: [{ id: `wamid.stub-${Date.now()}` }] };
    },
  };
}

// ─── Real Implementation ───

/**
 * Create a real WhatsApp Cloud API service that sends messages via the
 * Graph API v21.0 endpoint.
 */
export function createWhatsappApiService(): WhatsappApiService {
  return {
    async sendMessage(
      accessToken: string,
      phoneNumberId: string,
      payload: WhatsappSendPayload,
    ): Promise<WhatsappSendResponse> {
      const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}/messages`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "<unreadable>");
        throw new Error(
          `WhatsApp Cloud API error: ${response.status} ${response.statusText} — ${errorBody}`,
        );
      }

      const json = (await response.json()) as WhatsappSendResponse;
      return json;
    },
  };
}

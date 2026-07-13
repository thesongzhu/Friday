/**
 * Lark webhook relay service.
 *
 * The channel plugin owns event normalization/business logic while this relay
 * owns HTTP webhook ingress state and challenge/event dispatch semantics.
 */

import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

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
    | "LARK_SIGNATURE_INVALID"
    | "LARK_DECRYPT_FAILED";
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

/**
 * Decrypt a Lark/Feishu event-encryption envelope.
 *
 * When an "Encrypt Key" is configured on the Lark app, the platform POSTs
 * `{"encrypt":"<base64>"}` instead of the plaintext payload. The scheme
 * (per Lark/Feishu event subscription docs) is:
 *   - AES-256-CBC with PKCS7 padding
 *   - key    = sha256(encryptKey)                       (32 bytes)
 *   - buffer = base64_decode(encrypt)
 *   - iv     = buffer[0..16], ciphertext = buffer[16..]
 *   - plaintext = JSON string of the real event / url_verification payload
 *
 * Returns the parsed plaintext object, or null if the envelope is malformed,
 * undecryptable, or does not decode to a JSON object (never throws).
 */
function decryptLarkEnvelope(
  encrypted: string,
  encryptKey: string,
): Record<string, unknown> | null {
  try {
    const aesKey = createHash("sha256").update(encryptKey, "utf8").digest();
    const buffer = Buffer.from(encrypted, "base64");
    if (buffer.length <= 16) {
      return null;
    }
    const iv = buffer.subarray(0, 16);
    const ciphertext = buffer.subarray(16);
    const decipher = createDecipheriv("aes-256-cbc", aesKey, iv);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

type LarkPayloadResolution =
  | { ok: true; payload: Record<string, unknown>; encryptMode: boolean }
  | { ok: false; result: LarkWebhookRelayResult };

/**
 * Resolve the effective payload for dispatch.
 *
 * In encrypt mode (an Encrypt Key is configured AND the body carries an
 * `encrypt` envelope) the signature — computed over the RAW encrypted body — is
 * verified FIRST, then the envelope is decrypted so the real event flows through
 * the same downstream token + dispatch checks. Non-encrypt mode (no encryptKey
 * OR no `encrypt` field) returns the parsed body unchanged with encryptMode
 * false, preserving the legacy path byte-for-byte.
 */
function resolveLarkPayload(
  payload: Record<string, unknown>,
  encryptKey: string | null,
  rawBody: string,
  signatureHeader?: string,
  timestampHeader?: string,
  nonceHeader?: string,
): LarkPayloadResolution {
  const encryptEnvelope = typeof payload.encrypt === "string" ? payload.encrypt : null;
  if (encryptKey === null || encryptEnvelope === null) {
    return { ok: true, payload, encryptMode: false };
  }
  if (!signatureHeader || !timestampHeader || !nonceHeader) {
    return { ok: false, result: { accepted: false, statusCode: 401, code: "LARK_SIGNATURE_MISSING" } };
  }
  if (!validateLarkWebhookSignature(timestampHeader, nonceHeader, encryptKey, rawBody, signatureHeader)) {
    return { ok: false, result: { accepted: false, statusCode: 403, code: "LARK_SIGNATURE_INVALID" } };
  }
  const decrypted = decryptLarkEnvelope(encryptEnvelope, encryptKey);
  if (decrypted === null) {
    return { ok: false, result: { accepted: false, statusCode: 400, code: "LARK_DECRYPT_FAILED" } };
  }
  return { ok: true, payload: decrypted, encryptMode: true };
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

      // Encrypt mode (Encrypt Key configured + `{"encrypt":...}` envelope):
      // verify the signature over the raw body, decrypt, and continue with the
      // decrypted payload. Non-encrypt mode is passed through unchanged.
      const resolution = resolveLarkPayload(
        payload,
        encryptKey,
        rawBody,
        signatureHeader,
        timestampHeader,
        nonceHeader,
      );
      if (!resolution.ok) {
        return resolution.result;
      }
      payload = resolution.payload;
      const encryptMode = resolution.encryptMode;

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

      if (encryptKey && !encryptMode) {
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

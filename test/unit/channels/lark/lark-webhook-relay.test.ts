import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createLarkWebhookRelayService,
  validateLarkWebhookSignature,
} from "#channels";

function sign(timestamp: string, nonce: string, encryptKey: string, rawBody: string): string {
  return createHash("sha256")
    .update(`${timestamp}${nonce}${encryptKey}${rawBody}`, "utf-8")
    .digest("hex");
}

/**
 * Encrypt a plaintext payload with the exact Lark/Feishu event-encryption
 * scheme the relay must decrypt: AES-256-CBC, key = sha256(encryptKey),
 * random 16-byte IV prepended to the ciphertext, base64-encoded.
 */
function larkEncrypt(plaintext: string, encryptKey: string, iv = randomBytes(16)): string {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, ciphertext]).toString("base64");
}

describe("lark-webhook-relay", () => {
  it("accepts the official sha256(timestamp+nonce+encryptKey+body) signature", () => {
    const rawBody = JSON.stringify({
      schema: "2.0",
      header: { event_type: "im.message.receive_v1", token: "verify-token" },
      event: {},
    });
    const signature = sign("1700000000", "nonce-1", "encrypt-key-1", rawBody);

    expect(
      validateLarkWebhookSignature("1700000000", "nonce-1", "encrypt-key-1", rawBody, signature),
    ).toBe(true);
  });

  it("rejects the legacy broken signature shape", () => {
    const rawBody = JSON.stringify({
      schema: "2.0",
      header: { event_type: "im.message.receive_v1", token: "verify-token" },
      event: {},
    });
    const brokenLegacySignature = createHash("sha256")
      .update("1700000000nonce-1encrypt-key-1", "utf-8")
      .digest("hex");

    expect(
      validateLarkWebhookSignature(
        "1700000000",
        "nonce-1",
        "encrypt-key-1",
        rawBody,
        brokenLegacySignature,
      ),
    ).toBe(false);
  });

  it("rejects event callbacks when verification token is not configured", async () => {
    const relay = createLarkWebhookRelayService();
    await relay.start(() => {});

    const rawBody = JSON.stringify({
      schema: "2.0",
      header: { event_type: "im.message.receive_v1" },
      event: {},
    });

    expect(relay.handleHttpWebhook(rawBody)).toEqual({
      accepted: false,
      statusCode: 503,
      code: "LARK_TOKEN_UNCONFIGURED",
    });
  });

  it("rejects mismatched verification tokens before dispatch", async () => {
    const relay = createLarkWebhookRelayService();
    relay.setVerificationToken("verify-token");
    await relay.start(() => {});

    const rawBody = JSON.stringify({
      schema: "2.0",
      header: { event_type: "im.message.receive_v1", token: "wrong-token" },
      event: {},
    });

    expect(relay.handleHttpWebhook(rawBody)).toEqual({
      accepted: false,
      statusCode: 403,
      code: "LARK_TOKEN_INVALID",
    });
  });

  it("requires signature headers when encrypt key verification is enabled", async () => {
    const relay = createLarkWebhookRelayService();
    relay.setVerificationToken("verify-token");
    relay.setEncryptKey("encrypt-key");
    await relay.start(() => {});

    const rawBody = JSON.stringify({
      schema: "2.0",
      header: { event_type: "im.message.receive_v1", token: "verify-token" },
      event: {},
    });

    expect(relay.handleHttpWebhook(rawBody)).toEqual({
      accepted: false,
      statusCode: 401,
      code: "LARK_SIGNATURE_MISSING",
    });
  });

  it("dispatches only when token and signature are both valid", async () => {
    const relay = createLarkWebhookRelayService();
    const received: Array<Record<string, unknown>> = [];
    relay.setVerificationToken("verify-token");
    relay.setEncryptKey("encrypt-key");
    await relay.start((payload) => {
      received.push(payload);
    });

    const rawBody = JSON.stringify({
      schema: "2.0",
      header: { event_type: "im.message.receive_v1", token: "verify-token" },
      event: { message: { message_id: "om_1" } },
    });
    const signature = sign("1700000000", "nonce-1", "encrypt-key", rawBody);

    expect(
      relay.handleHttpWebhook(rawBody, signature, "1700000000", "nonce-1"),
    ).toEqual({
      accepted: true,
      statusCode: 200,
    });
    expect(received).toHaveLength(1);
  });

  it("verifies url challenge with verification token instead of blindly echoing", async () => {
    const relay = createLarkWebhookRelayService();
    relay.setVerificationToken("verify-token");
    await relay.start(() => {});

    const accepted = relay.handleHttpWebhook(JSON.stringify({
      type: "url_verification",
      token: "verify-token",
      challenge: "challenge-1",
    }));
    const rejected = relay.handleHttpWebhook(JSON.stringify({
      type: "url_verification",
      token: "wrong-token",
      challenge: "challenge-2",
    }));

    expect(accepted).toEqual({
      accepted: true,
      statusCode: 200,
      challenge: "challenge-1",
    });
    expect(rejected).toEqual({
      accepted: false,
      statusCode: 403,
      code: "LARK_TOKEN_INVALID",
    });
  });

  describe("encrypt mode (Encrypt Key configured)", () => {
    it("decrypts and dispatches an encrypted im.message.receive_v1 event", async () => {
      const relay = createLarkWebhookRelayService();
      const received: Array<Record<string, unknown>> = [];
      relay.setVerificationToken("vt");
      relay.setEncryptKey("ek");
      await relay.start((payload) => {
        received.push(payload);
      });

      const event = {
        schema: "2.0",
        header: { event_type: "im.message.receive_v1", token: "vt" },
        event: { message: { message_id: "om_enc_1" } },
      };
      const rawBody = JSON.stringify({ encrypt: larkEncrypt(JSON.stringify(event), "ek") });
      const signature = sign("1700000000", "nonce-enc", "ek", rawBody);

      // RED anchor: today the token check runs on the still-encrypted envelope
      // (no header.token) → 401 LARK_TOKEN_MISSING and the handler never fires.
      expect(
        relay.handleHttpWebhook(rawBody, signature, "1700000000", "nonce-enc"),
      ).toEqual({
        accepted: true,
        statusCode: 200,
      });
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(event);
    });

    it("decrypts and answers an encrypted url_verification challenge", async () => {
      const relay = createLarkWebhookRelayService();
      relay.setVerificationToken("vt");
      relay.setEncryptKey("ek");
      await relay.start(() => {});

      const challenge = {
        type: "url_verification",
        challenge: "enc-challenge-1",
        token: "vt",
      };
      const rawBody = JSON.stringify({ encrypt: larkEncrypt(JSON.stringify(challenge), "ek") });
      const signature = sign("1700000001", "nonce-enc2", "ek", rawBody);

      expect(
        relay.handleHttpWebhook(rawBody, signature, "1700000001", "nonce-enc2"),
      ).toEqual({
        accepted: true,
        statusCode: 200,
        challenge: "enc-challenge-1",
      });
    });

    it("rejects an encrypted event whose signature is invalid (no-degrade)", async () => {
      const relay = createLarkWebhookRelayService();
      const received: Array<Record<string, unknown>> = [];
      relay.setVerificationToken("vt");
      relay.setEncryptKey("ek");
      await relay.start((payload) => {
        received.push(payload);
      });

      const event = {
        schema: "2.0",
        header: { event_type: "im.message.receive_v1", token: "vt" },
        event: {},
      };
      const rawBody = JSON.stringify({ encrypt: larkEncrypt(JSON.stringify(event), "ek") });
      const wrongSignature = sign("1700000000", "nonce-enc", "different-key", rawBody);

      expect(
        relay.handleHttpWebhook(rawBody, wrongSignature, "1700000000", "nonce-enc"),
      ).toEqual({
        accepted: false,
        statusCode: 403,
        code: "LARK_SIGNATURE_INVALID",
      });
      expect(received).toHaveLength(0);
    });

    it("rejects an encrypted event missing signature headers (no-degrade)", async () => {
      const relay = createLarkWebhookRelayService();
      relay.setVerificationToken("vt");
      relay.setEncryptKey("ek");
      await relay.start(() => {});

      const event = {
        schema: "2.0",
        header: { event_type: "im.message.receive_v1", token: "vt" },
        event: {},
      };
      const rawBody = JSON.stringify({ encrypt: larkEncrypt(JSON.stringify(event), "ek") });

      expect(relay.handleHttpWebhook(rawBody)).toEqual({
        accepted: false,
        statusCode: 401,
        code: "LARK_SIGNATURE_MISSING",
      });
    });

    it("fails closed on a signature-valid but undecryptable envelope", async () => {
      const relay = createLarkWebhookRelayService();
      const received: Array<Record<string, unknown>> = [];
      relay.setVerificationToken("vt");
      relay.setEncryptKey("ek");
      await relay.start((payload) => {
        received.push(payload);
      });

      // Valid base64, correct signature over rawBody, but the ciphertext block
      // is malformed (16-byte IV + a non-block-aligned tail) → cannot decrypt.
      const tampered = Buffer.concat([Buffer.alloc(16, 7), Buffer.from("garbage-xx", "utf8")]).toString("base64");
      const rawBody = JSON.stringify({ encrypt: tampered });
      const signature = sign("1700000002", "nonce-enc3", "ek", rawBody);

      const result = relay.handleHttpWebhook(rawBody, signature, "1700000002", "nonce-enc3");
      expect(result.accepted).toBe(false);
      expect(result.statusCode).toBeGreaterThanOrEqual(400);
      expect(result.statusCode).toBeLessThan(500);
      expect(result.code).toBe("LARK_DECRYPT_FAILED");
      expect(received).toHaveLength(0);
    });

    it("leaves the non-encrypt plaintext path unchanged (regression)", async () => {
      const relay = createLarkWebhookRelayService();
      const received: Array<Record<string, unknown>> = [];
      relay.setVerificationToken("vt");
      // No encrypt key: plaintext delivery, no signature headers required.
      await relay.start((payload) => {
        received.push(payload);
      });

      const rawBody = JSON.stringify({
        schema: "2.0",
        header: { event_type: "im.message.receive_v1", token: "vt" },
        event: { message: { message_id: "om_plain_1" } },
      });

      expect(relay.handleHttpWebhook(rawBody)).toEqual({
        accepted: true,
        statusCode: 200,
      });
      expect(received).toHaveLength(1);
    });
  });
});

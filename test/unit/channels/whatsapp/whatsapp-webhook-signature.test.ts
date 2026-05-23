import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  createWhatsappWebhookService,
  validateWhatsappWebhookSignature,
} from "../../../../src/channels/whatsapp/whatsapp-service.js";

describe("validateWhatsappWebhookSignature", () => {
  const appSecret = "test-app-secret-12345";
  const payload = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

  function computeValidSignature(body: string, secret: string): string {
    const hmac = createHmac("sha256", secret).update(body, "utf-8").digest("hex");
    return `sha256=${hmac}`;
  }

  it("returns true for a valid signature", () => {
    const signature = computeValidSignature(payload, appSecret);
    expect(validateWhatsappWebhookSignature(payload, signature, appSecret)).toBe(true);
  });

  it("returns false for an invalid signature", () => {
    const badSignature = "sha256=0000000000000000000000000000000000000000000000000000000000000000";
    expect(validateWhatsappWebhookSignature(payload, badSignature, appSecret)).toBe(false);
  });

  it("returns false when signature prefix is missing", () => {
    const hmac = createHmac("sha256", appSecret).update(payload, "utf-8").digest("hex");
    expect(validateWhatsappWebhookSignature(payload, hmac, appSecret)).toBe(false);
  });

  it("returns false when signature has wrong length", () => {
    expect(validateWhatsappWebhookSignature(payload, "sha256=abc", appSecret)).toBe(false);
  });

  it("returns false for tampered payload", () => {
    const signature = computeValidSignature(payload, appSecret);
    const tamperedPayload = payload + "tampered";
    expect(validateWhatsappWebhookSignature(tamperedPayload, signature, appSecret)).toBe(false);
  });

  it("returns false for wrong secret", () => {
    const signature = computeValidSignature(payload, appSecret);
    expect(validateWhatsappWebhookSignature(payload, signature, "wrong-secret")).toBe(false);
  });

  it("returns false (not throws) for malformed non-hex signature", () => {
    // 64 chars long (same as a valid sha256 hex digest) but not valid hex —
    // Buffer.from(str, "hex") silently drops non-hex chars producing a shorter
    // buffer, which previously caused timingSafeEqual to throw.
    const nonHex = "sha256=" + "zz".repeat(32); // 64 chars, all invalid hex
    expect(validateWhatsappWebhookSignature(payload, nonHex, appSecret)).toBe(false);

    // Mixed valid/invalid hex characters
    const mixedHex = "sha256=" + "ab" + "!!".repeat(31); // starts valid then garbage
    expect(validateWhatsappWebhookSignature(payload, mixedHex, appSecret)).toBe(false);
  });

  it("handles empty payload", () => {
    const signature = computeValidSignature("", appSecret);
    expect(validateWhatsappWebhookSignature("", signature, appSecret)).toBe(true);
  });

  it("fails closed for webhook POST when app secret is not configured", async () => {
    const relay = createWhatsappWebhookService();
    await relay.startWebhook("verify-token", () => {});

    const result = relay.handleHttpWebhook(
      payload,
      computeValidSignature(payload, appSecret),
    );

    expect(result).toEqual({
      accepted: false,
      statusCode: 503,
      code: "WHATSAPP_SIGNATURE_UNCONFIGURED",
    });
  });
});

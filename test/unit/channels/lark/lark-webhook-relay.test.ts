import { createHash } from "node:crypto";
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
});

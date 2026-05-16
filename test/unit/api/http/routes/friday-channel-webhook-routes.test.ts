import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FridayHttpContext, FridayRouteDefinition } from "#api";
import {
  createLineWebhookListenerService,
  createLarkWebhookRelayService,
  createWhatsappWebhookService,
} from "#channels";
import { createFridayChannelWebhookRoutes } from "../../../../../src/api/http/routes/friday-channel-webhook-routes.js";

function makeCtx(
  overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {},
): FridayHttpContext<unknown, unknown, unknown> {
  return {
    requestId: "req-channel-webhook",
    receivedAt: "2026-03-01T00:00:00.000Z",
    params: {},
    query: {},
    body: {},
    headers: {},
    principal: null,
    ...overrides,
  };
}

function findRoute(
  routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[],
  operationId: string,
) {
  const route = routes.find((entry) => entry.operationId === operationId);
  if (!route) {
    throw new Error(`route not found: ${operationId}`);
  }
  return route;
}

describe("createFridayChannelWebhookRoutes", () => {
  it("rate-limits all public channel webhook routes", () => {
    const routes = createFridayChannelWebhookRoutes({});

    for (const route of routes) {
      expect(route.auth).toEqual({ public: true });
      expect(route.rateLimitPolicyId).toBe("channel.webhook");
    }
  });

  it("returns CAPABILITY_DISABLED when LINE listener is absent", async () => {
    const routes = createFridayChannelWebhookRoutes({});
    const route = findRoute(routes, "channels.webhooks.line");

    await expect(
      route.handler(
        makeCtx({
          rawBody: JSON.stringify({ destination: "x", events: [] }),
          headers: {},
        }),
      ),
    ).rejects.toMatchObject({
      code: "CAPABILITY_DISABLED",
      httpStatus: 501,
      details: {
        capability: "channel_webhook_listener",
        surface: "/v1/channel-webhooks/line",
        channel: "line",
      },
    });
  });

  it("validates LINE X-Line-Signature and dispatches payload", async () => {
    const relay = createLineWebhookListenerService();
    let receivedText = "";
    await relay.start("/webhook/line", "line-secret", (payload) => {
      receivedText = payload.events[0]?.message?.text ?? "";
    });

    const routes = createFridayChannelWebhookRoutes({
      lineWebhookRelay: relay,
    });
    const route = findRoute(routes, "channels.webhooks.line");

    const rawBody = JSON.stringify({
      destination: "line-destination",
      events: [
        {
          type: "message",
          replyToken: "reply-token-1",
          source: {
            type: "user",
            userId: "u-line-1",
          },
          timestamp: Date.now(),
          message: {
            id: "msg-line-1",
            type: "text",
            text: "hello line",
          },
        },
      ],
    });
    const signature = createHmac("sha256", "line-secret")
      .update(rawBody, "utf-8")
      .digest("base64");

    const result = await route.handler(
      makeCtx({
        rawBody,
        headers: { "x-line-signature": signature },
      }),
    ) as { accepted: boolean };

    expect(result.accepted).toBe(true);
    expect(receivedText).toBe("hello line");
  });

  it("rejects LINE webhook when signature header is missing", async () => {
    const relay = createLineWebhookListenerService();
    await relay.start("/webhook/line", "line-secret", () => {});

    const routes = createFridayChannelWebhookRoutes({
      lineWebhookRelay: relay,
    });
    const route = findRoute(routes, "channels.webhooks.line");

    await expect(
      route.handler(
        makeCtx({
          rawBody: JSON.stringify({ destination: "x", events: [] }),
          headers: {},
        }),
      ),
    ).rejects.toMatchObject({
      code: "LINE_SIGNATURE_MISSING",
      httpStatus: 401,
    });
  });

  it("handles WhatsApp GET verification challenge", async () => {
    const relay = createWhatsappWebhookService();
    await relay.startWebhook("verify-token-1", () => {});

    const routes = createFridayChannelWebhookRoutes({
      whatsappWebhookRelay: relay,
    });
    const route = findRoute(routes, "channels.webhooks.whatsapp.verify");

    const result = await route.handler(
      makeCtx({
        query: {
          "hub.mode": "subscribe",
          "hub.verify_token": "verify-token-1",
          "hub.challenge": "challenge-abc",
        },
      }),
    ) as { __fridayRawTextResponse: true; body: string };

    expect(result.__fridayRawTextResponse).toBe(true);
    expect(result.body).toBe("challenge-abc");
  });

  it("validates WhatsApp POST signature and dispatches payload", async () => {
    const relay = createWhatsappWebhookService();
    let capturedMessageId = "";
    relay.setAppSecret?.("wa-secret");
    await relay.startWebhook("verify-token", (payload) => {
      capturedMessageId = payload.entry[0]?.changes[0]?.value.messages?.[0]?.id ?? "";
    });
    relay.setAppSecret?.("wa-secret");

    const routes = createFridayChannelWebhookRoutes({
      whatsappWebhookRelay: relay,
    });
    const route = findRoute(routes, "channels.webhooks.whatsapp");

    const rawBody = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "entry-1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "1",
                  phone_number_id: "2",
                },
                messages: [
                  {
                    from: "15550001",
                    id: "wamid.001",
                    timestamp: "1700000000",
                    type: "text",
                    text: { body: "hello wa" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const signature = `sha256=${createHmac("sha256", "wa-secret").update(rawBody, "utf-8").digest("hex")}`;

    const result = await route.handler(
      makeCtx({
        rawBody,
        headers: { "x-hub-signature-256": signature },
      }),
    ) as { received: boolean };

    expect(result.received).toBe(true);
    expect(capturedMessageId).toBe("wamid.001");
  });

  it("handles Lark url_verification and event relay", async () => {
    const relay = createLarkWebhookRelayService();
    let dispatched = false;
    relay.setVerificationToken("lark-verify-token");
    relay.setEncryptKey("lark-encrypt-key");
    await relay.start(() => {
      dispatched = true;
    });

    const routes = createFridayChannelWebhookRoutes({
      larkWebhookRelay: relay,
    });
    const route = findRoute(routes, "channels.webhooks.lark");

    const verifyResult = await route.handler(
      makeCtx({
        rawBody: JSON.stringify({
          type: "url_verification",
          token: "lark-verify-token",
          challenge: "lark-challenge",
        }),
      }),
    ) as { challenge: string };
    expect(verifyResult.challenge).toBe("lark-challenge");

    const rawBody = JSON.stringify({
      header: {
        event_type: "im.message.receive_v1",
        token: "lark-verify-token",
      },
      event: {},
    });
    const signature = createHash("sha256")
      .update(`1700000000nonce-1lark-encrypt-key${rawBody}`, "utf-8")
      .digest("hex");
    const eventResult = await route.handler(
      makeCtx({
        rawBody,
        headers: {
          "x-lark-signature": signature,
          "x-lark-request-timestamp": "1700000000",
          "x-lark-request-nonce": "nonce-1",
        },
      }),
    ) as { accepted: boolean };
    expect(eventResult.accepted).toBe(true);
    expect(dispatched).toBe(true);
  });

  it("rejects Lark webhook when verification token is invalid", async () => {
    const relay = createLarkWebhookRelayService();
    relay.setVerificationToken("lark-verify-token");
    await relay.start(() => {});

    const routes = createFridayChannelWebhookRoutes({
      larkWebhookRelay: relay,
    });
    const route = findRoute(routes, "channels.webhooks.lark");

    await expect(
      route.handler(
        makeCtx({
          rawBody: JSON.stringify({
            header: {
              event_type: "im.message.receive_v1",
              token: "wrong-token",
            },
            event: {},
          }),
        }),
      ),
    ).rejects.toMatchObject({
      code: "LARK_TOKEN_INVALID",
      httpStatus: 403,
    });
  });

  // ── Phase 14.5A WP-001 channel signature posture negative tests ──────────

  it("Phase 14.5A: rejects WhatsApp POST when app-secret is configured but signature header is missing", async () => {
    const relay = createWhatsappWebhookService();
    relay.setAppSecret?.("wa-secret");
    await relay.startWebhook("verify-token", () => {});

    const routes = createFridayChannelWebhookRoutes({
      whatsappWebhookRelay: relay,
    });
    const route = findRoute(routes, "channels.webhooks.whatsapp");

    await expect(
      route.handler(
        makeCtx({
          rawBody: JSON.stringify({ object: "whatsapp_business_account", entry: [] }),
          headers: {},
        }),
      ),
    ).rejects.toMatchObject({
      code: "WHATSAPP_SIGNATURE_MISSING",
      httpStatus: 401,
    });
  });

  it("Phase 14.5A: rejects WhatsApp POST when app-secret is configured and signature is wrong", async () => {
    const relay = createWhatsappWebhookService();
    relay.setAppSecret?.("wa-secret");
    await relay.startWebhook("verify-token", () => {});

    const routes = createFridayChannelWebhookRoutes({
      whatsappWebhookRelay: relay,
    });
    const route = findRoute(routes, "channels.webhooks.whatsapp");

    await expect(
      route.handler(
        makeCtx({
          rawBody: JSON.stringify({ object: "whatsapp_business_account", entry: [] }),
          headers: { "x-hub-signature-256": "sha256=deadbeef" },
        }),
      ),
    ).rejects.toMatchObject({
      code: "WHATSAPP_SIGNATURE_INVALID",
      httpStatus: 403,
    });
  });

  it("Phase 14.5A: rejects Lark POST when encrypt-key is configured but signature headers are missing", async () => {
    const relay = createLarkWebhookRelayService();
    relay.setVerificationToken("lark-verify-token");
    relay.setEncryptKey("lark-encrypt-key");
    await relay.start(() => {});

    const routes = createFridayChannelWebhookRoutes({
      larkWebhookRelay: relay,
    });
    const route = findRoute(routes, "channels.webhooks.lark");

    await expect(
      route.handler(
        makeCtx({
          rawBody: JSON.stringify({
            header: { event_type: "im.message.receive_v1", token: "lark-verify-token" },
            event: {},
          }),
        }),
      ),
    ).rejects.toMatchObject({
      code: "LARK_SIGNATURE_MISSING",
      httpStatus: 401,
    });
  });

  it("Phase 14.5A: refuses Lark when verification token is not configured even with matching token", async () => {
    const relay = createLarkWebhookRelayService();
    await relay.start(() => {});

    const routes = createFridayChannelWebhookRoutes({
      larkWebhookRelay: relay,
    });
    const route = findRoute(routes, "channels.webhooks.lark");

    await expect(
      route.handler(
        makeCtx({
          rawBody: JSON.stringify({
            header: { event_type: "im.message.receive_v1", token: "anything" },
            event: {},
          }),
        }),
      ),
    ).rejects.toMatchObject({
      code: "LARK_TOKEN_UNCONFIGURED",
      httpStatus: 503,
    });
  });
});

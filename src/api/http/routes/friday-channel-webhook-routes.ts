import { FridayDomainError } from "#errors";
import type {
  LarkWebhookRelayService,
  LineWebhookListenerService,
  TelegramWebhookService,
  WhatsappWebhookService,
} from "#channels";
import { createFridayHttpRawTextResponse } from "../friday-http-raw-response.js";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import { throwFridayCapabilityDisabled } from "./friday-capability-disabled.js";

export interface FridayChannelWebhookRoutesDeps {
  lineWebhookRelay?: LineWebhookListenerService;
  whatsappWebhookRelay?: WhatsappWebhookService;
  larkWebhookRelay?: LarkWebhookRelayService;
  telegramWebhookRelay?: TelegramWebhookService;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function throwChannelWebhookError(
  code: string,
  message: string,
  statusCode: number,
): never {
  throw new FridayDomainError(code, message, { httpStatus: statusCode });
}

export function createFridayChannelWebhookRoutes(
  deps: FridayChannelWebhookRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "channels.webhooks.line",
      method: "POST",
      path: "/v1/channel-webhooks/line",
      auth: { public: true },
      rateLimitPolicyId: "channel.webhook",
      async handler(ctx) {
        const relay = deps.lineWebhookRelay;
        if (!relay?.handleHttpWebhook || relay.isListening() !== true) {
          throwFridayCapabilityDisabled({
            capability: "channel_webhook_listener",
            surface: "/v1/channel-webhooks/line",
            message: "LINE webhook listener is disabled in this runtime",
            details: { channel: "line" },
          });
        }
        const result = relay.handleHttpWebhook(
          ctx.rawBody ?? "",
          ctx.headers["x-line-signature"],
        );
        if (!result.accepted) {
          if (result.statusCode === 401) {
            throwChannelWebhookError(
              result.code ?? "LINE_SIGNATURE_MISSING",
              "LINE signature header is missing",
              401,
            );
          }
          if (result.statusCode === 403) {
            throwChannelWebhookError(
              result.code ?? "LINE_SIGNATURE_INVALID",
              "LINE signature verification failed",
              403,
            );
          }
          if (result.statusCode === 400) {
            throwChannelWebhookError(
              result.code ?? "LINE_PAYLOAD_INVALID",
              "LINE webhook payload is invalid JSON",
              400,
            );
          }
          throwChannelWebhookError(
            result.code ?? "LINE_LISTENER_INACTIVE",
            "LINE webhook listener is not active",
            503,
          );
        }
        return { accepted: true };
      },
    },
    {
      operationId: "channels.webhooks.whatsapp.verify",
      method: "GET",
      path: "/v1/channel-webhooks/whatsapp",
      auth: { public: true },
      rateLimitPolicyId: "channel.webhook",
      async handler(ctx) {
        const relay = deps.whatsappWebhookRelay;
        if (!relay?.handleVerificationChallenge || relay.isListening() !== true) {
          throwFridayCapabilityDisabled({
            capability: "channel_webhook_listener",
            surface: "/v1/channel-webhooks/whatsapp",
            message: "WhatsApp webhook listener is disabled in this runtime",
            details: { channel: "whatsapp" },
          });
        }
        const query = ctx.query as Record<string, unknown>;
        const result = relay.handleVerificationChallenge(
          asString(query["hub.mode"]),
          asString(query["hub.verify_token"]),
          asString(query["hub.challenge"]),
        );
        if (!result.accepted) {
          throwChannelWebhookError(
            result.code ?? "WHATSAPP_VERIFY_FAILED",
            "WhatsApp verification challenge failed",
            result.statusCode,
          );
        }
        return createFridayHttpRawTextResponse(result.challenge ?? "", {
          contentType: "text/plain; charset=utf-8",
        });
      },
    },
    {
      operationId: "channels.webhooks.whatsapp",
      method: "POST",
      path: "/v1/channel-webhooks/whatsapp",
      auth: { public: true },
      rateLimitPolicyId: "channel.webhook",
      async handler(ctx) {
        const relay = deps.whatsappWebhookRelay;
        if (!relay?.handleHttpWebhook || relay.isListening() !== true) {
          throwFridayCapabilityDisabled({
            capability: "channel_webhook_listener",
            surface: "/v1/channel-webhooks/whatsapp",
            message: "WhatsApp webhook listener is disabled in this runtime",
            details: { channel: "whatsapp" },
          });
        }
        const result = relay.handleHttpWebhook(
          ctx.rawBody ?? "",
          ctx.headers["x-hub-signature-256"],
        );
        if (!result.accepted) {
          if (result.statusCode === 401) {
            throwChannelWebhookError(
              result.code ?? "WHATSAPP_SIGNATURE_MISSING",
              "WhatsApp signature header is missing",
              401,
            );
          }
          if (result.statusCode === 403) {
            throwChannelWebhookError(
              result.code ?? "WHATSAPP_SIGNATURE_INVALID",
              "WhatsApp signature verification failed",
              403,
            );
          }
          if (result.statusCode === 400) {
            throwChannelWebhookError(
              result.code ?? "WHATSAPP_PAYLOAD_INVALID",
              "WhatsApp webhook payload is invalid JSON",
              400,
            );
          }
          if (result.code === "WHATSAPP_SIGNATURE_UNCONFIGURED") {
            throwChannelWebhookError(
              result.code,
              "WhatsApp webhook app secret is not configured",
              503,
            );
          }
          throwChannelWebhookError(
            result.code ?? "WHATSAPP_LISTENER_INACTIVE",
            "WhatsApp webhook listener is not active",
            503,
          );
        }
        return { received: true };
      },
    },
    {
      operationId: "channels.webhooks.telegram",
      method: "POST",
      path: "/v1/channel-webhooks/telegram",
      auth: { public: true },
      rateLimitPolicyId: "channel.webhook",
      async handler(ctx) {
        const relay = deps.telegramWebhookRelay;
        if (!relay?.handleHttpWebhook || relay.isListening() !== true) {
          throwFridayCapabilityDisabled({
            capability: "channel_webhook_listener",
            surface: "/v1/channel-webhooks/telegram",
            message: "Telegram webhook listener is disabled in this runtime",
            details: { channel: "telegram" },
          });
        }
        const result = relay.handleHttpWebhook(
          ctx.rawBody ?? "",
          ctx.headers["x-telegram-bot-api-secret-token"],
        );
        if (!result.accepted) {
          if (result.statusCode === 401) {
            throwChannelWebhookError(
              result.code ?? "TELEGRAM_SECRET_MISSING",
              "Telegram webhook secret token header is missing",
              401,
            );
          }
          if (result.statusCode === 403) {
            throwChannelWebhookError(
              result.code ?? "TELEGRAM_SECRET_INVALID",
              "Telegram webhook secret token verification failed",
              403,
            );
          }
          if (result.statusCode === 400) {
            throwChannelWebhookError(
              result.code ?? "TELEGRAM_PAYLOAD_INVALID",
              "Telegram webhook payload is invalid JSON",
              400,
            );
          }
          if (result.code === "TELEGRAM_SECRET_UNCONFIGURED") {
            throwChannelWebhookError(
              result.code,
              "Telegram webhook secret token is not configured",
              503,
            );
          }
          throwChannelWebhookError(
            result.code ?? "TELEGRAM_LISTENER_INACTIVE",
            "Telegram webhook listener is not active",
            503,
          );
        }
        return { accepted: true };
      },
    },
    {
      operationId: "channels.webhooks.lark",
      method: "POST",
      path: "/v1/channel-webhooks/lark",
      auth: { public: true },
      rateLimitPolicyId: "channel.webhook",
      async handler(ctx) {
        const relay = deps.larkWebhookRelay;
        if (!relay || relay.isListening() !== true) {
          throwFridayCapabilityDisabled({
            capability: "channel_webhook_listener",
            surface: "/v1/channel-webhooks/lark",
            message: "Lark webhook listener is disabled in this runtime",
            details: { channel: "lark" },
          });
        }
        const result = relay.handleHttpWebhook(
          ctx.rawBody ?? "",
          ctx.headers["x-lark-signature"],
          ctx.headers["x-lark-request-timestamp"],
          ctx.headers["x-lark-request-nonce"],
        );
        if (!result.accepted) {
          if (result.statusCode === 401) {
            if (result.code === "LARK_TOKEN_MISSING") {
              throwChannelWebhookError(
                result.code,
                "Lark webhook verification token is missing",
                401,
              );
            }
            throwChannelWebhookError(
              result.code ?? "LARK_SIGNATURE_MISSING",
              "Lark webhook signature headers are missing",
              401,
            );
          }
          if (result.statusCode === 403) {
            if (result.code === "LARK_TOKEN_INVALID") {
              throwChannelWebhookError(
                result.code,
                "Lark webhook verification token is invalid",
                403,
              );
            }
            throwChannelWebhookError(
              result.code ?? "LARK_SIGNATURE_INVALID",
              "Lark webhook signature is invalid",
              403,
            );
          }
          if (result.statusCode === 400) {
            throwChannelWebhookError(
              result.code ?? "LARK_PAYLOAD_INVALID",
              "Lark webhook payload is invalid JSON",
              400,
            );
          }
          if (result.code === "LARK_TOKEN_UNCONFIGURED") {
            throwChannelWebhookError(
              result.code,
              "Lark webhook verification token is not configured",
              503,
            );
          }
          throwChannelWebhookError(
            result.code ?? "LARK_LISTENER_INACTIVE",
            "Lark webhook listener is not active",
            503,
          );
        }
        if (typeof result.challenge === "string") {
          return { challenge: result.challenge };
        }
        return {
          accepted: true,
          ...(result.code ? { code: result.code } : {}),
        };
      },
    },
  ];
}

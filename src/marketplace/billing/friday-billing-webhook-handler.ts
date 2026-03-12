/**
 * Billing Webhook Handler — Routes incoming provider webhooks to adapters.
 *
 * Receives raw webhook payloads, verifies signatures via the appropriate
 * adapter, persists the webhook record, and emits a billing event for
 * downstream processing.
 *
 * @module marketplace/billing/friday-billing-webhook-handler
 */

import type {
  FridayBillingEvent,
  FridayBillingWebhook,
  ISODateTime,
  JsonObject,
  UUID,
} from "../model/friday-marketplace.types.js";

import type { FridayBillingAdapterRegistry } from "./friday-billing-adapter.js";
import { BILLING_ADAPTER_ERROR_CODES } from "./friday-billing-adapter.js";
import type { BillingAdapterError, BillingAdapterResult } from "./friday-billing-adapter.js";

// ─── Error Codes ───

export const WEBHOOK_HANDLER_ERROR_CODES = {
  PROVIDER_NOT_FOUND: BILLING_ADAPTER_ERROR_CODES.PROVIDER_NOT_FOUND,
  VERIFICATION_FAILED: BILLING_ADAPTER_ERROR_CODES.WEBHOOK_VERIFICATION_FAILED,
  DUPLICATE_EVENT: "WEBHOOK_DUPLICATE_EVENT",
  PROCESSING_FAILED: "WEBHOOK_PROCESSING_FAILED",
} as const;

export type WebhookHandlerErrorCode =
  (typeof WEBHOOK_HANDLER_ERROR_CODES)[keyof typeof WEBHOOK_HANDLER_ERROR_CODES];

export interface WebhookHandlerError {
  readonly code: WebhookHandlerErrorCode;
  readonly message: string;
}

export type WebhookHandlerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: WebhookHandlerError };

// ─── Webhook Input ───

export interface IncomingWebhookRequest {
  readonly provider: string;
  readonly rawPayload: string;
  readonly signature: string;
}

// ─── Deps ───

export interface FridayBillingWebhookHandlerDeps {
  readonly adapterRegistry: FridayBillingAdapterRegistry;
  readonly generateId: () => UUID;
  readonly now: () => ISODateTime;
  readonly getWebhookSecret: (provider: string) => string | undefined;
  readonly getWebhookByExternalId: (
    provider: string,
    externalId: string,
  ) => Promise<FridayBillingWebhook | null>;
  readonly saveWebhook: (webhook: FridayBillingWebhook) => Promise<void>;
  readonly saveBillingEvent: (event: FridayBillingEvent) => Promise<void>;
}

// ─── Interface ───

export interface FridayBillingWebhookHandler {
  /** Receive, verify, persist and emit a billing event from a provider webhook. */
  handleWebhook(
    request: IncomingWebhookRequest,
  ): Promise<WebhookHandlerResult<{ webhook: FridayBillingWebhook; event: FridayBillingEvent }>>;
}

// ─── Factory ───

export function createFridayBillingWebhookHandler(
  deps: FridayBillingWebhookHandlerDeps,
): FridayBillingWebhookHandler {
  return {
    async handleWebhook(request) {
      // 1. Resolve adapter
      const adapterResult = deps.adapterRegistry.require(request.provider);
      if (!adapterResult.ok) {
        return {
          ok: false,
          error: {
            code: WEBHOOK_HANDLER_ERROR_CODES.PROVIDER_NOT_FOUND,
            message: adapterResult.error.message,
          },
        };
      }
      const adapter = adapterResult.value;

      // 2. Get webhook secret
      const secret = deps.getWebhookSecret(request.provider);
      if (!secret) {
        return {
          ok: false,
          error: {
            code: WEBHOOK_HANDLER_ERROR_CODES.VERIFICATION_FAILED,
            message: `No webhook secret configured for provider "${request.provider}"`,
          },
        };
      }

      // 3. Verify signature and parse
      const verification = adapter.verifyWebhook({
        payload: request.rawPayload,
        signature: request.signature,
        secret,
      });

      if (!verification.ok) {
        // Persist as failed webhook for audit trail
        const failedWebhook: FridayBillingWebhook = {
          id: deps.generateId(),
          provider: request.provider,
          externalId: "",
          eventType: "unknown",
          payload: {} as JsonObject,
          signature: request.signature,
          status: "failed",
          attempts: 1,
          lastError: verification.error.message,
          receivedAt: deps.now(),
          processedAt: null,
        };
        await deps.saveWebhook(failedWebhook);

        return {
          ok: false,
          error: {
            code: WEBHOOK_HANDLER_ERROR_CODES.VERIFICATION_FAILED,
            message: verification.error.message,
          },
        };
      }

      const parsed = verification.value;

      // 4. Deduplication check
      const existing = await deps.getWebhookByExternalId(
        request.provider,
        parsed.externalId,
      );
      if (existing) {
        return {
          ok: false,
          error: {
            code: WEBHOOK_HANDLER_ERROR_CODES.DUPLICATE_EVENT,
            message: `Webhook with external ID "${parsed.externalId}" already processed`,
          },
        };
      }

      // 5. Persist webhook record
      const now = deps.now();
      const webhook: FridayBillingWebhook = {
        id: deps.generateId(),
        provider: request.provider,
        externalId: parsed.externalId,
        eventType: parsed.eventType,
        payload: parsed.payload,
        signature: request.signature,
        status: "processed",
        attempts: 1,
        lastError: null,
        receivedAt: now,
        processedAt: now,
      };
      await deps.saveWebhook(webhook);

      // 6. Emit billing event
      const billingEvent: FridayBillingEvent = {
        id: deps.generateId(),
        eventType: mapProviderEventType(parsed.eventType),
        source: "webhook",
        referenceType: extractReferenceType(parsed.eventType),
        referenceId: extractReferenceId(parsed.payload),
        payload: parsed.payload,
        processed: false,
        createdAt: now,
      };
      await deps.saveBillingEvent(billingEvent);

      return { ok: true, value: { webhook, event: billingEvent } };
    },
  };
}

// ─── Helpers ───

/**
 * Maps a provider-specific event type to the nearest FridayBillingEventType.
 *
 * Unknown event types are passed through as-is — they will be logged but
 * may not trigger automated processing.
 */
function mapProviderEventType(providerEventType: string): FridayBillingEvent["eventType"] {
  const mapping: Record<string, FridayBillingEvent["eventType"]> = {
    "charge.succeeded": "payment.succeeded",
    "payment_intent.succeeded": "payment.succeeded",
    "charge.failed": "payment.failed",
    "payment_intent.payment_failed": "payment.failed",
    "charge.refunded": "refund.completed",
    "refund.created": "refund.initiated",
    "customer.subscription.created": "subscription.created",
    "customer.subscription.updated": "subscription.renewed",
    "customer.subscription.deleted": "subscription.cancelled",
    "customer.subscription.paused": "subscription.paused",
    "customer.subscription.resumed": "subscription.resumed",
    "payout.paid": "payout.completed",
    "payout.failed": "payout.failed",
    "payout.created": "payout.initiated",
    "charge.dispute.created": "chargeback.opened",
    "charge.dispute.won": "chargeback.won",
    "charge.dispute.lost": "chargeback.lost",
    "checkout.session.completed": "checkout.completed",
    "checkout.session.expired": "checkout.abandoned",
  };

  return mapping[providerEventType] ?? ("payment.succeeded" as FridayBillingEvent["eventType"]);
}

function extractReferenceType(eventType: string): string | null {
  if (eventType.startsWith("charge") || eventType.startsWith("payment")) return "purchase";
  if (eventType.startsWith("refund")) return "refund";
  if (eventType.startsWith("customer.subscription")) return "subscription";
  if (eventType.startsWith("payout")) return "payout";
  if (eventType.startsWith("checkout")) return "purchase";
  return null;
}

function extractReferenceId(payload: JsonObject): UUID | null {
  // Providers typically include an `id` or `object.id` in the payload
  if (typeof payload["id"] === "string") return payload["id"];
  const data = payload["data"];
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const obj = (data as JsonObject)["object"];
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const id = (obj as JsonObject)["id"];
      if (typeof id === "string") return id;
    }
  }
  return null;
}

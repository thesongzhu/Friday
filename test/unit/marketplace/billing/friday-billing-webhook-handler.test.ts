import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFridayBillingWebhookHandler,
  WEBHOOK_HANDLER_ERROR_CODES,
} from "../../../../src/marketplace/billing/friday-billing-webhook-handler.js";
import type { FridayBillingWebhookHandlerDeps } from "../../../../src/marketplace/billing/friday-billing-webhook-handler.js";
import {
  createFridayBillingAdapterRegistry,
  BILLING_ADAPTER_ERROR_CODES,
} from "../../../../src/marketplace/billing/friday-billing-adapter.js";
import type { FridayBillingAdapter } from "../../../../src/marketplace/billing/friday-billing-adapter.js";

// ─── Helpers ───

let idCounter = 0;

function createMockDeps(
  overrides: Partial<FridayBillingWebhookHandlerDeps> = {},
): FridayBillingWebhookHandlerDeps {
  const registry = createFridayBillingAdapterRegistry();
  return {
    adapterRegistry: registry,
    generateId: () => `wh-${++idCounter}`,
    now: () => "2026-01-15T10:00:00.000Z",
    getWebhookSecret: vi.fn().mockReturnValue("whsec_test123"),
    getWebhookByExternalId: vi.fn().mockResolvedValue(null),
    saveWebhook: vi.fn().mockResolvedValue(undefined),
    saveBillingEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockStripeAdapter(): FridayBillingAdapter {
  return {
    providerId: "stripe",
    displayName: "Stripe",
    createCharge: vi.fn(),
    createRefund: vi.fn(),
    createPayout: vi.fn(),
    createSubscription: vi.fn(),
    cancelSubscription: vi.fn(),
    verifyWebhook: vi.fn().mockReturnValue({
      ok: true,
      value: {
        externalId: "evt_stripe_123",
        eventType: "charge.succeeded",
        payload: { id: "ch_abc", amount: 5000 },
      },
    }),
    getPaymentMethodInfo: vi.fn(),
  };
}

// ─── Tests ───

describe("FridayBillingWebhookHandler", () => {
  beforeEach(() => {
    idCounter = 0;
  });

  describe("handleWebhook", () => {
    it("verifies, persists, and emits billing event for valid webhook", async () => {
      const deps = createMockDeps();
      const adapter = createMockStripeAdapter();
      deps.adapterRegistry.register(adapter);

      const handler = createFridayBillingWebhookHandler(deps);
      const result = await handler.handleWebhook({
        provider: "stripe",
        rawPayload: '{"id":"ch_abc"}',
        signature: "sig_valid",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.webhook.provider).toBe("stripe");
        expect(result.value.webhook.externalId).toBe("evt_stripe_123");
        expect(result.value.webhook.status).toBe("processed");
        expect(result.value.event.eventType).toBe("payment.succeeded");
        expect(result.value.event.source).toBe("webhook");
      }

      expect(deps.saveWebhook).toHaveBeenCalledOnce();
      expect(deps.saveBillingEvent).toHaveBeenCalledOnce();
    });

    it("returns error for unregistered provider", async () => {
      const deps = createMockDeps();
      const handler = createFridayBillingWebhookHandler(deps);

      const result = await handler.handleWebhook({
        provider: "unknown",
        rawPayload: "{}",
        signature: "sig",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(WEBHOOK_HANDLER_ERROR_CODES.PROVIDER_NOT_FOUND);
      }
    });

    it("returns error when no webhook secret configured", async () => {
      const deps = createMockDeps({
        getWebhookSecret: vi.fn().mockReturnValue(undefined),
      });
      const adapter = createMockStripeAdapter();
      deps.adapterRegistry.register(adapter);

      const handler = createFridayBillingWebhookHandler(deps);
      const result = await handler.handleWebhook({
        provider: "stripe",
        rawPayload: "{}",
        signature: "sig",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(WEBHOOK_HANDLER_ERROR_CODES.VERIFICATION_FAILED);
        expect(result.error.message).toContain("No webhook secret");
      }
    });

    it("returns error and saves failed webhook on signature verification failure", async () => {
      const deps = createMockDeps();
      const adapter = createMockStripeAdapter();
      (adapter.verifyWebhook as ReturnType<typeof vi.fn>).mockReturnValue({
        ok: false,
        error: {
          code: BILLING_ADAPTER_ERROR_CODES.WEBHOOK_VERIFICATION_FAILED,
          message: "Invalid signature",
        },
      });
      deps.adapterRegistry.register(adapter);

      const handler = createFridayBillingWebhookHandler(deps);
      const result = await handler.handleWebhook({
        provider: "stripe",
        rawPayload: "{}",
        signature: "bad_sig",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(WEBHOOK_HANDLER_ERROR_CODES.VERIFICATION_FAILED);
      }
      // Failed webhook should be persisted for audit
      expect(deps.saveWebhook).toHaveBeenCalledOnce();
      const savedWebhook = (deps.saveWebhook as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(savedWebhook.status).toBe("failed");
    });

    it("returns duplicate error for already-processed webhook", async () => {
      const deps = createMockDeps({
        getWebhookByExternalId: vi.fn().mockResolvedValue({
          id: "existing-wh",
          provider: "stripe",
          externalId: "evt_stripe_123",
          status: "processed",
        }),
      });
      const adapter = createMockStripeAdapter();
      deps.adapterRegistry.register(adapter);

      const handler = createFridayBillingWebhookHandler(deps);
      const result = await handler.handleWebhook({
        provider: "stripe",
        rawPayload: "{}",
        signature: "sig",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(WEBHOOK_HANDLER_ERROR_CODES.DUPLICATE_EVENT);
        expect(result.error.message).toContain("evt_stripe_123");
      }
    });

    it("maps provider event types to Friday billing event types", async () => {
      const deps = createMockDeps();
      const adapter = createMockStripeAdapter();
      (adapter.verifyWebhook as ReturnType<typeof vi.fn>).mockReturnValue({
        ok: true,
        value: {
          externalId: "evt_refund_1",
          eventType: "charge.refunded",
          payload: { id: "re_123" },
        },
      });
      deps.adapterRegistry.register(adapter);

      const handler = createFridayBillingWebhookHandler(deps);
      const result = await handler.handleWebhook({
        provider: "stripe",
        rawPayload: "{}",
        signature: "sig",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.event.eventType).toBe("refund.completed");
      }
    });

    it("extracts reference ID from nested payload structure", async () => {
      const deps = createMockDeps();
      const adapter = createMockStripeAdapter();
      (adapter.verifyWebhook as ReturnType<typeof vi.fn>).mockReturnValue({
        ok: true,
        value: {
          externalId: "evt_nested_1",
          eventType: "customer.subscription.created",
          payload: {
            data: {
              object: { id: "sub_nested_id" },
            },
          },
        },
      });
      deps.adapterRegistry.register(adapter);

      const handler = createFridayBillingWebhookHandler(deps);
      const result = await handler.handleWebhook({
        provider: "stripe",
        rawPayload: "{}",
        signature: "sig",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.event.referenceId).toBe("sub_nested_id");
        expect(result.value.event.referenceType).toBe("subscription");
      }
    });
  });
});

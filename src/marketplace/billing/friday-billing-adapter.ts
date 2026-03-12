/**
 * Billing Adapter — Provider-agnostic payment processing abstraction.
 *
 * Defines the adapter interface for payment processors (Stripe, PayPal, etc.)
 * and a registry to manage multiple active adapters.
 *
 * @module marketplace/billing/friday-billing-adapter
 */

import type {
  FridayMoneyAmount,
  FridayPaymentMethod,
  ISODateTime,
  JsonObject,
  UUID,
} from "../model/friday-marketplace.types.js";

// ─── Adapter Error ───

export const BILLING_ADAPTER_ERROR_CODES = {
  PROVIDER_NOT_FOUND: "BILLING_PROVIDER_NOT_FOUND",
  CHARGE_FAILED: "BILLING_CHARGE_FAILED",
  REFUND_FAILED: "BILLING_REFUND_FAILED",
  PAYOUT_FAILED: "BILLING_PAYOUT_FAILED",
  WEBHOOK_VERIFICATION_FAILED: "BILLING_WEBHOOK_VERIFICATION_FAILED",
  SUBSCRIPTION_FAILED: "BILLING_SUBSCRIPTION_FAILED",
  PAYMENT_METHOD_FAILED: "BILLING_PAYMENT_METHOD_FAILED",
  NOT_SUPPORTED: "BILLING_NOT_SUPPORTED",
} as const;

export type BillingAdapterErrorCode =
  (typeof BILLING_ADAPTER_ERROR_CODES)[keyof typeof BILLING_ADAPTER_ERROR_CODES];

export interface BillingAdapterError {
  readonly code: BillingAdapterErrorCode;
  readonly message: string;
  readonly providerCode?: string;
}

export type BillingAdapterResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: BillingAdapterError };

// ─── Charge & Refund ───

export interface BillingChargeRequest {
  readonly amount: FridayMoneyAmount;
  readonly paymentMethodId: string;
  readonly description: string;
  readonly idempotencyKey: string;
  readonly metadata?: JsonObject;
}

export interface BillingChargeResult {
  readonly externalChargeId: string;
  readonly status: "succeeded" | "pending" | "failed";
  readonly providerResponse?: JsonObject;
}

export interface BillingRefundRequest {
  readonly externalChargeId: string;
  readonly amount: FridayMoneyAmount;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface BillingRefundResult {
  readonly externalRefundId: string;
  readonly status: "succeeded" | "pending" | "failed";
  readonly providerResponse?: JsonObject;
}

// ─── Payouts ───

export interface BillingPayoutRequest {
  readonly amount: FridayMoneyAmount;
  readonly recipientExternalId: string;
  readonly description: string;
  readonly idempotencyKey: string;
  readonly metadata?: JsonObject;
}

export interface BillingPayoutResult {
  readonly externalPayoutId: string;
  readonly status: "succeeded" | "pending" | "failed";
  readonly providerResponse?: JsonObject;
}

// ─── Subscriptions ───

export interface BillingSubscriptionRequest {
  readonly paymentMethodId: string;
  readonly priceExternalId: string;
  readonly trialDays?: number;
  readonly metadata?: JsonObject;
}

export interface BillingSubscriptionResult {
  readonly externalSubscriptionId: string;
  readonly status: "active" | "trialing" | "past_due" | "cancelled";
  readonly currentPeriodEnd: ISODateTime;
  readonly providerResponse?: JsonObject;
}

export interface BillingCancelSubscriptionRequest {
  readonly externalSubscriptionId: string;
  readonly atPeriodEnd: boolean;
}

export interface BillingCancelSubscriptionResult {
  readonly externalSubscriptionId: string;
  readonly cancelledAt: ISODateTime;
  readonly cancelAtPeriodEnd: boolean;
}

// ─── Webhooks ───

export interface BillingWebhookVerification {
  readonly payload: string;
  readonly signature: string;
  readonly secret: string;
}

export interface BillingWebhookEvent {
  readonly externalId: string;
  readonly eventType: string;
  readonly payload: JsonObject;
}

// ─── Payment Methods ───

export interface BillingPaymentMethodInfo {
  readonly externalMethodId: string;
  readonly type: FridayPaymentMethod["type"];
  readonly displayLabel: string;
  readonly expiresAt: ISODateTime | null;
}

// ─── Adapter Interface ───

/**
 * Provider-specific billing adapter.
 *
 * Implementors wrap a single payment provider (e.g. Stripe, PayPal).
 * All methods return Result types — no thrown exceptions.
 */
export interface FridayBillingAdapter {
  /** Unique provider identifier (e.g. "stripe", "paypal"). */
  readonly providerId: string;

  /** Display name for admin UI. */
  readonly displayName: string;

  /** Create a charge / payment intent. */
  createCharge(request: BillingChargeRequest): Promise<BillingAdapterResult<BillingChargeResult>>;

  /** Issue a refund against a previous charge. */
  createRefund(request: BillingRefundRequest): Promise<BillingAdapterResult<BillingRefundResult>>;

  /** Initiate a payout to a publisher / connected account. */
  createPayout(request: BillingPayoutRequest): Promise<BillingAdapterResult<BillingPayoutResult>>;

  /** Create a subscription. */
  createSubscription(
    request: BillingSubscriptionRequest,
  ): Promise<BillingAdapterResult<BillingSubscriptionResult>>;

  /** Cancel a subscription. */
  cancelSubscription(
    request: BillingCancelSubscriptionRequest,
  ): Promise<BillingAdapterResult<BillingCancelSubscriptionResult>>;

  /** Verify a webhook signature and parse the event. */
  verifyWebhook(
    verification: BillingWebhookVerification,
  ): BillingAdapterResult<BillingWebhookEvent>;

  /** Retrieve a payment method's display info from the provider. */
  getPaymentMethodInfo(
    externalMethodId: string,
  ): Promise<BillingAdapterResult<BillingPaymentMethodInfo>>;
}

// ─── Adapter Registry ───

export interface FridayBillingAdapterRegistry {
  /** Register an adapter for a provider. */
  register(adapter: FridayBillingAdapter): void;

  /** Get an adapter by provider ID. */
  get(providerId: string): FridayBillingAdapter | undefined;

  /** Get an adapter or throw if not found. */
  require(providerId: string): BillingAdapterResult<FridayBillingAdapter>;

  /** List all registered provider IDs. */
  listProviders(): string[];
}

export function createFridayBillingAdapterRegistry(): FridayBillingAdapterRegistry {
  const adapters = new Map<string, FridayBillingAdapter>();

  return {
    register(adapter) {
      adapters.set(adapter.providerId, adapter);
    },

    get(providerId) {
      return adapters.get(providerId);
    },

    require(providerId) {
      const adapter = adapters.get(providerId);
      if (!adapter) {
        return {
          ok: false,
          error: {
            code: BILLING_ADAPTER_ERROR_CODES.PROVIDER_NOT_FOUND,
            message: `Billing provider "${providerId}" is not registered`,
          },
        };
      }
      return { ok: true, value: adapter };
    },

    listProviders() {
      return [...adapters.keys()];
    },
  };
}

// ─── Marketplace Billing — Adapter Abstraction & Reconciliation ───

// Billing adapter
export {
  BILLING_ADAPTER_ERROR_CODES,
  createFridayBillingAdapterRegistry,
} from "./friday-billing-adapter.js";

export type {
  BillingAdapterErrorCode,
  BillingAdapterError,
  BillingAdapterResult,
  BillingChargeRequest,
  BillingChargeResult,
  BillingRefundRequest,
  BillingRefundResult,
  BillingPayoutRequest,
  BillingPayoutResult,
  BillingSubscriptionRequest,
  BillingSubscriptionResult,
  BillingCancelSubscriptionRequest,
  BillingCancelSubscriptionResult,
  BillingWebhookVerification,
  BillingWebhookEvent,
  BillingPaymentMethodInfo,
  FridayBillingAdapter,
  FridayBillingAdapterRegistry,
} from "./friday-billing-adapter.js";

// Webhook handler
export {
  WEBHOOK_HANDLER_ERROR_CODES,
  createFridayBillingWebhookHandler,
} from "./friday-billing-webhook-handler.js";

export type {
  WebhookHandlerErrorCode,
  WebhookHandlerError,
  WebhookHandlerResult,
  IncomingWebhookRequest,
  FridayBillingWebhookHandlerDeps,
  FridayBillingWebhookHandler,
} from "./friday-billing-webhook-handler.js";

// Reconciliation job
export {
  DEFAULT_RECONCILIATION_CONFIG,
  createFridayBillingReconciliationJob,
} from "./friday-billing-reconciliation-job.js";

export type {
  FridayBillingReconciliationConfig,
  FridayReconciliationResult,
  FridayBillingReconciliationDeps,
  FridayBillingReconciliationJob,
} from "./friday-billing-reconciliation-job.js";

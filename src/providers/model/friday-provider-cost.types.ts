import type {
  FridayProviderApi,
  FridayProviderKind,
  FridayProviderRoutingCostMode,
  FridayProviderRoutingDecisionTrace,
  FridayProviderRoutingReasonCode,
  FridayResolvedProviderRoute,
} from "./friday-provider.types.js";

// ─── Task complexity classification ───

export type FridayTaskComplexity = "simple" | "medium" | "complex";

// ─── Route strategy for cost-aware decisions ───

export type FridayProviderRouteStrategy =
  | "configured"
  | "cost_auto"
  | "budget_downgrade"
  | "budget_local_only";

// ─── Budget health state ───

export type FridayBudgetState = "ok" | "near_limit" | "over_limit";

// ─── Model quality tier ───

// "unknown" is used by the pricing fallback so an unpriced model is recorded as
// an explicit unknown rather than a fabricated "balanced" rate.
export type FridayModelQualityTier = "cheap" | "balanced" | "best" | "unknown";

// ─── Normalized usage across API shapes ───

export interface FridayProviderNormalizedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

// ─── Per-model pricing entry ───

export interface FridayProviderModelPricing {
  providerKind: FridayProviderKind;
  modelPattern: string;
  qualityTier: FridayModelQualityTier;
  inputPer1MUsd: number;
  outputPer1MUsd: number;
  cacheReadPer1MUsd: number;
  cacheWritePer1MUsd: number;
}

// ─── User-provided pricing override ───

export interface FridayProviderPricingOverride {
  providerKind: FridayProviderKind;
  model: string;
  pricing: FridayProviderModelPricing;
}

// ─── Budget configuration ───

export interface FridayLlmBudgetConfig {
  monthlyLimitUsd: number;
}

// ─── Budget status (computed) ───

export interface FridayLlmBudgetStatus {
  month: string;
  config: FridayLlmBudgetConfig | null;
  spentUsd: number;
  remainingUsd: number | null;
  state: FridayBudgetState;
}

// ─── Cost-aware routing decision ───

export interface FridayCostRoutingDecision {
  strategy: FridayProviderRouteStrategy;
  costMode?: FridayProviderRoutingCostMode;
  complexity: FridayTaskComplexity;
  budgetState: FridayBudgetState;
  estimatedInputTokens: number;
  orderedCandidates: FridayResolvedProviderRoute[];
  reason: string;
  reasonCode?: FridayProviderRoutingReasonCode;
  learningAdjusted?: boolean;
  learningSignalsPresent?: boolean;
  orderingAdjusted?: boolean;
  selectedAdjusted?: boolean;
  routeDecisionTrace?: FridayProviderRoutingDecisionTrace;
}

// ─── Persisted usage record ───

export interface FridayLlmUsageRecord {
  id: string;
  occurredAt: string;
  usageDay: string;
  usageMonth: string;
  providerId: string;
  // May be "unknown" when the provider profile was deleted/disabled between the
  // LLM call and this (fire-and-forget) usage write. Never silently default to a
  // real provider kind — that would record false provider attribution.
  providerKind: FridayProviderKind | "unknown";
  providerApi: FridayProviderApi;
  model: string;
  routeStrategy: FridayProviderRouteStrategy;
  taskComplexity: FridayTaskComplexity;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  currency: "USD";
  // The provider response's own request identifier (x-request-id header or
  // response body id). Present for calls whose provider surfaced one; NULL for
  // legacy/local calls. When present it is the idempotency key: recording the
  // same requestId twice yields one row / one charge.
  requestId?: string | null;
  // Agent run/turn linkage (nullable).
  runId?: string | null;
  turnId?: string | null;
  // Deterministic receipt hash bound to the call. Recomputable for tamper
  // detection. NULL when there is no requestId to bind a receipt to.
  receipt?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ─── Provider-call receipt (durable, request-id-bound) ───

export interface FridayProviderCallReceipt {
  requestId: string;
  providerId: string;
  providerKind: FridayProviderKind | "unknown";
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  currency: "USD";
  runId: string | null;
  turnId: string | null;
  occurredAt: string;
  /** The deterministic receipt hash persisted with the record. */
  receipt: string;
}

// ─── Receipt readback (record + tamper verdict) ───

export interface FridayProviderCallReceiptLookup {
  receipt: FridayProviderCallReceipt;
  /**
   * True when the persisted receipt hash matches a recomputation over the
   * stored fields — i.e. the row has not been tampered with since recording.
   */
  receiptValid: boolean;
}

// ─── Result of a recordUsage write (idempotency-aware) ───

export interface FridayRecordUsageResult {
  /** True when this call inserted a new durable row. */
  recorded: boolean;
  /**
   * True when a row for this requestId already existed and the write was a
   * no-op (idempotent replay). Always false when there is no requestId.
   */
  duplicate: boolean;
  /** The requestId the row is keyed by, when one was supplied. */
  requestId?: string | null;
  /** The receipt hash bound to the row, when a requestId was supplied. */
  receipt?: string | null;
}

// ─── Usage summary row ───

export interface FridayProviderUsageSummaryRow {
  day?: string;
  providerId?: string;
  model?: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
}

// ─── Aggregated usage summary ───

export interface FridayProviderUsageSummary {
  from: string;
  to: string;
  groupBy: "day" | "provider" | "model";
  rows: FridayProviderUsageSummaryRow[];
  totals: {
    callCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    costUsd: number;
  };
}

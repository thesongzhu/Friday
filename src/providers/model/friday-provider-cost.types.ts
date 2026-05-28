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
  metadata: Record<string, unknown>;
  createdAt: string;
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

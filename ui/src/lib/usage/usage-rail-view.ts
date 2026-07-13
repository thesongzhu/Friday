import type { FridayProviderUsageSummary } from "@/lib/api/types";

/**
 * View model for the usage right-rail. Every number is derived from recorded
 * usage data (llm_usage_records via /v1/providers/usage) — never fabricated.
 * When there is no recorded usage the totals are 0, so the rail truthfully
 * shows a zero state rather than a placeholder.
 */
export interface UsageRailView {
  /** Month-to-date accumulated cost across all recorded provider calls. */
  cumulativeUsd: number;
  /** Cost recorded for `todayYmd` specifically. */
  todayUsd: number;
  /** Total recorded token count month-to-date. */
  totalTokens: number;
  /** Number of recorded calls month-to-date. */
  callCount: number;
  /** True once a summary has loaded (even if it is all zero). */
  hasData: boolean;
}

/** Zero state: no recorded usage yet. */
export function emptyUsageRailView(): UsageRailView {
  return {
    cumulativeUsd: 0,
    todayUsd: 0,
    totalTokens: 0,
    callCount: 0,
    hasData: false,
  };
}

/**
 * Derives the rail view from a day-grouped usage summary. `todayYmd` is the
 * YYYY-MM-DD date whose row is surfaced as "today's cost". Pure and
 * side-effect-free so it can be unit-tested without a DOM.
 */
export function deriveUsageRailView(
  summary: FridayProviderUsageSummary | undefined,
  todayYmd: string,
): UsageRailView {
  if (!summary) {
    return emptyUsageRailView();
  }
  const todayRow = summary.rows.find((row) => row.day === todayYmd);
  return {
    cumulativeUsd: summary.totals.costUsd,
    todayUsd: todayRow?.costUsd ?? 0,
    totalTokens: summary.totals.totalTokens,
    callCount: summary.totals.callCount,
    hasData: true,
  };
}

/**
 * Formats a USD figure for the compact rail. Zero renders as "$0.00"; a nonzero
 * amount smaller than a cent renders as "<$0.01" so a real-but-tiny spend is
 * never rounded to look like nothing.
 */
export function formatRailUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "$0.00";
  }
  if (value < 0.01) {
    return "<$0.01";
  }
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

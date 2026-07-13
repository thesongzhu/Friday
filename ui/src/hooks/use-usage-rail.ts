import { useQuery } from "@tanstack/react-query";
import { providerUsageApi } from "@/lib/api/provider-usage";
import type { FridayProviderUsageSummary } from "@/lib/api/types";
import {
  deriveUsageRailView,
  emptyUsageRailView,
  type UsageRailView,
} from "@/lib/usage/usage-rail-view";

/**
 * Month-to-date usage range in UTC — llm_usage_records.usage_day is written from
 * ISO UTC dates, so the rail must query on the same boundary as the server.
 */
function currentUtcUsageRange(): { from: string; to: string; today: string } {
  const today = new Date().toISOString().slice(0, 10);
  return { from: `${today.slice(0, 7)}-01`, to: today, today };
}

export interface UsageRailResult extends UsageRailView {
  loading: boolean;
}

/**
 * Feeds the usage right-rail with real accumulated spend read from
 * /v1/providers/usage. On error or before load it returns the zero state, so
 * the rail never shows a fabricated figure.
 */
export function useUsageRail(options?: { enabled?: boolean }): UsageRailResult {
  const range = currentUtcUsageRange();
  const { data, isLoading } = useQuery<FridayProviderUsageSummary>({
    queryKey: ["providers", "usage", "rail", range.from, range.to],
    queryFn: () =>
      providerUsageApi.getUsageSummary({
        from: range.from,
        to: range.to,
        groupBy: "day",
      }),
    refetchInterval: 60_000,
    enabled: options?.enabled ?? true,
  });

  if (isLoading || !data) {
    return { ...emptyUsageRailView(), loading: isLoading };
  }
  return { ...deriveUsageRailView(data, range.today), loading: false };
}

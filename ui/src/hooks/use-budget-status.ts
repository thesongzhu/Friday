import { useQuery } from "@tanstack/react-query";
import { providerUsageApi } from "@/lib/api/provider-usage";
import type { FridayBudgetState, FridayLlmBudgetStatus } from "@/lib/api/types";

export interface BudgetStatusViewModel {
  loading: boolean;
  spentUsd: number;
  limitUsd: number | null;
  remainingUsd: number | null;
  percentUsed: number | null;
  state: FridayBudgetState;
  tone: "neutral" | "warning" | "critical";
}

export function useBudgetStatus(options?: { enabled?: boolean }): BudgetStatusViewModel {
  const { data, isLoading } = useQuery<FridayLlmBudgetStatus>({
    queryKey: ["providers", "budget"],
    queryFn: () => providerUsageApi.getBudget(),
    refetchInterval: 60_000,
    enabled: options?.enabled ?? true,
  });

  if (isLoading || !data) {
    return {
      loading: true,
      spentUsd: 0,
      limitUsd: null,
      remainingUsd: null,
      percentUsed: null,
      state: "ok",
      tone: "neutral",
    };
  }

  const limitUsd = data.config?.monthlyLimitUsd ?? null;
  const percentUsed = limitUsd && limitUsd > 0 ? (data.spentUsd / limitUsd) * 100 : null;
  const tone: BudgetStatusViewModel["tone"] =
    data.state === "over_limit" ? "critical"
      : data.state === "near_limit" ? "warning"
        : "neutral";

  return {
    loading: false,
    spentUsd: data.spentUsd,
    limitUsd,
    remainingUsd: data.remainingUsd,
    percentUsed,
    state: data.state,
    tone,
  };
}

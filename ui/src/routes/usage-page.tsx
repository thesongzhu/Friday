import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { providersApi } from "@/lib/api/providers";
import { providerUsageApi } from "@/lib/api/provider-usage";
import { SkeletonCard, StatusPill } from "@/components/core/primitives";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
import type {
  FridayLlmBudgetStatus,
  FridayModelRoutingConfig,
  FridayProviderRoutingExplainReport,
  FridayProviderUsageSummary,
} from "@/lib/api/types";

const USAGE_INPUT_BAR_COLOR = "var(--color-accent)";
const USAGE_OUTPUT_BAR_COLOR = "var(--coral)";
const USAGE_PROVIDER_BAR_COLOR = "var(--color-accent)";

// ─── Types ───

interface ProviderHealthItem {
  providerId: string;
  providerKind: string;
  lane: "primary" | "fallback" | "standby" | "disabled";
  enabled: boolean;
  defaultModel?: string;
  backendKind: string;
  authMode: string;
  backendHealth: string;
  authHealth: string;
  routingEligible: boolean;
  validationStatus: "never" | "ok" | "failed";
  circuitState: "closed" | "cooldown" | "unknown";
  cooldownRemainingMs?: number;
  lastFailureAt?: string;
  reasons: string[];
  suggestedAction: string;
}

interface ProviderHealthResponse {
  items: ProviderHealthItem[];
}

interface ProviderItem {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
}

interface ProviderListResponse {
  items: ProviderItem[];
}

// ─── Hooks ───

function useProviderHealth() {
  return useQuery({
    queryKey: ["provider-health"],
    queryFn: async (): Promise<ProviderHealthItem[]> => {
      try {
        const data = await apiClient.get<ProviderHealthResponse>("/v1/providers/health");
        return data.items ?? [];
      } catch {
        return [];
      }
    },
    refetchInterval: 30_000,
  });
}

function useProviderUsage() {
  return useQuery({
    queryKey: ["provider-usage", "provider"],
    queryFn: async (): Promise<FridayProviderUsageSummary> =>
      providerUsageApi.getUsageSummary({ groupBy: "provider" }),
    refetchInterval: 30_000,
  });
}

function useBudgetStatus() {
  return useQuery({
    queryKey: ["provider-budget"],
    queryFn: async (): Promise<FridayLlmBudgetStatus> => providerUsageApi.getBudget(),
    refetchInterval: 30_000,
  });
}

function useProviders() {
  return useQuery({
    queryKey: ["providers"],
    queryFn: async (): Promise<ProviderItem[]> => {
      try {
        const data = await apiClient.get<ProviderListResponse>("/v1/providers");
        return data.items ?? [];
      } catch {
        return [];
      }
    },
    refetchInterval: 60_000,
  });
}

function useRoutingConfig() {
  return useQuery({
    queryKey: ["provider-routing"],
    queryFn: async (): Promise<FridayModelRoutingConfig> => providersApi.getRouting(),
    refetchInterval: 30_000,
  });
}

function hasRoutingEligibleProvider(
  healthItems: ProviderHealthItem[],
  routingConfig: FridayModelRoutingConfig | undefined,
): boolean {
  if (!routingConfig?.defaultProviderId) {
    return false;
  }
  const routedProviderIds = new Set([
    routingConfig.defaultProviderId,
    ...(routingConfig.fallbackProviderIds ?? []),
  ]);
  return healthItems.some((item) =>
    item.enabled &&
    item.routingEligible &&
    routedProviderIds.has(item.providerId)
  );
}

function useRoutingExplain(enabled: boolean) {
  return useQuery({
    queryKey: ["provider-routing-explain", "usage-page"],
    queryFn: async (): Promise<FridayProviderRoutingExplainReport> =>
      providersApi.explainRouting({ estimatedInputTokens: 0, complexity: "medium" }),
    enabled,
    refetchInterval: 30_000,
  });
}

// ─── Helpers ───

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString();
}

function formatDateTime(value?: string): string {
  if (!value) return "n/a";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "n/a" : parsed.toLocaleString();
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatTokenSharePercent(value: number, total: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) {
    return "0%";
  }
  const pct = Math.round((Math.max(0, value) / total) * 100);
  return `${String(Math.max(0, Math.min(100, pct)))}%`;
}

function laneLabel(lane: ProviderHealthItem["lane"], locale: import("@/lib/i18n/localized-text").AppLocale): string {
  switch (lane) {
    case "primary":
      return localize(locale, "主链路", "Primary");
    case "fallback":
      return localize(locale, "回退链路", "Fallback");
    case "standby":
      return localize(locale, "待命", "Standby");
    case "disabled":
      return localize(locale, "已禁用", "Disabled");
    default:
      return lane;
  }
}

function providerStatusBadge(item: ProviderHealthItem, locale: import("@/lib/i18n/localized-text").AppLocale) {
  if (item.validationStatus === "failed") {
    return <StatusPill tone="danger">{localize(locale, "验证失败", "Validation failed")}</StatusPill>;
  }
  if (!item.routingEligible) {
    return <StatusPill tone="warning">{localize(locale, "不可路由", "Not routable")}</StatusPill>;
  }
  if (item.backendHealth === "healthy" && item.authHealth === "healthy") {
    return <StatusPill tone="success">{localize(locale, "可用", "Ready")}</StatusPill>;
  }
  if (item.backendHealth === "missing" || item.authHealth === "missing") {
    return <StatusPill tone="danger">{localize(locale, "缺少依赖", "Missing dependency")}</StatusPill>;
  }
  return <StatusPill tone="warning">{localize(locale, "需关注", "Needs attention")}</StatusPill>;
}

export function budgetStatusTone(status: FridayLlmBudgetStatus["state"]): "success" | "warning" | "danger" | undefined {
  switch (status) {
    case "ok":
      return "success";
    case "near_limit":
      return "warning";
    case "over_limit":
      return "danger";
    default:
      return undefined;
  }
}

export function budgetStatusLabel(status: FridayLlmBudgetStatus["state"], locale: import("@/lib/i18n/localized-text").AppLocale): string {
  switch (status) {
    case "ok":
      return localize(locale, "预算正常", "Budget OK");
    case "near_limit":
      return localize(locale, "接近上限", "Near limit");
    case "over_limit":
      return localize(locale, "超出上限", "Over limit");
    default:
      return localize(locale, "未知", "Unknown");
  }
}

function budgetStatusBadge(status: FridayLlmBudgetStatus["state"], locale: import("@/lib/i18n/localized-text").AppLocale) {
  return <StatusPill tone={budgetStatusTone(status)}>{budgetStatusLabel(status, locale)}</StatusPill>;
}

// Re-export from extracted chart module for direct use
import { PercentBar } from "@/components/usage/usage-charts";

// ─── Page ───

export function UsagePage() {
  const { locale } = useAppLocale();
  const { data: healthItems = [], isLoading: healthLoading, isError: healthError } = useProviderHealth();
  const { data: usageSummary, isLoading: usageLoading, isError: usageError } = useProviderUsage();
  const { data: budgetStatus, isLoading: budgetLoading, isError: budgetError } = useBudgetStatus();
  const { data: providers = [], isLoading: providersLoading, isError: providersError } = useProviders();
  const { data: routingConfig, isLoading: routingLoading, isError: routingConfigError } = useRoutingConfig();
  const routingExplainEnabled = hasRoutingEligibleProvider(healthItems, routingConfig);
  const { data: routingExplain, isLoading: routingExplainLoading, isError: routingExplainError } = useRoutingExplain(
    routingExplainEnabled,
  );

  const isLoading = healthLoading || usageLoading || budgetLoading || providersLoading;
  const isError = healthError || usageError || budgetError || providersError;

  const totals = usageSummary?.totals ?? {
    callCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
  const estimatedInputTokens = totals.inputTokens;
  const estimatedOutputTokens = totals.outputTokens;
  const estimatedTotalTokens = totals.totalTokens;

  // Build per-provider cost table by joining health with provider metadata.
  const providerMap = new Map(providers.map((p) => [p.id, p]));
  const healthMap = new Map(healthItems.map((item) => [item.providerId, item]));
  const selectedRoute = routingExplain?.selected ?? routingExplain?.candidates.find((candidate) => candidate.selected);
  const defaultProvider = routingConfig ? providerMap.get(routingConfig.defaultProviderId) : undefined;
  const selectedProvider = selectedRoute ? providerMap.get(selectedRoute.providerId) : undefined;
  const routeDiffersFromDefault = Boolean(
    routingConfig
    && selectedRoute
    && selectedRoute.providerId !== routingConfig.defaultProviderId,
  );
  const costRows = (usageSummary?.rows ?? []).map((row) => {
    const providerId = row.providerId ?? "";
    const meta = providerMap.get(providerId);
    const health = healthMap.get(providerId);
    return {
      id: providerId,
      name: meta?.name ?? providerId,
      kind: meta?.kind ?? "unknown",
      requests: row.callCount,
      tokens: row.totalTokens,
      costUsd: row.costUsd,
      lane: health?.lane,
    };
  });
  const validationFailedCount = healthItems.filter((item) => item.validationStatus === "failed").length;
  const unroutableCount = healthItems.filter((item) => !item.routingEligible).length;
  const cooldownCount = healthItems.filter((item) => item.circuitState === "cooldown").length;

  const maxTokensInRow = Math.max(...costRows.map((r) => r.tokens), 1);

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
          {localize(locale, "用量与成本", "Usage & Cost")}
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
          {localize(
            locale,
            "这里展示的是 Friday 当前运行态的真实 usage、预算和 provider 健康快照。账单结算仍以各提供商后台为准。",
            "This page shows Friday's live usage, budget, and provider-health snapshot for the current runtime. Final billing truth still lives in each provider console.",
          )}
        </p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <SkeletonCard lines={1} />
          <SkeletonCard lines={1} />
          <SkeletonCard lines={1} />
          <SkeletonCard lines={1} />
        </div>
      ) : isError ? (
        <div className="rounded-xl border border-[color:var(--color-border-danger)] bg-[color:var(--color-bg-danger-subtle)] p-8 text-center">
          <p className="text-sm font-medium status-error">{localize(locale, "加载用量数据失败", "Failed to load usage data")}</p>
          <p className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">{localize(locale, "提供商健康信息暂时不可用。", "Provider health information is temporarily unavailable.")}</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* ─── Active Routing Snapshot ─── */}
          <div className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium text-[color:var(--color-text-primary)]">
                  {localize(locale, "当前默认路由", "Current Default Route")}
                </h2>
                <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">
                  {localize(
                    locale,
                    "这里是下一次未显式指定 provider/model 时的实际路由说明；下面的用量表只是历史账本，不代表下一次会用哪把 key。",
                    "This shows the route Friday will use for the next run without an explicit provider/model. The usage table below is historical ledger data, not the next-key selector.",
                  )}
                </p>
              </div>
              {routingLoading || routingExplainLoading ? (
                <StatusPill>{localize(locale, "检查中", "Checking")}</StatusPill>
              ) : routeDiffersFromDefault ? (
                <StatusPill tone="warning">{localize(locale, "路由已调整", "Route adjusted")}</StatusPill>
              ) : selectedRoute ? (
                <StatusPill tone="success">{localize(locale, "按默认路由", "Default route")}</StatusPill>
              ) : (
                <StatusPill tone="warning">{localize(locale, "不可用", "Unavailable")}</StatusPill>
              )}
            </div>

            {routingConfigError || routingExplainError ? (
              <p className="mt-4 rounded-lg bg-[color:var(--color-bg-warning-subtle)] p-3 text-xs text-[color:var(--color-text-secondary)]">
                {localize(locale, "无法读取当前路由解释。请到 Providers 页面检查 provider 健康状态。", "Unable to read the current routing explanation. Check provider health on the Providers page.")}
              </p>
            ) : (
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <div className="rounded-lg bg-[color:var(--color-bg-subtle)] p-3">
                  <p className="text-xs text-[color:var(--color-text-secondary)]">{localize(locale, "配置默认", "Configured default")}</p>
                  <p className="mt-1 text-sm font-semibold text-[color:var(--color-text-primary)]">
                    {defaultProvider?.name ?? routingConfig?.defaultProviderId ?? "n/a"}
                  </p>
                  <p className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">
                    {routingConfig?.defaultModel ?? localize(locale, "使用 provider 默认模型", "Provider default model")}
                  </p>
                </div>
                <div className="rounded-lg bg-[color:var(--color-bg-subtle)] p-3">
                  <p className="text-xs text-[color:var(--color-text-secondary)]">{localize(locale, "实际首选", "Actual first choice")}</p>
                  <p className="mt-1 text-sm font-semibold text-[color:var(--color-text-primary)]">
                    {selectedProvider?.name ?? selectedRoute?.providerId ?? "n/a"}
                  </p>
                  <p className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">
                    {selectedRoute?.model ?? "n/a"}
                  </p>
                </div>
                <div className="rounded-lg bg-[color:var(--color-bg-subtle)] p-3">
                  <p className="text-xs text-[color:var(--color-text-secondary)]">{localize(locale, "原因", "Reason")}</p>
                  <p className="mt-1 text-sm font-semibold text-[color:var(--color-text-primary)]">
                    {routingExplain?.reasonCode ?? "n/a"}
                  </p>
                  <p className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">
                    {routingExplain?.reasonText ?? localize(locale, "暂无路由说明", "No routing explanation available")}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* ─── Token Usage Summary ─── */}
          <div className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-5">
            <h2 className="text-sm font-medium text-[color:var(--color-text-primary)]">
              {localize(locale, "Token 用量", "Token Usage")}
            </h2>
            <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">
              {localize(locale, "这里展示的是当前运行态累积记录下来的真实 token 统计，不再是按请求数反推的占位估算。", "This section shows real token totals recorded by the current runtime rather than placeholder estimates derived from request counts.")}
            </p>
            <div className="mt-4 grid grid-cols-3 gap-4">
              <div className="rounded-lg bg-[color:var(--color-bg-subtle)] p-3">
                <p className="text-xs text-[color:var(--color-text-secondary)]">{localize(locale, "总 Token", "Total Tokens")}</p>
                <p className="mt-1 text-lg font-semibold text-[color:var(--color-text-primary)]">
                  {formatNumber(estimatedTotalTokens)}
                </p>
              </div>
              <div className="rounded-lg bg-[color:var(--color-bg-subtle)] p-3">
                <p className="text-xs text-[color:var(--color-text-secondary)]">{localize(locale, "输入 Token", "Input Tokens")}</p>
                <p className="mt-1 text-lg font-semibold text-[color:var(--color-accent)]">
                  {formatNumber(estimatedInputTokens)}
                </p>
              </div>
              <div className="rounded-lg bg-[color:var(--color-bg-subtle)] p-3">
                <p className="text-xs text-[color:var(--color-text-secondary)]">{localize(locale, "输出 Token", "Output Tokens")}</p>
                <p className="mt-1 text-lg font-semibold text-[color:var(--color-accent)]">
                  {formatNumber(estimatedOutputTokens)}
                </p>
              </div>
            </div>

            {/* Simple input/output bar */}
            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-3">
                <span className="w-14 text-xs text-[color:var(--color-text-secondary)]">{localize(locale, "输入", "Input")}</span>
                <div className="flex-1">
                  <PercentBar value={estimatedInputTokens} max={estimatedTotalTokens} color={USAGE_INPUT_BAR_COLOR} />
                </div>
                <span className="w-10 text-right text-xs text-[color:var(--color-text-secondary)]">
                  {formatTokenSharePercent(estimatedInputTokens, estimatedTotalTokens)}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-14 text-xs text-[color:var(--color-text-secondary)]">{localize(locale, "输出", "Output")}</span>
                <div className="flex-1">
                  <PercentBar value={estimatedOutputTokens} max={estimatedTotalTokens} color={USAGE_OUTPUT_BAR_COLOR} />
                </div>
                <span className="w-10 text-right text-xs text-[color:var(--color-text-secondary)]">
                  {formatTokenSharePercent(estimatedOutputTokens, estimatedTotalTokens)}
                </span>
              </div>
            </div>
          </div>

          {/* ─── Budget ─── */}
          <div className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium text-[color:var(--color-text-primary)]">
                {localize(locale, "月度预算", "Monthly Budget")}
              </h2>
              {budgetStatus ? budgetStatusBadge(budgetStatus.state, locale) : null}
            </div>
            {budgetStatus ? (
              <div className="mt-4 grid grid-cols-3 gap-4">
                <div className="rounded-lg bg-[color:var(--color-bg-subtle)] p-3">
                  <p className="text-xs text-[color:var(--color-text-secondary)]">{localize(locale, "本月已花费", "Spent this month")}</p>
                  <p className="mt-1 text-lg font-semibold text-[color:var(--color-text-primary)]">
                    {formatUsd(budgetStatus.spentUsd)}
                  </p>
                </div>
                <div className="rounded-lg bg-[color:var(--color-bg-subtle)] p-3">
                  <p className="text-xs text-[color:var(--color-text-secondary)]">{localize(locale, "预算上限", "Budget limit")}</p>
                  <p className="mt-1 text-lg font-semibold text-[color:var(--color-text-primary)]">
                    {budgetStatus.config ? formatUsd(budgetStatus.config.monthlyLimitUsd) : localize(locale, "未配置", "Unset")}
                  </p>
                </div>
                <div className="rounded-lg bg-[color:var(--color-bg-subtle)] p-3">
                  <p className="text-xs text-[color:var(--color-text-secondary)]">{localize(locale, "剩余额度", "Remaining budget")}</p>
                  <p className="mt-1 text-lg font-semibold text-[color:var(--color-text-primary)]">
                    {budgetStatus.remainingUsd == null ? localize(locale, "未配置", "Unset") : formatUsd(budgetStatus.remainingUsd)}
                  </p>
                </div>
              </div>
            ) : null}
          </div>

          {/* ─── Cost by Provider ─── */}
          <div className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-5">
            <h2 className="text-sm font-medium text-[color:var(--color-text-primary)]">
              {localize(locale, "按提供商计费", "Cost by Provider")}
            </h2>

            {costRows.length === 0 ? (
              <p className="mt-3 text-xs text-[color:var(--color-text-secondary)]">
                {localize(locale, "暂无提供商数据。", "No provider data available yet.")}
              </p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-[color:var(--color-border-soft)] text-xs text-[color:var(--color-text-secondary)]">
                      <th className="pb-2 pr-4 font-medium">{localize(locale, "提供商", "Provider")}</th>
                      <th className="pb-2 pr-4 font-medium">{localize(locale, "链路", "Lane")}</th>
                      <th className="pb-2 pr-4 font-medium">{localize(locale, "请求数", "Requests")}</th>
                      <th className="pb-2 pr-4 font-medium">{localize(locale, "Token 数", "Tokens")}</th>
                      <th className="pb-2 pr-4 font-medium">{localize(locale, "分布", "Distribution")}</th>
                      <th className="pb-2 font-medium text-right">{localize(locale, "成本", "Cost")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {costRows.map((row) => (
                      <tr key={row.id} className="border-b border-[color:var(--color-border-soft)] last:border-0">
                        <td className="py-2.5 pr-4">
                          <p className="font-medium text-[color:var(--color-text-primary)]">{row.name}</p>
                          <p className="text-xs text-[color:var(--color-text-secondary)]">{row.kind}</p>
                        </td>
                        <td className="py-2.5 pr-4 text-[color:var(--color-text-secondary)]">
                          {row.lane ? laneLabel(row.lane, locale) : localize(locale, "未知", "Unknown")}
                        </td>
                        <td className="py-2.5 pr-4 text-[color:var(--color-text-secondary)]">
                          {formatNumber(row.requests)}
                        </td>
                        <td className="py-2.5 pr-4 text-[color:var(--color-text-secondary)]">
                          {formatNumber(row.tokens)}
                        </td>
                        <td className="w-32 py-2.5 pr-4">
                          <PercentBar value={row.tokens} max={maxTokensInRow} color={USAGE_PROVIDER_BAR_COLOR} />
                        </td>
                        <td className="py-2.5 text-right font-medium text-[color:var(--color-text-primary)]">
                          {formatUsd(row.costUsd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ─── Routing & Validation ─── */}
          <div className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-5">
            <h2 className="text-sm font-medium text-[color:var(--color-text-primary)]">
              {localize(locale, "路由与校验", "Routing & Validation")}
            </h2>
            <div className="mt-4 grid grid-cols-3 gap-4">
              <div className="rounded-lg bg-[color:var(--color-bg-subtle)] p-3">
                <p className="text-xs text-[color:var(--color-text-secondary)]">{localize(locale, "不可路由 provider", "Non-routable providers")}</p>
                <p className="mt-1 text-lg font-semibold text-[color:var(--color-text-primary)]">
                  {formatNumber(unroutableCount)}
                </p>
              </div>
              <div className="rounded-lg bg-[color:var(--color-bg-subtle)] p-3">
                <p className="text-xs text-[color:var(--color-text-secondary)]">{localize(locale, "校验失败", "Validation failed")}</p>
                <p className={`mt-1 text-lg font-semibold ${validationFailedCount > 0 ? "text-[color:var(--color-text-danger)]" : "text-[color:var(--color-text-success)]"}`}>
                  {formatNumber(validationFailedCount)}
                </p>
              </div>
              <div className="rounded-lg bg-[color:var(--color-bg-subtle)] p-3">
                <p className="text-xs text-[color:var(--color-text-secondary)]">{localize(locale, "冷却中的 provider", "Providers in cooldown")}</p>
                <p className="mt-1 text-lg font-semibold text-[color:var(--color-text-warning)]">
                  {formatNumber(cooldownCount)}
                </p>
              </div>
            </div>
          </div>

          {/* ─── Provider Health Status ─── */}
          <div className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-5">
            <h2 className="text-sm font-medium text-[color:var(--color-text-primary)]">
              {localize(locale, "提供商健康", "Provider Health")}
            </h2>

            {healthItems.length === 0 ? (
              <p className="mt-3 text-xs text-[color:var(--color-text-secondary)]">
                {localize(locale, "暂无提供商健康数据。", "No providers reporting health data.")}
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {healthItems.map((item) => {
                  const meta = providerMap.get(item.providerId);
                  return (
                    <div
                      key={item.providerId}
                      className="flex items-center justify-between rounded-lg border border-[color:var(--color-border-soft)] px-4 py-3"
                    >
                      <div>
                        <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
                          {meta?.name ?? item.providerId}
                        </p>
                        <p className="text-xs text-[color:var(--color-text-secondary)]">
                          {item.providerKind} {" \u00b7 "} {laneLabel(item.lane, locale)} {" \u00b7 "}
                          {item.backendKind}/{item.authMode}
                          {item.defaultModel ? ` · ${item.defaultModel}` : ""}
                        </p>
                        <p className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">
                          {localize(locale, "后端", "Backend")}: {item.backendHealth}
                          {" · "}
                          {localize(locale, "鉴权", "Auth")}: {item.authHealth}
                          {" · "}
                          {localize(locale, "验证", "Validation")}: {item.validationStatus}
                          {item.lastFailureAt ? ` · ${localize(locale, "最近失败", "Last failure")} ${formatDateTime(item.lastFailureAt)}` : ""}
                        </p>
                        {item.reasons.length > 0 ? (
                          <p className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">
                            {item.reasons.join(", ")}
                          </p>
                        ) : null}
                      </div>
                      {providerStatusBadge(item, locale)}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ─── Pricing Note ─── */}
          <div className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
            <h2 className="text-sm font-medium text-[color:var(--color-text-primary)]">
              {localize(locale, "定价配置", "Pricing Configuration")}
            </h2>
            <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">
              {localize(
                locale,
                "如果这里的 usage、预算或 provider health 与你预期不一致，优先相信这些实时路由返回，而不是旧文档或旧截图。你可以在",
                "If usage, budget, or provider health here differs from what you expected, trust these live routes over old docs or screenshots. You can adjust related pricing and routing settings in",
              )}{" "}
              <a href="/settings" className="font-medium text-indigo-600 underline underline-offset-2 dark:text-indigo-400">
                {localize(locale, "设置", "Settings")}
              </a>{" "}
              {localize(
                locale,
                "中覆盖每个模型的定价费率，以匹配您的实际提供商合同和协商价格。",
                "to match your actual provider contracts and negotiated rates.",
              )}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

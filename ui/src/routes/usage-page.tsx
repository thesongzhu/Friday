import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { SkeletonCard } from "@/components/core/primitives";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

// ─── Types ───

interface ProviderHealthItem {
  providerId: string;
  providerKind: string;
  status: string;
  successCount: number;
  errorCount: number;
  latencyMs: number;
  lastChecked: string;
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

// ─── Helpers ───

/** Rough cost estimate using a generic placeholder rate. Not real billing. */
function estimateCost(tokens: number): string {
  return `~$${(tokens * 0.00001).toFixed(4)}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function statusBadge(status?: string) {
  switch (status) {
    case "healthy":
    case "ok":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
          Healthy
        </span>
      );
    case "degraded":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
          Degraded
        </span>
      );
    case "down":
    case "error":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
          Down
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          Unknown
        </span>
      );
  }
}

// Re-export from extracted chart module for direct use
import { PercentBar } from "@/components/usage/usage-charts";

// ─── Page ───

export function UsagePage() {
  const locale = useAppLocale();
  const { data: healthItems = [], isLoading: healthLoading, isError: healthError } = useProviderHealth();
  const { data: providers = [], isLoading: providersLoading, isError: providersError } = useProviders();

  const isLoading = healthLoading || providersLoading;
  const isError = healthError || providersError;

  // Aggregate stats from provider health data.
  const totalRequests = healthItems.reduce((sum, p) => sum + p.successCount + p.errorCount, 0);
  const totalErrors = healthItems.reduce((sum, p) => sum + p.errorCount, 0);
  const totalSuccess = healthItems.reduce((sum, p) => sum + p.successCount, 0);
  const errorRate = totalRequests > 0 ? ((totalErrors / totalRequests) * 100).toFixed(1) : "0.0";

  // Rough token estimate: 800 tokens per successful request (placeholder).
  const estimatedTotalTokens = totalSuccess * 800;
  const estimatedInputTokens = Math.round(estimatedTotalTokens * 0.35);
  const estimatedOutputTokens = estimatedTotalTokens - estimatedInputTokens;

  // Build per-provider cost table by joining health with provider metadata.
  const providerMap = new Map(providers.map((p) => [p.id, p]));
  const costRows = healthItems.map((h) => {
    const meta = providerMap.get(h.providerId);
    const reqs = h.successCount + h.errorCount;
    const tokens = h.successCount * 800;
    return {
      name: meta?.name ?? h.providerId,
      kind: meta?.kind ?? h.providerKind,
      requests: reqs,
      tokens,
      cost: estimateCost(tokens),
    };
  });

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
            "监控提供商健康状态和请求量。下方的 Token 和成本数据为基于请求数和通用定价的粗略估算，非实际计费数据。",
            "Monitor provider health and request volume. Token and cost figures below are rough estimates derived from request counts and generic pricing — they are not actual billing data.",
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
        <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center dark:border-red-900/50 dark:bg-red-900/20">
          <p className="text-sm font-medium status-error">{localize(locale, "加载用量数据失败", "Failed to load usage data")}</p>
          <p className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">{localize(locale, "提供商健康信息暂时不可用。", "Provider health information is temporarily unavailable.")}</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* ─── Token Usage Summary ─── */}
          <div className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-5">
            <h2 className="text-sm font-medium text-[color:var(--color-text-primary)]">
              {localize(locale, "Token 用量估算", "Token Usage Estimate")}
            </h2>
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              {localize(locale, "Token 数按每次成功请求约 800 个估算（输入/输出比 35/65）。实际用量因模型和提示长度而异。", "Tokens are estimated at ~800 per successful request with a 35/65 input/output split. Actual usage varies by model and prompt length.")}
            </p>
            <div className="mt-4 grid grid-cols-3 gap-4">
              <div className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50">
                <p className="text-xs text-[color:var(--color-text-secondary)]">{localize(locale, "总 Token", "Total Tokens")}</p>
                <p className="mt-1 text-lg font-semibold text-[color:var(--color-text-primary)]">
                  {formatNumber(estimatedTotalTokens)}
                </p>
              </div>
              <div className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50">
                <p className="text-xs text-[color:var(--color-text-secondary)]">{localize(locale, "输入 Token", "Input Tokens")}</p>
                <p className="mt-1 text-lg font-semibold text-indigo-600 dark:text-indigo-400">
                  {formatNumber(estimatedInputTokens)}
                </p>
              </div>
              <div className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50">
                <p className="text-xs text-[color:var(--color-text-secondary)]">{localize(locale, "输出 Token", "Output Tokens")}</p>
                <p className="mt-1 text-lg font-semibold text-violet-600 dark:text-violet-400">
                  {formatNumber(estimatedOutputTokens)}
                </p>
              </div>
            </div>

            {/* Simple input/output bar */}
            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-3">
                <span className="w-14 text-xs text-[color:var(--color-text-secondary)]">Input</span>
                <div className="flex-1">
                  <PercentBar value={estimatedInputTokens} max={estimatedTotalTokens} color="#6366f1" />
                </div>
                <span className="w-10 text-right text-xs text-[color:var(--color-text-secondary)]">35%</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-14 text-xs text-[color:var(--color-text-secondary)]">Output</span>
                <div className="flex-1">
                  <PercentBar value={estimatedOutputTokens} max={estimatedTotalTokens} color="#8b5cf6" />
                </div>
                <span className="w-10 text-right text-xs text-[color:var(--color-text-secondary)]">65%</span>
              </div>
            </div>
          </div>

          {/* ─── Cost by Provider ─── */}
          <div className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-5">
            <h2 className="text-sm font-medium text-[color:var(--color-text-primary)]">
              Cost by Provider
            </h2>

            {costRows.length === 0 ? (
              <p className="mt-3 text-xs text-[color:var(--color-text-secondary)]">
                No provider data available yet.
              </p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-[color:var(--color-border-soft)] text-xs text-[color:var(--color-text-secondary)]">
                      <th className="pb-2 pr-4 font-medium">Provider</th>
                      <th className="pb-2 pr-4 font-medium">Requests</th>
                      <th className="pb-2 pr-4 font-medium">Tokens</th>
                      <th className="pb-2 pr-4 font-medium">Distribution</th>
                      <th className="pb-2 font-medium text-right">Est. Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {costRows.map((row) => (
                      <tr key={row.name} className="border-b border-[color:var(--color-border-soft)] last:border-0">
                        <td className="py-2.5 pr-4">
                          <p className="font-medium text-[color:var(--color-text-primary)]">{row.name}</p>
                          <p className="text-xs text-[color:var(--color-text-secondary)]">{row.kind}</p>
                        </td>
                        <td className="py-2.5 pr-4 text-[color:var(--color-text-secondary)]">
                          {formatNumber(row.requests)}
                        </td>
                        <td className="py-2.5 pr-4 text-[color:var(--color-text-secondary)]">
                          {formatNumber(row.tokens)}
                        </td>
                        <td className="w-32 py-2.5 pr-4">
                          <PercentBar value={row.tokens} max={maxTokensInRow} color="#6366f1" />
                        </td>
                        <td className="py-2.5 text-right font-medium text-[color:var(--color-text-primary)]">
                          {row.cost}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ─── Error Rate & Fallback ─── */}
          <div className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-5">
            <h2 className="text-sm font-medium text-[color:var(--color-text-primary)]">
              {localize(locale, "错误率与回退", "Error Rate & Fallbacks")}
            </h2>
            <div className="mt-4 grid grid-cols-3 gap-4">
              <div className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50">
                <p className="text-xs text-[color:var(--color-text-secondary)]">{localize(locale, "总请求数", "Total Requests")}</p>
                <p className="mt-1 text-lg font-semibold text-[color:var(--color-text-primary)]">
                  {formatNumber(totalRequests)}
                </p>
              </div>
              <div className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50">
                <p className="text-xs text-[color:var(--color-text-secondary)]">{localize(locale, "错误率", "Error Rate")}</p>
                <p className={`mt-1 text-lg font-semibold ${Number(errorRate) > 5 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                  {errorRate}%
                </p>
              </div>
              <div className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50">
                <p className="text-xs text-[color:var(--color-text-secondary)]">Fallback Count</p>
                <p className="mt-1 text-lg font-semibold text-amber-600 dark:text-amber-400">
                  {formatNumber(totalErrors)}
                </p>
              </div>
            </div>

            {/* Error bar */}
            <div className="mt-4">
              <div className="flex items-center gap-3">
                <span className="w-14 text-xs text-[color:var(--color-text-secondary)]">Errors</span>
                <div className="flex-1">
                  <PercentBar value={totalErrors} max={totalRequests} color="#ef4444" />
                </div>
                <span className="w-14 text-right text-xs text-[color:var(--color-text-secondary)]">
                  {errorRate}%
                </span>
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
                No providers reporting health data.
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
                          {item.providerKind}
                          {" \u00b7 "}
                          {String(item.latencyMs)}ms avg
                          {" \u00b7 "}
                          last checked {new Date(item.lastChecked).toLocaleTimeString()}
                        </p>
                      </div>
                      {statusBadge(item.status)}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ─── Pricing Note ─── */}
          <div className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
            <h2 className="text-sm font-medium text-[color:var(--color-text-primary)]">
              Pricing Configuration
            </h2>
            <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">
              The estimated costs shown above use default token pricing. You can override per-model pricing rates in{" "}
              <a href="/settings" className="font-medium text-indigo-600 underline underline-offset-2 dark:text-indigo-400">
                Settings
              </a>{" "}
              to match your actual provider contracts and negotiated rates.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { BookOpen, Brain, Shield, TrendingUp } from "lucide-react";
import { learningApi } from "@/lib/api/learning";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
import { SkeletonLine } from "@/components/core/primitives";

/**
 * Compact card showing Friday's learning status — how many lessons,
 * patterns, and auto-fixes it has accumulated. Makes the intelligence
 * layer visible to the user.
 */
export function LearningInsightCard() {
  const { locale } = useAppLocale();
  const { data: overview, isLoading } = useQuery({
    queryKey: ["learning", "overview"],
    queryFn: () => learningApi.getOverview(5),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4">
        <SkeletonLine width="40%" />
        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="skeleton" style={{ height: 56, borderRadius: 12 }} />
          ))}
        </div>
      </div>
    );
  }

  if (!overview) return null;

  const stats = [
    {
      icon: BookOpen,
      value: overview.coverage.lessons,
      label: localize(locale, "教训", "Lessons"),
      tone: "text-[color:var(--color-info)]",
      bg: "bg-[color:var(--color-accent-soft)]",
    },
    {
      icon: TrendingUp,
      value: overview.coverage.patterns,
      label: localize(locale, "模式", "Patterns"),
      tone: "text-[color:var(--color-success)]",
      bg: "bg-emerald-50",
    },
    {
      icon: Shield,
      value: overview.coverage.autoFixActions,
      label: localize(locale, "自动修复", "Auto-fixes"),
      tone: "text-[color:var(--color-warning)]",
      bg: "bg-amber-50",
    },
    {
      icon: Brain,
      value: overview.coverage.incidents,
      label: localize(locale, "诊断", "Diagnoses"),
      tone: "text-[color:var(--color-text-secondary)]",
      bg: "bg-[color:var(--color-bg-subtle)]",
    },
  ];

  const hasActivity = stats.some((s) => s.value > 0);

  return (
    <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4 transition-all hover:shadow-[var(--shadow-floating)]">
      <div className="flex items-center gap-2 mb-3">
        <Brain className="h-4 w-4 text-[color:var(--color-accent)]" aria-hidden="true" />
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">
          {localize(locale, "Friday 学到了什么", "What Friday Learned")}
        </p>
      </div>

      {hasActivity ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {stats.map((stat) => (
              <div
                key={stat.label}
                className={`flex items-center gap-2.5 rounded-xl ${stat.bg} px-3 py-2.5`}
              >
                <stat.icon className={`h-4 w-4 shrink-0 ${stat.tone}`} aria-hidden="true" />
                <div>
                  <p className="text-lg font-semibold leading-none text-[color:var(--color-text-primary)]">{stat.value}</p>
                  <p className="mt-0.5 text-[11px] text-[color:var(--color-text-secondary)]">{stat.label}</p>
                </div>
              </div>
            ))}
          </div>

          {overview.recentRejectedFixes.length > 0 && (
            <div className="mt-3 rounded-xl bg-[color:var(--color-bg-contrast)] px-3 py-2">
              <p className="text-xs text-[color:var(--color-text-secondary)]">
                {localize(
                  locale,
                  `最近 ${String(overview.recentRejectedFixes.length)} 次修复被拒绝 — Friday 已学会避免这些方案`,
                  `${String(overview.recentRejectedFixes.length)} recent fix(es) rejected — Friday learned to avoid these approaches`,
                )}
              </p>
            </div>
          )}

          {overview.coverage.autoFixActions > 0 && overview.rollbackHotspots.length === 0 && (
            <div className="mt-3 rounded-xl bg-emerald-50 px-3 py-2">
              <p className="text-xs text-emerald-700">
                {localize(
                  locale,
                  `Friday 已自动修复 ${String(overview.coverage.autoFixActions)} 个问题，无需人工干预。`,
                  `Friday auto-fixed ${String(overview.coverage.autoFixActions)} issue(s) without manual intervention.`,
                )}
              </p>
            </div>
          )}

          {overview.rollbackHotspots.length > 0 && (
            <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2">
              <p className="text-xs text-amber-700">
                {localize(
                  locale,
                  `${String(overview.rollbackHotspots.length)} 个热点问题频繁回滚 — Friday 正在学习更好的修复方案。`,
                  `${String(overview.rollbackHotspots.length)} hotspot(s) with frequent rollbacks — Friday is learning better fixes.`,
                )}
              </p>
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-[color:var(--color-text-secondary)]">
          {localize(
            locale,
            "Friday 还在学习中。使用越多，它越了解你的偏好和工作方式。",
            "Friday is still learning. The more you use it, the better it understands your preferences and workflows.",
          )}
        </p>
      )}
    </div>
  );
}

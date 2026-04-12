import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Brain, ChevronDown, Shield, TrendingUp } from "lucide-react";
import { useNavigate } from "react-router-dom";
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
  const navigate = useNavigate();
  const [expandedStat, setExpandedStat] = useState<string | null>(null);
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
          {/* Human-friendly summary sentence — primary message */}
          <p className="text-sm text-[color:var(--color-text-primary)] mb-3">
            {overview.coverage.patterns > 0 &&
              localize(
                locale,
                `Friday 已了解你的 ${String(overview.coverage.patterns)} 个工作习惯`,
                `Friday has learned ${String(overview.coverage.patterns)} of your work habits`,
              )}
            {overview.coverage.patterns > 0 && overview.coverage.autoFixActions > 0 &&
              localize(
                locale,
                `，并自动修复了 ${String(overview.coverage.autoFixActions)} 个问题`,
                `, and auto-fixed ${String(overview.coverage.autoFixActions)} issues`,
              )}
            {overview.coverage.patterns > 0 && overview.coverage.autoFixActions === 0 && overview.coverage.lessons > 0 &&
              localize(
                locale,
                `，从过去的经验中学到了 ${String(overview.coverage.lessons)} 条教训`,
                `, and learned ${String(overview.coverage.lessons)} lessons from past experience`,
              )}
            {overview.coverage.patterns > 0 ? "." : ""}
          </p>

          {/* Stat tiles — secondary, muted */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {stats.map((stat) => (
              <button
                key={stat.label}
                type="button"
                onClick={() => setExpandedStat(expandedStat === stat.label ? null : stat.label)}
                className={`flex items-center gap-2 rounded-xl ${stat.bg} px-2.5 py-2 text-left transition hover:opacity-80 ${expandedStat === stat.label ? "ring-1 ring-[color:var(--color-border-strong)]" : ""}`}
              >
                <stat.icon className={`h-3.5 w-3.5 shrink-0 ${stat.tone} opacity-60`} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium leading-none text-[color:var(--color-text-secondary)]">{stat.value}</p>
                  <p className="mt-0.5 text-[10px] text-[color:var(--color-text-faint)]">{stat.label}</p>
                </div>
                <ChevronDown className={`h-3 w-3 shrink-0 text-[color:var(--color-text-faint)] transition-transform ${expandedStat === stat.label ? "rotate-180" : ""}`} aria-hidden="true" />
              </button>
            ))}
          </div>

          {/* Expanded detail section */}
          {expandedStat && (
            <div className="mt-3 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-3">
              {expandedStat === localize(locale, "教训", "Lessons") && (
                overview.lessons.length > 0 ? (
                  <div className="space-y-2">
                    {overview.lessons.slice(0, 3).map((item) => (
                      <div key={item.lesson.id} className="rounded-lg bg-[color:var(--color-bg-surface)] px-3 py-2">
                        <p className="text-xs font-medium text-[color:var(--color-text-primary)]">{item.lesson.title}</p>
                        <p className="mt-1 text-[11px] text-[color:var(--color-text-secondary)]">
                          {localize(locale, "原因", "Cause")}: {item.lesson.cause}
                        </p>
                        <p className="text-[11px] text-[color:var(--color-text-secondary)]">
                          {localize(locale, "修复", "Fix")}: {item.lesson.fix}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-[color:var(--color-text-secondary)]">
                    {localize(locale, "点击「管理」查看完整详情", "Click Manage for full details")}
                  </p>
                )
              )}

              {expandedStat === localize(locale, "模式", "Patterns") && (
                overview.patterns.length > 0 ? (
                  <div className="space-y-2">
                    {overview.patterns.slice(0, 3).map((item) => (
                      <div key={item.patternId} className="rounded-lg bg-[color:var(--color-bg-surface)] px-3 py-2">
                        <p className="text-xs font-medium text-[color:var(--color-text-primary)]">{item.kind}</p>
                        <p className="mt-1 text-[11px] text-[color:var(--color-text-secondary)]">{item.description}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-[color:var(--color-text-secondary)]">
                    {localize(locale, "点击「管理」查看完整详情", "Click Manage for full details")}
                  </p>
                )
              )}

              {expandedStat === localize(locale, "自动修复", "Auto-fixes") && (
                overview.rejectedFixes.length > 0 || overview.coverage.autoFixActions > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs text-[color:var(--color-text-secondary)]">
                      {localize(
                        locale,
                        `共 ${String(overview.coverage.autoFixActions)} 次自动修复`,
                        `${String(overview.coverage.autoFixActions)} auto-fix action(s) total`,
                      )}
                    </p>
                    {overview.rejectedFixes.slice(0, 3).map((item) => (
                      <div key={item.actionId} className="rounded-lg bg-[color:var(--color-bg-surface)] px-3 py-2">
                        <p className="text-xs font-medium text-[color:var(--color-text-primary)]">{item.title}</p>
                        {item.reason && (
                          <p className="mt-1 text-[11px] text-[color:var(--color-text-secondary)]">{item.reason}</p>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-[color:var(--color-text-secondary)]">
                    {localize(locale, "点击「管理」查看完整详情", "Click Manage for full details")}
                  </p>
                )
              )}

              {expandedStat === localize(locale, "诊断", "Diagnoses") && (
                overview.rollbackHotspots.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs text-[color:var(--color-text-secondary)]">
                      {localize(
                        locale,
                        `共 ${String(overview.coverage.incidents)} 次诊断`,
                        `${String(overview.coverage.incidents)} diagnosis event(s)`,
                      )}
                    </p>
                    {overview.rollbackHotspots.slice(0, 3).map((item) => (
                      <div key={item.fingerprint} className="rounded-lg bg-[color:var(--color-bg-surface)] px-3 py-2">
                        <p className="text-xs font-medium text-[color:var(--color-text-primary)]">{item.fingerprint}</p>
                        <p className="mt-1 text-[11px] text-[color:var(--color-text-secondary)]">
                          {localize(
                            locale,
                            `回滚 ${String(item.rolledBackCount)} / 应用 ${String(item.appliedCount)} / 拒绝 ${String(item.rejectedCount)}`,
                            `Rolled back ${String(item.rolledBackCount)} / Applied ${String(item.appliedCount)} / Rejected ${String(item.rejectedCount)}`,
                          )}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-[color:var(--color-text-secondary)]">
                    {localize(locale, "点击「管理」查看完整详情", "Click Manage for full details")}
                  </p>
                )
              )}
            </div>
          )}

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
                  `Friday 在 ${String(overview.rollbackHotspots.length)} 个地方尝试修复后发现效果不好，已自动撤销并在学习更好的方案。`,
                  `Friday tried fixes in ${String(overview.rollbackHotspots.length)} areas but rolled them back — it's learning better approaches.`,
                )}
              </p>
            </div>
          )}

          {/* Manage link */}
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => navigate("/settings#learning")}
              className="text-xs text-[color:var(--color-text-faint)] hover:text-[color:var(--color-text-secondary)] transition-colors"
            >
              {localize(locale, "管理 →", "Manage →")}
            </button>
          </div>
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

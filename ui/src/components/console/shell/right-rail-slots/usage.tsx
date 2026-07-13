import { NavLink } from "react-router-dom";
import { BarChart3, ChevronRight, DollarSign, Gauge } from "lucide-react";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
import { useUsageRail } from "@/hooks/use-usage-rail";
import { formatRailUsd } from "@/lib/usage/usage-rail-view";

/**
 * Right-rail preset for `/usage`. Figures are read from recorded usage data via
 * `useUsageRail()` (/v1/providers/usage) — never fabricated. Before load, on
 * error, or when nothing has been recorded, it shows the truthful zero state
 * ($0.00 / 0 tokens).
 */
export function UsageRightRailSlot() {
  const { locale } = useAppLocale();
  const usage = useUsageRail();

  const todayCost = formatRailUsd(usage.todayUsd);
  const cumulativeCost = formatRailUsd(usage.cumulativeUsd);
  const tokenHint = usage.loading
    ? localize(locale, "读取中…", "Loading…")
    : localize(
        locale,
        `${usage.totalTokens.toLocaleString()} tokens · ${usage.callCount} 次调用`,
        `${usage.totalTokens.toLocaleString()} tokens · ${usage.callCount} calls`,
      );

  return (
    <div className="flex flex-col gap-3 p-4">
      <header>
        <p
          className="text-[10px] font-semibold uppercase tracking-[0.16em]"
          style={{ color: "var(--color-text-faint)" }}
        >
          {localize(locale, "用量", "Usage")}
        </p>
        <h3
          className="mt-1 text-sm font-semibold"
          style={{ color: "var(--color-text-primary)", fontFamily: "var(--font-serif-sc)" }}
        >
          {localize(locale, "今日花费", "Today's cost")}{" "}
          <span style={{ color: "var(--color-accent)" }}>{usage.loading ? "" : todayCost}</span>
        </h3>
      </header>

      <ul className="flex flex-col gap-2">
        <Row
          to="/usage"
          Icon={Gauge}
          title={localize(locale, "Token 消耗", "Token spend")}
          hint={tokenHint}
        />
        <Row
          to="/usage"
          Icon={DollarSign}
          title={localize(locale, "累计费用", "Cumulative cost")}
          hint={usage.loading
            ? localize(locale, "本月至今的支出", "Month-to-date")
            : localize(locale, `本月至今 ${cumulativeCost}`, `${cumulativeCost} month-to-date`)}
        />
        <Row
          to="/observability"
          Icon={BarChart3}
          title={localize(locale, "趋势", "Trend")}
          hint={localize(locale, "和上一周期对比", "Compare vs. previous period")}
        />
      </ul>
    </div>
  );
}

function Row(props: { to: string; Icon: typeof Gauge; title: string; hint: string }) {
  return (
    <li>
      <NavLink
        to={props.to}
        className="group flex items-start gap-3 rounded-[var(--radius-md)] border px-3 py-3 transition-colors hover:bg-[color:var(--color-accent-soft)]"
        style={{
          borderColor: "var(--color-border-soft)",
          background: "var(--color-bg-subtle)",
        }}
      >
        <props.Icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--color-accent)" }} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium" style={{ color: "var(--color-text-primary)" }}>
            {props.title}
          </p>
          <p className="mt-0.5 text-xs" style={{ color: "var(--color-text-secondary)" }}>
            {props.hint}
          </p>
        </div>
        <ChevronRight
          className="h-4 w-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          style={{ color: "var(--color-text-secondary)" }}
        />
      </NavLink>
    </li>
  );
}

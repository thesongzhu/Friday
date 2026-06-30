import { NavLink } from "react-router-dom";
import { BarChart3, ChevronRight, DollarSign, Gauge } from "lucide-react";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

/**
 * Right-rail preset for `/usage`. Ships the frame with static hint rows; Phase
 * 2 wires a `useTodayUsageQuery()` to replace placeholder copy with real
 * token/cost figures without changing the rail shape.
 */
export function UsageRightRailSlot() {
  const { locale } = useAppLocale();

  return (
    <div className="flex flex-col gap-3 p-4">
      <header>
        <p
          className="text-[10px] font-semibold uppercase tracking-[0.16em]"
          style={{ color: "var(--ink-300)" }}
        >
          {localize(locale, "用量", "Usage")}
        </p>
        <h3
          className="mt-1 text-sm font-semibold"
          style={{ color: "var(--ink-900)", fontFamily: "var(--font-serif-sc)" }}
        >
          {localize(locale, "今日花费", "Today's cost")}
        </h3>
      </header>

      <ul className="flex flex-col gap-2">
        <Row
          to="/usage"
          Icon={Gauge}
          title={localize(locale, "Token 消耗", "Token spend")}
          hint={localize(locale, "按模型拆分的用量", "Breakdown by model")}
        />
        <Row
          to="/usage"
          Icon={DollarSign}
          title={localize(locale, "累计费用", "Cumulative cost")}
          hint={localize(locale, "本月至今的支出", "Month-to-date")}
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
        className="group flex items-start gap-3 rounded-[var(--radius-md)] border px-3 py-3 transition-colors hover:bg-[color:var(--accent-soft)]"
        style={{
          borderColor: "var(--surface-border)",
          background: "var(--surface-2)",
        }}
      >
        <props.Icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--accent)" }} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium" style={{ color: "var(--ink-900)" }}>
            {props.title}
          </p>
          <p className="mt-0.5 text-xs" style={{ color: "var(--ink-500)" }}>
            {props.hint}
          </p>
        </div>
        <ChevronRight
          className="h-4 w-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          style={{ color: "var(--ink-500)" }}
        />
      </NavLink>
    </li>
  );
}

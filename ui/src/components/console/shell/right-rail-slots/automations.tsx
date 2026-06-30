import { NavLink } from "react-router-dom";
import { CalendarClock, ChevronRight, ListTodo, Timer } from "lucide-react";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

/**
 * Right-rail preset for `/automations`. Surfaces the "next scheduled run"
 * shortcut plus direct links into the queue and the retry ledger. Phase 2
 * swaps placeholders for `useAutomationsQueueSummary()` data.
 */
export function AutomationsRightRailSlot() {
  const { locale } = useAppLocale();

  return (
    <div className="flex flex-col gap-3 p-4">
      <header>
        <p
          className="text-[10px] font-semibold uppercase tracking-[0.16em]"
          style={{ color: "var(--ink-300)" }}
        >
          {localize(locale, "自动化", "Automations")}
        </p>
        <h3
          className="mt-1 text-sm font-semibold"
          style={{ color: "var(--ink-900)", fontFamily: "var(--font-serif-sc)" }}
        >
          {localize(locale, "排期与队列", "Schedule & queue")}
        </h3>
      </header>

      <ul className="flex flex-col gap-2">
        <Row
          to="/automations"
          Icon={CalendarClock}
          title={localize(locale, "下一次执行", "Next scheduled run")}
          hint={localize(locale, "查看即将触发的自动化", "Upcoming triggers")}
        />
        <Row
          to="/automations"
          Icon={ListTodo}
          title={localize(locale, "任务队列", "Queue depth")}
          hint={localize(locale, "等待执行与在跑任务", "Waiting & running")}
        />
        <Row
          to="/observability"
          Icon={Timer}
          title={localize(locale, "重试与失败", "Retries & failures")}
          hint={localize(locale, "查看最近的恢复路径", "Recovery paths for recent failures")}
        />
      </ul>
    </div>
  );
}

function Row(props: { to: string; Icon: typeof CalendarClock; title: string; hint: string }) {
  return (
    <li>
      <NavLink
        to={props.to}
        className="group flex items-start gap-3 rounded-[var(--radius-md)] border px-3 py-3 transition-colors hover:bg-[color:var(--accent-soft)]"
        style={{
          borderColor: "rgba(122, 106, 88, 0.18)",
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

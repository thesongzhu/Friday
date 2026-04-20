import { NavLink } from "react-router-dom";
import { AlertTriangle, CheckCheck, ChevronRight, Inbox, type LucideIcon } from "lucide-react";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

/**
 * Approvals preview for the /assistant surface. Phase 1 renders the frame
 * with static placeholders; the Phase 2 assistant inbox query will replace
 * the items without changing the rail shape.
 */
export function AssistantRightRailSlot() {
  const { locale } = useAppLocale();

  return (
    <div className="flex flex-col gap-3 p-4">
      <header className="flex items-center justify-between">
        <div>
          <p
            className="text-[10px] font-semibold uppercase tracking-[0.16em]"
            style={{ color: "var(--ink-300)" }}
          >
            {localize(locale, "待审批", "Approvals preview")}
          </p>
          <h3
            className="mt-1 text-sm font-semibold"
            style={{ color: "var(--ink-900)", fontFamily: "var(--font-serif-sc)" }}
          >
            {localize(locale, "Friday 等待你确认", "Waiting on you")}
          </h3>
        </div>
        <NavLink
          to="/assistant"
          className="inline-flex items-center gap-1 text-xs"
          style={{ color: "var(--amber-600)" }}
        >
          {localize(locale, "全部", "View all")}
          <ChevronRight className="h-3.5 w-3.5" />
        </NavLink>
      </header>

      <ul
        className="flex flex-col gap-2"
        aria-label={localize(locale, "待审批列表", "Pending approvals list")}
      >
        <ApprovalRow
          Icon={CheckCheck}
          title={localize(locale, "无待审批项", "No pending approvals")}
          hint={localize(locale, "Friday 没有在等你。", "Friday has nothing waiting on you.")}
        />
        <ApprovalRow
          Icon={AlertTriangle}
          title={localize(locale, "近期问题", "Recent issues")}
          hint={localize(locale, "查看恢复路径", "See recovery paths")}
        />
        <ApprovalRow
          Icon={Inbox}
          title={localize(locale, "最近证据", "Recent evidence")}
          hint={localize(locale, "最近运行日志摘要", "Latest run summaries")}
        />
      </ul>
    </div>
  );
}

function ApprovalRow(props: {
  Icon: LucideIcon;
  title: string;
  hint: string;
}) {
  return (
    <li
      className="flex items-start gap-3 rounded-[var(--radius-md)] border px-3 py-3"
      style={{
        borderColor: "rgba(122, 106, 88, 0.18)",
        background: "var(--surface-2)",
      }}
    >
      <props.Icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--amber-600)" }} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium" style={{ color: "var(--ink-900)" }}>
          {props.title}
        </p>
        <p className="mt-0.5 text-xs" style={{ color: "var(--ink-500)" }}>
          {props.hint}
        </p>
      </div>
    </li>
  );
}

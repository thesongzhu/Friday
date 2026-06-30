import { NavLink } from "react-router-dom";
import { ArrowUpRight, Inbox, ListTodo, MessageCircle } from "lucide-react";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

export function HomeRightRailSlot() {
  const { locale } = useAppLocale();

  const shortcuts = [
    {
      to: "/chat",
      icon: MessageCircle,
      label: localize(locale, "开始新对话", "Start a new chat"),
      hint: localize(locale, "直接告诉 Friday 你要完成什么", "Tell Friday what to get done"),
    },
    {
      to: "/assistant",
      icon: Inbox,
      label: localize(locale, "查看审批与问题", "Approvals & issues"),
      hint: localize(locale, "集中处理待审批事项", "Review pending approvals"),
    },
    {
      to: "/automations",
      icon: ListTodo,
      label: localize(locale, "任务队列", "Task queue"),
      hint: localize(locale, "排期与在跑任务", "Scheduled and running"),
    },
  ];

  return (
    <div className="flex flex-col gap-3 p-4">
      <header>
        <p
          className="text-[10px] font-semibold uppercase tracking-[0.16em]"
          style={{ color: "var(--ink-300)" }}
        >
          {localize(locale, "快捷入口", "Quick actions")}
        </p>
        <h3
          className="mt-1 text-sm font-semibold"
          style={{ color: "var(--ink-900)", fontFamily: "var(--font-serif-sc)" }}
        >
          {localize(locale, "今天先做哪件", "What's next?")}
        </h3>
      </header>

      <ul className="flex flex-col gap-2">
        {shortcuts.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              className="group flex items-start gap-3 rounded-[var(--radius-md)] border px-3 py-3 transition-colors hover:bg-[color:var(--accent-soft)]"
              style={{
                borderColor: "var(--surface-border)",
                background: "var(--surface-2)",
              }}
            >
              <item.icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--accent)" }} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium" style={{ color: "var(--ink-900)" }}>
                  {item.label}
                </p>
                <p className="mt-0.5 text-xs" style={{ color: "var(--ink-500)" }}>
                  {item.hint}
                </p>
              </div>
              <ArrowUpRight
                className="h-4 w-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                style={{ color: "var(--ink-500)" }}
              />
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

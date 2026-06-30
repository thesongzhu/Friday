import { NavLink } from "react-router-dom";
import { ChevronRight, History, MessageSquare } from "lucide-react";
import { useRecentSessionsQuery } from "@/hooks/use-recent-sessions";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

/**
 * Right-rail preset for `/sessions`. Reuses the shell-wide recent-sessions
 * query so the rail stays consistent with Cmd+K's "Recent sessions" section —
 * one source of truth, one cache entry.
 */
export function SessionsRightRailSlot() {
  const { locale } = useAppLocale();
  const { data, isLoading } = useRecentSessionsQuery(5);
  const sessions = data ?? [];

  return (
    <div className="flex flex-col gap-3 p-4">
      <header>
        <p
          className="text-[10px] font-semibold uppercase tracking-[0.16em]"
          style={{ color: "var(--ink-300)" }}
        >
          {localize(locale, "最近会话", "Recent sessions")}
        </p>
        <h3
          className="mt-1 text-sm font-semibold"
          style={{ color: "var(--ink-900)", fontFamily: "var(--font-serif-sc)" }}
        >
          {localize(locale, "继续之前的对话", "Jump back in")}
        </h3>
      </header>

      {isLoading ? (
        <p className="text-xs" style={{ color: "var(--ink-500)" }}>
          {localize(locale, "载入中…", "Loading…")}
        </p>
      ) : sessions.length === 0 ? (
        <EmptyRow locale={locale} />
      ) : (
        <ul className="flex flex-col gap-2">
          {sessions.map((session) => (
            <li key={session.id}>
              <NavLink
                to="/sessions"
                className="group flex items-start gap-3 rounded-[var(--radius-md)] border px-3 py-3 transition-colors hover:bg-[color:var(--accent-soft)]"
                style={{
                  borderColor: "var(--surface-border)",
                  background: "var(--surface-2)",
                }}
              >
                <MessageSquare className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--accent)" }} />
                <div className="min-w-0 flex-1">
                  <p
                    className="truncate text-sm font-medium"
                    style={{ color: "var(--ink-900)" }}
                  >
                    {session.key}
                  </p>
                  <p className="mt-0.5 text-xs" style={{ color: "var(--ink-500)" }}>
                    {session.channel} · {session.status}
                  </p>
                </div>
                <ChevronRight
                  className="h-4 w-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                  style={{ color: "var(--ink-500)" }}
                />
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyRow(props: { locale: "zh" | "en" }) {
  return (
    <div
      className="flex items-start gap-3 rounded-[var(--radius-md)] border px-3 py-3"
      style={{
        borderColor: "var(--surface-border)",
        background: "var(--surface-2)",
      }}
    >
      <History className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--ink-300)" }} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium" style={{ color: "var(--ink-900)" }}>
          {localize(props.locale, "暂无会话", "No sessions yet")}
        </p>
        <p className="mt-0.5 text-xs" style={{ color: "var(--ink-500)" }}>
          {localize(props.locale, "在聊天里发起后会显示在这里", "Start a chat and it will show up here")}
        </p>
      </div>
    </div>
  );
}

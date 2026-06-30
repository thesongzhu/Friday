import { NavLink } from "react-router-dom";
import { ChevronRight, Plug, Radio, Wifi } from "lucide-react";
import { useSystemHealthQuery } from "@/hooks/use-system-health";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

/**
 * Right-rail preset for `/channels`. Reflects shell-level system health so a
 * degraded channel bus is visible even before the user opens a specific
 * channel's drilldown. Phase 2 will swap the aggregate badge for a per-channel
 * live/degraded table backed by `useChannelsHealthQuery()`.
 */
export function ChannelsRightRailSlot() {
  const { locale } = useAppLocale();
  const { data } = useSystemHealthQuery();
  const status = data?.status ?? "healthy";

  const badge = buildBadge(status, locale);

  return (
    <div className="flex flex-col gap-3 p-4">
      <header>
        <p
          className="text-[10px] font-semibold uppercase tracking-[0.16em]"
          style={{ color: "var(--ink-300)" }}
        >
          {localize(locale, "渠道", "Channels")}
        </p>
        <h3
          className="mt-1 text-sm font-semibold"
          style={{ color: "var(--ink-900)", fontFamily: "var(--font-serif-sc)" }}
        >
          {localize(locale, "接入与监控", "Connect & monitor")}
        </h3>
      </header>

      <div
        className="flex items-center gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-xs"
        style={{
          borderColor: "var(--surface-border)",
          background: "var(--surface-2)",
          color: badge.color,
        }}
      >
        <span
          aria-hidden="true"
          className="h-2 w-2 rounded-full"
          style={{ background: badge.color }}
        />
        <span className="font-medium">{badge.label}</span>
      </div>

      <ul className="flex flex-col gap-2">
        <Row
          to="/channels"
          Icon={Radio}
          title={localize(locale, "消息总线", "Message bus")}
          hint={localize(locale, "查看消息渠道状态", "Inspect channel streams")}
        />
        <Row
          to="/plugins"
          Icon={Plug}
          title={localize(locale, "插件连接器", "Plugin connectors")}
          hint={localize(locale, "已装载的渠道插件", "Installed channel plugins")}
        />
        <Row
          to="/observability"
          Icon={Wifi}
          title={localize(locale, "连接性", "Connectivity")}
          hint={localize(locale, "出站请求诊断", "Outbound request diagnostics")}
        />
      </ul>
    </div>
  );
}

function buildBadge(
  status: "healthy" | "degraded" | "unavailable" | "offline",
  locale: "zh" | "en",
): { label: string; color: string } {
  if (status === "offline") {
    return { label: localize(locale, "总线离线", "Bus offline"), color: "var(--rust-500)" };
  }
  if (status === "unavailable") {
    return { label: localize(locale, "总线暂不可用", "Bus unavailable"), color: "var(--accent)" };
  }
  if (status === "degraded") {
    return { label: localize(locale, "部分降级", "Partially degraded"), color: "var(--accent)" };
  }
  return { label: localize(locale, "渠道健康", "Channels healthy"), color: "var(--ok)" };
}

function Row(props: { to: string; Icon: typeof Radio; title: string; hint: string }) {
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

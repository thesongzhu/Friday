import { NavLink } from "react-router-dom";
import { Activity, ChevronRight } from "lucide-react";
import { useSystemHealthQuery } from "@/hooks/use-system-health";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

const STATUS_COLOR: Record<string, string> = {
  healthy: "var(--ok)",
  degraded: "var(--accent)",
  unavailable: "var(--accent)",
  offline: "var(--rust-500)",
};

const STATUS_LABEL = {
  healthy: { zh: "正常", en: "Healthy" },
  degraded: { zh: "降级", en: "Degraded" },
  unavailable: { zh: "暂不可用", en: "Unavailable" },
  offline: { zh: "不可达", en: "Offline" },
} as const;

export function SettingsProvidersRightRailSlot() {
  const { locale } = useAppLocale();
  const { data } = useSystemHealthQuery();
  const status = data?.status ?? "healthy";

  return (
    <div className="flex flex-col gap-3 p-4">
      <header className="flex items-center justify-between">
        <div>
          <p
            className="text-[10px] font-semibold uppercase tracking-[0.16em]"
            style={{ color: "var(--ink-300)" }}
          >
            {localize(locale, "提供方健康度", "Provider health")}
          </p>
          <h3
            className="mt-1 text-sm font-semibold"
            style={{ color: "var(--ink-900)", fontFamily: "var(--font-serif-sc)" }}
          >
            {localize(locale, "Friday 运行依赖", "Runtime dependencies")}
          </h3>
        </div>
        <NavLink
          to="/observability"
          className="inline-flex items-center gap-1 text-xs"
          style={{ color: "var(--accent)" }}
        >
          {localize(locale, "详情", "Details")}
          <ChevronRight className="h-3.5 w-3.5" />
        </NavLink>
      </header>

      <div
        className="flex items-center gap-3 rounded-[var(--radius-md)] border px-3 py-3"
        style={{
          borderColor: "var(--surface-border)",
          background: "var(--surface-2)",
        }}
      >
        <Activity className="h-4 w-4 shrink-0" style={{ color: STATUS_COLOR[status] }} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium" style={{ color: "var(--ink-900)" }}>
            {localize(locale, "整体状态", "Overall")}
          </p>
          <p className="mt-0.5 text-xs" style={{ color: "var(--ink-500)" }}>
            {localize(locale, STATUS_LABEL[status].zh, STATUS_LABEL[status].en)}
          </p>
        </div>
      </div>
    </div>
  );
}

import { NavLink } from "react-router-dom";
import { ChevronRight, Globe2, Layers, Package } from "lucide-react";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

/**
 * Right-rail preset for `/packs`. Phase 1 surfaces the cross-border quickstart
 * plus deep links into the wider pack library; Phase 2 swaps the static rows
 * for a `usePackInstallations()` query when available.
 */
export function PacksRightRailSlot() {
  const { locale } = useAppLocale();

  return (
    <div className="flex flex-col gap-3 p-4">
      <header>
        <p
          className="text-[10px] font-semibold uppercase tracking-[0.16em]"
          style={{ color: "var(--ink-300)" }}
        >
          {localize(locale, "引导包", "Pack library")}
        </p>
        <h3
          className="mt-1 text-sm font-semibold"
          style={{ color: "var(--ink-900)", fontFamily: "var(--font-serif-sc)" }}
        >
          {localize(locale, "按行业启动 Friday", "Launch by industry")}
        </h3>
      </header>

      <ul className="flex flex-col gap-2">
        <PackRow
          to="/packs/cross-border/setup"
          Icon={Globe2}
          title={localize(locale, "跨境经营引导包", "Cross-border operating pack")}
          hint={localize(locale, "零售 / 品牌 / 小卖家分流", "Retail · brand · seller flows")}
        />
        <PackRow
          to="/packs"
          Icon={Package}
          title={localize(locale, "全部引导包", "All packs")}
          hint={localize(locale, "浏览行业与任务模板", "Browse industry & task templates")}
        />
        <PackRow
          to="/skills"
          Icon={Layers}
          title={localize(locale, "相关技能", "Related skills")}
          hint={localize(locale, "查看 Pack 绑定的技能", "Skills bundled with packs")}
        />
      </ul>
    </div>
  );
}

function PackRow(props: {
  to: string;
  Icon: typeof Globe2;
  title: string;
  hint: string;
}) {
  return (
    <li>
      <NavLink
        to={props.to}
        className="group flex items-start gap-3 rounded-[var(--radius-md)] border px-3 py-3 transition-colors hover:bg-[color:var(--amber-100)]"
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
        <ChevronRight
          className="h-4 w-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          style={{ color: "var(--ink-500)" }}
        />
      </NavLink>
    </li>
  );
}

import { useMemo } from "react";
import { NavLink } from "react-router-dom";
import {
  Activity,
  BarChart3,
  Brain,
  ChevronsLeft,
  ChevronsRight,
  Clock3,
  Globe2,
  Home,
  Layers,
  ListFilter,
  MessageCircle,
  MessageSquare,
  Plug,
  Settings,
  Sparkles,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { localize, resolveLocalizedText, type AppLocale } from "@/lib/i18n/localized-text";
import {
  AGENT_OS_NAV_ADVANCED,
  AGENT_OS_NAV_PRIMARY,
  type AgentOsNavItem,
} from "@/lib/routes/agent-os-nav";
import { sortNavByFrequency } from "@/lib/uix/adaptive-layout";
import { cn } from "@/lib/utils/cn";
import { useAppLocale } from "@/providers/locale-provider";

const PRIMARY_ICONS: Record<string, LucideIcon> = {
  "/home": Home,
  "/chat": MessageCircle,
  "/packs": ListFilter,
  "/assistant": Sparkles,
};

const ADVANCED_ICONS: Record<string, LucideIcon> = {
  "/channels": MessageSquare,
  "/skills": Layers,
  "/plugins": Plug,
  "/workflows": Workflow,
  "/automations": Clock3,
  "/memory": Brain,
  "/mcp": Plug,
  "/fleet": Globe2,
  "/command-center": Settings,
  "/usage": BarChart3,
  "/sessions": MessageSquare,
  "/observability": Activity,
};

function iconFor(path: string): LucideIcon {
  return PRIMARY_ICONS[path] ?? ADVANCED_ICONS[path] ?? Sparkles;
}

interface RailProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function Rail({ collapsed, onToggleCollapse }: RailProps) {
  const { locale, setLocale } = useAppLocale();

  const advancedOrdered = useMemo<AgentOsNavItem[]>(() => {
    const paths = AGENT_OS_NAV_ADVANCED.map((item) => item.path);
    const freqOrdered = sortNavByFrequency(paths);
    const byPath = new Map(AGENT_OS_NAV_ADVANCED.map((item) => [item.path, item]));
    const ordered: AgentOsNavItem[] = [];
    for (const p of freqOrdered) {
      const item = byPath.get(p);
      if (item) ordered.push(item);
    }
    for (const item of AGENT_OS_NAV_ADVANCED) {
      if (!ordered.includes(item)) ordered.push(item);
    }
    return ordered;
  }, []);

  return (
    <aside
      data-testid="app-shell-rail"
      role="navigation"
      aria-label="Main navigation"
      className="hidden shrink-0 lg:block"
      style={{
        width: collapsed ? "var(--shell-rail-w-collapsed)" : "var(--shell-rail-w)",
        transition: "width var(--motion-swift)",
      }}
    >
      <div
        className="flex h-full flex-col border-r px-3 py-4"
        style={{
          background: "var(--surface-1)",
          borderColor: "var(--ink-300)",
          borderRightColor: "rgba(122, 106, 88, 0.15)",
        }}
      >
        <div className={cn("flex items-center gap-2 px-1 pb-3", collapsed ? "justify-center" : "justify-between")}>
          {collapsed ? (
            <p
              className="text-base font-semibold tracking-tight"
              style={{ color: "var(--ink-900)" }}
              aria-label="Friday"
            >
              F
            </p>
          ) : (
            <div className="min-w-0">
              <p className="text-base font-semibold tracking-tight" style={{ color: "var(--ink-900)" }}>
                Friday
              </p>
              <p
                className="mt-0.5 text-xs italic"
                style={{ fontFamily: "var(--font-serif-sc)", color: "var(--ink-500)" }}
              >
                Console
              </p>
            </div>
          )}
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label={localize(locale, collapsed ? "展开导航" : "收起导航", collapsed ? "Expand rail" : "Collapse rail")}
            aria-pressed={collapsed}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] transition-colors hover:bg-[color:var(--amber-100)]"
            style={{ color: "var(--ink-500)" }}
          >
            {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
          </button>
        </div>

        <nav className="mt-2 space-y-1" aria-label="Primary surfaces">
          {AGENT_OS_NAV_PRIMARY.map((item) => (
            <RailNavItem key={item.path} item={item} collapsed={collapsed} locale={locale} />
          ))}
        </nav>

        <div
          className="mt-4 border-t pt-3"
          style={{ borderColor: "rgba(122, 106, 88, 0.18)" }}
          aria-label="Advanced surfaces"
        >
          <nav className="space-y-1">
            {advancedOrdered.map((item) => (
              <RailNavItem key={item.path} item={item} collapsed={collapsed} locale={locale} />
            ))}
          </nav>
        </div>

        <div
          className="mt-auto border-t pt-3"
          style={{ borderColor: "rgba(122, 106, 88, 0.18)" }}
        >
          <RailNavItem
            item={{
              path: "/settings",
              label: { zh: "设置", en: "Settings" },
              description: { zh: "", en: "" },
            }}
            collapsed={collapsed}
            locale={locale}
          />

          <button
            type="button"
            onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
            className="mt-2 flex w-full items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-sm transition-colors"
            style={{
              color: "var(--ink-700)",
              background: "transparent",
            }}
            aria-label={localize(locale, "切换语言", "Toggle language")}
          >
            <Globe2 className="h-4 w-4 shrink-0" />
            {!collapsed ? <span>{locale === "zh" ? "中文" : "English"}</span> : null}
          </button>
        </div>
      </div>
    </aside>
  );
}

function RailNavItem(props: {
  item: AgentOsNavItem;
  collapsed: boolean;
  locale: AppLocale;
}) {
  const { item, collapsed, locale } = props;
  const Icon = iconFor(item.path) ?? (item.path === "/settings" ? Settings : Sparkles);
  const label = resolveLocalizedText(item.label, locale);

  return (
    <NavLink
      to={item.path}
      end={item.path === "/home"}
      title={collapsed ? label : undefined}
      className={cn(
        "flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-sm font-medium transition-colors",
        collapsed ? "justify-center" : "",
      )}
      style={({ isActive }) => ({
        color: isActive ? "var(--ink-900)" : "var(--ink-700)",
        background: isActive ? "var(--amber-100)" : "transparent",
      })}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed ? <span className="truncate">{label}</span> : null}
    </NavLink>
  );
}

export function MobileNav(props: { onOpenMore: () => void }) {
  const { locale } = useAppLocale();
  const items = useMemo(
    () => AGENT_OS_NAV_PRIMARY.map((item) => ({
      ...item,
      Icon: iconFor(item.path) ?? Sparkles,
      labelText: resolveLocalizedText(item.label, locale),
    })),
    [locale],
  );

  return (
    <nav
      aria-label="Mobile navigation"
      className="fixed inset-x-0 bottom-0 z-30 border-t lg:hidden"
      style={{
        background: "var(--surface-1)",
        borderColor: "rgba(122, 106, 88, 0.18)",
        height: "var(--shell-mobile-nav-h)",
      }}
    >
      <div className="mx-auto grid h-full max-w-2xl grid-cols-5 gap-1 px-2">
        {items.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className="flex flex-col items-center justify-center rounded-[var(--radius-md)] text-[11px] font-medium transition-colors"
            style={({ isActive }) => ({
              color: isActive ? "var(--ink-900)" : "var(--ink-500)",
              background: isActive ? "var(--amber-100)" : "transparent",
            })}
          >
            <item.Icon className="mb-1 h-4 w-4" />
            <span>{item.labelText}</span>
          </NavLink>
        ))}
        <button
          type="button"
          onClick={props.onOpenMore}
          className="flex flex-col items-center justify-center rounded-[var(--radius-md)] text-[11px] font-medium"
          style={{ color: "var(--ink-500)" }}
          aria-label={localize(locale, "更多", "More")}
        >
          <BarChart3 className="mb-1 h-4 w-4" />
          <span>{localize(locale, "更多", "More")}</span>
        </button>
      </div>
    </nav>
  );
}

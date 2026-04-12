import { NavLink } from "react-router-dom";
import {
  Activity,
  BarChart3,
  Brain,
  Clock3,
  CreditCard,
  Globe2,
  Layers,
  MessageSquare,
  Plug,
  Settings,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { resolveLocalizedText } from "@/lib/i18n/localized-text";
import type { AgentOsNavItem } from "@/lib/routes/agent-os-nav";
import type { AppLocale } from "@/lib/i18n/localized-text";

const NAV_ICONS: Record<string, LucideIcon> = {
  "/skills": Layers,
  "/workflows": Workflow,
  "/automations": Clock3,
  "/memory": Brain,
  "/mcp": Plug,
  "/usage": CreditCard,
  "/sessions": MessageSquare,
  "/observability": Activity,
  "/fleet": Globe2,
  "/settings": Settings,
};

export function QuickAccessBar(props: { items: AgentOsNavItem[]; locale: AppLocale }) {
  return (
    <div className="mb-3 flex items-center gap-2 overflow-x-auto scrollbar-none pb-1 lg:flex-wrap lg:overflow-x-visible lg:pb-0">
      {props.items.map((item) => {
        const Icon = NAV_ICONS[item.path];
        return (
          <NavLink
            key={item.path}
            to={item.path}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-text-secondary)] transition-colors hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg-surface-strong)] hover:text-[color:var(--color-text-primary)]"
          >
            {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
            <span>{resolveLocalizedText(item.label, props.locale)}</span>
          </NavLink>
        );
      })}
    </div>
  );
}

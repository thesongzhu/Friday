import { NavLink } from "react-router-dom";
import { ChevronRight, Layers, Package, Sparkles } from "lucide-react";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

/**
 * Right-rail preset for `/packs`. Keep this aligned with the user-created-task
 * flow instead of re-surfacing hidden built-in packs.
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
          {localize(locale, "用户任务", "User tasks")}
        </p>
        <h3
          className="mt-1 text-sm font-semibold"
          style={{ color: "var(--ink-900)", fontFamily: "var(--font-serif-sc)" }}
        >
          {localize(locale, "把自创任务接成真实动作", "Turn custom tasks into live actions")}
        </h3>
      </header>

      <ul className="flex flex-col gap-2">
        <PackRow
          to="/packs"
          Icon={Package}
          title={localize(locale, "创建或整理任务", "Create or organize tasks")}
          hint={localize(locale, "只显示你自己的任务定义", "Only show your own task definitions")}
        />
        <PackRow
          to="/chat"
          Icon={Sparkles}
          title={localize(locale, "去聊天启动", "Launch from chat")}
          hint={localize(locale, "直接把当前任务接到真实会话和 run", "Connect the task straight into a live session and run")}
        />
        <PackRow
          to="/skills"
          Icon={Layers}
          title={localize(locale, "相关技能", "Related skills")}
          hint={localize(locale, "查看任务现在能调用哪些能力", "See which capabilities your tasks can call right now")}
        />
      </ul>
    </div>
  );
}

function PackRow(props: {
  to: string;
  Icon: typeof Package;
  title: string;
  hint: string;
}) {
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

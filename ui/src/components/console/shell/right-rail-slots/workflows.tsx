import { NavLink } from "react-router-dom";
import { ChevronRight, GitBranch, PlayCircle, Workflow } from "lucide-react";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

/**
 * Right-rail preset for `/workflows`. Keeps the builder + active-run entry
 * points one click away; Phase 2 hooks this to a `useWorkflowRunSummary()`
 * query so the hint text reflects actual queue depth.
 */
export function WorkflowsRightRailSlot() {
  const { locale } = useAppLocale();

  return (
    <div className="flex flex-col gap-3 p-4">
      <header>
        <p
          className="text-[10px] font-semibold uppercase tracking-[0.16em]"
          style={{ color: "var(--ink-300)" }}
        >
          {localize(locale, "工作流", "Workflows")}
        </p>
        <h3
          className="mt-1 text-sm font-semibold"
          style={{ color: "var(--ink-900)", fontFamily: "var(--font-serif-sc)" }}
        >
          {localize(locale, "部署与观察", "Build · run · observe")}
        </h3>
      </header>

      <ul className="flex flex-col gap-2">
        <Row
          to="/workflows/builder"
          Icon={Workflow}
          title={localize(locale, "打开编辑器", "Open builder")}
          hint={localize(locale, "模板驱动的工作流编辑", "Template-first authoring")}
        />
        <Row
          to="/observability"
          Icon={PlayCircle}
          title={localize(locale, "活跃运行", "Active runs")}
          hint={localize(locale, "追踪最近的工作流执行", "Trace recent executions")}
        />
        <Row
          to="/workflows"
          Icon={GitBranch}
          title={localize(locale, "版本与分支", "Versions & branches")}
          hint={localize(locale, "工作流版本管理面板", "Workflow version surface")}
        />
      </ul>
    </div>
  );
}

function Row(props: { to: string; Icon: typeof Workflow; title: string; hint: string }) {
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

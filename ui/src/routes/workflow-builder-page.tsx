import { Suspense, lazy, useLayoutEffect } from "react";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

const WorkflowBuilderWorkspace = lazy(async () =>
  import("@/components/workflows/workflow-builder-workspace").then((module) => ({
    default: module.WorkflowBuilderWorkspace,
  }))
);

export function WorkflowBuilderPage() {
  const { locale } = useAppLocale();

  return (
    <Suspense fallback={<WorkflowBuilderShell />}>
      <WorkflowBuilderWorkspace />
    </Suspense>
  );

  function WorkflowBuilderShell() {
    useLayoutEffect(() => {
      if (typeof window !== "undefined" && typeof window.performance?.mark === "function") {
        window.performance.mark("friday-workflow-builder-shell-ready");
      }
    }, []);

    return (
      <div
        data-testid="workflow-builder-shell"
        className="space-y-4"
      >
        <section className="rounded-[30px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-5 py-5 shadow-[var(--shadow-floating)]">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
            {localize(locale, "工作流构建器", "Workflow Builder")}
          </p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
            {localize(locale, "正在加载可视化画布", "Loading the visual canvas")}
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[color:var(--color-text-secondary)]">
            {localize(
              locale,
              "Friday 先渲染轻壳层，再按需加载节点库、布局引擎和画布交互。",
              "Friday renders a lightweight shell first, then loads the node library, layout engine, and canvas interactions on demand.",
            )}
          </p>
        </section>

        <div className="grid gap-4 xl:grid-cols-[0.92fr_1.45fr_0.98fr]">
          <div className="min-h-[320px] rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4 shadow-[var(--shadow-floating)]" />
          <div className="min-h-[520px] rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4 shadow-[var(--shadow-floating)]" />
          <div className="min-h-[360px] rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4 shadow-[var(--shadow-floating)]" />
        </div>
      </div>
    );
  }
}

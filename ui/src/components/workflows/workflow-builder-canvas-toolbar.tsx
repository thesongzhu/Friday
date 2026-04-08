import { useMemo } from "react";
import { useReactFlow } from "@xyflow/react";

export interface WorkflowBuilderCanvasToolbarProps {
  nodesCount: number;
  edgesCount: number;
  overviewVisible: boolean;
  onToggleOverview: () => void;
}

export function WorkflowBuilderCanvasToolbar(props: WorkflowBuilderCanvasToolbarProps) {
  const reactFlow = useReactFlow();
  const statsLabel = useMemo(
    () => `${props.nodesCount} nodes · ${props.edgesCount} edges`,
    [props.edgesCount, props.nodesCount],
  );

  return (
    <div className="pointer-events-none absolute right-4 top-4 z-20 flex flex-col items-end gap-3">
      <div className="pointer-events-auto flex items-center gap-2 rounded-[20px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-elevated)] px-2 py-2 shadow-[var(--shadow-floating)]">
        <ToolbarButton label="−" onClick={() => void reactFlow.zoomOut?.({ duration: 120 })} />
        <ToolbarButton label="+" onClick={() => void reactFlow.zoomIn?.({ duration: 120 })} />
        <ToolbarButton label="Fit" onClick={() => void reactFlow.fitView?.({ duration: 160, padding: 0.18 })} />
        <ToolbarButton label={props.overviewVisible ? "Hide" : "Stats"} onClick={props.onToggleOverview} />
      </div>

      {props.overviewVisible ? (
        <div className="pointer-events-auto w-[220px] rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-elevated)] px-4 py-4 shadow-[var(--shadow-floating)]">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
            Canvas Summary
          </p>
          <p className="mt-2 text-sm font-medium text-[color:var(--color-text-primary)]">
            {statsLabel}
          </p>
          <p className="mt-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">
            Keep the first pass fast, then open the full inspector and template catalog only when you need them.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function ToolbarButton(props: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-sm font-medium text-[color:var(--color-text-primary)] transition hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg-surface-strong)]"
    >
      {props.label}
    </button>
  );
}

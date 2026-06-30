import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, CheckCircle2, ChevronRight, CircleAlert, FileCheck2, ShieldCheck } from "lucide-react";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

const RIGHT_RAIL_COLLAPSED_KEY = "friday.shell.right-rail-collapsed";
const RIGHT_RAIL_WIDTH_KEY = "friday.shell.right-rail-width";
const DEFAULT_RIGHT_RAIL_WIDTH = 428;
const MIN_RIGHT_RAIL_WIDTH = 360;
const MAX_RIGHT_RAIL_WIDTH = 620;

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(RIGHT_RAIL_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(RIGHT_RAIL_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // ignore storage failures
  }
}

function clampRailWidth(width: number): number {
  return Math.max(MIN_RIGHT_RAIL_WIDTH, Math.min(MAX_RIGHT_RAIL_WIDTH, Math.round(width)));
}

function readRailWidth(): number {
  try {
    const raw = window.localStorage.getItem(RIGHT_RAIL_WIDTH_KEY);
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampRailWidth(parsed) : DEFAULT_RIGHT_RAIL_WIDTH;
  } catch {
    return DEFAULT_RIGHT_RAIL_WIDTH;
  }
}

function writeRailWidth(width: number): void {
  try {
    window.localStorage.setItem(RIGHT_RAIL_WIDTH_KEY, String(clampRailWidth(width)));
  } catch {
    // ignore storage failures
  }
}

function widthVar(collapsed: boolean, widthPx: number): string {
  return collapsed
    ? "var(--shell-right-rail-w-collapsed)"
    : `${clampRailWidth(widthPx)}px`;
}

function ProofChip(props: { children: string; tone?: "accent" | "success" | "warning" }) {
  return (
    <span
      data-friday-ui="chip"
      className="inline-flex min-h-[28px] items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold"
      style={{
        borderColor: props.tone === "warning" ? "rgba(216, 99, 77, 0.24)" : "rgba(15, 125, 140, 0.22)",
        background:
          props.tone === "warning"
            ? "rgba(216, 99, 77, 0.12)"
            : props.tone === "success"
              ? "rgba(39, 122, 93, 0.12)"
              : "rgba(15, 125, 140, 0.10)",
        color:
          props.tone === "warning"
            ? "var(--coral)"
            : props.tone === "success"
              ? "var(--ok)"
              : "var(--accent)",
      }}
    >
      {props.children}
    </span>
  );
}

function ProofRow(props: {
  icon: typeof ShieldCheck;
  title: string;
  detail: string;
  tone?: "accent" | "success" | "warning";
}) {
  const Icon = props.icon;
  return (
    <div className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-3">
      <div className="flex items-start gap-3">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl"
          style={{
            background: props.tone === "warning" ? "rgba(216, 99, 77, 0.12)" : "rgba(15, 125, 140, 0.11)",
            color: props.tone === "warning" ? "var(--coral)" : "var(--accent)",
          }}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{props.title}</p>
          <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">{props.detail}</p>
        </div>
      </div>
    </div>
  );
}

function DesktopProofInspector(props: {
  collapsed: boolean;
  forceCollapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const { locale } = useAppLocale();

  if (props.collapsed || props.forceCollapsed) {
    return (
      <div className="flex h-full flex-col items-center gap-4 bg-[color:var(--color-bg-elevated)] px-2 py-4">
        <button
          type="button"
          onClick={props.onToggleCollapse}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] text-[color:var(--color-accent)]"
          aria-label={localize(locale, "展开证明检查器", "Expand proof inspector")}
        >
          <FileCheck2 className="h-4 w-4" />
        </button>
        <div data-testid="desktop-subtle-status-pet" className="h-2 w-2 rounded-full bg-[color:var(--accent)] shadow-[0_0_10px_rgba(15,125,140,0.35)]" />
        <div
          className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]"
          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
        >
          Proof
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="desktop-proof-inspector"
      className="flex h-full flex-col bg-[color:var(--color-bg-elevated)]"
    >
      <header className="border-b border-[color:var(--color-border-soft)] px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">
                Proof Inspector
              </p>
              <div
                data-testid="desktop-subtle-status-pet"
                className="h-2.5 w-2.5 rounded-full bg-[color:var(--accent)] shadow-[0_0_10px_rgba(15,125,140,0.35)]"
                aria-label={localize(locale, "Friday 状态点", "Friday status dot")}
              />
            </div>
            <h3 className="mt-2 text-xl font-semibold text-[color:var(--color-text-primary)]">
              {localize(locale, "证据与治理", "Evidence and governance")}
            </h3>
          </div>
          <button
            type="button"
            onClick={props.onToggleCollapse}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] text-[color:var(--color-text-secondary)] transition hover:text-[color:var(--color-text-primary)]"
            aria-label={localize(locale, "折叠证明检查器", "Collapse proof inspector")}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-friday-ui="button-primary"
            className="inline-flex min-h-[40px] items-center justify-center rounded-full border border-[color:var(--accent)] bg-[color:var(--accent)] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
          >
            {localize(locale, "查看当前证明", "Review current proof")}
          </button>
          <button
            type="button"
            data-friday-ui="filter"
            className="inline-flex min-h-[40px] items-center justify-center rounded-full border border-[rgba(15,125,140,0.22)] bg-[rgba(15,125,140,0.10)] px-3 py-2 text-sm font-semibold text-[color:var(--accent)]"
          >
            {localize(locale, "全部", "All")}
          </button>
          <ProofChip tone="accent">{localize(locale, "实时引用", "live refs")}</ProofChip>
        </div>

        <ProofRow
          icon={ShieldCheck}
          title={localize(locale, "治理边界", "Governance boundary")}
          detail={localize(
            locale,
            "审批、签名、写入和执行腿必须带可追踪引用；未证明的能力不会在这里显示成完成。",
            "Approvals, signatures, writes, and execution legs keep traceable refs; unproven work is not shown as complete.",
          )}
        />
        <ProofRow
          icon={FileCheck2}
          title={localize(locale, "证明收据", "Proof receipts")}
          detail={localize(
            locale,
            "这里是右停靠检查器，用来阅读当前 surface 的收据、哈希链和工作项状态。",
            "This right-docked inspector reads receipts, audit chains, and work-item state for the current surface.",
          )}
          tone="success"
        />
        <ProofRow
          icon={Activity}
          title={localize(locale, "运行状态", "Run state")}
          detail={localize(
            locale,
            "Friday 会保留真实状态差异：可操作项、需审批项、等待外部项分开显示。",
            "Friday keeps real state separated: actionable, approval-needed, and external-waiting items render differently.",
          )}
        />
        <ProofRow
          icon={CircleAlert}
          title={localize(locale, "未闭环项", "Open items")}
          detail={localize(
            locale,
            "如果缺少真实 receipt 或 live 观察，这里会保持待处理状态，而不是把证明缺口藏进聊天栏。",
            "When live receipts or observations are missing, this stays pending instead of hiding proof gaps in a chat rail.",
          )}
          tone="warning"
        />
      </div>

      <footer className="border-t border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-base)] px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">
              {localize(locale, "当前面板", "Current panel")}
            </p>
            <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">
              {localize(locale, "右停靠 · 三栏布局", "Right docked · three-pane layout")}
            </p>
          </div>
          <CheckCircle2 className="h-5 w-5 text-[color:var(--accent)]" />
        </div>
      </footer>
    </div>
  );
}

export function RightRail() {
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed());
  const [widthPx, setWidthPx] = useState<number>(() => readRailWidth());
  const forceCollapsed = false;

  const width = useMemo(
    () => widthVar(collapsed || forceCollapsed, widthPx),
    [collapsed, forceCollapsed, widthPx],
  );
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const widthRef = useRef(widthPx);

  useEffect(() => {
    widthRef.current = widthPx;
  }, [widthPx]);

  useEffect(() => {
    if (collapsed || forceCollapsed) {
      return;
    }
    writeRailWidth(widthPx);
  }, [collapsed, forceCollapsed, widthPx]);

  useEffect(() => {
    if (forceCollapsed) {
      return;
    }

    function handlePointerMove(event: MouseEvent) {
      const drag = dragStateRef.current;
      if (!drag) {
        return;
      }
      const nextWidth = clampRailWidth(drag.startWidth + (drag.startX - event.clientX));
      setWidthPx(nextWidth);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    function finishDrag() {
      if (!dragStateRef.current) {
        return;
      }
      dragStateRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      writeRailWidth(widthRef.current);
    }

    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("mouseup", finishDrag);
    return () => {
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("mouseup", finishDrag);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [forceCollapsed]);

  return (
    <aside
      data-testid="app-shell-right-rail"
      data-friday-ui="proof-inspector"
      data-dock="right"
      aria-label="Friday rail"
      className="group/right-rail relative hidden shrink-0 overflow-y-auto border-l lg:block"
      style={{
        width,
        background: "var(--color-bg-chrome-strong)",
        borderColor: "var(--color-border-soft)",
        transition: "width var(--motion-swift)",
      }}
    >
      {!collapsed && !forceCollapsed ? (
        <div
          data-testid="desktop-proof-inspector"
          className="sr-only"
        >
          Right-docked ProofInspector
        </div>
      ) : null}

      {!collapsed && !forceCollapsed ? (
        <button
          type="button"
          aria-label="Resize Friday rail"
          onMouseDown={(event) => {
            dragStateRef.current = {
              startX: event.clientX,
              startWidth: widthRef.current,
            };
            event.preventDefault();
          }}
          onDoubleClick={() => setWidthPx(DEFAULT_RIGHT_RAIL_WIDTH)}
          className="absolute inset-y-0 left-0 z-10 hidden w-4 -translate-x-1/2 cursor-col-resize items-center justify-center border-0 bg-transparent p-0 lg:flex"
        >
          <span
            className="h-20 w-[3px] rounded-full opacity-55 transition-opacity group-hover/right-rail:opacity-100"
            style={{ background: "rgba(122, 106, 88, 0.28)" }}
          />
        </button>
      ) : null}

      <DesktopProofInspector
        collapsed={collapsed}
        forceCollapsed={forceCollapsed}
        onToggleCollapse={() => {
          setCollapsed((current) => {
            const next = !current;
            writeCollapsed(next);
            return next;
          });
        }}
      />
    </aside>
  );
}

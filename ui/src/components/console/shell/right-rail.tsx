import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { FridayRail } from "./friday-rail";

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

export function RightRail() {
  const location = useLocation();
  const isChatPage = location.pathname === "/chat";
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
    if (isChatPage || collapsed || forceCollapsed) {
      return;
    }
    writeRailWidth(widthPx);
  }, [collapsed, forceCollapsed, isChatPage, widthPx]);

  useEffect(() => {
    if (isChatPage || forceCollapsed) {
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
  }, [forceCollapsed, isChatPage]);

  if (isChatPage) {
    return null;
  }

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

      <FridayRail
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

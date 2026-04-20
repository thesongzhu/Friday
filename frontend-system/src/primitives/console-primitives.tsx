import type { PropsWithChildren } from "react";
import type { PreviewState } from "../types";

export function PreviewPanel({ title, children }: PropsWithChildren<{ title: string }>) {
  return (
    <section style={{ border: "1px solid #dccdbe", borderRadius: 18, background: "#fffaf2", padding: 16 }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 18 }}>{title}</h2>
      {children}
    </section>
  );
}

export function StateBadge({ state }: { state: PreviewState }) {
  const palette: Record<PreviewState, { bg: string; fg: string }> = {
    loading: { bg: "#dceeff", fg: "#245680" },
    empty: { bg: "#efe4d5", fg: "#5d4e42" },
    error: { bg: "#f9dada", fg: "#7a2525" },
    partial: { bg: "#fff0cf", fg: "#7e5516" },
    success: { bg: "#dff3df", fg: "#245d31" },
  };

  return (
    <span style={{ display: "inline-block", padding: "4px 8px", borderRadius: 999, background: palette[state].bg, color: palette[state].fg, fontSize: 12, textTransform: "capitalize" }}>
      {state}
    </span>
  );
}

export function MetricList({ items }: { items: Array<{ title: string; value: string }> }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {items.map((item) => (
        <div key={item.title} style={{ display: "flex", justifyContent: "space-between", gap: 16, borderTop: "1px solid #f2e9dd", paddingTop: 10 }}>
          <span>{item.title}</span>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

export function BodyCopy({ children }: PropsWithChildren) {
  return <p style={{ margin: 0, lineHeight: 1.6, color: "#5d4e42" }}>{children}</p>;
}

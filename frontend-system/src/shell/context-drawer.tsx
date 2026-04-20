import type { PropsWithChildren } from "react";

export function ContextDrawer({ title, children }: PropsWithChildren<{ title: string }>) {
  return (
    <aside style={{ border: "1px solid #dccdbe", borderRadius: 20, padding: 16, background: "#fffaf2" }}>
      <div style={{ marginBottom: 12, fontSize: 14, fontWeight: 600 }}>{title}</div>
      {children}
    </aside>
  );
}

import type { PropsWithChildren, ReactNode } from "react";
import type { ShellContextContract, ShellNavItem } from "../types";

type ShellProps = PropsWithChildren<{
  title: string;
  nav: ShellNavItem[];
  context: ShellContextContract;
  rightRail: ReactNode;
}>;

export function DesktopConsoleShell({ title, nav, context, rightRail, children }: ShellProps) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "220px 1fr 340px", minHeight: "100vh", background: "#f5efe6", color: "#2f241a" }}>
      <aside style={{ borderRight: "1px solid #dccdbe", padding: 20, background: "#efe4d5" }}>
        <p style={{ margin: 0, fontSize: 12, letterSpacing: "0.16em", textTransform: "uppercase" }}>Friday</p>
        <h1 style={{ margin: "12px 0 20px", fontSize: 24 }}>{title}</h1>
        <nav style={{ display: "grid", gap: 10 }}>
          {nav.map((item) => (
            <div key={item.id} style={{ padding: "10px 12px", borderRadius: 14, background: item.id === context.sourcePage ? "#d8f0ec" : "#fffaf2" }}>
              {item.label}
            </div>
          ))}
        </nav>
      </aside>
      <main style={{ padding: 24 }}>{children}</main>
      <aside style={{ borderLeft: "1px solid #dccdbe", padding: 20, background: "#fffaf2" }}>{rightRail}</aside>
    </div>
  );
}

export function MobileConsoleShell({ title, nav, context, rightRail, children }: ShellProps) {
  return (
    <div style={{ minHeight: "100vh", background: "#f5efe6", color: "#2f241a" }}>
      <header style={{ padding: 16, borderBottom: "1px solid #dccdbe", background: "#fffaf2" }}>
        <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.16em" }}>Friday</div>
        <div style={{ marginTop: 8, fontSize: 24 }}>{title}</div>
      </header>
      <main style={{ padding: 16 }}>{children}</main>
      <section style={{ margin: "0 16px 16px", border: "1px solid #dccdbe", borderRadius: 18, padding: 16, background: "#fffaf2" }}>
        {rightRail}
      </section>
      <nav style={{ position: "sticky", bottom: 0, display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, padding: 12, borderTop: "1px solid #dccdbe", background: "#efe4d5" }}>
        {nav.slice(0, 5).map((item) => (
          <div key={item.id} style={{ textAlign: "center", fontSize: 12, color: item.id === context.sourcePage ? "#186f65" : "#5d4e42" }}>
            {item.label}
          </div>
        ))}
      </nav>
    </div>
  );
}

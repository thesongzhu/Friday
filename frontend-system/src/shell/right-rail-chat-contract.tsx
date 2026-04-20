import type { ShellContextContract } from "../types";

export function RightRailChatCard({ context }: { context: ShellContextContract }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div>
        <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.16em", color: "#8b7867" }}>Shared chat</div>
        <div style={{ marginTop: 8, fontSize: 18, fontWeight: 600 }}>{context.summary}</div>
      </div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Injected context</div>
        <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
          {context.injections.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Quick actions</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
          {context.quickActions.map((item) => (
            <span key={item} style={{ padding: "6px 10px", borderRadius: 999, background: "#d8f0ec", color: "#0f4f49", fontSize: 12 }}>
              {item}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

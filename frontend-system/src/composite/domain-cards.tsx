import { PreviewPanel } from "../primitives/console-primitives";

export function ApprovalStackCard({ count, risk }: { count: string; risk: string }) {
  return (
    <PreviewPanel title="Approval stack">
      <div style={{ display: "grid", gap: 8 }}>
        <div>Pending items: {count}</div>
        <div>Highest risk: {risk}</div>
      </div>
    </PreviewPanel>
  );
}

export function ProviderHealthCard({ provider, state }: { provider: string; state: string }) {
  return (
    <PreviewPanel title="Provider health">
      <div>{provider}</div>
      <div style={{ color: "#5d4e42" }}>{state}</div>
    </PreviewPanel>
  );
}

export function IncidentCard({ title, impact }: { title: string; impact: string }) {
  return (
    <PreviewPanel title="Incident">
      <div style={{ fontWeight: 600 }}>{title}</div>
      <div style={{ color: "#5d4e42", marginTop: 8 }}>{impact}</div>
    </PreviewPanel>
  );
}

export function IntegrationCard({ title, status }: { title: string; status: string }) {
  return (
    <PreviewPanel title={title}>
      <div style={{ color: "#5d4e42" }}>{status}</div>
    </PreviewPanel>
  );
}

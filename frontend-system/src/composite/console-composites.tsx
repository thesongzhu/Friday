import { BodyCopy, MetricList, PreviewPanel, StateBadge } from "../primitives/console-primitives";
import type { PreviewFixture } from "../types";

export function PageScenarioCard({ fixture }: { fixture: PreviewFixture }) {
  return (
    <PreviewPanel title={fixture.title}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <BodyCopy>{fixture.scenario}</BodyCopy>
        <StateBadge state={fixture.status} />
      </div>
      <MetricList items={fixture.modules.map((item) => ({ title: item.title, value: item.value }))} />
    </PreviewPanel>
  );
}

export function EvidenceSummaryCard({ items }: { items: string[] }) {
  return (
    <PreviewPanel title="Evidence summary">
      <ul style={{ margin: 0, paddingLeft: 18, color: "#5d4e42", lineHeight: 1.6 }}>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </PreviewPanel>
  );
}

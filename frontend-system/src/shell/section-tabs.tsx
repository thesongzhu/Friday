export function SectionTabs({
  tabs,
  activeId,
}: {
  tabs: Array<{ id: string; label: string }>;
  activeId: string;
}) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          style={{
            padding: "8px 12px",
            borderRadius: 999,
            background: tab.id === activeId ? "#d8f0ec" : "#efe4d5",
            color: tab.id === activeId ? "#0f4f49" : "#5d4e42",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {tab.label}
        </div>
      ))}
    </div>
  );
}

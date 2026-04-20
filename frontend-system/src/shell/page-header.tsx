export function PageHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <header style={{ display: "grid", gap: 8, marginBottom: 16 }}>
      <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.16em", color: "#8b7867" }}>{eyebrow}</div>
      <h1 style={{ margin: 0, fontSize: 30, lineHeight: 1.2 }}>{title}</h1>
      <p style={{ margin: 0, color: "#5d4e42", lineHeight: 1.6 }}>{description}</p>
    </header>
  );
}

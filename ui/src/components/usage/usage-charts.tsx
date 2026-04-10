/**
 * Lightweight CSS-based chart components for the usage dashboard.
 * No external chart library dependency — uses div-based percentage bars.
 */

export function PercentBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="h-3 w-full rounded-full bg-[color:var(--color-bg-subtle)]">
      <div
        className="h-3 rounded-full transition-all duration-300"
        style={{ width: `${String(pct)}%`, backgroundColor: color }}
      />
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "healthy":
      return <span className="inline-flex items-center rounded-full bg-[color:var(--color-bg-success-subtle)] px-2 py-0.5 text-xs font-medium text-[color:var(--color-text-success)]">Healthy</span>;
    case "degraded":
      return <span className="inline-flex items-center rounded-full bg-[color:var(--color-bg-warning-subtle)] px-2 py-0.5 text-xs font-medium text-[color:var(--color-text-warning)]">Degraded</span>;
    case "error":
    case "down":
      return <span className="inline-flex items-center rounded-full bg-[color:var(--color-bg-danger-subtle)] px-2 py-0.5 text-xs font-medium text-[color:var(--color-text-danger)]">Error</span>;
    default:
      return <span className="inline-flex items-center rounded-full bg-[color:var(--color-bg-subtle)] px-2 py-0.5 text-xs font-medium text-[color:var(--color-text-secondary)]">{status}</span>;
  }
}

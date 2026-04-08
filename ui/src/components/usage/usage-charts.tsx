/**
 * Lightweight CSS-based chart components for the usage dashboard.
 * No external chart library dependency — uses div-based percentage bars.
 */

export function PercentBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="h-3 w-full rounded-full bg-zinc-100 dark:bg-zinc-800">
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
      return <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">Healthy</span>;
    case "degraded":
      return <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">Degraded</span>;
    case "error":
    case "down":
      return <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">Error</span>;
    default:
      return <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">{status}</span>;
  }
}

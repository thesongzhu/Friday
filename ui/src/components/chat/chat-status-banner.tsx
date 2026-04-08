import type { StatusBannerViewModel } from "@/hooks/use-agent-run-events";

const TONE_STYLES: Record<StatusBannerViewModel["tone"], string> = {
  warning: "border-[color:var(--color-border-strong)] bg-[color:var(--color-accent-muted)] text-[color:var(--color-text-primary)]",
  info: "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] text-[color:var(--color-text-primary)]",
  error: "border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] text-[color:var(--color-text-primary)]",
};

const KIND_LABELS: Record<StatusBannerViewModel["kind"], string> = {
  degraded: "Degraded",
  mode_changed: "Mode",
  route_fallback: "Provider",
  route_mismatch: "Routing",
};

interface ChatStatusBannerProps {
  banners: StatusBannerViewModel[];
}

export function ChatStatusBanner({ banners }: ChatStatusBannerProps) {
  if (banners.length === 0) return null;

  return (
    <div className="space-y-2">
      {banners.map((banner) => (
        <div
          key={banner.id}
          className={`rounded-2xl border p-3 text-sm ${TONE_STYLES[banner.tone]}`}
        >
          <span className="mr-2 rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-[color:var(--color-text-secondary)]">
            {KIND_LABELS[banner.kind]}
          </span>
          {banner.message}
        </div>
      ))}
    </div>
  );
}

import type { StatusBannerViewModel } from "@/hooks/use-agent-run-events";

const TONE_STYLES: Record<StatusBannerViewModel["tone"], string> = {
  warning: "border-amber-400/30 bg-amber-400/[0.08] text-amber-100",
  info: "border-sky-400/30 bg-sky-400/[0.08] text-sky-100",
  error: "border-red-400/30 bg-red-400/[0.08] text-red-100",
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
          <span className="mr-2 rounded-full bg-white/10 px-2 py-0.5 text-xs font-semibold uppercase tracking-wider">
            {KIND_LABELS[banner.kind]}
          </span>
          {banner.message}
        </div>
      ))}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export interface InvestigationLine {
  id: string;
  text: string;
  type?: "info" | "discovery" | "analysis" | "conclusion";
}

export interface InvestigationPanelProps {
  lines: InvestigationLine[];
  isStreaming: boolean;
  title?: string;
}

function lineColor(type: InvestigationLine["type"]) {
  switch (type) {
    case "discovery":
      return "text-emerald-200/80";
    case "analysis":
      return "text-amber-200/70";
    case "conclusion":
      return "text-white";
    default:
      return "text-white/60";
  }
}

export function InvestigationPanel(props: InvestigationPanelProps) {
  const { lines, isStreaming, title } = props;
  const bottomRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(0);

  useEffect(() => {
    if (lines.length > visibleCount) {
      const timer = setTimeout(() => {
        setVisibleCount((prev) => Math.min(prev + 1, lines.length));
      }, 80);
      return () => clearTimeout(timer);
    }
  }, [lines.length, visibleCount]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [visibleCount]);

  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-center gap-2.5">
        {isStreaming && <Loader2 className="h-4 w-4 animate-spin text-[var(--accent-strong)]" />}
        <p className="text-sm font-medium text-white/70">
          {title ?? "Friday is investigating..."}
        </p>
      </div>

      <div className="mt-4 space-y-1.5 font-mono text-[13px] leading-6">
        {lines.slice(0, visibleCount).map((line, index) => (
          <p
            key={line.id}
            className={cn(
              "transition-opacity duration-300",
              index === visibleCount - 1 ? "animate-in fade-in slide-in-from-bottom-1 duration-300" : "",
              lineColor(line.type),
            )}
          >
            {line.text}
          </p>
        ))}
        {isStreaming && visibleCount >= lines.length && (
          <span className="inline-block h-4 w-1.5 animate-pulse bg-white/40" />
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

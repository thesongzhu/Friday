import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

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
      return "text-[color:var(--color-accent)]";
    case "analysis":
      return "text-[color:var(--color-text-secondary)]";
    case "conclusion":
      return "text-[color:var(--color-text-primary)]";
    default:
      return "text-[color:var(--color-text-tertiary)]";
  }
}

export function InvestigationPanel(props: InvestigationPanelProps) {
  const { locale } = useAppLocale();
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
    <div className="rounded-3xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-5 shadow-[var(--shadow-floating)]">
      <div className="flex items-center gap-2.5">
        {isStreaming && <Loader2 className="h-4 w-4 animate-spin text-[color:var(--color-accent)]" />}
        <p className="text-sm font-medium text-[color:var(--color-text-secondary)]">
          {title ?? localize(locale, "Friday 正在分析", "Friday is investigating")}
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
          <span className="inline-block h-4 w-1.5 animate-pulse bg-[color:var(--color-accent-soft)]" />
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

import { useState, type ReactNode } from "react";
import { HelpCircle } from "lucide-react";
import { lookupGlossary } from "@/lib/help/glossary";
import { cn } from "@/lib/utils/cn";

interface HelpTooltipProps {
  /** Glossary key to look up (e.g. "skill", "workflow", "fleet"). */
  term: string;
  /** Optional override for the tooltip text. */
  text?: string;
  /** Children rendered as the trigger element. */
  children?: ReactNode;
  className?: string;
}

export function HelpTooltip({ term, text, children, className }: HelpTooltipProps) {
  const [visible, setVisible] = useState(false);
  const entry = lookupGlossary(term);
  const tooltipText = text ?? entry?.definition;

  if (!tooltipText) {
    return <>{children}</>;
  }

  return (
    <span
      className={cn("relative inline-flex items-center gap-1", className)}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children ?? (
        <span className="inline-flex items-center gap-1 border-b border-dashed border-white/20 text-inherit">
          {entry?.term ?? term}
          <HelpCircle className="inline h-3 w-3 text-white/30" />
        </span>
      )}

      {visible && (
        <span className="absolute bottom-full left-1/2 z-50 mb-2 w-64 -translate-x-1/2 rounded-xl border border-white/10 bg-[var(--bg-canvas)] px-3 py-2 text-xs leading-relaxed text-white/70 shadow-lg">
          {entry?.term && <span className="mb-1 block font-semibold text-white">{entry.term}</span>}
          {tooltipText}
        </span>
      )}
    </span>
  );
}

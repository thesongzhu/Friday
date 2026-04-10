import { useState, useRef, useEffect } from "react";
import { HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { AppLocale } from "@/lib/i18n/localized-text";

export function ContextualHelp(props: { text: string; locale: AppLocale; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  if (!props.text) return null;

  return (
    <span ref={ref} className={cn("relative inline-flex", props.className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center rounded-full p-0.5 text-[color:var(--color-text-faint)] transition hover:text-[color:var(--color-text-secondary)]"
        aria-label={props.locale === "zh" ? "帮助" : "Help"}
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </button>
      {open && (
        <span className="absolute left-1/2 top-full z-50 mt-2 w-56 -translate-x-1/2 rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-elevated)] px-3 py-2.5 text-xs leading-5 text-[color:var(--color-text-secondary)] shadow-[var(--shadow-floating)]">
          {props.text}
        </span>
      )}
    </span>
  );
}

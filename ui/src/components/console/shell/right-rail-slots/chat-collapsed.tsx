import { MessageSquare } from "lucide-react";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

/**
 * Phase 1 placeholder — 44px-wide collapsed strip. When the full Chat tool
 * rail lands in Phase 2 this component will expand on demand (an `aria-expanded`
 * toggle mounts the ChatSidePanel). For now it documents the collapsed surface.
 */
export function ChatCollapsedRightRailSlot() {
  const { locale } = useAppLocale();
  return (
    <div className="flex h-full flex-col items-center gap-3 py-3">
      <span
        aria-hidden="true"
        className="flex h-9 w-9 items-center justify-center rounded-full"
        style={{ background: "var(--amber-100)", color: "var(--amber-600)" }}
      >
        <MessageSquare className="h-4 w-4" />
      </span>
      <p
        className="writing-vertical text-[10px] font-semibold uppercase tracking-[0.18em]"
        style={{
          color: "var(--ink-300)",
          writingMode: "vertical-rl",
          transform: "rotate(180deg)",
        }}
      >
        {localize(locale, "工具调用", "Tool calls")}
      </p>
    </div>
  );
}

import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import { Send } from "lucide-react";
import { cn } from "@/lib/utils/cn";

interface ChatInputProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

const QUICK_ACTIONS = [
  { label: "System status", text: "What is the current system status?" },
  { label: "Create workflow", text: "Help me create a new workflow" },
  { label: "Install a skill", text: "What skills can I install?" },
  { label: "Help", text: "What can you do?" },
];

export function ChatInput({ onSend, disabled = false, placeholder }: ChatInputProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [text, disabled, onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  const showQuickActions = text.length === 0;

  return (
    <div className="space-y-3">
      {showQuickActions && (
        <div className="flex flex-wrap gap-2">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => onSend(action.text)}
              disabled={disabled}
              className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-white/60 transition-colors hover:border-emerald-400/30 hover:bg-emerald-400/10 hover:text-white/80 disabled:opacity-50"
            >
              {action.label}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder={placeholder ?? "Ask Friday anything, or tell it what to do..."}
          disabled={disabled}
          rows={1}
          className="min-h-[24px] flex-1 resize-none bg-transparent text-sm text-white placeholder:text-white/30 focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={disabled || text.trim().length === 0}
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors",
            text.trim().length > 0 && !disabled
              ? "bg-emerald-500 text-white hover:bg-emerald-400"
              : "bg-white/10 text-white/30",
          )}
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

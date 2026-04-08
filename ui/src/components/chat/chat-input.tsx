import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Send } from "lucide-react";
import { localize } from "@/lib/i18n/localized-text";
import { cn } from "@/lib/utils/cn";
import { useAppLocale } from "@/providers/locale-provider";

interface ChatInputProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
}

export function ChatInput({
  onSend,
  disabled = false,
  placeholder,
  autoFocus = false,
  value,
  onValueChange,
}: ChatInputProps) {
  const { locale } = useAppLocale();
  const [internalText, setInternalText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const text = value ?? internalText;

  const setText = useCallback((nextValue: string) => {
    if (value === undefined) {
      setInternalText(nextValue);
    }
    onValueChange?.(nextValue);
  }, [onValueChange, value]);

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

  useEffect(() => {
    handleInput();
  }, [handleInput, text]);

  return (
    <div className="rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-3 shadow-[var(--shadow-floating)]">
      <div className="flex items-end gap-2">
        <textarea
          data-testid="chat-task-input"
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          autoFocus={autoFocus}
          placeholder={placeholder ?? localize(
            locale,
            "告诉 Friday 你要完成什么，或者直接描述你想处理的事情…",
            "Tell Friday what you want to get done or describe the task directly…",
          )}
          disabled={disabled}
          rows={1}
          className="min-h-[32px] flex-1 resize-none bg-transparent text-sm leading-6 text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-faint)] focus:outline-none disabled:opacity-50"
        />
        <button
          data-testid="chat-send-button"
          type="button"
          onClick={handleSend}
          disabled={disabled || text.trim().length === 0}
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors",
            text.trim().length > 0 && !disabled
              ? "bg-[color:var(--color-accent)] text-[color:var(--color-bg-base)] hover:opacity-90"
              : "bg-[color:var(--color-bg-subtle)] text-[color:var(--color-text-faint)]",
          )}
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

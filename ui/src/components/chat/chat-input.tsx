import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Send,
  MessageSquarePlus,
  Trash2,
  Sparkles,
  Workflow,
  Settings,
  HelpCircle,
} from "lucide-react";
import { localize } from "@/lib/i18n/localized-text";
import { cn } from "@/lib/utils/cn";
import { useAppLocale } from "@/providers/locale-provider";

/* ------------------------------------------------------------------ */
/*  Slash-command definitions                                         */
/* ------------------------------------------------------------------ */

interface SlashCommand {
  id: string;
  label: { zh: string; en: string };
  description: { zh: string; en: string };
  icon: React.ComponentType<{ className?: string }>;
}

const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "new",
    label: { zh: "新对话", en: "New conversation" },
    description: { zh: "清除历史开始新会话", en: "Clear history and start fresh" },
    icon: MessageSquarePlus,
  },
  {
    id: "clear",
    label: { zh: "清除历史", en: "Clear history" },
    description: { zh: "清除当前对话记录", en: "Clear current conversation" },
    icon: Trash2,
  },
  {
    id: "skills",
    label: { zh: "技能库", en: "Skills" },
    description: { zh: "打开技能页面", en: "Open skills page" },
    icon: Sparkles,
  },
  {
    id: "workflows",
    label: { zh: "工作流", en: "Workflows" },
    description: { zh: "打开工作流页面", en: "Open workflows page" },
    icon: Workflow,
  },
  {
    id: "settings",
    label: { zh: "设置", en: "Settings" },
    description: { zh: "打开设置页面", en: "Open settings page" },
    icon: Settings,
  },
  {
    id: "help",
    label: { zh: "帮助", en: "Help" },
    description: { zh: "显示可用命令", en: "Show available commands" },
    icon: HelpCircle,
  },
];

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

interface ChatInputProps {
  onSend: (text: string) => void;
  onCommand?: (commandId: string) => void;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
}

const CHAT_INPUT_MAX_LENGTH = 50_000;

export function ChatInput({
  onSend,
  onCommand,
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

  /* --- slash dropdown state --- */
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [slashOpen, setSlashOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const filteredCommands = useMemo(() => {
    if (!text.startsWith("/")) return [];
    const query = text.slice(1).toLowerCase();
    return SLASH_COMMANDS.filter(
      (cmd) =>
        cmd.id.startsWith(query) ||
        cmd.label.zh.includes(query) ||
        cmd.label.en.toLowerCase().includes(query),
    );
  }, [text]);

  // Show/hide dropdown when filtered results change
  useEffect(() => {
    setSlashOpen(filteredCommands.length > 0 && text.startsWith("/"));
    setSelectedIndex(0);
  }, [filteredCommands.length, text]);

  const executeCommand = useCallback(
    (cmd: SlashCommand) => {
      onCommand?.(cmd.id);
      setText("");
      setSlashOpen(false);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    },
    [onCommand],
  );

  const setText = useCallback(
    (nextValue: string) => {
      if (value === undefined) {
        setInternalText(nextValue);
      }
      onValueChange?.(nextValue);
    },
    [onValueChange, value],
  );

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [text, disabled, onSend, setText]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (slashOpen) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev < filteredCommands.length - 1 ? prev + 1 : 0,
          );
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev > 0 ? prev - 1 : filteredCommands.length - 1,
          );
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const cmd = filteredCommands[selectedIndex];
          if (cmd) executeCommand(cmd);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashOpen(false);
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          const cmd = filteredCommands[selectedIndex];
          if (cmd) {
            setText(`/${cmd.id}`);
          }
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [slashOpen, handleSend, filteredCommands, selectedIndex, executeCommand, setText],
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

  // Scroll selected item into view
  useEffect(() => {
    if (!slashOpen || !dropdownRef.current) return;
    const items = dropdownRef.current.querySelectorAll("[data-slash-item]");
    items[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, slashOpen]);

  return (
    <div className="relative">
      {/* Slash-command dropdown (appears ABOVE the input) */}
      {slashOpen && (
        <div
          ref={dropdownRef}
          className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-[240px] overflow-y-auto rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] py-1 shadow-[var(--shadow-floating)] animate-in fade-in duration-150"
        >
          <div className="px-3 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-text-faint)]">
              {localize(locale, "命令", "Commands")}
            </span>
          </div>
          {filteredCommands.map((cmd, i) => {
            const Icon = cmd.icon;
            return (
              <button
                key={cmd.id}
                type="button"
                data-slash-item
                onMouseEnter={() => setSelectedIndex(i)}
                onClick={() => executeCommand(cmd)}
                className={cn(
                  "flex w-full items-center gap-3 px-3 transition-colors",
                  "h-10 text-left",
                  i === selectedIndex
                    ? "bg-[color:var(--color-accent-soft)]"
                    : "hover:bg-[color:var(--color-bg-subtle)]",
                )}
              >
                <Icon className="h-4 w-4 shrink-0 text-[color:var(--color-text-secondary)]" />
                <span className="text-sm font-medium text-[color:var(--color-text-primary)]">
                  /{cmd.id}
                </span>
                <span className="truncate text-xs text-[color:var(--color-text-secondary)]">
                  {locale === "zh" ? cmd.description.zh : cmd.description.en}
                </span>
              </button>
            );
          })}
        </div>
      )}

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
            aria-label={localize(locale, "任务输入框", "Task input")}
            placeholder={placeholder ?? localize(
              locale,
              "告诉 Friday 你要完成什么，或者直接描述你想处理的事情…",
              "Tell Friday what you want to get done or describe the task directly…",
            )}
            disabled={disabled}
            maxLength={CHAT_INPUT_MAX_LENGTH}
            rows={1}
            className="min-h-[32px] flex-1 resize-none bg-transparent text-sm leading-6 text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-faint)] focus:outline-none disabled:opacity-50"
          />
          <button
            data-testid="chat-send-button"
            type="button"
            aria-label={localize(locale, "发送消息", "Send message")}
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
    </div>
  );
}

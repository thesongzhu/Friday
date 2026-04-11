import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  MessageCircle,
  MessageSquarePlus,
  Send,
  Trash2,
  Sparkles,
  Workflow,
  Settings,
  HelpCircle,
} from "lucide-react";
import { useChatSession } from "@/hooks/use-chat-session";
import { useAppNavigate } from "@/hooks/use-app-navigate";
import { ChatMessageBubble } from "@/components/chat/chat-message";
import { localize } from "@/lib/i18n/localized-text";
import { cn } from "@/lib/utils/cn";
import { useAppLocale } from "@/providers/locale-provider";

/* ------------------------------------------------------------------ */
/*  Slash-command definitions (mirrors chat-input.tsx)                 */
/* ------------------------------------------------------------------ */

interface SlashCommand {
  id: string;
  label: { zh: string; en: string };
  description: { zh: string; en: string };
  icon: React.ComponentType<{ className?: string }>;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { id: "new", label: { zh: "新对话", en: "New conversation" }, description: { zh: "清除历史开始新会话", en: "Clear history and start fresh" }, icon: MessageSquarePlus },
  { id: "clear", label: { zh: "清除历史", en: "Clear history" }, description: { zh: "清除当前对话记录", en: "Clear current conversation" }, icon: Trash2 },
  { id: "skills", label: { zh: "技能库", en: "Skills" }, description: { zh: "打开技能页面", en: "Open skills page" }, icon: Sparkles },
  { id: "workflows", label: { zh: "工作流", en: "Workflows" }, description: { zh: "打开工作流页面", en: "Open workflows page" }, icon: Workflow },
  { id: "settings", label: { zh: "设置", en: "Settings" }, description: { zh: "打开设置页面", en: "Open settings page" }, icon: Settings },
  { id: "help", label: { zh: "帮助", en: "Help" }, description: { zh: "显示可用命令", en: "Show available commands" }, icon: HelpCircle },
];

/**
 * Compact chat panel that lives in the right sidebar of the AppShell.
 * Shares the same session as the full-screen ChatPage via useChatSession.
 * Hidden when the user is on the /chat route (full-screen mode takes over).
 */
export function ChatSidePanel() {
  const { locale } = useAppLocale();
  const navigate = useAppNavigate();
  const {
    messages,
    runEvents,
    sendMessage,
    isStreaming,
    clearHistory,
    startNewConversation,
  } = useChatSession({});

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [slashOpen, setSlashOpen] = useState(false);

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

  useEffect(() => {
    setSlashOpen(filteredCommands.length > 0 && text.startsWith("/"));
    setSelectedIndex(0);
  }, [filteredCommands.length, text]);

  const executeCommand = useCallback(
    (cmd: SlashCommand) => {
      setText("");
      setSlashOpen(false);
      if (textareaRef.current) textareaRef.current.style.height = "auto";

      switch (cmd.id) {
        case "new":
          startNewConversation();
          break;
        case "clear":
          clearHistory();
          break;
        case "skills":
          navigate("/skills");
          break;
        case "workflows":
          navigate("/workflows");
          break;
        case "settings":
          navigate("/settings");
          break;
        case "help":
          void sendMessage(
            locale === "zh"
              ? "请列出所有可用的斜杠命令及其用途。"
              : "Please list all available slash commands and what they do.",
          );
          break;
      }
    },
    [startNewConversation, clearHistory, navigate, sendMessage, locale],
  );

  useEffect(() => {
    if (!slashOpen || !dropdownRef.current) return;
    const items = dropdownRef.current.querySelectorAll("[data-slash-item]");
    items[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, slashOpen]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, isStreaming]);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    void sendMessage(trimmed);
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [text, isStreaming, sendMessage]);

  const handleRetry = useCallback((assistantMsgId: string) => {
    const idx = messages.findIndex((m) => m.id === assistantMsgId);
    if (idx < 1) return;
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i]!.role === "user") {
        void sendMessage(messages[i]!.content);
        return;
      }
    }
  }, [messages, sendMessage]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev < filteredCommands.length - 1 ? prev + 1 : 0));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : filteredCommands.length - 1));
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
        if (cmd) setText(`/${cmd.id}`);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [slashOpen, handleSend, filteredCommands, selectedIndex, executeCommand]);

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  useEffect(() => {
    handleInput();
  }, [handleInput, text]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-[color:var(--color-border-soft)] px-4 py-3">
        <div className="flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-[color:var(--color-accent)]" />
          <span className="text-sm font-semibold text-[color:var(--color-text-primary)]">
            {localize(locale, "Friday 对话", "Friday Chat")}
          </span>
        </div>
        <span className="rounded-full bg-[color:var(--color-accent-soft)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--color-accent)]">
          {localize(locale, "上下文已加载", "Context loaded")}
        </span>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)]">
              <MessageCircle className="h-5 w-5 text-[color:var(--color-accent)]" />
            </div>
            <p className="mt-3 text-sm font-medium text-[color:var(--color-text-primary)]">
              {localize(locale, "随时对话", "Chat anytime")}
            </p>
            <p className="mt-1 max-w-[240px] text-xs leading-relaxed text-[color:var(--color-text-secondary)]">
              {localize(
                locale,
                "Friday 已加载你的记忆和工作上下文。在任何页面都可以在这里对话。",
                "Friday has loaded your memory and work context. Chat here from any page.",
              )}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((msg) => (
              <ChatMessageBubble
                key={msg.id}
                message={msg}
                onRetry={msg.role === "assistant" ? () => handleRetry(msg.id) : undefined}
              />
            ))}
            {runEvents.autonomousGoal ? (
              <div className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-faint)]">
                  {localize(locale, "自主任务", "Autonomous Task")}
                </p>
                <p className="mt-0.5 text-xs text-[color:var(--color-text-secondary)] line-clamp-2">
                  {runEvents.autonomousGoal.description}
                </p>
                {runEvents.autonomousGoal.steps.length > 0 && (
                  <div className="mt-1.5 flex items-center gap-1">
                    {runEvents.autonomousGoal.steps.map((step) => (
                      <div
                        key={step.id}
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          step.status === "completed" ? "bg-emerald-500"
                            : step.status === "executing" ? "bg-[color:var(--color-accent)] animate-pulse"
                            : step.status === "failed" ? "bg-red-500"
                            : "bg-[color:var(--color-text-faint)]",
                        )}
                      />
                    ))}
                  </div>
                )}
              </div>
            ) : null}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Compact input */}
      <div className="relative shrink-0 border-t border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-base)] px-3 py-3">
        {slashOpen && (
          <div
            ref={dropdownRef}
            className="absolute bottom-full left-3 right-3 z-50 mb-2 max-h-[240px] overflow-y-auto rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] py-1 shadow-[var(--shadow-floating)] animate-in fade-in duration-150"
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
        <div className="flex items-end gap-2 rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-2 transition-colors focus-within:border-[color:var(--color-border-strong)]">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            placeholder={localize(locale, "告诉 Friday 你要完成什么…", "Tell Friday what you want to do...")}
            disabled={isStreaming}
            rows={1}
            className="min-h-[24px] max-h-[120px] flex-1 resize-none bg-transparent text-sm leading-relaxed text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-faint)] focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={isStreaming || text.trim().length === 0}
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors",
              text.trim().length > 0 && !isStreaming
                ? "bg-[color:var(--color-accent)] text-[color:var(--color-bg-base)] hover:opacity-90"
                : "bg-[color:var(--color-bg-subtle)] text-[color:var(--color-text-faint)]",
            )}
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="mt-1.5 flex items-center gap-1.5 px-1">
          <span className="h-[5px] w-[5px] rounded-full bg-emerald-400" />
          <span className="text-[10px] text-[color:var(--color-text-faint)]">
            {localize(locale, "Friday 已加载记忆和上下文 · 单会话", "Memory & context loaded · Single session")}
          </span>
        </div>
      </div>
    </div>
  );
}

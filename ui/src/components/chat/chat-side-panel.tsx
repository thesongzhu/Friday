import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { MessageCircle, Send } from "lucide-react";
import { useChatSession } from "@/hooks/use-chat-session";
import { ChatMessageBubble } from "@/components/chat/chat-message";
import { localize } from "@/lib/i18n/localized-text";
import { cn } from "@/lib/utils/cn";
import { useAppLocale } from "@/providers/locale-provider";

/**
 * Compact chat panel that lives in the right sidebar of the AppShell.
 * Shares the same session as the full-screen ChatPage via useChatSession.
 * Hidden when the user is on the /chat route (full-screen mode takes over).
 */
export function ChatSidePanel() {
  const { locale } = useAppLocale();
  const {
    messages,
    runEvents,
    sendMessage,
    isStreaming,
  } = useChatSession({});

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");

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

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

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
              <ChatMessageBubble key={msg.id} message={msg} />
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
      <div className="shrink-0 border-t border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-base)] px-3 py-3">
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

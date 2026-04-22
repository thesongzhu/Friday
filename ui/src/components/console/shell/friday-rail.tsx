import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Send } from "lucide-react";
import { useLocation } from "react-router-dom";
import { ProviderTruthCard } from "@/components/console/shell/provider-truth";
import { useChatSession } from "@/hooks/use-chat-session";
import { useProviderTruthQuery } from "@/hooks/use-provider-truth";
import { learningApi } from "@/lib/api/learning";
import { localize, resolveLocalizedText } from "@/lib/i18n/localized-text";
import { resolvePageTitle } from "@/lib/routes/agent-os-nav";
import { cn } from "@/lib/utils/cn";
import { useAppLocale } from "@/providers/locale-provider";

interface FridayRailProps {
  collapsed: boolean;
  forceCollapsed?: boolean;
  onToggleCollapse: () => void;
}

function formatShortTime(value: string, locale: "zh" | "en"): string {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function buildLearningBullets(
  overview: Awaited<ReturnType<typeof learningApi.getOverview>>,
  locale: "zh" | "en",
): string[] {
  const bullets: string[] = [];
  if (overview.coverage.autoFixActions > 0) {
    bullets.push(
      localize(
        locale,
        `${overview.coverage.autoFixActions} 次自动回补修复已经进过真实运行链路`,
        `${overview.coverage.autoFixActions} auto-fix actions have already run through the live pipeline`,
      ),
    );
  }
  if (overview.coverage.patterns > 0) {
    bullets.push(
      localize(
        locale,
        `${overview.coverage.patterns} 个工作模式已进入 Friday 的学习层`,
        `${overview.coverage.patterns} work patterns are now part of Friday's learning layer`,
      ),
    );
  }
  if (overview.coverage.lessons > 0) {
    bullets.push(
      localize(
        locale,
        `累计 ${overview.coverage.lessons} 条教训正在影响后续路由与修复决策`,
        `${overview.coverage.lessons} lessons are shaping later routing and repair decisions`,
      ),
    );
  }
  if (overview.recentRejectedFixes.length > 0) {
    bullets.push(
      localize(
        locale,
        `最近 ${overview.recentRejectedFixes.length} 次被拒修复已被 Friday 记住，避免重复犯错`,
        `${overview.recentRejectedFixes.length} recent rejected fixes were remembered to avoid repeating them`,
      ),
    );
  }
  return bullets.slice(0, 3);
}

function RailMessage(props: {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  locale: "zh" | "en";
  status?: "sending" | "streaming" | "done" | "error";
}) {
  const isUser = props.role === "user";
  return (
    <div className="space-y-1.5">
      <p className="text-[10px] uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">
        {isUser ? localize(props.locale, "你", "You") : "FRIDAY"} · {formatShortTime(props.timestamp, props.locale)}
      </p>
      <div
        className={cn(
          "rounded-[22px] border px-3 py-3 text-sm leading-6",
          isUser
            ? "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] text-[color:var(--color-text-primary)]"
            : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] text-[color:var(--color-text-primary)]",
          props.status === "error" && "border-[color:var(--color-border-danger)] bg-[color:var(--color-bg-danger-subtle)]",
        )}
      >
        {props.status === "streaming" && props.content.trim().length === 0 ? (
          <div className="flex items-center gap-1.5 py-1">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[color:var(--color-accent)]" />
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[color:var(--color-accent)]" style={{ animationDelay: "120ms" }} />
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[color:var(--color-accent)]" style={{ animationDelay: "240ms" }} />
          </div>
        ) : (
          <div className="whitespace-pre-wrap break-words">{props.content}</div>
        )}
      </div>
    </div>
  );
}

export function FridayRail(props: FridayRailProps) {
  const location = useLocation();
  const { locale } = useAppLocale();
  const providerTruthQuery = useProviderTruthQuery();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const [showCards, setShowCards] = useState(true);
  const effectiveCollapsed = props.collapsed || props.forceCollapsed === true;
  const pageLabel = resolveLocalizedText(resolvePageTitle(location.pathname), locale);
  const learningQuery = useQuery({
    queryKey: ["learning", "overview", "friday-rail"],
    queryFn: () => learningApi.getOverview(5),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const {
    messages,
    runEvents,
    sendMessage,
    isStreaming,
  } = useChatSession({});

  const learningBullets = useMemo(
    () => (learningQuery.data ? buildLearningBullets(learningQuery.data, locale) : []),
    [learningQuery.data, locale],
  );
  const helperCardVisible = messages.length === 0;
  const cardCount = (learningBullets.length > 0 ? 1 : 0) + (helperCardVisible ? 1 : 0);
  const latestAssistantMessage = messages.length > 0 ? messages[messages.length - 1] : null;

  const renderedMessages = useMemo(
    () => messages.map((message) => {
      const streamingText = message.id === latestAssistantMessage?.id && message.status === "streaming"
        ? runEvents.outputText
        : message.content;
      return {
        ...message,
        renderedContent: streamingText,
      };
    }),
    [latestAssistantMessage?.id, messages, runEvents.outputText],
  );

  useEffect(() => {
    if (effectiveCollapsed) {
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [effectiveCollapsed, renderedMessages.length, runEvents.outputText]);

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) {
      return;
    }
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 132)}px`;
  }, [draft]);

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text || isStreaming) {
      return;
    }
    void sendMessage(text);
    setDraft("");
  }, [draft, isStreaming, sendMessage]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  if (effectiveCollapsed) {
    return (
      <div className="flex h-full flex-col items-center justify-between py-3">
        <div className="flex flex-col items-center gap-3">
          {!props.forceCollapsed ? (
            <button
              type="button"
              onClick={props.onToggleCollapse}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] text-[color:var(--color-text-secondary)] transition hover:text-[color:var(--color-text-primary)]"
              aria-label={localize(locale, "展开 Friday", "Expand Friday")}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          ) : (
            <div className="flex h-9 w-9 items-center justify-center rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] text-[color:var(--color-accent)]">
              F
            </div>
          )}
          <div
            className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]"
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
          >
            Friday
          </div>
        </div>
        <div className="h-2 w-2 rounded-full bg-[color:var(--color-accent)] opacity-80" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[color:var(--color-bg-elevated)]">
      <header className="border-b border-[color:var(--color-border-soft)] px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-xl font-semibold text-[color:var(--color-text-primary)]" style={{ fontFamily: "var(--font-serif)" }}>
              Friday
            </h3>
            <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">
              <span className="mr-1 text-[color:var(--color-accent)]">•</span>
              {localize(locale, "正在看", "Watching")} · {pageLabel}
            </p>
          </div>
          <button
            type="button"
            onClick={props.onToggleCollapse}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] text-[color:var(--color-text-secondary)] transition hover:text-[color:var(--color-text-primary)]"
            aria-label={localize(locale, "折叠 Friday", "Collapse Friday")}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <ProviderTruthCard
          locale={locale}
          truth={providerTruthQuery.data}
          loading={providerTruthQuery.isPending}
          variant="rail"
        />

        {showCards && learningBullets.length > 0 ? (
          <section className="space-y-3 rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">
                LEARNING LOOP · {localize(locale, "学习反馈", "Learning feedback")}
              </p>
              <h4 className="mt-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
                {localize(locale, "Friday 最近学到了什么", "What Friday learned recently")}
              </h4>
            </div>
            <ul className="space-y-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">
              {learningBullets.map((bullet) => (
                <li key={bullet} className="flex gap-2">
                  <span className="mt-[7px] inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--color-accent)]" />
                  <span>{bullet}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {showCards && helperCardVisible ? (
          <section className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4 text-sm leading-6 text-[color:var(--color-text-primary)]">
            {localize(
              locale,
              "我在这儿。你可以直接让我执行页面上的操作，或者先问我现在这页最值得处理的事情。",
              "I'm here. Ask me to execute something on this page, or ask what matters most here right now.",
            )}
          </section>
        ) : null}

        {renderedMessages.map((message) => (
          <RailMessage
            key={message.id}
            role={message.role}
            content={message.renderedContent}
            timestamp={message.timestamp}
            locale={locale}
            status={message.status}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      <footer className="border-t border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-base)] px-4 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setShowCards((current) => !current)}
            className="rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-1 text-[11px] text-[color:var(--color-text-secondary)] transition hover:text-[color:var(--color-text-primary)]"
          >
            {showCards
              ? localize(locale, "隐藏所有卡片", "Hide all cards")
              : localize(locale, "显示所有卡片", "Show all cards")}
          </button>
          <span className="text-[11px] text-[color:var(--color-text-faint)]">
            {localize(locale, `${renderedMessages.length} 条 · ${cardCount} 卡片`, `${renderedMessages.length} messages · ${cardCount} cards`)}
          </span>
        </div>

        <div className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-3">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={localize(locale, "让 Friday 做点什么…", "Ask Friday to do something…")}
            disabled={isStreaming}
            className="min-h-[32px] w-full resize-none bg-transparent text-sm leading-6 text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-faint)] focus:outline-none disabled:opacity-50"
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-[10px] text-[color:var(--color-text-faint)]">
              <span>{localize(locale, `作用域 · ${pageLabel}`, `Scope · ${pageLabel}`)}</span>
              <span className="rounded-full border border-[color:var(--color-border-soft)] px-1.5 py-0.5">{localize(locale, "⌘↩ 发送", "Cmd+Enter send")}</span>
            </div>
            <button
              type="button"
              onClick={handleSend}
              disabled={isStreaming || draft.trim().length === 0}
              className={cn(
                "flex h-10 min-w-[44px] items-center justify-center rounded-full border px-3 transition disabled:cursor-not-allowed disabled:opacity-50",
                draft.trim().length > 0 && !isStreaming
                  ? "border-[color:var(--color-accent)] bg-[color:var(--color-bg-base)] text-[color:var(--color-accent)] hover:bg-[color:var(--color-accent-soft)]"
                  : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] text-[color:var(--color-text-faint)]",
              )}
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}

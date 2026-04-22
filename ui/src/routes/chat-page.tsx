import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, MessageSquarePlus, Trash2 } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useChatSession } from "@/hooks/use-chat-session";
import { ChatMessageBubble } from "@/components/chat/chat-message";
import { ChatInput } from "@/components/chat/chat-input";
import { ChatToolActivity } from "@/components/chat/chat-tool-activity";
import { AutonomousStepIndicator } from "@/components/chat/autonomous-step-indicator";
import { ChatActionCard, parseActionsFromText } from "@/components/chat/chat-action-card";
import { ActionButton } from "@/components/core/primitives";
import { PackQuickSheet } from "@/components/packs/pack-quick-sheet";
import { useAppNavigate } from "@/hooks/use-app-navigate";
import { useCustomPacks } from "@/hooks/use-custom-packs";
import { useHomeSurfacePreferences } from "@/hooks/use-home-surface-preferences";
import { usePackLaunchActions } from "@/hooks/use-pack-launch-actions";
import { useUserProfile } from "@/hooks/use-user-profile";
import { localize } from "@/lib/i18n/localized-text";
import { buildPackAssistantHref } from "@/lib/packs/pack-links";
import { getPackById } from "@/lib/packs/pack-registry";
import { sessionsApi, type SessionUsageResponse } from "@/lib/api/sessions";
import { buildSkillHref } from "@/lib/skills/view-models";
import { useAppLocale } from "@/providers/locale-provider";

function formatUsage(sessionUsage: SessionUsageResponse, locale: "zh" | "en"): string {
  const tokenCount = ((sessionUsage.totalInputTokens + sessionUsage.totalOutputTokens) / 1000).toFixed(1);
  if (locale === "zh") {
    return `${tokenCount}K tokens`;
  }
  return `${tokenCount}K tokens`;
}

export function ChatPage() {
  const navigate = useAppNavigate();
  const { locale } = useAppLocale();
  const { profileType } = useUserProfile();
  const { pinnedPackIds } = useHomeSurfacePreferences(profileType);
  const { customPackInputs } = useCustomPacks();
  const { startPackNow, adjustPackBeforeStart } = usePackLaunchActions(customPackInputs, { surface: "chat" });
  const [searchParams, setSearchParams] = useSearchParams();
  const packIdParam = searchParams.get("packId");
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
  const [pendingPackPath, setPendingPackPath] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [showTopFade, setShowTopFade] = useState(false);
  const {
    messages,
    sessionKey,
    runEvents,
    sendMessage,
    isStreaming,
    clearHistory,
    startNewConversation,
  } = useChatSession({ packId: packIdParam });

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const lastCompletedMessageIdRef = useRef<string | null>(null);
  const [sessionUsage, setSessionUsage] = useState<SessionUsageResponse | null>(null);
  const activePack = packIdParam ? getPackById(packIdParam, customPackInputs) ?? null : null;

  // Save-as-automation moved to task completion flow (assistant/sessions pages)
  // Not appropriate during mid-conversation in chat.

  useEffect(() => {
    const prompt = searchParams.get("prompt")?.trim();
    if (!prompt) {
      return;
    }
    setDraftText(prompt);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("prompt");
      return next;
    }, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (!sessionKey) {
      setSessionUsage(null);
      return;
    }
    sessionsApi.getUsage(sessionKey).then(setSessionUsage).catch((err) => {
      console.warn("[friday][chat] Failed to fetch session usage:", err);
      setSessionUsage(null);
    });
  }, [messages.length, sessionKey]);

  useEffect(() => {
    if (!pendingPackPath) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      navigate(pendingPackPath);
      setPendingPackPath(null);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [navigate, pendingPackPath]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    const updateAutoScrollState = () => {
      const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
      shouldAutoScrollRef.current = remaining < 96;
      setShowTopFade(container.scrollTop > 8);
    };

    updateAutoScrollState();
    container.addEventListener("scroll", updateAutoScrollState, { passive: true });
    return () => container.removeEventListener("scroll", updateAutoScrollState);
  }, []);

  useEffect(() => {
    const latestMessage = messages[messages.length - 1];
    if (!latestMessage || latestMessage.role !== "assistant") {
      return;
    }

    const isNewCompletedMessage =
      latestMessage.status === "done"
      && latestMessage.id !== lastCompletedMessageIdRef.current;
    if (isNewCompletedMessage) {
      lastCompletedMessageIdRef.current = latestMessage.id;
    }

    if (!shouldAutoScrollRef.current && !isNewCompletedMessage) {
      return;
    }

    bottomRef.current?.scrollIntoView({
      behavior: isNewCompletedMessage ? "smooth" : "auto",
      block: "end",
    });

    window.requestAnimationFrame(() => {
      const container = scrollRef.current;
      if (!container) {
        return;
      }
      setShowTopFade(container.scrollTop > 8);
    });
  }, [messages, runEvents.progress.phase]);

  const handleSend = useCallback((text: string) => {
    setDraftText("");
    void sendMessage(text);
  }, [sendMessage]);

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

  const handleCommand = useCallback((commandId: string) => {
    switch (commandId) {
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
  }, [startNewConversation, clearHistory, navigate, sendMessage, locale]);

  const latestAssistantMsg = messages.length > 0
    ? messages[messages.length - 1]
    : undefined;
  const streamingContent = latestAssistantMsg?.status === "streaming"
    ? runEvents.outputText
    : undefined;
  const { actions: streamingActions } = streamingContent
    ? parseActionsFromText(streamingContent)
    : { actions: [] };

  const pinnedPacks = useMemo(
    () => pinnedPackIds
      .map((packId) => getPackById(packId, customPackInputs))
      .filter((pack): pack is NonNullable<ReturnType<typeof getPackById>> => Boolean(pack))
      .slice(0, 4),
    [customPackInputs, pinnedPackIds],
  );
  const selectedPack = selectedPackId ? getPackById(selectedPackId, customPackInputs) ?? null : null;
  const activePackTitle = activePack ? (locale === "zh" ? activePack.title.zh : activePack.title.en) : null;
  const examplePrompts = useMemo(
    () => [
      localize(locale, "帮我整理这周最该推进的三件事。", "Help me identify the three most important things to push this week."),
      localize(locale, "把这段材料整理成一份可执行摘要。", "Turn these notes into an actionable summary."),
      localize(locale, "现在这个问题先做哪一步最合适？", "What is the best next step for this issue right now?"),
    ],
    [locale],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <section className="flex shrink-0 flex-col gap-3 rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-4 shadow-[var(--shadow-floating)] lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
            {activePackTitle
              ? localize(locale, "当前行业与任务", "Current pack")
              : localize(locale, "主聊天", "Main chat")}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight text-[color:var(--color-text-primary)]">
              {activePackTitle ?? localize(locale, "直接告诉 Friday 你要完成什么", "Tell Friday what to do")}
            </h2>
            {sessionUsage && sessionUsage.totalRuns > 0 ? (
              <span className="inline-flex min-h-[28px] items-center rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 text-xs text-[color:var(--color-text-secondary)]">
                {formatUsage(sessionUsage, locale)}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm leading-6 text-[color:var(--color-text-secondary)]">
            {activePackTitle
              ? localize(
                locale,
                "当前对话会继续沿用这个入口的上下文与路由。",
                "This conversation keeps using the context and routing from the selected pack.",
              )
              : localize(
                locale,
                "输入框固定在底部；历史记录向上翻看，不会一直占着视线。",
                "The composer stays pinned to the bottom; history only appears when you scroll up.",
              )}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {activePack ? (
            <ActionButton tone="secondary" onClick={() => setSelectedPackId(activePack.id)}>
              {localize(locale, "查看入口", "Open pack")}
            </ActionButton>
          ) : null}
          <ActionButton tone="secondary" onClick={startNewConversation}>
            <MessageSquarePlus className="mr-2 h-4 w-4" />
            {localize(locale, "新对话", "New Conversation")}
          </ActionButton>
          {messages.length > 0 ? (
            <ActionButton tone="secondary" onClick={() => {
              if (window.confirm(localize(locale, "确定清空所有对话记录吗？", "Are you sure you want to clear all chat history?"))) {
                clearHistory();
              }
            }}>
              <Trash2 className="mr-2 h-4 w-4" />
              {localize(locale, "清空", "Clear")}
            </ActionButton>
          ) : null}
        </div>
      </section>

      <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[30px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] shadow-[var(--shadow-floating)]">
        {showTopFade ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-16"
            style={{
              background:
                "linear-gradient(180deg, var(--color-bg-surface) 0%, color-mix(in srgb, var(--color-bg-surface) 82%, transparent) 46%, transparent 100%)",
            }}
          />
        ) : null}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div className="flex min-h-full flex-col">
            {messages.length === 0 ? (
              <div className="mt-auto space-y-5">
                <div className="max-w-2xl">
                  <p className="text-base leading-7 text-[color:var(--color-text-secondary)]">
                    {localize(
                      locale,
                      "从这里开始直接对话。输入需求后，Friday 会像标准聊天框一样把最新对话贴在底部，旧记录留在上面按需翻看。",
                      "Start here directly. Once you type a task, Friday keeps the latest exchange pinned near the bottom while older history stays above on scroll.",
                    )}
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  {examplePrompts.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => setDraftText(prompt)}
                      className="rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-2 text-left text-sm text-[color:var(--color-text-primary)] transition hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg-surface-strong)]"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>

                {pinnedPacks.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {pinnedPacks.map((pack) => (
                      <button
                        key={pack.id}
                        type="button"
                        onClick={() => setSelectedPackId(pack.id)}
                        className="inline-flex min-h-[40px] items-center rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 text-sm text-[color:var(--color-text-primary)] transition hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg-surface-strong)]"
                      >
                        {pack.icon ? <pack.icon className="mr-2 h-4 w-4 text-[color:var(--color-accent)]" /> : null}
                        {locale === "zh" ? pack.title.zh : pack.title.en}
                      </button>
                    ))}
                  </div>
                ) : null}

                <button
                  type="button"
                  onClick={() => navigate("/packs")}
                  className="inline-flex min-h-[40px] items-center gap-2 rounded-full text-sm font-medium text-[color:var(--color-text-secondary)] transition hover:text-[color:var(--color-text-primary)]"
                >
                  {localize(locale, "打开行业与任务库", "Open Industry & Tasks")}
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div className="mt-auto space-y-4">
                {messages.map((msg) => {
                  const { cleanText, actions } = msg.role === "assistant" && msg.status === "done" && msg.content
                    ? parseActionsFromText(msg.content)
                    : { cleanText: msg.content, actions: [] };

                  return (
                    <div key={msg.id} className="space-y-2">
                      <ChatMessageBubble
                        message={msg.role === "assistant" && msg.status === "done"
                          ? { ...msg, content: cleanText }
                          : msg}
                        streamingText={
                          msg.status === "streaming"
                            ? runEvents.outputText
                            : undefined
                        }
                        onRetry={msg.role === "assistant" ? () => handleRetry(msg.id) : undefined}
                      />
                      {actions.length > 0 ? <ChatActionCard actions={actions} /> : null}
                    </div>
                  );
                })}

                {isStreaming && runEvents.toolCalls.length > 0 ? (
                  <ChatToolActivity
                    toolCalls={runEvents.toolCalls}
                    activeTool={runEvents.progress.activeTool}
                  />
                ) : null}

                {runEvents.autonomousGoal ? (
                  <AutonomousStepIndicator goal={runEvents.autonomousGoal} locale={locale} />
                ) : null}

                {isStreaming && streamingActions.length > 0 ? <ChatActionCard actions={streamingActions} /> : null}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="shrink-0 border-t border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-base)] px-4 py-4">
          {activePack ? (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-[color:var(--color-text-secondary)]">
              <span className="rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-2.5 py-1">
                {activePackTitle}
              </span>
              <span>
                {localize(locale, "当前消息会继续使用这个入口的上下文。", "Messages here continue with this pack's context.")}
              </span>
              <button
                type="button"
                onClick={() => navigate(buildPackAssistantHref(activePack.id))}
                className="text-[color:var(--color-accent)] transition hover:opacity-80"
              >
                {localize(locale, "去 Assistant", "Open Assistant")}
              </button>
            </div>
          ) : null}

          <ChatInput
            onSend={handleSend}
            onCommand={handleCommand}
            disabled={isStreaming}
            autoFocus
            value={draftText}
            onValueChange={setDraftText}
            placeholder={isStreaming ? localize(locale, "Friday 正在处理…", "Friday is working…") : undefined}
          />
        </div>
      </section>

      <PackQuickSheet
        open={Boolean(selectedPack)}
        pack={selectedPack}
        onClose={() => setSelectedPackId(null)}
        onStartNow={() => {
          setSelectedPackId(null);
          if (selectedPack) {
            void startPackNow(selectedPack);
          }
        }}
        onAdjustBeforeStart={() => {
          setSelectedPackId(null);
          if (selectedPack) {
            adjustPackBeforeStart(selectedPack);
          }
        }}
        onOpenSkill={(skillId) => {
          setSelectedPackId(null);
          navigate(buildSkillHref(skillId));
        }}
        onAskFriday={(prompt) => {
          if (selectedPack) {
            setSearchParams((prev) => {
              const next = new URLSearchParams(prev);
              next.set("packId", selectedPack.id);
              return next;
            }, { replace: true });
          }
          setSelectedPackId(null);
          setDraftText(prompt);
        }}
        onOpenAssistant={selectedPack ? () => {
          setSelectedPackId(null);
          setPendingPackPath(buildPackAssistantHref(selectedPack.id));
        } : undefined}
      />
    </div>
  );
}

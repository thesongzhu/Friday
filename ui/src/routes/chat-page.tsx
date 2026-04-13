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
import { PackAssistantHandoffCard } from "@/components/packs/pack-assistant-handoff-card";
import { PackQuickSheet } from "@/components/packs/pack-quick-sheet";
import { useAppNavigate } from "@/hooks/use-app-navigate";
import { useHomeSurfacePreferences } from "@/hooks/use-home-surface-preferences";
import { useUserProfile } from "@/hooks/use-user-profile";
import { localize } from "@/lib/i18n/localized-text";
import { buildPackAssistantHref, buildPackFlowHref } from "@/lib/packs/pack-links";
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
  const [searchParams, setSearchParams] = useSearchParams();
  const packIdParam = searchParams.get("packId");
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
  const [pendingPackPath, setPendingPackPath] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
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
  const activePack = packIdParam ? getPackById(packIdParam) ?? null : null;

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
      .map((packId) => getPackById(packId))
      .filter((pack): pack is NonNullable<ReturnType<typeof getPackById>> => Boolean(pack))
      .slice(0, 4),
    [pinnedPackIds],
  );
  const selectedPack = selectedPackId ? getPackById(selectedPackId) ?? null : null;

  return (
    <div className="flex min-h-[calc(100vh-10rem)] flex-col gap-4">
      <section className="rounded-[30px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-5 py-5 shadow-[var(--shadow-floating)]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
              {localize(locale, "聊天入口", "Chat")}
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
              {localize(locale, "最快开始一个新任务", "Start a task in one message")}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[color:var(--color-text-secondary)]">
              {localize(
                locale,
                "直接说你要完成什么。需要结构化入口时，再点下面这些固定的行业与任务包。",
                "Tell Friday what you need. Use the pinned packs below when you want a more guided starting point.",
              )}
            </p>
          </div>
          {messages.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {sessionUsage && sessionUsage.totalRuns > 0 ? (
                <span className="inline-flex min-h-[44px] items-center rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 text-sm text-[color:var(--color-text-secondary)]">
                  {formatUsage(sessionUsage, locale)}
                </span>
              ) : null}
              <ActionButton tone="secondary" onClick={startNewConversation}>
                <MessageSquarePlus className="mr-2 h-4 w-4" />
                {localize(locale, "新对话", "New Conversation")}
              </ActionButton>
              <ActionButton tone="secondary" onClick={() => {
                if (window.confirm(localize(locale, "确定清空所有对话记录吗？", "Are you sure you want to clear all chat history?"))) {
                  clearHistory();
                }
              }}>
                <Trash2 className="mr-2 h-4 w-4" />
                {localize(locale, "清空", "Clear")}
              </ActionButton>
            </div>
          ) : null}
        </div>

        {pinnedPacks.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {pinnedPacks.map((pack) => (
              <button
                key={pack.id}
                type="button"
                onClick={() => setSelectedPackId(pack.id)}
                className="inline-flex min-h-[44px] items-center rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 text-sm text-[color:var(--color-text-primary)] transition hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg-surface-strong)]"
              >
                {pack.icon ? <pack.icon className="mr-2 h-4 w-4 text-[color:var(--color-accent)]" /> : null}
                {locale === "zh" ? pack.title.zh : pack.title.en}
              </button>
            ))}
          </div>
        ) : null}
      </section>

      {activePack?.productCopy ? (
        <PackAssistantHandoffCard
          pack={activePack}
          compact
          onUsePrompt={(prompt) => setDraftText(prompt.prompt[locale])}
          onOpenAssistant={() => navigate(buildPackAssistantHref(activePack.id))}
        />
      ) : null}

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="flex h-full min-h-[360px] flex-col justify-center rounded-[30px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-6 py-6 text-center shadow-[var(--shadow-floating)]">
            <p className="mx-auto max-w-2xl text-base leading-7 text-[color:var(--color-text-secondary)]">
              {localize(
                locale,
                "例如：帮我整理这周要推进的事情；把这份材料变成周会摘要；看看这个问题现在应该先处理哪一步。",
                "For example: organize what I should push this week; turn these notes into a weekly summary; tell me what to do next about this issue.",
              )}
            </p>
            <div className="mt-5 flex justify-center">
              <button
                type="button"
                onClick={() => navigate("/packs")}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-full text-sm font-medium text-[color:var(--color-text-secondary)] transition hover:text-[color:var(--color-text-primary)]"
              >
                {localize(locale, "打开行业与任务库", "Open Industry & Tasks")}
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-1">
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

      <ChatInput
        onSend={handleSend}
        onCommand={handleCommand}
        disabled={isStreaming}
        autoFocus
        value={draftText}
        onValueChange={setDraftText}
        placeholder={isStreaming ? localize(locale, "Friday 正在处理…", "Friday is working…") : undefined}
      />

      <PackQuickSheet
        open={Boolean(selectedPack)}
        pack={selectedPack}
        onClose={() => setSelectedPackId(null)}
        onStartNow={() => {
          setSelectedPackId(null);
          if (selectedPack) {
            setPendingPackPath(buildPackFlowHref(selectedPack));
          }
        }}
        onAdjustBeforeStart={() => {
          setSelectedPackId(null);
          if (selectedPack) {
            setPendingPackPath(buildPackFlowHref(selectedPack, { mode: "adjust" }));
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

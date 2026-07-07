import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Database, HelpCircle, MessageSquarePlus, ShieldCheck, Trash2, X } from "lucide-react";
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
import {
  buildChannelChatHandoffTaskPrompt,
  clearPendingChannelChatHandoff,
  readPendingChannelChatHandoff,
  type FridayChannelChatHandoffPayload,
} from "@/lib/chat/channel-handoff";
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

function ChatProofPreviews() {
  return (
    <div className="space-y-3">
      <div
        data-ui-component="chat-approval-proof-card"
        data-cap="security_approval_bound_principal_gate_cat10_netnew"
        data-truth="wired_registry"
        className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4"
      >
        <div className="flex items-center gap-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
          <ShieldCheck className="h-4 w-4 text-[color:var(--color-accent)]" />
          Approval proof
        </div>
        <p className="mt-2 font-mono text-xs text-[color:var(--color-text-secondary)]">
          command digest + reviewer proof + bound principal gate. wired_registry !== runtime PASS.
        </p>
      </div>
      <div
        data-ui-component="chat-memory-candidate-card"
        data-cap="memory_review_no_silent_write_decide_candidate"
        data-truth="wired_registry"
        className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4"
      >
        <div className="flex items-center gap-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
          <Database className="h-4 w-4 text-[color:var(--color-accent)]" />
          Memory candidate
        </div>
        <p className="mt-2 font-mono text-xs text-[color:var(--color-text-secondary)]">
          no silent write; keep/edit/reject must go through memory_review_no_silent_write_decide_candidate.
        </p>
      </div>
      <div
        data-ui-component="chat-clarify-card"
        data-cap="agent_loop_planning_clarify_approval_dangerous_action"
        data-truth="wired_registry"
        className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4"
      >
        <div className="flex items-center gap-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
          <HelpCircle className="h-4 w-4 text-[color:var(--color-accent)]" />
          Clarify before risky action
        </div>
        <p className="mt-2 font-mono text-xs text-[color:var(--color-text-secondary)]">
          agent_loop_planning_clarify_approval_dangerous_action asks before destructive targets or unclear intent.
        </p>
      </div>
    </div>
  );
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
  const [pendingHandoff, setPendingHandoff] = useState<FridayChannelChatHandoffPayload | null>(null);
  const {
    messages,
    sessionKey,
    runEvents,
    sendMessage,
    isStreaming,
    queuedMessageCount,
    clearHistory,
    startNewConversation,
  } = useChatSession({ packId: packIdParam });

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const lastCompletedMessageIdRef = useRef<string | null>(null);
  const appliedFreshHandoffRef = useRef<string | null>(null);
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
    const handoffId = searchParams.get("handoff")?.trim();
    if (!handoffId) {
      setPendingHandoff(null);
      return;
    }
    setPendingHandoff(readPendingChannelChatHandoff(handoffId));
  }, [searchParams]);

  useEffect(() => {
    const handoffId = searchParams.get("handoff")?.trim();
    const shouldFreshOpen = searchParams.get("fresh") === "1";
    if (!handoffId || !shouldFreshOpen || appliedFreshHandoffRef.current === handoffId) {
      return;
    }
    appliedFreshHandoffRef.current = handoffId;
    startNewConversation();
  }, [searchParams, startNewConversation]);

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

  const clearActiveHandoff = useCallback(() => {
    const handoffId = pendingHandoff?.id ?? searchParams.get("handoff");
    clearPendingChannelChatHandoff(handoffId);
    setPendingHandoff(null);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("handoff");
      next.delete("fresh");
      return next;
    }, { replace: true });
  }, [pendingHandoff?.id, searchParams, setSearchParams]);

  const sendFromChat = useCallback((text: string) => {
    const taskPrompt = pendingHandoff
      ? buildChannelChatHandoffTaskPrompt(pendingHandoff, text, locale)
      : undefined;
    void sendMessage(text, {
      taskPrompt,
      onAccepted: pendingHandoff ? clearActiveHandoff : undefined,
    });
  }, [clearActiveHandoff, locale, pendingHandoff, sendMessage]);

  const handleSend = useCallback((text: string) => {
    setDraftText("");
    sendFromChat(text);
  }, [sendFromChat]);

  const handleRetry = useCallback((assistantMsgId: string) => {
    const idx = messages.findIndex((m) => m.id === assistantMsgId);
    if (idx < 1) return;
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i]!.role === "user") {
        sendFromChat(messages[i]!.content);
        return;
      }
    }
  }, [messages, sendFromChat]);

  const handleCommand = useCallback((commandId: string) => {
    switch (commandId) {
      case "new":
        clearActiveHandoff();
        startNewConversation();
        break;
      case "clear":
        clearActiveHandoff();
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
        sendFromChat(
          locale === "zh"
            ? "请列出所有可用的斜杠命令及其用途。"
            : "Please list all available slash commands and what they do.",
        );
        break;
    }
  }, [clearActiveHandoff, startNewConversation, clearHistory, navigate, sendFromChat, locale]);

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
    <div data-ui-screen="desktop-friday-chat" className="flex h-full min-h-0 flex-col gap-3">
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
          <p className="mt-2 text-xs font-medium text-[color:var(--color-text-tertiary)]">
            one workbench area, not chat-first · private by default · ask_friday_chat_compose_send wired_registry !== runtime PASS
          </p>
          {pendingHandoff ? (
            <div className="mt-3 rounded-[20px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">
                    {localize(locale, "继续来源", "Continuation source")}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-[color:var(--color-text-primary)]">
                    {pendingHandoff.sourceChannel} · {pendingHandoff.sourceDisplayName}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-[color:var(--color-text-secondary)]">
                    {localize(
                      locale,
                      "这会打开一条新的主聊天线，只带入摘要与最近锚点，不自动合并完整渠道历史。",
                      "This opens a fresh main-chat thread and carries over only a summary plus recent anchors, not the full channel history.",
                    )}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <ActionButton tone="secondary" onClick={() => navigate(`/channels?sessionKey=${encodeURIComponent(pendingHandoff.sourceSessionKey)}`)}>
                    {localize(locale, "查看原会话", "Open source thread")}
                  </ActionButton>
                  <ActionButton tone="secondary" onClick={clearActiveHandoff}>
                    <X className="mr-2 h-4 w-4" />
                    {localize(locale, "关闭来源", "Dismiss source")}
                  </ActionButton>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-[color:var(--color-text-secondary)]">
                {pendingHandoff.topicSummary ? (
                  <span className="rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-2.5 py-1">
                    {localize(locale, "主题", "Topic")}: {pendingHandoff.topicSummary}
                  </span>
                ) : null}
                <span className="rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-2.5 py-1">
                  {localize(locale, "消息", "Messages")}: {pendingHandoff.sourceMessageCount}
                </span>
                <span className="rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-2.5 py-1">
                  {localize(locale, "默认隔离", "Isolation")}: {localize(locale, "不自动合并", "No auto merge")}
                </span>
              </div>
              {pendingHandoff.latestUserMessage ? (
                <p className="mt-3 text-sm leading-6 text-[color:var(--color-text-secondary)]">
                  <span className="font-medium text-[color:var(--color-text-primary)]">
                    {localize(locale, "最近用户消息", "Latest user message")}:
                  </span>
                  {" "}
                  {pendingHandoff.latestUserMessage}
                </p>
              ) : null}
            </div>
          ) : null}
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

      <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section data-ui-component="friday-chat-workbench" className="relative flex min-h-0 flex-col overflow-hidden rounded-[30px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] shadow-[var(--shadow-floating)]">
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

                <ChatProofPreviews />

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

        <div
          data-ui-component="friday-chat-sticky-composer"
          data-action="send_to_friday"
          data-cap="ask_friday_chat_compose_send"
          data-truth="wired_registry"
          className="shrink-0 border-t border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-base)] px-4 py-4"
        >
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
          {pendingHandoff ? (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-[color:var(--color-text-secondary)]">
              <span className="rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-2.5 py-1">
                {pendingHandoff.sourceChannel} · {pendingHandoff.sourceDisplayName}
              </span>
              <span>
                {localize(
                  locale,
                  "首次发送会带入这条渠道会话的摘要，不会自动并入完整历史。",
                  "The first send carries a summary of this channel thread and does not merge the full history.",
                )}
              </span>
            </div>
          ) : null}

          <ChatInput
            onSend={handleSend}
            onCommand={handleCommand}
            disabled={false}
            autoFocus
            value={draftText}
            onValueChange={setDraftText}
            placeholder={isStreaming
              ? localize(locale, "继续输入，消息会排队发送", "Keep typing; messages will be queued")
              : undefined}
          />
          {queuedMessageCount > 0 ? (
            <p className="mt-2 px-1 text-xs text-[color:var(--color-text-secondary)]">
              {localize(locale, `已排队 ${queuedMessageCount} 条消息`, `${queuedMessageCount} message${queuedMessageCount === 1 ? "" : "s"} queued`)}
            </p>
          ) : null}
          <p className="mt-2 px-1 text-xs text-[color:var(--color-text-tertiary)]">
            Sent to Hub, not executed · Hub gate + ledger required before runtime proof.
          </p>
        </div>
        </section>
        <aside
          data-ui-component="friday-chat-inspector"
          className="hidden min-h-0 overflow-y-auto rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4 shadow-[var(--shadow-floating)] xl:block"
        >
          <h3 className="text-sm font-semibold text-[color:var(--color-text-primary)]">Proof inspector</h3>
          <div className="mt-3 space-y-3 text-xs text-[color:var(--color-text-secondary)]">
            <p className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-3">
              turn: Friday Chat · private by default · no provider leak before Friday routes the provider.
            </p>
            <p className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-3">
              ask_friday_chat_compose_send / wired_registry !== runtime PASS.
            </p>
            <p className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-3">
              Inline proof cards show approval, memory, and clarify gates as Hub truth surfaces, not completed execution.
            </p>
          </div>
        </aside>
      </div>

      <PackQuickSheet
        open={Boolean(selectedPack)}
        pack={selectedPack}
        onClose={() => setSelectedPackId(null)}
        onStartNow={() => {
          if (selectedPack) {
            void startPackNow(selectedPack);
          }
        }}
        onAdjustBeforeStart={() => {
          if (selectedPack) {
            adjustPackBeforeStart(selectedPack);
          }
        }}
        onOpenSkill={(skillId) => {
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
          setPendingPackPath(buildPackAssistantHref(selectedPack.id));
        } : undefined}
      />
    </div>
  );
}

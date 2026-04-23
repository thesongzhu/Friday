import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Radio, Send, Settings2, Wifi, WifiOff, MessageSquare, ChevronRight, X, Zap } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { ActionButton, StatusPill } from "@/components/core/primitives";
import { useAppNavigate } from "@/hooks/use-app-navigate";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
import { CHANNEL_META, CHANNEL_KINDS_ORDERED, getChannelDisplayName } from "@/lib/channels/channel-meta";
import { redactSecretLikeText } from "@/lib/security/redact-secrets";
import type { ChannelKind } from "@/lib/setup/types";
import type { FridaySessionRecord, FridaySessionMessageRecord, ChannelRegistryView } from "@/lib/api/types";
import { agentApi } from "@/lib/api/agent";
import { channelsApi } from "@/lib/api/channels";
import { sessionsApi } from "@/lib/api/sessions";
import { buildChannelChatHandoffPayload, writePendingChannelChatHandoff } from "@/lib/chat/channel-handoff";
import { useAgentRunEvents } from "@/hooks/use-agent-run-events";
import {
  useChannelRegistryQuery,
  useChannelSessionsQuery,
  useSessionMessagesQuery,
  getSessionDisplayName,
  getSessionChannelKind,
} from "@/hooks/use-channel-sessions";

// ─── Status helpers ───

function channelStatusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "connected": return "success";
    case "connecting": return "warning";
    case "error": return "danger";
    default: return "neutral";
  }
}

function channelStatusLabel(status: string, locale: "zh" | "en"): string {
  switch (status) {
    case "connected": return localize(locale, "已连接", "Connected");
    case "connecting": return localize(locale, "连接中", "Connecting");
    case "error": return localize(locale, "错误", "Error");
    default: return localize(locale, "未连接", "Disconnected");
  }
}

function safeChannelName(kind: string, locale: "zh" | "en"): string {
  const meta = CHANNEL_META[kind as ChannelKind];
  return meta ? (locale === "zh" ? meta.nameZh : meta.name) : kind;
}

function safeChannelEmoji(kind: string): string {
  const meta = CHANNEL_META[kind as ChannelKind];
  return meta?.emoji ?? "💬";
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    if (diffMs < 60_000) return "just now";
    if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
    if (diffMs < 86400_000) return `${Math.floor(diffMs / 3600_000)}h ago`;
    return d.toLocaleDateString();
  } catch {
    return "";
  }
}

// ─── Main component ───

export function ChannelsPage() {
  const { locale } = useAppLocale();
  const navigate = useAppNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: registry = [] } = useChannelRegistryQuery();
  const [filterChannel, setFilterChannel] = useState<string>("all");
  const [selectedSessionKey, setSelectedSessionKey] = useState<string | null>(() => searchParams.get("sessionKey"));

  // Reply state
  const [replyText, setReplyText] = useState("");
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isOutboundSending, setIsOutboundSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Persona panel state
  const [showPersonaPanel, setShowPersonaPanel] = useState(false);
  const [personaText, setPersonaText] = useState("");
  const [systemPromptText, setSystemPromptText] = useState("");
  const [personaSaving, setPersonaSaving] = useState(false);
  const [personaChannelKind, setPersonaChannelKind] = useState<string | null>(null);

  const requestedSessionChannels = filterChannel === "all"
    ? registry.map((channel) => channel.kind)
    : filterChannel;
  const { data: sessions = [] } = useChannelSessionsQuery(requestedSessionChannels);
  const { data: messages = [], refetch: refetchMessages } = useSessionMessagesQuery(selectedSessionKey);

  useEffect(() => {
    const sessionKey = searchParams.get("sessionKey");
    setSelectedSessionKey(sessionKey);
  }, [searchParams]);

  // Streaming response for current reply
  const runEvents = useAgentRunEvents(currentRunId, {
    onTerminal: useCallback(() => {
      setCurrentRunId(null);
      setIsSending(false);
      // Refetch messages after a short delay to pick up the new response
      setTimeout(() => { void refetchMessages(); }, 500);
    }, [refetchMessages]),
  });

  const isStreaming = runEvents.connectionState === "streaming" || runEvents.connectionState === "connecting";

  // Auto-scroll when new messages or streaming text arrives
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, runEvents.outputText]);

  // Clear reply state when switching sessions
  useEffect(() => {
    setReplyText("");
    setCurrentRunId(null);
    setIsSending(false);
    setIsOutboundSending(false);
  }, [selectedSessionKey]);

  // Persona panel handlers
  async function openPersonaPanel(kind: string) {
    setPersonaChannelKind(kind);
    setShowPersonaPanel(true);
    try {
      const config = await channelsApi.getPersona(kind);
      setPersonaText(config?.persona ?? "");
      setSystemPromptText(config?.systemPrompt ?? "");
    } catch {
      setPersonaText("");
      setSystemPromptText("");
    }
  }

  async function handleSavePersona() {
    if (!personaChannelKind) return;
    setPersonaSaving(true);
    try {
      await channelsApi.updatePersona(personaChannelKind, {
        persona: personaText,
        systemPrompt: systemPromptText,
      });
      toast.success(localize(locale, "人设已保存", "Persona saved"));
      setShowPersonaPanel(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : localize(locale, "保存失败", "Failed to save"));
    } finally {
      setPersonaSaving(false);
    }
  }

  // Send reply handler
  async function handleSendOutbound() {
    const trimmed = replyText.trim();
    if (!trimmed || !selectedSessionKey || isOutboundSending || isSending) return;

    setIsOutboundSending(true);
    setReplyText("");

    try {
      const result = await sessionsApi.sendOutbound(selectedSessionKey, {
        text: trimmed,
        metadata: {
          uiSurface: "channels",
          operatorAction: "direct_channel_outbound",
        },
      });
      toast.success(localize(
        locale,
        `已发送到 ${safeChannelName(result.delivery.channel, locale)}`,
        `Sent to ${safeChannelName(result.delivery.channel, locale)}`,
      ));
      await refetchMessages();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : localize(locale, "渠道发送失败", "Channel send failed"));
    } finally {
      setIsOutboundSending(false);
    }
  }

  async function handleSendReply() {
    const trimmed = replyText.trim();
    if (!trimmed || !selectedSessionKey || isSending || isOutboundSending) return;

    setIsSending(true);
    setReplyText("");

    try {
      const result = await agentApi.startRun({
        task: trimmed,
        sessionKey: selectedSessionKey,
        executionContext: {
          surface: "channel",
          interactive: true,
        },
      });

      if (result.eventStreamAvailable) {
        setCurrentRunId(result.runId);
      } else {
        // No streaming — just refetch after a delay
        setIsSending(false);
        setTimeout(() => { void refetchMessages(); }, 1000);
      }
    } catch (err) {
      setIsSending(false);
      toast.error(err instanceof Error ? err.message : localize(locale, "发送失败", "Failed to send"));
    }
  }

  // Build a lookup for registry status
  const registryMap = new Map<string, ChannelRegistryView>();
  for (const ch of registry) {
    registryMap.set(ch.kind, ch);
  }
  const registeredChannelKinds = new Set(registry.map((channel) => channel.kind));

  const connectedChannels = registry.filter((ch) => ch.running);
  const selectedSession = sessions.find((s) => s.key === selectedSessionKey) ?? null;

  async function handleContinueToMainChat() {
    if (!selectedSession) {
      return;
    }

    try {
      const sourceMessages = messages.length > 0
        ? messages
        : await sessionsApi.listMessages(selectedSession.key, { limit: 12 });
      const handoff = buildChannelChatHandoffPayload({
        session: selectedSession,
        displayName: getSessionDisplayName(selectedSession),
        messages: sourceMessages,
      });
      const handoffId = writePendingChannelChatHandoff(handoff);
      navigate(`/chat?handoff=${encodeURIComponent(handoffId)}&fresh=1`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : localize(locale, "交接失败", "Failed to hand off"));
    }
  }

  // Only treat sessions as channel sessions when they belong to a registered channel kind.
  const channelSessions = sessions.filter((session) => registeredChannelKinds.has(getSessionChannelKind(session)));

  // Escalation detection: channels with errors or sessions that need attention
  const channelsWithErrors = registry.filter((ch) =>
    ch.health.state === "error"
    || ch.health.credentialStatus === "invalid"
    || ch.health.credentialStatus === "missing"
    || Boolean(ch.health.blockedReason),
  );
  const attentionCount = channelsWithErrors.length;

  return (
    <div className="flex h-[calc(100vh-120px)] flex-col gap-4 pb-4">
      {/* ── Header ── */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
          {localize(locale, "渠道", "Channels")}
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
          {localize(
            locale,
            "监控和管理 Friday 在各个平台上的对话。",
            "Monitor and manage Friday's conversations across platforms.",
          )}
        </p>
      </div>

      {/* ── Escalation banner ── */}
      {attentionCount > 0 && (
        <div className="flex items-center gap-3 rounded-2xl border border-[color:var(--color-danger-soft)] bg-[color:var(--color-danger-soft)] px-4 py-2.5">
          <AlertTriangle className="h-4 w-4 shrink-0 text-[color:var(--color-danger)]" />
          <p className="text-sm text-[color:var(--color-text-primary)]">
            {localize(
              locale,
              `${attentionCount} 个渠道需要关注`,
              `${attentionCount} channel${attentionCount > 1 ? "s" : ""} need${attentionCount === 1 ? "s" : ""} attention`,
            )}
            {" — "}
            {channelsWithErrors.map((ch) => `${safeChannelEmoji(ch.kind)} ${safeChannelName(ch.kind, locale)}`).join(", ")}
          </p>
        </div>
      )}

      {/* ── Channel status bar ── */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            setFilterChannel("all");
            setSelectedSessionKey(null);
            setSearchParams((prev) => {
              const next = new URLSearchParams(prev);
              next.delete("sessionKey");
              return next;
            }, { replace: true });
          }}
          className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 text-sm font-medium transition ${
            filterChannel === "all"
              ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]"
              : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] text-[color:var(--color-text-secondary)] hover:border-[color:var(--color-border-strong)]"
          }`}
        >
          <Radio className="h-3.5 w-3.5" />
          {localize(locale, "全部", "All")}
          {channelSessions.length > 0 && (
            <span className="ml-1 text-xs opacity-60">{channelSessions.length}</span>
          )}
        </button>
        {CHANNEL_KINDS_ORDERED.map((kind) => {
          const reg = registryMap.get(kind);
          if (!reg?.running) return null;
          const meta = CHANNEL_META[kind];
          const sessionCount = channelSessions.filter((s) => getSessionChannelKind(s) === kind).length;
          return (
            <button
              key={kind}
              type="button"
              onClick={() => { setFilterChannel(kind); setSelectedSessionKey(null); }}
              className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 text-sm font-medium transition ${
                filterChannel === kind
                  ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]"
                  : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] text-[color:var(--color-text-secondary)] hover:border-[color:var(--color-border-strong)]"
              }`}
            >
              <span className="text-sm">{meta.emoji}</span>
              {getChannelDisplayName(kind, locale)}
              {sessionCount > 0 && (
                <span className="ml-1 text-xs opacity-60">{sessionCount}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Connected channels overview (when no session selected) ── */}
      {!selectedSessionKey && connectedChannels.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {connectedChannels.map((ch) => {
            const meta = CHANNEL_META[ch.kind as ChannelKind];
            if (!meta) return null;
            return (
              <div
                key={ch.kind}
                className="flex items-center gap-3 rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-3"
              >
                <span className="text-xl">{meta.emoji}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">
                    {getChannelDisplayName(ch.kind as ChannelKind, locale)}
                  </p>
                  <div className="mt-0.5 flex items-center gap-2">
                    <StatusPill tone={channelStatusTone(ch.status)}>
                      {channelStatusLabel(ch.status, locale)}
                    </StatusPill>
                    {ch.health.restartCount > 0 && (
                      <span className="text-[10px] text-[color:var(--color-text-faint)]">
                        {localize(locale, `重启 ${ch.health.restartCount} 次`, `${ch.health.restartCount} restarts`)}
                      </span>
                    )}
                  </div>
                </div>
                {ch.status === "connected" ? (
                  <Wifi className="h-4 w-4 text-[color:var(--color-positive)]" />
                ) : (
                  <WifiOff className="h-4 w-4 text-[color:var(--color-text-faint)]" />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Main content: session list + message viewer ── */}
      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
        {/* Session list */}
        <div className="w-80 shrink-0 overflow-y-auto rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)]">
          {channelSessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
              <MessageSquare className="mb-3 h-8 w-8 text-[color:var(--color-text-faint)]" />
              <p className="text-sm font-medium text-[color:var(--color-text-secondary)]">
                {localize(locale, "暂无会话", "No conversations yet")}
              </p>
              <p className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">
                {localize(
                  locale,
                  "当有人通过连接的渠道发送消息时，对话会出现在这里。",
                  "Conversations will appear here when someone messages through a connected channel.",
                )}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-[color:var(--color-border-soft)]">
              {channelSessions.map((session) => {
                const chKind = getSessionChannelKind(session);
                const isActive = session.key === selectedSessionKey;
                const chRegistry = registryMap.get(chKind);
                const needsAttention = chRegistry?.health.state === "error" || chRegistry?.health.credentialStatus === "invalid";
                return (
                  <button
                    key={session.key}
                    type="button"
                    onClick={() => {
                      setSelectedSessionKey(session.key);
                      setSearchParams((prev) => {
                        const next = new URLSearchParams(prev);
                        next.set("sessionKey", session.key);
                        return next;
                      }, { replace: true });
                    }}
                    className={`flex w-full items-center gap-3 px-4 py-3 text-left transition ${
                      isActive
                        ? "bg-[color:var(--color-accent-soft)]"
                        : needsAttention
                          ? "bg-red-50/50"
                          : "hover:bg-[color:var(--color-bg-subtle)]"
                    }`}
                  >
                    <span className="relative text-lg">
                      {safeChannelEmoji(chKind)}
                      {needsAttention && (
                        <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-red-500" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-[color:var(--color-text-primary)]">
                        {getSessionDisplayName(session)}
                      </p>
                      <div className="mt-0.5 flex items-center gap-2">
                        <span className="text-[10px] text-[color:var(--color-text-faint)]">
                          {safeChannelName(chKind, locale)}
                        </span>
                        <span className="text-[10px] text-[color:var(--color-text-faint)]">
                          {session.messageCount} {localize(locale, "条消息", "msgs")}
                        </span>
                        {session.lastActivityAt && (
                          <span className="text-[10px] text-[color:var(--color-text-faint)]">
                            {formatTime(session.lastActivityAt)}
                          </span>
                        )}
                      </div>
                    </div>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[color:var(--color-text-faint)]" />
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Message viewer */}
        <div className="flex min-w-0 flex-1 flex-col rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)]">
          {selectedSession ? (
            <>
              {/* Session header */}
              <div className="flex items-center gap-3 border-b border-[color:var(--color-border-soft)] px-5 py-3">
                <span className="text-lg">
                  {safeChannelEmoji(getSessionChannelKind(selectedSession))}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">
                    {getSessionDisplayName(selectedSession)}
                  </p>
                  <p className="text-[11px] text-[color:var(--color-text-faint)]">
                    {safeChannelName(getSessionChannelKind(selectedSession), locale)}
                    {" · "}
                    {selectedSession.chatKind === "dm"
                      ? localize(locale, "私信", "Direct Message")
                      : localize(locale, "群组", "Group")}
                    {" · "}
                    {selectedSession.messageCount} {localize(locale, "条消息", "messages")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => openPersonaPanel(getSessionChannelKind(selectedSession))}
                  className="mr-2 flex h-8 w-8 items-center justify-center rounded-lg text-[color:var(--color-text-tertiary)] transition hover:bg-[color:var(--color-bg-subtle)] hover:text-[color:var(--color-text-primary)]"
                  title={localize(locale, "渠道人设配置", "Channel persona settings")}
                >
                  <Settings2 className="h-4 w-4" />
                </button>
                <StatusPill tone={selectedSession.status === "active" ? "success" : "neutral"}>
                  {selectedSession.status}
                </StatusPill>
              </div>

              <div className="border-b border-[color:var(--color-border-soft)] px-5 py-3">
                <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">
                        {localize(locale, "渠道上下文", "Channel context")}
                      </p>
                      <p className="mt-1 text-sm leading-6 text-[color:var(--color-text-secondary)]">
                        {localize(
                          locale,
                          `这里的回复会继续留在 ${safeChannelName(getSessionChannelKind(selectedSession), locale)}，默认不会自动并到主聊天。`,
                          `Replies here stay in ${safeChannelName(getSessionChannelKind(selectedSession), locale)} and do not automatically merge into main chat.`,
                        )}
                      </p>
                    </div>
                    <ActionButton tone="secondary" onClick={() => void handleContinueToMainChat()}>
                      {localize(locale, "继续到主聊天", "Continue in main chat")}
                    </ActionButton>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-[color:var(--color-text-secondary)]">
                    <span className="rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-2.5 py-1">
                      {localize(locale, "默认行为", "Default")}: {localize(locale, "隔离上下文", "Isolated context")}
                    </span>
                    <span className="rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-2.5 py-1">
                      {localize(locale, "手动继续", "Manual continue")}: {localize(locale, "只带摘要", "Summary only")}
                    </span>
                  </div>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto px-5 py-4">
                {messages.length === 0 && !isStreaming ? (
                  <p className="text-center text-sm text-[color:var(--color-text-tertiary)]">
                    {localize(locale, "暂无消息", "No messages yet")}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {messages.map((msg) => (
                      <MessageBubble key={msg.id} message={msg} locale={locale} />
                    ))}
                    {/* Streaming response */}
                    {isStreaming && runEvents.outputText && (
                      <div className="flex justify-start">
                        <div className="max-w-[75%] rounded-2xl bg-[color:var(--color-bg-subtle)] px-4 py-2.5 text-[color:var(--color-text-primary)]">
                          <p className="mb-1 text-[10px] font-medium text-[color:var(--color-accent)]">
                            Friday
                            <span className="ml-2 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[color:var(--color-accent)]" />
                          </p>
                          <p className="whitespace-pre-wrap text-sm leading-relaxed">{redactSecretLikeText(runEvents.outputText)}</p>
                        </div>
                      </div>
                    )}
                    {isStreaming && !runEvents.outputText && (
                      <div className="flex justify-start">
                        <div className="rounded-2xl bg-[color:var(--color-bg-subtle)] px-4 py-2.5">
                          <p className="text-xs text-[color:var(--color-text-tertiary)]">
                            {localize(locale, "Friday 正在思考...", "Friday is thinking...")}
                            <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[color:var(--color-accent)]" />
                          </p>
                        </div>
                      </div>
                    )}
                    <div ref={messagesEndRef} />
                  </div>
                )}
              </div>

              {/* Reply input */}
              <div className="border-t border-[color:var(--color-border-soft)] px-4 py-3">
                <div className="flex items-end gap-2">
                  <textarea
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void handleSendOutbound();
                      }
                    }}
                    placeholder={localize(
                      locale,
                      "输入要发到渠道的消息...",
                      "Type a message to send to the channel...",
                    )}
                    disabled={isSending || isOutboundSending}
                    rows={1}
                    className="min-h-[40px] max-h-[120px] flex-1 resize-none rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2.5 text-sm text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-faint)] focus:border-[color:var(--color-accent)] focus:outline-none disabled:opacity-50"
                  />
                  <ActionButton
                    tone="secondary"
                    onClick={() => void handleSendReply()}
                    disabled={!replyText.trim() || isSending || isOutboundSending}
                  >
                    {isSending
                      ? localize(locale, "处理中", "Running")
                      : localize(locale, "让 Friday 处理", "Ask Friday")}
                  </ActionButton>
                  <button
                    type="button"
                    onClick={() => void handleSendOutbound()}
                    disabled={!replyText.trim() || isSending || isOutboundSending}
                    title={localize(locale, "直接发送到渠道", "Send directly to channel")}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[color:var(--color-accent)] text-white transition hover:opacity-90 disabled:opacity-40"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                </div>
                <div className="mt-1.5 flex items-center gap-1.5 px-1">
                  <Zap className="h-3 w-3 text-[color:var(--color-accent)]" />
                  <p className="text-[10px] text-[color:var(--color-text-faint)]">
                    {localize(
                      locale,
                      `发送按钮会直接发到 ${safeChannelName(getSessionChannelKind(selectedSession), locale)}；“让 Friday 处理”会在同一渠道会话里启动一次真实 run。主聊天默认不会自动合并这条线。`,
                      `Send delivers directly to ${safeChannelName(getSessionChannelKind(selectedSession), locale)}; "Ask Friday" starts a real run in this channel session. Main chat does not auto-merge this thread.`,
                    )}
                  </p>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
              <Radio className="mb-3 h-10 w-10 text-[color:var(--color-text-faint)]" />
              <p className="text-sm font-medium text-[color:var(--color-text-secondary)]">
                {localize(locale, "选择一个会话查看消息", "Select a conversation to view messages")}
              </p>
              <p className="mt-1 max-w-sm text-xs text-[color:var(--color-text-tertiary)]">
                {localize(
                  locale,
                  "Friday 会自动回复来自所有连接渠道的消息。你可以在这里监控所有对话。",
                  "Friday auto-replies to messages from all connected channels. You can monitor all conversations here.",
                )}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── No channels connected state ── */}
      {connectedChannels.length === 0 && channelSessions.length === 0 && (
        <div className="rounded-2xl border border-dashed border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-subtle)] px-6 py-8 text-center">
          <WifiOff className="mx-auto mb-3 h-8 w-8 text-[color:var(--color-text-faint)]" />
          <p className="text-sm font-medium text-[color:var(--color-text-secondary)]">
            {localize(locale, "尚未连接任何渠道", "No channels connected")}
          </p>
          <p className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">
            {localize(
              locale,
              "前往设置页面连接 Discord、Telegram、Slack 等渠道。",
              "Go to Settings to connect Discord, Telegram, Slack, and more.",
            )}
          </p>
        </div>
      )}

      {/* ── Persona configuration panel ── */}
      {showPersonaPanel && personaChannelKind && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/20" onClick={() => setShowPersonaPanel(false)} />
          <div className="relative w-full max-w-md bg-[color:var(--color-bg-surface)] shadow-xl">
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between border-b border-[color:var(--color-border-soft)] px-5 py-4">
                <div>
                  <h2 className="text-base font-semibold text-[color:var(--color-text-primary)]">
                    {localize(locale, "渠道人设配置", "Channel Persona")}
                  </h2>
                  <p className="mt-0.5 text-xs text-[color:var(--color-text-tertiary)]">
                    {safeChannelEmoji(personaChannelKind)} {safeChannelName(personaChannelKind, locale)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowPersonaPanel(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-[color:var(--color-text-tertiary)] hover:bg-[color:var(--color-bg-subtle)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-[color:var(--color-text-primary)]">
                    {localize(locale, "角色描述", "Role Description")}
                  </label>
                  <p className="mb-2 text-xs text-[color:var(--color-text-tertiary)]">
                    {localize(
                      locale,
                      "简短描述 Friday 在这个渠道上的角色。例如：你是一个专业的电商客服，语气友好专业。",
                      "Briefly describe Friday's role on this channel. e.g., \"You are a professional e-commerce customer service agent.\"",
                    )}
                  </p>
                  <textarea
                    value={personaText}
                    onChange={(e) => setPersonaText(e.target.value)}
                    rows={3}
                    placeholder={localize(
                      locale,
                      "例如：你是一个专业的电商客服，语气友好专业，回答简洁明了。",
                      "e.g., You are a professional customer service agent. Be friendly and concise.",
                    )}
                    className="w-full resize-none rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2.5 text-sm text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-faint)] focus:border-[color:var(--color-accent)] focus:outline-none"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-[color:var(--color-text-primary)]">
                    {localize(locale, "系统提示词（高级）", "System Prompt (Advanced)")}
                  </label>
                  <p className="mb-2 text-xs text-[color:var(--color-text-tertiary)]">
                    {localize(
                      locale,
                      "完整的系统提示词，会覆盖角色描述。留空则使用上面的角色描述。",
                      "Full system prompt override. Leave empty to use the role description above.",
                    )}
                  </p>
                  <textarea
                    value={systemPromptText}
                    onChange={(e) => setSystemPromptText(e.target.value)}
                    rows={6}
                    placeholder={localize(
                      locale,
                      "留空即可，角色描述通常已足够...",
                      "Leave empty — the role description is usually sufficient...",
                    )}
                    className="w-full resize-none rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2.5 text-sm text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-faint)] focus:border-[color:var(--color-accent)] focus:outline-none"
                  />
                </div>
              </div>

              <div className="border-t border-[color:var(--color-border-soft)] px-5 py-4">
                <ActionButton
                  onClick={() => void handleSavePersona()}
                  disabled={personaSaving}
                  className="w-full"
                >
                  {personaSaving
                    ? localize(locale, "保存中...", "Saving...")
                    : localize(locale, "保存人设", "Save Persona")}
                </ActionButton>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Message bubble ───

function MessageBubble({ message, locale }: { message: FridaySessionMessageRecord; locale: "zh" | "en" }) {
  const isAssistant = message.role === "assistant";
  const rawText = message.contentText || (typeof message.content === "string" ? message.content : JSON.stringify(message.content));
  const text = redactSecretLikeText(rawText);
  const time = message.occurredAt ? formatTime(message.occurredAt) : "";

  return (
    <div className={`flex ${isAssistant ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-2.5 ${
          isAssistant
            ? "bg-[color:var(--color-bg-subtle)] text-[color:var(--color-text-primary)]"
            : "bg-[color:var(--color-accent)] text-white"
        }`}
      >
        {!isAssistant && (
          <p className="mb-1 text-[10px] font-medium opacity-70">
            {(message.metadata as Record<string, string>)?.senderName ?? localize(locale, "用户", "User")}
          </p>
        )}
        {isAssistant && (
          <p className="mb-1 text-[10px] font-medium text-[color:var(--color-accent)]">
            Friday
          </p>
        )}
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{text}</p>
        {time && (
          <p className={`mt-1 text-[10px] ${isAssistant ? "text-[color:var(--color-text-faint)]" : "opacity-60"}`}>
            {time}
          </p>
        )}
      </div>
    </div>
  );
}

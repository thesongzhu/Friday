import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, MessageSquarePlus, Trash2 } from "lucide-react";
import { useChatSession } from "@/hooks/use-chat-session";
import { ChatMessageBubble } from "@/components/chat/chat-message";
import { ChatInput } from "@/components/chat/chat-input";
import { ChatToolActivity } from "@/components/chat/chat-tool-activity";
import { ChatActionCard, parseActionsFromText } from "@/components/chat/chat-action-card";
import { sessionsApi, type SessionUsageResponse } from "@/lib/api/sessions";

export function ChatPage() {
  const {
    messages,
    runEvents,
    sendMessage,
    isStreaming,
    clearHistory,
    startNewConversation,
  } = useChatSession();

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [sessionUsage, setSessionUsage] = useState<SessionUsageResponse | null>(null);
  const sessionKeyRef = useRef<string | null>(null);

  // Fetch session usage after each completed run
  useEffect(() => {
    // Get session key from localStorage (same source as useChatSession)
    const key = localStorage.getItem("friday-chat-session-key");
    if (!key || key === sessionKeyRef.current && sessionUsage) return;
    sessionKeyRef.current = key;
    sessionsApi.getUsage(key).then(setSessionUsage).catch(() => { /* non-fatal */ });
  }, [messages.length, sessionUsage]);

  // Auto-scroll to bottom on new messages or streaming output
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, runEvents.outputText, runEvents.toolCalls.length]);

  const handleSend = useCallback(
    (text: string) => {
      void sendMessage(text);
    },
    [sendMessage],
  );

  // Parse actions from the latest streaming text
  const latestAssistantMsg = messages.length > 0
    ? messages[messages.length - 1]
    : undefined;
  const streamingContent = latestAssistantMsg?.status === "streaming"
    ? runEvents.outputText
    : undefined;
  const { actions: streamingActions } = streamingContent
    ? parseActionsFromText(streamingContent)
    : { actions: [] };

  return (
    <div className="flex h-full min-h-[calc(100vh-8rem)] flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/10 px-1 pb-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Chat with Friday</h2>
          <p className="text-xs text-white/40">Ask anything or tell Friday what to do</p>
        </div>
        {messages.length > 0 && (
          <div className="flex items-center gap-2">
            {sessionUsage && sessionUsage.totalRuns > 0 && (
              <span className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-white/40" title={`Input: ${sessionUsage.totalInputTokens.toLocaleString()} · Output: ${sessionUsage.totalOutputTokens.toLocaleString()}`}>
                <Activity className="h-3 w-3" />
                {((sessionUsage.totalInputTokens + sessionUsage.totalOutputTokens) / 1000).toFixed(1)}K tokens
                {sessionUsage.totalCostUsd > 0 && ` · $${sessionUsage.totalCostUsd.toFixed(3)}`}
              </span>
            )}
            <button
              type="button"
              onClick={startNewConversation}
              className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-white/50 transition-colors hover:border-emerald-400/30 hover:text-emerald-300"
            >
              <MessageSquarePlus className="h-3 w-3" />
              New conversation
            </button>
            <button
              type="button"
              onClick={clearHistory}
              className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-white/50 transition-colors hover:border-rose-400/30 hover:text-rose-300"
            >
              <Trash2 className="h-3 w-3" />
              Clear all
            </button>
          </div>
        )}
      </div>

      {/* Messages area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full border border-emerald-400/30 bg-emerald-400/10 text-2xl font-bold text-emerald-300">
              F
            </div>
            <h3 className="text-xl font-semibold text-white">Hi, I'm Friday</h3>
            <p className="max-w-md text-sm leading-relaxed text-white/50">
              Your AI automation assistant. Ask me anything, or tell me what you'd like to automate.
              I can create workflows, install skills, monitor systems, and more.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((msg) => {
              // For completed assistant messages, check for action cards
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
                  />
                  {actions.length > 0 && (
                    <ChatActionCard actions={actions} />
                  )}
                </div>
              );
            })}

            {/* Show tool activity during streaming */}
            {isStreaming && runEvents.toolCalls.length > 0 && (
              <ChatToolActivity
                toolCalls={runEvents.toolCalls}
                activeTool={runEvents.progress.activeTool}
              />
            )}

            {/* Show streaming actions as they appear */}
            {isStreaming && streamingActions.length > 0 && (
              <ChatActionCard actions={streamingActions} />
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="border-t border-white/10 pt-3">
        <ChatInput
          onSend={handleSend}
          disabled={isStreaming}
          placeholder={isStreaming ? "Friday is thinking..." : undefined}
        />
      </div>
    </div>
  );
}

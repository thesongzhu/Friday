import { useCallback, useRef, useState } from "react";
import { agentApi } from "@/lib/api/agent";
import { useAgentRunEvents, type UseAgentRunEventsResult } from "./use-agent-run-events";

// ─── Types ───

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  runId?: string;
  timestamp: string;
  status?: "sending" | "streaming" | "done" | "error";
}

export interface UseChatSessionResult {
  messages: ChatMessage[];
  currentRunId: string | null;
  runEvents: UseAgentRunEventsResult;
  sendMessage: (text: string) => Promise<void>;
  isStreaming: boolean;
  clearHistory: () => void;
}

// ─── Persistent session key ───

const SESSION_KEY_STORAGE = "friday-chat-session-key";
const HISTORY_STORAGE = "friday-chat-history";

function getOrCreateSessionKey(): string {
  const existing = localStorage.getItem(SESSION_KEY_STORAGE);
  if (existing) return existing;
  const key = `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  localStorage.setItem(SESSION_KEY_STORAGE, key);
  return key;
}

function loadHistory(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE);
    if (!raw) return [];
    return JSON.parse(raw) as ChatMessage[];
  } catch {
    return [];
  }
}

function saveHistory(messages: ChatMessage[]) {
  try {
    // Keep last 200 messages to avoid localStorage overflow
    const trimmed = messages.slice(-200);
    localStorage.setItem(HISTORY_STORAGE, JSON.stringify(trimmed));
  } catch {
    // Ignore quota errors
  }
}

// ─── Hook ───

export function useChatSession(): UseChatSessionResult {
  const [messages, setMessages] = useState<ChatMessage[]>(loadHistory);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const sessionKeyRef = useRef(getOrCreateSessionKey());

  const runEvents = useAgentRunEvents(currentRunId, {
    enabled: currentRunId !== null,
    onTerminal: (status) => {
      // Finalize the assistant message with full output
      setMessages((prev) => {
        const updated = prev.map((m) =>
          m.runId === currentRunId && m.role === "assistant"
            ? { ...m, status: (status === "completed" ? "done" : "error") as ChatMessage["status"] }
            : m,
        );
        saveHistory(updated);
        return updated;
      });
      setCurrentRunId(null);
    },
  });

  const isStreaming = runEvents.connectionState === "streaming" || runEvents.connectionState === "connecting";

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Add user message
    const userMsg: ChatMessage = {
      id: `msg-${Date.now().toString(36)}`,
      role: "user",
      content: trimmed,
      timestamp: new Date().toISOString(),
      status: "done",
    };

    setMessages((prev) => {
      const updated = [...prev, userMsg];
      saveHistory(updated);
      return updated;
    });

    try {
      // Start a new agent run
      const { runId } = await agentApi.startRun({
        task: trimmed,
        sessionKey: sessionKeyRef.current,
        executionContext: {
          surface: "chat",
          interactive: true,
        },
      });

      // Add placeholder assistant message
      const assistantMsg: ChatMessage = {
        id: `msg-${Date.now().toString(36)}-reply`,
        role: "assistant",
        content: "",
        runId,
        timestamp: new Date().toISOString(),
        status: "streaming",
      };

      setMessages((prev) => {
        const updated = [...prev, assistantMsg];
        saveHistory(updated);
        return updated;
      });

      setCurrentRunId(runId);
    } catch (err) {
      // Add error message
      const errMsg: ChatMessage = {
        id: `msg-${Date.now().toString(36)}-err`,
        role: "assistant",
        content: `Failed to send message: ${err instanceof Error ? err.message : "Unknown error"}`,
        timestamp: new Date().toISOString(),
        status: "error",
      };
      setMessages((prev) => {
        const updated = [...prev, errMsg];
        saveHistory(updated);
        return updated;
      });
    }
  }, []);

  const clearHistory = useCallback(() => {
    setMessages([]);
    localStorage.removeItem(HISTORY_STORAGE);
    localStorage.removeItem(SESSION_KEY_STORAGE);
    sessionKeyRef.current = getOrCreateSessionKey();
  }, []);

  return {
    messages,
    currentRunId,
    runEvents,
    sendMessage,
    isStreaming,
    clearHistory,
  };
}

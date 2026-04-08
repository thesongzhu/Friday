import { useCallback, useEffect, useRef, useState } from "react";
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
  sessionKey: string;
  currentRunId: string | null;
  runEvents: UseAgentRunEventsResult;
  sendMessage: (text: string) => Promise<void>;
  isStreaming: boolean;
  clearHistory: () => void;
  startNewConversation: () => void;
}

export interface UseChatSessionOptions {
  packId?: string | null;
}

// ─── Persistent session key ───

const SESSION_KEY_STORAGE = "friday-chat-session-key";
const HISTORY_STORAGE = "friday-chat-history";
const CHAT_SESSION_CHANNEL = "chat";
const CHAT_SESSION_ACCOUNT = "default";
const SESSION_KEY_SEGMENT_PATTERN = /^[a-z0-9._-]+$/;
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "failed_tests"]);

function normalizeSessionKeySegment(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function createChatConversationId(): string {
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildChatSessionKey(chatId = createChatConversationId()): string {
  const normalizedChatId = normalizeSessionKeySegment(chatId);
  return `${CHAT_SESSION_CHANNEL}:${CHAT_SESSION_ACCOUNT}:${normalizedChatId}`;
}

function isCanonicalConversationSessionKey(raw: string): boolean {
  const segments = raw.split(":");
  return segments.length === 3 && segments.every((segment) =>
    segment.length > 0 && SESSION_KEY_SEGMENT_PATTERN.test(segment)
  );
}

export function coercePersistedChatSessionKey(raw: string | null): string {
  if (!raw) {
    return buildChatSessionKey();
  }

  if (isCanonicalConversationSessionKey(raw)) {
    return raw;
  }

  const meaningfulSegments = raw
    .split(":")
    .map((segment) => normalizeSessionKeySegment(segment))
    .filter((segment) => segment.length > 0);

  const candidateChatId = meaningfulSegments.at(-1);
  return buildChatSessionKey(candidateChatId);
}

export function isTerminalChatRunStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && TERMINAL_RUN_STATUSES.has(status);
}

export function resolveImmediateChatResponse(input: {
  status?: string;
  response?: string;
  finalResponse?: string;
}): string | null {
  if (!isTerminalChatRunStatus(input.status)) {
    return null;
  }
  const text = input.finalResponse ?? input.response;
  return typeof text === "string" && text.trim().length > 0 ? text : null;
}

function getOrCreateSessionKey(): string {
  const key = coercePersistedChatSessionKey(localStorage.getItem(SESSION_KEY_STORAGE));
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

export function useChatSession(options: UseChatSessionOptions = {}): UseChatSessionResult {
  const [messages, setMessages] = useState<ChatMessage[]>(loadHistory);
  const [sessionKey, setSessionKey] = useState<string>(() => getOrCreateSessionKey());
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const sessionKeyRef = useRef(sessionKey);
  const outputTextRef = useRef("");

  const runEvents = useAgentRunEvents(currentRunId, {
    enabled: currentRunId !== null,
    onTerminal: (status) => {
      // Finalize the assistant message with full output text
      const finalText = outputTextRef.current;
      setMessages((prev) => {
        const updated = prev.map((m) =>
          m.runId === currentRunId && m.role === "assistant"
            ? {
                ...m,
                content: finalText,
                status: (status === "completed" ? "done" : "error") as ChatMessage["status"],
              }
            : m,
        );
        saveHistory(updated);
        return updated;
      });
      outputTextRef.current = "";
      setCurrentRunId(null);
    },
  });

  // Keep ref in sync with latest streaming output
  useEffect(() => {
    outputTextRef.current = runEvents.outputText;
  }, [runEvents.outputText]);

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
      const result = await agentApi.startRun({
        task: trimmed,
        sessionKey: sessionKeyRef.current,
        executionContext: {
          surface: "chat",
          interactive: true,
          ...(options.packId ? { packId: options.packId } : {}),
        },
      });

      const immediateResponse = resolveImmediateChatResponse(result);
      if (immediateResponse) {
        const assistantMsg: ChatMessage = {
          id: `msg-${Date.now().toString(36)}-reply`,
          role: "assistant",
          content: immediateResponse,
          runId: result.runId,
          timestamp: new Date().toISOString(),
          status: result.status === "completed" ? "done" : "error",
        };

        setMessages((prev) => {
          const updated = [...prev, assistantMsg];
          saveHistory(updated);
          return updated;
        });
        return;
      }

      if (result.eventStreamAvailable === false) {
        throw new Error("Run started without event stream support");
      }

      // Add placeholder assistant message
      const assistantMsg: ChatMessage = {
        id: `msg-${Date.now().toString(36)}-reply`,
        role: "assistant",
        content: "",
        runId: result.runId,
        timestamp: new Date().toISOString(),
        status: "streaming",
      };

      setMessages((prev) => {
        const updated = [...prev, assistantMsg];
        saveHistory(updated);
        return updated;
      });

      setCurrentRunId(result.runId);
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
  }, [options.packId]);

  const clearHistory = useCallback(() => {
    setMessages([]);
    localStorage.removeItem(HISTORY_STORAGE);
    localStorage.removeItem(SESSION_KEY_STORAGE);
    const nextSessionKey = getOrCreateSessionKey();
    sessionKeyRef.current = nextSessionKey;
    setSessionKey(nextSessionKey);
  }, []);

  const startNewConversation = useCallback(() => {
    // Generate a fresh session key so the agent starts a new context,
    // but keep previous messages visible as a read-only log.
    localStorage.removeItem(SESSION_KEY_STORAGE);
    const nextSessionKey = getOrCreateSessionKey();
    sessionKeyRef.current = nextSessionKey;
    setSessionKey(nextSessionKey);
    // Add a visual separator message
    const separator: ChatMessage = {
      id: `sep-${Date.now().toString(36)}`,
      role: "assistant",
      content: "--- New conversation started ---",
      timestamp: new Date().toISOString(),
      status: "done",
    };
    setMessages((prev) => {
      const updated = [...prev, separator];
      saveHistory(updated);
      return updated;
    });
  }, []);

  return {
    messages,
    sessionKey,
    currentRunId,
    runEvents,
    sendMessage,
    isStreaming,
    clearHistory,
    startNewConversation,
  };
}

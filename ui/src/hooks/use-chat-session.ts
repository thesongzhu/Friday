import { useCallback, useEffect, useRef, useState } from "react";
import { agentApi } from "@/lib/api/agent";
import { sessionsApi } from "@/lib/api/sessions";
import { ApiError, type FridaySessionMessageRecord } from "@/lib/api/types";
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
  sendMessage: (text: string, options?: { taskPrompt?: string; onAccepted?: () => void }) => Promise<void>;
  isStreaming: boolean;
  queuedMessageCount: number;
  clearHistory: () => void;
  startNewConversation: () => void;
}

export interface UseChatSessionOptions {
  packId?: string | null;
}

interface QueuedChatSend {
  text: string;
  options?: { taskPrompt?: string; onAccepted?: () => void };
  sessionKey: string;
  userMessageId: string;
}

// ─── Persistent session key ───

const SESSION_KEY_STORAGE = "friday-chat-session-key";
const HISTORY_STORAGE_PREFIX = "friday-chat-history:";
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

function getHistoryStorageKey(sessionKey: string): string {
  return `${HISTORY_STORAGE_PREFIX}${sessionKey}`;
}

function loadHistory(sessionKey: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(getHistoryStorageKey(sessionKey));
    if (!raw) return [];
    return JSON.parse(raw) as ChatMessage[];
  } catch {
    return [];
  }
}

function saveHistory(sessionKey: string, messages: ChatMessage[]) {
  try {
    // Keep last 200 messages to avoid localStorage overflow
    const trimmed = messages.slice(-200);
    localStorage.setItem(getHistoryStorageKey(sessionKey), JSON.stringify(trimmed));
  } catch {
    // Ignore quota errors
  }
}

function extractChatIdFromSessionKey(sessionKey: string): string {
  const parts = sessionKey.split(":");
  return parts[parts.length - 1] ?? createChatConversationId();
}

function stringifySessionContent(record: FridaySessionMessageRecord): string {
  if (record.contentText.trim().length > 0) {
    return record.contentText;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  try {
    return JSON.stringify(record.content);
  } catch {
    return "";
  }
}

function isChatRenderableSessionMessage(
  record: FridaySessionMessageRecord,
): record is FridaySessionMessageRecord & { role: ChatMessage["role"] } {
  return record.role === "user" || record.role === "assistant";
}

function mapSessionMessagesToChatMessages(records: FridaySessionMessageRecord[]): ChatMessage[] {
  return records
    .filter(isChatRenderableSessionMessage)
    .sort((left, right) => left.sequence - right.sequence)
    .map((record) => ({
      id: record.id,
      role: record.role,
      content: stringifySessionContent(record),
      timestamp: record.occurredAt || record.createdAt,
      status: "done" as const,
    }));
}

export function isSessionAlreadyCreatedError(error: unknown): boolean {
  return error instanceof ApiError
    && (
      error.code === "ALREADY_EXISTS"
      || error.code === "SESSION_ALREADY_EXISTS"
      || (
        error.statusCode === 409
        && /session already exists/i.test(error.message)
      )
    );
}

// ─── Hook ───

export function useChatSession(options: UseChatSessionOptions = {}): UseChatSessionResult {
  const [sessionKey, setSessionKey] = useState<string>(() => getOrCreateSessionKey());
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadHistory(sessionKey));
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [queuedMessageCount, setQueuedMessageCount] = useState(0);
  const sessionKeyRef = useRef(sessionKey);
  const currentRunIdRef = useRef<string | null>(null);
  const currentRunSessionKeyRef = useRef<string | null>(null);
  const outputTextRef = useRef("");
  const isStartingRunRef = useRef(false);
  const pendingQueueRef = useRef<QueuedChatSend[]>([]);
  const beginRunForMessageRef = useRef<((input: QueuedChatSend) => Promise<void>) | null>(null);

  const syncMessagesFromServer = useCallback(async (targetSessionKey: string): Promise<boolean> => {
    try {
      const remoteMessages = await sessionsApi.listMessages(targetSessionKey, { limit: 200 });
      const mapped = mapSessionMessagesToChatMessages(remoteMessages);
      if (sessionKeyRef.current === targetSessionKey) {
        setMessages(mapped);
      }
      saveHistory(targetSessionKey, mapped);
      return true;
    } catch {
      return false;
    }
  }, []);

  const ensureRemoteSession = useCallback(async (targetSessionKey: string) => {
    try {
      await sessionsApi.create({
        channel: CHAT_SESSION_CHANNEL,
        chatId: extractChatIdFromSessionKey(targetSessionKey),
        chatKind: "dm",
      });
    } catch (error) {
      if (!isSessionAlreadyCreatedError(error)) {
        throw error;
      }
    }
  }, []);

  const scheduleSyncFromServer = useCallback((targetSessionKey: string, delayMs = 300) => {
    window.setTimeout(() => {
      void syncMessagesFromServer(targetSessionKey);
    }, delayMs);
  }, [syncMessagesFromServer]);

  const updateSessionHistory = useCallback((
    targetSessionKey: string,
    updater: (messages: ChatMessage[]) => ChatMessage[],
  ) => {
    if (sessionKeyRef.current !== targetSessionKey) {
      const updated = updater(loadHistory(targetSessionKey));
      saveHistory(targetSessionKey, updated);
      return;
    }

    setMessages((prev) => {
      if (sessionKeyRef.current !== targetSessionKey) {
        const updated = updater(loadHistory(targetSessionKey));
        saveHistory(targetSessionKey, updated);
        return prev;
      }
      const updated = updater(prev);
      saveHistory(targetSessionKey, updated);
      return updated;
    });
  }, []);

  const beginRunForMessage = useCallback(async (input: QueuedChatSend): Promise<void> => {
    const activeSessionKey = input.sessionKey;
    isStartingRunRef.current = true;

    updateSessionHistory(activeSessionKey, (prev) => {
      const hasExistingUserMessage = prev.some((message) => message.id === input.userMessageId);
      if (hasExistingUserMessage) {
        return prev.map((message) =>
          message.id === input.userMessageId
            ? { ...message, status: "done" as const }
            : message,
        );
      }
      const userMsg: ChatMessage = {
        id: input.userMessageId,
        role: "user",
        content: input.text,
        timestamp: new Date().toISOString(),
        status: "done",
      };
      return [...prev, userMsg];
    });

    try {
      await ensureRemoteSession(activeSessionKey);

      const result = await agentApi.startRun({
        task: input.text,
        taskPrompt: typeof input.options?.taskPrompt === "string" && input.options.taskPrompt.trim().length > 0
          ? input.options.taskPrompt.trim()
          : undefined,
        sessionKey: activeSessionKey,
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

        updateSessionHistory(activeSessionKey, (prev) => [...prev, assistantMsg]);
        scheduleSyncFromServer(activeSessionKey);
        input.options?.onAccepted?.();
        return;
      }

      if (result.eventStreamAvailable === false) {
        throw new Error("Run started without event stream support");
      }

      const assistantMsg: ChatMessage = {
        id: `msg-${Date.now().toString(36)}-reply`,
        role: "assistant",
        content: "",
        runId: result.runId,
        timestamp: new Date().toISOString(),
        status: "streaming",
      };

      updateSessionHistory(activeSessionKey, (prev) => [...prev, assistantMsg]);

      currentRunSessionKeyRef.current = activeSessionKey;
      currentRunIdRef.current = result.runId;
      setCurrentRunId(result.runId);
      input.options?.onAccepted?.();
    } catch (err) {
      const errMsg: ChatMessage = {
        id: `msg-${Date.now().toString(36)}-err`,
        role: "assistant",
        content: `Failed to send message: ${err instanceof Error ? err.message : "Unknown error"}`,
        timestamp: new Date().toISOString(),
        status: "error",
      };
      updateSessionHistory(activeSessionKey, (prev) => [...prev, errMsg]);
    } finally {
      isStartingRunRef.current = false;
      if (currentRunIdRef.current === null && pendingQueueRef.current.length > 0) {
        window.setTimeout(() => {
          const next = pendingQueueRef.current.shift();
          setQueuedMessageCount(pendingQueueRef.current.length);
          if (next) {
            void beginRunForMessageRef.current?.(next);
          }
        }, 0);
      }
    }
  }, [ensureRemoteSession, options.packId, scheduleSyncFromServer, updateSessionHistory]);

  beginRunForMessageRef.current = beginRunForMessage;

  const drainQueuedMessage = useCallback(() => {
    const next = pendingQueueRef.current.shift();
    setQueuedMessageCount(pendingQueueRef.current.length);
    if (!next) return;
    void beginRunForMessageRef.current?.(next);
  }, []);

  const runEvents = useAgentRunEvents(currentRunId, {
    enabled: currentRunId !== null,
    onTerminal: (status) => {
      // Finalize the assistant message with full output text
      const finalText = outputTextRef.current;
      const runSessionKey = currentRunSessionKeyRef.current ?? sessionKeyRef.current;
      const terminalRunId = currentRunIdRef.current ?? currentRunId;
      updateSessionHistory(runSessionKey, (prev) =>
        prev.map((m) =>
          m.runId === terminalRunId && m.role === "assistant"
            ? {
                ...m,
                content: finalText,
                status: (status === "completed" ? "done" : "error") as ChatMessage["status"],
              }
            : m,
        ),
      );
      outputTextRef.current = "";
      currentRunSessionKeyRef.current = null;
      currentRunIdRef.current = null;
      setCurrentRunId(null);
      scheduleSyncFromServer(runSessionKey);
      window.setTimeout(drainQueuedMessage, 0);
    },
  });

  // Keep ref in sync with latest streaming output
  useEffect(() => {
    outputTextRef.current = runEvents.outputText;
  }, [runEvents.outputText]);

  useEffect(() => {
    currentRunIdRef.current = currentRunId;
  }, [currentRunId]);

  useEffect(() => {
    sessionKeyRef.current = sessionKey;
    setMessages(loadHistory(sessionKey));
    void syncMessagesFromServer(sessionKey);
  }, [sessionKey, syncMessagesFromServer]);

  const isStreaming = runEvents.connectionState === "streaming" || runEvents.connectionState === "connecting";

  const sendMessage = useCallback(async (
    text: string,
    sendOptions?: { taskPrompt?: string; onAccepted?: () => void },
  ) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const activeSessionKey = sessionKeyRef.current;

    const userMessageId = `msg-${Date.now().toString(36)}`;
    if (currentRunIdRef.current || isStartingRunRef.current) {
      const queuedUserMsg: ChatMessage = {
        id: userMessageId,
        role: "user",
        content: trimmed,
        timestamp: new Date().toISOString(),
        status: "sending",
      };
      updateSessionHistory(activeSessionKey, (prev) => [...prev, queuedUserMsg]);
      const queuedOptions = sendOptions
        ? { taskPrompt: sendOptions.taskPrompt }
        : undefined;
      pendingQueueRef.current.push({
        text: trimmed,
        ...(queuedOptions ? { options: queuedOptions } : {}),
        sessionKey: activeSessionKey,
        userMessageId,
      });
      setQueuedMessageCount(pendingQueueRef.current.length);
      sendOptions?.onAccepted?.();
      return;
    }

    await beginRunForMessage({
      text: trimmed,
      ...(sendOptions ? { options: sendOptions } : {}),
      sessionKey: activeSessionKey,
      userMessageId,
    });
  }, [beginRunForMessage, updateSessionHistory]);

  const clearHistory = useCallback(() => {
    const currentSessionKey = sessionKeyRef.current;
    void sessionsApi.reset(currentSessionKey).catch(() => {});
    outputTextRef.current = "";
    currentRunSessionKeyRef.current = null;
    currentRunIdRef.current = null;
    pendingQueueRef.current = [];
    setQueuedMessageCount(0);
    setCurrentRunId(null);
    setMessages([]);
    localStorage.removeItem(getHistoryStorageKey(currentSessionKey));
    localStorage.removeItem(SESSION_KEY_STORAGE);
    const nextSessionKey = getOrCreateSessionKey();
    sessionKeyRef.current = nextSessionKey;
    setSessionKey(nextSessionKey);
  }, []);

  const startNewConversation = useCallback(() => {
    // Generate a fresh session key so the next send starts a clean server-backed session.
    outputTextRef.current = "";
    currentRunSessionKeyRef.current = null;
    currentRunIdRef.current = null;
    pendingQueueRef.current = [];
    setQueuedMessageCount(0);
    setCurrentRunId(null);
    setMessages([]);
    localStorage.removeItem(SESSION_KEY_STORAGE);
    const nextSessionKey = getOrCreateSessionKey();
    sessionKeyRef.current = nextSessionKey;
    setSessionKey(nextSessionKey);
  }, []);

  return {
    messages,
    sessionKey,
    currentRunId,
    runEvents,
    sendMessage,
    isStreaming,
    queuedMessageCount,
    clearHistory,
    startNewConversation,
  };
}

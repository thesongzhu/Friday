import * as React from "react";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { authStorage } from "@/lib/storage/auth-storage";
import { apiClient } from "@/lib/api/client";
import type { AgentRunStreamEvent, AgentRunStatus } from "@/lib/api/types";

// ─── View models ───

export interface ToolCallViewModel {
  id: string;
  toolName: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  summary?: string;
  status: "running" | "completed" | "failed";
}

export interface SubagentNodeViewModel {
  id: string;
  task: string;
  status: AgentRunStatus | "running";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
}

// ─── Options + Result ───

export interface UseAgentRunEventsOptions {
  enabled?: boolean;
  onTerminal?: (status: "completed" | "failed" | "cancelled" | "failed_tests") => void;
}

export type ConnectionState = "idle" | "connecting" | "streaming" | "closed" | "error";

export interface UseAgentRunEventsResult {
  connectionState: ConnectionState;
  status: string | null;
  outputText: string;
  events: AgentRunStreamEvent[];
  toolCalls: ToolCallViewModel[];
  subagents: SubagentNodeViewModel[];
  errorMessage?: string;
  reconnect: () => void;
}

// ─── Terminal statuses ───

const TERMINAL_STATUSES = new Set<string>(["completed", "failed", "cancelled", "failed_tests"]);

function isTerminalStatus(value: string | null | undefined): value is "completed" | "failed" | "cancelled" | "failed_tests" {
  if (!value) return false;
  return TERMINAL_STATUSES.has(value);
}

// ─── Backoff delays ───

const BACKOFF_MS = [500, 1000, 2000, 5000];

// ─── Hook ───

export function useAgentRunEvents(
  runId: string | null,
  options: UseAgentRunEventsOptions = {},
): UseAgentRunEventsResult {
  const { enabled = true, onTerminal } = options;

  const [connectionState, setConnectionState] = React.useState<ConnectionState>("idle");
  const [status, setStatus] = React.useState<string | null>(null);
  const [outputText, setOutputText] = React.useState("");
  const [events, setEvents] = React.useState<AgentRunStreamEvent[]>([]);
  const [toolCalls, setToolCalls] = React.useState<ToolCallViewModel[]>([]);
  const [subagents, setSubagents] = React.useState<SubagentNodeViewModel[]>([]);
  const [errorMessage, setErrorMessage] = React.useState<string | undefined>();
  const [reconnectTrigger, setReconnectTrigger] = React.useState(0);

  const abortRef = React.useRef<AbortController | null>(null);
  const retryCountRef = React.useRef(0);
  const terminalRef = React.useRef(false);
  const onTerminalRef = React.useRef(onTerminal);
  onTerminalRef.current = onTerminal;

  const reconnect = React.useCallback(() => {
    setReconnectTrigger((n) => n + 1);
  }, []);

  React.useEffect(() => {
    if (!runId || !enabled) {
      setConnectionState("idle");
      return;
    }

    terminalRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;

    async function connect() {
      setConnectionState("connecting");

      const headers: Record<string, string> = {
        Accept: "text/event-stream",
      };
      const token = authStorage.getAccessToken();
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      try {
        const res = await fetch(`/v1/agent/runs/${encodeURIComponent(runId!)}/events`, {
          headers,
          signal: controller.signal,
        });

        if (res.status === 401 && token) {
          try {
            await apiClient.refreshSession();
            if (!controller.signal.aborted) {
              connect();
            }
            return;
          } catch {
            setConnectionState("error");
            setErrorMessage("Session expired");
            return;
          }
        }

        if (!res.ok || !res.body) {
          setConnectionState("error");
          setErrorMessage(`HTTP ${res.status}`);
          return;
        }

        setConnectionState("streaming");
        retryCountRef.current = 0;

        const stream = res.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new EventSourceParserStream());

        const reader = stream.getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (!value.data) continue;

          let parsed: AgentRunStreamEvent;
          try {
            parsed = JSON.parse(value.data) as AgentRunStreamEvent;
          } catch {
            continue;
          }

          setEvents((prev) => [...prev, parsed]);

          const eventType = parsed.type;

          // Text delta
          if (eventType === "agent.run.text_delta" && parsed.delta) {
            setOutputText((prev) => prev + parsed.delta);
          }

          // Status updates
          if (eventType.startsWith("agent.run.") && parsed.status) {
            setStatus(parsed.status);
            if (isTerminalStatus(parsed.status)) {
              terminalRef.current = true;
              setConnectionState("closed");
              onTerminalRef.current?.(parsed.status);
              return;
            }
          }

          // Tool start
          if (eventType === "agent.run.tool_start" && parsed.toolCallId) {
            setToolCalls((prev) => [
              ...prev,
              {
                id: parsed.toolCallId!,
                toolName: parsed.toolName ?? "unknown",
                startedAt: parsed.timestamp ?? new Date().toISOString(),
                status: "running",
              },
            ]);
          }

          // Tool end
          if (eventType === "agent.run.tool_end" && parsed.toolCallId) {
            setToolCalls((prev) =>
              prev.map((tc) =>
                tc.id === parsed.toolCallId
                  ? {
                      ...tc,
                      endedAt: parsed.timestamp,
                      durationMs: parsed.durationMs,
                      summary: parsed.summary,
                      status: "completed" as const,
                    }
                  : tc,
              ),
            );
          }

          // Subagent spawned
          if (eventType === "agent.subagent.spawned" && parsed.subagentId) {
            setSubagents((prev) => [
              ...prev,
              {
                id: parsed.subagentId!,
                task: parsed.subagentTask ?? "",
                status: "running",
                startedAt: parsed.timestamp ?? new Date().toISOString(),
              },
            ]);
          }

          // Subagent completed
          if (eventType === "agent.subagent.completed" && parsed.subagentId) {
            setSubagents((prev) =>
              prev.map((sa) =>
                sa.id === parsed.subagentId
                  ? {
                      ...sa,
                      status: parsed.status ?? "completed",
                      completedAt: parsed.timestamp,
                      durationMs: parsed.durationMs,
                    }
                  : sa,
              ),
            );
          }

          // Terminal events
          if (TERMINAL_STATUSES.has(eventType.replace("agent.run.", ""))) {
            terminalRef.current = true;
            setConnectionState("closed");
            const terminalStatus = eventType.replace("agent.run.", "") as "completed" | "failed" | "cancelled" | "failed_tests";
            setStatus(terminalStatus);
            onTerminalRef.current?.(terminalStatus);
            return;
          }
        }

        // Stream ended naturally
        if (!terminalRef.current) {
          setConnectionState("closed");
        }
      } catch (err) {
        if (controller.signal.aborted) return;

        if (!terminalRef.current) {
          const retryIdx = Math.min(retryCountRef.current, BACKOFF_MS.length - 1);
          retryCountRef.current++;
          setConnectionState("error");
          setErrorMessage(err instanceof Error ? err.message : "Connection lost");

          setTimeout(() => {
            if (!controller.signal.aborted && !terminalRef.current) {
              connect();
            }
          }, BACKOFF_MS[retryIdx]);
        }
      }
    }

    // Reset state
    setOutputText("");
    setEvents([]);
    setToolCalls([]);
    setSubagents([]);
    setStatus(null);
    setErrorMessage(undefined);

    connect();

    return () => {
      controller.abort();
    };
  }, [runId, enabled, reconnectTrigger]);

  return {
    connectionState,
    status,
    outputText,
    events,
    toolCalls,
    subagents,
    errorMessage,
    reconnect,
  };
}

import * as React from "react";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { authStorage } from "@/lib/storage/auth-storage";
import { apiClient } from "@/lib/api/client";
import type { AgentRunStreamEvent, AgentRunStatus } from "@/lib/api/types";

// ─── Autonomous view models ───

export interface AutonomousStepViewModel {
  id: string;
  instruction: string;
  status: "pending" | "executing" | "completed" | "failed";
}

export interface AutonomousGoalViewModel {
  id: string;
  description: string;
  status: "pending" | "executing" | "completed" | "failed";
  steps: AutonomousStepViewModel[];
  currentStepIndex: number;
}

// ─── View models ───

export interface ToolCallViewModel {
  id: string;
  toolName: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  summary?: string;
  params?: Record<string, unknown>;
  presentationMode?: "headless" | "host_chrome_visible";
  targetBrowser?: string;
  browserTarget?: string;
  sessionId?: string;
  tabId?: string;
  fallbackReason?: string;
  targetUrl?: string;
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

export interface PendingToolApprovalViewModel {
  runId: string;
  toolName: string;
  toolCallId: string;
  params?: Record<string, unknown>;
  reason: string;
  receivedAt: string;
  riskLevel?: "safe" | "guarded" | "destructive" | "blocked";
}

export interface StatusBannerViewModel {
  id: string;
  kind: "degraded" | "mode_changed" | "route_fallback" | "route_mismatch";
  message: string;
  timestamp: string;
  tone: "warning" | "info" | "error";
}

export interface RunProgressViewModel {
  phase?: AgentRunStatus;
  startedAt?: string;
  elapsedMs: number;
  activeTool?: string;
  subagentCount: number;
  latestSubagentId?: string;
  activeSubagentIds: string[];
  eta?: number;
  etaConfidence: "low" | "medium" | "high" | "unavailable";
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
  pendingToolApprovals: PendingToolApprovalViewModel[];
  statusBanners: StatusBannerViewModel[];
  progress: RunProgressViewModel;
  autonomousGoal: AutonomousGoalViewModel | null;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readBrowserTargetUrl(params: Record<string, unknown> | undefined): string | undefined {
  if (!params) return undefined;
  const url = params.url;
  return typeof url === "string" && url.trim().length > 0 ? url.trim() : undefined;
}

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
  const [progress, setProgress] = React.useState<RunProgressViewModel>({
    elapsedMs: 0,
    subagentCount: 0,
    activeSubagentIds: [],
    etaConfidence: "unavailable",
  });
  const [pendingToolApprovals, setPendingToolApprovals] = React.useState<PendingToolApprovalViewModel[]>([]);
  const [statusBanners, setStatusBanners] = React.useState<StatusBannerViewModel[]>([]);
  const [autonomousGoal, setAutonomousGoal] = React.useState<AutonomousGoalViewModel | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | undefined>();
  const [reconnectTrigger, setReconnectTrigger] = React.useState(0);

  const abortRef = React.useRef<AbortController | null>(null);
  const retryCountRef = React.useRef(0);
  const terminalRef = React.useRef(false);
  const seenSeqRef = React.useRef<Set<number>>(new Set());
  const lastSeqRef = React.useRef(0);
  const onTerminalRef = React.useRef(onTerminal);
  onTerminalRef.current = onTerminal;

  const reconnect = React.useCallback(() => {
    setReconnectTrigger((n) => n + 1);
  }, []);

  React.useEffect(() => {
    if (!progress.startedAt) return;
    if (isTerminalStatus(status)) return;
    const interval = window.setInterval(() => {
      setProgress((prev) => {
        if (!prev.startedAt) return prev;
        return {
          ...prev,
          elapsedMs: Math.max(prev.elapsedMs, Date.now() - new Date(prev.startedAt).getTime()),
        };
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [progress.startedAt, status]);

  React.useEffect(() => {
    if (!runId || !enabled) {
      setConnectionState("idle");
      return;
    }

    terminalRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;
    let authRefreshAttempted = false;

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
        const afterSeq = lastSeqRef.current > 0 ? `?afterSeq=${String(lastSeqRef.current)}` : "";
        const res = await fetch(`/v1/agent/runs/${encodeURIComponent(runId!)}/events${afterSeq}`, {
          headers,
          signal: controller.signal,
        });

        if (res.status === 401 && token && !authRefreshAttempted) {
          try {
            authRefreshAttempted = true;
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

        if (res.status === 401) {
          setConnectionState("error");
          setErrorMessage("Session expired");
          return;
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

          if (typeof parsed.seq === "number") {
            if (seenSeqRef.current.has(parsed.seq)) {
              continue;
            }
            seenSeqRef.current.add(parsed.seq);
            lastSeqRef.current = Math.max(lastSeqRef.current, parsed.seq);
          }

          setEvents((prev) => [...prev, parsed]);

          const eventType = parsed.type;
          const eventTime = parsed.emittedAt ?? parsed.timestamp ?? new Date().toISOString();

          if (eventType === "agent.run.started") {
            setProgress((prev) => ({
              ...prev,
              startedAt: eventTime,
              elapsedMs: 0,
            }));
          }

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

          if (eventType === "agent.run.progress") {
            setProgress((prev) => ({
              ...prev,
              ...(parsed.phase ? { phase: parsed.phase } : {}),
              ...(typeof parsed.elapsedMs === "number" ? { elapsedMs: parsed.elapsedMs } : {}),
              ...(typeof parsed.activeTool === "string" ? { activeTool: parsed.activeTool } : { activeTool: undefined }),
              ...(typeof parsed.subagentCount === "number" ? { subagentCount: parsed.subagentCount } : {}),
              ...(typeof parsed.latestSubagentId === "string" ? { latestSubagentId: parsed.latestSubagentId } : {}),
              ...(Array.isArray(parsed.activeSubagentIds) ? { activeSubagentIds: parsed.activeSubagentIds } : {}),
              ...(typeof parsed.eta === "number" ? { eta: parsed.eta } : { eta: undefined }),
              etaConfidence: parsed.etaConfidence ?? prev.etaConfidence,
              startedAt: prev.startedAt ?? eventTime,
            }));
          }

          if (eventType === "agent.run.awaiting_clarification") {
            setStatus("awaiting_clarification");
            setOutputText(parsed.message ?? parsed.output ?? "");
            setProgress((prev) => ({
              ...prev,
              phase: "awaiting_clarification",
              startedAt: prev.startedAt ?? eventTime,
            }));
          }

          if (eventType === "agent.run.plan_ready") {
            setOutputText(parsed.planMarkdown ?? parsed.planSummary ?? parsed.message ?? "");
          }

          if (eventType === "agent.run.awaiting_plan_approval") {
            setStatus("awaiting_plan_approval");
            setOutputText(parsed.planMarkdown ?? parsed.message ?? parsed.output ?? "");
            setProgress((prev) => ({
              ...prev,
              phase: "awaiting_plan_approval",
              startedAt: prev.startedAt ?? eventTime,
            }));
          }

          // Tool approval request
          if (eventType === "agent.run.awaiting_tool_approval" && parsed.toolCallId) {
            setPendingToolApprovals((prev) => {
              if (prev.some((p) => p.toolCallId === parsed.toolCallId)) return prev;
              return [
                ...prev,
                {
                  runId: parsed.runId ?? runId ?? "",
                  toolName: parsed.toolName ?? "unknown",
                  toolCallId: parsed.toolCallId!,
                  params: asRecord(parsed.params),
                  reason: parsed.reason
                    ?? parsed.message ?? "This action requires approval.",
                  receivedAt: eventTime,
                  riskLevel: parsed.riskLevel as PendingToolApprovalViewModel["riskLevel"],
                },
              ];
            });
            setProgress((prev) => ({
              ...prev,
              phase: "awaiting_tool_approval" as AgentRunStatus,
              startedAt: prev.startedAt ?? eventTime,
            }));
          }

          // Runtime status events → banners
          if (eventType === "agent.run.degraded") {
            const level = typeof parsed.level === "string" ? parsed.level : "unknown";
            const msg = typeof parsed.message === "string" ? parsed.message : `Service degraded to ${level} mode.`;
            setStatusBanners((prev) => [
              ...prev.filter((b) => b.kind !== "degraded"),
              { id: `degraded-${eventTime}`, kind: "degraded", message: msg, timestamp: eventTime, tone: "warning" },
            ]);
          }

          if (eventType === "agent.run.mode_changed") {
            const newMode = typeof parsed.newMode === "string" ? parsed.newMode : "restricted";
            const reason = typeof parsed.reason === "string" ? parsed.reason : "";
            setStatusBanners((prev) => [
              ...prev.filter((b) => b.kind !== "mode_changed"),
              {
                id: `mode-${eventTime}`,
                kind: "mode_changed",
                message: `Switched to ${newMode} mode${reason ? `: ${reason}` : ""}`,
                timestamp: eventTime,
                tone: newMode === "restricted" ? "warning" : "info",
              },
            ]);
          }

          if (eventType === "agent.run.route_fallback") {
            const count = typeof parsed.fallbackCount === "number" ? parsed.fallbackCount : 0;
            setStatusBanners((prev) => [
              ...prev.filter((b) => b.kind !== "route_fallback"),
              {
                id: `fallback-${eventTime}`,
                kind: "route_fallback",
                message: `Provider fallback occurred (${count} attempt${count !== 1 ? "s" : ""}).`,
                timestamp: eventTime,
                tone: "warning",
              },
            ]);
          }

          if (eventType === "agent.run.route_mismatch") {
            const msg = typeof parsed.message === "string" ? parsed.message : "Model routing mismatch detected.";
            setStatusBanners((prev) => [
              ...prev.filter((b) => b.kind !== "route_mismatch"),
              {
                id: `mismatch-${eventTime}`,
                kind: "route_mismatch",
                message: msg,
                timestamp: eventTime,
                tone: "error",
              },
            ]);
          }

          // Tool start — also clears any pending approval for this tool call
          if (eventType === "agent.run.tool_start" && parsed.toolCallId) {
            setPendingToolApprovals((prev) =>
              prev.filter((p) => p.toolCallId !== parsed.toolCallId),
            );
            const params = asRecord(parsed.params);
            setToolCalls((prev) => {
              if (prev.some((tc) => tc.id === parsed.toolCallId)) {
                return prev;
              }
              return [
                ...prev,
                {
                  id: parsed.toolCallId!,
                  toolName: parsed.toolName ?? "unknown",
                  startedAt: eventTime,
                  params,
                  targetUrl: readBrowserTargetUrl(params),
                  status: "running",
                },
              ];
            });
          }

          // Tool end
          if (eventType === "agent.run.tool_end" && parsed.toolCallId) {
            setPendingToolApprovals((prev) =>
              prev.filter((p) => p.toolCallId !== parsed.toolCallId),
            );
            setToolCalls((prev) => {
              const existing = prev.find((tc) => tc.id === parsed.toolCallId);
              const nextTool = {
                ...(existing ?? {
                  id: parsed.toolCallId!,
                  toolName: parsed.toolName ?? "unknown",
                  startedAt: eventTime,
                  status: "running" as const,
                }),
                endedAt: eventTime,
                durationMs: parsed.durationMs,
                summary: parsed.summary,
                status: parsed.isError ? "failed" as const : "completed" as const,
                presentationMode: parsed.presentationMode,
                targetBrowser: parsed.targetBrowser,
                browserTarget: parsed.browserTarget ?? parsed.targetBrowser,
                sessionId: parsed.sessionId,
                tabId: parsed.tabId,
                fallbackReason: parsed.fallbackReason,
              };

              if (!existing) {
                return [...prev, nextTool];
              }

              return prev.map((tc) => (tc.id === parsed.toolCallId ? nextTool : tc));
            });
          }

          // Subagent spawned
          if (eventType === "agent.subagent.spawned" && parsed.subagentId) {
            setSubagents((prev) => {
              if (prev.some((sa) => sa.id === parsed.subagentId)) {
                return prev;
              }
              return [
                ...prev,
                {
                  id: parsed.subagentId!,
                  task: parsed.subagentTask ?? ((parsed as { task?: string }).task ?? ""),
                  status: "running",
                  startedAt: eventTime,
                },
              ];
            });
            setProgress((prev) => ({
              ...prev,
              subagentCount: Math.max(prev.subagentCount, prev.activeSubagentIds.length + 1),
              latestSubagentId: parsed.subagentId,
              activeSubagentIds: prev.activeSubagentIds.includes(parsed.subagentId!)
                ? prev.activeSubagentIds
                : [...prev.activeSubagentIds, parsed.subagentId!],
            }));
          }

          // Subagent completed
          if (eventType === "agent.subagent.completed" && parsed.subagentId) {
            setSubagents((prev) =>
              prev.map((sa) =>
                sa.id === parsed.subagentId
                  ? {
                      ...sa,
                      status: parsed.status ?? "completed",
                      completedAt: eventTime,
                      durationMs: parsed.durationMs,
                    }
                  : sa,
              ),
            );
            setProgress((prev) => ({
              ...prev,
              latestSubagentId: parsed.subagentId,
              activeSubagentIds: prev.activeSubagentIds.filter((id) => id !== parsed.subagentId),
              subagentCount: Math.max(0, prev.activeSubagentIds.filter((id) => id !== parsed.subagentId).length),
            }));
          }

          // Autonomous goal/step events
          if (eventType === "autonomous.goal.created" && parsed.goalId) {
            setAutonomousGoal({
              id: parsed.goalId,
              description: parsed.description ?? "",
              status: "pending",
              steps: [],
              currentStepIndex: -1,
            });
          }

          if (eventType === "autonomous.goal.started" && parsed.goalId) {
            setAutonomousGoal((prev) =>
              prev && prev.id === parsed.goalId ? { ...prev, status: "executing" } : prev,
            );
          }

          if (eventType === "autonomous.step.started" && parsed.goalId && parsed.stepId) {
            setAutonomousGoal((prev) => {
              if (!prev || prev.id !== parsed.goalId) return prev;
              const existingIdx = prev.steps.findIndex((s) => s.id === parsed.stepId);
              const step: AutonomousStepViewModel = {
                id: parsed.stepId!,
                instruction: parsed.instruction ?? "",
                status: "executing",
              };
              const nextSteps = existingIdx >= 0
                ? prev.steps.map((s, i) => (i === existingIdx ? step : s))
                : [...prev.steps, step];
              return {
                ...prev,
                steps: nextSteps,
                currentStepIndex: typeof parsed.index === "number" ? parsed.index : nextSteps.length - 1,
              };
            });
          }

          if (eventType === "autonomous.step.completed" && parsed.goalId && parsed.stepId) {
            setAutonomousGoal((prev) => {
              if (!prev || prev.id !== parsed.goalId) return prev;
              return {
                ...prev,
                steps: prev.steps.map((s) =>
                  s.id === parsed.stepId ? { ...s, status: "completed" } : s,
                ),
              };
            });
          }

          if (eventType === "autonomous.step.failed" && parsed.goalId && parsed.stepId) {
            setAutonomousGoal((prev) => {
              if (!prev || prev.id !== parsed.goalId) return prev;
              return {
                ...prev,
                steps: prev.steps.map((s) =>
                  s.id === parsed.stepId ? { ...s, status: "failed" } : s,
                ),
              };
            });
          }

          if (eventType === "autonomous.goal.completed" && parsed.goalId) {
            setAutonomousGoal((prev) =>
              prev && prev.id === parsed.goalId ? { ...prev, status: "completed" } : prev,
            );
          }

          if (eventType === "autonomous.goal.failed" && parsed.goalId) {
            setAutonomousGoal((prev) =>
              prev && prev.id === parsed.goalId ? { ...prev, status: "failed" } : prev,
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
    setPendingToolApprovals([]);
    setStatusBanners([]);
    setProgress({
      elapsedMs: 0,
      subagentCount: 0,
      activeSubagentIds: [],
      etaConfidence: "unavailable",
    });
    setAutonomousGoal(null);
    setStatus(null);
    setErrorMessage(undefined);
    seenSeqRef.current = new Set();
    lastSeqRef.current = 0;

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
    pendingToolApprovals,
    statusBanners,
    progress,
    autonomousGoal,
    errorMessage,
    reconnect,
  };
}

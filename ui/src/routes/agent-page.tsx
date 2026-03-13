import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import {
  AlertTriangle,
  AppWindow,
  ClipboardList,
  Command,
  MonitorCog,
  RadioTower,
  RefreshCcw,
  ShieldAlert,
  TerminalSquare,
} from "lucide-react";
import { toast } from "sonner";
import { agentApi } from "@/lib/api/agent";
import { systemApi } from "@/lib/api/system";
import type {
  FridaySystemApprovalRule,
  FridaySystemEvent,
  FridaySystemIntentAction,
  FridaySystemNotificationAction,
  FridaySystemRemoteDevice,
  FridaySystemRemoteSession,
} from "@/lib/api/system-types";
import { useAgentRunEvents } from "@/hooks/use-agent-run-events";
import { useSystemEvents } from "@/hooks/use-system-events";
import { systemKeys } from "@/lib/system/query-keys";
import {
  buildApprovalActionCards,
  buildRemoteDevicePasskeySummary,
  buildSystemTimelineItems,
  summarizeHealthReasons,
} from "@/lib/system/view-models";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";

const OPERATOR_ID = "ui-operator";

function formatTimestamp(value?: string): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function formatRelative(value?: string): string {
  if (!value) return "Never";
  const ms = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function mapTone(status?: string): "neutral" | "success" | "warning" | "danger" {
  if (status === "healthy" || status === "completed" || status === "active") return "success";
  if (status === "blocked" || status === "degraded" || status === "safe_mode") return "warning";
  if (status === "failed" || status === "unavailable" || status === "revoked") return "danger";
  return "neutral";
}

function formatBrowserMode(mode?: "headless" | "host_chrome_visible"): string {
  if (mode === "host_chrome_visible") return "visible desktop";
  if (mode === "headless") return "headless";
  return "unknown";
}

function browserModeTone(mode?: "headless" | "host_chrome_visible"): "neutral" | "success" | "warning" | "danger" {
  if (mode === "host_chrome_visible") return "success";
  if (mode === "headless") return "warning";
  return "neutral";
}

function getBlockedApprovalEvents(events: FridaySystemEvent[]): FridaySystemEvent[] {
  return events.filter((event) =>
    event.event === "system.intent.blocked"
      && typeof event.payload.message === "string"
      && event.payload.message.includes("Approval required")
  );
}

export function AgentPage() {
  const queryClient = useQueryClient();
  const [task, setTask] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [remoteLabel, setRemoteLabel] = useState("");
  const [remoteFingerprint, setRemoteFingerprint] = useState("");
  const passkeysSupported = typeof PublicKeyCredential !== "undefined";

  const { data: session, error: sessionError } = useQuery({
    queryKey: systemKeys.session(),
    queryFn: () => systemApi.getSession(),
    retry: 0,
    refetchInterval: 10_000,
  });

  const { data: state, error: stateError } = useQuery({
    queryKey: systemKeys.state(),
    queryFn: () => systemApi.getState(),
    retry: 0,
    refetchInterval: 10_000,
  });

  const { data: approvalsResponse } = useQuery({
    queryKey: systemKeys.approvals(),
    queryFn: () => systemApi.listApprovals({ limit: 100 }),
    retry: 0,
    refetchInterval: 20_000,
  });

  const { data: remoteDevices = [] } = useQuery({
    queryKey: systemKeys.remoteDevices(),
    queryFn: () => systemApi.listRemoteDevices(),
    retry: 0,
    refetchInterval: 20_000,
  });

  const { data: remoteSessions = [] } = useQuery({
    queryKey: systemKeys.remoteSessions(),
    queryFn: () => systemApi.listRemoteSessions({ limit: 20 }),
    retry: 0,
    refetchInterval: 15_000,
  });

  const { data: runs = [], refetch: refetchRuns } = useQuery({
    queryKey: ["agent-os", "runs"],
    queryFn: () => agentApi.listRuns({ limit: 8 }),
    refetchInterval: 20_000,
  });

  const systemEvents = useSystemEvents(Boolean(session));
  const deferredRuns = useDeferredValue(runs);
  const approvalCards = useMemo(
    () => buildApprovalActionCards(approvalsResponse?.items ?? []),
    [approvalsResponse?.items],
  );
  const timelineItems = useMemo(
    () => buildSystemTimelineItems(systemEvents.events),
    [systemEvents.events],
  );
  const blockedApprovalEvents = useMemo(
    () => getBlockedApprovalEvents(systemEvents.events),
    [systemEvents.events],
  );
  const runEvents = useAgentRunEvents(currentRunId, {
    enabled: currentRunId !== null,
    onTerminal: () => {
      void refetchRuns();
    },
  });
  const latestBrowserTool = useMemo(
    () => [...runEvents.toolCalls].reverse().find((tool) => tool.toolName === "browser"),
    [runEvents.toolCalls],
  );

  useEffect(() => {
    if (currentRunId) return;
    const active = deferredRuns.find((run) =>
      ["pending", "planning", "executing", "testing", "fixing"].includes(run.status),
    );
    if (active) {
      setCurrentRunId(active.id);
    }
  }, [currentRunId, deferredRuns]);

  const startRunMutation = useMutation({
    mutationFn: (input: { task: string; readOnly: boolean }) =>
      agentApi.startRun({
        task: input.task,
        readOnly: input.readOnly,
        requireReview: false,
        executionContext: {
          surface: "agent_page",
          interactive: true,
        },
      }),
    onSuccess: (result, input) => {
      toast.success(`Run started for "${input.task}"`);
      startTransition(() => {
        setCurrentRunId(result.runId);
      });
      setTask("");
      void refetchRuns();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to start run");
    },
  });

  const cancelRunMutation = useMutation({
    mutationFn: (runId: string) => agentApi.cancelRun(runId),
    onSuccess: () => {
      toast.success("Run cancelled");
      void refetchRuns();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to cancel run");
    },
  });

  const systemIntentMutation = useMutation({
    mutationFn: (input: {
      action: FridaySystemIntentAction;
      target?: string;
      reason?: string;
      notificationId?: string;
      notificationAction?: FridaySystemNotificationAction;
      layout?: "single_focus" | "dual_pane" | "triad";
    }) =>
      systemApi.executeIntent({
        action: input.action,
        actorId: OPERATOR_ID,
        actorKind: "api",
        target: input.target,
        reason: input.reason,
        notificationId: input.notificationId,
        notificationAction: input.notificationAction,
        layout: input.layout,
      }),
    onSuccess: (result) => {
      toast.success(result.message);
      void queryClient.invalidateQueries({ queryKey: systemKeys.state() });
      void queryClient.invalidateQueries({ queryKey: systemKeys.approvals() });
      void queryClient.invalidateQueries({ queryKey: systemKeys.session() });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "System action failed");
    },
  });

  const remoteRegisterMutation = useMutation({
    mutationFn: () =>
      systemApi.registerRemoteDevice({
        label: remoteLabel.trim(),
        fingerprint: remoteFingerprint.trim(),
        platform: "browser",
      }),
    onSuccess: () => {
      toast.success("Trusted device registered");
      setRemoteLabel("");
      setRemoteFingerprint("");
      void queryClient.invalidateQueries({ queryKey: systemKeys.remoteDevices() });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to register trusted device");
    },
  });

  const remoteRevokeMutation = useMutation({
    mutationFn: (deviceId: string) => systemApi.revokeRemoteDevice(deviceId),
    onSuccess: () => {
      toast.success("Trusted device revoked");
      void queryClient.invalidateQueries({ queryKey: systemKeys.remoteDevices() });
      void queryClient.invalidateQueries({ queryKey: systemKeys.remoteSessions() });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to revoke trusted device");
    },
  });

  const remoteClearPasskeyMutation = useMutation({
    mutationFn: (deviceId: string) => systemApi.clearRemoteDevicePasskey(deviceId),
    onSuccess: () => {
      toast.success("Trusted-device passkey cleared");
      void queryClient.invalidateQueries({ queryKey: systemKeys.remoteDevices() });
      void queryClient.invalidateQueries({ queryKey: systemKeys.remoteSessions() });
      void queryClient.invalidateQueries({ queryKey: systemKeys.state() });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to clear trusted-device passkey");
    },
  });

  const remoteCloseSessionMutation = useMutation({
    mutationFn: (sessionId: string) => systemApi.closeRemoteSession(sessionId),
    onSuccess: () => {
      toast.success("Remote session closed");
      void queryClient.invalidateQueries({ queryKey: systemKeys.remoteSessions() });
      void queryClient.invalidateQueries({ queryKey: systemKeys.state() });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to close remote session");
    },
  });

  const remoteEnrollPasskeyMutation = useMutation({
    mutationFn: async (deviceId: string) => {
      if (typeof PublicKeyCredential === "undefined") {
        throw new Error("Passkeys are not available in this browser");
      }
      const options = await systemApi.beginRemotePasskeyRegistration(deviceId);
      const response = await startRegistration({ optionsJSON: options.options });
      return systemApi.verifyRemotePasskeyRegistration({
        deviceId,
        challengeId: options.challengeId,
        response,
      });
    },
    onSuccess: () => {
      toast.success("Passkey enrolled for trusted device");
      void queryClient.invalidateQueries({ queryKey: systemKeys.remoteDevices() });
      void queryClient.invalidateQueries({ queryKey: systemKeys.remoteSessions() });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to enroll passkey");
    },
  });

  const remoteOpenSessionMutation = useMutation({
    mutationFn: async (deviceId: string) => {
      if (typeof PublicKeyCredential === "undefined") {
        throw new Error("Passkeys are not available in this browser");
      }
      const options = await systemApi.beginRemotePasskeyAssertion(deviceId);
      const response = await startAuthentication({ optionsJSON: options.options });
      const assertion = await systemApi.verifyRemotePasskeyAssertion({
        deviceId,
        challengeId: options.challengeId,
        response,
      });
      return systemApi.openRemoteSession({
        deviceId,
        assertionToken: assertion.assertionToken,
      });
    },
    onSuccess: () => {
      toast.success("Trusted remote session opened");
      void queryClient.invalidateQueries({ queryKey: systemKeys.remoteDevices() });
      void queryClient.invalidateQueries({ queryKey: systemKeys.remoteSessions() });
      void queryClient.invalidateQueries({ queryKey: systemKeys.state() });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to open remote session");
    },
  });

  const commandCenterError = sessionError ?? stateError;
  const approvalRules = approvalsResponse?.items ?? [];

  return (
    <div className="grid gap-4 xl:grid-cols-[1.35fr_0.95fr]">
      <div className="space-y-4">
        <ShellCard
          eyebrow="Operator Console"
          title="Command Center"
          aside={<StatusPill tone={mapTone(runEvents.connectionState)}>{runEvents.connectionState}</StatusPill>}
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!task.trim()) return;
              startRunMutation.mutate({ task: task.trim(), readOnly });
            }}
          >
            <div className="rounded-[28px] border border-white/10 bg-black/20 p-4">
              <label className="mb-2 flex items-center gap-2 text-sm font-medium text-white">
                <Command className="h-4 w-4 text-[var(--accent-strong)]" />
                Send a new operator task
              </label>
              <textarea
                value={task}
                onChange={(event) => setTask(event.target.value)}
                rows={5}
                className="agent-textarea"
                placeholder="Example: open the workspace, inspect system permissions, and prepare the next build task."
              />
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <label className="inline-flex items-center gap-2 text-sm text-white/70">
                  <input
                    type="checkbox"
                    checked={readOnly}
                    onChange={(event) => setReadOnly(event.target.checked)}
                    className="rounded border-white/20 bg-white/10"
                  />
                  Start in read-only mode
                </label>
                <div className="flex flex-wrap gap-2">
                  <ActionButton
                    tone="secondary"
                    onClick={() => systemIntentMutation.mutate({ action: "request_control", reason: "command_center" })}
                  >
                    Request Control
                  </ActionButton>
                  <ActionButton
                    tone="secondary"
                    onClick={() => systemIntentMutation.mutate({ action: "recover_ui", reason: "operator_recovery" })}
                  >
                    Recover UI
                  </ActionButton>
                  <ActionButton type="submit" disabled={startRunMutation.isPending || task.trim().length === 0}>
                    Launch Run
                  </ActionButton>
                </div>
              </div>
            </div>
          </form>
        </ShellCard>

        <ShellCard
          eyebrow="Live Run"
          title="Execution Console"
          aside={latestBrowserTool?.presentationMode ? (
            <StatusPill tone={browserModeTone(latestBrowserTool.presentationMode)}>
              {formatBrowserMode(latestBrowserTool.presentationMode)}
            </StatusPill>
          ) : undefined}
        >
          <div className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
            <div className="rounded-[24px] border border-white/10 bg-black/20 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-white">Run output</p>
                  <p className="text-xs text-white/50">
                    {currentRunId ? `Run ${currentRunId}` : "No active run selected"}
                  </p>
                </div>
                {currentRunId ? (
                  <ActionButton
                    tone="danger"
                    onClick={() => cancelRunMutation.mutate(currentRunId)}
                    disabled={cancelRunMutation.isPending}
                  >
                    Cancel
                  </ActionButton>
                ) : null}
              </div>
              <pre className="agent-console">
                {runEvents.outputText || "Start a run to stream live model output, tool activity, and terminal state here."}
              </pre>
            </div>

            <div className="space-y-3">
              <div className="rounded-[24px] border border-white/10 bg-black/20 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/40">
                  Tools
                </p>
                <div className="mt-3 space-y-2">
                  {runEvents.toolCalls.length === 0 ? (
                    <p className="text-sm text-white/50">No tool activity yet.</p>
                  ) : runEvents.toolCalls.slice(-4).map((tool) => (
                    <div key={tool.id} className="rounded-2xl border border-white/[0.08] bg-white/[0.04] p-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium text-white">{tool.toolName}</span>
                        <div className="flex flex-wrap items-center gap-2">
                          {tool.toolName === "browser" && tool.presentationMode ? (
                            <StatusPill tone={browserModeTone(tool.presentationMode)}>
                              {formatBrowserMode(tool.presentationMode)}
                            </StatusPill>
                          ) : null}
                          <StatusPill tone={mapTone(tool.status)}>{tool.status}</StatusPill>
                        </div>
                      </div>
                      <p className="mt-2 text-xs text-white/50">
                        {tool.summary
                          ?? (tool.toolName === "browser"
                            ? tool.targetUrl ?? "Browser action in progress."
                            : "Tool call completed without a summary.")}
                      </p>
                      {tool.toolName === "browser" && tool.browserTarget ? (
                        <p className="mt-2 text-[11px] text-white/35">
                          Target: {tool.browserTarget}
                        </p>
                      ) : null}
                      {tool.toolName === "browser" && tool.fallbackReason ? (
                        <p className="mt-2 text-[11px] text-amber-200/90">
                          Fallback: {tool.fallbackReason}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-[24px] border border-white/10 bg-black/20 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/40">
                  Recent runs
                </p>
                <div className="mt-3 space-y-2">
                  {deferredRuns.length === 0 ? (
                    <p className="text-sm text-white/50">No runs recorded yet.</p>
                  ) : deferredRuns.map((run) => (
                    <button
                      key={run.id}
                      type="button"
                      onClick={() => setCurrentRunId(run.id)}
                      className="w-full rounded-2xl border border-white/[0.08] bg-white/[0.04] p-3 text-left transition hover:border-white/[0.16] hover:bg-white/[0.08]"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="line-clamp-1 font-medium text-white">{run.task}</span>
                        <StatusPill tone={mapTone(run.status)}>{run.status}</StatusPill>
                      </div>
                      <p className="mt-2 text-xs text-white/50">{formatTimestamp(run.startedAt)}</p>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </ShellCard>

        <div className="grid gap-4 lg:grid-cols-2">
          <ShellCard eyebrow="System Truth" title="Current Session">
            {commandCenterError ? (
              <p className="text-sm text-rose-200">
                Agent OS routes are unavailable: {commandCenterError instanceof Error ? commandCenterError.message : "unknown error"}
              </p>
            ) : session && state ? (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Metric label="Health" value={state.health.status} tone={mapTone(state.health.status)} />
                  <Metric label="Remote Mode" value={session.remoteMode} tone={mapTone(session.remoteMode === "trusted_private_network" ? "active" : "unavailable")} />
                  <Metric label="Workspace" value={state.workspaceRoot} mono />
                  <Metric label="Active Task" value={state.activeTask ?? "None"} />
                  <Metric
                    label="Browser Mode"
                    value={state.browser ? formatBrowserMode(state.browser.activeMode) : "unobserved"}
                    tone={state.browser ? browserModeTone(state.browser.activeMode) : "neutral"}
                  />
                  <Metric label="Browser Target" value={state.browser?.browserTarget ?? state.browser?.targetBrowser ?? "unknown"} />
                </div>
                <p className="text-sm leading-6 text-white/60">
                  {summarizeHealthReasons(state.health)}
                </p>
                {state.browser?.fallbackReason ? (
                  <p className="text-sm leading-6 text-amber-200/90">
                    Browser fallback: {state.browser.fallbackReason}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <ActionButton
                    tone="secondary"
                    onClick={() => systemIntentMutation.mutate({ action: "arrange_windows", reason: "command_center_layout" })}
                  >
                    Arrange Windows
                  </ActionButton>
                  <ActionButton
                    tone="secondary"
                    onClick={() => systemIntentMutation.mutate({ action: "release_control", reason: "operator_release" })}
                  >
                    Release Control
                  </ActionButton>
                  <ActionButton
                    tone="secondary"
                    onClick={() => queryClient.invalidateQueries({ queryKey: systemKeys.state() })}
                  >
                    Refresh Snapshot
                  </ActionButton>
                </div>
              </div>
            ) : (
              <p className="text-sm text-white/50">Loading system session...</p>
            )}
          </ShellCard>

          <ShellCard eyebrow="Companion" title="Desktop Bridge">
            {state ? (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Metric label="Platform" value={state.platform} />
                  <Metric label="Runtime" value={state.companion.runtimeKind} />
                  <Metric label="Transport" value={state.companion.transport.mode} />
                  <Metric label="Heartbeat" value={formatRelative(state.companion.lastHeartbeatAt)} />
                  <Metric label="Panic Hotkey" value={state.companion.panicHotkey} mono />
                  <Metric label="Companion Safe Mode" value={state.companion.safeMode ? "active" : "clear"} tone={mapTone(state.companion.safeMode ? "warning" : "active")} />
                  <Metric label="Overlay" value={state.companion.overlayVisible ? "visible" : "hidden"} />
                  <Metric label="Browser Session" value={state.browser?.sessionId ?? "none"} mono />
                  <Metric label="Browser Tab" value={state.browser?.tabId ?? "none"} mono />
                </div>
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(state.companion.capabilities.surfaces).map(([key, enabled]) => (
                      <StatusPill key={key} tone={enabled ? "success" : "neutral"}>
                        {key}
                      </StatusPill>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(state.companion.capabilities.actions).map(([key, availability]) => (
                      <StatusPill
                        key={key}
                        tone={
                          availability === "supported"
                            ? "success"
                            : availability === "fallback"
                              ? "warning"
                              : "neutral"
                        }
                      >
                        {key}:{availability}
                      </StatusPill>
                    ))}
                  </div>
                </div>
                <p className="text-sm text-white/60">
                  Window arrangement, app focus, and notification actions route through the companion bridge first. A native panic override now drives safe mode into the shared system state so the web console reflects native companion state instead of guessing.
                </p>
              </div>
            ) : (
              <p className="text-sm text-white/50">No companion snapshot available.</p>
            )}
          </ShellCard>
        </div>
      </div>

      <div className="space-y-4">
        <ShellCard
          eyebrow="Approvals"
          title="Risk Gates"
          aside={<StatusPill tone={blockedApprovalEvents.length > 0 ? "warning" : "neutral"}>{blockedApprovalEvents.length} blocked</StatusPill>}
        >
          <div className="space-y-3">
            {approvalCards.map((card) => (
              <div key={card.action} className="rounded-[24px] border border-white/10 bg-black/20 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="font-medium text-white">{card.label}</p>
                    <p className="mt-1 text-sm leading-6 text-white/60">{card.summary}</p>
                  </div>
                  <StatusPill tone={mapTone(card.decision === "missing" ? "neutral" : card.decision)}>
                    {card.decision}
                  </StatusPill>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <ActionButton
                    tone="secondary"
                    onClick={() => systemIntentMutation.mutate({
                      action: "approve",
                      target: card.action,
                      reason: "Allowed from Command Center",
                    })}
                  >
                    Allow
                  </ActionButton>
                  <ActionButton
                    tone="danger"
                    onClick={() => systemIntentMutation.mutate({
                      action: "deny",
                      target: card.action,
                      reason: "Denied from Command Center",
                    })}
                  >
                    Deny
                  </ActionButton>
                </div>
                {card.updatedAt ? (
                  <p className="mt-3 text-xs text-white/40">Updated {formatRelative(card.updatedAt)}</p>
                ) : null}
              </div>
            ))}
          </div>
          {approvalRules.length === 0 ? (
            <p className="mt-4 text-sm text-white/50">
              No persistent approval rules exist yet. Sensitive actions will block until you allow them.
            </p>
          ) : null}
        </ShellCard>

        <ShellCard
          eyebrow="Notifications"
          title="Notification Queue"
          aside={<StatusPill tone={state?.notifications.length ? "warning" : "neutral"}>{state?.notifications.length ?? 0} queued</StatusPill>}
        >
          <div className="space-y-3">
            {state?.notifications.length ? state.notifications.slice(0, 4).map((notification) => (
              <div key={notification.id} className="rounded-[24px] border border-white/10 bg-black/20 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="font-medium text-white">{notification.title}</p>
                    <p className="mt-1 text-sm text-white/60">{notification.body ?? "No body provided."}</p>
                    <p className="mt-2 text-xs text-white/40">
                      {notification.sourceApp ?? "Unknown source"} · {formatRelative(notification.receivedAt)}
                    </p>
                  </div>
                  <StatusPill tone={notification.read ? "neutral" : "warning"}>
                    {notification.read ? "read" : "unread"}
                  </StatusPill>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <ActionButton
                    tone="secondary"
                    onClick={() => systemIntentMutation.mutate({
                      action: "notification_act",
                      reason: "notification_open",
                      notificationId: notification.id,
                      notificationAction: "open",
                    })}
                  >
                    Open
                  </ActionButton>
                  <ActionButton
                    tone="secondary"
                    onClick={() => systemIntentMutation.mutate({
                      action: "notification_act",
                      reason: "notification_mark_read",
                      notificationId: notification.id,
                      notificationAction: "mark_read",
                    })}
                  >
                    Mark Read
                  </ActionButton>
                  <ActionButton
                    tone="danger"
                    onClick={() => systemIntentMutation.mutate({
                      action: "notification_act",
                      reason: "notification_dismiss",
                      notificationId: notification.id,
                      notificationAction: "dismiss",
                    })}
                  >
                    Dismiss
                  </ActionButton>
                </div>
              </div>
            )) : (
              <p className="text-sm text-white/50">
                No notifications are currently surfaced by the companion.
              </p>
            )}
          </div>
        </ShellCard>

        <ShellCard
          eyebrow="Trusted Devices"
          title="Remote Access"
          aside={<StatusPill tone={remoteDevices.some((item) => item.status === "active") ? "success" : "neutral"}>{remoteDevices.length} devices / {remoteSessions.filter((item) => item.status === "active").length} sessions</StatusPill>}
        >
          <form
            className="space-y-3 rounded-[24px] border border-white/10 bg-black/20 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!remoteLabel.trim() || !remoteFingerprint.trim()) {
                toast.error("Label and fingerprint are required");
                return;
              }
              remoteRegisterMutation.mutate();
            }}
          >
            <div className="grid gap-3">
              <input
                value={remoteLabel}
                onChange={(event) => setRemoteLabel(event.target.value)}
                placeholder="Device label"
                className="agent-input"
              />
              <input
                value={remoteFingerprint}
                onChange={(event) => setRemoteFingerprint(event.target.value)}
                placeholder="Fingerprint"
                className="agent-input"
              />
            </div>
            <p className="text-sm text-white/55">
              Register the browser as a trusted device first, then enroll a passkey on the device card below.
            </p>
            <ActionButton type="submit" disabled={remoteRegisterMutation.isPending}>
              Register Trusted Device
            </ActionButton>
          </form>

          <div className="mt-4 space-y-3">
            {remoteDevices.length === 0 ? (
              <p className="text-sm text-white/50">No trusted devices registered yet.</p>
            ) : remoteDevices.map((device) => (
              <RemoteDeviceCard
                key={device.id}
                device={device}
                passkeysSupported={passkeysSupported}
                onEnrollPasskey={() => remoteEnrollPasskeyMutation.mutate(device.id)}
                onClearPasskey={() => remoteClearPasskeyMutation.mutate(device.id)}
                onOpenSession={() => remoteOpenSessionMutation.mutate(device.id)}
                onRevoke={() => remoteRevokeMutation.mutate(device.id)}
                enrolling={remoteEnrollPasskeyMutation.isPending && remoteEnrollPasskeyMutation.variables === device.id}
                clearingPasskey={remoteClearPasskeyMutation.isPending && remoteClearPasskeyMutation.variables === device.id}
                openingSession={remoteOpenSessionMutation.isPending && remoteOpenSessionMutation.variables === device.id}
                hasActiveSession={remoteSessions.some((sessionItem) =>
                  sessionItem.deviceId === device.id && sessionItem.status === "active"
                )}
              />
            ))}
          </div>

          <div className="mt-4 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/40">
              Remote sessions
            </p>
            {remoteSessions.length === 0 ? (
              <p className="text-sm text-white/50">
                No remote sessions recorded yet. Active trusted-device sessions will appear here once connected from a private network.
              </p>
            ) : remoteSessions.map((sessionItem) => (
              <RemoteSessionCard
                key={sessionItem.id}
                session={sessionItem}
                onClose={() => remoteCloseSessionMutation.mutate(sessionItem.id)}
              />
            ))}
          </div>
        </ShellCard>

        <ShellCard
          eyebrow="Event Timeline"
          title="System Feed"
          aside={
            <div className="flex items-center gap-2">
              <StatusPill tone={mapTone(systemEvents.connectionState)}>{systemEvents.connectionState}</StatusPill>
              <ActionButton tone="secondary" onClick={systemEvents.reconnect}>
                <RefreshCcw className="mr-2 h-4 w-4" />
                Reconnect
              </ActionButton>
            </div>
          }
        >
          {systemEvents.errorMessage ? (
            <p className="mb-3 text-sm text-amber-200">{systemEvents.errorMessage}</p>
          ) : null}
          <div className="space-y-3">
            {timelineItems.length === 0 ? (
              <p className="text-sm text-white/50">Waiting for system activity.</p>
            ) : timelineItems.map((item) => (
              <div key={item.id} className="rounded-[22px] border border-white/10 bg-black/20 p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium text-white">{item.title}</p>
                  <StatusPill tone={item.tone}>{item.tone}</StatusPill>
                </div>
                {item.detail ? <p className="mt-2 text-sm text-white/60">{item.detail}</p> : null}
                <p className="mt-2 text-xs text-white/40">{formatTimestamp(item.timestamp)}</p>
              </div>
            ))}
          </div>
        </ShellCard>
      </div>
    </div>
  );
}

function Metric(props: {
  label: string;
  value: string;
  tone?: "neutral" | "success" | "warning" | "danger";
  mono?: boolean;
  detail?: string;
}) {
  return (
    <div className="rounded-[22px] border border-white/[0.08] bg-white/[0.04] p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/40">{props.label}</p>
      <p className={`mt-2 text-sm ${props.mono ? "font-mono" : "font-medium"} text-white`}>
        {props.value}
      </p>
      {props.detail ? <p className="mt-2 text-xs text-white/45">{props.detail}</p> : null}
      {props.tone ? <StatusPill tone={props.tone} className="mt-3">{props.tone}</StatusPill> : null}
    </div>
  );
}

function RemoteDeviceCard(props: {
  device: FridaySystemRemoteDevice;
  passkeysSupported: boolean;
  onEnrollPasskey: () => void;
  onClearPasskey: () => void;
  onOpenSession: () => void;
  onRevoke: () => void;
  enrolling: boolean;
  clearingPasskey: boolean;
  openingSession: boolean;
  hasActiveSession: boolean;
}) {
  const passkey = buildRemoteDevicePasskeySummary(props.device);
  return (
    <div className="rounded-[24px] border border-white/10 bg-black/20 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium text-white">{props.device.label}</p>
          <p className="mt-1 break-all font-mono text-xs text-white/50">{props.device.fingerprint}</p>
        </div>
        <StatusPill tone={mapTone(props.device.status)}>{props.device.status}</StatusPill>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Metric label="Registered" value={formatTimestamp(props.device.registeredAt)} />
        <Metric label="Last Seen" value={formatRelative(props.device.lastSeenAt)} />
        <Metric label="Platform" value={props.device.platform} />
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Metric
          label="Passkey"
          value={passkey.label}
          tone={passkey.tone}
          detail={passkey.detail}
        />
        <Metric
          label="Passkey Last Used"
          value={props.device.credentialId ? formatRelative(props.device.passkeyLastUsedAt) : "Not yet used"}
          detail={props.device.passkeyRegisteredAt ? `Registered ${formatTimestamp(props.device.passkeyRegisteredAt)}` : undefined}
        />
        <Metric
          label="Remote Session"
          value={props.hasActiveSession ? "Active" : "Inactive"}
          tone={props.hasActiveSession ? "success" : "neutral"}
        />
      </div>
      {!props.passkeysSupported ? (
        <p className="mt-4 text-sm text-amber-200">
          This browser does not support passkey registration or assertion.
        </p>
      ) : null}
      {props.device.status === "active" ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <ActionButton
            tone="secondary"
            onClick={props.onEnrollPasskey}
            disabled={props.enrolling || !props.passkeysSupported}
          >
            {props.device.credentialId ? "Rotate Passkey" : "Enroll Passkey"}
          </ActionButton>
          {props.device.credentialId ? (
            <ActionButton
              tone="danger"
              onClick={props.onClearPasskey}
              disabled={props.clearingPasskey}
            >
              Clear Passkey
            </ActionButton>
          ) : null}
          <ActionButton
            onClick={props.onOpenSession}
            disabled={!props.device.credentialId || props.openingSession || !props.passkeysSupported}
          >
            Verify and Open Session
          </ActionButton>
          <ActionButton tone="danger" onClick={props.onRevoke}>
            Revoke Device
          </ActionButton>
        </div>
      ) : null}
      {props.device.status === "active" && !props.device.credentialId ? (
        <p className="mt-3 text-xs text-white/45">
          Remote sessions stay locked until this trusted device completes passkey enrollment.
        </p>
      ) : null}
    </div>
  );
}

function RemoteSessionCard(props: {
  session: FridaySystemRemoteSession;
  onClose: () => void;
}) {
  return (
    <div className="rounded-[24px] border border-white/10 bg-black/20 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium text-white">{props.session.ipAddress ?? "Unknown origin"}</p>
          <p className="mt-1 line-clamp-2 text-xs text-white/50">
            {props.session.userAgent ?? "No user agent captured"}
          </p>
        </div>
        <StatusPill tone={mapTone(props.session.status)}>{props.session.status}</StatusPill>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Metric label="Connected" value={formatTimestamp(props.session.connectedAt)} />
        <Metric label="Last Seen" value={formatRelative(props.session.lastSeenAt)} />
        <Metric label="Device Platform" value={props.session.devicePlatform ?? "unknown"} />
      </div>
      {props.session.status === "active" ? (
        <div className="mt-4">
          <ActionButton tone="danger" onClick={props.onClose}>
            Close Session
          </ActionButton>
        </div>
      ) : props.session.closedReason ? (
        <p className="mt-4 text-xs text-white/40">Closed: {props.session.closedReason}</p>
      ) : null}
    </div>
  );
}

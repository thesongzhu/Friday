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
import { useNavigate, useSearchParams } from "react-router-dom";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
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
import { skillsApi } from "@/lib/api/skills";
import { authStorage } from "@/lib/storage/auth-storage";
import { systemApi } from "@/lib/api/system";
import type {
  FridaySystemApprovalRule,
  FridaySystemEvent,
  FridaySystemIntentAction,
  FridaySystemNotificationAction,
  FridaySystemRemoteDevice,
  FridaySystemRemoteSession,
} from "@/lib/api/system-types";
import { useAgentRunEvents, type PendingToolApprovalViewModel } from "@/hooks/use-agent-run-events";
import { ChatAuditDrawer } from "@/components/chat/chat-audit-drawer";
import { ChatStatusBanner } from "@/components/chat/chat-status-banner";
import { ActivitySummaryPanel } from "@/components/core/activity-summary-panel";
import { BudgetIndicator } from "@/components/core/budget-indicator";
import { useSystemEvents } from "@/hooks/use-system-events";
import { systemKeys } from "@/lib/system/query-keys";
import {
  buildApprovalActionCards,
  buildRemoteDevicePasskeySummary,
  buildSystemTimelineItems,
  summarizeHealthReasons,
} from "@/lib/system/view-models";
import { buildSkillHref } from "@/lib/skills/view-models";
import { trackStarterSkillBatch, trackStarterSkillEvent } from "@/lib/skills/starter-skill-telemetry";
import {
  describeRunHealth,
  labelForRunHealth,
  summarizeRunContext,
  toneForRunHealth,
} from "@/lib/runs/run-health";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";

const OPERATOR_ID = "ui-operator";

const STARTER_SKILL_PROMPTS: Record<string, string> = {
  "repo-health-check": "Run the repo-health-check starter skill for this workspace and tell me the next useful action.",
  "workspace-change-risk-review": "Run the workspace-change-risk-review starter skill against the current workspace changes and summarize risk.",
  "release-readiness-check": "Run the release-readiness-check starter skill and tell me whether this workspace is ready to ship.",
  "system-health-snapshot": "Run the system-health-snapshot starter skill and summarize Friday runtime health, browser mode, companion state, and approvals.",
  "review-open-issues": "Run the review-open-issues starter skill and tell me what Friday has already detected, what matters most, and what I should inspect next.",
  "autofix-readiness-review": "Run the autofix-readiness-review starter skill and explain which planned repairs are safe, which need approval, and what rollback coverage exists.",
  "failed-deploy-recovery-brief": "Run the failed-deploy-recovery-brief starter skill and summarize the current failed deploy and the safest recovery path.",
  "log-error-triage": "Run the log-error-triage starter skill on the relevant local logs and cluster the recurring errors.",
  "local-service-diagnose": "Run the local-service-diagnose starter skill for the local service I am working on and explain what looks wrong.",
  "incident-brief-generator": "Run the incident-brief-generator starter skill and turn the current evidence into a concise incident brief.",
};

const ACTIVE_RUN_STATUSES = [
  "pending",
  "planning",
  "awaiting_clarification",
  "awaiting_plan_approval",
  "executing",
  "testing",
  "fixing",
] as const;

function formatTimestamp(value?: string): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function formatRelative(value?: string): string {
  if (!value) return "—";
  const ms = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "—";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(valueMs?: number): string {
  if (typeof valueMs !== "number" || !Number.isFinite(valueMs) || valueMs < 0) return "0s";
  const totalSeconds = Math.floor(valueMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 1) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return `${minutes}m ${seconds}s`;
  return `${hours}h ${minutes % 60}m`;
}

function isActiveRunStatus(status: string): status is (typeof ACTIVE_RUN_STATUSES)[number] {
  return ACTIVE_RUN_STATUSES.includes(status as (typeof ACTIVE_RUN_STATUSES)[number]);
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

function scoreStarterSkill(input: {
  skillId: string;
  task: string;
  healthStatus?: string;
  approvalCount?: number;
  blockedApprovalCount?: number;
}): number {
  const task = input.task.toLowerCase();
  let score = 0;

  if (input.healthStatus === "degraded" || input.healthStatus === "blocked") {
    if (input.skillId === "system-health-snapshot") score += 45;
    if (input.skillId === "review-open-issues") score += 35;
    if (input.skillId === "autofix-readiness-review") score += 25;
    if (input.skillId === "local-service-diagnose") score += 40;
    if (input.skillId === "incident-brief-generator") score += 20;
  }

  if ((input.approvalCount ?? 0) > 0 || (input.blockedApprovalCount ?? 0) > 0) {
    if (input.skillId === "autofix-readiness-review") score += 60;
    if (input.skillId === "review-open-issues") score += 40;
  }

  if (task.length === 0) {
    if (input.skillId === "system-health-snapshot") score += 18;
    if (input.skillId === "repo-health-check") score += 15;
    if (input.skillId === "release-readiness-check") score += 10;
  }

  if (/(repo|workspace|next step|what should i do)/.test(task) && input.skillId === "repo-health-check") score += 60;
  if (/(diff|change|risk|review)/.test(task) && input.skillId === "workspace-change-risk-review") score += 60;
  if (/(release|ship|deploy|lint|test|build|typecheck)/.test(task) && input.skillId === "release-readiness-check") score += 60;
  if (/(system|runtime|browser|companion|permission|snapshot|desktop)/.test(task) && input.skillId === "system-health-snapshot") score += 65;
  if (/(issue|problem|broken|wrong|incident|approval)/.test(task) && input.skillId === "review-open-issues") score += 70;
  if (/(repair|self.?heal|auto.?fix|approval|rollback|safe fix)/.test(task) && input.skillId === "autofix-readiness-review") score += 75;
  if (/(failed deploy|deployment failed|recover deploy|workflow failed|deploy recovery)/.test(task) && input.skillId === "failed-deploy-recovery-brief") score += 80;
  if (/(log|error|exception|stack|triage)/.test(task) && input.skillId === "log-error-triage") score += 60;
  if (/(service|health|port|process|server|diagnose)/.test(task) && input.skillId === "local-service-diagnose") score += 60;
  if (/(incident|brief|summary|postmortem)/.test(task) && input.skillId === "incident-brief-generator") score += 60;

  return score;
}

/* ── Risk-level badge config ── */
const RISK_BADGE: Record<
  NonNullable<PendingToolApprovalViewModel["riskLevel"]>,
  { tone: "success" | "warning" | "danger"; en: string; zh: string }
> = {
  safe:        { tone: "success", en: "SAFE",        zh: "安全" },
  guarded:     { tone: "warning", en: "GUARDED",     zh: "受控" },
  destructive: { tone: "danger",  en: "DESTRUCTIVE", zh: "危险" },
  blocked:     { tone: "danger",  en: "BLOCKED",     zh: "禁止" },
};

const RISK_HELP_TEXT: Record<
  NonNullable<PendingToolApprovalViewModel["riskLevel"]>,
  { en: string; zh: string }
> = {
  safe:        { zh: "此操作是安全的，不会修改重要数据。",         en: "This operation is safe and won't modify important data." },
  guarded:     { zh: "此操作受保护，Friday 会小心执行。",         en: "This operation is protected. Friday will proceed carefully." },
  destructive: { zh: "此操作会修改或删除数据，请仔细确认。",      en: "This operation may modify or delete data. Please confirm carefully." },
  blocked:     { zh: "此操作被安全策略禁止。",                    en: "This operation is blocked by safety policy." },
};

function ApprovalCard({
  approval,
  locale,
  onApprove,
  onReject,
  disabled,
}: {
  approval: PendingToolApprovalViewModel;
  locale: string;
  onApprove: () => void;
  onReject: () => void;
  disabled: boolean;
}) {
  const [showParams, setShowParams] = useState(false);
  const badge = approval.riskLevel ? RISK_BADGE[approval.riskLevel] : null;
  const paramKeys = approval.params ? Object.keys(approval.params) : [];

  return (
    <div
      className="mb-3 rounded-2xl border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] p-3 text-sm text-[color:var(--color-text-primary)]"
    >
      <p className="mb-2 flex items-center gap-2 font-medium">
        <span>
          Friday wants to use{" "}
          <span className="font-mono font-bold text-[color:var(--color-text-primary)]">
            {approval.toolName}
          </span>
        </span>
        {badge && (
          <StatusPill tone={badge.tone}>
            {locale === "zh" ? badge.zh : badge.en}
          </StatusPill>
        )}
      </p>
      {approval.riskLevel && (
        <p className="mb-2 text-[11px] text-[color:var(--color-text-faint)]">
          {locale === "zh" ? RISK_HELP_TEXT[approval.riskLevel].zh : RISK_HELP_TEXT[approval.riskLevel].en}
        </p>
      )}
      <p className="mb-3 text-xs text-[color:var(--color-text-secondary)]">{approval.reason}</p>

      {paramKeys.length > 0 && (
        <div className="mb-3">
          <button
            type="button"
            onClick={() => setShowParams((v) => !v)}
            className="text-xs font-medium text-[color:var(--color-text-tertiary)] hover:text-[color:var(--color-text-secondary)] transition-colors"
          >
            {showParams
              ? (locale === "zh" ? "收起参数" : "Hide params")
              : (locale === "zh" ? "查看参数" : "Show params")}
          </button>
          {showParams && (
            <dl className="mt-2 space-y-1 rounded-xl bg-[color:var(--color-bg-subtle)] p-2 text-xs">
              {paramKeys.map((key) => (
                <div key={key} className="flex gap-2">
                  <dt className="shrink-0 font-mono font-semibold text-[color:var(--color-text-secondary)]">{key}:</dt>
                  <dd className="break-all text-[color:var(--color-text-tertiary)]">
                    {typeof approval.params![key] === "string"
                      ? (approval.params![key] as string)
                      : JSON.stringify(approval.params![key])}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <ActionButton tone="secondary" onClick={onApprove} disabled={disabled}>
          {localize(locale as "zh" | "en", "批准", "Approve")}
        </ActionButton>
        <ActionButton tone="danger" onClick={onReject} disabled={disabled}>
          {localize(locale as "zh" | "en", "拒绝", "Reject")}
        </ActionButton>
      </div>
    </div>
  );
}

export function AgentPage() {
  const navigate = useNavigate();
  const { locale } = useAppLocale();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [task, setTask] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [auditDrawerOpen, setAuditDrawerOpen] = useState(false);
  const [remoteLabel, setRemoteLabel] = useState("");
  const [remoteFingerprint, setRemoteFingerprint] = useState("");
  const passkeysSupported = typeof PublicKeyCredential !== "undefined";
  const operatorUserId = authStorage.getUser()?.id?.trim() || "anonymous";
  const commandCenterSessionKey = `ui:command-center:${operatorUserId}`;
  const runIdFromUrl = searchParams.get("runId");

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
    refetchInterval: 5_000,
  });

  const { data: currentRun } = useQuery({
    queryKey: ["agent-os", "runs", currentRunId],
    queryFn: () => agentApi.getRun(currentRunId!),
    enabled: currentRunId !== null,
    refetchInterval: 5_000,
  });

  const { data: starterSkills = [] } = useQuery({
    queryKey: ["agent-os", "starter-skills"],
    queryFn: async () => {
      const skills = await skillsApi.listSkills();
      return skills.filter((skill) => skill.starter);
    },
    retry: 0,
    refetchInterval: 30_000,
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
  const recommendedStarterSkills = useMemo(
    () => starterSkills
      .map((skill) => ({
        ...skill,
        score: scoreStarterSkill({
          skillId: skill.skillId,
          task,
          healthStatus: state?.health.status,
          approvalCount: approvalCards.length,
          blockedApprovalCount: blockedApprovalEvents.length,
        }),
      }))
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
      .slice(0, 3),
    [approvalCards.length, blockedApprovalEvents.length, starterSkills, task, state?.health.status],
  );

  useEffect(() => {
    if (runIdFromUrl && runIdFromUrl !== currentRunId) {
      setCurrentRunId(runIdFromUrl);
    }
  }, [currentRunId, runIdFromUrl]);

  useEffect(() => {
    if (!currentRunId || currentRunId === runIdFromUrl) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("runId", currentRunId);
      return next;
    }, { replace: true });
  }, [currentRunId, runIdFromUrl, setSearchParams]);

  useEffect(() => {
    if (currentRunId) return;
    const active = deferredRuns.find((run) => isActiveRunStatus(run.status));
    if (active) {
      setCurrentRunId(active.id);
    }
  }, [currentRunId, deferredRuns]);

  useEffect(() => {
    if (recommendedStarterSkills.length === 0) return;
    trackStarterSkillBatch("starter_skill_suggested", {
      skillIds: recommendedStarterSkills.map((skill) => skill.skillId),
      source: "command_center",
      metadata: { taskLength: task.trim().length, healthStatus: state?.health.status },
    });
  }, [recommendedStarterSkills, state?.health.status, task]);

  const startRunMutation = useMutation({
    mutationFn: (input: { task: string; readOnly: boolean }) =>
      agentApi.startRun({
        task: input.task,
        readOnly: input.readOnly,
        requireReview: false,
        sessionKey: commandCenterSessionKey,
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
      toast.error(error instanceof Error ? error.message : localize(locale, "启动运行失败", "Failed to start run"));
    },
  });

  const cancelRunMutation = useMutation({
    mutationFn: (runId: string) => agentApi.cancelRun(runId),
    onSuccess: () => {
      toast.success("Run cancelled");
      void refetchRuns();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "取消运行失败", "Failed to cancel run"));
    },
  });

  const approvePlanMutation = useMutation({
    mutationFn: (runId: string) => agentApi.approvePlan(runId),
    onSuccess: async (result) => {
      toast.success("Plan approved");
      setCurrentRunId(result.runId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-os", "runs"] }),
        queryClient.invalidateQueries({ queryKey: ["agent-os", "runs", result.runId] }),
      ]);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "批准计划失败", "Failed to approve plan"));
    },
  });

  const rejectPlanMutation = useMutation({
    mutationFn: (runId: string) => agentApi.rejectPlan(runId),
    onSuccess: async (result) => {
      toast.success("Plan rejected");
      setCurrentRunId(result.runId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-os", "runs"] }),
        queryClient.invalidateQueries({ queryKey: ["agent-os", "runs", result.runId] }),
      ]);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "拒绝计划失败", "Failed to reject plan"));
    },
  });

  const approveToolMutation = useMutation({
    mutationFn: (input: { runId: string; toolCallId: string }) =>
      agentApi.approveTool(input.runId, input.toolCallId),
    onSuccess: () => {
      toast.success("Tool approved");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "批准工具使用失败", "Failed to approve tool"));
    },
  });

  const rejectToolMutation = useMutation({
    mutationFn: (input: { runId: string; toolCallId: string; reason?: string }) =>
      agentApi.rejectTool(input.runId, input.toolCallId, input.reason),
    onSuccess: () => {
      toast.success("Tool rejected");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "拒绝工具使用失败", "Failed to reject tool"));
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
      toast.error(error instanceof Error ? error.message : localize(locale, "系统操作失败", "System action failed"));
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
      toast.error(error instanceof Error ? error.message : localize(locale, "注册受信设备失败", "Failed to register trusted device"));
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
      toast.error(error instanceof Error ? error.message : localize(locale, "撤销受信设备失败", "Failed to revoke trusted device"));
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
      toast.error(error instanceof Error ? error.message : localize(locale, "清除设备通行密钥失败", "Failed to clear trusted-device passkey"));
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
      toast.error(error instanceof Error ? error.message : localize(locale, "关闭远程会话失败", "Failed to close remote session"));
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
      toast.error(error instanceof Error ? error.message : localize(locale, "注册通行密钥失败", "Failed to enroll passkey"));
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
      toast.error(error instanceof Error ? error.message : localize(locale, "打开远程会话失败", "Failed to open remote session"));
    },
  });

  const commandCenterError = sessionError ?? stateError;
  const approvalRules = approvalsResponse?.items ?? [];
  const runOutputText = runEvents.outputText
    || currentRun?.responseText
    || currentRun?.planReview?.gate?.planMarkdown
    || currentRun?.planReview?.gate?.planSummary
    || "";

  return (
    <div className="grid gap-4 xl:grid-cols-[1.35fr_0.95fr]">
      <div className="space-y-4">
        <ActivitySummaryPanel />
        <ShellCard
          eyebrow={locale === "zh" ? "操作控制台" : "Operator Console"}
          title={locale === "zh" ? "命令中心" : "Command Center"}
          aside={
            <div className="flex items-center gap-2">
              <BudgetIndicator />
              <StatusPill tone={mapTone(runEvents.connectionState)}>{runEvents.connectionState}</StatusPill>
            </div>
          }
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!task.trim()) return;
              startRunMutation.mutate({ task: task.trim(), readOnly });
            }}
          >
            <div className="rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
              <label className="mb-2 flex items-center gap-2 text-sm font-medium text-[color:var(--color-text-primary)]">
                <Command className="h-4 w-4 text-[color:var(--color-accent)]" />
                {locale === "zh" ? "发送新的操作任务" : "Send a new operator task"}
              </label>
              <textarea
                value={task}
                onChange={(event) => setTask(event.target.value)}
                rows={5}
                className="agent-textarea"
                placeholder={locale === "zh" ? "例如：打开工作区、检查系统权限并准备下一个构建任务。" : "Example: open the workspace, inspect system permissions, and prepare the next build task."}
              />
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <label className="inline-flex items-center gap-2 text-sm text-[color:var(--color-text-secondary)]">
                  <input
                    type="checkbox"
                    checked={readOnly}
                    onChange={(event) => setReadOnly(event.target.checked)}
                    className="rounded border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-surface)]"
                  />
                  {locale === "zh" ? "以只读模式启动" : "Start in read-only mode"}
                </label>
                <div className="flex flex-wrap gap-2">
                  <ActionButton
                    tone="secondary"
                    onClick={() => systemIntentMutation.mutate({ action: "request_control", reason: "command_center" })}
                  >
                    {locale === "zh" ? "请求控制" : "Request Control"}
                  </ActionButton>
                  <ActionButton
                    tone="secondary"
                    onClick={() => systemIntentMutation.mutate({ action: "recover_ui", reason: "operator_recovery" })}
                  >
                    {locale === "zh" ? "恢复界面" : "Recover UI"}
                  </ActionButton>
                  <ActionButton type="submit" disabled={startRunMutation.isPending || task.trim().length === 0}>
                    {locale === "zh" ? "启动运行" : "Launch Run"}
                  </ActionButton>
                </div>
              </div>
            </div>
          </form>
        </ShellCard>

        <ShellCard
          eyebrow={locale === "zh" ? "推荐技能" : "Recommended Skills"}
          title={locale === "zh" ? "本会话的入门包匹配" : "Starter pack matches for this session"}
          aside={<StatusPill tone={recommendedStarterSkills.length > 0 ? "success" : "neutral"}>{recommendedStarterSkills.length} {locale === "zh" ? "推荐" : "suggested"}</StatusPill>}
        >
          <div className="grid gap-3">
            {recommendedStarterSkills.length === 0 ? (
              <p className="text-sm text-[color:var(--color-text-tertiary)]">{locale === "zh" ? "技能注册表加载后将显示入门推荐。" : "Starter recommendations will appear once the skill registry is loaded."}</p>
            ) : recommendedStarterSkills.map((skill) => (
              <div key={skill.skillId} className="agent-subcard">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{skill.name}</p>
                    <p className="mt-2 text-sm leading-6 text-[color:var(--color-text-secondary)]">{skill.description ?? (locale === "zh" ? "内置入门技能。" : "Bundled starter skill.")}</p>
                  </div>
                  <StatusPill tone="success">starter</StatusPill>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <ActionButton
                    tone="secondary"
                    onClick={() => {
                      const prompt = STARTER_SKILL_PROMPTS[skill.skillId] ?? `Run the ${skill.skillId} starter skill for the current context.`;
                      setTask(prompt);
                      trackStarterSkillEvent("starter_skill_invoked", {
                        skillId: skill.skillId,
                        source: "command_center_prefill",
                      });
                    }}
                  >
                    {locale === "zh" ? "使用技能" : "Use Skill"}
                  </ActionButton>
                  <ActionButton
                    tone="secondary"
                    onClick={() => {
                      trackStarterSkillEvent("starter_skill_detail_opened", {
                        skillId: skill.skillId,
                        source: "command_center_details",
                      });
                      navigate(buildSkillHref(skill.skillId));
                    }}
                  >
                    {locale === "zh" ? "查看详情" : "Open Details"}
                  </ActionButton>
                </div>
              </div>
            ))}
          </div>
        </ShellCard>

        <ShellCard
          eyebrow={locale === "zh" ? "实时运行" : "Live Run"}
          title={locale === "zh" ? "执行控制台" : "Execution Console"}
          aside={latestBrowserTool?.presentationMode ? (
            <StatusPill tone={browserModeTone(latestBrowserTool.presentationMode)}>
              {formatBrowserMode(latestBrowserTool.presentationMode)}
            </StatusPill>
          ) : undefined}
        >
          <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Metric
              label="Phase"
              value={runEvents.progress.phase ?? runEvents.status ?? "idle"}
              tone={mapTone(runEvents.progress.phase ?? runEvents.status ?? "neutral")}
            />
            <Metric
              label="Elapsed"
              value={formatDuration(runEvents.progress.elapsedMs)}
              tone={runEvents.progress.elapsedMs >= 30_000 ? "warning" : "neutral"}
            />
            <Metric
              label="ETA"
              value={
                typeof runEvents.progress.eta === "number"
                  ? `up to ${formatDuration(runEvents.progress.eta)}`
                  : "ETA unavailable"
              }
            />
            <Metric
              label="Active Tool"
              value={runEvents.progress.activeTool ?? "none"}
            />
            <Metric
              label="Subagents"
              value={String(runEvents.progress.subagentCount)}
              tone={runEvents.progress.subagentCount > 0 ? "success" : "neutral"}
            />
            <Metric
              label="Run Link"
              value={currentRunId ? `/command-center?runId=${currentRunId}` : "no active run"}
              mono
            />
          </div>
          <div className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
            <div className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">Run output</p>
                  <p className="text-xs text-[color:var(--color-text-tertiary)]">
                    {currentRunId ? `Run ${currentRunId}` : "No active run selected"}
                  </p>
                </div>
                {currentRun?.status === "awaiting_plan_approval" ? (
                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      tone="secondary"
                      onClick={() => approvePlanMutation.mutate(currentRun.id)}
                      disabled={approvePlanMutation.isPending || rejectPlanMutation.isPending}
                    >
                      {locale === "zh" ? "批准计划" : "Approve Plan"}
                    </ActionButton>
                    <ActionButton
                      tone="danger"
                      onClick={() => rejectPlanMutation.mutate(currentRun.id)}
                      disabled={approvePlanMutation.isPending || rejectPlanMutation.isPending}
                    >
                      {locale === "zh" ? "拒绝计划" : "Reject Plan"}
                    </ActionButton>
                  </div>
                ) : currentRunId ? (
                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      tone="secondary"
                      onClick={() => setAuditDrawerOpen(true)}
                    >
                      {locale === "zh" ? "查看审计" : "View Audit"}
                    </ActionButton>
                    <ActionButton
                      tone="danger"
                      onClick={() => cancelRunMutation.mutate(currentRunId)}
                      disabled={cancelRunMutation.isPending}
                    >
                      {locale === "zh" ? "取消" : "Cancel"}
                    </ActionButton>
                  </div>
                ) : null}
              </div>
              {currentRun?.status === "awaiting_clarification" && currentRun.planReview?.gate?.clarificationQuestions?.length ? (
                <div className="mb-3 rounded-2xl border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] p-3 text-sm text-[color:var(--color-text-primary)]">
                  {locale === "zh" ? "等待澄清。下一个问题：" : "Waiting for clarification. Next question: "}{currentRun.planReview.gate.clarificationQuestions[0]}
                </div>
              ) : null}
              {currentRun?.status === "awaiting_plan_approval" && currentRun.planReview?.gate?.approvalPrompt ? (
                <div className="mb-3 rounded-2xl border border-[color:var(--color-accent-soft)] bg-[color:var(--color-accent-muted)] p-3 text-sm text-[color:var(--color-text-primary)]">
                  {currentRun.planReview.gate.approvalPrompt}
                </div>
              ) : null}
              {runEvents.statusBanners.length > 0 && (
                <div className="mb-3">
                  <ChatStatusBanner banners={runEvents.statusBanners} />
                </div>
              )}
              {runEvents.pendingToolApprovals.map((approval) => (
                <ApprovalCard
                  key={approval.toolCallId}
                  approval={approval}
                  locale={locale}
                  onApprove={() =>
                    approveToolMutation.mutate({
                      runId: approval.runId,
                      toolCallId: approval.toolCallId,
                    })
                  }
                  onReject={() =>
                    rejectToolMutation.mutate({
                      runId: approval.runId,
                      toolCallId: approval.toolCallId,
                    })
                  }
                  disabled={approveToolMutation.isPending || rejectToolMutation.isPending}
                />
              ))}
              <pre className="agent-console">
                {runOutputText || "Start a run to stream live model output, tool activity, and terminal state here."}
              </pre>
            </div>

            <div className="space-y-3">
              <div className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
                  Tools and Subagents
                </p>
                <div className="mt-3 space-y-2">
                  {runEvents.toolCalls.length === 0 && runEvents.subagents.length === 0 ? (
                    <p className="text-sm text-[color:var(--color-text-tertiary)]">No tool activity yet.</p>
                  ) : null}
                  {runEvents.toolCalls.slice(-4).map((tool) => (
                    <div key={tool.id} className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium text-[color:var(--color-text-primary)]">{tool.toolName}</span>
                        <div className="flex flex-wrap items-center gap-2">
                          {tool.toolName === "browser" && tool.presentationMode ? (
                            <StatusPill tone={browserModeTone(tool.presentationMode)}>
                              {formatBrowserMode(tool.presentationMode)}
                            </StatusPill>
                          ) : null}
                          <StatusPill tone={mapTone(tool.status)}>{tool.status}</StatusPill>
                        </div>
                      </div>
                      <p className="mt-2 text-xs text-[color:var(--color-text-tertiary)]">
                        {tool.summary
                          ?? (tool.toolName === "browser"
                            ? tool.targetUrl ?? "Browser action in progress."
                            : "Tool call completed without a summary.")}
                      </p>
                      {tool.toolName === "browser" && tool.browserTarget ? (
                        <p className="mt-2 text-[11px] text-[color:var(--color-text-faint)]">
                          Target: {tool.browserTarget}
                        </p>
                      ) : null}
                      {tool.toolName === "browser" && tool.fallbackReason ? (
                        <p className="mt-2 text-[11px] text-[color:var(--color-text-secondary)]">
                          Fallback: {tool.fallbackReason}
                        </p>
                      ) : null}
                    </div>
                  ))}
                  {runEvents.subagents.slice(-4).map((subagent) => (
                    <div key={subagent.id} className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-accent-muted)] p-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium text-[color:var(--color-text-primary)]">subagent</span>
                        <StatusPill tone={mapTone(subagent.status)}>{subagent.status}</StatusPill>
                      </div>
                      <p className="mt-2 text-xs text-[color:var(--color-text-tertiary)]">{subagent.task || subagent.id}</p>
                      <p className="mt-2 text-[11px] text-[color:var(--color-text-faint)]">
                        Started {formatTimestamp(subagent.startedAt)}
                        {subagent.durationMs ? ` · ${formatDuration(subagent.durationMs)}` : ""}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
                  Recent runs
                </p>
                <div className="mt-3 space-y-2">
                  {deferredRuns.length === 0 ? (
                    <p className="text-sm text-[color:var(--color-text-tertiary)]">No runs recorded yet.</p>
                  ) : deferredRuns.map((run) => (
                    <button
                      key={run.id}
                      type="button"
                      onClick={() => setCurrentRunId(run.id)}
                      className="w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-3 text-left transition hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg-surface-strong)]"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="line-clamp-1 font-medium text-[color:var(--color-text-primary)]">{run.task}</span>
                        <StatusPill tone={toneForRunHealth(run)}>{labelForRunHealth(run, "en")}</StatusPill>
                      </div>
                      <p className="mt-2 text-xs text-[color:var(--color-text-tertiary)]">
                        {formatTimestamp(run.startedAt)}
                        {describeRunHealth(run, "en")
                          ? ` · ${describeRunHealth(run, "en")}`
                          : summarizeRunContext(run, "en")
                            ? ` · ${summarizeRunContext(run, "en")}`
                            : run.status === "awaiting_plan_approval" && run.planReview?.gate?.planSummary
                              ? ` · ${run.planReview.gate.planSummary}`
                              : ""}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </ShellCard>

        <div className="grid gap-4 lg:grid-cols-2">
          <ShellCard eyebrow={locale === "zh" ? "系统状态" : "System Truth"} title={locale === "zh" ? "当前会话" : "Current Session"}>
            {commandCenterError ? (
              <p className="text-sm text-[color:var(--color-text-primary)]">
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
                <p className="text-sm leading-6 text-[color:var(--color-text-secondary)]">
                  {summarizeHealthReasons(state.health, locale)}
                </p>
                {state.browser?.fallbackReason ? (
                  <p className="text-sm leading-6 text-[color:var(--color-text-secondary)]">
                    Browser fallback: {state.browser.fallbackReason}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <ActionButton
                    tone="secondary"
                    onClick={() => systemIntentMutation.mutate({ action: "arrange_windows", reason: "command_center_layout" })}
                  >
                    {locale === "zh" ? "排列窗口" : "Arrange Windows"}
                  </ActionButton>
                  <ActionButton
                    tone="secondary"
                    onClick={() => systemIntentMutation.mutate({ action: "release_control", reason: "operator_release" })}
                  >
                    {locale === "zh" ? "释放控制" : "Release Control"}
                  </ActionButton>
                  <ActionButton
                    tone="secondary"
                    onClick={() => queryClient.invalidateQueries({ queryKey: systemKeys.state() })}
                  >
                    {locale === "zh" ? "刷新快照" : "Refresh Snapshot"}
                  </ActionButton>
                </div>
              </div>
            ) : (
              <p className="text-sm text-[color:var(--color-text-tertiary)]">Loading system session...</p>
            )}
          </ShellCard>

          <ShellCard eyebrow={locale === "zh" ? "伴侣应用" : "Companion"} title={locale === "zh" ? "桌面桥接" : "Desktop Bridge"}>
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
                <p className="text-sm text-[color:var(--color-text-secondary)]">
                  Window arrangement, app focus, and notification actions route through the companion bridge first. A native panic override now drives safe mode into the shared system state so the web console reflects native companion state instead of guessing.
                </p>
              </div>
            ) : (
              <p className="text-sm text-[color:var(--color-text-tertiary)]">{locale === "zh" ? "暂无伴侣应用快照。" : "No companion snapshot available."}</p>
            )}
          </ShellCard>
        </div>
      </div>

      <div className="space-y-4">
        <ShellCard
          eyebrow={locale === "zh" ? "审批" : "Approvals"}
          title={locale === "zh" ? "风险门控" : "Risk Gates"}
          aside={<StatusPill tone={blockedApprovalEvents.length > 0 ? "warning" : "neutral"}>{blockedApprovalEvents.length} {locale === "zh" ? "已阻止" : "blocked"}</StatusPill>}
        >
          <div className="space-y-3">
            {approvalCards.map((card) => (
              <div key={card.action} className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="font-medium text-[color:var(--color-text-primary)]">{card.label}</p>
                    <p className="mt-1 text-sm leading-6 text-[color:var(--color-text-secondary)]">{card.summary}</p>
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
                      reason: locale === "zh" ? "已从命令中心允许" : "Allowed from Command Center",
                    })}
                  >
                    {locale === "zh" ? "允许" : "Allow"}
                  </ActionButton>
                  <ActionButton
                    tone="danger"
                    onClick={() => systemIntentMutation.mutate({
                      action: "deny",
                      target: card.action,
                      reason: locale === "zh" ? "已从命令中心拒绝" : "Denied from Command Center",
                    })}
                  >
                    {locale === "zh" ? "拒绝" : "Deny"}
                  </ActionButton>
                </div>
                {card.updatedAt ? (
                  <p className="mt-3 text-xs text-[color:var(--color-text-faint)]">Updated {formatRelative(card.updatedAt)}</p>
                ) : null}
              </div>
            ))}
          </div>
          {approvalRules.length === 0 ? (
            <p className="mt-4 text-sm text-[color:var(--color-text-tertiary)]">
              {locale === "zh" ? "暂无持久审批规则。敏感操作将被阻止，直到您允许。" : "No persistent approval rules exist yet. Sensitive actions will block until you allow them."}
            </p>
          ) : null}
        </ShellCard>

        <ShellCard
          eyebrow={locale === "zh" ? "通知" : "Notifications"}
          title={locale === "zh" ? "通知队列" : "Notification Queue"}
          aside={<StatusPill tone={state?.notifications.length ? "warning" : "neutral"}>{state?.notifications.length ?? 0} {locale === "zh" ? "排队中" : "queued"}</StatusPill>}
        >
          <div className="space-y-3">
            {state?.notifications.length ? state.notifications.slice(0, 4).map((notification) => (
              <div key={notification.id} className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="font-medium text-[color:var(--color-text-primary)]">{notification.title}</p>
                    <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">{notification.body ?? (locale === "zh" ? "无内容。" : "No body provided.")}</p>
                    <p className="mt-2 text-xs text-[color:var(--color-text-faint)]">
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
                    {locale === "zh" ? "打开" : "Open"}
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
                    {locale === "zh" ? "标为已读" : "Mark Read"}
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
                    {locale === "zh" ? "忽略" : "Dismiss"}
                  </ActionButton>
                </div>
              </div>
            )) : (
              <p className="text-sm text-[color:var(--color-text-tertiary)]">
                {locale === "zh" ? "伴侣应用当前没有待处理的通知。" : "No notifications are currently surfaced by the companion."}
              </p>
            )}
          </div>
        </ShellCard>

        <ShellCard
          eyebrow={locale === "zh" ? "受信设备" : "Trusted Devices"}
          title={locale === "zh" ? "远程访问" : "Remote Access"}
          aside={<StatusPill tone={remoteDevices.some((item) => item.status === "active") ? "success" : "neutral"}>{remoteDevices.length} devices / {remoteSessions.filter((item) => item.status === "active").length} sessions</StatusPill>}
        >
          <form
            className="space-y-3 rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!remoteLabel.trim() || !remoteFingerprint.trim()) {
                toast.error(locale === "zh" ? "需要标签和指纹" : "Label and fingerprint are required");
                return;
              }
              remoteRegisterMutation.mutate();
            }}
          >
            <div className="grid gap-3">
              <input
                value={remoteLabel}
                onChange={(event) => setRemoteLabel(event.target.value)}
                placeholder={locale === "zh" ? "设备标签" : "Device label"}
                className="agent-input"
              />
              <input
                value={remoteFingerprint}
                onChange={(event) => setRemoteFingerprint(event.target.value)}
                placeholder={locale === "zh" ? "指纹" : "Fingerprint"}
                className="agent-input"
              />
            </div>
            <p className="text-sm text-[color:var(--color-text-tertiary)]">
              {locale === "zh" ? "先将浏览器注册为受信设备，然后在下方的设备卡片中注册通行密钥。" : "Register the browser as a trusted device first, then enroll a passkey on the device card below."}
            </p>
            <ActionButton type="submit" disabled={remoteRegisterMutation.isPending}>
              {locale === "zh" ? "注册受信设备" : "Register Trusted Device"}
            </ActionButton>
          </form>

          <div className="mt-4 space-y-3">
            {remoteDevices.length === 0 ? (
              <p className="text-sm text-[color:var(--color-text-tertiary)]">{locale === "zh" ? "暂无已注册的受信设备。" : "No trusted devices registered yet."}</p>
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
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
              {locale === "zh" ? "远程会话" : "Remote sessions"}
            </p>
            {remoteSessions.length === 0 ? (
              <p className="text-sm text-[color:var(--color-text-tertiary)]">
                {locale === "zh" ? "暂无远程会话记录。从私有网络连接后，受信设备的活跃会话将显示在此。" : "No remote sessions recorded yet. Active trusted-device sessions will appear here once connected from a private network."}
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
          eyebrow={locale === "zh" ? "事件时间线" : "Event Timeline"}
          title={locale === "zh" ? "系统动态" : "System Feed"}
          aside={
            <div className="flex items-center gap-2">
              <StatusPill tone={mapTone(systemEvents.connectionState)}>{systemEvents.connectionState}</StatusPill>
              <ActionButton tone="secondary" onClick={systemEvents.reconnect}>
                <RefreshCcw className="mr-2 h-4 w-4" />
                {locale === "zh" ? "重新连接" : "Reconnect"}
              </ActionButton>
            </div>
          }
        >
          {systemEvents.errorMessage ? (
            <p className="mb-3 text-sm text-[color:var(--color-text-primary)]">{systemEvents.errorMessage}</p>
          ) : null}
          <div className="space-y-3">
            {timelineItems.length === 0 ? (
              <p className="text-sm text-[color:var(--color-text-tertiary)]">{locale === "zh" ? "等待系统活动。" : "Waiting for system activity."}</p>
            ) : timelineItems.map((item) => (
              <div key={item.id} className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium text-[color:var(--color-text-primary)]">{item.title}</p>
                  <StatusPill tone={item.tone}>{item.tone}</StatusPill>
                </div>
                {item.detail ? <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">{item.detail}</p> : null}
                <p className="mt-2 text-xs text-[color:var(--color-text-faint)]">{formatTimestamp(item.timestamp)}</p>
              </div>
            ))}
          </div>
        </ShellCard>
      </div>
      {currentRunId && (
        <ChatAuditDrawer
          runId={currentRunId}
          open={auditDrawerOpen}
          onClose={() => setAuditDrawerOpen(false)}
        />
      )}
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
    <div className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">{props.label}</p>
      <p className={`mt-2 text-sm ${props.mono ? "font-mono" : "font-medium"} text-[color:var(--color-text-primary)]`}>
        {props.value}
      </p>
      {props.detail ? <p className="mt-2 text-xs text-[color:var(--color-text-faint)]">{props.detail}</p> : null}
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
    <div className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium text-[color:var(--color-text-primary)]">{props.device.label}</p>
          <p className="mt-1 break-all font-mono text-xs text-[color:var(--color-text-tertiary)]">{props.device.fingerprint}</p>
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
        <p className="mt-4 text-sm text-[color:var(--color-text-primary)]">
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
        <p className="mt-3 text-xs text-[color:var(--color-text-faint)]">
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
    <div className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium text-[color:var(--color-text-primary)]">{props.session.ipAddress ?? "Unknown origin"}</p>
          <p className="mt-1 line-clamp-2 text-xs text-[color:var(--color-text-tertiary)]">
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
        <p className="mt-4 text-xs text-[color:var(--color-text-faint)]">Closed: {props.session.closedReason}</p>
      ) : null}
    </div>
  );
}

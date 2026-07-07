import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import {
  ArrowRight,
  Bot,
  Clock3,
  Command,
  Pin,
  RotateCcw,
  Sparkles,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { ProviderTruthCard, ProviderTruthCompact } from "@/components/console/shell/provider-truth";
import { PackCard } from "@/components/packs/pack-card";
import { PackQuickSheet } from "@/components/packs/pack-quick-sheet";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";
import { useAdaptivePollingInterval } from "@/hooks/use-adaptive-polling";
import { useAppNavigate } from "@/hooks/use-app-navigate";
import { useCustomPacks } from "@/hooks/use-custom-packs";
import { useHomeSurfacePreferences } from "@/hooks/use-home-surface-preferences";
import { usePackLaunchActions } from "@/hooks/use-pack-launch-actions";
import { useProviderTruthQuery } from "@/hooks/use-provider-truth";
import { useSystemHealthQuery, type SystemHealthStatus } from "@/hooks/use-system-health";
import { useUserProfile } from "@/hooks/use-user-profile";
import { automationsApi } from "@/lib/api/automations";
import { requestCommandPaletteOpen } from "@/lib/command-palette";
import { learningApi } from "@/lib/api/learning";
import { healthApi } from "@/lib/api/health";
import { type AgentAutomationRecord, type AgentRunRecord, type FridayLearningOverview } from "@/lib/api/types";
import { uixSnapshotsApi } from "@/lib/api/uix-snapshots";
import {
  FRIDAY_SETUP_READINESS_SESSION_KEY,
  FridayReadinessSummaryPanel,
} from "@/components/setup/friday-readiness-summary";
import { recordPageVisit } from "@/lib/home/intent-engine";
import { localize } from "@/lib/i18n/localized-text";
import { findPackRuns } from "@/lib/packs/pack-assistant-receipt";
import { buildPackAssistantHref, buildPackChatHref, buildPackFlowHref } from "@/lib/packs/pack-links";
import { buildCustomPackId, getPackById } from "@/lib/packs/pack-registry";
import {
  describeRunHealth,
  displayRunPreview,
  displayRunTask,
  labelForRunHealth,
  summarizeRunContext,
  toneForRunHealth,
} from "@/lib/runs/run-health";
import { buildSkillHref } from "@/lib/skills/view-models";
import { cn } from "@/lib/utils/cn";
import { useAppLocale } from "@/providers/locale-provider";

const ACTIVE_RUN_STATUSES = new Set([
  "pending",
  "planning",
  "awaiting_clarification",
  "awaiting_plan_approval",
  "awaiting_tool_approval",
  "executing",
  "testing",
  "fixing",
]);

type FridayPetStageRuntime = {
  destroy: () => void;
};

type FridayPetStageApi = {
  createStage: (
    stage: HTMLElement,
    options: {
      surface: string;
      height: number;
      behavior: string;
      ecoAllowlist: string[];
      interactive?: boolean;
      autoSchedule?: boolean;
    },
  ) => Promise<FridayPetStageRuntime>;
};

declare global {
  interface Window {
    FridayPetStage?: FridayPetStageApi;
    __fridayMobileWebHeroPetReady?: boolean;
    __fridayMobileWebHeroPetError?: string | null;
  }
}

let fridayPetStageEnginePromise: Promise<void> | null = null;

function loadFridayPetStageEngine(): Promise<void> {
  if (window.FridayPetStage) {
    return Promise.resolve();
  }
  if (fridayPetStageEnginePromise) {
    return fridayPetStageEnginePromise;
  }
  fridayPetStageEnginePromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>('script[data-friday-pet-stage-engine="mobile-web"]');
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener("error", () => reject(new Error("pet-stage-engine load failed")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "/pet-stage-engine.js?v=mobile-web-v9-20260706";
    script.async = true;
    script.dataset.fridayPetStageEngine = "mobile-web";
    script.onload = () => {
      if (window.FridayPetStage) {
        resolve();
        return;
      }
      reject(new Error("FridayPetStage unavailable after script load"));
    };
    script.onerror = () => reject(new Error("pet-stage-engine load failed"));
    document.head.appendChild(script);
  });
  return fridayPetStageEnginePromise;
}

type ConsoleScheduledAutomation = Pick<
  AgentAutomationRecord,
  "id" | "name" | "enabled" | "schedule"
> & {
  nextRunAt: string | null;
  updatedAt?: string;
};

function formatShortTimestamp(value: string | undefined, locale: "zh" | "en"): string {
  if (!value) {
    return locale === "zh" ? "刚刚" : "Just now";
  }
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatRelativeTime(value: string | undefined, locale: "zh" | "en"): string {
  if (!value) {
    return locale === "zh" ? "刚刚" : "just now";
  }
  const rtf = new Intl.RelativeTimeFormat(locale === "zh" ? "zh-CN" : "en-US", { numeric: "auto" });
  const diffMs = new Date(value).getTime() - Date.now();
  const diffMinutes = Math.round(diffMs / 60_000);
  if (Math.abs(diffMinutes) < 60) {
    return rtf.format(diffMinutes, "minute");
  }
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) {
    return rtf.format(diffHours, "hour");
  }
  return rtf.format(Math.round(diffHours / 24), "day");
}

function formatRunElapsed(run: AgentRunRecord, locale: "zh" | "en"): string {
  const baseMs = run.durationMs ?? Math.max(Date.now() - new Date(run.startedAt).getTime(), 0);
  const totalSeconds = Math.max(Math.round(baseMs / 1000), 0);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (locale === "zh") {
    return `${minutes} 分 ${seconds} 秒`;
  }
  return `${minutes}m ${seconds}s`;
}

function labelForRunStage(status: AgentRunRecord["status"], locale: "zh" | "en"): string {
  const labels: Record<AgentRunRecord["status"], { zh: string; en: string }> = {
    pending: { zh: "待开始", en: "Pending" },
    planning: { zh: "规划中", en: "Planning" },
    awaiting_clarification: { zh: "待澄清", en: "Needs Clarification" },
    awaiting_plan_approval: { zh: "待批准计划", en: "Awaiting Plan Approval" },
    awaiting_tool_approval: { zh: "待工具批准", en: "Awaiting Tool Approval" },
    executing: { zh: "执行中", en: "Executing" },
    testing: { zh: "验证中", en: "Validating" },
    fixing: { zh: "修复中", en: "Fixing" },
    completed: { zh: "已完成", en: "Completed" },
    failed: { zh: "失败", en: "Failed" },
    failed_tests: { zh: "测试失败", en: "Failed Tests" },
    cancelled: { zh: "已取消", en: "Cancelled" },
  };
  return locale === "zh" ? labels[status].zh : labels[status].en;
}

function describeAutomationTiming(input: {
  automation: Pick<ConsoleScheduledAutomation, "schedule">;
  nextRunAt: string | null;
  locale: "zh" | "en";
}): { dateLabel: string; timeLabel: string; detail: string } {
  const { automation, nextRunAt, locale } = input;
  if (!nextRunAt) {
    return {
      dateLabel: locale === "zh" ? "已暂停" : "Paused",
      timeLabel: "—",
      detail: `${automation.schedule?.cron ?? "Manual"}${automation.schedule?.timezone ? ` · ${automation.schedule.timezone}` : ""}`,
    };
  }
  const formatter = new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: automation.schedule?.timezone,
  });
  const formatted = formatter.formatToParts(new Date(nextRunAt));
  const month = formatted.find((part) => part.type === "month")?.value ?? "";
  const day = formatted.find((part) => part.type === "day")?.value ?? "";
  const hour = formatted.find((part) => part.type === "hour")?.value ?? "";
  const minute = formatted.find((part) => part.type === "minute")?.value ?? "00";
  return {
    dateLabel: locale === "zh" ? `${month}${day}日` : `${month} ${day}`,
    timeLabel: `${hour}:${minute}`,
    detail: `${automation.schedule?.cron ?? ""}${automation.schedule?.timezone ? ` · ${automation.schedule.timezone}` : ""}`,
  };
}

function buildPulseSummary(
  overview: FridayLearningOverview | undefined,
  locale: "zh" | "en",
): string {
  if (!overview) {
    return locale === "zh" ? "Friday 正在整理最近的学习结果。" : "Friday is compiling recent learning signals.";
  }
  if (overview.coverage.patterns > 0) {
    return localize(
      locale,
      `Friday 已吸收 ${overview.coverage.patterns} 个工作模式，最近 ${overview.coverage.lessons} 条教训正在影响后续路由。`,
      `Friday has absorbed ${overview.coverage.patterns} work patterns, and ${overview.coverage.lessons} lessons are now shaping later routing.`,
    );
  }
  if (overview.coverage.autoFixActions > 0) {
    const buckets = overview.coverage.autoFixOutcomeBuckets;
    return localize(
      locale,
      `Friday 最近记录了 ${buckets.recordedActions} 次修复动作，其中 ${buckets.verifiedRepairs} 次已验证修复、${buckets.diagnosticOnly} 次为诊断结果。`,
      `Friday recently recorded ${buckets.recordedActions} repair action(s): ${buckets.verifiedRepairs} verified repair(s), ${buckets.diagnosticOnly} diagnostic-only result(s).`,
    );
  }
  return locale === "zh"
    ? "Friday 还在积累更多真实运行记录，学习层会随着你的使用逐渐长出来。"
    : "Friday is still collecting live run evidence, and the learning layer will deepen as you use it.";
}

function scrollToSection(sectionId: string) {
  const target = document.getElementById(sectionId);
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function SummaryStripButton(props: {
  label: string;
  subtitle: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="flex flex-col items-start gap-1 rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-4 text-left transition hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg-surface-strong)]"
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-[color:var(--color-text-primary)]">{props.label}</span>
        <span className="inline-flex h-6 min-w-[24px] items-center justify-center rounded-full bg-[color:var(--color-accent-soft)] px-2 text-[11px] font-semibold text-[color:var(--color-accent)]">
          {props.count}
        </span>
      </div>
      <span className="text-xs text-[color:var(--color-text-secondary)]">{props.subtitle}</span>
    </button>
  );
}

function navigatorMetaKeyLabel(): string {
  if (typeof navigator === "undefined") return "⌘";
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
}

function runtimeChipParts(status: SystemHealthStatus, locale: "zh" | "en") {
  if (status === "offline") {
    return {
      color: "var(--rust-500)",
      label: localize(locale, "离线", "Offline"),
    };
  }
  if (status === "unavailable") {
    return {
      color: "var(--accent)",
      label: localize(locale, "能力暂不可用", "Unavailable"),
    };
  }
  if (status === "degraded") {
    return {
      color: "var(--accent)",
      label: localize(locale, "部分降级", "Degraded"),
    };
  }
  return {
    color: "var(--ok)",
    label: localize(locale, "运行正常", "Healthy"),
  };
}

function MobileWebHeroPetStage(props: { locale: "zh" | "en" }) {
  const { locale } = props;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [petError, setPetError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let runtime: FridayPetStageRuntime | null = null;
    const stage = stageRef.current;
    window.__fridayMobileWebHeroPetReady = false;
    window.__fridayMobileWebHeroPetError = null;

    if (!stage) {
      return () => {};
    }

    stage.querySelectorAll(".friday-pet-actor").forEach((node) => node.remove());
    loadFridayPetStageEngine()
      .then(() => {
        if (cancelled || !window.FridayPetStage) {
          return undefined;
        }
        return window.FridayPetStage.createStage(stage, {
          surface: "mobile",
          height: 168,
          behavior: "locked-core-only",
          ecoAllowlist: [],
          interactive: true,
          autoSchedule: true,
        });
      })
      .then((nextRuntime) => {
        if (!nextRuntime) {
          return;
        }
        if (cancelled) {
          nextRuntime.destroy();
          return;
        }
        runtime = nextRuntime;
        window.__fridayMobileWebHeroPetReady = true;
        window.__fridayMobileWebHeroPetError = null;
        setPetError(null);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        window.__fridayMobileWebHeroPetError = message;
        if (!cancelled) {
          setPetError(message);
        }
      });

    return () => {
      cancelled = true;
      runtime?.destroy();
      runtime = null;
    };
  }, []);

  return (
    <div
      data-testid="mobile-web-hero-pet"
      data-friday-pet-stage="mobile-web"
      data-friday-pet-render="v9-canvas"
      data-friday-pet-engine="pet-stage-engine"
      data-friday-mobile-strategy="design-truth-aligned"
      className="relative min-h-[168px] overflow-hidden rounded-[8px] border"
      style={{
        background: "#eef3e8",
        borderColor: "var(--color-border-soft)",
      }}
    >
      <style>{`
        .friday-mobile-web-pet-stage .friday-pet-actor {
          --face: 1;
          --foot-css-x: 50%;
          position: absolute;
          left: 0;
          top: 0;
          width: 190px;
          height: 160px;
          transform-origin: var(--foot-css-x) 100%;
          transform: scaleX(var(--face));
          will-change: left, transform;
        }
        .friday-mobile-web-pet-stage .friday-pet-actor canvas {
          position: absolute;
          inset: 0;
          display: block;
          width: 100%;
          height: 100%;
        }
        .friday-mobile-web-pet-stage .friday-pet-actor.boing {
          animation: fridayMobileWebPetBoing .36s ease-out;
        }
        @keyframes fridayMobileWebPetBoing {
          0% { transform: scaleX(var(--face)) scaleY(1); }
          30% { transform: scaleX(var(--face)) scaleY(1.05); }
          100% { transform: scaleX(var(--face)) scaleY(1); }
        }
        .friday-mobile-web-pet-stage .friday-pet-fx {
          position: absolute;
          left: 50%;
          top: 4px;
          width: 120px;
          height: 82px;
          transform: translateX(-50%);
          pointer-events: none;
          color: #e33131;
        }
        .friday-mobile-web-pet-stage .friday-pet-fx span {
          position: absolute;
          left: 50%;
          bottom: 0;
          font-size: 18px;
          line-height: 1;
          color: #e33131;
          text-shadow: 0 1px 0 #fff5f2, 0 2px 5px rgba(165,35,35,.18);
          opacity: 0;
          transform: translate(-50%, 8px) scale(.55);
        }
        .friday-mobile-web-pet-stage .friday-pet-fx.go span {
          animation: fridayMobileWebPetHeartFloat 1.15s ease-out both;
        }
        .friday-mobile-web-pet-stage .friday-pet-fx.go span:nth-child(2) { animation-delay: .05s; }
        .friday-mobile-web-pet-stage .friday-pet-fx.go span:nth-child(3) { animation-delay: .11s; }
        .friday-mobile-web-pet-stage .friday-pet-fx.go span:nth-child(4) { animation-delay: .17s; }
        .friday-mobile-web-pet-stage .friday-pet-fx.go span:nth-child(5) { animation-delay: .23s; }
        @keyframes fridayMobileWebPetHeartFloat {
          0% { opacity: 0; transform: translate(-50%, 8px) scale(.55); }
          18% { opacity: 1; }
          100% { opacity: 0; transform: translate(calc(-50% + var(--dx)), var(--dy)) scale(var(--s)); }
        }
      `}</style>
      <div className="absolute inset-0 bg-[linear-gradient(180deg,#f8faf2_0%,#e5efdd_100%)]" aria-hidden="true" />
      <div
        ref={stageRef}
        aria-label={localize(locale, "Friday v9 交互宠物", "Friday v9 interactive pet")}
        className="friday-mobile-web-pet-stage friday-pet-stage absolute bottom-1 right-0 h-[160px] w-[188px] overflow-hidden"
      />
      <div className="relative max-w-[210px] p-4">
        <p className="text-xs font-semibold text-[color:var(--color-text-faint)]">
          Friday Home
        </p>
        <h2 className="mt-2 text-2xl font-semibold leading-tight text-[color:var(--color-text-primary)]" style={{ fontFamily: "var(--font-serif)" }}>
          {localize(locale, "状态先行", "Status first")}
        </h2>
        <p className="mt-2 text-sm leading-6 text-[color:var(--color-text-secondary)]">
          {localize(locale, "Chat 与 Status 同屏，Friday 随时可开。", "Chat and Status share the home surface so Friday is always one tap away.")}
        </p>
        {petError ? (
          <p className="mt-2 text-[11px] font-semibold text-[color:var(--danger)]" data-friday-pet-status="NO-GO">
            {localize(locale, "NO-GO：v9 pet canvas 未渲染", "NO-GO: v9 pet canvas did not render")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function OpsMasthead(props: {
  locale: "zh" | "en";
  activeCount: number;
  needsCount: number;
  scheduledCount: number;
  runtimeLabel: string;
  runtimeColor: string;
}) {
  const { locale, activeCount, needsCount, scheduledCount, runtimeLabel, runtimeColor } = props;

  return (
    <div
      data-ui-component="ops-masthead"
      className="rounded-[16px] border px-4 py-3"
      style={{
        background: "linear-gradient(120deg, rgba(15,125,140,.12), var(--surface) 64%)",
        borderColor: "var(--hair)",
      }}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-[9px] w-[9px] rounded-full"
              style={{ background: runtimeColor }}
            />
            <p className="text-[15px] font-bold text-[color:var(--ink)]">
              {localize(locale, "Operations", "Operations")}
            </p>
          </div>
          <p className="mt-1 font-mono text-[11.5px] text-[color:var(--muted)]">
            {runtimeLabel} · source-of-truth projection · proof-first actions
          </p>
        </div>
        <div className="grid min-w-[260px] grid-cols-3 gap-4 border-t pt-3 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0" style={{ borderColor: "var(--hair)" }}>
          {[
            { value: needsCount, label: "Needs Me" },
            { value: activeCount, label: "Running" },
            { value: scheduledCount, label: "Scheduled" },
          ].map((item) => (
            <div key={item.label}>
              <p className="text-[21px] font-bold leading-none text-[color:var(--ink)]">{item.value}</p>
              <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.07em] text-[color:var(--faint)]">{item.label}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MobileWebHomeSurface(props: {
  locale: "zh" | "en";
  systemLabel: string;
  runtimeLabel: string;
  runtimeColor: string;
  onOpenChat: () => void;
  onOpenCommandSheet: () => void;
}) {
  const { locale, systemLabel, runtimeLabel, runtimeColor, onOpenChat, onOpenCommandSheet } = props;

  return (
    <div
      data-testid="mobile-web-home-surface"
      data-friday-mobile-strategy="design-truth-aligned"
      className="mb-5 lg:hidden"
    >
      <div className="grid gap-4">
        <MobileWebHeroPetStage locale={locale} />

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onOpenChat}
            className="min-h-[52px] rounded-[8px] border px-3 text-left text-sm font-semibold"
            style={{
              background: "var(--color-bg-subtle)",
              borderColor: "var(--color-border-soft)",
              color: "var(--color-text-primary)",
            }}
          >
            <span className="block text-xs font-medium text-[color:var(--color-text-faint)]">Chat</span>
            {localize(locale, "开始新任务", "Start a task")}
          </button>
          <button
            type="button"
            onClick={onOpenCommandSheet}
            className="min-h-[52px] rounded-[8px] border px-3 text-left text-sm font-semibold"
            style={{
              background: "var(--color-bg-subtle)",
              borderColor: "var(--color-border-soft)",
              color: "var(--color-text-primary)",
            }}
          >
            <span className="block text-xs font-medium text-[color:var(--color-text-faint)]">Command Sheet</span>
            {localize(locale, "打开命令", "Open command")}
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-[8px] border px-3 py-2 text-sm" style={{ borderColor: "var(--color-border-soft)" }}>
          <span className="font-semibold text-[color:var(--color-text-primary)]">Status</span>
          <span className="inline-flex items-center gap-2 text-xs text-[color:var(--color-text-secondary)]">
            <span className="h-2 w-2 rounded-full" style={{ background: runtimeColor }} aria-hidden="true" />
            {systemLabel} · {runtimeLabel}
          </span>
        </div>
      </div>
    </div>
  );
}

export function HomePage() {
  const navigate = useAppNavigate();
  const queryClient = useQueryClient();
  const location = useLocation();
  const { locale } = useAppLocale();
  const { profileType } = useUserProfile();
  const { pinnedPackIds, pinPack, unpinPack } = useHomeSurfacePreferences(profileType);
  const { customPackInputs } = useCustomPacks();
  const { startPackNow, adjustPackBeforeStart, continuePack, openCurrentPackRun } = usePackLaunchActions(customPackInputs, { surface: "home" });
  const providerTruthQuery = useProviderTruthQuery();
  const systemHealthQuery = useSystemHealthQuery();
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
  const [pendingPackPath, setPendingPackPath] = useState<string | null>(null);
  const [selfRepairNotice, setSelfRepairNotice] = useState<{
    tone: "success" | "warning" | "danger";
    title: string;
    detail: string;
  } | null>(null);
  const [selfRepairRollbackTarget, setSelfRepairRollbackTarget] = useState<{
    actionId: string;
  } | null>(null);
  const [showSetupReadiness, setShowSetupReadiness] = useState(() => {
    const state = location.state as { starterSource?: string } | null;
    return state?.starterSource === "setup" || window.sessionStorage.getItem(FRIDAY_SETUP_READINESS_SESSION_KEY) === "1";
  });
  const pollInterval = useAdaptivePollingInterval({ activeMs: 12_000, backgroundMs: 36_000 });

  useEffect(() => {
    recordPageVisit("/home");
  }, []);

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

  const snapshotQuery = useQuery({
    queryKey: ["home", "snapshot", "console-home"],
    queryFn: () => uixSnapshotsApi.getHome(),
    refetchInterval: pollInterval,
  });
  const learningOverviewQuery = useQuery({
    queryKey: ["learning", "overview", "console-home"],
    queryFn: () => learningApi.getOverview(5),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const automationsQuery = useQuery({
    queryKey: ["agent-os", "automations", "console-home"],
    queryFn: () => automationsApi.list({ limit: 20 }),
    refetchInterval: pollInterval,
  });
  const capabilityHealthQuery = useQuery({
    queryKey: ["health", "capabilities", "home"],
    queryFn: () => healthApi.getCapabilityHealth(),
    refetchInterval: showSetupReadiness ? 30_000 : false,
    staleTime: 10_000,
  });
  const selfRepairMutation = useMutation({
    mutationFn: () => learningApi.runReadyAutoFixActions({ maxRiskTier: 1, limit: 50 }),
    onSuccess: (result) => {
      const { summary } = result;
      const rollbackCandidate = result.executed.find((item) =>
        item.result.success && item.action.summary.rollbackPlanAvailable,
      );
      setSelfRepairRollbackTarget(
        rollbackCandidate ? { actionId: rollbackCandidate.action.summary.actionId } : null,
      );
      let title: string;
      if (summary.failed > 0) {
        title = localize(
          locale,
          `已运行 ${summary.executed} 项自我修复，${summary.failed} 项失败`,
          `Ran ${summary.executed} self-repair action${summary.executed === 1 ? "" : "s"}; ${summary.failed} failed`,
        );
      } else if (summary.executed > 0) {
        title = localize(
          locale,
          `已运行 ${summary.executed} 项修复动作，完成状态以验证证据为准`,
          `Ran ${summary.executed} repair action${summary.executed === 1 ? "" : "s"}; completion depends on verification evidence`,
        );
      } else {
        title = localize(locale, "当前没有可自动执行的修复", "No automatic repair is ready right now");
      }
      const detail = localize(
        locale,
        `成功 ${summary.succeeded} 项，失败 ${summary.failed} 项；${summary.requiresApproval} 项需要审批，${summary.blockedByPolicy} 项被数据保护策略跳过。用户已有数据不会被清空或重置。`,
        `${summary.succeeded} succeeded, ${summary.failed} failed; ${summary.requiresApproval} need approval, and ${summary.blockedByPolicy} were skipped by the data protection policy. Existing user data is not cleared or reset.`,
      );
      setSelfRepairNotice({
        tone: summary.failed > 0 ? "warning" : "success",
        title,
        detail,
      });
      void queryClient.invalidateQueries({ queryKey: ["learning"] });
      void queryClient.invalidateQueries({ queryKey: ["home", "snapshot", "console-home"] });
      void providerTruthQuery.refetch();
      void systemHealthQuery.refetch();
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      setSelfRepairRollbackTarget(null);
      setSelfRepairNotice({
        tone: "danger",
        title: localize(locale, "自我修复没有启动", "Self-repair did not start"),
        detail: message,
      });
    },
  });
  const selfRepairRollbackMutation = useMutation({
    mutationFn: (input: { actionId: string }) =>
      learningApi.rollbackAutoFixAction({
        actionId: input.actionId,
        reason: "Home supervised repair rollback",
      }),
    onSuccess: (result) => {
      setSelfRepairRollbackTarget(null);
      setSelfRepairNotice({
        tone: result.result.rollbackSucceeded ? "success" : "warning",
        title: result.result.rollbackSucceeded
          ? localize(locale, "已回滚刚才的修复", "Rolled back the repair")
          : localize(locale, "已尝试回滚，请检查证据", "Rollback attempted; review evidence"),
        detail: result.result.rollbackSucceeded
          ? localize(
              locale,
              "回滚已执行并写入证据；Friday 不会把未证明的修复标成可用。",
              "Rollback ran and evidence was recorded; Friday will not mark unproven repairs as available.",
            )
          : localize(
              locale,
              "回滚请求已返回，但结果未证明成功。请在证据里确认当前状态。",
              "The rollback request returned without proven success. Check the evidence before trusting the state.",
            ),
      });
      void queryClient.invalidateQueries({ queryKey: ["learning"] });
      void queryClient.invalidateQueries({ queryKey: ["home", "snapshot", "console-home"] });
      void providerTruthQuery.refetch();
      void systemHealthQuery.refetch();
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      setSelfRepairNotice({
        tone: "danger",
        title: localize(locale, "回滚没有启动", "Rollback did not start"),
        detail: message,
      });
    },
  });

  const recentRuns = snapshotQuery.data?.runs ?? [];
  const activeRuns = recentRuns.filter((run) => ACTIVE_RUN_STATUSES.has(run.status));
  const recentResults = recentRuns
    .filter((run) => run.status === "completed" || run.status === "failed" || run.status === "failed_tests")
    .slice(0, 4);
  const failedResults = recentResults.filter((run) => run.status === "failed" || run.status === "failed_tests");
  const pendingApprovals = snapshotQuery.data?.pendingApprovals ?? [];

  const nextRunByAutomationId = useMemo(
    () => new Map((snapshotQuery.data?.scheduledAutomations ?? []).map((automation) => [automation.id, automation.nextRunAt])),
    [snapshotQuery.data?.scheduledAutomations],
  );

  const scheduledAutomations = useMemo<ConsoleScheduledAutomation[]>(() => {
    if ((automationsQuery.data?.length ?? 0) === 0) {
      return (snapshotQuery.data?.scheduledAutomations ?? []).map((automation) => ({
        id: automation.id,
        name: automation.name,
        enabled: automation.enabled,
        schedule: automation.schedule,
        nextRunAt: automation.nextRunAt,
      }));
    }

    return (automationsQuery.data ?? [])
      .filter((automation) => automation.schedule)
      .map((automation) => ({
        ...automation,
        nextRunAt: nextRunByAutomationId.get(automation.id) ?? null,
      }))
      .sort((left, right) => {
        if (left.enabled !== right.enabled) {
          return Number(right.enabled) - Number(left.enabled);
        }
        if (left.nextRunAt && right.nextRunAt) {
          return new Date(left.nextRunAt).getTime() - new Date(right.nextRunAt).getTime();
        }
        if (left.nextRunAt) return -1;
        if (right.nextRunAt) return 1;
        return new Date(right.updatedAt ?? 0).getTime() - new Date(left.updatedAt ?? 0).getTime();
      })
      .slice(0, 6);
  }, [automationsQuery.data, nextRunByAutomationId, snapshotQuery.data?.scheduledAutomations]);

  const systemTone = failedResults.length > 0 ? "warning" : "success";
  const systemLabel = failedResults.length > 0
    ? localize(locale, "部分降级", "Partially degraded")
    : activeRuns.length > 0
      ? localize(locale, "Friday 运行中", "Friday is active")
      : localize(locale, "已就绪", "Ready");

  const pulseCount = learningOverviewQuery.data?.coverage.patterns
    ?? learningOverviewQuery.data?.coverage.lessons
    ?? recentResults.length;

  const summaryItems = [
    {
      id: "home-active-section",
      label: localize(locale, "正在进行中", "In Flight"),
      subtitle: localize(locale, "盯当前运行", "Track live work"),
      count: activeRuns.length,
    },
    {
      id: "home-approvals-section",
      label: localize(locale, "等你决定", "Waiting on you"),
      subtitle: localize(locale, "先处理边界", "Handle boundaries first"),
      count: pendingApprovals.length,
    },
    {
      id: "home-pulse-section",
      label: localize(locale, "总览脉冲", "Pulse"),
      subtitle: localize(locale, "看学习与结果", "Read learning and results"),
      count: pulseCount,
    },
    {
      id: "home-schedule-section",
      label: localize(locale, "接下来", "Next"),
      subtitle: localize(locale, "看自动节奏", "Review the automation cadence"),
      count: scheduledAutomations.length,
    },
  ];

  const userCreatedPacks = useMemo(
    () => customPackInputs
      .map((input, index) => {
        const packId = buildCustomPackId(input, index);
        return getPackById(packId, customPackInputs);
      })
      .filter((pack): pack is NonNullable<ReturnType<typeof getPackById>> => Boolean(pack)),
    [customPackInputs],
  );
  const pinnedPacks = pinnedPackIds
    .map((packId) => getPackById(packId, customPackInputs))
    .filter((pack): pack is NonNullable<ReturnType<typeof getPackById>> => {
      if (!pack) {
        return false;
      }
      return !pack.builtIn;
    });
  const recommendedPacks = userCreatedPacks
    .filter((pack) => !pinnedPackIds.includes(pack.id))
    .slice(0, 3);
  const selectedPack = selectedPackId ? getPackById(selectedPackId, customPackInputs) ?? null : null;
  const selectedPackRunState = selectedPack
    ? findPackRuns(selectedPack, recentRuns)
    : { activeRun: null, recentRun: null };
  const runtimeChip = runtimeChipParts(systemHealthQuery.data?.status ?? "healthy", locale);
  const kbdLabel = navigatorMetaKeyLabel();

  return (
    <div data-ui-screen="desktop-operations" className="space-y-5 pb-6">
      {showSetupReadiness ? (
        <FridayReadinessSummaryPanel
          health={capabilityHealthQuery.data}
          locale={locale}
          onDismiss={() => {
            window.sessionStorage.removeItem(FRIDAY_SETUP_READINESS_SESSION_KEY);
            setShowSetupReadiness(false);
          }}
        />
      ) : null}

      <section
        data-testid="home-surface-ready"
        className="rounded-[30px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-5 py-5 shadow-[var(--shadow-floating)]"
      >
        <MobileWebHomeSurface
          locale={locale}
          systemLabel={systemLabel}
          runtimeLabel={runtimeChip.label}
          runtimeColor={runtimeChip.color}
          onOpenChat={() => navigate("/chat")}
          onOpenCommandSheet={() => requestCommandPaletteOpen()}
        />
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(390px,430px)] xl:items-start">
          <div className="min-w-0">
            <OpsMasthead
              locale={locale}
              activeCount={activeRuns.length}
              needsCount={pendingApprovals.length}
              scheduledCount={scheduledAutomations.length}
              runtimeLabel={runtimeChip.label}
              runtimeColor={runtimeChip.color}
            />
            <div className="flex flex-wrap items-center gap-3">
              <StatusPill tone={systemTone}>
                {systemLabel}
              </StatusPill>
              <span className="text-xs text-[color:var(--color-text-secondary)]">
                {localize(
                  locale,
                  "Cmd+K 全局搜索和顶部命令面板继续保留；首页重新回到控制台总览模式。",
                  "Cmd+K and the command palette stay intact; home is now back in console overview mode.",
                )}
              </span>
            </div>
            <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
              {localize(locale, "Operations", "Operations")}
            </p>
            <h2 className="mt-1 text-3xl font-semibold tracking-tight text-[color:var(--color-text-primary)]" style={{ fontFamily: "var(--font-serif)" }}>
              {localize(locale, "运行、待决与排期在同一个控制台", "Running work, decisions, and cadence in one console")}
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-[color:var(--color-text-secondary)]">
              {localize(
                locale,
                "Operations 先展示 Friday 的真实运行状态、需要你决定的事、provider 真路由和已排进队列的节奏；新任务仍从 Friday Chat 的 mission intake 进入。",
                "Operations surfaces Friday's live state, decisions waiting on you, the real provider route, and queued cadence; new work still enters through Friday Chat mission intake.",
              )}
            </p>

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              {summaryItems.map((item) => (
                <SummaryStripButton
                  key={item.id}
                  label={item.label}
                  subtitle={item.subtitle}
                  count={item.count}
                  onClick={() => scrollToSection(item.id)}
                />
              ))}
            </div>
          </div>

          <div className="w-full xl:justify-self-end">
            <div className="space-y-3 xl:ml-auto xl:max-w-[430px]">
              <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                <span
                  className="inline-flex min-h-[36px] items-center gap-2 rounded-[var(--radius-md)] border px-3 py-1.5 text-xs"
                  style={{
                    borderColor: "rgba(15, 125, 140, 0.22)",
                    background: "var(--surface-2)",
                    color: "var(--ink-700)",
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 rounded-full"
                    style={{ background: runtimeChip.color }}
                  />
                  {runtimeChip.label}
                </span>

                <ProviderTruthCompact
                  locale={locale}
                  truth={providerTruthQuery.data}
                  loading={providerTruthQuery.isPending}
                  className="max-w-[360px]"
                />

                <button
                  type="button"
                  onClick={() => requestCommandPaletteOpen()}
                  className="inline-flex min-h-[36px] items-center gap-2 rounded-[var(--radius-md)] border px-3 text-xs transition-colors hover:bg-[color:var(--accent-soft)]"
                  style={{
                    borderColor: "rgba(15, 125, 140, 0.22)",
                    background: "var(--surface-2)",
                    color: "var(--ink-500)",
                  }}
                >
                  <Command className="h-3.5 w-3.5" />
                  <span>{localize(locale, "命令面板", "Command")}</span>
                  <kbd
                    className="rounded border px-1 py-0.5 font-mono text-[10px]"
                    style={{
                      borderColor: "rgba(15, 125, 140, 0.20)",
                      color: "var(--ink-300)",
                      fontFamily: "var(--font-mono-jb)",
                    }}
                  >
                    {kbdLabel}K
                  </kbd>
                </button>
              </div>

              <div className="flex flex-wrap gap-2 xl:justify-end">
                <ActionButton
                  data-testid="operations-submit-intent"
                  data-action="mission_intake_submit"
                  data-cap="mission_intake"
                  data-truth="wired_registry"
                  data-result="opens-friday-chat-intake"
                  onClick={() => navigate("/chat")}
                >
                  <Sparkles className="mr-2 h-4 w-4" />
                  {localize(locale, "提交意图", "Submit Intent")}
                </ActionButton>
                <ActionButton tone="secondary" onClick={() => navigate("/assistant")}>
                  <Bot className="mr-2 h-4 w-4" />
                  {localize(locale, "继续去 Assistant", "Continue to Assistant")}
                </ActionButton>
                <ActionButton tone="secondary" onClick={() => navigate("/observability")}>
                  <ArrowRight className="mr-2 h-4 w-4" />
                  {localize(locale, "打开 Observability", "Open Observability")}
                </ActionButton>
                <ActionButton
                  data-testid="home-self-repair"
                  tone="secondary"
                  disabled={selfRepairMutation.isPending}
                  onClick={() => {
                    setSelfRepairNotice(null);
                    setSelfRepairRollbackTarget(null);
                    selfRepairMutation.mutate();
                  }}
                >
                  <Wrench className="mr-2 h-4 w-4" />
                  {selfRepairMutation.isPending
                    ? localize(locale, "修复中", "Repairing")
                    : localize(locale, "监督修复", "Supervised repair")}
                </ActionButton>
              </div>

              <p className="text-xs leading-5 text-[color:var(--color-text-tertiary)] xl:text-right">
                {localize(
                  locale,
                  "只运行已审批、低风险且可验证的修复动作；完整自主事故修复仍需要单独证明。",
                  "Runs only approved, low-risk, verifiable repair actions; full autonomous incident repair still needs separate proof.",
                )}
              </p>

              {selfRepairNotice ? (
                <div
                  data-testid="home-self-repair-result"
                  role="status"
                  className={cn(
                    "rounded-[var(--radius-md)] border px-4 py-3 text-sm",
                    selfRepairNotice.tone === "success" && "border-[color:var(--color-border-success)] bg-[color:var(--color-bg-success-subtle)] text-[color:var(--color-text-success)]",
                    selfRepairNotice.tone === "warning" && "border-[color:var(--color-border-warning)] bg-[color:var(--color-bg-warning-subtle)] text-[color:var(--color-text-warning)]",
                    selfRepairNotice.tone === "danger" && "border-[color:var(--color-border-danger)] bg-[color:var(--color-bg-danger-subtle)] text-[color:var(--color-text-danger)]",
                  )}
                >
                  <p className="font-semibold">{selfRepairNotice.title}</p>
                  <p className="mt-1 leading-6">{selfRepairNotice.detail}</p>
                  {selfRepairRollbackTarget ? (
                    <div className="mt-3 flex justify-start">
                      <ActionButton
                        data-testid="home-self-repair-rollback"
                        tone="secondary"
                        disabled={selfRepairRollbackMutation.isPending}
                        onClick={() => selfRepairRollbackMutation.mutate(selfRepairRollbackTarget)}
                      >
                        <RotateCcw className="mr-2 h-4 w-4" />
                        {selfRepairRollbackMutation.isPending
                          ? localize(locale, "回滚中", "Rolling back")
                          : localize(locale, "回滚刚才的修复", "Rollback repair")}
                      </ActionButton>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <ProviderTruthCard
                locale={locale}
                truth={providerTruthQuery.data}
                loading={providerTruthQuery.isPending}
                variant="home"
              />
            </div>
          </div>
        </div>
      </section>

      <section id="home-active-section" className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-3xl font-semibold text-[color:var(--color-text-primary)]" style={{ fontFamily: "var(--font-serif)" }}>
              {localize(locale, `Running (${activeRuns.length})`, `Running (${activeRuns.length})`)}
            </h3>
            <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
              {localize(locale, "只显示真正还在跑的任务，不混进静态入口。", "Only live runs appear here; static entry points stay out of the way.")}
            </p>
          </div>
          <ActionButton tone="secondary" onClick={() => navigate("/assistant")}>
            {localize(locale, "全部查看", "View all")}
          </ActionButton>
        </div>

        {activeRuns.length === 0 ? (
          <ShellCard>
            <p className="text-sm text-[color:var(--color-text-secondary)]">
              {localize(locale, "当前没有正在运行的任务。你可以从聊天开始新任务，或者先去看 Assistant。", "There are no active runs right now. Start from chat or check Assistant for what needs attention.")}
            </p>
          </ShellCard>
        ) : (
          <div className="grid gap-4 xl:grid-cols-3">
            {activeRuns.slice(0, 3).map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => navigate("/assistant")}
                className="rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-5 text-left shadow-[var(--shadow-floating)] transition hover:border-[color:var(--color-border-strong)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <StatusPill tone={toneForRunHealth(run)}>{labelForRunStage(run.status, locale)}</StatusPill>
                  <span className="inline-block h-2.5 w-2.5 rounded-full bg-[color:var(--color-accent)] opacity-80" />
                </div>
                <h4 className="mt-4 line-clamp-3 text-2xl font-semibold leading-tight text-[color:var(--color-text-primary)]" style={{ fontFamily: "var(--font-serif)" }}>
                  {displayRunTask(run)}
                </h4>
                <p className="mt-3 text-sm text-[color:var(--color-text-secondary)]">
                  {formatRunElapsed(run, locale)} · {localize(locale, "当前阶段", "Current stage")} · {labelForRunStage(run.status, locale)}
                </p>
                <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">
                  {summarizeRunContext(run, locale) ?? describeRunHealth(run, locale)}
                </p>
                <div className="mt-6 flex items-center justify-between gap-3 border-t border-[color:var(--color-border-soft)] pt-4 text-xs text-[color:var(--color-text-faint)]">
                  <span>{localize(locale, "开始于", "Started")} {formatShortTimestamp(run.startedAt, locale)}</span>
                  <span>{labelForRunHealth(run, locale)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      <section id="home-approvals-section" className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-3xl font-semibold text-[color:var(--color-text-primary)]" style={{ fontFamily: "var(--font-serif)" }}>
              {localize(locale, "Needs Me", "Needs Me")}
            </h3>
            <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
              {localize(locale, "先处理会改变边界、预算、模型或风险口径的东西。", "Handle anything that changes boundaries, budget, models, or risk posture first.")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate("/assistant")}
            className="text-sm font-medium text-[color:var(--color-accent)] transition hover:opacity-80"
          >
            {localize(locale, `全部查看 (${pendingApprovals.length})`, `View all (${pendingApprovals.length})`)}
          </button>
        </div>

        {pendingApprovals.length === 0 ? (
          <ShellCard>
            <p className="text-sm text-[color:var(--color-text-secondary)]">
              {localize(locale, "现在没有待确认边界。Assistant 会在真正需要你决策时把东西推过来。", "There is nothing waiting for your decision right now. Assistant will surface boundaries here when real approval is needed.")}
            </p>
          </ShellCard>
        ) : (
          <div className="space-y-3">
            {pendingApprovals.map((item) => (
              <div
                key={item.id}
                className="flex flex-col gap-3 rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-5 py-4 shadow-[var(--shadow-floating)] md:flex-row md:items-center md:justify-between"
              >
                <div className="flex min-w-0 items-start gap-4">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]">
                    <TriangleAlert className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xl font-semibold leading-tight text-[color:var(--color-text-primary)]" style={{ fontFamily: "var(--font-serif)" }}>
                      {item.title}
                    </p>
                    <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">{item.summary}</p>
                    <p className="mt-2 text-xs text-[color:var(--color-text-faint)]">
                      {localize(locale, "创建于", "Created")} {formatRelativeTime(item.createdAt, locale)}
                    </p>
                  </div>
                </div>
                <ActionButton tone="secondary" onClick={() => navigate("/assistant")}>
                  {localize(locale, "去处理", "Handle it")}
                </ActionButton>
              </div>
            ))}
          </div>
        )}
      </section>

      <section id="home-pulse-section" className="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <ShellCard className="min-w-0" eyebrow={localize(locale, "总览脉冲", "Pulse")} title={localize(locale, "控制台脉冲", "Console pulse")}>
          <p className="text-sm leading-6 text-[color:var(--color-text-secondary)]">
            {buildPulseSummary(learningOverviewQuery.data, locale)}
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {[
              {
                label: localize(locale, "最近成功", "Recent successes"),
                value: recentResults.filter((run) => run.status === "completed").length,
              },
              {
                label: localize(locale, "最近失败", "Recent failures"),
                value: failedResults.length,
              },
              {
                label: localize(locale, "学习到的模式", "Learned patterns"),
                value: learningOverviewQuery.data?.coverage.patterns ?? 0,
              },
              {
                label: localize(locale, "已验证修复", "Verified repairs"),
                value: learningOverviewQuery.data?.coverage.autoFixOutcomeBuckets.verifiedRepairs ?? 0,
              },
            ].map((item) => (
              <div
                key={item.label}
                className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4"
              >
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">
                  {item.label}
                </p>
                <p className="mt-3 text-2xl font-semibold text-[color:var(--color-text-primary)]">{item.value}</p>
              </div>
            ))}
          </div>
        </ShellCard>

        <ShellCard className="min-w-0" eyebrow={localize(locale, "最近结果", "Recent results")} title={localize(locale, "刚刚发生了什么", "What just happened")}>
          {recentResults.length === 0 ? (
            <p className="text-sm text-[color:var(--color-text-secondary)]">
              {localize(locale, "还没有足够的最近结果。随着真实运行积累，这里会开始显示成功和失败的趋势。", "There is not enough recent run history yet. This section will fill in as live execution history accumulates.")}
            </p>
          ) : (
            <div className="space-y-3">
              {recentResults.map((run) => (
                <div
                  key={run.id}
                  className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="min-w-0 truncate text-sm font-semibold text-[color:var(--color-text-primary)]">{displayRunTask(run)}</p>
                    <StatusPill tone={toneForRunHealth(run)}>{labelForRunHealth(run, locale)}</StatusPill>
                  </div>
                  <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">
                    {describeRunHealth(run, locale) || summarizeRunContext(run, locale) || displayRunPreview(run) || ""}
                  </p>
                  <p className="mt-2 text-xs text-[color:var(--color-text-faint)]">
                    {formatShortTimestamp(run.completedAt ?? run.startedAt, locale)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </ShellCard>
      </section>

      <section id="home-schedule-section" className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-3xl font-semibold text-[color:var(--color-text-primary)]" style={{ fontFamily: "var(--font-serif)" }}>
              {localize(locale, "Scheduled", "Scheduled")}
            </h3>
            <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
              {localize(locale, "这里看的是已经接到真实自动化队列里的节奏，不是占位提醒。", "This is the real automation cadence coming from the live queue, not placeholder reminders.")}
            </p>
          </div>
          <ActionButton tone="secondary" onClick={() => navigate("/automations")}>
            <Clock3 className="mr-2 h-4 w-4" />
            {localize(locale, "查看任务队列", "Open task queue")}
          </ActionButton>
        </div>

        {scheduledAutomations.length === 0 ? (
          <ShellCard>
            <p className="text-sm text-[color:var(--color-text-secondary)]">
              {localize(locale, "当前没有排进来的自动化节奏。去任务队列创建一个之后，这里会显示它的下一次触发。", "There is no scheduled automation cadence right now. Create one in Task Queue and it will appear here with its next trigger.")}
            </p>
          </ShellCard>
        ) : (
          <div className="space-y-3">
            {scheduledAutomations.map((automation) => {
              const timing = describeAutomationTiming({ automation, nextRunAt: automation.nextRunAt, locale });
              return (
                <button
                  key={automation.id}
                  type="button"
                  onClick={() => navigate("/automations")}
                  className="grid w-full gap-4 rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-5 py-4 text-left shadow-[var(--shadow-floating)] transition hover:border-[color:var(--color-border-strong)] md:grid-cols-[132px_minmax(0,1fr)_auto]"
                >
                  <div className="flex items-start gap-3 md:block">
                    <div className="min-w-[72px]">
                      <p className="text-sm font-semibold text-[color:var(--color-text-secondary)]">{timing.dateLabel}</p>
                      <p className="mt-1 text-2xl font-semibold text-[color:var(--color-text-primary)]" style={{ fontFamily: "var(--font-serif)" }}>
                        {timing.timeLabel}
                      </p>
                    </div>
                    {!automation.enabled ? (
                      <StatusPill tone="warning">{localize(locale, "已暂停", "Paused")}</StatusPill>
                    ) : null}
                  </div>
                  <div className="min-w-0">
                    <p className="text-xl font-semibold leading-tight text-[color:var(--color-text-primary)]" style={{ fontFamily: "var(--font-serif)" }}>
                      {automation.name}
                    </p>
                    <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">{timing.detail}</p>
                  </div>
                  <div className="flex items-center justify-end text-[color:var(--color-text-faint)]">
                    <ArrowRight className="h-5 w-5" />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section className="grid gap-3 lg:grid-cols-3" aria-label={localize(locale, "Operations endpoint queues", "Operations endpoint queues")}>
        {[
          {
            label: "Standing goals",
            detail: localize(locale, "读取长期目标入口；写入和暂停动作须等待真实回执。", "Long-running goals stay visible here; writes and pauses require real receipts."),
            path: "/automations",
          },
          {
            label: "Agenda",
            detail: localize(locale, "议程批准与运行会回到 Needs Me，不把未证明项装成完成。", "Agenda approvals and runs return to Needs Me; unproven items are never shown as complete."),
            path: "/assistant",
          },
          {
            label: "Scheduled",
            detail: localize(locale, "已排队节奏来自真实自动化投影，空态保持诚实。", "Cadence comes from the live automation projection, with honest empty state."),
            path: "/automations",
          },
        ].map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => navigate(item.path)}
            className="rounded-[15px] border px-4 py-4 text-left transition hover:border-[color:var(--color-border-strong)]"
            style={{ borderColor: "var(--hair)", background: "var(--surface-2)" }}
          >
            <p className="text-sm font-semibold text-[color:var(--ink)]">{item.label}</p>
            <p className="mt-2 text-xs leading-5 text-[color:var(--muted)]">{item.detail}</p>
          </button>
        ))}
      </section>

      <div className="flex flex-wrap gap-3">
        <ActionButton tone="secondary" onClick={() => navigate("/assistant")}>
          {localize(locale, "继续去 Assistant", "Continue to Assistant")}
        </ActionButton>
        <ActionButton tone="secondary" onClick={() => navigate("/observability")}>
          {localize(locale, "打开 Observability", "Open Observability")}
        </ActionButton>
      </div>

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-2xl font-semibold text-[color:var(--color-text-primary)]" style={{ fontFamily: "var(--font-serif)" }}>
              {localize(locale, "继续推进的自创任务", "User Tasks to Keep Moving")}
            </h3>
            <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
              {localize(locale, "首页这里只保留你自己创建的任务，不再把官方行业包重新露出来。真实运行链路保持不变。", "Home only keeps the tasks you created. Built-in packs stay hidden here while the live run wiring remains intact.")}
            </p>
          </div>
          <ActionButton tone="secondary" onClick={() => navigate("/packs")}>
            <Pin className="mr-2 h-4 w-4" />
            {localize(locale, "管理任务库", "Manage task library")}
          </ActionButton>
        </div>

        {pinnedPacks.length === 0 ? (
          recommendedPacks.length === 0 ? (
            <ShellCard title={localize(locale, "还没有自创任务", "No user-created tasks yet")}>
              <div className="space-y-3">
                <p className="text-sm text-[color:var(--color-text-secondary)]">
                  {localize(locale, "先去“行业与任务”页创建你的第一个任务，再把它固定回首页。", "Create your first task from the Packs page, then pin it back to home.")}
                </p>
                <div>
                  <ActionButton tone="secondary" onClick={() => navigate("/packs")}>
                    {localize(locale, "去创建任务", "Create a task")}
                  </ActionButton>
                </div>
              </div>
            </ShellCard>
          ) : (
            <ShellCard title={localize(locale, "先固定几个入口", "Pin a few entries first")}>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {recommendedPacks.map((pack) => (
                  <PackCard
                    key={pack.id}
                    pack={pack}
                    compact
                    note={pack.productCopy ? localize(locale, pack.productCopy.resultSummary.zh, pack.productCopy.resultSummary.en) : undefined}
                    onOpen={() => setSelectedPackId(pack.id)}
                    onPin={() => pinPack(pack.id)}
                  />
                ))}
              </div>
            </ShellCard>
          )
        ) : (
          <div className={cn("grid gap-4 md:grid-cols-2", locale === "zh" && "xl:grid-cols-3")}>
            {pinnedPacks.map((pack) => {
              const runState = findPackRuns(pack, recentRuns);
              const note = runState.activeRun
                ? `${localize(locale, "当前任务", "Current run")}: ${runState.activeRun.task}`
                : runState.recentRun
                  ? `${localize(locale, "上次处理", "Last touched")}: ${formatShortTimestamp(runState.recentRun.completedAt ?? runState.recentRun.startedAt, locale)}`
                  : pack.productCopy
                    ? localize(locale, pack.productCopy.resultSummary.zh, pack.productCopy.resultSummary.en)
                    : localize(locale, "这个入口已经可以继续接着做。", "This pack is ready to pick back up.");

              return (
                <PackCard
                  key={pack.id}
                  pack={pack}
                  pinned
                  note={note}
                  statusLabel={runState.activeRun ? localize(locale, "正在进行", "Live") : runState.recentRun ? localize(locale, "最近记录", "Recent") : undefined}
                  onOpen={() => setSelectedPackId(pack.id)}
                />
              );
            })}
          </div>
        )}
      </section>

      <PackQuickSheet
        open={Boolean(selectedPack)}
        pack={selectedPack}
        currentRunLabel={selectedPackRunState.activeRun ? formatShortTimestamp(selectedPackRunState.activeRun.startedAt, locale) : null}
        continueLabel={selectedPackRunState.recentRun ? formatShortTimestamp(selectedPackRunState.recentRun.completedAt ?? selectedPackRunState.recentRun.startedAt, locale) : null}
        onClose={() => setSelectedPackId(null)}
        onOpenCurrent={selectedPackRunState.activeRun ? () => {
          if (selectedPack && selectedPackRunState.activeRun) {
            openCurrentPackRun(selectedPack, selectedPackRunState.activeRun);
          }
        } : undefined}
        onContinue={selectedPackRunState.recentRun ? () => {
          if (selectedPack) {
            continuePack(selectedPack, selectedPackRunState.recentRun);
          }
        } : undefined}
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
          setSelectedPackId(null);
          setPendingPackPath(buildSkillHref(skillId));
        }}
        onAskFriday={(prompt) => {
          setSelectedPackId(null);
          if (selectedPack) {
            setPendingPackPath(buildPackChatHref(selectedPack.id, prompt));
          }
        }}
        onOpenAssistant={selectedPack ? () => {
          setSelectedPackId(null);
          setPendingPackPath(buildPackAssistantHref(selectedPack.id));
        } : undefined}
        onRemoveFromHome={selectedPack && pinnedPackIds.includes(selectedPack.id) ? () => {
          unpinPack(selectedPack.id);
          setSelectedPackId(null);
        } : undefined}
      />
    </div>
  );
}

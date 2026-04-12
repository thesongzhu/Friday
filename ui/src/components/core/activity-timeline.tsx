import { useMemo } from "react";
import { ShellCard } from "@/components/core/primitives";
import { localize } from "@/lib/i18n/localized-text";
import type { AgentRunRecord } from "@/lib/api/types";

// ─── Types ───

type TimelineEventType =
  | "run_completed"
  | "run_started"
  | "run_failed"
  | "run_active"
  | "automation_triggered";

type TimelineTone = "success" | "warning" | "neutral" | "info";

interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  title: string;
  timestamp: string;
  tone: TimelineTone;
}

// ─── Props ───

export interface ActivityTimelineProps {
  locale: "zh" | "en";
  runs: AgentRunRecord[];
}

// ─── Helpers ───

function relativeTime(iso: string, locale: "zh" | "en"): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return locale === "zh" ? "刚刚" : "Just now";
  if (minutes < 60)
    return locale === "zh" ? `${minutes} 分钟前` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return locale === "zh" ? `${hours} 小时前` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return locale === "zh" ? `${days} 天前` : `${days}d ago`;
}

const ACTIVE_STATUSES = new Set([
  "pending",
  "planning",
  "awaiting_clarification",
  "awaiting_plan_approval",
  "awaiting_tool_approval",
  "executing",
  "testing",
  "fixing",
]);

function deriveEvents(runs: AgentRunRecord[], locale: "zh" | "en"): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const run of runs) {
    const taskLabel =
      run.task.length > 48 ? `${run.task.slice(0, 48)}...` : run.task;

    if (run.status === "completed") {
      events.push({
        id: `${run.id}-completed`,
        type: "run_completed",
        title: locale === "zh"
          ? `完成任务: ${taskLabel}`
          : `Completed: ${taskLabel}`,
        timestamp: run.completedAt ?? run.startedAt,
        tone: "success",
      });
    } else if (run.status === "failed" || run.status === "failed_tests") {
      events.push({
        id: `${run.id}-failed`,
        type: "run_failed",
        title: locale === "zh"
          ? `任务失败: ${taskLabel}`
          : `Failed: ${taskLabel}`,
        timestamp: run.completedAt ?? run.startedAt,
        tone: "warning",
      });
    } else if (run.status === "cancelled") {
      events.push({
        id: `${run.id}-cancelled`,
        type: "run_failed",
        title: locale === "zh"
          ? `已取消: ${taskLabel}`
          : `Cancelled: ${taskLabel}`,
        timestamp: run.completedAt ?? run.startedAt,
        tone: "neutral",
      });
    } else if (ACTIVE_STATUSES.has(run.status)) {
      events.push({
        id: `${run.id}-active`,
        type: "run_active",
        title: locale === "zh"
          ? `正在执行: ${taskLabel}`
          : `Running: ${taskLabel}`,
        timestamp: run.startedAt,
        tone: "info",
      });
    }
  }

  // Sort by most recent first
  events.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  return events.slice(0, 8);
}

// ─── Dot color map ───

const DOT_COLORS: Record<TimelineTone, string> = {
  success: "bg-[color:var(--color-text-success,#34d399)]",
  warning: "bg-[color:var(--color-text-warning,#fbbf24)]",
  info: "bg-[color:var(--color-accent,#60a5fa)]",
  neutral: "bg-[color:var(--color-text-tertiary,#9ca3af)]",
};

// ─── Component ───

export function ActivityTimeline({ locale, runs }: ActivityTimelineProps) {
  const events = useMemo(() => deriveEvents(runs, locale), [runs, locale]);

  return (
    <ShellCard eyebrow={localize(locale, "活动时间线", "Activity Timeline")}>
      {events.length === 0 ? (
        <p className="py-4 text-center text-sm text-[color:var(--color-text-secondary)]">
          {localize(locale, "Friday 正在待命", "Friday is standing by")}
        </p>
      ) : (
        <div className="relative pl-4">
          {/* Vertical connector line */}
          <div
            className="absolute left-[7px] top-[6px] w-px bg-[color:var(--color-border-soft)]"
            style={{ height: `calc(100% - 12px)` }}
          />

          {events.map((event, index) => (
            <div
              key={event.id}
              className="relative flex items-start gap-3"
              style={{ minHeight: index < events.length - 1 ? 36 : undefined }}
            >
              {/* Colored dot */}
              <div
                className={`absolute -left-4 top-[6px] h-2 w-2 shrink-0 rounded-full ring-2 ring-[color:var(--color-bg-surface)] ${DOT_COLORS[event.tone]}`}
              />

              {/* Content */}
              <div className="flex min-w-0 flex-1 items-baseline justify-between gap-2 pb-2">
                <p className="min-w-0 truncate text-sm text-[color:var(--color-text-primary)]">
                  {event.title}
                </p>
                <span className="shrink-0 text-[11px] text-[color:var(--color-text-tertiary)]">
                  {relativeTime(event.timestamp, locale)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </ShellCard>
  );
}

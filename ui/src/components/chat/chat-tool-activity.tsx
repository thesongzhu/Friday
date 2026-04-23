import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { ToolCallViewModel } from "@/hooks/use-agent-run-events";
import { localize } from "@/lib/i18n/localized-text";
import { redactSecretLikeText, redactSecretLikeValue } from "@/lib/security/redact-secrets";
import { useAppLocale } from "@/providers/locale-provider";
import { cn } from "@/lib/utils/cn";

// ─── Helpers ───

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function truncateValue(value: unknown, maxLen = 200): string {
  const redacted = redactSecretLikeValue(value);
  return redacted.length > maxLen ? `${redacted.slice(0, maxLen)}...` : redacted;
}

// ─── Status badge ───

function StatusBadge({ status }: { status: ToolCallViewModel["status"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none",
        status === "running" &&
          "animate-pulse bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]",
        status === "completed" &&
          "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        status === "failed" &&
          "bg-red-500/10 text-red-600 dark:text-red-400",
      )}
    >
      {status}
    </span>
  );
}

// ─── Expanded detail pane ───

interface ToolCallDetailProps {
  call: ToolCallViewModel;
  locale: "zh" | "en";
}

function ToolCallDetail({ call, locale }: ToolCallDetailProps) {
  const l = (zh: string, en: string) => localize(locale, zh, en);

  return (
    <div className="mt-1.5 space-y-2 rounded-xl bg-[color:var(--color-bg-subtle)] px-3 py-2.5 text-xs">
      {/* Parameters */}
      {call.params && Object.keys(call.params).length > 0 && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-[color:var(--color-text-faint)]">
            {l("参数", "Parameters")}
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {Object.entries(call.params).map(([key, value]) => (
              <div key={key} className="contents">
                <span className="text-[10px] uppercase tracking-wide text-[color:var(--color-text-faint)]">
                  {key}
                </span>
                <span className="whitespace-pre-wrap break-all font-mono text-xs text-[color:var(--color-text-primary)]">
                  {truncateValue(value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Summary */}
      {call.summary && (
        <div>
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-[color:var(--color-text-faint)]">
            {l("结果", "Summary")}
          </div>
          <p className="whitespace-pre-wrap text-xs text-[color:var(--color-text-secondary)]">
            {redactSecretLikeText(call.summary)}
          </p>
        </div>
      )}

      {/* Duration */}
      {call.durationMs != null && (
        <div>
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-[color:var(--color-text-faint)]">
            {l("耗时", "Duration")}
          </div>
          <span className="font-mono text-xs text-[color:var(--color-text-secondary)]">
            {formatDuration(call.durationMs)}
          </span>
        </div>
      )}

      {/* Status badge */}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-[color:var(--color-text-faint)]">
          {l("状态", "Status")}
        </span>
        <StatusBadge status={call.status} />
      </div>
    </div>
  );
}

// ─── Main component ───

interface ChatToolActivityProps {
  toolCalls: ToolCallViewModel[];
  activeTool?: string;
}

export function ChatToolActivity({ toolCalls, activeTool }: ChatToolActivityProps) {
  const { locale } = useAppLocale();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  // Show only recent tool calls (last 5)
  const recentCalls = toolCalls.slice(-5);

  if (recentCalls.length === 0 && !activeTool) return null;

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <div className="flex items-start gap-3">
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-xs font-bold text-[color:var(--color-text-primary)]">
        F
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        {activeTool && (
          <div className="flex items-center gap-2 text-xs text-[color:var(--color-text-secondary)]">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[color:var(--color-accent)]" />
            <span>Running: {activeTool}</span>
          </div>
        )}
        {recentCalls.map((call) => {
          const isExpanded = expandedIds.has(call.id);

          return (
            <div key={call.id}>
              <button
                type="button"
                onClick={() => toggleExpanded(call.id)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs transition-colors hover:bg-[color:var(--color-bg-subtle)]",
                  call.status === "running"
                    ? "text-[color:var(--color-text-secondary)]"
                    : "text-[color:var(--color-text-tertiary)]",
                )}
              >
                <span
                  className={cn(
                    "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
                    call.status === "running"
                      ? "animate-pulse bg-[color:var(--color-accent)]"
                      : call.status === "completed"
                        ? "bg-emerald-500"
                        : "bg-red-500",
                  )}
                />
                <span className="font-medium">{call.toolName}</span>
                {call.durationMs != null && (
                  <span className="text-[color:var(--color-text-faint)]">
                    {formatDuration(call.durationMs)}
                  </span>
                )}
                {!isExpanded && call.summary && (
                  <span className="min-w-0 max-w-[300px] truncate text-[color:var(--color-text-faint)]">
                    {redactSecretLikeText(call.summary)}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-[color:var(--color-text-faint)]">
                  {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </span>
              </button>

              {isExpanded && <ToolCallDetail call={call} locale={locale} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

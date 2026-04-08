import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

interface RunSummaryItem {
  id: string;
  task: string;
  status: string;
  createdAt: string;
  durationMs?: number;
}

interface ActivitySummaryData {
  since: string | null;
  totalRuns: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  totalCostUsd: number;
  runs: RunSummaryItem[];
}

export function ActivitySummaryPanel() {
  const [dismissed, setDismissed] = useState(false);
  const [lastVisit] = useState(() => {
    const stored = localStorage.getItem("friday:lastVisit");
    const now = new Date().toISOString();
    localStorage.setItem("friday:lastVisit", now);
    return stored;
  });

  const { data, isLoading } = useQuery<ActivitySummaryData>({
    queryKey: ["agent-os", "runs", "summary", lastVisit],
    queryFn: () =>
      apiClient.get<ActivitySummaryData>(
        lastVisit
          ? `/v1/agent/runs/summary?since=${encodeURIComponent(lastVisit)}`
          : "/v1/agent/runs/summary",
      ),
    enabled: !!lastVisit && !dismissed,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (data && data.totalRuns === 0) {
      setDismissed(true);
    }
  }, [data]);

  if (dismissed || isLoading || !data || data.totalRuns === 0) {
    return null;
  }

  return (
    <div className="mb-4 rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-4 text-sm text-[color:var(--color-text-secondary)] shadow-[var(--shadow-floating)]">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-semibold text-[color:var(--color-text-primary)]">你不在时 / While You Were Away</p>
        <button
          className="text-xs text-[color:var(--color-text-faint)] hover:text-[color:var(--color-text-primary)]"
          onClick={() => setDismissed(true)}
        >
          关闭 / Dismiss
        </button>
      </div>
      <p className="mb-2 text-[color:var(--color-text-secondary)]">
        Friday 完成了 <strong className="text-[color:var(--color-text-primary)]">{data.completedCount}</strong> 个任务
        {" / "}
        Friday completed <strong className="text-[color:var(--color-text-primary)]">{data.completedCount}</strong> task{data.completedCount !== 1 ? "s" : ""}
        {data.failedCount > 0 && (
          <>，<strong className="text-[color:var(--color-text-primary)]">{data.failedCount}</strong> 个失败 / failed</>
        )}
        {data.cancelledCount > 0 && (
          <>，<strong className="text-[color:var(--color-text-primary)]">{data.cancelledCount}</strong> 个取消 / cancelled</>
        )}
        {data.totalCostUsd > 0 && (
          <>。总成本 / Total cost: <strong className="text-[color:var(--color-text-primary)]">${data.totalCostUsd.toFixed(2)}</strong>.</>
        )}
      </p>
      <ul className="space-y-1">
        {data.runs.slice(0, 5).map((run) => (
          <li key={run.id} className="flex items-center gap-2 text-xs text-[color:var(--color-text-tertiary)]">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                run.status === "completed" ? "bg-[color:var(--color-accent)]"
                  : run.status === "failed" || run.status === "failed_tests" ? "bg-[color:var(--color-text-primary)]"
                    : "bg-[color:var(--color-text-faint)]"
              }`}
            />
            <span className="truncate text-[color:var(--color-text-secondary)]">{run.task}</span>
            {run.durationMs !== undefined && (
              <span className="shrink-0 text-[10px] text-[color:var(--color-text-faint)]">
                {(run.durationMs / 1000).toFixed(1)}s
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

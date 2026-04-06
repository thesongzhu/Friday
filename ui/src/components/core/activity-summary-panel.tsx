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
    <div className="mb-4 rounded-2xl border border-sky-400/20 bg-sky-400/[0.06] p-4 text-sm text-sky-100">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-semibold">While you were away</p>
        <button
          className="text-xs text-sky-300/60 hover:text-sky-200"
          onClick={() => setDismissed(true)}
        >
          Dismiss
        </button>
      </div>
      <p className="mb-2 text-sky-100/70">
        Friday completed <strong>{data.completedCount}</strong> task{data.completedCount !== 1 ? "s" : ""}
        {data.failedCount > 0 && (
          <>, <strong className="text-red-300">{data.failedCount}</strong> failed</>
        )}
        {data.cancelledCount > 0 && (
          <>, <strong>{data.cancelledCount}</strong> cancelled</>
        )}
        {data.totalCostUsd > 0 && (
          <> Total cost: <strong>${data.totalCostUsd.toFixed(2)}</strong>.</>
        )}
      </p>
      <ul className="space-y-1">
        {data.runs.slice(0, 5).map((run) => (
          <li key={run.id} className="flex items-center gap-2 text-xs text-sky-100/60">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                run.status === "completed" ? "bg-emerald-400"
                  : run.status === "failed" || run.status === "failed_tests" ? "bg-red-400"
                    : "bg-zinc-400"
              }`}
            />
            <span className="truncate">{run.task}</span>
            {run.durationMs !== undefined && (
              <span className="shrink-0 text-[10px] text-sky-100/40">
                {(run.durationMs / 1000).toFixed(1)}s
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

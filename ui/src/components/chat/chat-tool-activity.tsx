import type { ToolCallViewModel } from "@/hooks/use-agent-run-events";
import { cn } from "@/lib/utils/cn";

interface ChatToolActivityProps {
  toolCalls: ToolCallViewModel[];
  activeTool?: string;
}

export function ChatToolActivity({ toolCalls, activeTool }: ChatToolActivityProps) {
  // Show only recent tool calls (last 5)
  const recentCalls = toolCalls.slice(-5);

  if (recentCalls.length === 0 && !activeTool) return null;

  return (
    <div className="flex items-start gap-3">
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-emerald-400/30 bg-emerald-400/10 text-xs font-bold text-emerald-300">
        F
      </div>
      <div className="space-y-1.5">
        {activeTool && (
          <div className="flex items-center gap-2 text-xs text-white/50">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            <span>Running: {activeTool}</span>
          </div>
        )}
        {recentCalls.map((call) => (
          <div
            key={call.id}
            className={cn(
              "flex items-center gap-2 text-xs",
              call.status === "running" ? "text-white/50" : "text-white/30",
            )}
          >
            <span
              className={cn(
                "inline-block h-1.5 w-1.5 rounded-full",
                call.status === "running"
                  ? "animate-pulse bg-emerald-400"
                  : call.status === "completed"
                    ? "bg-emerald-600"
                    : "bg-rose-500",
              )}
            />
            <span>{call.toolName}</span>
            {call.durationMs != null && (
              <span className="text-white/20">({call.durationMs}ms)</span>
            )}
            {call.summary && (
              <span className="max-w-[300px] truncate text-white/25">{call.summary}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

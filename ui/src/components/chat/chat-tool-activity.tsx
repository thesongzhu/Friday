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
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-xs font-bold text-[color:var(--color-text-primary)]">
        F
      </div>
      <div className="space-y-1.5">
        {activeTool && (
          <div className="flex items-center gap-2 text-xs text-[color:var(--color-text-secondary)]">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[color:var(--color-accent)]" />
            <span>Running: {activeTool}</span>
          </div>
        )}
        {recentCalls.map((call) => (
          <div
            key={call.id}
            className={cn(
              "flex items-center gap-2 text-xs",
              call.status === "running"
                ? "text-[color:var(--color-text-secondary)]"
                : "text-[color:var(--color-text-tertiary)]",
            )}
          >
            <span
              className={cn(
                "inline-block h-1.5 w-1.5 rounded-full",
                call.status === "running"
                  ? "animate-pulse bg-[color:var(--color-accent)]"
                  : call.status === "completed"
                    ? "bg-[color:var(--color-text-primary)]"
                    : "bg-[color:var(--color-border-strong)]",
              )}
            />
            <span>{call.toolName}</span>
            {call.durationMs != null && (
              <span className="text-[color:var(--color-text-faint)]">({call.durationMs}ms)</span>
            )}
            {call.summary && (
              <span className="max-w-[300px] truncate text-[color:var(--color-text-faint)]">{call.summary}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

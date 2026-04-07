import { useQuery } from "@tanstack/react-query";
import { agentApi } from "@/lib/api/agent";
import type { RunAuditEvent } from "@/lib/api/agent";

interface ChatAuditDrawerProps {
  runId: string;
  open: boolean;
  onClose: () => void;
}

const EVENT_LABELS: Record<string, string> = {
  "agent.run.started": "Run started",
  "agent.run.tool_start": "Tool started",
  "agent.run.tool_end": "Tool ended",
  "agent.run.route_selected": "Provider selected",
  "agent.run.route_fallback": "Provider fallback",
  "agent.run.route_mismatch": "Routing mismatch",
  "agent.run.degraded": "Degraded",
  "agent.run.mode_changed": "Mode changed",
  "agent.run.awaiting_tool_approval": "Awaiting approval",
  "agent.run.completed": "Run completed",
  "agent.run.failed": "Run failed",
  "agent.run.cancelled": "Run cancelled",
};

const EVENT_DOTS: Record<string, string> = {
  "agent.run.started": "bg-[color:var(--color-accent)]",
  "agent.run.tool_start": "bg-[color:var(--color-text-secondary)]",
  "agent.run.tool_end": "bg-[color:var(--color-text-secondary)]",
  "agent.run.route_selected": "bg-[color:var(--color-accent)]",
  "agent.run.route_fallback": "bg-[color:var(--color-border-strong)]",
  "agent.run.route_mismatch": "bg-[color:var(--color-text-primary)]",
  "agent.run.degraded": "bg-[color:var(--color-border-strong)]",
  "agent.run.mode_changed": "bg-[color:var(--color-border-strong)]",
  "agent.run.awaiting_tool_approval": "bg-[color:var(--color-accent)]",
  "agent.run.completed": "bg-[color:var(--color-accent)]",
  "agent.run.failed": "bg-[color:var(--color-text-primary)]",
  "agent.run.cancelled": "bg-[color:var(--color-text-tertiary)]",
};

function formatPayload(event: RunAuditEvent): string {
  const p = event.payload;
  if (event.type === "agent.run.tool_start" || event.type === "agent.run.tool_end") {
    const name = typeof p.toolName === "string" ? p.toolName : "unknown";
    const dur = typeof p.durationMs === "number" ? ` (${p.durationMs}ms)` : "";
    const summary = typeof p.summary === "string" ? ` — ${p.summary}` : "";
    return `${name}${dur}${summary}`;
  }
  if (event.type === "agent.run.route_selected") {
    const provider = typeof p.actualProviderId === "string" ? p.actualProviderId : "?";
    const model = typeof p.actualModel === "string" ? p.actualModel : "?";
    return `${provider} / ${model}`;
  }
  if (event.type === "agent.run.degraded") {
    return typeof p.message === "string" ? p.message : `Level: ${String(p.level ?? "?")}`;
  }
  if (event.type === "agent.run.mode_changed") {
    return `${String(p.previousMode ?? "?")} → ${String(p.newMode ?? "?")}`;
  }
  if (event.type === "agent.run.awaiting_tool_approval") {
    return `${String(p.toolName ?? "?")} — ${String(p.reason ?? "")}`;
  }
  return "";
}

export function ChatAuditDrawer({ runId, open, onClose }: ChatAuditDrawerProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["agent-os", "runs", runId, "audit"],
    queryFn: () => agentApi.getRunAudit(runId),
    enabled: open,
  });

  if (!open) return null;

  return (
    <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-base)] shadow-[0_20px_60px_rgba(51,41,34,0.18)]">
      <div className="flex items-center justify-between border-b border-[color:var(--color-border-soft)] px-4 py-3">
        <h2 className="text-sm font-semibold text-[color:var(--color-text-primary)]">Audit Trail</h2>
        <button
          onClick={onClose}
          className="rounded-lg p-1 text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-surface)] hover:text-[color:var(--color-text-primary)]"
        >
          &times;
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {isLoading && (
          <p className="text-sm text-[color:var(--color-text-secondary)]">Loading audit events...</p>
        )}
        {data && data.events.length === 0 && (
          <p className="text-sm text-[color:var(--color-text-secondary)]">No audit events recorded.</p>
        )}
        {data && data.events.length > 0 && (
          <ol className="relative border-l border-[color:var(--color-border-soft)] pl-4">
            {data.events.map((event) => {
              const label = EVENT_LABELS[event.type] ?? event.type;
              const dot = EVENT_DOTS[event.type] ?? "bg-[color:var(--color-text-tertiary)]";
              const detail = formatPayload(event);
              return (
                <li key={event.seq} className="mb-4 ml-2">
                  <span
                    className={`absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full ${dot}`}
                  />
                  <time className="mb-1 block text-[10px] font-mono text-[color:var(--color-text-faint)]">
                    {event.timestamp}
                  </time>
                  <p className="text-sm font-medium text-[color:var(--color-text-primary)]">{label}</p>
                  {detail && (
                    <p className="text-xs text-[color:var(--color-text-secondary)]">{detail}</p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}

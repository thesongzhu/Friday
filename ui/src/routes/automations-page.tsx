import type { ReactNode } from "react";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, Play, Plus, RefreshCcw, SquarePen } from "lucide-react";
import { toast } from "sonner";
import { automationsApi } from "@/lib/api/automations";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";

function formatTimestamp(value?: string): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function summarizeSchedule(schedule?: { type: "cron"; cron: string; timezone?: string } | null): string {
  if (!schedule) return "Manual";
  return `${schedule.cron}${schedule.timezone ? ` · ${schedule.timezone}` : ""}`;
}

export function AutomationsPage() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [taskTemplate, setTaskTemplate] = useState("");
  const [cron, setCron] = useState("");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);

  const { data: automations = [], isLoading, refetch } = useQuery({
    queryKey: ["agent-os", "automations"],
    queryFn: () => automationsApi.list({ limit: 50 }),
  });

  const createAutomationMutation = useMutation({
    mutationFn: () =>
      automationsApi.create({
        name: name.trim(),
        taskTemplate: taskTemplate.trim(),
        schedule: cron.trim().length > 0
          ? {
            type: "cron",
            cron: cron.trim(),
            timezone: timezone.trim() || undefined,
          }
          : undefined,
        enabled: true,
      }),
    onSuccess: () => {
      toast.success("Task created");
      setName("");
      setTaskTemplate("");
      setCron("");
      void queryClient.invalidateQueries({ queryKey: ["agent-os", "automations"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to create task");
    },
  });

  const runAutomationMutation = useMutation({
    mutationFn: (automationId: string) => automationsApi.run(automationId),
    onSuccess: () => {
      toast.success("Task run started");
      void queryClient.invalidateQueries({ queryKey: ["agent-os", "automations"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to run task");
    },
  });

  const toggleAutomationMutation = useMutation({
    mutationFn: (input: { automationId: string; enabled: boolean }) =>
      automationsApi.update(input.automationId, { enabled: input.enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent-os", "automations"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to update task");
    },
  });

  return (
    <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
      <div className="space-y-4">
        <ShellCard eyebrow="Create Task" title="Quick Queue Entry">
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim() || !taskTemplate.trim()) {
                toast.error("Name and task template are required");
                return;
              }
              createAutomationMutation.mutate();
            }}
          >
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="agent-input"
              placeholder="Task name"
            />
            <textarea
              value={taskTemplate}
              onChange={(event) => setTaskTemplate(event.target.value)}
              rows={6}
              className="agent-textarea"
              placeholder="Describe the task to run when this automation is triggered."
            />
            <div className="grid gap-3 md:grid-cols-[1fr_220px]">
              <input
                value={cron}
                onChange={(event) => setCron(event.target.value)}
                className="agent-input"
                placeholder="Cron schedule (optional)"
              />
              <input
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                className="agent-input"
                placeholder="Timezone"
              />
            </div>
            <ActionButton type="submit" disabled={createAutomationMutation.isPending}>
              <Plus className="mr-2 h-4 w-4" />
              Create Task
            </ActionButton>
          </form>
        </ShellCard>

        <ShellCard eyebrow="Queue Diagnostics" title="Operator Notes">
          <div className="space-y-3 text-sm leading-6 text-white/60">
            <p>
              This phase keeps task management intentionally lightweight. You can create manual or cron-backed tasks, trigger them on demand, and flip enablement without exposing the old automation builder UI.
            </p>
            <p>
              Detailed workflow, memory, and session tooling has been intentionally deferred behind redirects while the Agent OS shell becomes the primary entrypoint.
            </p>
          </div>
        </ShellCard>
      </div>

      <ShellCard
        eyebrow="Task Queue"
        title="Scheduled Work"
        aside={
          <ActionButton tone="secondary" onClick={() => void refetch()}>
            <RefreshCcw className="mr-2 h-4 w-4" />
            Refresh
          </ActionButton>
        }
      >
        {isLoading ? (
          <p className="text-sm text-white/60">Loading task queue...</p>
        ) : automations.length === 0 ? (
          <div className="rounded-[28px] border border-dashed border-white/[0.12] bg-black/20 p-8 text-center text-sm text-white/60">
            No scheduled tasks exist yet.
          </div>
        ) : (
          <div className="space-y-3">
            {automations.map((automation) => (
              <div key={automation.id} className="rounded-[26px] border border-white/10 bg-black/20 p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-semibold text-white">{automation.name}</h2>
                      <StatusPill tone={automation.enabled ? "success" : "neutral"}>
                        {automation.enabled ? "enabled" : "paused"}
                      </StatusPill>
                    </div>
                    {automation.description ? (
                      <p className="text-sm text-white/60">{automation.description}</p>
                    ) : null}
                    <p className="text-sm text-white/40">{automation.taskTemplate}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      tone="secondary"
                      onClick={() => runAutomationMutation.mutate(automation.id)}
                    >
                      <Play className="mr-2 h-4 w-4" />
                      Run
                    </ActionButton>
                    <ActionButton
                      tone="secondary"
                      onClick={() => toggleAutomationMutation.mutate({
                        automationId: automation.id,
                        enabled: !automation.enabled,
                      })}
                    >
                      <SquarePen className="mr-2 h-4 w-4" />
                      {automation.enabled ? "Pause" : "Enable"}
                    </ActionButton>
                  </div>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <TaskMetric label="Schedule" value={summarizeSchedule(automation.schedule)} icon={<Clock3 className="h-4 w-4" />} />
                  <TaskMetric label="Last Run" value={formatTimestamp(automation.lastRunAt)} icon={<Play className="h-4 w-4" />} />
                  <TaskMetric label="Run Count" value={String(automation.runCount)} icon={<RefreshCcw className="h-4 w-4" />} />
                </div>
              </div>
            ))}
          </div>
        )}
      </ShellCard>
    </div>
  );
}

function TaskMetric(props: { label: string; value: string; icon: ReactNode }) {
  return (
    <div className="rounded-[22px] border border-white/[0.08] bg-white/[0.04] p-4">
      <div className="flex items-center gap-2 text-white/40">
        {props.icon}
        <span className="text-xs font-semibold uppercase tracking-[0.18em]">{props.label}</span>
      </div>
      <p className="mt-3 text-sm text-white">{props.value}</p>
    </div>
  );
}

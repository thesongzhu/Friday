import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, Pencil, Play, Plus, RefreshCcw, SquarePen, X } from "lucide-react";
import { toast } from "sonner";
import { useSearchParams } from "react-router-dom";
import { automationsApi } from "@/lib/api/automations";
import { ActionButton, ShellCard, SkeletonList, StatusPill } from "@/components/core/primitives";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

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
  const locale = useAppLocale();
  const [searchParams] = useSearchParams();
  const [name, setName] = useState("");
  const [taskTemplate, setTaskTemplate] = useState("");
  const [cron, setCron] = useState("");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editTask, setEditTask] = useState("");
  const [editCron, setEditCron] = useState("");

  useEffect(() => {
    const seededName = searchParams.get("name");
    const seededTask = searchParams.get("task");
    const seededTimezone = searchParams.get("timezone");
    if (seededName) {
      setName(seededName);
    }
    if (seededTask) {
      setTaskTemplate(seededTask);
    }
    if (seededTimezone) {
      setTimezone(seededTimezone);
    }
  }, [searchParams]);

  const { data: automations = [], isLoading, refetch } = useQuery({
    queryKey: ["agent-os", "automations"],
    queryFn: () => automationsApi.list({ limit: 50 }),
  });

  const sortedAutomations = useMemo(
    () =>
      [...automations].sort((left, right) =>
        right.lastOutcomeScore - left.lastOutcomeScore
        || right.estimatedTimeSavedMinutes - left.estimatedTimeSavedMinutes
        || right.reuseCount - left.reuseCount
        || right.runCount - left.runCount,
      ),
    [automations],
  );

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
      toast.error(error instanceof Error ? error.message : localize(locale, "更新任务失败", "Failed to update task"));
    },
  });

  const editAutomationMutation = useMutation({
    mutationFn: (input: { automationId: string; name: string; taskTemplate: string; cron: string }) =>
      automationsApi.update(input.automationId, {
        name: input.name,
        taskTemplate: input.taskTemplate,
        ...(input.cron ? { schedule: { type: "cron" as const, cron: input.cron } } : {}),
      }),
    onSuccess: () => {
      toast.success(localize(locale, "任务已更新", "Task updated"));
      setEditingId(null);
      void queryClient.invalidateQueries({ queryKey: ["agent-os", "automations"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "更新任务失败", "Failed to update task"));
    },
  });

  function startEditing(automation: { id: string; name: string; taskTemplate: string; schedule?: { cron?: string } }) {
    setEditingId(automation.id);
    setEditName(automation.name);
    setEditTask(automation.taskTemplate);
    setEditCron(automation.schedule?.cron ?? "");
  }

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
              data-testid="automations-name-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="agent-input"
              placeholder="Task name"
            />
            <textarea
              data-testid="automations-task-input"
              value={taskTemplate}
              onChange={(event) => setTaskTemplate(event.target.value)}
              rows={6}
              className="agent-textarea"
              placeholder="Describe the task to run when this automation is triggered."
            />
            <div className="grid gap-3 md:grid-cols-[1fr_220px]">
              <input
                data-testid="automations-cron-input"
                value={cron}
                onChange={(event) => setCron(event.target.value)}
                className="agent-input"
                placeholder="Cron schedule (optional)"
              />
              <input
                data-testid="automations-timezone-input"
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
          <div className="space-y-3 text-sm leading-6 text-[color:var(--color-text-secondary)]">
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
          <SkeletonList rows={3} />
        ) : sortedAutomations.length === 0 ? (
          <div className="rounded-[28px] border border-dashed border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-8 text-center text-sm text-[color:var(--color-text-secondary)]">
            No scheduled tasks exist yet.
          </div>
        ) : (
          <div className="space-y-3">
            {sortedAutomations.map((automation) => (
              <div
                key={automation.id}
                className="rounded-[26px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-5"
                data-testid={`automation-card-${automation.id}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-semibold text-[color:var(--color-text-primary)]">{automation.name}</h2>
                      <StatusPill tone={automation.enabled ? "success" : "neutral"}>
                        {automation.enabled ? "enabled" : "paused"}
                      </StatusPill>
                      <StatusPill tone={automation.promotionState === "public_boost_eligible" ? "warning" : automation.promotionState === "team" ? "success" : "neutral"}>
                        {automation.promotionState.replaceAll("_", " ")}
                      </StatusPill>
                    </div>
                    {automation.description ? (
                      <p className="text-sm text-[color:var(--color-text-secondary)]">{automation.description}</p>
                    ) : null}
                    <p className="text-sm text-[color:var(--color-text-faint)]">{automation.taskTemplate}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      tone="secondary"
                      onClick={() => runAutomationMutation.mutate(automation.id)}
                    >
                      <Play className="mr-2 h-4 w-4" aria-hidden="true" />
                      {localize(locale, "运行", "Run")}
                    </ActionButton>
                    <ActionButton
                      tone="secondary"
                      onClick={() => startEditing(automation)}
                    >
                      <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
                      {localize(locale, "编辑", "Edit")}
                    </ActionButton>
                    <ActionButton
                      tone="secondary"
                      onClick={() => toggleAutomationMutation.mutate({
                        automationId: automation.id,
                        enabled: !automation.enabled,
                      })}
                    >
                      <SquarePen className="mr-2 h-4 w-4" aria-hidden="true" />
                      {automation.enabled ? localize(locale, "暂停", "Pause") : localize(locale, "启用", "Enable")}
                    </ActionButton>
                  </div>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-4">
                  <TaskMetric label="Schedule" value={summarizeSchedule(automation.schedule)} icon={<Clock3 className="h-4 w-4" />} />
                  <TaskMetric label="Time Saved" value={`${automation.estimatedTimeSavedMinutes} min`} icon={<Clock3 className="h-4 w-4" />} />
                  <TaskMetric label="Reuse Count" value={String(automation.reuseCount)} icon={<RefreshCcw className="h-4 w-4" />} />
                  <TaskMetric label="Outcome Score" value={String(Math.round(automation.lastOutcomeScore))} icon={<Play className="h-4 w-4" />} />
                </div>
                {editingId === automation.id && (
                  <div className="mt-4 space-y-2 rounded-xl border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">{localize(locale, "编辑任务", "Edit Task")}</p>
                      <button type="button" onClick={() => setEditingId(null)} className="rounded-full p-1 text-[color:var(--color-text-faint)] hover:text-[color:var(--color-text-primary)]" aria-label={localize(locale, "取消编辑", "Cancel edit")}>
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                    <input value={editName} onChange={(e) => setEditName(e.target.value)} className="agent-input py-2 text-sm" placeholder={localize(locale, "任务名称", "Task name")} />
                    <textarea value={editTask} onChange={(e) => setEditTask(e.target.value)} className="agent-textarea resize-none py-2 text-sm" rows={2} placeholder={localize(locale, "任务描述", "Task template")} />
                    <input value={editCron} onChange={(e) => setEditCron(e.target.value)} className="agent-input py-2 text-sm" placeholder={localize(locale, "Cron 表达式（可选）", "Cron schedule (optional)")} />
                    <ActionButton
                      disabled={editName.trim().length === 0 || editTask.trim().length === 0 || editAutomationMutation.isPending}
                      onClick={() => editAutomationMutation.mutate({ automationId: automation.id, name: editName.trim(), taskTemplate: editTask.trim(), cron: editCron.trim() })}
                    >
                      {editAutomationMutation.isPending ? localize(locale, "保存中...", "Saving...") : localize(locale, "保存修改", "Save Changes")}
                    </ActionButton>
                  </div>
                )}

                <p className="mt-3 text-xs text-[color:var(--color-text-faint)]">
                  {localize(locale, "上次运行", "Last run")} {formatTimestamp(automation.lastRunAt)} · {localize(locale, "总运行", "total runs")} {automation.runCount}
                </p>
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
    <div className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
      <div className="flex items-center gap-2 text-[color:var(--color-text-faint)]">
        {props.icon}
        <span className="text-xs font-semibold uppercase tracking-[0.18em]">{props.label}</span>
      </div>
      <p className="mt-3 text-sm text-[color:var(--color-text-primary)]">{props.value}</p>
    </div>
  );
}

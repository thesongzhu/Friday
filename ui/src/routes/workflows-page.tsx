import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Package, PlayCircle, RefreshCcw } from "lucide-react";
import { toast } from "sonner";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";
import { workflowsApi } from "@/lib/api/workflows";
import { systemApi } from "@/lib/api/system";
import { systemKeys } from "@/lib/system/query-keys";
import {
  buildWorkflowGuidedSteps,
  buildWorkflowHref,
  summarizeWorkflowAttention,
  type FridayWorkflowFocus,
} from "@/lib/workflows/view-models";

function formatTimestamp(value?: string): string {
  if (!value) return "Unknown";
  return new Date(value).toLocaleString();
}

function toneForRunStatus(status?: string): "neutral" | "success" | "warning" | "danger" {
  if (status === "completed") return "success";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "running" || status === "queued") return "warning";
  return "neutral";
}

function parseWorkflowFocus(value: string | null): FridayWorkflowFocus {
  if (value === "recovery" || value === "deploy" || value === "export" || value === "history") {
    return value;
  }
  return "details";
}

function focusLabel(focus: FridayWorkflowFocus): string {
  if (focus === "recovery") return "Recovery focus";
  if (focus === "deploy") return "Deploy focus";
  if (focus === "export") return "Export focus";
  if (focus === "history") return "History focus";
  return "Workflow detail";
}

export function WorkflowsPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const requestedWorkflowId = searchParams.get("workflowId");
  const focus = parseWorkflowFocus(searchParams.get("focus"));

  const workflowsQuery = useQuery({
    queryKey: ["workflows", "list"],
    queryFn: () => workflowsApi.list({ limit: 50 }),
    refetchInterval: 15_000,
  });

  const workflows = workflowsQuery.data?.items ?? [];

  useEffect(() => {
    if (requestedWorkflowId && workflows.some((workflow) => workflow.id === requestedWorkflowId)) {
      setSelectedWorkflowId((current) => (current === requestedWorkflowId ? current : requestedWorkflowId));
      return;
    }

    if (!selectedWorkflowId && workflows.length > 0) {
      const firstWorkflowId = workflows[0]!.id;
      setSelectedWorkflowId(firstWorkflowId);
      setSearchParams(
        {
          workflowId: firstWorkflowId,
          focus,
        },
        { replace: true },
      );
    }
  }, [focus, requestedWorkflowId, selectedWorkflowId, setSearchParams, workflows]);

  const selectedWorkflow = workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? null;

  const overviewQuery = useQuery({
    queryKey: selectedWorkflowId ? systemKeys.workflowOverview(selectedWorkflowId) : ["system", "workflow-overview", "empty"],
    queryFn: () => systemApi.getWorkflowOverview(selectedWorkflowId!),
    enabled: selectedWorkflowId !== null,
    refetchInterval: 10_000,
  });

  const visualizationQuery = useQuery({
    queryKey: selectedWorkflowId
      ? systemKeys.workflowVisualization(
        selectedWorkflowId,
        overviewQuery.data?.latestDraft?.draftId ?? overviewQuery.data?.publishedVersion?.id ?? "default",
      )
      : ["system", "workflow-visualization", "empty"],
    queryFn: () =>
      systemApi.getWorkflowVisualization(selectedWorkflowId!, {
        draftId: overviewQuery.data?.latestDraft?.draftId,
        versionId: overviewQuery.data?.latestDraft ? undefined : overviewQuery.data?.publishedVersion?.id,
        timelineLimit: 16,
      }),
    enabled: selectedWorkflowId !== null && overviewQuery.data !== undefined,
    refetchInterval: 10_000,
  });

  const deployMutation = useMutation({
    mutationFn: (input: { workflowId: string; draftId: string; includeExport: boolean; runNow: boolean }) =>
      systemApi.deployWorkflowDraft(input.workflowId, input.draftId, {
        includeExport: input.includeExport,
        resyncTriggers: true,
        runNow: input.runNow,
      }),
    onSuccess: (deployment) => {
      toast.success(
        deployment.exportBundle
          ? "Workflow bundle exported and deployment evidence recorded."
          : "Workflow deployed.",
      );
      if (selectedWorkflowId) {
        void queryClient.invalidateQueries({ queryKey: systemKeys.workflowOverview(selectedWorkflowId) });
        void queryClient.invalidateQueries({
          queryKey: systemKeys.workflowVisualization(
            selectedWorkflowId,
            overviewQuery.data?.latestDraft?.draftId ?? overviewQuery.data?.publishedVersion?.id ?? "default",
          ),
        });
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Workflow deploy failed");
    },
  });

  const graphNodes = useMemo(() => {
    const spec = visualizationQuery.data?.spec;
    const visual = visualizationQuery.data?.visual;
    if (!spec || !visual) return [];
    return visual.nodes.map((node) => {
      const step = spec.steps.find((entry) => entry.id === node.nodeId);
      return {
        id: node.nodeId,
        x: node.x,
        y: node.y,
        label: step?.id ?? (node.nodeId === "__trigger__" ? "Trigger" : node.nodeId),
        type: step?.type ?? "trigger",
      };
    });
  }, [visualizationQuery.data]);

  const attentionSummary = useMemo(
    () => (overviewQuery.data ? summarizeWorkflowAttention(overviewQuery.data) : null),
    [overviewQuery.data],
  );

  const guidedSteps = useMemo(
    () =>
      overviewQuery.data
        ? buildWorkflowGuidedSteps({
          overview: overviewQuery.data,
          visualization: visualizationQuery.data,
        })
        : [],
    [overviewQuery.data, visualizationQuery.data],
  );

  const handleSelectWorkflow = (workflowId: string) => {
    setSelectedWorkflowId(workflowId);
    setSearchParams({ workflowId, focus }, { replace: false });
  };

  const updateFocus = (nextFocus: FridayWorkflowFocus) => {
    if (!selectedWorkflowId) return;
    setSearchParams({ workflowId: selectedWorkflowId, focus: nextFocus }, { replace: false });
  };

  const handlePrimaryAction = () => {
    if (!overviewQuery.data || !attentionSummary) return;
    if (attentionSummary.focus === "deploy" || attentionSummary.focus === "export" || focus === "deploy" || focus === "export") {
      if (!overviewQuery.data.latestDraft) return;
      void deployMutation.mutateAsync({
        workflowId: overviewQuery.data.workflow.id,
        draftId: overviewQuery.data.latestDraft.draftId,
        runNow: attentionSummary.focus !== "export",
        includeExport: attentionSummary.focus === "export" || focus === "export",
      });
      return;
    }
    updateFocus(attentionSummary.focus);
  };

  const handleSecondaryAction = () => {
    if (!overviewQuery.data || !attentionSummary) return;
    if (attentionSummary.secondaryLabel === "Deploy repaired draft" && overviewQuery.data.latestDraft) {
      void deployMutation.mutateAsync({
        workflowId: overviewQuery.data.workflow.id,
        draftId: overviewQuery.data.latestDraft.draftId,
        runNow: true,
        includeExport: false,
      });
      return;
    }
    if (attentionSummary.secondaryLabel === "Export bundle" && overviewQuery.data.latestDraft) {
      void deployMutation.mutateAsync({
        workflowId: overviewQuery.data.workflow.id,
        draftId: overviewQuery.data.latestDraft.draftId,
        runNow: false,
        includeExport: true,
      });
      return;
    }
    updateFocus(attentionSummary.focus === "details" ? "history" : "details");
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[0.92fr_1.08fr]">
      <div className="space-y-4">
        <ShellCard
          eyebrow={focusLabel(focus)}
          title={selectedWorkflow ? attentionSummary?.title ?? selectedWorkflow.name : "Workflow control plane"}
          aside={
            selectedWorkflow ? (
              <StatusPill tone={attentionSummary?.tone ?? "neutral"}>
                {attentionSummary?.focus ?? "details"}
              </StatusPill>
            ) : undefined
          }
        >
          {selectedWorkflow && overviewQuery.data && attentionSummary ? (
            <div className="space-y-4 text-sm text-white/70">
              <p>
                Friday brings workflow recovery and deploy actions to the top first. The graph stays here as an
                operator detail view, but you should not need DAG literacy before you know what to click.
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                <WorkflowMetric label="Selected workflow" value={selectedWorkflow.name} />
                <WorkflowMetric label="Current focus" value={focusLabel(focus)} />
                <WorkflowMetric label="Latest run" value={overviewQuery.data.latestRun?.status ?? "not run yet"} />
              </div>
              <div className="agent-subcard-strong p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-white/35">What needs attention now</p>
                <p className="mt-2 text-base font-semibold text-white">{attentionSummary.title}</p>
                <p className="mt-3 text-sm leading-6 text-white/64">{attentionSummary.summary}</p>
                <div className="mt-4 flex flex-wrap gap-3">
                  <ActionButton onClick={handlePrimaryAction} disabled={deployMutation.isPending}>
                    {attentionSummary.focus === "deploy" || attentionSummary.focus === "export" ? (
                      <PlayCircle className="mr-2 h-4 w-4" />
                    ) : (
                      <RefreshCcw className="mr-2 h-4 w-4" />
                    )}
                    {attentionSummary.primaryLabel}
                  </ActionButton>
                  {attentionSummary.secondaryLabel ? (
                    <ActionButton tone="secondary" onClick={handleSecondaryAction} disabled={deployMutation.isPending}>
                      <Package className="mr-2 h-4 w-4" />
                      {attentionSummary.secondaryLabel}
                    </ActionButton>
                  ) : null}
                  <Link
                    className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]"
                    to={buildWorkflowHref(selectedWorkflow.id, "details")}
                  >
                    Operator details
                  </Link>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-white/60">Select a workflow to unlock click-first deploy and recovery guidance.</p>
          )}
        </ShellCard>

        <ShellCard
          eyebrow="Workflow library"
          title="Choose which workflow Friday should operate next"
          aside={
            <StatusPill tone={workflows.length > 0 ? "success" : "neutral"}>
              {workflows.length} tracked
            </StatusPill>
          }
        >
          <div className="space-y-3">
            {workflows.map((workflow) => (
              <button
                key={workflow.id}
                type="button"
                onClick={() => handleSelectWorkflow(workflow.id)}
                className="agent-selection-card"
                data-active={workflow.id === selectedWorkflowId}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-white">{workflow.name}</p>
                    <p className="text-xs text-white/50">{workflow.slug}</p>
                  </div>
                  <StatusPill tone={workflow.publishedVersionNumber ? "success" : "warning"}>
                    v{workflow.latestVersionNumber}
                  </StatusPill>
                </div>
                <p className="mt-3 text-sm text-white/60">
                  {workflow.description || "No description provided yet."}
                </p>
              </button>
            ))}
            {workflows.length === 0 ? (
              <p className="text-sm text-white/60">No workflows have been created yet.</p>
            ) : null}
          </div>
        </ShellCard>

        <ShellCard eyebrow="Guided path" title="Friday shows the next safe moves before raw graph detail">
          {guidedSteps.length ? (
            <div className="space-y-3">
              {guidedSteps.map((step, index) => (
                <article key={step.id} className={index === 0 ? "agent-subcard-strong p-4" : "agent-subcard p-4"}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-white/35">
                        {index === 0 ? "Start here" : "Then"}
                      </p>
                      <p className="mt-2 text-base font-semibold text-white">{step.title}</p>
                    </div>
                    <StatusPill tone={step.tone}>{step.tone}</StatusPill>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-white/64">{step.summary}</p>
                </article>
              ))}
            </div>
          ) : (
            <p className="text-sm text-white/60">Select a workflow to load Friday's guided recovery path.</p>
          )}
        </ShellCard>

        <ShellCard eyebrow="Version history" title="Change notes and what is live">
          {overviewQuery.data ? (
            <div className="space-y-3">
              {overviewQuery.data.versionHistory.map((version) => (
                <div key={version.id} className="agent-subcard p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-white">Version {version.versionNumber}</p>
                      <p className="text-xs text-white/50">{formatTimestamp(version.createdAt)}</p>
                    </div>
                    <StatusPill tone={version.isPublished ? "success" : "neutral"}>
                      {version.isPublished ? "published" : "draft-only"}
                    </StatusPill>
                  </div>
                  <p className="mt-3 text-sm text-white/60">
                    {version.changeNote || "No change note recorded."}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-white/60">Select a workflow to inspect version history.</p>
          )}
        </ShellCard>
      </div>

      <div className="space-y-4">
        <ShellCard
          eyebrow="Current outcome"
          title="Latest run, blocker, and rerun context"
          aside={
            overviewQuery.data?.latestRun ? (
              <StatusPill tone={toneForRunStatus(overviewQuery.data.latestRun.status)}>
                {overviewQuery.data.latestRun.status}
              </StatusPill>
            ) : undefined
          }
        >
          {overviewQuery.data?.latestRun ? (
            <div className="space-y-4 text-sm text-white/70">
              <div className="grid gap-3 sm:grid-cols-3">
                <WorkflowMetric label="Run status" value={overviewQuery.data.latestRun.status} />
                <WorkflowMetric label="Started" value={formatTimestamp(overviewQuery.data.latestRun.startedAt)} />
                <WorkflowMetric label="Finished" value={formatTimestamp(overviewQuery.data.latestRun.finishedAt)} />
              </div>
              <div className="space-y-3">
                {visualizationQuery.data?.nodeTimeline.map((entry) => (
                  <div key={`${entry.nodeId}:${entry.attempt}`} className="agent-subcard p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-medium text-white">{entry.nodeId}</p>
                      <StatusPill tone={entry.status === "failed" ? "danger" : entry.status === "completed" ? "success" : "warning"}>
                        {entry.status}
                      </StatusPill>
                    </div>
                    <p className="mt-2 text-white/60">{entry.message || "No failure message recorded."}</p>
                    <p className="mt-2 text-xs text-white/45">
                      Attempt {entry.attempt} · Finished {formatTimestamp(entry.finishedAt)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-white/60">Friday has not run this workflow yet.</p>
          )}
        </ShellCard>

        <ShellCard eyebrow="Evidence" title="Recent bundles and deployment artifacts">
          {visualizationQuery.data?.latestEvidenceExports.length ? (
            <div className="space-y-3">
              {visualizationQuery.data.latestEvidenceExports.map((item) => (
                <a
                  key={item.exportId}
                  href={item.uri}
                  className="agent-selection-card block"
                  target="_blank"
                  rel="noreferrer"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-white">{item.exportId}</p>
                      <p className="text-xs text-white/50">{formatTimestamp(item.createdAt)}</p>
                    </div>
                    <RefreshCcw className="h-4 w-4 text-white/45" />
                  </div>
                  <p className="mt-3 break-all text-sm text-white/60">{item.checksum}</p>
                </a>
              ))}
            </div>
          ) : (
            <p className="text-sm text-white/60">Export evidence will show up here after a bundle export or run evidence export.</p>
          )}
        </ShellCard>

        <ShellCard
          eyebrow="Operator graph"
          title={selectedWorkflow?.name ? `${selectedWorkflow.name} dependency map` : "Workflow graph"}
          aside={<StatusPill tone="neutral">advanced</StatusPill>}
        >
          {visualizationQuery.data ? (
            <div className="space-y-4">
              <p className="text-sm text-white/60">
                Friday keeps the raw graph here as operator context. Recovery, deploy, rerun, and export stay above it so this page remains click-first for standard work.
              </p>
              <div className="relative overflow-hidden rounded-[26px] border border-white/[0.08] bg-[linear-gradient(135deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] p-6">
                <div className="relative min-h-[360px]">
                  {graphNodes.map((node) => (
                    <div
                      key={node.id}
                      className="absolute w-40 rounded-[20px] border border-white/[0.1] bg-slate-950/80 p-3 shadow-[0_12px_32px_rgba(0,0,0,0.25)]"
                      style={{ left: `${node.x / 1.6}px`, top: `${node.y / 1.6}px` }}
                    >
                      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-white/45">
                        <GitBranch className="h-3.5 w-3.5" />
                        {node.type}
                      </div>
                      <p className="mt-2 font-medium text-white">{node.label}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-white/60">Select a workflow to load its graph.</p>
          )}
        </ShellCard>
      </div>
    </div>
  );
}

function WorkflowMetric(props: { label: string; value: string }) {
  return (
    <div className="agent-metric-card">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/45">{props.label}</p>
      <p className="mt-3 text-sm text-white">{props.value}</p>
    </div>
  );
}

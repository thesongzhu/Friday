import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { GitBranch, Package, PlayCircle, RefreshCcw } from "lucide-react";
import { toast } from "sonner";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";
import { HelpTooltip } from "@/components/core/help-tooltip";
import { useSystemEvents } from "@/hooks/use-system-events";
import { workflowRunsApi } from "@/lib/api/workflow-runs";
import { workflowsApi } from "@/lib/api/workflows";
import { buildObservabilityHref } from "@/lib/observability/view-models";
import { toSafeHref } from "@/lib/security/safe-url";
import { systemApi } from "@/lib/api/system";
import { systemKeys } from "@/lib/system/query-keys";
import { useAppLocale } from "@/providers/locale-provider";
import {
  buildWorkflowBuilderHref,
  buildWorkflowGuidedSteps,
  buildWorkflowHref,
  summarizeWorkflowAttention,
  type FridayWorkflowFocus,
} from "@/lib/workflows/view-models";

function formatTimestamp(value?: string): string {
  if (!value) return "—";
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

function focusLabel(focus: FridayWorkflowFocus, locale?: string): string {
  if (focus === "recovery") return locale === "zh" ? "恢复焦点" : "Recovery focus";
  if (focus === "deploy") return locale === "zh" ? "部署焦点" : "Deploy focus";
  if (focus === "export") return locale === "zh" ? "导出焦点" : "Export focus";
  if (focus === "history") return locale === "zh" ? "历史焦点" : "History focus";
  return locale === "zh" ? "工作流详情" : "Workflow detail";
}

type WorkflowGraphNodeStatus = "idle" | "queued" | "running" | "completed" | "failed" | "cancelled" | "paused";

interface WorkflowOperatorGraphNodeData extends Record<string, unknown> {
  label: string;
  nodeType: string;
  status: WorkflowGraphNodeStatus;
  message?: string;
  attempt?: number;
}

type WorkflowOperatorGraphNode = Node<WorkflowOperatorGraphNodeData, "workflow_operator_node">;
type WorkflowOperatorGraphEdge = Edge<{ branch?: string; status?: WorkflowGraphNodeStatus }>;

function normalizeGraphStatus(status?: string): WorkflowGraphNodeStatus {
  if (
    status === "queued" ||
    status === "running" ||
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "paused"
  ) {
    return status;
  }
  return "idle";
}

function graphStatusClass(status: WorkflowGraphNodeStatus): string {
  if (status === "completed") return "border-emerald-400/60 bg-emerald-500/10";
  if (status === "failed" || status === "cancelled") return "border-red-400/60 bg-red-500/10";
  if (status === "running" || status === "queued" || status === "paused") return "border-amber-400/70 bg-amber-500/10";
  return "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface-strong)]";
}

function WorkflowOperatorNode(props: NodeProps<WorkflowOperatorGraphNode>) {
  const data = props.data;
  return (
    <div className={`w-[190px] rounded-xl border px-3 py-3 shadow-[0_14px_32px_rgba(0,0,0,0.24)] ${graphStatusClass(data.status)}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-[11px] font-semibold uppercase text-[color:var(--color-text-faint)]">
          <GitBranch className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{data.nodeType}</span>
        </div>
        <span className="shrink-0 rounded-full border border-[color:var(--color-border-soft)] px-2 py-0.5 text-[10px] text-[color:var(--color-text-secondary)]">
          {data.status}
        </span>
      </div>
      <p className="mt-2 truncate text-sm font-semibold text-[color:var(--color-text-primary)]">{data.label}</p>
      {data.message ? (
        <p className="mt-2 line-clamp-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">{data.message}</p>
      ) : null}
      {data.attempt != null ? (
        <p className="mt-2 text-[11px] text-[color:var(--color-text-faint)]">Attempt {data.attempt}</p>
      ) : null}
    </div>
  );
}

const workflowOperatorNodeTypes = {
  workflow_operator_node: WorkflowOperatorNode,
};

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

export function WorkflowsPage() {
  const { locale } = useAppLocale();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [externalDraftReviewConfirmed, setExternalDraftReviewConfirmed] = useState(false);
  const requestedWorkflowId = searchParams.get("workflowId");
  const focus = parseWorkflowFocus(searchParams.get("focus"));

  const workflowsQuery = useQuery({
    queryKey: ["workflows", "list"],
    queryFn: () => workflowsApi.list({ limit: 50 }),
    refetchInterval: 15_000,
  });

  const workflows = workflowsQuery.data?.items ?? [];
  const systemEvents = useSystemEvents(selectedWorkflowId !== null);

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

  useEffect(() => {
    if (!selectedWorkflowId) return;
    const latestEvent = [...systemEvents.events].reverse().find((event) => {
      if (!event.event.startsWith("workflow.")) return false;
      const workflowId = payloadString(event.payload, "workflowId");
      const runId = payloadString(event.payload, "runId");
      return workflowId === selectedWorkflowId || runId === overviewQuery.data?.latestRun?.id;
    });
    if (!latestEvent) return;

    void queryClient.invalidateQueries({ queryKey: systemKeys.workflowOverview(selectedWorkflowId) });
    void queryClient.invalidateQueries({
      queryKey: systemKeys.workflowVisualization(
        selectedWorkflowId,
        overviewQuery.data?.latestDraft?.draftId ?? overviewQuery.data?.publishedVersion?.id ?? "default",
      ),
    });
  }, [
    overviewQuery.data?.latestDraft?.draftId,
    overviewQuery.data?.latestRun?.id,
    overviewQuery.data?.publishedVersion?.id,
    queryClient,
    selectedWorkflowId,
    systemEvents.events,
  ]);

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
    mutationFn: (input: { workflowId: string; draftId: string; includeExport: boolean; runNow: boolean; externalReviewConfirmed?: boolean }) =>
      systemApi.deployWorkflowDraft(input.workflowId, input.draftId, {
        includeExport: input.includeExport,
        resyncTriggers: true,
        runNow: input.runNow,
        externalReviewConfirmed: input.externalReviewConfirmed,
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

  const cancelRunMutation = useMutation({
    mutationFn: (runId: string) => workflowRunsApi.cancel(runId),
    onSuccess: () => {
      toast.success("Run cancelled");
      if (selectedWorkflowId) {
        void queryClient.invalidateQueries({ queryKey: systemKeys.workflowOverview(selectedWorkflowId) });
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to cancel run");
    },
  });

  const retryRunMutation = useMutation({
    mutationFn: (runId: string) => workflowRunsApi.retry(runId),
    onSuccess: () => {
      toast.success("Run retried");
      if (selectedWorkflowId) {
        void queryClient.invalidateQueries({ queryKey: systemKeys.workflowOverview(selectedWorkflowId) });
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to retry run");
    },
  });

  const resumeRunMutation = useMutation({
    mutationFn: (runId: string) => workflowRunsApi.resume(runId),
    onSuccess: () => {
      toast.success("Run resumed");
      if (selectedWorkflowId) {
        void queryClient.invalidateQueries({ queryKey: systemKeys.workflowOverview(selectedWorkflowId) });
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to resume run");
    },
  });

  const startRunMutation = useMutation({
    mutationFn: (input: { workflowId: string; workflowVersionId?: string }) =>
      workflowRunsApi.start({
        workflowId: input.workflowId,
        workflowVersionId: input.workflowVersionId,
        triggerType: "manual",
        triggerPayload: {},
      }),
    onSuccess: () => {
      toast.success(locale === "zh" ? "工作流已启动。" : "Workflow run started.");
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
      toast.error(error instanceof Error ? error.message : (locale === "zh" ? "无法启动工作流。" : "Failed to start workflow."));
    },
  });

  const graphModel = useMemo<{
    nodes: WorkflowOperatorGraphNode[];
    edges: WorkflowOperatorGraphEdge[];
  }>(() => {
    const spec = visualizationQuery.data?.spec;
    const visual = visualizationQuery.data?.visual;
    if (!spec || !visual) return { nodes: [], edges: [] };

    const latestTimelineByNode = new Map<string, NonNullable<typeof visualizationQuery.data>["nodeTimeline"][number]>();
    for (const entry of visualizationQuery.data?.nodeTimeline ?? []) {
      const previous = latestTimelineByNode.get(entry.nodeId);
      if (!previous || entry.attempt >= previous.attempt) {
        latestTimelineByNode.set(entry.nodeId, entry);
      }
    }
    const visualLayoutByNode = new Map(visual.nodes.map((node) => [node.nodeId, node]));
    const nodeIds = ["__trigger__", ...spec.steps.map((step) => step.id)];
    const nodes: WorkflowOperatorGraphNode[] = nodeIds.map((nodeId, index) => {
      const layout = visualLayoutByNode.get(nodeId);
      const step = spec.steps.find((entry) => entry.id === nodeId);
      const timeline = latestTimelineByNode.get(nodeId);
      const status = nodeId === "__trigger__"
        ? normalizeGraphStatus(visualizationQuery.data?.latestRun?.status)
        : normalizeGraphStatus(timeline?.status);
      return {
        id: nodeId,
        type: "workflow_operator_node",
        position: {
          x: layout?.x ?? (index % 3) * 260,
          y: layout?.y ?? Math.floor(index / 3) * 170,
        },
        data: {
          label: nodeId === "__trigger__" ? "Trigger" : step?.id ?? nodeId,
          nodeType: nodeId === "__trigger__" ? "trigger" : step?.type ?? "step",
          status,
          message: timeline?.message,
          attempt: timeline?.attempt,
        },
      };
    });

    const edges: WorkflowOperatorGraphEdge[] = [];
    if (spec.startStepId) {
      edges.push({
        id: `trigger:${spec.startStepId}`,
        source: "__trigger__",
        target: spec.startStepId,
        label: "start",
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed },
      });
    }
    for (const edge of spec.edges) {
      edges.push({
        id: `${edge.from}:${edge.to}:${edge.when ?? "success"}`,
        source: edge.from,
        target: edge.to,
        label: edge.when ?? "success",
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed },
        data: {
          branch: edge.when,
          status: latestTimelineByNode.has(edge.to) ? normalizeGraphStatus(latestTimelineByNode.get(edge.to)?.status) : "idle",
        },
      });
    }
    return { nodes, edges };
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

  const runnableWorkflowVersionId = overviewQuery.data?.publishedVersion?.id ?? overviewQuery.data?.latestVersion?.id;
  const latestDraftRequiresExternalReview = overviewQuery.data?.latestDraft?.sourceReview?.requiresReviewBeforePublish === true;

  useEffect(() => {
    setExternalDraftReviewConfirmed(false);
  }, [overviewQuery.data?.latestDraft?.draftId]);

  const deployLatestDraft = (input: { runNow: boolean; includeExport: boolean }) => {
    if (!overviewQuery.data?.latestDraft) return;
    if (latestDraftRequiresExternalReview && !externalDraftReviewConfirmed) {
      toast.error(locale === "zh" ? "请先确认已审查这个外部工作流草稿。" : "Review and confirm this external workflow draft before deploy.");
      return;
    }
    void deployMutation.mutateAsync({
      workflowId: overviewQuery.data.workflow.id,
      draftId: overviewQuery.data.latestDraft.draftId,
      runNow: input.runNow,
      includeExport: input.includeExport,
      externalReviewConfirmed: latestDraftRequiresExternalReview ? externalDraftReviewConfirmed : undefined,
    });
  };

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
      deployLatestDraft({
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
      deployLatestDraft({
        runNow: true,
        includeExport: false,
      });
      return;
    }
    if (attentionSummary.secondaryLabel === "Export bundle" && overviewQuery.data.latestDraft) {
      deployLatestDraft({
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
          eyebrow={focusLabel(focus, locale)}
          title={selectedWorkflow ? attentionSummary?.title ?? selectedWorkflow.name : <><HelpTooltip term="workflow" /> {locale === "zh" ? "控制面板" : "control plane"}</>}
          aside={
            selectedWorkflow ? (
              <StatusPill tone={attentionSummary?.tone ?? "neutral"}>
                {attentionSummary?.focus ?? "details"}
              </StatusPill>
            ) : undefined
          }
        >
          {selectedWorkflow && overviewQuery.data && attentionSummary ? (
            <div className="space-y-4 text-sm text-[color:var(--color-text-secondary)]">
              <p>
                {locale === "zh"
                  ? "Friday 将工作流恢复和部署操作优先展示。图表作为操作详情视图保留在此，但在标准操作中您无需了解 DAG。"
                  : "Friday brings workflow recovery and deploy actions to the top first. The graph stays here as an operator detail view, but you should not need DAG literacy before you know what to click."}
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                <WorkflowMetric label={locale === "zh" ? "已选工作流" : "Selected workflow"} value={selectedWorkflow.name} />
                <WorkflowMetric label={locale === "zh" ? "当前焦点" : "Current focus"} value={focusLabel(focus, locale)} />
                <WorkflowMetric label={locale === "zh" ? "最近运行" : "Latest run"} value={overviewQuery.data.latestRun?.status ?? (locale === "zh" ? "尚未运行" : "not run yet")} />
              </div>
              <div className="agent-subcard-strong p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{locale === "zh" ? "当前需要关注的" : "What needs attention now"}</p>
                <p className="mt-2 text-base font-semibold text-[color:var(--color-text-primary)]">{attentionSummary.title}</p>
                <p className="mt-3 text-sm leading-6 text-[color:var(--color-text-secondary)]">{attentionSummary.summary}</p>
                {latestDraftRequiresExternalReview ? (
                  <label className="mt-4 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    <input
                      type="checkbox"
                      data-testid="workflow-operator-external-draft-review-confirm"
                      className="mt-0.5 h-4 w-4"
                      checked={externalDraftReviewConfirmed}
                      onChange={(event) => setExternalDraftReviewConfirmed(event.target.checked)}
                    />
                    <span>
                      {locale === "zh"
                        ? "我已审查这个外部导入的工作流草稿，并允许本次部署或导出。"
                        : "I reviewed this externally imported workflow draft and allow this deploy or export."}
                    </span>
                  </label>
                ) : null}
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
                  {runnableWorkflowVersionId ? (
                    <ActionButton
                      tone="secondary"
                      onClick={() => startRunMutation.mutate({
                        workflowId: overviewQuery.data.workflow.id,
                        workflowVersionId: runnableWorkflowVersionId,
                      })}
                      disabled={startRunMutation.isPending}
                    >
                      <PlayCircle className="mr-2 h-4 w-4" />
                      {locale === "zh" ? "运行当前工作流" : "Run current workflow"}
                    </ActionButton>
                  ) : null}
                  <Link
                    className="inline-flex items-center rounded-2xl bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)]"
                    to={buildWorkflowHref(selectedWorkflow.id, "details")}
                  >
                    {locale === "zh" ? "操作详情" : "Operator details"}
                  </Link>
                  <Link
                    className="inline-flex items-center rounded-2xl bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)]"
                    to={buildWorkflowBuilderHref({
                      workflowId: selectedWorkflow.id,
                      draftId: overviewQuery.data.latestDraft?.draftId,
                      focus: overviewQuery.data.latestDraft ? "draft" : "templates",
                    })}
                  >
                    {locale === "zh" ? "打开编辑器" : "Open builder"}
                  </Link>
                  <Link
                    className="inline-flex items-center rounded-2xl bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)]"
                    to={buildObservabilityHref({
                      focus: overviewQuery.data.latestRun?.status === "failed" ? "traces" : "overview",
                    })}
                  >
                    {locale === "zh" ? "打开诊断" : "Open diagnostics"}
                  </Link>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{locale === "zh" ? "选择一个工作流以解锁部署和恢复引导。" : "Select a workflow to unlock click-first deploy and recovery guidance."}</p>
          )}
        </ShellCard>

        <ShellCard
          eyebrow={locale === "zh" ? "工作流库" : "Workflow library"}
          title={locale === "zh" ? <>选择 Friday 下一步要执行的<HelpTooltip term="workflow" />工作流</> : <>Choose which <HelpTooltip term="workflow" /> Friday should operate next</>}
          aside={
            <div className="flex items-center gap-2">
              <StatusPill tone={workflows.length > 0 ? "success" : "neutral"}>
                {workflows.length} {locale === "zh" ? "已跟踪" : "tracked"}
              </StatusPill>
              <Link
                className="inline-flex items-center rounded-2xl bg-[color:var(--color-bg-surface)] px-3 py-1.5 text-xs text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)]"
                to="/workflows/generator"
              >
                {locale === "zh" ? "生成草案" : "Generate draft"}
              </Link>
              <Link
                className="inline-flex items-center rounded-2xl bg-[color:var(--color-bg-surface)] px-3 py-1.5 text-xs text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)]"
                to="/workflows/builder"
              >
                {locale === "zh" ? "打开编辑器" : "Open builder"}
              </Link>
            </div>
          }
        >
          <div className="space-y-3">
            {workflows.map((workflow) => (
              <div
                key={workflow.id}
                className="agent-selection-card"
                data-active={workflow.id === selectedWorkflowId}
              >
                <button
                  type="button"
                  onClick={() => handleSelectWorkflow(workflow.id)}
                  className="w-full text-left"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-[color:var(--color-text-primary)]">{workflow.name}</p>
                      <p className="text-xs text-[color:var(--color-text-tertiary)]">{workflow.slug}</p>
                    </div>
                    <StatusPill tone={workflow.publishedVersionNumber ? "success" : "warning"}>
                      v{workflow.latestVersionNumber}
                    </StatusPill>
                  </div>
                  <p className="mt-3 text-sm text-[color:var(--color-text-secondary)]">
                    {workflow.description || (locale === "zh" ? "暂无描述。" : "No description provided yet.")}
                  </p>
                </button>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link
                    className="inline-flex items-center rounded-2xl bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)]"
                    to={buildWorkflowBuilderHref({
                      workflowId: workflow.id,
                      focus: workflow.id === selectedWorkflowId && overviewQuery.data?.latestDraft ? "draft" : "templates",
                      draftId:
                        workflow.id === selectedWorkflowId
                          ? overviewQuery.data?.latestDraft?.draftId
                          : undefined,
                    })}
                  >
                    {locale === "zh" ? "打开编辑器" : "Open builder"}
                  </Link>
                  <Link
                    className="inline-flex items-center rounded-2xl bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)]"
                    to={buildWorkflowHref(workflow.id, "details")}
                  >
                    {locale === "zh" ? "控制面板" : "Control plane"}
                  </Link>
                </div>
              </div>
            ))}
            {workflows.length === 0 ? (
              <div className="space-y-2 text-sm text-[color:var(--color-text-secondary)]">
                <p>{locale === "zh" ? "尚未创建工作流。" : "No workflows have been created yet."}</p>
                <p>{locale === "zh" ? "用自然语言描述你想自动化的内容，Friday 会为你构建。" : "Describe what you want to automate in plain language and Friday will build it for you."}</p>
                <Link to="/chat" className="inline-flex items-center rounded-full border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent-strong)]">{locale === "zh" ? "在聊天中描述" : "Describe in Chat"}</Link>
              </div>
            ) : null}
          </div>
        </ShellCard>

        <ShellCard eyebrow={locale === "zh" ? "引导路径" : "Guided path"} title={locale === "zh" ? "Friday 在展示原始图表前先显示下一步安全操作" : "Friday shows the next safe moves before raw graph detail"}>
          {guidedSteps.length ? (
            <div className="space-y-3">
              {guidedSteps.map((step, index) => (
                <article key={step.id} className={index === 0 ? "agent-subcard-strong p-4" : "agent-subcard p-4"}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
                        {index === 0 ? (locale === "zh" ? "从这里开始" : "Start here") : (locale === "zh" ? "然后" : "Then")}
                      </p>
                      <p className="mt-2 text-base font-semibold text-[color:var(--color-text-primary)]">{step.title}</p>
                    </div>
                    <StatusPill tone={step.tone}>{step.tone}</StatusPill>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-[color:var(--color-text-secondary)]">{step.summary}</p>
                </article>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{locale === "zh" ? "选择工作流以加载 Friday 的引导恢复路径。" : "Select a workflow to load Friday's guided recovery path."}</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={locale === "zh" ? "版本历史" : "Version history"} title={locale === "zh" ? "变更记录和当前上线版本" : "Change notes and what is live"}>
          {overviewQuery.data ? (
            <div className="space-y-3">
              {overviewQuery.data.versionHistory.map((version) => (
                <div key={version.id} className="agent-subcard p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-[color:var(--color-text-primary)]">Version {version.versionNumber}</p>
                      <p className="text-xs text-[color:var(--color-text-tertiary)]">{formatTimestamp(version.createdAt)}</p>
                    </div>
                    <StatusPill tone={version.isPublished ? "success" : "neutral"}>
                      {version.isPublished ? (locale === "zh" ? "已发布" : "published") : (locale === "zh" ? "仅草稿" : "draft-only")}
                    </StatusPill>
                  </div>
                  <p className="mt-3 text-sm text-[color:var(--color-text-secondary)]">
                    {version.changeNote || (locale === "zh" ? "暂无变更记录。" : "No change note recorded.")}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{locale === "zh" ? "选择工作流以查看版本历史。" : "Select a workflow to inspect version history."}</p>
          )}
        </ShellCard>
      </div>

      <div className="space-y-4">
        <ShellCard
          eyebrow={locale === "zh" ? "当前结果" : "Current outcome"}
          title={locale === "zh" ? "最近运行、阻塞和重运行上下文" : "Latest run, blocker, and rerun context"}
          aside={
            overviewQuery.data?.latestRun ? (
              <StatusPill tone={toneForRunStatus(overviewQuery.data.latestRun.status)}>
                {overviewQuery.data.latestRun.status}
              </StatusPill>
            ) : undefined
          }
        >
          {overviewQuery.data?.latestRun ? (
            <div className="space-y-4 text-sm text-[color:var(--color-text-secondary)]">
              <div className="grid gap-3 sm:grid-cols-3">
                <WorkflowMetric label={locale === "zh" ? "运行状态" : "Run status"} value={overviewQuery.data.latestRun.status} />
                <WorkflowMetric label={locale === "zh" ? "开始时间" : "Started"} value={formatTimestamp(overviewQuery.data.latestRun.startedAt)} />
                <WorkflowMetric label={locale === "zh" ? "完成时间" : "Finished"} value={formatTimestamp(overviewQuery.data.latestRun.finishedAt)} />
              </div>
              <div className="space-y-3">
                {visualizationQuery.data?.nodeTimeline.map((entry) => (
                  <div key={`${entry.nodeId}:${entry.attempt}`} className="agent-subcard p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-medium text-[color:var(--color-text-primary)]">{entry.nodeId}</p>
                      <StatusPill tone={entry.status === "failed" ? "danger" : entry.status === "completed" ? "success" : "warning"}>
                        {entry.status}
                      </StatusPill>
                    </div>
                    <p className="mt-2 text-[color:var(--color-text-secondary)]">{entry.message || (locale === "zh" ? "暂无失败消息。" : "No failure message recorded.")}</p>
                    <p className="mt-2 text-xs text-[color:var(--color-text-faint)]">
                      Attempt {entry.attempt} · Finished {formatTimestamp(entry.finishedAt)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{locale === "zh" ? "Friday 尚未运行此工作流。" : "Friday has not run this workflow yet."}</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={locale === "zh" ? "运行历史" : "Run history"} title={locale === "zh" ? "最近的工作流执行" : "Recent workflow executions"}>
          {overviewQuery.data?.recentRuns.length ? (
            <div className="space-y-3">
              {overviewQuery.data.recentRuns.map((run) => (
                <div key={run.id} className="agent-subcard p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-[color:var(--color-text-primary)]">{run.id.slice(0, 8)}</p>
                      <p className="text-xs text-[color:var(--color-text-tertiary)]">
                        {formatTimestamp(run.startedAt)}
                        {run.finishedAt ? ` — ${formatTimestamp(run.finishedAt)}` : ""}
                      </p>
                    </div>
                    <StatusPill tone={toneForRunStatus(run.status)}>{run.status}</StatusPill>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(run.status === "running" || run.status === "queued") ? (
                      <ActionButton
                        tone="danger"
                        onClick={() => cancelRunMutation.mutate(run.id)}
                        disabled={cancelRunMutation.isPending}
                      >
                        {locale === "zh" ? "取消" : "Cancel"}
                      </ActionButton>
                    ) : null}
                    {run.status === "failed" ? (
                      <ActionButton
                        onClick={() => retryRunMutation.mutate(run.id)}
                        disabled={retryRunMutation.isPending}
                      >
                        {locale === "zh" ? "重试" : "Retry"}
                      </ActionButton>
                    ) : null}
                    {run.status === "paused" ? (
                      <ActionButton
                        onClick={() => resumeRunMutation.mutate(run.id)}
                        disabled={resumeRunMutation.isPending}
                      >
                        {locale === "zh" ? "恢复" : "Resume"}
                      </ActionButton>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{locale === "zh" ? "此工作流暂无运行记录。" : "No runs recorded yet for this workflow."}</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={locale === "zh" ? "证据" : "Evidence"} title={locale === "zh" ? "最近的打包和部署产物" : "Recent bundles and deployment artifacts"}>
          {visualizationQuery.data?.latestEvidenceExports.length ? (
            <div className="space-y-3">
              {visualizationQuery.data.latestEvidenceExports.map((item) => {
                const safeHref = toSafeHref(item.uri, {
                  allowRelative: false,
                  allowedProtocols: ["http:", "https:", "file:"],
                });
                const content = (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-[color:var(--color-text-primary)]">{item.exportId}</p>
                        <p className="text-xs text-[color:var(--color-text-tertiary)]">{formatTimestamp(item.createdAt)}</p>
                      </div>
                      <RefreshCcw className="h-4 w-4 text-[color:var(--color-text-faint)]" />
                    </div>
                    <p className="mt-3 break-all text-sm text-[color:var(--color-text-secondary)]">{item.checksum}</p>
                  </>
                );
                return safeHref ? (
                  <a
                    key={item.exportId}
                    href={safeHref}
                    className="agent-selection-card block"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {content}
                  </a>
                ) : (
                  <div key={item.exportId} className="agent-selection-card block">
                    {content}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{locale === "zh" ? "导出证据将在打包导出或运行证据导出后显示在此。" : "Export evidence will show up here after a bundle export or run evidence export."}</p>
          )}
        </ShellCard>

        <ShellCard
          eyebrow={locale === "zh" ? "操作图表" : "Operator graph"}
          title={selectedWorkflow?.name ? `${selectedWorkflow.name} dependency map` : "Workflow graph"}
          aside={
            <StatusPill tone={systemEvents.connectionState === "streaming" ? "success" : "neutral"}>
              {systemEvents.connectionState === "streaming" ? "live" : "syncing"}
            </StatusPill>
          }
        >
          {visualizationQuery.data ? (
            <div className="space-y-4">
              <p className="text-sm text-[color:var(--color-text-secondary)]">
                {locale === "zh"
                  ? "Friday 将原始图表保留在此作为操作上下文。恢复、部署、重运行和导出在上方，使此页面保持点击优先。"
                  : "Friday keeps the raw graph here as operator context. Recovery, deploy, rerun, and export stay above it so this page remains click-first for standard work."}
              </p>
              <div className="h-[420px] overflow-hidden rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)]">
                <ReactFlow
                  nodes={graphModel.nodes}
                  edges={graphModel.edges}
                  nodeTypes={workflowOperatorNodeTypes}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  elementsSelectable={false}
                  fitView
                  fitViewOptions={{ padding: 0.18 }}
                  minZoom={0.35}
                  maxZoom={1.4}
                  proOptions={{ hideAttribution: true }}
                >
                  <Background color="rgba(148, 163, 184, 0.22)" gap={18} />
                  <Controls showInteractive={false} />
                </ReactFlow>
              </div>
              <div className="grid gap-2 text-xs text-[color:var(--color-text-secondary)] sm:grid-cols-4">
                <WorkflowGraphLegend status="running" label={locale === "zh" ? "执行中" : "Running"} />
                <WorkflowGraphLegend status="completed" label={locale === "zh" ? "已完成" : "Completed"} />
                <WorkflowGraphLegend status="failed" label={locale === "zh" ? "失败" : "Failed"} />
                <WorkflowGraphLegend status="idle" label={locale === "zh" ? "未触发" : "Idle"} />
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{locale === "zh" ? "选择工作流以加载其图表。" : "Select a workflow to load its graph."}</p>
          )}
        </ShellCard>
      </div>
    </div>
  );
}

function WorkflowMetric(props: { label: string; value: string }) {
  return (
    <div className="agent-metric-card">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{props.label}</p>
      <p className="mt-3 text-sm text-[color:var(--color-text-primary)]">{props.value}</p>
    </div>
  );
}

function WorkflowGraphLegend(props: { status: WorkflowGraphNodeStatus; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`h-2.5 w-2.5 rounded-full border ${graphStatusClass(props.status)}`} />
      <span>{props.label}</span>
    </div>
  );
}

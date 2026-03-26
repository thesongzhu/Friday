import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Rocket, Wrench } from "lucide-react";
import { toast } from "sonner";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";
import { useAuth } from "@/hooks/use-auth";
import { workflowBuilderApi } from "@/lib/api/workflow-builder";
import { workflowsApi } from "@/lib/api/workflows";
import type {
  AgentTaskProfileId,
  FridayStableWorkflowTemplate,
  FridayWorkflowDraftEntity,
  FridayWorkflowTemplateEntity,
} from "@/lib/api/types";
import { createDefaultRawGraph } from "@/lib/workflows/defaults";
import {
  buildWorkflowBuilderHref,
  buildWorkflowHref,
  type FridayWorkflowBuilderFocus,
} from "@/lib/workflows/view-models";

const TASK_PROFILE_OPTIONS: Array<{
  id: AgentTaskProfileId;
  label: string;
  detail: string;
}> = [
  { id: "default", label: "Balanced", detail: "General-purpose profile." },
  { id: "deterministic", label: "Deterministic", detail: "Low-variance structured execution." },
  { id: "planning", label: "Planning", detail: "Higher-effort planning and decomposition." },
  { id: "review", label: "Review", detail: "Low-variance critique and validation." },
  { id: "creative", label: "Creative", detail: "Higher-variance ideation and synthesis." },
];

function parseFocus(value: string | null): FridayWorkflowBuilderFocus {
  if (value === "draft" || value === "publish") {
    return value;
  }
  return "templates";
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : `workflow-${Date.now()}`;
}

function formatTimestamp(value?: string): string {
  if (!value) return "Not yet";
  return new Date(value).toLocaleString();
}

function describeStableBinding(template: FridayStableWorkflowTemplate): string {
  return template.preferredBinding === "built-in-tool"
    ? "Prefer built-in tool"
    : "Prefer stable skill";
}

function describeIntegrationMode(input: {
  template?: FridayWorkflowTemplateEntity | null;
  stableTemplate?: FridayStableWorkflowTemplate | null;
}): { label: string; reason: string } {
  if (input.stableTemplate) {
    return input.stableTemplate.preferredBinding === "built-in-tool"
      ? {
          label: "Prefer workflow node",
          reason: "This stable template is optimized around a built-in tool binding and low-overhead execution.",
        }
      : {
          label: "Prefer stable skill",
          reason: "This stable template is designed to bind to an existing stable skill rather than ad-hoc MCP prompts.",
        };
  }
  if (!input.template) {
    return {
      label: "No template selected",
      reason: "Choose a template to inspect the recommended binding mode.",
    };
  }
  if (input.template.kind === "skill") {
    return {
      label: "Skill-derived template",
      reason: "This template came from an installed skill, so skill-backed execution is the default binding.",
    };
  }
  if (input.template.kind === "builtin") {
    return {
      label: "Builtin template",
      reason: "This template is a generic workflow starter and will usually need refinement before publish.",
    };
  }
  return {
    label: "User template",
    reason: "This template is user-owned and should be checked against your current deployment and validation needs.",
  };
}

export function WorkflowBuilderPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [title, setTitle] = useState("");
  const [selectedTaskProfileId, setSelectedTaskProfileId] = useState<AgentTaskProfileId>("planning");
  const [targetWorkflowId, setTargetWorkflowId] = useState<string>("new");
  const [changeNote, setChangeNote] = useState("Published from workflow builder.");

  const selectedTemplateId = searchParams.get("templateId");
  const requestedWorkflowId = searchParams.get("workflowId");
  const requestedDraftId = searchParams.get("draftId");
  const focus = parseFocus(searchParams.get("focus"));

  const templatesQuery = useQuery({
    queryKey: ["workflow-builder", "templates"],
    queryFn: () => workflowBuilderApi.listTemplates(),
    refetchInterval: 30_000,
  });

  const workflowsQuery = useQuery({
    queryKey: ["workflow-builder", "workflows"],
    queryFn: () => workflowsApi.list({ limit: 50 }),
    refetchInterval: 30_000,
  });

  const draftsQuery = useQuery({
    queryKey: ["workflow-builder", "drafts", requestedWorkflowId],
    queryFn: () => workflowBuilderApi.listDrafts(requestedWorkflowId!, { limit: 12 }),
    enabled: Boolean(requestedWorkflowId),
    refetchInterval: 15_000,
  });

  const resolvedDraftId = requestedDraftId ?? draftsQuery.data?.items[0]?.draftId ?? null;

  const draftQuery = useQuery({
    queryKey: ["workflow-builder", "draft", requestedWorkflowId, resolvedDraftId],
    queryFn: () => workflowBuilderApi.getDraft(requestedWorkflowId!, resolvedDraftId!),
    enabled: Boolean(requestedWorkflowId && resolvedDraftId),
    refetchInterval: 10_000,
  });

  const regularTemplates = templatesQuery.data?.items ?? [];
  const stableTemplates = templatesQuery.data?.stableItems ?? [];
  const selectedStableTemplate = stableTemplates.find((item) => item.id === selectedTemplateId) ?? null;
  const selectedRegularTemplate = regularTemplates.find((item) => item.templateId === selectedTemplateId) ?? null;

  const templateDetailQuery = useQuery({
    queryKey: ["workflow-builder", "template", selectedTemplateId],
    queryFn: () => workflowBuilderApi.getTemplate(selectedTemplateId!),
    enabled: Boolean(selectedTemplateId && !selectedStableTemplate),
  });

  const selectedTemplate = templateDetailQuery.data?.template ?? selectedRegularTemplate;
  const activeDraft = draftQuery.data?.draft ?? null;

  useEffect(() => {
    if (!selectedTemplateId) {
      const firstTemplateId = stableTemplates[0]?.id ?? regularTemplates[0]?.templateId;
      if (!firstTemplateId) return;
      const next = new URLSearchParams(searchParams);
      next.set("templateId", firstTemplateId);
      if (!next.get("focus")) {
        next.set("focus", "templates");
      }
      setSearchParams(next, { replace: true });
    }
  }, [regularTemplates, searchParams, selectedTemplateId, setSearchParams, stableTemplates]);

  useEffect(() => {
    if (selectedStableTemplate) {
      setSelectedTaskProfileId(selectedStableTemplate.defaultTaskProfile);
      if (!title.trim()) {
        setTitle(selectedStableTemplate.label);
      }
      return;
    }
    if (selectedTemplate && !title.trim()) {
      setTitle(selectedTemplate.name);
    }
  }, [selectedStableTemplate, selectedTemplate, title]);

  useEffect(() => {
    if (requestedWorkflowId) {
      setTargetWorkflowId(requestedWorkflowId);
    }
  }, [requestedWorkflowId]);

  useEffect(() => {
    if (requestedWorkflowId && !requestedDraftId && draftsQuery.data?.items[0]?.draftId) {
      const next = new URLSearchParams(searchParams);
      next.set("draftId", draftsQuery.data.items[0].draftId);
      setSearchParams(next, { replace: true });
    }
  }, [draftsQuery.data, requestedDraftId, requestedWorkflowId, searchParams, setSearchParams]);

  const instantiateMutation = useMutation({
    mutationFn: async () => {
      const effectiveTitle = title.trim() || selectedStableTemplate?.label || selectedTemplate?.name || "Workflow draft";
      let workflowId = targetWorkflowId !== "new" ? targetWorkflowId : "";
      if (!workflowId) {
        const created = await workflowsApi.create({
          slug: slugify(`${effectiveTitle}-${Date.now()}`),
          name: effectiveTitle,
          description: selectedStableTemplate?.description ?? selectedTemplate?.description,
          tags: selectedStableTemplate?.tags ?? selectedTemplate?.tags ?? [],
          graph: createDefaultRawGraph(),
        });
        workflowId = created.workflow.id;
      }
      if (!selectedTemplateId) {
        throw new Error("Select a template first.");
      }
      const result = await workflowBuilderApi.instantiateTemplate(selectedTemplateId, {
        workflowId,
        title: effectiveTitle,
        ownerUserId: user?.id,
        taskProfileId: selectedTaskProfileId,
      });
      return { workflowId, draft: result.draft };
    },
    onSuccess: async ({ workflowId, draft }) => {
      toast.success("Template instantiated into a draft.");
      const next = new URLSearchParams();
      next.set("templateId", selectedTemplateId ?? "");
      next.set("workflowId", workflowId);
      next.set("draftId", draft.draftId);
      next.set("focus", "draft");
      setSearchParams(next, { replace: false });
      await queryClient.invalidateQueries({ queryKey: ["workflow-builder", "drafts", workflowId] });
      await queryClient.invalidateQueries({ queryKey: ["workflow-builder", "draft", workflowId, draft.draftId] });
      await queryClient.invalidateQueries({ queryKey: ["workflow-builder", "workflows"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not instantiate the template");
    },
  });

  const compileMutation = useMutation({
    mutationFn: () => workflowBuilderApi.compileDraft(requestedWorkflowId!, resolvedDraftId!),
    onSuccess: () => {
      toast.success("Draft compiled successfully.");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Draft compile failed");
    },
  });

  const publishMutation = useMutation({
    mutationFn: async () => {
      if (!requestedWorkflowId || !resolvedDraftId || !user?.id) {
        throw new Error("Workflow, draft, and user context are required before publish.");
      }
      const acquired = await workflowBuilderApi.acquireLock(requestedWorkflowId, {
        ownerUserId: user.id,
        ttlSec: 300,
      });
      if (!acquired.acquired || !acquired.lock) {
        throw new Error("Workflow is locked by another editor.");
      }
      try {
        return await workflowBuilderApi.publishDraft(requestedWorkflowId, resolvedDraftId, {
          workflowId: requestedWorkflowId,
          lockToken: acquired.lock.lockToken,
          createdByUserId: user.id,
          changeNote,
          publishNow: true,
        });
      } finally {
        await workflowBuilderApi.releaseLock(requestedWorkflowId, {
          lockToken: acquired.lock.lockToken,
        }).catch(() => undefined);
      }
    },
    onSuccess: async () => {
      toast.success("Draft published.");
      const next = new URLSearchParams(searchParams);
      next.set("focus", "publish");
      setSearchParams(next, { replace: false });
      await queryClient.invalidateQueries({ queryKey: ["workflow-builder", "drafts", requestedWorkflowId] });
      await queryClient.invalidateQueries({ queryKey: ["workflow-builder", "workflows"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Draft publish failed");
    },
  });

  const integrationMode = describeIntegrationMode({
    template: selectedTemplate,
    stableTemplate: selectedStableTemplate,
  });

  const groupedRegularTemplates = useMemo(() => ({
    builtin: regularTemplates.filter((item) => item.kind === "builtin"),
    skill: regularTemplates.filter((item) => item.kind === "skill"),
    user: regularTemplates.filter((item) => item.kind === "user"),
  }), [regularTemplates]);

  return (
    <div className="grid gap-4 xl:grid-cols-[0.86fr_1.14fr_0.92fr]">
      <div className="space-y-4">
        <ShellCard
          eyebrow="Stable Starters"
          title="Template-first workflow authoring"
          aside={<StatusPill tone={stableTemplates.length > 0 ? "success" : "neutral"}>{stableTemplates.length} stable</StatusPill>}
        >
          <div className="space-y-3">
            {stableTemplates.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => setSearchParams(new URLSearchParams(buildWorkflowBuilderHref({
                  templateId: template.id,
                  workflowId: requestedWorkflowId ?? undefined,
                  draftId: requestedDraftId ?? undefined,
                  focus: "templates",
                }).replace("/workflows/builder?", "")), { replace: false })}
                className="agent-selection-card"
                data-active={selectedTemplateId === template.id}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-white">{template.label}</p>
                    <p className="text-xs text-white/50">{template.id}</p>
                  </div>
                  <StatusPill tone={template.preferredBinding === "built-in-tool" ? "success" : "warning"}>
                    {describeStableBinding(template)}
                  </StatusPill>
                </div>
                <p className="mt-2 text-sm text-white/60">{template.description}</p>
              </button>
            ))}
          </div>
        </ShellCard>

        {(["builtin", "skill", "user"] as const).map((groupKey) => (
          <ShellCard
            key={groupKey}
            eyebrow="Builder Templates"
            title={groupKey === "builtin" ? "Builtin templates" : groupKey === "skill" ? "Skill-derived templates" : "User templates"}
            aside={<StatusPill>{groupedRegularTemplates[groupKey].length}</StatusPill>}
          >
            <div className="space-y-3">
              {groupedRegularTemplates[groupKey].length === 0 ? (
                <p className="text-sm text-white/55">No templates in this group yet.</p>
              ) : groupedRegularTemplates[groupKey].map((template) => (
                <button
                  key={template.templateId}
                  type="button"
                  onClick={() => setSearchParams(new URLSearchParams(buildWorkflowBuilderHref({
                    templateId: template.templateId,
                    workflowId: requestedWorkflowId ?? undefined,
                    draftId: requestedDraftId ?? undefined,
                    focus: "templates",
                  }).replace("/workflows/builder?", "")), { replace: false })}
                  className="agent-selection-card"
                  data-active={selectedTemplateId === template.templateId}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-white">{template.name}</p>
                      <p className="text-xs text-white/50">{template.templateId}</p>
                    </div>
                    <StatusPill>{template.kind}</StatusPill>
                  </div>
                  <p className="mt-2 text-sm text-white/60">{template.description ?? "No description recorded."}</p>
                </button>
              ))}
            </div>
          </ShellCard>
        ))}
      </div>

      <div className="space-y-4">
        <ShellCard
          eyebrow="Template Detail"
          title={selectedStableTemplate?.label ?? selectedTemplate?.name ?? "Select a template"}
          aside={
            selectedStableTemplate ? (
              <StatusPill tone={selectedStableTemplate.preferredBinding === "built-in-tool" ? "success" : "warning"}>
                stable
              </StatusPill>
            ) : selectedTemplate ? (
              <StatusPill>{selectedTemplate.kind}</StatusPill>
            ) : undefined
          }
        >
          {selectedStableTemplate || selectedTemplate ? (
            <div className="space-y-4 text-sm text-white/72">
              <p>{selectedStableTemplate?.description ?? selectedTemplate?.description ?? "No description recorded."}</p>
              <div className="grid gap-3 sm:grid-cols-3">
                <BuilderMetric
                  label="Template source"
                  value={selectedStableTemplate ? "stable" : selectedTemplate?.kind ?? "unknown"}
                />
                <BuilderMetric
                  label="Recommended mode"
                  value={integrationMode.label}
                />
                <BuilderMetric
                  label="Default profile"
                  value={selectedStableTemplate?.defaultTaskProfile ?? selectedTaskProfileId}
                />
              </div>
              <div className="agent-subcard p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-white/38">Binding recommendation</p>
                <p className="mt-2 text-sm text-white/70">{integrationMode.reason}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(selectedStableTemplate?.tags ?? selectedTemplate?.tags ?? []).map((tag) => (
                    <StatusPill key={tag}>{tag}</StatusPill>
                  ))}
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-2 text-sm">
                  <span className="font-medium text-white">Draft title</span>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    className="agent-input"
                    placeholder="Workflow title"
                  />
                </label>
                <label className="grid gap-2 text-sm">
                  <span className="font-medium text-white">Target workflow</span>
                  <select
                    value={targetWorkflowId}
                    onChange={(event) => setTargetWorkflowId(event.target.value)}
                    className="agent-input"
                  >
                    <option value="new">Create a new workflow</option>
                    {(workflowsQuery.data?.items ?? []).map((workflow) => (
                      <option key={workflow.id} value={workflow.id}>
                        {workflow.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="grid gap-2 text-sm">
                <span className="font-medium text-white">Task profile</span>
                <select
                  value={selectedTaskProfileId}
                  onChange={(event) => setSelectedTaskProfileId(event.target.value as AgentTaskProfileId)}
                  className="agent-input"
                >
                  {TASK_PROFILE_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label} · {option.detail}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex flex-wrap gap-3">
                <ActionButton disabled={instantiateMutation.isPending || !selectedTemplateId} onClick={() => instantiateMutation.mutate()}>
                  {instantiateMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wrench className="mr-2 h-4 w-4" />}
                  Instantiate draft
                </ActionButton>
                <Link
                  className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]"
                  to="/workflows"
                >
                  Open control plane
                </Link>
              </div>
            </div>
          ) : (
            <p className="text-sm text-white/55">Pick a stable or builder template to see its recommended binding and draft path.</p>
          )}
        </ShellCard>

        <ShellCard
          eyebrow="Draft Snapshot"
          title={activeDraft?.title ?? "No draft selected"}
          aside={activeDraft ? <StatusPill tone="warning">{activeDraft.status}</StatusPill> : undefined}
        >
          {activeDraft ? (
            <div className="space-y-4 text-sm text-white/72">
              <div className="grid gap-3 sm:grid-cols-3">
                <BuilderMetric label="Revision" value={String(activeDraft.revision)} />
                <BuilderMetric label="Updated" value={formatTimestamp(activeDraft.updatedAt)} />
                <BuilderMetric label="Autosave" value={activeDraft.autosave.enabled ? "enabled" : "disabled"} />
              </div>
              <div className="agent-subcard p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-white/38">Spec outline</p>
                <p className="mt-2 text-sm text-white/70">
                  {activeDraft.spec.description || "This draft does not have a description yet."}
                </p>
                <div className="mt-3 grid gap-2 text-xs text-white/55">
                  <p>Trigger: {activeDraft.spec.trigger.type}</p>
                  <p>Steps: {activeDraft.spec.steps.length}</p>
                  <p>Outputs: {activeDraft.spec.outputs.length}</p>
                  <p>Task profile arg: {String(activeDraft.spec.steps[0]?.args?.taskProfile ?? "not set")}</p>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-white/55">Instantiate a template or open an existing workflow draft to continue.</p>
          )}
        </ShellCard>
      </div>

      <div className="space-y-4">
        <ShellCard
          eyebrow="Draft Actions"
          title="Compile, publish, and hand off"
          aside={<StatusPill tone={activeDraft ? "warning" : "neutral"}>{focus}</StatusPill>}
        >
          {activeDraft && requestedWorkflowId ? (
            <div className="space-y-4 text-sm text-white/72">
              <label className="grid gap-2 text-sm">
                <span className="font-medium text-white">Publish note</span>
                <input
                  value={changeNote}
                  onChange={(event) => setChangeNote(event.target.value)}
                  className="agent-input"
                  placeholder="Change note"
                />
              </label>
              <div className="flex flex-wrap gap-3">
                <ActionButton
                  tone="secondary"
                  disabled={compileMutation.isPending}
                  onClick={() => compileMutation.mutate()}
                >
                  {compileMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Compile
                </ActionButton>
                <ActionButton
                  disabled={publishMutation.isPending}
                  onClick={() => publishMutation.mutate()}
                >
                  {publishMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Rocket className="mr-2 h-4 w-4" />}
                  Publish
                </ActionButton>
              </div>
              {compileMutation.data ? (
                <div className="agent-subcard p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium text-white">Compile report</p>
                    <StatusPill tone={compileMutation.data.validation.valid ? "success" : "warning"}>
                      {compileMutation.data.validation.valid ? "valid" : "issues"}
                    </StatusPill>
                  </div>
                  <p className="mt-2 text-sm text-white/70">
                    Nodes: {compileMutation.data.compiled.graph.nodes.length} ·
                    Edges: {compileMutation.data.compiled.graph.edges.length}
                  </p>
                  <div className="mt-3 space-y-2 text-xs text-white/55">
                    {compileMutation.data.validation.issues.length === 0 ? (
                      <p>No validation issues.</p>
                    ) : compileMutation.data.validation.issues.map((issue) => (
                      <p key={`${issue.stage}:${issue.code}:${issue.message}`}>
                        {issue.stage}: {issue.message}
                      </p>
                    ))}
                  </div>
                </div>
              ) : null}
              {publishMutation.data ? (
                <div className="agent-subcard p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium text-white">Publish result</p>
                    <StatusPill tone="success">v{publishMutation.data.versionNumber}</StatusPill>
                  </div>
                  <p className="mt-2 text-sm text-white/70">
                    Draft published and ready for control-plane deploy and run/export actions.
                  </p>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-3">
                <Link
                  className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]"
                  to={buildWorkflowHref(requestedWorkflowId, "deploy")}
                >
                  Open control plane
                </Link>
                <Link
                  className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]"
                  to={buildWorkflowBuilderHref({
                    templateId: selectedTemplateId ?? undefined,
                    workflowId: requestedWorkflowId,
                    draftId: activeDraft.draftId,
                    focus: "draft",
                  })}
                >
                  Copy deep link
                </Link>
              </div>
            </div>
          ) : (
            <p className="text-sm text-white/55">Compile and publish controls appear after a draft is selected.</p>
          )}
        </ShellCard>
      </div>
    </div>
  );
}

function BuilderMetric(props: { label: string; value: string }) {
  return (
    <div className="agent-metric-card">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/45">{props.label}</p>
      <p className="mt-3 text-sm text-white">{props.value}</p>
    </div>
  );
}

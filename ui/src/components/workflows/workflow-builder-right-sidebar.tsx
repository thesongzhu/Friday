import { Link } from "react-router-dom";
import { Loader2, Rocket } from "lucide-react";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";
import type {
  AgentTaskProfileId,
  FridayWorkflowBuilderValidationReport,
  FridayWorkflowDraftEntity,
  FridayWorkflowNodeConfig,
  FridayWorkflowNodeDefinition,
  FridayWorkflowSpecEdgeWhen,
  FridayWorkflowTemplateEntity,
  WorkflowNodeType,
} from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import {
  buildValidationIssueNavigationItems,
  describeWorkflowEdgeLabel,
  type BuilderValidationIssueSummary,
  type BuilderValidationTone,
} from "@/lib/workflows/builder-canvas";

interface WorkflowBuilderTaskProfileOption {
  id: AgentTaskProfileId;
  label: string;
  detail: string;
}

interface WorkflowBuilderIntegrationModeOption {
  value: string;
  label: string;
}

interface WorkflowBuilderSelectedNodeData extends FridayWorkflowNodeDefinition {
  __ui?: {
    issueTone?: BuilderValidationTone;
    issueCount?: number;
    primaryIssueMessage?: string;
    remainingCount?: number;
    activeIssue?: boolean;
    visitedIssue?: boolean;
    dropTarget?: boolean;
    preview?: boolean;
  };
}

interface WorkflowBuilderSelectedEdgeData {
  source: string;
  target: string;
  data?: {
    branch?: FridayWorkflowSpecEdgeWhen | string;
  };
}

interface WorkflowBuilderCompileReport {
  validation: FridayWorkflowBuilderValidationReport;
  nodes: number;
  edges: number;
}

export interface WorkflowBuilderRightSidebarProps {
  deferredInspectorReady: boolean;
  deferredTemplateGroupsReady: boolean;
  focus: string;
  inspectorTitle: string;
  inspectorTone: "success" | "neutral";
  selectedNodeData: WorkflowBuilderSelectedNodeData | null;
  selectedEdgeData: WorkflowBuilderSelectedEdgeData | null;
  selectedNodeIssueSummary: BuilderValidationIssueSummary | null;
  selectedEdgeIssueSummary: BuilderValidationIssueSummary | null;
  jsonEditorText: string;
  onJsonEditorTextChange: (value: string) => void;
  onApplyJsonEditor: () => void;
  onUpdateSelectedNode: (update: Partial<FridayWorkflowNodeDefinition>) => void;
  onUpdateSelectedNodeConfig: (configPatch: Partial<FridayWorkflowNodeConfig>) => void;
  onSelectedNodeTypeChange: (nextType: WorkflowNodeType) => void;
  onSelectedStepTypeChange: (stepType: FridayWorkflowNodeDefinition["stepType"]) => void;
  selectedTaskProfileId: AgentTaskProfileId;
  taskProfileOptions: WorkflowBuilderTaskProfileOption[];
  integrationModeOptions: readonly WorkflowBuilderIntegrationModeOption[];
  availableSkills: Array<{ skillId: string; name: string }>;
  onUpdateSelectedEdgeBranch: (branch: "" | FridayWorkflowSpecEdgeWhen) => void;
  activeDraft: FridayWorkflowDraftEntity | null;
  draftTitle: string;
  onDraftTitleChange: (value: string) => void;
  changeNote: string;
  onChangeNoteChange: (value: string) => void;
  compilePending: boolean;
  onCompile: () => void;
  publishPending: boolean;
  externalDraftReviewRequired: boolean;
  externalDraftReviewConfirmed: boolean;
  onExternalDraftReviewConfirmedChange: (value: boolean) => void;
  onPublish: () => void;
  readonlyReason: string | null;
  publishedVersionNumber: number | null;
  controlPlaneHref: string | null;
  deepLinkHref: string | null;
  compileReport: WorkflowBuilderCompileReport | null;
  activeIssueKey: string | null;
  onFocusIssue: (issue: FridayWorkflowBuilderValidationReport["issues"][number]) => void;
  groupedRegularTemplates: Record<"builtin" | "skill" | "user", FridayWorkflowTemplateEntity[]>;
  selectedTemplateId: string | null;
  onSelectTemplate: (templateId: string) => void;
}

export function WorkflowBuilderRightSidebar(props: WorkflowBuilderRightSidebarProps) {
  return (
    <div className="space-y-4">
      <ShellCard
        eyebrow="Inspector"
        title={props.inspectorTitle}
        aside={<StatusPill tone={props.inspectorTone}>{props.focus}</StatusPill>}
      >
        {!props.deferredInspectorReady ? (
          <InspectorSkeleton />
        ) : props.selectedNodeData ? (
          <NodeInspector
            selectedNodeData={props.selectedNodeData}
            selectedNodeIssueSummary={props.selectedNodeIssueSummary}
            jsonEditorText={props.jsonEditorText}
            onJsonEditorTextChange={props.onJsonEditorTextChange}
            onApplyJsonEditor={props.onApplyJsonEditor}
            onUpdateSelectedNode={props.onUpdateSelectedNode}
            onUpdateSelectedNodeConfig={props.onUpdateSelectedNodeConfig}
            onSelectedNodeTypeChange={props.onSelectedNodeTypeChange}
            onSelectedStepTypeChange={props.onSelectedStepTypeChange}
            selectedTaskProfileId={props.selectedTaskProfileId}
            taskProfileOptions={props.taskProfileOptions}
            integrationModeOptions={props.integrationModeOptions}
            availableSkills={props.availableSkills}
          />
        ) : props.selectedEdgeData ? (
          <EdgeInspector
            selectedEdgeData={props.selectedEdgeData}
            selectedEdgeIssueSummary={props.selectedEdgeIssueSummary}
            onUpdateSelectedEdgeBranch={props.onUpdateSelectedEdgeBranch}
          />
        ) : props.activeDraft ? (
          <DraftInspector
            activeDraft={props.activeDraft}
            draftTitle={props.draftTitle}
            onDraftTitleChange={props.onDraftTitleChange}
            changeNote={props.changeNote}
            onChangeNoteChange={props.onChangeNoteChange}
            compilePending={props.compilePending}
            onCompile={props.onCompile}
            publishPending={props.publishPending}
            externalDraftReviewRequired={props.externalDraftReviewRequired}
            externalDraftReviewConfirmed={props.externalDraftReviewConfirmed}
            onExternalDraftReviewConfirmedChange={props.onExternalDraftReviewConfirmedChange}
            onPublish={props.onPublish}
            readonlyReason={props.readonlyReason}
            publishedVersionNumber={props.publishedVersionNumber}
            controlPlaneHref={props.controlPlaneHref}
            deepLinkHref={props.deepLinkHref}
          />
        ) : (
          <p className="text-sm text-[color:var(--color-text-tertiary)]">Select a draft, node, or edge to inspect it here.</p>
        )}
        {props.compileReport ? (
          <CompileReportPanel
            report={props.compileReport}
            activeIssueKey={props.activeIssueKey}
            onFocusIssue={props.onFocusIssue}
          />
        ) : null}
      </ShellCard>

      {props.deferredTemplateGroupsReady ? (
        (["builtin", "skill", "user"] as const).map((groupKey) => (
          <ShellCard
            key={groupKey}
            eyebrow="Templates"
            title={groupKey === "builtin" ? "Builtin" : groupKey === "skill" ? "Skill-derived" : "User"}
            aside={<StatusPill>{props.groupedRegularTemplates[groupKey].length}</StatusPill>}
          >
            <div className="space-y-3">
              {props.groupedRegularTemplates[groupKey].length === 0 ? (
                <p className="text-sm text-[color:var(--color-text-tertiary)]">No templates in this group yet.</p>
              ) : props.groupedRegularTemplates[groupKey].map((template) => (
                <button
                  key={template.templateId}
                  type="button"
                  onClick={() => props.onSelectTemplate(template.templateId)}
                  className="agent-selection-card text-left"
                  data-active={props.selectedTemplateId === template.templateId}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-[color:var(--color-text-primary)]">{template.name}</p>
                      <p className="text-xs text-[color:var(--color-text-tertiary)]">{template.templateId}</p>
                    </div>
                    <StatusPill>{template.kind}</StatusPill>
                  </div>
                  <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">{template.description ?? "No description recorded."}</p>
                </button>
              ))}
            </div>
          </ShellCard>
        ))
      ) : (
        <ShellCard eyebrow="Templates" title="Additional template groups">
          <div className="space-y-3">
            <div className="min-h-[96px] rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]" />
            <div className="min-h-[96px] rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]" />
          </div>
        </ShellCard>
      )}
    </div>
  );
}

function NodeInspector(props: {
  selectedNodeData: WorkflowBuilderSelectedNodeData;
  selectedNodeIssueSummary: BuilderValidationIssueSummary | null;
  jsonEditorText: string;
  onJsonEditorTextChange: (value: string) => void;
  onApplyJsonEditor: () => void;
  onUpdateSelectedNode: (update: Partial<FridayWorkflowNodeDefinition>) => void;
  onUpdateSelectedNodeConfig: (configPatch: Partial<FridayWorkflowNodeConfig>) => void;
  onSelectedNodeTypeChange: (nextType: WorkflowNodeType) => void;
  onSelectedStepTypeChange: (stepType: FridayWorkflowNodeDefinition["stepType"]) => void;
  selectedTaskProfileId: AgentTaskProfileId;
  taskProfileOptions: WorkflowBuilderTaskProfileOption[];
  integrationModeOptions: readonly WorkflowBuilderIntegrationModeOption[];
  availableSkills: Array<{ skillId: string; name: string }>;
}) {
  const selectedNodeData = props.selectedNodeData;

  return (
    <div className="space-y-4 text-sm text-[color:var(--color-text-secondary)]">
      {props.selectedNodeIssueSummary ? (
        <ValidationSummaryCard
          title="Node issues"
          summary={props.selectedNodeIssueSummary}
        />
      ) : null}
      <label className="grid gap-2">
        <span className="font-medium text-[color:var(--color-text-primary)]">Name</span>
        <input
          value={selectedNodeData.name}
          onChange={(event) => props.onUpdateSelectedNode({ name: event.target.value })}
          className="agent-input"
        />
      </label>
      {selectedNodeData.type !== "trigger" ? (
        <>
          <label className="grid gap-2">
            <span className="font-medium text-[color:var(--color-text-primary)]">Node category</span>
            <select
              value={selectedNodeData.type}
              onChange={(event) => props.onSelectedNodeTypeChange(event.target.value as WorkflowNodeType)}
              className="agent-input"
            >
              <option value="action">Action</option>
              <option value="ai">AI / Tool</option>
              <option value="condition">Condition</option>
              <option value="data">Transform</option>
              <option value="approval">Approval</option>
            </select>
          </label>
          <label className="grid gap-2">
            <span className="font-medium text-[color:var(--color-text-primary)]">Step type</span>
            <select
              value={selectedNodeData.stepType ?? (selectedNodeData.type === "ai" ? "tool_call" : "skill_call")}
              onChange={(event) => props.onSelectedStepTypeChange(event.target.value as FridayWorkflowNodeDefinition["stepType"])}
              className="agent-input"
            >
              <option value="skill_call">skill_call</option>
              <option value="tool_call">tool_call</option>
              <option value="condition">condition</option>
              <option value="transform">transform</option>
              <option value="human_approval">human_approval</option>
            </select>
          </label>
          <label className="grid gap-2">
            <span className="font-medium text-[color:var(--color-text-primary)]">Reference</span>
            {"actionType" in selectedNodeData.config && selectedNodeData.config.actionType === "skill" ? (
              <select
                value={selectedNodeData.stepRef ?? selectedNodeData.config.skillId}
                onChange={(event) =>
                  props.onUpdateSelectedNode({
                    stepRef: event.target.value,
                    config: {
                      ...(selectedNodeData.config as Record<string, unknown>),
                      skillId: event.target.value,
                    } as FridayWorkflowNodeConfig,
                  })}
                className="agent-input"
              >
                <option value="">Select a skill</option>
                {props.availableSkills.map((skill) => (
                  <option key={skill.skillId} value={skill.skillId}>
                    {skill.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={selectedNodeData.stepRef ?? ""}
                onChange={(event) => props.onUpdateSelectedNode({ stepRef: event.target.value })}
                className="agent-input"
                placeholder="tool id / external reference"
              />
            )}
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-2">
              <span className="font-medium text-[color:var(--color-text-primary)]">Task profile</span>
              <select
                value={typeof selectedNodeData.rawArgs?.taskProfile === "string" ? selectedNodeData.rawArgs.taskProfile : props.selectedTaskProfileId}
                onChange={(event) =>
                  props.onUpdateSelectedNode({
                    rawArgs: {
                      ...(selectedNodeData.rawArgs ?? {}),
                      taskProfile: event.target.value,
                    },
                  })}
                className="agent-input"
              >
                {props.taskProfileOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-2">
              <span className="font-medium text-[color:var(--color-text-primary)]">Integration mode</span>
              <select
                value={typeof selectedNodeData.rawArgs?.integrationMode === "string" ? selectedNodeData.rawArgs.integrationMode : "workflow_node"}
                onChange={(event) =>
                  props.onUpdateSelectedNode({
                    rawArgs: {
                      ...(selectedNodeData.rawArgs ?? {}),
                      integrationMode: event.target.value,
                    },
                  })}
                className="agent-input"
              >
                {props.integrationModeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-2">
            <span className="font-medium text-[color:var(--color-text-primary)]">Trigger type</span>
            <select
              value={"triggerType" in selectedNodeData.config ? selectedNodeData.config.triggerType : "manual"}
              onChange={(event) =>
                props.onUpdateSelectedNodeConfig(
                  event.target.value === "manual"
                    ? { triggerType: "manual" }
                    : event.target.value === "cron"
                      ? { triggerType: "cron", cron: "0 9 * * 1", timezone: "UTC" }
                      : { triggerType: "event", source: "system", event: "created" },
                )}
              className="agent-input"
            >
              <option value="manual">manual</option>
              <option value="cron">schedule</option>
              <option value="event">event</option>
            </select>
          </label>
          {"triggerType" in selectedNodeData.config && selectedNodeData.config.triggerType === "cron" ? (
            <label className="grid gap-2">
              <span className="font-medium text-[color:var(--color-text-primary)]">Cron</span>
              <input
                value={selectedNodeData.config.cron}
                onChange={(event) => props.onUpdateSelectedNodeConfig({ cron: event.target.value })}
                className="agent-input"
              />
            </label>
          ) : null}
        </div>
      )}
      {selectedNodeData.type === "condition" ? (
        <label className="grid gap-2">
          <span className="font-medium text-[color:var(--color-text-primary)]">Condition expression</span>
          <textarea
            value={selectedNodeData.stepCondition ?? ""}
            onChange={(event) => props.onUpdateSelectedNode({ stepCondition: event.target.value })}
            rows={4}
            className="agent-input min-h-[112px]"
          />
        </label>
      ) : null}
      {selectedNodeData.type === "data" ? (
        <label className="grid gap-2">
          <span className="font-medium text-[color:var(--color-text-primary)]">Transform expression</span>
          <textarea
            value={
              "expression" in selectedNodeData.config && typeof selectedNodeData.config.expression === "string"
                ? selectedNodeData.config.expression
                : ""
            }
            onChange={(event) => props.onUpdateSelectedNodeConfig({ expression: event.target.value })}
            rows={4}
            className="agent-input min-h-[112px]"
          />
        </label>
      ) : null}
      <label className="grid gap-2">
        <span className="font-medium text-[color:var(--color-text-primary)]">Args JSON</span>
        <textarea
          value={props.jsonEditorText}
          onChange={(event) => props.onJsonEditorTextChange(event.target.value)}
          onBlur={props.onApplyJsonEditor}
          rows={10}
          className="agent-input min-h-[240px] font-mono text-xs"
        />
      </label>
    </div>
  );
}

function EdgeInspector(props: {
  selectedEdgeData: WorkflowBuilderSelectedEdgeData;
  selectedEdgeIssueSummary: BuilderValidationIssueSummary | null;
  onUpdateSelectedEdgeBranch: (branch: "" | FridayWorkflowSpecEdgeWhen) => void;
}) {
  return (
    <div className="space-y-4 text-sm text-[color:var(--color-text-secondary)]">
      {props.selectedEdgeIssueSummary ? (
        <ValidationSummaryCard
          title="Edge issues"
          summary={props.selectedEdgeIssueSummary}
        />
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <BuilderMetric label="Source" value={props.selectedEdgeData.source} />
        <BuilderMetric label="Target" value={props.selectedEdgeData.target} />
      </div>
      <label className="grid gap-2">
        <span className="font-medium text-[color:var(--color-text-primary)]">Branch condition</span>
        <select
          value={(props.selectedEdgeData.data?.branch as FridayWorkflowSpecEdgeWhen | undefined) ?? ""}
          onChange={(event) => props.onUpdateSelectedEdgeBranch(event.target.value as "" | FridayWorkflowSpecEdgeWhen)}
          className="agent-input"
        >
          <option value="">Unconditional</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
          <option value="true">True</option>
          <option value="false">False</option>
        </select>
      </label>
      <p className="text-sm text-[color:var(--color-text-secondary)]">
        Friday stores edge routing through `when` branches, so changing this selector updates the compiled branch condition without forcing you into raw JSON.
      </p>
    </div>
  );
}

function DraftInspector(props: {
  activeDraft: FridayWorkflowDraftEntity;
  draftTitle: string;
  onDraftTitleChange: (value: string) => void;
  changeNote: string;
  onChangeNoteChange: (value: string) => void;
  compilePending: boolean;
  onCompile: () => void;
  publishPending: boolean;
  externalDraftReviewRequired: boolean;
  externalDraftReviewConfirmed: boolean;
  onExternalDraftReviewConfirmedChange: (value: boolean) => void;
  onPublish: () => void;
  readonlyReason: string | null;
  publishedVersionNumber: number | null;
  controlPlaneHref: string | null;
  deepLinkHref: string | null;
}) {
  return (
    <div className="space-y-4 text-sm text-[color:var(--color-text-secondary)]">
      <div className="grid gap-3 sm:grid-cols-2">
        <BuilderMetric label="Revision" value={String(props.activeDraft.revision)} />
        <BuilderMetric label="Updated" value={formatTimestamp(props.activeDraft.updatedAt)} />
      </div>
      <label className="grid gap-2">
        <span className="font-medium text-[color:var(--color-text-primary)]">Draft title</span>
        <input
          value={props.draftTitle}
          onChange={(event) => props.onDraftTitleChange(event.target.value)}
          className="agent-input"
        />
      </label>
      <label className="grid gap-2">
        <span className="font-medium text-[color:var(--color-text-primary)]">Publish note</span>
        <input
          value={props.changeNote}
          onChange={(event) => props.onChangeNoteChange(event.target.value)}
          className="agent-input"
        />
      </label>
      {props.externalDraftReviewRequired ? (
        <label className="flex items-start gap-3 rounded-[18px] border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <input
            type="checkbox"
            data-testid="workflow-builder-external-draft-review-confirm"
            className="mt-0.5 h-4 w-4"
            checked={props.externalDraftReviewConfirmed}
            onChange={(event) => props.onExternalDraftReviewConfirmedChange(event.target.checked)}
          />
          <span>
            I reviewed this external workflow template and want to allow publish/deploy for this draft.
          </span>
        </label>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <ActionButton tone="secondary" disabled={props.compilePending} onClick={props.onCompile}>
          {props.compilePending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Compile
        </ActionButton>
        <ActionButton
          disabled={props.publishPending || Boolean(props.readonlyReason) || (props.externalDraftReviewRequired && !props.externalDraftReviewConfirmed)}
          onClick={props.onPublish}
        >
          {props.publishPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Rocket className="mr-2 h-4 w-4" />}
          Publish
        </ActionButton>
      </div>
      {props.publishedVersionNumber ? (
        <div className="rounded-[22px] border border-[color:var(--color-accent-soft)] bg-[color:var(--color-accent-muted)] p-4">
          <p className="font-medium text-[color:var(--color-text-primary)]">Publish result</p>
          <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">
            Draft published as version {props.publishedVersionNumber}. Use the control plane for deploy, run, or export.
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-3">
        {props.controlPlaneHref ? (
          <Link
            className="inline-flex items-center rounded-2xl bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)]"
            to={props.controlPlaneHref}
          >
            Open control plane
          </Link>
        ) : null}
        {props.deepLinkHref ? (
          <Link
            className="inline-flex items-center rounded-2xl bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)]"
            to={props.deepLinkHref}
          >
            Copy deep link
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function InspectorSkeleton() {
  return (
    <div className="space-y-3">
      <div className="min-h-[44px] rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]" />
      <div className="min-h-[112px] rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]" />
      <div className="min-h-[148px] rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]" />
    </div>
  );
}

function BuilderMetric(props: { label: string; value: string }) {
  return (
    <div className="agent-metric-card">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{props.label}</p>
      <p className="mt-3 break-words text-sm text-[color:var(--color-text-primary)]">{props.value}</p>
    </div>
  );
}

function ValidationSummaryCard(props: { title: string; summary: BuilderValidationIssueSummary }) {
  return (
    <div className="agent-subcard p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium text-[color:var(--color-text-primary)]">{props.title}</p>
        <StatusPill tone={issueToneToStatusTone(props.summary.tone)}>
          {props.summary.count} issue{props.summary.count > 1 ? "s" : ""}
        </StatusPill>
      </div>
      <div className="mt-3 space-y-2 text-xs text-[color:var(--color-text-secondary)]">
        {props.summary.issues.map((issue) => (
          <p key={`${props.title}:${issue.code}:${issue.message}`}>
            {issue.stage}: {issue.message}
          </p>
        ))}
      </div>
    </div>
  );
}

function issueToneToStatusTone(tone?: BuilderValidationTone): "warning" | "danger" | "neutral" {
  if (tone === "danger") {
    return "danger";
  }
  if (tone === "warning") {
    return "warning";
  }
  return "neutral";
}

function describeIssueLocation(issue: FridayWorkflowBuilderValidationReport["issues"][number]): string | null {
  if (issue.stepId) {
    return `Node ${issue.stepId}`;
  }
  if (issue.edgeRef) {
    const edgeLabel = describeWorkflowEdgeLabel({
      branch: issue.edgeRef.when,
      condition: undefined,
    });
    return edgeLabel
      ? `Edge ${issue.edgeRef.from} -> ${issue.edgeRef.to} · ${edgeLabel}`
      : `Edge ${issue.edgeRef.from} -> ${issue.edgeRef.to}`;
  }
  return null;
}

function CompileReportPanel(props: {
  report: WorkflowBuilderCompileReport;
  activeIssueKey: string | null;
  onFocusIssue: (issue: FridayWorkflowBuilderValidationReport["issues"][number]) => void;
}) {
  const nodeIssues = props.report.validation.issues.filter((issue) => Boolean(issue.stepId));
  const edgeIssues = props.report.validation.issues.filter((issue) => Boolean(issue.edgeRef));
  const globalIssues = props.report.validation.issues.filter((issue) => !issue.stepId && !issue.edgeRef);
  const navigationItems = buildValidationIssueNavigationItems(props.report.validation);

  const renderIssueList = (
    issues: FridayWorkflowBuilderValidationReport["issues"],
    emptyLabel: string,
  ) => (
    issues.length === 0 ? (
      <p className="text-xs text-[color:var(--color-text-tertiary)]">{emptyLabel}</p>
    ) : issues.map((issue) => {
      const location = describeIssueLocation(issue);
      const focusable = Boolean(issue.stepId || issue.edgeRef);
      const activeItem = navigationItems.find((item) => item.issue === issue) ?? null;
      const isActive = activeItem?.key === props.activeIssueKey;
      return (
        <button
          data-testid={activeItem ? `workflow-builder-compile-item-${activeItem.key}` : undefined}
          data-active-issue={isActive ? "true" : "false"}
          key={`${issue.stage}:${issue.code}:${issue.message}:${location ?? "global"}`}
          type="button"
          disabled={!focusable}
          onClick={() => props.onFocusIssue(issue)}
          className={cn(
            "w-full rounded-[18px] border px-3 py-3 text-left transition",
            isActive && "ring-2 ring-[color:var(--color-focus-ring)]",
            "border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] hover:bg-[color:var(--color-bg-contrast)]",
            !focusable && "cursor-default opacity-80 hover:bg-inherit",
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--color-text-tertiary)]">{issue.stage}</p>
            <StatusPill tone={issue.severity === "error" ? "danger" : "warning"}>{issue.severity}</StatusPill>
          </div>
          <p className="mt-2 text-sm text-[color:var(--color-text-primary)]">{issue.message}</p>
          {location ? (
            <p className="mt-2 text-xs text-[color:var(--color-text-tertiary)]">{location} · click to focus</p>
          ) : null}
        </button>
      );
    })
  );

  return (
    <div className="mt-4 agent-subcard p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium text-[color:var(--color-text-primary)]">Compile report</p>
        <StatusPill tone={props.report.validation.valid ? "success" : "warning"}>
          {props.report.validation.valid ? "valid" : "issues"}
        </StatusPill>
      </div>
      <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">
        Nodes: {props.report.nodes} · Edges: {props.report.edges}
      </p>
      <div className="mt-4 space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">Node issues</p>
            <StatusPill>{nodeIssues.length}</StatusPill>
          </div>
          <div className="space-y-2">{renderIssueList(nodeIssues, "No node-specific issues.")}</div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">Edge issues</p>
            <StatusPill>{edgeIssues.length}</StatusPill>
          </div>
          <div className="space-y-2">{renderIssueList(edgeIssues, "No edge-specific issues.")}</div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">Global issues</p>
            <StatusPill>{globalIssues.length}</StatusPill>
          </div>
          <div className="space-y-2">{renderIssueList(globalIssues, "No global validation issues.")}</div>
        </div>
      </div>
    </div>
  );
}

function formatTimestamp(value?: string): string {
  if (!value) return "Not yet";
  return new Date(value).toLocaleString();
}

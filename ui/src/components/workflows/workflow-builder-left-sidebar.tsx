import { ChevronDown, ChevronRight, Loader2, PackagePlus, Sparkles } from "lucide-react";
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";
import type { AgentTaskProfileId, WorkflowNodeType } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";

export interface WorkflowBuilderTaskProfileOption {
  id: AgentTaskProfileId;
  label: string;
  detail: string;
}

export interface WorkflowBuilderStableTemplateSummary {
  id: string;
  label: string;
  description: string;
  preferredBinding: "built-in-tool" | "stable-skill";
}

export interface WorkflowBuilderPaletteEntrySummary {
  type: Exclude<WorkflowNodeType, "trigger">;
  label: string;
  description: string;
}

export interface WorkflowBuilderPaletteGroupSummary {
  id: string;
  label: string;
  entries: WorkflowBuilderPaletteEntrySummary[];
  visibleEntries: WorkflowBuilderPaletteEntrySummary[];
  collapsed: boolean;
}

export interface WorkflowBuilderLeftSidebarProps {
  deferredSidebarReady: boolean;
  catalogQueriesEnabled: boolean;
  title: string;
  onTitleChange: (value: string) => void;
  targetWorkflowId: string;
  onTargetWorkflowChange: (value: string) => void;
  workflows: Array<{ id: string; name: string }>;
  selectedTaskProfileId: AgentTaskProfileId;
  onTaskProfileChange: (value: AgentTaskProfileId) => void;
  taskProfileOptions: WorkflowBuilderTaskProfileOption[];
  selectedTemplateId: string | null;
  instantiatePending: boolean;
  onInstantiate: () => void;
  createBlankPending: boolean;
  onCreateBlank: () => void;
  bindingTitle: string | null;
  bindingDescription: string | null;
  bindingLabel: string;
  bindingReason: string;
  bindingTags: string[];
  stableTemplates: WorkflowBuilderStableTemplateSummary[];
  onSelectStableTemplate: (templateId: string) => void;
  paletteQuery: string;
  onPaletteQueryChange: (value: string) => void;
  onPaletteSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  visiblePaletteGroups: WorkflowBuilderPaletteGroupSummary[];
  keyboardPaletteActiveType: Exclude<WorkflowNodeType, "trigger"> | null;
  onTogglePaletteGroup: (groupId: string) => void;
  activeDraft: boolean;
  readonly: boolean;
  draggingPaletteType: Exclude<WorkflowNodeType, "trigger"> | null;
  onPaletteDragStart: (event: ReactDragEvent<HTMLButtonElement>, type: Exclude<WorkflowNodeType, "trigger">) => void;
  onPaletteDragEnd: () => void;
  onPaletteEntryHover: (type: Exclude<WorkflowNodeType, "trigger">) => void;
  onPaletteEntryClick: (type: Exclude<WorkflowNodeType, "trigger">) => void;
}

export function WorkflowBuilderLeftSidebar(props: WorkflowBuilderLeftSidebarProps) {
  return (
    <div className="space-y-4">
      <ShellCard
        eyebrow="Template Library"
        title="Start from a stable starter or a blank draft"
        aside={
          <StatusPill tone={props.catalogQueriesEnabled && props.stableTemplates.length > 0 ? "success" : "neutral"}>
            {props.catalogQueriesEnabled ? `${props.stableTemplates.length} stable` : "catalog deferred"}
          </StatusPill>
        }
      >
        <div className="space-y-4 text-sm text-[color:var(--color-text-secondary)]">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-2">
              <span className="font-medium text-[color:var(--color-text-primary)]">Draft title</span>
              <input
                value={props.title}
                onChange={(event) => props.onTitleChange(event.target.value)}
                className="agent-input"
                placeholder="Workflow title"
              />
            </label>
            <label className="grid gap-2">
              <span className="font-medium text-[color:var(--color-text-primary)]">Target workflow</span>
              <select
                value={props.targetWorkflowId}
                onChange={(event) => props.onTargetWorkflowChange(event.target.value)}
                className="agent-input"
              >
                <option value="new">Create a new workflow</option>
                {!props.catalogQueriesEnabled ? (
                  <option value="__catalog_deferred__" disabled>
                    Loading existing workflows after editor mount…
                  </option>
                ) : null}
                {props.workflows.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="grid gap-2">
            <span className="font-medium text-[color:var(--color-text-primary)]">Default task profile</span>
            <select
              value={props.selectedTaskProfileId}
              onChange={(event) => props.onTaskProfileChange(event.target.value as AgentTaskProfileId)}
              className="agent-input"
            >
              {props.taskProfileOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label} · {option.detail}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-3">
            <ActionButton disabled={!props.selectedTemplateId || props.instantiatePending} onClick={props.onInstantiate}>
              {props.instantiatePending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PackagePlus className="mr-2 h-4 w-4" />}
              Instantiate template
            </ActionButton>
            <ActionButton tone="secondary" disabled={props.createBlankPending} onClick={props.onCreateBlank}>
              {props.createBlankPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
              Blank draft
            </ActionButton>
          </div>
        </div>
      </ShellCard>

      {props.bindingTitle ? (
        <ShellCard
          eyebrow="Binding Recommendation"
          title={props.bindingTitle}
          aside={<StatusPill tone={props.bindingDescription ? "success" : "neutral"}>{props.bindingLabel}</StatusPill>}
        >
          <div className="space-y-3 text-sm text-[color:var(--color-text-secondary)]">
            {props.bindingDescription ? <p>{props.bindingDescription}</p> : null}
            <p>{props.bindingReason}</p>
            <div className="flex flex-wrap gap-2">
              {props.bindingTags.map((tag) => (
                <StatusPill key={tag}>{tag}</StatusPill>
              ))}
            </div>
          </div>
        </ShellCard>
      ) : null}

      <ShellCard eyebrow="Stable Starters" title="Stable workflow templates">
        {props.deferredSidebarReady ? (
          <div className="space-y-3">
            {props.stableTemplates.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => props.onSelectStableTemplate(template.id)}
                className="agent-selection-card text-left"
                data-active={props.selectedTemplateId === template.id}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-[color:var(--color-text-primary)]">{template.label}</p>
                    <p className="text-xs text-[color:var(--color-text-tertiary)]">{template.id}</p>
                  </div>
                  <StatusPill tone={template.preferredBinding === "built-in-tool" ? "success" : "warning"}>
                    {template.preferredBinding === "built-in-tool" ? "Prefer workflow node" : "Prefer stable skill"}
                  </StatusPill>
                </div>
                <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">{template.description}</p>
              </button>
            ))}
          </div>
        ) : (
          <SidebarCardSkeleton count={2} minHeightClassName="min-h-[88px]" />
        )}
      </ShellCard>

      <ShellCard eyebrow="Node Library" title="Add workflow nodes">
        <div data-testid="workflow-builder-node-library" className="space-y-4">
          {props.deferredSidebarReady ? (
            <>
              <label className="grid gap-2">
                <span className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-tertiary)]">Search nodes</span>
                <input
                  data-testid="workflow-builder-node-search"
                  value={props.paletteQuery}
                  onInput={(event) => props.onPaletteQueryChange(event.currentTarget.value)}
                  onChange={(event) => props.onPaletteQueryChange(event.target.value)}
                  onKeyDown={props.onPaletteSearchKeyDown}
                  className="agent-input"
                  placeholder="Search by node or group"
                />
              </label>
              {props.visiblePaletteGroups.length === 0 ? (
                <p className="text-sm text-[color:var(--color-text-tertiary)]">No node cards match this filter.</p>
              ) : props.visiblePaletteGroups.map((group) => (
                <div key={group.id} className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <button
                      data-testid={`workflow-builder-palette-toggle-${group.id}`}
                      type="button"
                      onClick={() => props.onTogglePaletteGroup(group.id)}
                      className="inline-flex items-center gap-2 text-left"
                    >
                      {group.collapsed ? <ChevronRight className="h-4 w-4 text-[color:var(--color-text-tertiary)]" /> : <ChevronDown className="h-4 w-4 text-[color:var(--color-text-tertiary)]" />}
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{group.label}</p>
                    </button>
                    <StatusPill>{group.entries.length}</StatusPill>
                  </div>
                  {group.visibleEntries.length === 0 ? (
                    <p className="rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2 text-xs text-[color:var(--color-text-faint)]">
                      Group collapsed. Search still reveals matching nodes without changing this state.
                    </p>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {group.visibleEntries.map((entry) => (
                        <button
                          key={entry.type}
                          data-testid={`workflow-builder-palette-entry-${entry.type}`}
                          data-keyboard-active={props.keyboardPaletteActiveType === entry.type ? "true" : "false"}
                          type="button"
                          disabled={!props.activeDraft || props.readonly}
                          draggable={props.activeDraft && !props.readonly}
                          onDragStart={(event) => props.onPaletteDragStart(event, entry.type)}
                          onDragEnd={props.onPaletteDragEnd}
                          onMouseEnter={() => props.onPaletteEntryHover(entry.type)}
                          onClick={() => props.onPaletteEntryClick(entry.type)}
                          className={cn(
                            "agent-selection-card text-left disabled:cursor-not-allowed disabled:opacity-60",
                            props.keyboardPaletteActiveType === entry.type && "ring-2 ring-[color:var(--color-focus-ring)]",
                            props.draggingPaletteType === entry.type && "border-[color:var(--color-accent)] bg-[color:var(--color-accent-muted)]",
                          )}
                        >
                          <p className="font-medium text-[color:var(--color-text-primary)]">{entry.label}</p>
                          <p className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">{entry.description}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </>
          ) : (
            <div className="space-y-3">
              <div className="min-h-[44px] rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]" />
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="min-h-[88px] rounded-[20px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]" />
                <div className="min-h-[88px] rounded-[20px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]" />
              </div>
            </div>
          )}
        </div>
      </ShellCard>
    </div>
  );
}

function SidebarCardSkeleton(props: {
  count: number;
  minHeightClassName: string;
}) {
  return (
    <div className="space-y-3">
      {Array.from({ length: props.count }).map((_, index) => (
        <div
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          className={cn(
            props.minHeightClassName,
            "rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]",
          )}
        />
      ))}
    </div>
  );
}

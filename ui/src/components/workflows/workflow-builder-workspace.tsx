import "@xyflow/react/dist/style.css";

import { Suspense, createContext, lazy, memo, startTransition, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  getBezierPath,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type Viewport,
} from "@xyflow/react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightLeft,
  Copy,
  Loader2,
  Lock,
  RefreshCcw,
  Save,
  Shapes,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";
import { WorkflowBuilderCanvasToolbar } from "@/components/workflows/workflow-builder-canvas-toolbar";
import type {
  WorkflowBuilderPaletteGroupSummary,
  WorkflowBuilderStableTemplateSummary,
  WorkflowBuilderTaskProfileOption,
} from "@/components/workflows/workflow-builder-left-sidebar";
import { skillsApi } from "@/lib/api/skills";
import { workflowBuilderApi } from "@/lib/api/workflow-builder";
import { workflowsApi } from "@/lib/api/workflows";
import type {
  AgentTaskProfileId,
  FridayAcquireWorkflowLockResponse,
  FridayStableWorkflowTemplate,
  FridayWorkflowBuilderValidationReport,
  FridayWorkflowDraftEntity,
  FridayWorkflowEditorEdge,
  FridayWorkflowEditorGraphV1,
  FridayWorkflowEditorNode,
  FridayWorkflowNodeConfig,
  FridayWorkflowNodeDefinition,
  FridayWorkflowSpecEdgeWhen,
  FridayWorkflowTemplateEntity,
  WorkflowNodeType,
} from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { createDefaultRawGraph, createDefaultSpec, createDefaultVisual, getDefaultNodeConfig, getNextNodeName } from "@/lib/workflows/defaults";
import {
  buildValidationIssueNavigationItems,
  describeWorkflowEdgeLabel,
  BUILDER_NODE_PALETTE,
  buildBuilderPaletteGroups,
  edgeKeyFor,
  findClosestDropTargetNodeId,
  snapFlowPositionToGrid,
  summarizeWorkflowValidationIssues,
  type BuilderPaletteGroupId,
  type BuilderValidationIssueNavigationItem,
  type BuilderValidationTone,
} from "@/lib/workflows/builder-canvas";
import { applyDagreLayout } from "@/lib/workflows/flow-layout";
import { draftToEditorGraph, editorGraphToDraftBundle } from "@/lib/workflows/editor-adapters";
import { type FridayWorkflowBuilderFocus } from "@/lib/workflows/view-models";

const WorkflowBuilderRightSidebar = lazy(async () =>
  import("@/components/workflows/workflow-builder-right-sidebar").then((module) => ({
    default: module.WorkflowBuilderRightSidebar,
  }))
);

const WorkflowBuilderLeftSidebar = lazy(async () =>
  import("@/components/workflows/workflow-builder-left-sidebar").then((module) => ({
    default: module.WorkflowBuilderLeftSidebar,
  }))
);

type FlowNodeData = FridayWorkflowNodeDefinition & {
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
};

type FlowEdgeData = NonNullable<FridayWorkflowEditorEdge["data"]> & {
  issueTone?: BuilderValidationTone;
  issueCount?: number;
  primaryIssueMessage?: string;
  remainingCount?: number;
  activeIssue?: boolean;
  visitedIssue?: boolean;
};

type FlowNode = Node<FlowNodeData, "workflow_node">;
type FlowEdge = Edge<FlowEdgeData, "workflow_edge">;

interface EditorSnapshot {
  nodes: FlowNode[];
  edges: FlowEdge[];
  viewport: Viewport;
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
}

interface DropPreviewState {
  type: Exclude<WorkflowNodeType, "trigger">;
  position: { x: number; y: number };
}

interface CanvasDropFeedbackState {
  tone: "valid" | "invalid";
  type: Exclude<WorkflowNodeType, "trigger">;
  message: string;
  targetNodeId: string | null;
}

interface WorkflowCanvasInteractionContextValue {
  focusNodeIssue: (nodeId: string) => void;
  focusEdgeIssue: (edgeKey: string) => void;
  compactMode: boolean;
}

const WorkflowCanvasInteractionContext = createContext<WorkflowCanvasInteractionContextValue | null>(null);

const TASK_PROFILE_OPTIONS: WorkflowBuilderTaskProfileOption[] = [
  { id: "default", label: "Balanced", detail: "General-purpose profile." },
  { id: "deterministic", label: "Deterministic", detail: "Low-variance structured execution." },
  { id: "planning", label: "Planning", detail: "Higher-effort planning and decomposition." },
  { id: "review", label: "Review", detail: "Low-variance critique and validation." },
  { id: "creative", label: "Creative", detail: "Higher-variance ideation and synthesis." },
];

const INTEGRATION_MODE_OPTIONS = [
  { value: "stable_skill", label: "Prefer stable skill" },
  { value: "workflow_node", label: "Prefer workflow node" },
  { value: "cli_backed", label: "Prefer CLI-backed skill" },
  { value: "mcp_backed", label: "Prefer MCP-backed skill" },
] as const;

const NODE_LIBRARY_DND_MIME = "application/friday-workflow-node-type";

const CANVAS_GRID_SIZE = 28;

function describePaletteEntry(type: Exclude<WorkflowNodeType, "trigger">) {
  return BUILDER_NODE_PALETTE.find((entry) => entry.type === type) ?? null;
}

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
      label: "Prefer stable skill",
      reason: "This template came from an installed skill, so a stable skill binding is the default starting point.",
    };
  }
  if (input.template.kind === "builtin") {
    return {
      label: "Prefer workflow node",
      reason: "This template is a generic workflow starter and usually begins as a node-driven flow.",
    };
  }
  return {
    label: "Prefer workflow node",
    reason: "This user-owned template should be checked against the current deploy and validation surface.",
  };
}

function defaultStepTypeForNodeType(nodeType: WorkflowNodeType): FridayWorkflowNodeDefinition["stepType"] {
  switch (nodeType) {
    case "ai":
      return "tool_call";
    case "condition":
      return "condition";
    case "data":
      return "transform";
    case "approval":
      return "human_approval";
    case "trigger":
      return undefined;
    case "action":
    default:
      return "skill_call";
  }
}

function defaultNodeTypeForStepType(stepType: FridayWorkflowNodeDefinition["stepType"]): WorkflowNodeType {
  switch (stepType) {
    case "tool_call":
      return "ai";
    case "condition":
      return "condition";
    case "transform":
      return "data";
    case "human_approval":
      return "approval";
    case "skill_call":
    default:
      return "action";
  }
}

function buildReplacementNodeDefinition(input: {
  node: FridayWorkflowNodeDefinition;
  nextType: WorkflowNodeType;
  nextStepType?: FridayWorkflowNodeDefinition["stepType"];
}): FridayWorkflowNodeDefinition {
  const config = getDefaultNodeConfig(input.nextType);
  const preservedRawArgs = {
    ...(input.node.rawArgs ?? {}),
  };
  const nextStepType = input.nextStepType ?? defaultStepTypeForNodeType(input.nextType);
  const nextStepRef =
    input.nextType === "trigger"
      ? undefined
      : "skillId" in config
        ? config.skillId
        : "toolId" in config
          ? config.toolId
          : undefined;

  return {
    ...input.node,
    type: input.nextType,
    stepType: nextStepType,
    stepRef: nextStepRef,
    config,
    stepCondition: nextStepType === "condition" ? input.node.stepCondition : undefined,
    rawArgs: preservedRawArgs,
  };
}

function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || target.isContentEditable;
}

function cloneSnapshot(snapshot: EditorSnapshot): EditorSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as EditorSnapshot;
}

function snapshotSignature(snapshot: EditorSnapshot): string {
  return JSON.stringify(snapshot);
}

function toFlowNodes(nodes: FridayWorkflowEditorNode[], selectedNodeIds: string[]): FlowNode[] {
  const selected = new Set(selectedNodeIds);
  return nodes.map((node) => ({
    ...node,
    selected: selected.has(node.id),
  }));
}

function toFlowEdges(edges: FridayWorkflowEditorEdge[], selectedEdgeIds: string[]): FlowEdge[] {
  const selected = new Set(selectedEdgeIds);
  return edges.map((edge) => ({
    ...edge,
    type: "workflow_edge",
    selected: selected.has(edge.id),
    markerEnd: { type: MarkerType.ArrowClosed, color: "rgba(236, 245, 255, 0.8)" },
    style: { stroke: "rgba(236, 245, 255, 0.65)", strokeWidth: 1.6 },
  }));
}

function flowToEditorGraph(input: {
  nodes: FlowNode[];
  edges: FlowEdge[];
  viewport: Viewport;
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
}): FridayWorkflowEditorGraphV1 {
  return {
    schemaVersion: "1.0",
    reactFlowVersion: "11",
    nodes: input.nodes.map((node) => ({
      id: node.id,
      type: "workflow_node",
      position: node.position,
      width: node.width,
      height: node.height,
      data: node.data,
    })),
    edges: input.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? undefined,
      targetHandle: edge.targetHandle ?? undefined,
      data: edge.data
        ? {
            condition: edge.data.condition,
            branch: edge.data.branch,
            edgeKey: edge.data.edgeKey,
            bendPoints: edge.data.bendPoints,
          }
        : undefined,
    })),
    viewport: input.viewport,
    selectedNodeId: input.selectedNodeIds[0],
    selectedEdgeId: input.selectedEdgeIds[0],
  };
}

function createSnapshot(input: {
  nodes: FlowNode[];
  edges: FlowEdge[];
  viewport: Viewport;
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
}): EditorSnapshot {
  return cloneSnapshot({
    nodes: input.nodes,
    edges: input.edges,
    viewport: input.viewport,
    selectedNodeIds: input.selectedNodeIds,
    selectedEdgeIds: input.selectedEdgeIds,
  });
}

function branchFromHandle(sourceHandle?: string | null): FridayWorkflowSpecEdgeWhen | undefined {
  if (sourceHandle === "success" || sourceHandle === "failure" || sourceHandle === "true" || sourceHandle === "false") {
    return sourceHandle;
  }
  return undefined;
}

function createBlankDraftPayload(workflowId: string, title: string) {
  const spec = createDefaultSpec(workflowId, title);
  const visual = createDefaultVisual(workflowId);
  visual.panelLayout = { leftOpen: true, rightOpen: true, bottomOpen: true };
  visual.nodes = [{ nodeId: "__trigger__", x: 80, y: 220, width: 230, height: 124 }];
  return { spec, visual };
}

function nodeTypeBadge(node: FridayWorkflowNodeDefinition): string {
  if (node.type === "trigger") return "trigger";
  return node.stepType ?? node.type;
}

function syncNodeSelection(nodes: FlowNode[], selectedNodeIds: string[]): FlowNode[] {
  const selected = new Set(selectedNodeIds);
  return nodes.map((node) => (
    node.selected === selected.has(node.id)
      ? node
      : { ...node, selected: selected.has(node.id) }
  ));
}

function syncEdgeSelection(edges: FlowEdge[], selectedEdgeIds: string[]): FlowEdge[] {
  const selected = new Set(selectedEdgeIds);
  return edges.map((edge) => (
    edge.selected === selected.has(edge.id)
      ? edge
      : { ...edge, selected: selected.has(edge.id) }
  ));
}

function sameIdList(current: string[], next: string[]): boolean {
  if (current.length !== next.length) {
    return false;
  }
  for (let index = 0; index < current.length; index += 1) {
    if (current[index] !== next[index]) {
      return false;
    }
  }
  return true;
}

function useDeferredMount(active: boolean, timeoutMs = 140): boolean {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (!active) {
      setMounted(false);
      return;
    }

    if (mounted) {
      return;
    }

    if (typeof window === "undefined" || Boolean(process.env.VITEST)) {
      setMounted(true);
      return;
    }

    const browserWindow = window as Window & typeof globalThis & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    if (typeof browserWindow.requestIdleCallback === "function") {
      const idleId = browserWindow.requestIdleCallback(() => setMounted(true), { timeout: timeoutMs });
      return () => browserWindow.cancelIdleCallback?.(idleId);
    }

    const timeoutId = browserWindow.setTimeout(() => setMounted(true), timeoutMs);
    return () => browserWindow.clearTimeout(timeoutId);
  }, [active, mounted, timeoutMs]);

  return mounted;
}

function issueToneToStatusTone(tone?: BuilderValidationTone): "warning" | "danger" | "neutral" {
  if (tone === "danger") return "danger";
  if (tone === "warning") return "warning";
  return "neutral";
}

function issueToneToEdgeStroke(tone?: BuilderValidationTone, selected?: boolean): string {
  if (tone === "danger") return "rgba(251, 113, 133, 0.9)";
  if (tone === "warning") return "rgba(251, 191, 36, 0.9)";
  if (selected) return "rgba(110, 231, 183, 0.92)";
  return "rgba(236, 245, 255, 0.65)";
}

function createCompactCanvasNode(node: FlowNode): FlowNode {
  const { id, name, type, stepType, stepRef, config, __ui } = node.data;
  return {
    ...node,
    data: {
      id,
      name,
      type,
      stepType,
      stepRef,
      config,
      __ui,
    },
  };
}

function createCompactCanvasEdge(edge: FlowEdge): FlowEdge {
  return {
    ...edge,
    data: edge.data
      ? {
          branch: edge.data.branch,
          condition: edge.data.condition,
          edgeKey: edge.data.edgeKey,
          issueTone: edge.data.issueTone,
          issueCount: edge.data.issueCount,
          primaryIssueMessage: edge.data.primaryIssueMessage,
          remainingCount: edge.data.remainingCount,
          activeIssue: edge.data.activeIssue,
          visitedIssue: edge.data.visitedIssue,
        }
      : undefined,
  };
}

function WorkflowCanvasNodeInner(props: NodeProps<FlowNode>) {
  const { data: node, selected } = props;
  const interaction = useContext(WorkflowCanvasInteractionContext);
  const isCondition = node.type === "condition";
  const isTrigger = node.type === "trigger";
  const isPreview = node.__ui?.preview === true;
  const isActiveIssue = node.__ui?.activeIssue === true;
  const isVisitedIssue = node.__ui?.visitedIssue === true;
  const isDropTarget = node.__ui?.dropTarget === true;
  const integrationMode = typeof node.rawArgs?.integrationMode === "string" ? node.rawArgs.integrationMode : null;
  const taskProfile = typeof node.rawArgs?.taskProfile === "string" ? node.rawArgs.taskProfile : null;
  const issueTone = node.__ui?.issueTone;
  const issueCount = node.__ui?.issueCount ?? 0;
  const primaryIssueMessage = node.__ui?.primaryIssueMessage;
  const remainingCount = node.__ui?.remainingCount ?? 0;
  const canFocusIssue = Boolean(!isPreview && issueCount > 0 && interaction);
  const compactMode = interaction?.compactMode === true && !selected && !isActiveIssue && !isPreview;

  if (compactMode) {
    return (
      <div
        data-testid={`workflow-builder-node-${node.id}`}
        className={cn(
          "relative min-w-[188px] rounded-[20px] border px-4 py-3 shadow-[0_12px_24px_rgba(0,0,0,0.18)]",
          issueTone
            ? "border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-surface)]"
            : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]",
        )}
      >
        {!isTrigger ? <Handle type="target" id="in" position={Position.Left} className="!h-3 !w-3 !border-none !bg-[color:var(--color-accent)]" /> : null}
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{nodeTypeBadge(node)}</p>
          <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{node.name}</p>
          {issueCount > 0 ? (
            <p className="text-[11px] text-[color:var(--color-text-secondary)]">
              {issueCount} issue{issueCount > 1 ? "s" : ""}
            </p>
          ) : null}
        </div>
        {isTrigger ? (
          <Handle type="source" id="any" position={Position.Right} className="!h-3 !w-3 !border-none !bg-[color:var(--color-border-strong)]" />
        ) : isCondition ? (
          <>
            <Handle type="source" id="true" position={Position.Right} style={{ top: 30 }} className="!h-3 !w-3 !border-none !bg-[color:var(--color-accent)]" />
            <Handle type="source" id="false" position={Position.Right} style={{ top: 62 }} className="!h-3 !w-3 !border-none !bg-[color:var(--color-border-strong)]" />
          </>
        ) : (
          <>
            <Handle type="source" id="any" position={Position.Right} style={{ top: 26 }} className="!h-3 !w-3 !border-none !bg-[color:var(--color-accent)]" />
            <Handle type="source" id="success" position={Position.Right} style={{ top: 54 }} className="!h-3 !w-3 !border-none !bg-[color:var(--color-accent)]" />
            <Handle type="source" id="failure" position={Position.Right} style={{ top: 82 }} className="!h-3 !w-3 !border-none !bg-[color:var(--color-border-strong)]" />
          </>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid={`workflow-builder-node-${node.id}`}
      data-active-issue={isActiveIssue ? "true" : "false"}
      data-drop-target={isDropTarget ? "true" : "false"}
      className={`relative min-w-[220px] rounded-[24px] border px-4 py-3 shadow-[0_18px_45px_rgba(0,0,0,0.28)] ${
        isPreview
          ? "border-dashed border-[color:var(--color-accent)] bg-[color:var(--color-accent-muted)]"
          : isActiveIssue
            ? "border-[color:var(--color-accent)] bg-[color:var(--color-bg-surface-strong)] ring-2 ring-[color:var(--color-focus-ring)]"
            : selected
              ? "border-[color:var(--color-accent)] bg-[color:var(--color-bg-surface-strong)] ring-1 ring-[color:var(--color-focus-ring)]"
              : isDropTarget
                ? "border-[color:var(--color-accent)] bg-[color:var(--color-bg-surface-strong)] ring-2 ring-[color:var(--color-focus-ring)]"
                : issueTone === "danger"
                  ? "border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] ring-1 ring-[color:var(--color-border-strong)]"
                  : issueTone === "warning"
                    ? "border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] ring-1 ring-[color:var(--color-focus-ring)]"
                    : isVisitedIssue
                      ? "border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-surface)]"
                      : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]"
      }`}
      style={isPreview ? { opacity: 0.9 } : undefined}
    >
      {issueTone && !isPreview ? (
        <div
          className={cn(
            "absolute inset-y-3 left-1.5 rounded-full",
            isActiveIssue ? "w-1.5" : "w-1",
            issueTone === "danger" ? "bg-[color:var(--color-border-strong)]" : "bg-[color:var(--color-bg-contrast)]",
          )}
        />
      ) : null}
      {isVisitedIssue && !isActiveIssue && !isPreview ? (
        <div className="absolute right-3 top-3 h-2.5 w-2.5 rounded-full bg-[color:var(--color-accent)]" />
      ) : null}
      {!isTrigger && !isPreview ? <Handle type="target" id="in" position={Position.Left} className="!h-3 !w-3 !border-none !bg-[color:var(--color-accent)]" /> : null}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-[color:var(--color-text-faint)]">{nodeTypeBadge(node)}</p>
            <p className="mt-1 text-sm font-semibold text-[color:var(--color-text-primary)]">{node.name}</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <StatusPill tone={isPreview || selected ? "success" : "neutral"}>{isPreview ? "preview" : node.type}</StatusPill>
            {!compactMode && issueCount > 0 ? (
              canFocusIssue ? (
                <button
                  data-testid={`workflow-builder-node-issue-pill-${node.id}`}
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    interaction?.focusNodeIssue(node.id);
                  }}
                >
                  <StatusPill tone={issueToneToStatusTone(issueTone)}>
                    {issueCount} issue{issueCount > 1 ? "s" : ""}
                  </StatusPill>
                </button>
              ) : (
                <StatusPill tone={issueToneToStatusTone(issueTone)}>
                  {issueCount} issue{issueCount > 1 ? "s" : ""}
                </StatusPill>
              )
            ) : null}
            {isDropTarget && !isPreview ? <StatusPill tone="success">drop target</StatusPill> : null}
          </div>
        </div>
        {compactMode ? null : <p className="text-xs text-[color:var(--color-text-tertiary)]">{node.stepRef ?? "No bound ref yet"}</p>}
        {compactMode ? null : (
          <div className="flex flex-wrap gap-2">
            {taskProfile ? <StatusPill>{taskProfile}</StatusPill> : null}
            {integrationMode ? <StatusPill>{integrationMode}</StatusPill> : null}
          </div>
        )}
        {!compactMode && primaryIssueMessage ? (
          canFocusIssue ? (
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                interaction?.focusNodeIssue(node.id);
              }}
              className={cn(
                "flex w-full items-center justify-between gap-3 rounded-[18px] border px-3 py-2 text-left text-xs transition",
                issueTone === "danger"
                  ? "border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-contrast)]"
                  : "border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-contrast)]",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{primaryIssueMessage}</span>
              {remainingCount > 0 ? <span className="shrink-0 text-[10px] uppercase tracking-[0.16em] text-[color:var(--color-text-secondary)]">+{remainingCount} more</span> : null}
            </button>
          ) : (
            <div
              className={cn(
                "rounded-[18px] border px-3 py-2 text-xs",
                issueTone === "danger"
                  ? "border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] text-[color:var(--color-text-primary)]"
                  : "border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] text-[color:var(--color-text-primary)]",
              )}
            >
              <span>{primaryIssueMessage}</span>
              {remainingCount > 0 ? <span className="ml-2 text-[10px] uppercase tracking-[0.16em] text-[color:var(--color-text-secondary)]">+{remainingCount} more</span> : null}
            </div>
          )
        ) : null}
      </div>
      {isPreview ? null : isTrigger ? (
        <Handle type="source" id="any" position={Position.Right} className="!h-3 !w-3 !border-none !bg-[color:var(--color-border-strong)]" />
      ) : isCondition ? (
        <>
          <Handle type="source" id="true" position={Position.Right} style={{ top: 34 }} className="!h-3 !w-3 !border-none !bg-[color:var(--color-accent)]" />
          <Handle type="source" id="false" position={Position.Right} style={{ top: 78 }} className="!h-3 !w-3 !border-none !bg-[color:var(--color-border-strong)]" />
        </>
      ) : (
        <>
          <Handle type="source" id="any" position={Position.Right} style={{ top: 28 }} className="!h-3 !w-3 !border-none !bg-[color:var(--color-accent)]" />
          <Handle type="source" id="success" position={Position.Right} style={{ top: 62 }} className="!h-3 !w-3 !border-none !bg-[color:var(--color-accent)]" />
          <Handle type="source" id="failure" position={Position.Right} style={{ top: 96 }} className="!h-3 !w-3 !border-none !bg-[color:var(--color-border-strong)]" />
        </>
      )}
    </div>
  );
}

const WorkflowCanvasNode = memo(WorkflowCanvasNodeInner);

function WorkflowCanvasEdgeInner(props: EdgeProps<FlowEdge>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd } = props;
  const interaction = useContext(WorkflowCanvasInteractionContext);
  const isActiveIssue = data?.activeIssue === true;
  const isVisitedIssue = data?.visitedIssue === true;
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const edgeStroke = isActiveIssue
    ? "rgba(125, 211, 252, 0.96)"
    : issueToneToEdgeStroke(data?.issueTone, selected);
  const compactMode = interaction?.compactMode === true && !selected && !isActiveIssue && !data?.primaryIssueMessage;

  if (compactMode) {
    return (
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: edgeStroke,
          strokeWidth: data?.issueTone ? 2.1 : 1.55,
        }}
      />
    );
  }

  const label = describeWorkflowEdgeLabel(data, {
    includeFallback: selected || Boolean(data?.issueCount) || Boolean(data?.primaryIssueMessage),
  });
  const primaryIssueMessage = data?.primaryIssueMessage;
  const remainingCount = data?.remainingCount ?? 0;
  const canFocusIssue = Boolean(data?.edgeKey && primaryIssueMessage && interaction);

  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: edgeStroke,
          strokeWidth: isActiveIssue ? 3 : selected ? 2.6 : data?.issueTone ? 2.2 : 1.6,
          strokeDasharray: isActiveIssue ? "8 5" : undefined,
        }}
      />
      {!compactMode && (label || primaryIssueMessage) ? (
        <EdgeLabelRenderer>
          <button
            data-testid={data?.edgeKey ? `workflow-builder-edge-label-${data.edgeKey}` : undefined}
            data-active-issue={isActiveIssue ? "true" : "false"}
            type="button"
            disabled={!canFocusIssue}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (data?.edgeKey) {
                interaction?.focusEdgeIssue(data.edgeKey);
              }
            }}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            className={cn(
              "pointer-events-auto absolute min-w-[152px] rounded-[18px] border px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--color-text-primary)] shadow-[0_14px_28px_rgba(0,0,0,0.32)]",
              isActiveIssue && "ring-2 ring-[color:var(--color-focus-ring)]",
              isVisitedIssue && !isActiveIssue && "border-[color:var(--color-border-strong)]",
              data?.issueTone === "danger" && "border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] text-[color:var(--color-text-primary)]",
              data?.issueTone === "warning" && "border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] text-[color:var(--color-text-primary)]",
              !data?.issueTone && "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] text-[color:var(--color-text-secondary)]",
              !canFocusIssue && "cursor-default",
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <span>{label ?? "Always"}</span>
              {data?.issueCount ? <span className="text-[10px] tracking-[0.12em] text-[color:var(--color-text-secondary)]">{data.issueCount}</span> : null}
            </div>
            {primaryIssueMessage ? (
              <div className="mt-1.5 border-t border-[color:var(--color-border-soft)] pt-1.5 text-[10px] normal-case tracking-normal text-[color:var(--color-text-secondary)]">
                <span>{primaryIssueMessage}</span>
                {remainingCount > 0 ? <span className="ml-2 uppercase tracking-[0.16em] text-[color:var(--color-text-secondary)]">+{remainingCount}</span> : null}
              </div>
            ) : null}
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const WorkflowCanvasEdge = memo(WorkflowCanvasEdgeInner);

const WORKFLOW_NODE_TYPES = {
  workflow_node: WorkflowCanvasNode,
};

const WORKFLOW_EDGE_TYPES = {
  workflow_edge: WorkflowCanvasEdge,
};

export function WorkflowBuilderWorkspace() {
  return (
    <ReactFlowProvider>
      <WorkflowBuilderEditor />
    </ReactFlowProvider>
  );
}

function WorkflowBuilderRightSidebarFallback() {
  return (
    <div className="space-y-4">
      <ShellCard eyebrow="Inspector" title="Draft inspector" aside={<StatusPill tone="neutral">loading</StatusPill>}>
        <div className="space-y-3">
          <div className="min-h-[44px] rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]" />
          <div className="min-h-[112px] rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]" />
          <div className="min-h-[148px] rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]" />
        </div>
      </ShellCard>
      <ShellCard eyebrow="Templates" title="Additional template groups">
        <div className="space-y-3">
          <div className="min-h-[96px] rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]" />
          <div className="min-h-[96px] rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]" />
        </div>
      </ShellCard>
    </div>
  );
}

function WorkflowBuilderLeftSidebarFallback() {
  return (
    <div className="space-y-4">
      <ShellCard eyebrow="Template Library" title="Builder library loading">
        <div className="space-y-3">
          <div className="min-h-[112px] rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]" />
          <div className="min-h-[52px] rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]" />
        </div>
      </ShellCard>
      <ShellCard eyebrow="Stable Starters" title="Stable workflow templates">
        <div className="space-y-3">
          <div className="min-h-[88px] rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]" />
          <div className="min-h-[88px] rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]" />
        </div>
      </ShellCard>
      <ShellCard eyebrow="Node Library" title="Add workflow nodes">
        <div className="space-y-3">
          <div className="min-h-[44px] rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]" />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-h-[88px] rounded-[20px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]" />
            <div className="min-h-[88px] rounded-[20px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]" />
          </div>
        </div>
      </ShellCard>
    </div>
  );
}

function WorkflowBuilderEditor() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const reactFlow = useReactFlow<FlowNode, FlowEdge>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [title, setTitle] = useState("");
  const [selectedTaskProfileId, setSelectedTaskProfileId] = useState<AgentTaskProfileId>("planning");
  const [targetWorkflowId, setTargetWorkflowId] = useState<string>("new");
  const [changeNote, setChangeNote] = useState("Published from workflow builder.");
  const [draftTitle, setDraftTitle] = useState("");
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const [jsonEditorText, setJsonEditorText] = useState("{}");
  const [dirty, setDirty] = useState(false);
  const [readonlyReason, setReadonlyReason] = useState<string | null>(null);
  const [lockState, setLockState] = useState<FridayAcquireWorkflowLockResponse["lock"] | null>(null);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [collapsedPaletteGroups, setCollapsedPaletteGroups] = useState<BuilderPaletteGroupId[]>([]);
  const [keyboardPaletteIndex, setKeyboardPaletteIndex] = useState(-1);
  const [compileReport, setCompileReport] = useState<{
    validation: FridayWorkflowBuilderValidationReport;
    nodes: number;
    edges: number;
  } | null>(null);
  const [overviewVisible, setOverviewVisible] = useState(false);
  const [activeIssueKey, setActiveIssueKey] = useState<string | null>(null);
  const [visitedIssueKeys, setVisitedIssueKeys] = useState<string[]>([]);
  const [draggingPaletteType, setDraggingPaletteType] = useState<Exclude<WorkflowNodeType, "trigger"> | null>(null);
  const [dropPreview, setDropPreview] = useState<DropPreviewState | null>(null);
  const [dropFeedback, setDropFeedback] = useState<CanvasDropFeedbackState | null>(null);
  const [publishedVersionNumber, setPublishedVersionNumber] = useState<number | null>(null);
  const [localDraftOverride, setLocalDraftOverride] = useState<FridayWorkflowDraftEntity | null>(null);
  const historyRef = useRef<EditorSnapshot[]>([]);
  const historyIndexRef = useRef(-1);
  const latestDraftStageKeyRef = useRef<string | null>(null);
  const latestGraphTransformKeyRef = useRef<string | null>(null);
  const latestReactFlowMountKeyRef = useRef<string | null>(null);
  const latestInteractiveCanvasKeyRef = useRef<string | null>(null);
  const [reactFlowMounted, setReactFlowMounted] = useState(false);
  const pendingHydratedDraftRef = useRef<{
    fingerprint: string;
    snapshot: EditorSnapshot;
    resetCompileState: boolean;
  } | null>(null);
  const clipboardRef = useRef<EditorSnapshot | null>(null);
  const loadedDraftKeyRef = useRef<string | null>(null);
  const lastAutosaveAtRef = useRef<string | null>(null);
  const lastManualSaveAtRef = useRef<string | null>(null);
  const syncViewportToCanvas = (nextViewport: Viewport) => {
    if (typeof reactFlow.setViewport !== "function") {
      return;
    }
    const maybePromise = reactFlow.setViewport(nextViewport, { duration: 0 });
    if (maybePromise && typeof (maybePromise as Promise<unknown>).catch === "function") {
      void (maybePromise as Promise<unknown>).catch(() => undefined);
    }
  };

  const selectedTemplateId = searchParams.get("templateId");
  const requestedWorkflowId = searchParams.get("workflowId");
  const requestedDraftId = searchParams.get("draftId");
  const focus = parseFocus(searchParams.get("focus"));
  const hasRequestedDraftTarget = Boolean(requestedWorkflowId && requestedDraftId);
  const isDeepLinkedDraft = hasRequestedDraftTarget;
  const deferredCanvasDetailReady = useDeferredMount(hasRequestedDraftTarget, isDeepLinkedDraft ? 420 : 180);
  const deferredSidebarReady = useDeferredMount(!hasRequestedDraftTarget || deferredCanvasDetailReady, isDeepLinkedDraft ? 180 : 120);
  const deferredCatalogReady = useDeferredMount(true, isDeepLinkedDraft ? 900 : 220);
  const catalogQueriesEnabled = !isDeepLinkedDraft || deferredCatalogReady;
  const templatesQuery = useQuery({
    queryKey: ["workflow-builder", "templates"],
    queryFn: () => workflowBuilderApi.listTemplates(),
    enabled: catalogQueriesEnabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const workflowsQuery = useQuery({
    queryKey: ["workflow-builder", "workflows"],
    queryFn: () => workflowsApi.list({ limit: 50 }),
    enabled: catalogQueriesEnabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const draftsQuery = useQuery({
    queryKey: ["workflow-builder", "drafts", requestedWorkflowId],
    queryFn: () => workflowBuilderApi.listDrafts(requestedWorkflowId!, { limit: 12 }),
    enabled: Boolean(requestedWorkflowId && !requestedDraftId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const resolvedDraftId = requestedDraftId ?? draftsQuery.data?.items[0]?.draftId ?? null;
  const hasDraftTarget = Boolean(requestedWorkflowId && resolvedDraftId);
  const deferredCanvasChromeReady = useDeferredMount(hasDraftTarget, isDeepLinkedDraft ? 180 : 90);
  const deferredInspectorReady = useDeferredMount(hasDraftTarget, isDeepLinkedDraft ? 520 : 220);
  const deferredTemplateGroupsReady = useDeferredMount(catalogQueriesEnabled, isDeepLinkedDraft ? 1_300 : 320);

  const shouldLoadSkills = useMemo(() => {
    if (!deferredInspectorReady) {
      return false;
    }
    const currentSelectedNodeId = selectedNodeIds[0];
    if (!currentSelectedNodeId) {
      return false;
    }
    const currentSelectedNode = nodes.find((node) => node.id === currentSelectedNodeId);
    if (!currentSelectedNode || currentSelectedNode.data.type === "trigger") {
      return false;
    }
    return "actionType" in currentSelectedNode.data.config && currentSelectedNode.data.config.actionType === "skill";
  }, [deferredInspectorReady, nodes, selectedNodeIds]);

  const skillsQuery = useQuery({
    queryKey: ["workflow-builder", "skills"],
    queryFn: () => skillsApi.listSkills(),
    enabled: shouldLoadSkills,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const draftQuery = useQuery({
    queryKey: ["workflow-builder", "draft", requestedWorkflowId, resolvedDraftId],
    queryFn: () => workflowBuilderApi.getDraft(requestedWorkflowId!, resolvedDraftId!),
    enabled: Boolean(requestedWorkflowId && resolvedDraftId),
  });

  const regularTemplates = templatesQuery.data?.items ?? [];
  const stableTemplates = templatesQuery.data?.stableItems ?? [];
  const selectedStableTemplate = stableTemplates.find((item) => item.id === selectedTemplateId) ?? null;
  const selectedRegularTemplate = regularTemplates.find((item) => item.templateId === selectedTemplateId) ?? null;

  const templateDetailQuery = useQuery({
    queryKey: ["workflow-builder", "template", selectedTemplateId],
    queryFn: () => workflowBuilderApi.getTemplate(selectedTemplateId!),
    enabled: Boolean(catalogQueriesEnabled && selectedTemplateId && !selectedStableTemplate),
  });

  const selectedTemplate = templateDetailQuery.data?.template ?? selectedRegularTemplate;
  const activeDraft = localDraftOverride ?? draftQuery.data?.draft ?? null;
  const activeDraftFingerprint = activeDraft ? `${activeDraft.draftId}:${activeDraft.revision}` : null;
  const isDraftHydrated = activeDraftFingerprint !== null && loadedDraftKeyRef.current === activeDraftFingerprint;
  const selectedNode = selectedNodeIds[0]
    ? nodes.find((node) => node.id === selectedNodeIds[0]) ?? null
    : null;
  const selectedEdge = selectedEdgeIds[0]
    ? edges.find((edge) => edge.id === selectedEdgeIds[0]) ?? null
    : null;

  const integrationMode = describeIntegrationMode({
    template: selectedTemplate,
    stableTemplate: selectedStableTemplate,
  });

  const issueSummaries = useMemo(() => summarizeWorkflowValidationIssues(compileReport?.validation), [compileReport]);
  const issueNavigationItems = useMemo(
    () => buildValidationIssueNavigationItems(compileReport?.validation),
    [compileReport],
  );
  const activeIssueIndex = useMemo(
    () => issueNavigationItems.findIndex((item) => item.key === activeIssueKey),
    [activeIssueKey, issueNavigationItems],
  );
  const activeIssueItem = activeIssueIndex >= 0 ? issueNavigationItems[activeIssueIndex] ?? null : null;
  const visitedIssueKeySet = useMemo(() => new Set(visitedIssueKeys), [visitedIssueKeys]);

  const selectedNodeIssueSummary = selectedNode
    ? issueSummaries.nodeIssues.get(selectedNode.id) ?? null
    : null;

  const selectedEdgeIssueSummary = selectedEdge
    ? issueSummaries.edgeIssues.get(
      edgeKeyFor({
        source: selectedEdge.source,
        target: selectedEdge.target,
        branch: selectedEdge.data?.branch,
      }),
    ) ?? null
    : null;
  const controlPlaneHref = activeDraft ? `/workflows/${encodeURIComponent(activeDraft.workflowId)}?tab=deploy` : null;
  const deepLinkHref = activeDraft ? `/workflows/builder?${new URLSearchParams({
    ...(selectedTemplateId ? { templateId: selectedTemplateId } : {}),
    workflowId: activeDraft.workflowId,
    draftId: activeDraft.draftId,
    focus: "draft",
  }).toString()}` : null;

  const paletteGroups = useMemo(() => buildBuilderPaletteGroups({ query: paletteQuery }), [paletteQuery]);
  const collapsedPaletteGroupSet = useMemo(() => new Set(collapsedPaletteGroups), [collapsedPaletteGroups]);
  const visiblePaletteGroups = useMemo(() => {
    const revealMatches = paletteQuery.trim().length > 0;
    return paletteGroups.map((group) => ({
      ...group,
      collapsed: !revealMatches && collapsedPaletteGroupSet.has(group.id),
      visibleEntries: (!revealMatches && collapsedPaletteGroupSet.has(group.id)) ? [] : group.entries,
    }));
  }, [collapsedPaletteGroupSet, paletteGroups, paletteQuery]);
  const keyboardPaletteEntries = useMemo(
    () => visiblePaletteGroups.flatMap((group) => group.visibleEntries),
    [visiblePaletteGroups],
  );
  const selectTemplate = useCallback((templateId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("templateId", templateId);
    next.set("focus", "templates");
    setSearchParams(next, { replace: false });
  }, [searchParams, setSearchParams]);
  const keyboardPaletteEntry = keyboardPaletteIndex >= 0 ? keyboardPaletteEntries[keyboardPaletteIndex] ?? null : null;
  const compileIssueCounts = useMemo(() => {
    const issues = compileReport?.validation.issues ?? [];
    return {
      errors: issues.filter((issue) => issue.severity === "error").length,
      warnings: issues.filter((issue) => issue.severity === "warning").length,
    };
  }, [compileReport]);
  const activeNodeIssueTarget = activeIssueItem?.targetKind === "node" ? activeIssueItem.targetKey : null;
  const activeEdgeIssueTarget = activeIssueItem?.targetKind === "edge" ? activeIssueItem.targetKey : null;
  const visitedNodeIssueTargets = useMemo(() => (
    new Set(
      issueNavigationItems
        .filter((item) => item.targetKind === "node" && visitedIssueKeySet.has(item.key))
        .map((item) => item.targetKey),
    )
  ), [issueNavigationItems, visitedIssueKeySet]);
  const visitedEdgeIssueTargets = useMemo(() => (
    new Set(
      issueNavigationItems
        .filter((item) => item.targetKind === "edge" && visitedIssueKeySet.has(item.key))
        .map((item) => item.targetKey),
    )
  ), [issueNavigationItems, visitedIssueKeySet]);
  const dropTargetNodeId = dropFeedback?.tone === "valid" ? dropFeedback.targetNodeId : null;

  useEffect(() => {
    if (issueNavigationItems.length === 0) {
      setActiveIssueKey(null);
      setVisitedIssueKeys([]);
      return;
    }
    setActiveIssueKey((current) => issueNavigationItems.some((item) => item.key === current) ? current : issueNavigationItems[0]!.key);
    setVisitedIssueKeys((current) => current.filter((key) => issueNavigationItems.some((item) => item.key === key)));
  }, [issueNavigationItems]);

  useEffect(() => {
    setKeyboardPaletteIndex((current) => {
      if (keyboardPaletteEntries.length === 0) {
        return -1;
      }
      if (current < 0) {
        return current;
      }
      return Math.min(current, keyboardPaletteEntries.length - 1);
    });
  }, [keyboardPaletteEntries]);

  const compactCanvasMode = !deferredCanvasDetailReady;
  const shouldDecorateNodes = issueSummaries.nodeIssues.size > 0 || activeNodeIssueTarget !== null || visitedNodeIssueTargets.size > 0 || dropPreview !== null || dropTargetNodeId !== null;
  const canvasNodes = useMemo(() => {
      if (!shouldDecorateNodes) {
        return compactCanvasMode ? nodes.map(createCompactCanvasNode) : nodes;
      }
      const nextNodes: FlowNode[] = nodes.map((node) => {
        const summary = issueSummaries.nodeIssues.get(node.id);
        const nextUi = {
          issueTone: summary?.tone,
          issueCount: summary?.count,
          primaryIssueMessage: summary?.primaryIssueMessage,
          remainingCount: summary?.remainingCount,
          activeIssue: activeNodeIssueTarget === node.id,
          visitedIssue: visitedNodeIssueTargets.has(node.id),
          dropTarget: dropTargetNodeId === node.id,
        };
        const hasUiState = Object.values(nextUi).some((value) => value !== undefined && value !== false && value !== 0);
        return {
          ...node,
          data: {
            ...node.data,
            __ui: hasUiState ? nextUi : undefined,
          },
        };
      });

      if (dropPreview && activeDraft && !readonlyReason) {
        const previewConfig = getDefaultNodeConfig(dropPreview.type);
        const previewEntry = BUILDER_NODE_PALETTE.find((entry) => entry.type === dropPreview.type);
        nextNodes.push({
          id: `preview-${dropPreview.type}`,
          type: "workflow_node",
          position: dropPreview.position,
          draggable: false,
          selectable: false,
          connectable: false,
          focusable: false,
          data: {
            id: `preview-${dropPreview.type}`,
            type: dropPreview.type,
            name: `${previewEntry?.label ?? dropPreview.type} preview`,
            config: previewConfig,
            stepType: defaultStepTypeForNodeType(dropPreview.type),
            stepRef:
              "skillId" in previewConfig
                ? previewConfig.skillId
                : "toolId" in previewConfig
                  ? previewConfig.toolId
                  : undefined,
            rawArgs: {},
            __ui: {
              preview: true,
            },
          },
        });
      }

      return compactCanvasMode ? nextNodes.map(createCompactCanvasNode) : nextNodes;
    }, [activeDraft, activeNodeIssueTarget, compactCanvasMode, dropPreview, dropTargetNodeId, issueSummaries.nodeIssues, nodes, readonlyReason, shouldDecorateNodes, visitedNodeIssueTargets]);

  const shouldDecorateEdges = issueSummaries.edgeIssues.size > 0 || activeEdgeIssueTarget !== null || visitedEdgeIssueTargets.size > 0;
  const canvasEdges = useMemo(() => {
    if (!shouldDecorateEdges) {
      return compactCanvasMode ? edges.map(createCompactCanvasEdge) : edges;
    }
    const nextEdges = edges.map((edge) => {
      const edgeKey = edge.data?.edgeKey
          ?? edgeKeyFor({
            source: edge.source,
            target: edge.target,
            branch: edge.data?.branch,
          });
      const summary = issueSummaries.edgeIssues.get(edgeKey);
      const stroke = issueToneToEdgeStroke(summary?.tone, edge.selected);
      return {
        ...edge,
        type: "workflow_edge",
        data: {
          ...(edge.data ?? {}),
          edgeKey,
          issueTone: summary?.tone,
          issueCount: summary?.count,
          primaryIssueMessage: summary?.primaryIssueMessage,
          remainingCount: summary?.remainingCount,
          activeIssue: activeEdgeIssueTarget === edgeKey,
          visitedIssue: visitedEdgeIssueTargets.has(edgeKey),
        },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
        style: {
          stroke,
          strokeWidth: edge.selected ? 2.6 : summary?.tone ? 2.2 : 1.6,
        },
      } satisfies FlowEdge;
    });
    return compactCanvasMode ? nextEdges.map(createCompactCanvasEdge) : nextEdges;
  }, [activeEdgeIssueTarget, compactCanvasMode, edges, issueSummaries.edgeIssues, shouldDecorateEdges, visitedEdgeIssueTargets]);

  const groupedRegularTemplates = useMemo(() => ({
    builtin: regularTemplates.filter((item) => item.kind === "builtin"),
    skill: regularTemplates.filter((item) => item.kind === "skill"),
    user: regularTemplates.filter((item) => item.kind === "user"),
  }), [regularTemplates]);
  const stableTemplateSummaries = useMemo<WorkflowBuilderStableTemplateSummary[]>(
    () =>
      stableTemplates.map((template) => ({
        id: template.id,
        label: template.label,
        description: template.description,
        preferredBinding: template.preferredBinding,
      })),
    [stableTemplates],
  );
  const visiblePaletteGroupSummaries = useMemo<WorkflowBuilderPaletteGroupSummary[]>(
    () =>
      visiblePaletteGroups.map((group) => ({
        id: group.id,
        label: group.label,
        entries: group.entries.map((entry) => ({
          type: entry.type,
          label: entry.label,
          description: entry.description,
        })),
        visibleEntries: group.visibleEntries.map((entry) => ({
          type: entry.type,
          label: entry.label,
          description: entry.description,
        })),
        collapsed: group.collapsed,
      })),
    [visiblePaletteGroups],
  );

  useEffect(() => {
    if (!activeDraftFingerprint || latestDraftStageKeyRef.current === activeDraftFingerprint) {
      return;
    }
    if (typeof window !== "undefined" && typeof window.performance?.mark === "function") {
      window.performance.mark("friday-workflow-builder-draft-data-ready");
    }
    latestDraftStageKeyRef.current = activeDraftFingerprint;
  }, [activeDraftFingerprint]);

  useEffect(() => {
    if (!selectedTemplateId) {
      const firstTemplateId = stableTemplates[0]?.id ?? regularTemplates[0]?.templateId;
      if (!firstTemplateId) return;
      const next = new URLSearchParams(searchParams);
      next.set("templateId", firstTemplateId);
      next.set("focus", "templates");
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
      next.set("focus", "draft");
      setSearchParams(next, { replace: true });
    }
  }, [draftsQuery.data, requestedDraftId, requestedWorkflowId, searchParams, setSearchParams]);

  useEffect(() => {
    if (localDraftOverride && requestedDraftId && localDraftOverride.draftId !== requestedDraftId) {
      setLocalDraftOverride(null);
    }
  }, [localDraftOverride, requestedDraftId]);

  useLayoutEffect(() => {
    if (!activeDraft) {
      return;
    }
    const previouslyLoadedDraftId = loadedDraftKeyRef.current?.split(":")[0] ?? null;
    const isSameDraftEntity = previouslyLoadedDraftId === activeDraft.draftId;
    const fingerprint = `${activeDraft.draftId}:${activeDraft.revision}`;
    if (loadedDraftKeyRef.current === fingerprint) {
      return;
    }
    if (typeof window !== "undefined" && typeof window.performance?.mark === "function" && latestGraphTransformKeyRef.current !== fingerprint) {
      window.performance.mark("friday-workflow-builder-graph-transform-start");
    }
    const graph = draftToEditorGraph(activeDraft);
    if (typeof window !== "undefined" && typeof window.performance?.mark === "function" && latestGraphTransformKeyRef.current !== fingerprint) {
      window.performance.mark("friday-workflow-builder-graph-transformed");
      latestGraphTransformKeyRef.current = fingerprint;
    }
    const nextNodes = toFlowNodes(graph.nodes, graph.selectedNodeId ? [graph.selectedNodeId] : []);
    const nextEdges = toFlowEdges(graph.edges, graph.selectedEdgeId ? [graph.selectedEdgeId] : []);
    const nextViewport = graph.viewport ?? { x: 0, y: 0, zoom: 1 };

    setDraftTitle(activeDraft.title);
    setNodes(nextNodes);
    setEdges(nextEdges);
    setViewport(nextViewport);
    setSelectedNodeIds(graph.selectedNodeId ? [graph.selectedNodeId] : []);
    setSelectedEdgeIds(graph.selectedEdgeId ? [graph.selectedEdgeId] : []);
    setDirty(false);
    setReadonlyReason(null);
    pendingHydratedDraftRef.current = {
      fingerprint,
      resetCompileState: !isSameDraftEntity,
      snapshot: createSnapshot({
        nodes: nextNodes,
        edges: nextEdges,
        viewport: nextViewport,
        selectedNodeIds: graph.selectedNodeId ? [graph.selectedNodeId] : [],
        selectedEdgeIds: graph.selectedEdgeId ? [graph.selectedEdgeId] : [],
      }),
    };
    loadedDraftKeyRef.current = fingerprint;
  }, [activeDraft]);

  useEffect(() => {
    if (!activeDraftFingerprint) {
      pendingHydratedDraftRef.current = null;
      return;
    }

    const pending = pendingHydratedDraftRef.current;
    if (!pending || pending.fingerprint !== activeDraftFingerprint) {
      return;
    }

    historyRef.current = [pending.snapshot];
    historyIndexRef.current = 0;
    pendingHydratedDraftRef.current = null;

    if (pending.resetCompileState) {
      startTransition(() => {
        setCompileReport(null);
        setPublishedVersionNumber(null);
      });
    }
  }, [activeDraftFingerprint]);

  useEffect(() => {
    setJsonEditorText(JSON.stringify((selectedNode?.data.rawArgs ?? {}), null, 2));
  }, [selectedNode?.id]);

  useEffect(() => {
    if (!requestedWorkflowId || !resolvedDraftId || !user?.id) {
      setLockState(null);
      return;
    }

    let cancelled = false;
    let renewHandle: number | undefined;
    let acquiredLockToken: string | null = null;

    const acquire = async () => {
      try {
        const result = await workflowBuilderApi.acquireLock(requestedWorkflowId, {
          ownerUserId: user.id,
          ttlSec: 300,
        });
        if (cancelled) {
          return;
        }
        if (!result.acquired || !result.lock) {
          setLockState(null);
          setReadonlyReason("This draft is locked by another editor. You can inspect it, but autosave and publish stay disabled.");
          return;
        }
        acquiredLockToken = result.lock.lockToken;
        setLockState(result.lock);
        setReadonlyReason(null);
        renewHandle = window.setInterval(async () => {
          try {
            const renewed = await workflowBuilderApi.renewLock(requestedWorkflowId, {
              lockToken: acquiredLockToken!,
              ttlSec: 300,
            });
            if (!cancelled) {
              acquiredLockToken = renewed.lock.lockToken;
              setLockState(renewed.lock);
            }
          } catch {
            if (!cancelled) {
              setReadonlyReason("Friday lost the edit lock. The canvas is now read-only until you reopen the draft.");
              setLockState(null);
            }
          }
        }, 120_000);
      } catch (error) {
        if (!cancelled) {
          setReadonlyReason(error instanceof Error ? error.message : "Could not acquire a workflow edit lock.");
          setLockState(null);
        }
      }
    };

    void acquire();

    return () => {
      cancelled = true;
      if (renewHandle) {
        window.clearInterval(renewHandle);
      }
      if (acquiredLockToken) {
        void workflowBuilderApi.releaseLock(requestedWorkflowId, {
          lockToken: acquiredLockToken,
        }).catch(() => undefined);
      }
    };
  }, [requestedWorkflowId, resolvedDraftId, user?.id]);

  const snapshotFromCurrent = useCallback(() =>
    createSnapshot({
      nodes,
      edges,
      viewport,
      selectedNodeIds,
      selectedEdgeIds,
    }), [edges, nodes, selectedEdgeIds, selectedNodeIds, viewport]);

  const pushHistory = useCallback((snapshot?: EditorSnapshot) => {
    const nextSnapshot = snapshot ?? snapshotFromCurrent();
    const previous = historyRef.current[historyIndexRef.current];
    if (previous && snapshotSignature(previous) === snapshotSignature(nextSnapshot)) {
      return;
    }
    historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1);
    historyRef.current.push(cloneSnapshot(nextSnapshot));
    historyIndexRef.current = historyRef.current.length - 1;
  }, [snapshotFromCurrent]);

  const restoreSnapshot = (snapshot: EditorSnapshot) => {
    setNodes(snapshot.nodes);
    setEdges(snapshot.edges);
    setViewport(snapshot.viewport);
    syncViewportToCanvas(snapshot.viewport);
    setSelectedNodeIds(snapshot.selectedNodeIds);
    setSelectedEdgeIds(snapshot.selectedEdgeIds);
  };

  const updateGraph = useCallback((input: {
    nodes?: FlowNode[];
    edges?: FlowEdge[];
    viewport?: Viewport;
    selectedNodeIds?: string[];
    selectedEdgeIds?: string[];
    pushHistory?: boolean;
    dirty?: boolean;
  }) => {
    const nextSelectedNodeIds = input.selectedNodeIds ?? selectedNodeIds;
    const nextSelectedEdgeIds = input.selectedEdgeIds ?? selectedEdgeIds;
    const nextNodes = syncNodeSelection(input.nodes ?? nodes, nextSelectedNodeIds);
    const nextEdges = syncEdgeSelection(input.edges ?? edges, nextSelectedEdgeIds);
    const nextViewport = input.viewport ?? viewport;
    setNodes(nextNodes);
    setEdges(nextEdges);
    setViewport(nextViewport);
    if (input.viewport) {
      syncViewportToCanvas(nextViewport);
    }
    setSelectedNodeIds(nextSelectedNodeIds);
    setSelectedEdgeIds(nextSelectedEdgeIds);
    if (input.dirty ?? true) {
      setDirty(true);
    }
    if (input.pushHistory) {
      pushHistory(createSnapshot({
        nodes: nextNodes,
        edges: nextEdges,
        viewport: nextViewport,
        selectedNodeIds: nextSelectedNodeIds,
        selectedEdgeIds: nextSelectedEdgeIds,
      }));
    }
  }, [edges, nodes, pushHistory, selectedEdgeIds, selectedNodeIds, viewport]);

  const persistDraft = async (mode: "save" | "autosave"): Promise<FridayWorkflowDraftEntity | null> => {
    if (!requestedWorkflowId || !activeDraft || !lockState?.lockToken) {
      throw new Error("A locked draft is required before Friday can save changes.");
    }
    const editorGraph = flowToEditorGraph({
      nodes,
      edges,
      viewport,
      selectedNodeIds,
      selectedEdgeIds,
    });
    const bundle = editorGraphToDraftBundle(editorGraph, activeDraft);
    if (mode === "autosave") {
      const result = await workflowBuilderApi.autosaveDraft(requestedWorkflowId, activeDraft.draftId, {
        lockToken: lockState.lockToken,
        spec: bundle.spec,
        visual: bundle.visual,
      });
      if (result.draft) {
        setLocalDraftOverride(result.draft);
      }
      lastAutosaveAtRef.current = new Date().toISOString();
      setDirty(false);
      return result.draft;
    }

    const result = await workflowBuilderApi.saveDraft(requestedWorkflowId, activeDraft.draftId, {
      expectedRevision: activeDraft.revision,
      lockToken: lockState.lockToken,
      title: draftTitle.trim() || activeDraft.title,
      spec: bundle.spec,
      visual: bundle.visual,
    });
    setLocalDraftOverride(result.draft);
      lastManualSaveAtRef.current = new Date().toISOString();
      setDirty(false);
      return result.draft;
  };

  useEffect(() => {
    if (!requestedWorkflowId || !activeDraft || !lockState?.lockToken || readonlyReason || !dirty) {
      return;
    }
    const handle = window.setTimeout(() => {
      void persistDraft("autosave").catch(() => undefined);
    }, 12_000);
    return () => {
      window.clearTimeout(handle);
    };
  }, [activeDraft, dirty, edges, lockState?.lockToken, nodes, readonlyReason, requestedWorkflowId, selectedEdgeIds, selectedNodeIds, viewport]);

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (isTextInputTarget(event.target)) {
        return;
      }
      const metaKey = event.metaKey || event.ctrlKey;
      if (metaKey && event.key.toLowerCase() === "c") {
        const selectedNodeSet = new Set(selectedNodeIds);
        if (selectedNodeSet.size === 0) return;
        clipboardRef.current = createSnapshot({
          nodes: nodes.filter((node) => selectedNodeSet.has(node.id)),
          edges: edges.filter((edge) => selectedNodeSet.has(edge.source) && selectedNodeSet.has(edge.target)),
          viewport,
          selectedNodeIds,
          selectedEdgeIds,
        });
        event.preventDefault();
      }
      if (metaKey && event.key.toLowerCase() === "v" && clipboardRef.current) {
        const seed = clipboardRef.current;
        const idMap = new Map<string, string>();
        const duplicatedNodes = seed.nodes.map((node) => {
          const nextId = `${node.data.type}-${Math.random().toString(36).slice(2, 8)}`;
          idMap.set(node.id, nextId);
          return {
            ...node,
            id: nextId,
            position: { x: node.position.x + 96, y: node.position.y + 64 },
            selected: true,
            data: {
              ...node.data,
              id: nextId,
              name: `${node.data.name} copy`,
            },
          };
        });
        const duplicatedEdges = seed.edges.map((edge) => ({
          ...edge,
          id: `e-${Math.random().toString(36).slice(2, 8)}`,
          source: idMap.get(edge.source) ?? edge.source,
          target: idMap.get(edge.target) ?? edge.target,
          selected: true,
          data: {
            ...edge.data,
            edgeKey: edgeKeyFor({
              source: idMap.get(edge.source) ?? edge.source,
              target: idMap.get(edge.target) ?? edge.target,
              branch: edge.data?.branch,
            }),
          },
        }));
        const nextNodes = [
          ...nodes.map((node) => ({ ...node, selected: false })),
          ...duplicatedNodes,
        ];
        const nextEdges = [
          ...edges.map((edge) => ({ ...edge, selected: false })),
          ...duplicatedEdges,
        ];
        updateGraph({
          nodes: nextNodes,
          edges: nextEdges,
          selectedNodeIds: duplicatedNodes.map((node) => node.id),
          selectedEdgeIds: duplicatedEdges.map((edge) => edge.id),
          pushHistory: true,
        });
        event.preventDefault();
      }
      if (metaKey && event.key.toLowerCase() === "z") {
        const nextIndex = historyIndexRef.current - 1;
        if (nextIndex < 0) return;
        historyIndexRef.current = nextIndex;
        restoreSnapshot(cloneSnapshot(historyRef.current[nextIndex]!));
        event.preventDefault();
      }
      if (metaKey && (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z"))) {
        const nextIndex = historyIndexRef.current + 1;
        if (nextIndex >= historyRef.current.length) return;
        historyIndexRef.current = nextIndex;
        restoreSnapshot(cloneSnapshot(historyRef.current[nextIndex]!));
        event.preventDefault();
      }
      if ((event.key === "Delete" || event.key === "Backspace") && (selectedNodeIds.length > 0 || selectedEdgeIds.length > 0)) {
        removeSelection();
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", handle);
    return () => {
      window.removeEventListener("keydown", handle);
    };
  }, [edges, nodes, selectedEdgeIds, selectedNodeIds, viewport]);

  useEffect(() => {
    if (!activeDraft || readonlyReason) {
      setDraggingPaletteType(null);
      setDropPreview(null);
      setDropFeedback(null);
    }
  }, [activeDraft, readonlyReason]);

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
      setLocalDraftOverride(draft);
      toast.success("Template instantiated into a draft.");
      const next = new URLSearchParams();
      if (selectedTemplateId) next.set("templateId", selectedTemplateId);
      next.set("workflowId", workflowId);
      next.set("draftId", draft.draftId);
      next.set("focus", "draft");
      setSearchParams(next, { replace: false });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workflow-builder", "drafts", workflowId] }),
        queryClient.invalidateQueries({ queryKey: ["workflow-builder", "draft", workflowId, draft.draftId] }),
        queryClient.invalidateQueries({ queryKey: ["workflow-builder", "workflows"] }),
      ]);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not instantiate the template");
    },
  });

  const createBlankDraftMutation = useMutation({
    mutationFn: async () => {
      const effectiveTitle = title.trim() || "Workflow draft";
      let workflowId = targetWorkflowId !== "new" ? targetWorkflowId : "";
      if (!workflowId) {
        const created = await workflowsApi.create({
          slug: slugify(`${effectiveTitle}-${Date.now()}`),
          name: effectiveTitle,
          description: "Blank workflow draft created from the visual builder.",
          tags: ["builder", "blank"],
          graph: createDefaultRawGraph(),
        });
        workflowId = created.workflow.id;
      }
      const bundle = createBlankDraftPayload(workflowId, effectiveTitle);
      const result = await workflowBuilderApi.createDraft(workflowId, {
        title: effectiveTitle,
        spec: bundle.spec,
        visual: bundle.visual,
      });
      return { workflowId, draft: result.draft };
    },
    onSuccess: async ({ workflowId, draft }) => {
      setLocalDraftOverride(draft);
      toast.success("Blank draft created.");
      const next = new URLSearchParams(searchParams);
      next.set("workflowId", workflowId);
      next.set("draftId", draft.draftId);
      next.set("focus", "draft");
      setSearchParams(next, { replace: false });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workflow-builder", "drafts", workflowId] }),
        queryClient.invalidateQueries({ queryKey: ["workflow-builder", "draft", workflowId, draft.draftId] }),
        queryClient.invalidateQueries({ queryKey: ["workflow-builder", "workflows"] }),
      ]);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not create a blank draft");
    },
  });

  const saveMutation = useMutation({
    mutationFn: () => persistDraft("save"),
    onSuccess: async (draft) => {
      if (draft) {
        await queryClient.invalidateQueries({ queryKey: ["workflow-builder", "draft", draft.workflowId, draft.draftId] });
      }
      toast.success("Draft saved.");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not save the draft");
    },
  });

  const compileMutation = useMutation({
    mutationFn: async () => {
      const persisted = await persistDraft("save");
      if (!requestedWorkflowId || !persisted) {
        throw new Error("Draft save failed before compile.");
      }
      return workflowBuilderApi.compileDraft(requestedWorkflowId, persisted.draftId);
    },
    onSuccess: (result) => {
      setCompileReport({
        validation: result.validation,
        nodes: result.compiled.graph.nodes.length,
        edges: result.compiled.graph.edges.length,
      });
      toast.success(result.validation.valid ? "Draft compiled successfully." : "Draft compiled with validation issues.");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Draft compile failed");
    },
  });

  const publishMutation = useMutation({
    mutationFn: async () => {
      if (!requestedWorkflowId || !activeDraft || !lockState?.lockToken || !user?.id) {
        throw new Error("Workflow, draft, user, and edit lock are required before publish.");
      }
      const persisted = await persistDraft("save");
      if (!persisted) {
        throw new Error("Draft save failed before publish.");
      }
      const compiled = await workflowBuilderApi.compileDraft(requestedWorkflowId, persisted.draftId);
      setCompileReport({
        validation: compiled.validation,
        nodes: compiled.compiled.graph.nodes.length,
        edges: compiled.compiled.graph.edges.length,
      });
      if (!compiled.validation.valid) {
        throw new Error("Draft compile reported validation errors. Fix them before publish.");
      }
      return workflowBuilderApi.publishDraft(requestedWorkflowId, persisted.draftId, {
        workflowId: requestedWorkflowId,
        lockToken: lockState.lockToken,
        createdByUserId: user.id,
        changeNote,
        publishNow: true,
      });
    },
    onSuccess: async (result) => {
      setPublishedVersionNumber(result.versionNumber);
      toast.success(`Draft published as v${result.versionNumber}.`);
      const next = new URLSearchParams(searchParams);
      next.set("focus", "publish");
      setSearchParams(next, { replace: false });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workflow-builder", "drafts", requestedWorkflowId] }),
        queryClient.invalidateQueries({ queryKey: ["workflow-builder", "workflows"] }),
      ]);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Draft publish failed");
    },
  });

  const applyTaskProfileToNodes = (profileId: AgentTaskProfileId) => {
    const nextNodes = nodes.map((node) => {
      if (node.data.type === "trigger") {
        return node;
      }
      return {
        ...node,
        data: {
          ...node.data,
          rawArgs: {
            ...(node.data.rawArgs ?? {}),
            taskProfile: profileId,
          },
        },
      };
    });
    updateGraph({ nodes: nextNodes, pushHistory: true });
  };

  const addNode = (type: WorkflowNodeType, position?: { x: number; y: number }) => {
    if (!activeDraft) {
      toast.error("Create or open a draft before adding nodes to the canvas.");
      return;
    }
    if (readonlyReason) {
      toast.error(readonlyReason);
      return;
    }
    const nodeId = `${type}-${Math.random().toString(36).slice(2, 8)}`;
    const existingNames = nodes.map((node) => node.data.name);
    const config = getDefaultNodeConfig(type);
    const nextNode: FlowNode = {
      id: nodeId,
      type: "workflow_node",
      position: position ?? {
        x: 160 + nodes.length * 56,
        y: 140 + (nodes.length % 4) * 82,
      },
      selected: true,
      data: {
        id: nodeId,
        type,
        name: getNextNodeName(type, existingNames),
        config,
        stepType: defaultStepTypeForNodeType(type),
        stepRef:
          "skillId" in config
            ? config.skillId
            : "toolId" in config
              ? config.toolId
              : undefined,
        rawArgs: {},
      },
    };
    const nextNodes = [
      ...nodes.map((node) => ({ ...node, selected: false })),
      nextNode,
    ];
    updateGraph({
      nodes: nextNodes,
      selectedNodeIds: [nodeId],
      selectedEdgeIds: [],
      pushHistory: true,
    });
  };

  const togglePaletteGroup = (groupId: BuilderPaletteGroupId) => {
    setCollapsedPaletteGroups((current) => (
      current.includes(groupId)
        ? current.filter((candidate) => candidate !== groupId)
        : [...current, groupId]
    ));
  };

  const handlePaletteSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (keyboardPaletteEntries.length === 0) {
      if (event.key === "Escape" && paletteQuery.length > 0) {
        setPaletteQuery("");
        setKeyboardPaletteIndex(-1);
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setKeyboardPaletteIndex((current) => {
        if (current < 0) return 0;
        return (current + 1) % keyboardPaletteEntries.length;
      });
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setKeyboardPaletteIndex((current) => {
        if (current < 0) return keyboardPaletteEntries.length - 1;
        return (current - 1 + keyboardPaletteEntries.length) % keyboardPaletteEntries.length;
      });
      return;
    }

    if (event.key === "Enter") {
      const nextEntry = keyboardPaletteEntry ?? keyboardPaletteEntries[0];
      if (!nextEntry) return;
      event.preventDefault();
      addNode(nextEntry.type);
      setKeyboardPaletteIndex(keyboardPaletteEntries.findIndex((entry) => entry.type === nextEntry.type));
      return;
    }

    if (event.key === "Escape") {
      if (paletteQuery.length > 0) {
        event.preventDefault();
        setPaletteQuery("");
      }
      setKeyboardPaletteIndex(-1);
    }
  };

  const handlePaletteDragStart = (event: ReactDragEvent<HTMLButtonElement>, type: WorkflowNodeType) => {
    if (!activeDraft || readonlyReason) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(NODE_LIBRARY_DND_MIME, type);
    event.dataTransfer.setData("text/plain", type);
    event.dataTransfer.effectAllowed = "move";
    setDraggingPaletteType(type as Exclude<WorkflowNodeType, "trigger">);
    setKeyboardPaletteIndex(BUILDER_NODE_PALETTE.findIndex((entry) => entry.type === type));
    if (typeof document !== "undefined") {
      const paletteEntry = describePaletteEntry(type as Exclude<WorkflowNodeType, "trigger">);
      const ghost = document.createElement("div");
      ghost.style.position = "absolute";
      ghost.style.top = "-9999px";
      ghost.style.left = "-9999px";
      ghost.style.padding = "10px 14px";
      ghost.style.borderRadius = "18px";
      ghost.style.border = "1px solid rgba(167, 243, 208, 0.45)";
      ghost.style.background = "rgba(2, 6, 23, 0.95)";
      ghost.style.color = "white";
      ghost.style.fontSize = "12px";
      ghost.style.fontWeight = "600";
      ghost.style.letterSpacing = "0.08em";
      ghost.style.textTransform = "uppercase";
      ghost.style.boxShadow = "0 16px 40px rgba(0,0,0,0.3)";
      ghost.innerHTML = `
        <div style="opacity:0.58;font-size:10px;margin-bottom:4px;">${paletteEntry?.groupLabel ?? "Workflow node"}</div>
        <div>${paletteEntry?.label ?? type}</div>
      `;
      document.body.appendChild(ghost);
      event.dataTransfer.setDragImage(ghost, 24, 18);
      window.setTimeout(() => {
        ghost.remove();
      }, 0);
    }
  };

  const handlePaletteDragEnd = () => {
    setDraggingPaletteType(null);
    setDropPreview(null);
    setDropFeedback(null);
  };

  const handleCanvasDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(NODE_LIBRARY_DND_MIME)) {
      return;
    }
    event.preventDefault();
    const dragType = draggingPaletteType
      ?? (event.dataTransfer.getData(NODE_LIBRARY_DND_MIME) as Exclude<WorkflowNodeType, "trigger">);
    const canDrop = Boolean(activeDraft) && !readonlyReason && dragType.length > 0;
    event.dataTransfer.dropEffect = canDrop ? "move" : "none";
    const paletteEntry = describePaletteEntry(dragType);
    if (!canDrop) {
      setDropPreview(null);
      setDropFeedback({
        tone: "invalid",
        type: dragType,
        message: !activeDraft
          ? `Open a draft before dropping ${paletteEntry?.label ?? dragType}.`
          : readonlyReason ?? `This draft is read-only. ${paletteEntry?.label ?? dragType} cannot be dropped.`,
        targetNodeId: null,
      });
      return;
    }
    const snappedPosition = snapFlowPositionToGrid(
      reactFlow.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      }),
      { gridSize: CANVAS_GRID_SIZE },
    );
    const targetNodeId = findClosestDropTargetNodeId(
      nodes
        .filter((node) => node.data.type !== "trigger")
        .map((node) => ({
          id: node.id,
          position: node.position,
          width: node.width,
          height: node.height,
        })),
      snappedPosition,
    );
    setDropPreview({
      type: dragType,
      position: snappedPosition,
    });
    const targetNode = targetNodeId
      ? nodes.find((node) => node.id === targetNodeId) ?? null
      : null;
    setDropFeedback({
      tone: "valid",
      type: dragType,
      message: targetNode
        ? `Drop ${paletteEntry?.label ?? dragType} near ${targetNode.data.name} · snap ${Math.round(snappedPosition.x)}, ${Math.round(snappedPosition.y)}`
        : `Drop ${paletteEntry?.label ?? dragType} on canvas · snap ${Math.round(snappedPosition.x)}, ${Math.round(snappedPosition.y)}`,
      targetNodeId,
    });
  };

  const handleCanvasDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(NODE_LIBRARY_DND_MIME)) {
      return;
    }
    event.preventDefault();
    setDraggingPaletteType(null);
    if (!activeDraft) {
      setDropFeedback(null);
      toast.error("Create or open a draft before dropping nodes onto the canvas.");
      return;
    }
    if (readonlyReason) {
      setDropFeedback(null);
      toast.error(readonlyReason);
      return;
    }
    const droppedType = draggingPaletteType
      ?? (event.dataTransfer.getData(NODE_LIBRARY_DND_MIME) as Exclude<WorkflowNodeType, "trigger">);
    if (!droppedType) {
      setDropPreview(null);
      setDropFeedback(null);
      return;
    }
    const nextPosition = dropPreview?.type === droppedType
      ? dropPreview.position
      : snapFlowPositionToGrid(
          reactFlow.screenToFlowPosition({
            x: event.clientX,
            y: event.clientY,
          }),
          { gridSize: CANVAS_GRID_SIZE },
        );
    setDropPreview(null);
    setDropFeedback(null);
    addNode(droppedType, nextPosition);
  };

  const markIssueVisited = (issueKey: string | null) => {
    if (!issueKey) return;
    setVisitedIssueKeys((current) => current.includes(issueKey) ? current : [...current, issueKey]);
  };

  const syncActiveIssueToTarget = (targetKind: BuilderValidationIssueNavigationItem["targetKind"], targetKey: string) => {
    const nextIssue = issueNavigationItems.find((item) => item.targetKind === targetKind && item.targetKey === targetKey) ?? null;
    setActiveIssueKey(nextIssue?.key ?? null);
  };

  const focusValidationIssue = useCallback((issue: FridayWorkflowBuilderValidationReport["issues"][number]) => {
    const issueItem = issueNavigationItems.find((item) => item.issue === issue) ?? null;
    setActiveIssueKey(issueItem?.key ?? null);
    markIssueVisited(issueItem?.key ?? null);
    if (issue.stepId) {
      const node = nodes.find((candidate) => candidate.id === issue.stepId);
      if (node) {
        updateGraph({
          selectedNodeIds: [node.id],
          selectedEdgeIds: [],
          dirty: false,
        });
        void reactFlow.setCenter(
          node.position.x + ((node.width ?? 240) / 2),
          node.position.y + ((node.height ?? 124) / 2),
          {
            zoom: Math.max(viewport.zoom, 0.9),
            duration: 260,
          },
        );
        return;
      }
    }
    if (issue.edgeRef) {
      const edge = edges.find((candidate) => (
        edgeKeyFor({
          source: candidate.source,
          target: candidate.target,
          branch: candidate.data?.branch,
        }) === edgeKeyFor({
          source: issue.edgeRef!.from,
          target: issue.edgeRef!.to,
          branch: issue.edgeRef!.when,
        })
      ));
      if (edge) {
        updateGraph({
          selectedNodeIds: [],
          selectedEdgeIds: [edge.id],
          dirty: false,
        });
        const sourceNode = nodes.find((candidate) => candidate.id === edge.source);
        const targetNode = nodes.find((candidate) => candidate.id === edge.target);
        if (sourceNode && targetNode) {
          void reactFlow.setCenter(
            (sourceNode.position.x + targetNode.position.x) / 2 + 120,
            (sourceNode.position.y + targetNode.position.y) / 2 + 60,
            {
              zoom: Math.max(viewport.zoom, 0.85),
              duration: 260,
            },
          );
        }
      }
    }
  }, [edges, issueNavigationItems, nodes, reactFlow, updateGraph, viewport.zoom]);

  const focusNodeIssue = useCallback((nodeId: string) => {
    const issue = issueSummaries.nodeIssues.get(nodeId)?.issues[0];
    if (issue) {
      focusValidationIssue(issue);
    }
  }, [focusValidationIssue, issueSummaries.nodeIssues]);

  const focusEdgeIssue = useCallback((key: string) => {
    const issue = issueSummaries.edgeIssues.get(key)?.issues[0];
    if (issue) {
      focusValidationIssue(issue);
    }
  }, [focusValidationIssue, issueSummaries.edgeIssues]);

  const clearSelection = () => {
    updateGraph({
      selectedNodeIds: [],
      selectedEdgeIds: [],
      dirty: false,
    });
    setActiveIssueKey(null);
  };

  const navigateIssue = (direction: "next" | "previous") => {
    if (issueNavigationItems.length === 0) {
      return;
    }
    const nextIndex = activeIssueIndex >= 0
      ? direction === "next"
        ? (activeIssueIndex + 1) % issueNavigationItems.length
        : (activeIssueIndex - 1 + issueNavigationItems.length) % issueNavigationItems.length
      : 0;
    focusValidationIssue(issueNavigationItems[nextIndex]!.issue);
  };

  const removeSelection = () => {
    if (selectedNodeIds.length === 0 && selectedEdgeIds.length === 0) {
      return;
    }
    const selectedNodeSet = new Set(selectedNodeIds);
    const selectedEdgeSet = new Set(selectedEdgeIds);
    const nextNodes = nodes.filter((node) => !selectedNodeSet.has(node.id));
    const nextEdges = edges.filter((edge) =>
      !selectedEdgeSet.has(edge.id)
      && !selectedNodeSet.has(edge.source)
      && !selectedNodeSet.has(edge.target),
    );
    updateGraph({
      nodes: nextNodes,
      edges: nextEdges,
      selectedNodeIds: [],
      selectedEdgeIds: [],
      pushHistory: true,
    });
  };

  const applyJsonEditor = () => {
    if (!selectedNode) return;
    try {
      const parsed = JSON.parse(jsonEditorText) as Record<string, unknown>;
      const nextNodes = nodes.map((node) =>
        node.id === selectedNode.id
          ? {
              ...node,
              data: {
                ...node.data,
                rawArgs: parsed,
              },
            }
          : node);
      updateGraph({ nodes: nextNodes, pushHistory: true });
    } catch {
      toast.error("Args JSON must be valid JSON before Friday can save it.");
    }
  };

  const updateSelectedNode = (patch: Partial<FridayWorkflowNodeDefinition>) => {
    if (!selectedNode) return;
    const nextNodes = nodes.map((node) =>
      node.id === selectedNode.id
        ? {
            ...node,
            data: {
              ...node.data,
              ...patch,
            },
          }
        : node);
    updateGraph({ nodes: nextNodes, pushHistory: true });
  };

  const updateSelectedNodeConfig = (configPatch: Partial<FridayWorkflowNodeConfig>) => {
    if (!selectedNode) return;
    updateSelectedNode({
      config: {
        ...(selectedNode.data.config as Record<string, unknown>),
        ...configPatch,
      } as FridayWorkflowNodeConfig,
    });
  };

  const handleSelectedNodeTypeChange = (nextType: WorkflowNodeType) => {
    if (!selectedNode) return;
    const nextDefinition = buildReplacementNodeDefinition({
      node: selectedNode.data,
      nextType,
    });
    updateSelectedNode(nextDefinition);
  };

  const handleSelectedStepTypeChange = (nextStepType: FridayWorkflowNodeDefinition["stepType"]) => {
    if (!selectedNode || !nextStepType) return;
    const nextType = defaultNodeTypeForStepType(nextStepType);
    const nextDefinition = buildReplacementNodeDefinition({
      node: selectedNode.data,
      nextType,
      nextStepType,
    });
    updateSelectedNode(nextDefinition);
  };

  const updateSelectedEdgeBranch = (branch: "" | FridayWorkflowSpecEdgeWhen) => {
    if (!selectedEdge) return;
    const nextEdges = edges.map((edge) =>
      edge.id === selectedEdge.id
        ? {
            ...edge,
            data: {
              ...(edge.data ?? {}),
              branch: branch || undefined,
              edgeKey: edgeKeyFor({ source: edge.source, target: edge.target, branch: branch || undefined }),
            },
          }
        : edge);
    updateGraph({ edges: nextEdges, pushHistory: true });
  };

  const handleNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    const nextNodes = applyNodeChanges(changes, nodes);
    const changedSelection = changes.some((change) => change.type === "select");
    const structuralChange = changes.some((change) => change.type !== "select");
    setNodes(nextNodes);
    if (changedSelection) {
      const nextSelectedNodeIds = nextNodes.filter((node) => node.selected).map((node) => node.id);
      setSelectedNodeIds((current) => sameIdList(current, nextSelectedNodeIds) ? current : nextSelectedNodeIds);
    }
    if (structuralChange) {
      setDirty(true);
    }
  }, [nodes]);

  const handleEdgesChange = useCallback((changes: EdgeChange<FlowEdge>[]) => {
    const nextEdges = applyEdgeChanges(changes, edges);
    const changedSelection = changes.some((change) => change.type === "select");
    const structuralChange = changes.some((change) => change.type !== "select");
    setEdges(nextEdges);
    if (changedSelection) {
      const nextSelectedEdgeIds = nextEdges.filter((edge) => edge.selected).map((edge) => edge.id);
      setSelectedEdgeIds((current) => sameIdList(current, nextSelectedEdgeIds) ? current : nextSelectedEdgeIds);
    }
    if (structuralChange) {
      setDirty(true);
    }
  }, [edges]);

  const handleConnect = useCallback((connection: Connection) => {
    const branch = branchFromHandle(connection.sourceHandle);
    const nextEdge = {
      id: `e-${Math.random().toString(36).slice(2, 8)}`,
      source: connection.source ?? "",
      target: connection.target ?? "",
      sourceHandle: connection.sourceHandle ?? undefined,
      targetHandle: connection.targetHandle ?? undefined,
      data: {
        branch,
        edgeKey: edgeKeyFor({
          source: connection.source ?? "",
          target: connection.target ?? "",
          branch,
        }),
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: "rgba(236, 245, 255, 0.8)" },
      style: { stroke: "rgba(236, 245, 255, 0.65)", strokeWidth: 1.6 },
    } satisfies FlowEdge;
    const nextEdges = [...edges, nextEdge];
    updateGraph({
      edges: nextEdges,
      selectedEdgeIds: [nextEdge.id],
      selectedNodeIds: [],
      pushHistory: true,
    });
  }, [edges, updateGraph]);

  const handleNodeDragStop = useCallback(() => {
    pushHistory();
  }, [pushHistory]);

  const handleMoveEnd = useCallback((_: unknown, nextViewport: Viewport) => {
    setViewport(nextViewport);
  }, []);

  const handleAutoLayout = () => {
    const nextNodes = applyDagreLayout({ nodes, edges });
    updateGraph({ nodes: nextNodes, pushHistory: true });
  };

  const canvasInteractionValue = useMemo<WorkflowCanvasInteractionContextValue>(() => ({
    focusNodeIssue,
    focusEdgeIssue,
    compactMode: compactCanvasMode,
  }), [compactCanvasMode, focusEdgeIssue, focusNodeIssue]);

  useEffect(() => {
    if (!activeDraftFingerprint) {
      setReactFlowMounted(false);
      return;
    }
    setReactFlowMounted(false);
    latestReactFlowMountKeyRef.current = null;
    latestInteractiveCanvasKeyRef.current = null;
  }, [activeDraftFingerprint]);

  useEffect(() => {
    if (!activeDraftFingerprint || !reactFlowMounted || !isDraftHydrated || latestInteractiveCanvasKeyRef.current === activeDraftFingerprint) {
      return;
    }
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function" || typeof window.performance?.mark !== "function") {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      window.performance.mark("friday-workflow-builder-first-interactive-canvas");
      latestInteractiveCanvasKeyRef.current = activeDraftFingerprint;
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [activeDraftFingerprint, isDraftHydrated, reactFlowMounted]);

  return (
    <div className="grid gap-4 xl:grid-cols-[0.82fr_1.18fr_0.94fr]">
      {deferredSidebarReady ? (
        <Suspense fallback={<WorkflowBuilderLeftSidebarFallback />}>
          <WorkflowBuilderLeftSidebar
            deferredSidebarReady={deferredSidebarReady}
            catalogQueriesEnabled={catalogQueriesEnabled}
            title={title}
            onTitleChange={setTitle}
            targetWorkflowId={targetWorkflowId}
            onTargetWorkflowChange={setTargetWorkflowId}
            workflows={(workflowsQuery.data?.items ?? []).map((workflow) => ({ id: workflow.id, name: workflow.name }))}
            selectedTaskProfileId={selectedTaskProfileId}
            onTaskProfileChange={(nextProfile) => {
              setSelectedTaskProfileId(nextProfile);
              if (activeDraft) {
                applyTaskProfileToNodes(nextProfile);
              }
            }}
            taskProfileOptions={TASK_PROFILE_OPTIONS}
            selectedTemplateId={selectedTemplateId}
            instantiatePending={instantiateMutation.isPending}
            onInstantiate={() => instantiateMutation.mutate()}
            createBlankPending={createBlankDraftMutation.isPending}
            onCreateBlank={() => createBlankDraftMutation.mutate()}
            bindingTitle={selectedStableTemplate?.label ?? selectedTemplate?.name ?? null}
            bindingDescription={selectedStableTemplate?.description ?? selectedTemplate?.description ?? null}
            bindingLabel={integrationMode.label}
            bindingReason={integrationMode.reason}
            bindingTags={selectedStableTemplate?.tags ?? selectedTemplate?.tags ?? []}
            stableTemplates={stableTemplateSummaries}
            onSelectStableTemplate={(templateId) => {
              const next = new URLSearchParams(searchParams);
              next.set("templateId", templateId);
              next.set("focus", "templates");
              setSearchParams(next, { replace: false });
            }}
            paletteQuery={paletteQuery}
            onPaletteQueryChange={setPaletteQuery}
            onPaletteSearchKeyDown={handlePaletteSearchKeyDown}
            visiblePaletteGroups={visiblePaletteGroupSummaries}
            keyboardPaletteActiveType={keyboardPaletteEntry?.type ?? null}
            onTogglePaletteGroup={(groupId) => togglePaletteGroup(groupId as BuilderPaletteGroupId)}
            activeDraft={Boolean(activeDraft)}
            readonly={Boolean(readonlyReason)}
            draggingPaletteType={draggingPaletteType}
            onPaletteDragStart={handlePaletteDragStart}
            onPaletteDragEnd={handlePaletteDragEnd}
            onPaletteEntryHover={(type) => {
              const nextIndex = keyboardPaletteEntries.findIndex((candidate) => candidate.type === type);
              setKeyboardPaletteIndex(nextIndex);
            }}
            onPaletteEntryClick={addNode}
          />
        </Suspense>
      ) : (
        <WorkflowBuilderLeftSidebarFallback />
      )}

      <ShellCard
        eyebrow="Visual Builder"
        title={draftTitle || activeDraft?.title || "Open a draft to begin editing"}
        aside={
          <div className="flex items-center gap-2">
            <StatusPill tone={readonlyReason ? "danger" : dirty ? "warning" : "success"}>
              {readonlyReason ? "read-only" : dirty ? "unsaved" : "synced"}
            </StatusPill>
            {lockState ? (
              <StatusPill tone="success">
                <Lock className="mr-1 h-3 w-3" />
                lock
              </StatusPill>
            ) : null}
          </div>
        }
        className="min-h-[840px]"
      >
        {activeDraft ? isDraftHydrated ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <ActionButton tone="secondary" disabled={saveMutation.isPending || !!readonlyReason} onClick={() => saveMutation.mutate()}>
                {saveMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Save
              </ActionButton>
              <ActionButton tone="secondary" onClick={handleAutoLayout}>
                <ArrowRightLeft className="mr-2 h-4 w-4" />
                Auto-layout
              </ActionButton>
              <ActionButton tone="secondary" onClick={() => {
                const nextIndex = historyIndexRef.current - 1;
                if (nextIndex < 0) return;
                historyIndexRef.current = nextIndex;
                restoreSnapshot(cloneSnapshot(historyRef.current[nextIndex]!));
              }}>
                <Undo2 className="mr-2 h-4 w-4" />
                Undo
              </ActionButton>
              <ActionButton tone="secondary" onClick={() => {
                const nextIndex = historyIndexRef.current + 1;
                if (nextIndex >= historyRef.current.length) return;
                historyIndexRef.current = nextIndex;
                restoreSnapshot(cloneSnapshot(historyRef.current[nextIndex]!));
              }}>
                <RefreshCcw className="mr-2 h-4 w-4" />
                Redo
              </ActionButton>
              <ActionButton tone="secondary" onClick={removeSelection}>
                <Shapes className="mr-2 h-4 w-4" />
                Delete selection
              </ActionButton>
              <ActionButton tone="secondary" onClick={() => {
                const selectedNodeSet = new Set(selectedNodeIds);
                clipboardRef.current = createSnapshot({
                  nodes: nodes.filter((node) => selectedNodeSet.has(node.id)),
                  edges: edges.filter((edge) => selectedNodeSet.has(edge.source) && selectedNodeSet.has(edge.target)),
                  viewport,
                  selectedNodeIds,
                  selectedEdgeIds,
                });
                toast.success("Selection copied. Paste with Cmd/Ctrl+V.");
              }}>
                <Copy className="mr-2 h-4 w-4" />
                Copy
              </ActionButton>
              <div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-[color:var(--color-text-tertiary)]">
                <span>Manual save: {formatTimestamp(lastManualSaveAtRef.current ?? activeDraft.updatedAt)}</span>
                <span>Autosave: {formatTimestamp(lastAutosaveAtRef.current ?? activeDraft.autosave.lastSavedAt)}</span>
              </div>
            </div>
            {compileReport ? (
              <div
                data-testid="workflow-builder-compile-summary"
                className="flex flex-wrap items-center gap-3 rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3 text-sm text-[color:var(--color-text-secondary)]"
              >
                <StatusPill tone={compileIssueCounts.errors > 0 ? "danger" : "success"}>{compileIssueCounts.errors} errors</StatusPill>
                <StatusPill tone={compileIssueCounts.warnings > 0 ? "warning" : "neutral"}>{compileIssueCounts.warnings} warnings</StatusPill>
                <span className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">
                  Compiled {formatTimestamp(compileReport.validation.generatedAt)}
                </span>
                {issueNavigationItems.length > 0 ? (
                  <span data-testid="workflow-builder-issue-nav-status" className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-secondary)]">
                    {activeIssueIndex >= 0 ? `Issue ${activeIssueIndex + 1} of ${issueNavigationItems.length}` : `${issueNavigationItems.length} issues`}
                  </span>
                ) : null}
                {activeIssueItem ? (
                  <span data-testid="workflow-builder-active-issue-message" className="max-w-[320px] truncate text-xs text-[color:var(--color-text-secondary)]">
                    {activeIssueItem.issue.message}
                  </span>
                ) : null}
                <div className="ml-auto flex flex-wrap gap-3">
                  <ActionButton data-testid="workflow-builder-issue-prev" tone="secondary" disabled={issueNavigationItems.length === 0} onClick={() => navigateIssue("previous")}>
                    Previous issue
                  </ActionButton>
                  <ActionButton data-testid="workflow-builder-issue-next" tone="secondary" disabled={issueNavigationItems.length === 0} onClick={() => navigateIssue("next")}>
                    Next issue
                  </ActionButton>
                  <ActionButton data-testid="workflow-builder-issue-clear" tone="secondary" disabled={!activeIssueKey && selectedNodeIds.length === 0 && selectedEdgeIds.length === 0} onClick={clearSelection}>
                    Clear focus
                  </ActionButton>
                </div>
              </div>
            ) : null}
            <div
              data-testid="workflow-builder-canvas"
              className={cn(
                "relative h-[700px] overflow-hidden rounded-[28px] border bg-[color:var(--color-bg-surface)] transition",
                dropFeedback?.tone === "valid"
                  ? "border-[color:var(--color-accent)] ring-1 ring-[color:var(--color-focus-ring)]"
                  : dropFeedback?.tone === "invalid"
                    ? "border-[color:var(--color-border-strong)] ring-1 ring-[color:var(--color-border-strong)]"
                    : "border-[color:var(--color-border-soft)]",
              )}
              onDragOver={handleCanvasDragOver}
              onDrop={handleCanvasDrop}
              onDragLeave={() => {
                setDropPreview(null);
                setDropFeedback(null);
              }}
            >
              <div
                className="pointer-events-none absolute inset-0 opacity-70"
                style={{
                  backgroundImage: `
                    linear-gradient(to right, rgba(51, 41, 34, 0.05) 1px, transparent 1px),
                    linear-gradient(to bottom, rgba(51, 41, 34, 0.05) 1px, transparent 1px)
                  `,
                  backgroundSize: `${CANVAS_GRID_SIZE}px ${CANVAS_GRID_SIZE}px`,
                }}
              />
              {dropFeedback ? (
                <div
                  data-testid="workflow-builder-drop-feedback"
                  className={cn(
                    "pointer-events-none absolute left-4 top-4 z-20 rounded-[18px] border px-3 py-2 text-xs font-medium shadow-[0_18px_45px_rgba(0,0,0,0.24)]",
                    dropFeedback.tone === "valid"
                      ? "border-[color:var(--color-accent-soft)] bg-[color:var(--color-accent-strong)] text-[color:var(--color-text-primary)]"
                      : "border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] text-[color:var(--color-text-primary)]",
                  )}
                >
                  {dropFeedback.message}
                </div>
              ) : null}
              <WorkflowCanvasInteractionContext.Provider value={canvasInteractionValue}>
                {deferredCanvasChromeReady ? (
                  <WorkflowBuilderCanvasToolbar
                    nodesCount={nodes.length}
                    edgesCount={edges.length}
                    overviewVisible={overviewVisible}
                    onToggleOverview={() => setOverviewVisible((current) => !current)}
                  />
                ) : null}
                <ReactFlow
                  nodes={canvasNodes}
                  edges={canvasEdges}
                  nodeTypes={WORKFLOW_NODE_TYPES}
                  edgeTypes={WORKFLOW_EDGE_TYPES}
                  onlyRenderVisibleElements
                  onInit={() => {
                    if (typeof window !== "undefined" && typeof window.performance?.mark === "function" && activeDraftFingerprint && latestReactFlowMountKeyRef.current !== activeDraftFingerprint) {
                      window.performance.mark("friday-workflow-builder-reactflow-mounted");
                      window.performance.mark("friday-workflow-builder-canvas-ready");
                      latestReactFlowMountKeyRef.current = activeDraftFingerprint;
                    }
                    setReactFlowMounted(true);
                  }}
                  onNodesChange={handleNodesChange}
                  onEdgesChange={handleEdgesChange}
                  onConnect={handleConnect}
                  onNodeDragStop={handleNodeDragStop}
                  onEdgeClick={(_, edge) => {
                    updateGraph({
                      selectedEdgeIds: [edge.id],
                      selectedNodeIds: [],
                      dirty: false,
                    });
                    if (edge.data?.edgeKey) {
                      syncActiveIssueToTarget("edge", edge.data.edgeKey);
                    }
                  }}
                  onNodeClick={(_, node) => {
                    updateGraph({
                      selectedNodeIds: [node.id],
                      selectedEdgeIds: [],
                      dirty: false,
                    });
                    syncActiveIssueToTarget("node", node.id);
                  }}
                  deleteKeyCode={null}
                  defaultViewport={viewport}
                  proOptions={{ hideAttribution: true }}
                  onMoveEnd={handleMoveEnd}
                  minZoom={0.25}
                  maxZoom={1.8}
                  className="!bg-transparent"
                />
              </WorkflowCanvasInteractionContext.Provider>
            </div>
          </div>
        ) : (
          <div className="grid min-h-[760px] place-items-center text-center">
            <div className="max-w-md space-y-4">
              <StatusPill tone="neutral">loading draft</StatusPill>
              <div className="space-y-2">
                <p className="text-lg font-semibold text-[color:var(--color-text-primary)]">Preparing the workflow canvas</p>
                <p className="text-sm leading-6 text-[color:var(--color-text-secondary)]">
                  Friday is loading the draft graph, editor state, and validation context before mounting the canvas.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid min-h-[760px] place-items-center text-center">
            <div className="max-w-md space-y-4">
              <p className="agent-eyebrow">Canvas locked until a draft exists</p>
              <h2 className="font-[var(--font-display)] text-3xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
                Instantiate a template or create a blank draft
              </h2>
              <p className="text-sm leading-7 text-[color:var(--color-text-secondary)]">
                Friday now keeps templates as the entry point only. Once a draft exists, the canvas becomes the primary authoring surface.
              </p>
            </div>
          </div>
        )}
      </ShellCard>

      {deferredInspectorReady || deferredTemplateGroupsReady ? (
        <Suspense fallback={<WorkflowBuilderRightSidebarFallback />}>
          <WorkflowBuilderRightSidebar
            deferredInspectorReady={deferredInspectorReady}
            deferredTemplateGroupsReady={deferredTemplateGroupsReady}
            focus={focus}
            inspectorTitle={selectedNode ? selectedNode.data.name : selectedEdge ? "Edge" : activeDraft?.title ?? "Draft inspector"}
            inspectorTone={selectedNode || selectedEdge ? "success" : "neutral"}
            selectedNodeData={selectedNode?.data ?? null}
            selectedEdgeData={selectedEdge ? { source: selectedEdge.source, target: selectedEdge.target, data: selectedEdge.data } : null}
            selectedNodeIssueSummary={selectedNodeIssueSummary}
            selectedEdgeIssueSummary={selectedEdgeIssueSummary}
            jsonEditorText={jsonEditorText}
            onJsonEditorTextChange={setJsonEditorText}
            onApplyJsonEditor={applyJsonEditor}
            onUpdateSelectedNode={updateSelectedNode}
            onUpdateSelectedNodeConfig={updateSelectedNodeConfig}
            onSelectedNodeTypeChange={handleSelectedNodeTypeChange}
            onSelectedStepTypeChange={handleSelectedStepTypeChange}
            selectedTaskProfileId={selectedTaskProfileId}
            taskProfileOptions={TASK_PROFILE_OPTIONS}
            integrationModeOptions={INTEGRATION_MODE_OPTIONS}
            availableSkills={skillsQuery.data ?? []}
            onUpdateSelectedEdgeBranch={updateSelectedEdgeBranch}
            activeDraft={activeDraft}
            draftTitle={draftTitle}
            onDraftTitleChange={(value) => {
              setDraftTitle(value);
              setDirty(true);
            }}
            changeNote={changeNote}
            onChangeNoteChange={setChangeNote}
            compilePending={compileMutation.isPending}
            onCompile={() => compileMutation.mutate()}
            publishPending={publishMutation.isPending}
            onPublish={() => publishMutation.mutate()}
            readonlyReason={readonlyReason}
            publishedVersionNumber={publishedVersionNumber}
            controlPlaneHref={controlPlaneHref}
            deepLinkHref={deepLinkHref}
            compileReport={compileReport}
            activeIssueKey={activeIssueKey}
            onFocusIssue={focusValidationIssue}
            groupedRegularTemplates={groupedRegularTemplates}
            selectedTemplateId={selectedTemplateId}
            onSelectTemplate={selectTemplate}
          />
        </Suspense>
      ) : (
        <WorkflowBuilderRightSidebarFallback />
      )}
    </div>
  );
}

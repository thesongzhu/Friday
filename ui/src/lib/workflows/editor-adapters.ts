import type {
  FridayWorkflowDraftEntity,
  FridayWorkflowEditorGraphV1,
  FridayWorkflowEditorNode,
  FridayWorkflowEditorEdge,
  FridayWorkflowSpecV1,
  FridayWorkflowVisualGraphV1,
  FridayWorkflowNodeDefinition,
  FridayWorkflowSpecStep,
  FridayWorkflowSpecEdge,
  FridayWorkflowSpecEdgeWhen,
  WorkflowNodeType,
} from "@/lib/api/types";

// ─── Draft → Editor Graph ───

export function draftToEditorGraph(draft: FridayWorkflowDraftEntity): FridayWorkflowEditorGraphV1 {
  const { spec, visual } = draft;

  // Build position lookup from visual
  const posMap = new Map<string, { x: number; y: number; width?: number; height?: number }>(
    visual.nodes.map((node) => [
      node.nodeId,
      { x: node.x, y: node.y, width: node.width, height: node.height },
    ]),
  );
  const edgeLayoutMap = new Map(visual.edges.map((e) => [e.edgeKey, e]));

  // Build nodes from spec steps + trigger
  const editorNodes: FridayWorkflowEditorNode[] = [];

  // Trigger node
  const triggerPos = posMap.get("__trigger__") ?? { x: 100, y: 100 };
  editorNodes.push({
    id: "__trigger__",
    type: "workflow_node",
    position: { x: triggerPos.x, y: triggerPos.y },
    width: triggerPos.width,
    height: triggerPos.height,
    data: {
      id: "__trigger__",
      type: "trigger",
      name: "Trigger",
      config: spec.trigger as unknown as FridayWorkflowNodeDefinition["config"],
    },
  });

  // Step nodes
  for (const step of spec.steps) {
    const pos = posMap.get(step.id) ?? { x: 300, y: 100 + editorNodes.length * 120 };
    const nodeType = stepTypeToNodeType(step.type);
    editorNodes.push({
      id: step.id,
      type: "workflow_node",
      position: { x: pos.x, y: pos.y },
      width: pos.width,
      height: pos.height,
      data: {
        id: step.id,
        type: nodeType,
        name: step.ref ?? step.id,
        config: stepToNodeConfig(step, nodeType),
        timeoutMs: step.timeoutSec ? step.timeoutSec * 1000 : undefined,
      },
    });
  }

  // Build edges
  const editorEdges: FridayWorkflowEditorEdge[] = [];

  // Trigger → startStep edge
  if (spec.startStepId) {
    const edgeKey = `__trigger__:${spec.startStepId}:any`;
    const layout = edgeLayoutMap.get(edgeKey);
    editorEdges.push({
      id: `e-trigger-${spec.startStepId}`,
      source: "__trigger__",
      target: spec.startStepId,
      sourceHandle: layout?.sourceHandle,
      targetHandle: layout?.targetHandle,
    });
  }

  // Spec edges
  for (const edge of spec.edges) {
    const edgeKey = `${edge.from}:${edge.to}:${edge.when ?? "any"}`;
    const layout = edgeLayoutMap.get(edgeKey);
    editorEdges.push({
      id: `e-${edge.from}-${edge.to}-${edge.when ?? "any"}`,
      source: edge.from,
      target: edge.to,
      sourceHandle: layout?.sourceHandle,
      targetHandle: layout?.targetHandle,
      data: {
        branch: edge.when,
      },
    });
  }

  return {
    schemaVersion: "1.0",
    reactFlowVersion: "11",
    nodes: editorNodes,
    edges: editorEdges,
    viewport: visual.viewport,
  };
}

// ─── Editor Graph → Draft bundle ───

export function editorGraphToDraftBundle(
  editorGraph: FridayWorkflowEditorGraphV1,
  previousDraft: FridayWorkflowDraftEntity,
): { spec: FridayWorkflowSpecV1; visual: FridayWorkflowVisualGraphV1 } {
  const triggerNode = editorGraph.nodes.find((n) => n.data.type === "trigger");
  const stepNodes = editorGraph.nodes.filter((n) => n.data.type !== "trigger");

  // Find trigger → X edge to determine startStepId
  const triggerEdge = editorGraph.edges.find((e) => e.source === "__trigger__");
  const startStepId = triggerEdge?.target ?? "";

  // Build steps
  const steps: FridayWorkflowSpecStep[] = stepNodes.map((node) => ({
    id: node.data.id,
    type: nodeTypeToStepType(node.data.type),
    ref: node.data.name,
    args: extractStepArgs(node.data),
    condition: extractCondition(node.data),
    timeoutSec: node.data.timeoutMs ? Math.ceil(node.data.timeoutMs / 1000) : undefined,
  }));

  // Build spec edges (exclude trigger edges)
  const specEdges: FridayWorkflowSpecEdge[] = editorGraph.edges
    .filter((e) => e.source !== "__trigger__")
    .map((e) => ({
      from: e.source,
      to: e.target,
      when: (e.data?.branch as FridayWorkflowSpecEdgeWhen) ?? undefined,
    }));

  // Build trigger config
  const triggerConfig = triggerNode?.data.config ?? { type: "manual" };
  const trigger = isTriggerConfig(triggerConfig)
    ? triggerConfig
    : previousDraft.spec.trigger;

  const spec: FridayWorkflowSpecV1 = {
    ...previousDraft.spec,
    startStepId,
    trigger,
    steps,
    edges: specEdges,
  };

  // Build visual
  const visual: FridayWorkflowVisualGraphV1 = {
    schemaVersion: "1.0",
    workflowId: previousDraft.workflowId,
    viewport: editorGraph.viewport ?? { x: 0, y: 0, zoom: 1 },
    panelLayout: previousDraft.visual.panelLayout,
    nodes: editorGraph.nodes.map((n) => ({
      nodeId: n.id,
      x: n.position.x,
      y: n.position.y,
      width: n.width,
      height: n.height,
    })),
    edges: editorGraph.edges.map((e) => ({
      edgeKey: `${e.source}:${e.target}:${e.data?.branch ?? "any"}`,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
    })),
  };

  return { spec, visual };
}

// ─── Helpers ───

function stepTypeToNodeType(stepType: string): WorkflowNodeType {
  switch (stepType) {
    case "skill_call":
      return "action";
    case "tool_call":
      return "ai"; // or action depending on args, default to ai
    case "condition":
      return "condition";
    case "transform":
      return "data";
    case "human_approval":
      return "approval";
    default:
      return "action";
  }
}

function nodeTypeToStepType(nodeType: WorkflowNodeType): FridayWorkflowSpecStep["type"] {
  switch (nodeType) {
    case "trigger":
      return "skill_call"; // shouldn't hit, trigger isn't a step
    case "action":
      return "skill_call";
    case "ai":
      return "tool_call";
    case "condition":
      return "condition";
    case "data":
      return "transform";
    case "approval":
      return "human_approval";
  }
}

function stepToNodeConfig(step: FridayWorkflowSpecStep, nodeType: WorkflowNodeType): FridayWorkflowNodeDefinition["config"] {
  const args = step.args ?? {};
  switch (nodeType) {
    case "action":
      return { actionType: "skill" as const, skillId: (args.skillId as string) ?? "", inputMapping: args.inputMapping as Record<string, unknown> | undefined };
    case "ai":
      return { actionType: "ai_completion" as const, prompt: (args.prompt as string) ?? "", model: args.model as string | undefined };
    case "condition":
      return { conditionType: "if" as const, expression: step.condition ?? (args.expression as string) ?? "" };
    case "data":
      return { transformType: "template" as const, expression: (args.expression as string) ?? "" };
    case "approval":
      return { approverRole: "owner" as const };
    default:
      return { actionType: "skill" as const, skillId: "" };
  }
}

function extractStepArgs(data: FridayWorkflowNodeDefinition): Record<string, unknown> | undefined {
  const config = data.config as Record<string, unknown>;
  const args: Record<string, unknown> = {};

  if ("skillId" in config) args.skillId = config.skillId;
  if ("inputMapping" in config) args.inputMapping = config.inputMapping;
  if ("prompt" in config) args.prompt = config.prompt;
  if ("model" in config) args.model = config.model;
  if ("temperature" in config) args.temperature = config.temperature;
  if ("expression" in config) args.expression = config.expression;
  if ("mapping" in config) args.mapping = config.mapping;
  if ("method" in config && "url" in config) {
    args.method = config.method;
    args.url = config.url;
    if ("headers" in config) args.headers = config.headers;
    if ("body" in config) args.body = config.body;
  }

  return Object.keys(args).length > 0 ? args : undefined;
}

function extractCondition(data: FridayWorkflowNodeDefinition): string | undefined {
  const config = data.config as Record<string, unknown>;
  if ("expression" in config && data.type === "condition") {
    return config.expression as string;
  }
  return undefined;
}

function isTriggerConfig(config: unknown): config is FridayWorkflowSpecV1["trigger"] {
  if (typeof config !== "object" || config === null) return false;
  return "type" in config && ["manual", "schedule", "event"].includes((config as { type: string }).type);
}

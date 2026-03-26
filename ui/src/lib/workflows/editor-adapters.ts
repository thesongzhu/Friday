import type {
  FridayWorkflowDraftEntity,
  FridayWorkflowEditorEdge,
  FridayWorkflowEditorGraphV1,
  FridayWorkflowEditorNode,
  FridayWorkflowNodeConfig,
  FridayWorkflowNodeDefinition,
  FridayWorkflowSpecEdge,
  FridayWorkflowSpecEdgeWhen,
  FridayWorkflowSpecStep,
  FridayWorkflowSpecStepType,
  FridayWorkflowSpecTrigger,
  FridayWorkflowSpecV1,
  FridayWorkflowVisualGraphV1,
  WorkflowNodeType,
} from "@/lib/api/types";

function edgeKeyFor(input: { source: string; target: string; branch?: string }): string {
  return `${input.source}:${input.target}:${input.branch ?? "any"}`;
}

function isAiCompletionArgs(args?: Record<string, unknown>): boolean {
  return Boolean(args && ("prompt" in args || "model" in args || "temperature" in args));
}

function stepTypeToNodeType(step: FridayWorkflowSpecStep): WorkflowNodeType {
  switch (step.type) {
    case "condition":
      return "condition";
    case "transform":
      return "data";
    case "human_approval":
      return "approval";
    case "tool_call":
      return isAiCompletionArgs(step.args) ? "ai" : "action";
    case "skill_call":
    default:
      return "action";
  }
}

function nodeTypeToDefaultStepType(nodeType: WorkflowNodeType): FridayWorkflowSpecStepType {
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
    case "action":
    default:
      return "skill_call";
  }
}

function triggerToNodeConfig(trigger: FridayWorkflowSpecTrigger): FridayWorkflowNodeConfig {
  switch (trigger.type) {
    case "manual":
      return { triggerType: "manual" };
    case "schedule":
      return { triggerType: "cron", cron: trigger.cron, timezone: trigger.timezone };
    case "event":
      return { triggerType: "event", source: trigger.source, event: trigger.event };
    default:
      return { triggerType: "manual" };
  }
}

function nodeConfigToTrigger(
  config: FridayWorkflowNodeDefinition["config"],
  fallback: FridayWorkflowSpecTrigger,
): FridayWorkflowSpecTrigger {
  if ("triggerType" in config) {
    if (config.triggerType === "manual") {
      return { type: "manual" };
    }
    if (config.triggerType === "cron") {
      return { type: "schedule", cron: config.cron, timezone: config.timezone };
    }
    if (config.triggerType === "event") {
      return { type: "event", source: config.source, event: config.event };
    }
  }
  return fallback;
}

function stepToNodeConfig(step: FridayWorkflowSpecStep): FridayWorkflowNodeConfig {
  const args = step.args ?? {};

  switch (step.type) {
    case "skill_call":
      return {
        actionType: "skill",
        skillId: step.ref ?? (typeof args.skillId === "string" ? args.skillId : ""),
        inputMapping:
          typeof args.inputMapping === "object" && args.inputMapping !== null
            ? (args.inputMapping as Record<string, unknown>)
            : undefined,
      };
    case "tool_call":
      if (typeof args.method === "string" && typeof args.url === "string") {
        return {
          actionType: "http_request",
          method: args.method,
          url: args.url,
          headers:
            typeof args.headers === "object" && args.headers !== null
              ? (args.headers as Record<string, string>)
              : undefined,
          body: args.body,
        };
      }
      if (isAiCompletionArgs(args)) {
        return {
          actionType: "ai_completion",
          prompt: typeof args.prompt === "string" ? args.prompt : "",
          model: typeof args.model === "string" ? args.model : undefined,
          temperature: typeof args.temperature === "number" ? args.temperature : undefined,
        };
      }
      return {
        actionType: "tool",
        toolId: step.ref ?? "",
        args: args,
      };
    case "condition":
      return {
        conditionType: "if",
        expression: step.condition ?? (typeof args.expression === "string" ? args.expression : ""),
      };
    case "transform":
      return {
        transformType:
          args.mapping && typeof args.mapping === "object"
            ? "map"
            : (typeof args.transform === "string" ? "template" : "merge"),
        mapping:
          typeof args.mapping === "object" && args.mapping !== null
            ? (args.mapping as Record<string, unknown>)
            : undefined,
        expression:
          typeof args.transform === "string"
            ? args.transform
            : (typeof args.expression === "string" ? args.expression : undefined),
        outputKey: typeof args.outputKey === "string" ? args.outputKey : undefined,
      };
    case "human_approval":
      return {
        approverUserId: typeof args.approverUserId === "string" ? args.approverUserId : undefined,
        approverRole:
          args.approverRole === "owner" || args.approverRole === "admin" || args.approverRole === "operator"
            ? args.approverRole
            : "owner",
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
        onReject: args.onReject === "reject_branch" ? "reject_branch" : "fail",
      };
    default:
      return {
        actionType: "skill",
        skillId: step.ref ?? "",
      };
  }
}

function buildRawArgs(data: FridayWorkflowNodeDefinition): Record<string, unknown> | undefined {
  const args: Record<string, unknown> = {
    ...(data.rawArgs ?? {}),
  };
  const config = data.config as Record<string, unknown>;
  const stepType = data.stepType ?? nodeTypeToDefaultStepType(data.type);

  if (stepType === "skill_call") {
    if (typeof config.inputMapping === "object" && config.inputMapping !== null) {
      args.inputMapping = config.inputMapping;
    } else {
      delete args.inputMapping;
    }
    delete args.skillId;
  }

  if (stepType === "tool_call") {
    if (config.actionType === "tool") {
      if (typeof config.args === "object" && config.args !== null) {
        Object.assign(args, config.args as Record<string, unknown>);
      }
    } else if (config.actionType === "ai_completion") {
      args.prompt = config.prompt;
      if (config.model !== undefined) args.model = config.model;
      else delete args.model;
      if (config.temperature !== undefined) args.temperature = config.temperature;
      else delete args.temperature;
    } else if (config.actionType === "http_request") {
      args.method = config.method;
      args.url = config.url;
      if (config.headers !== undefined) args.headers = config.headers;
      else delete args.headers;
      if (config.body !== undefined) args.body = config.body;
      else delete args.body;
    }
  }

  if (stepType === "condition") {
    if (typeof data.stepCondition === "string" && data.stepCondition.trim().length > 0) {
      args.expression = data.stepCondition;
    } else if (typeof config.expression === "string") {
      args.expression = config.expression;
    }
  }

  if (stepType === "transform") {
    if (config.transformType === "map") {
      if (config.mapping !== undefined) args.mapping = config.mapping;
      else delete args.mapping;
      delete args.transform;
      delete args.expression;
    } else {
      const expression = typeof config.expression === "string" ? config.expression : undefined;
      if (expression) {
        args.transform = expression;
        args.expression = expression;
      } else {
        delete args.transform;
        delete args.expression;
      }
      if (config.outputKey !== undefined) args.outputKey = config.outputKey;
      else delete args.outputKey;
      if (config.mapping !== undefined) args.mapping = config.mapping;
      else delete args.mapping;
    }
  }

  if (stepType === "human_approval") {
    if (config.approverUserId !== undefined) args.approverUserId = config.approverUserId;
    else delete args.approverUserId;
    if (config.approverRole !== undefined) args.approverRole = config.approverRole;
    else delete args.approverRole;
    if (config.timeoutMs !== undefined) args.timeoutMs = config.timeoutMs;
    else delete args.timeoutMs;
    if (config.onReject !== undefined) args.onReject = config.onReject;
    else delete args.onReject;
  }

  return Object.keys(args).length > 0 ? args : undefined;
}

function isBranch(value: string | undefined): value is FridayWorkflowSpecEdgeWhen {
  return value === "success" || value === "failure" || value === "true" || value === "false";
}

export function draftToEditorGraph(draft: FridayWorkflowDraftEntity): FridayWorkflowEditorGraphV1 {
  const { spec, visual } = draft;
  const posMap = new Map<string, { x: number; y: number; width?: number; height?: number }>(
    visual.nodes.map((node) => [
      node.nodeId,
      { x: node.x, y: node.y, width: node.width, height: node.height },
    ]),
  );
  const edgeLayoutMap = new Map(visual.edges.map((edge) => [edge.edgeKey, edge]));

  const editorNodes: FridayWorkflowEditorNode[] = [];
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
      config: triggerToNodeConfig(spec.trigger),
    },
  });

  for (const step of spec.steps) {
    const pos = posMap.get(step.id) ?? { x: 300, y: 120 + editorNodes.length * 120 };
    editorNodes.push({
      id: step.id,
      type: "workflow_node",
      position: { x: pos.x, y: pos.y },
      width: pos.width,
      height: pos.height,
      data: {
        id: step.id,
        type: stepTypeToNodeType(step),
        name: step.ref ?? step.id,
        config: stepToNodeConfig(step),
        timeoutMs: step.timeoutSec ? step.timeoutSec * 1000 : undefined,
        stepType: step.type,
        stepRef: step.ref,
        rawArgs: step.args,
        stepCondition: step.condition,
        retry: step.retry,
      },
    });
  }

  const editorEdges: FridayWorkflowEditorEdge[] = [];
  let selectedEdgeId: string | undefined;

  if (spec.startStepId) {
    const edgeKey = edgeKeyFor({ source: "__trigger__", target: spec.startStepId });
    const layout = edgeLayoutMap.get(edgeKey);
    const edgeId = `e-trigger-${spec.startStepId}`;
    if (visual.selectedEdgeKey === edgeKey) {
      selectedEdgeId = edgeId;
    }
    editorEdges.push({
      id: edgeId,
      source: "__trigger__",
      target: spec.startStepId,
      sourceHandle: layout?.sourceHandle,
      targetHandle: layout?.targetHandle,
      data: {
        edgeKey,
        bendPoints: layout?.bendPoints,
      },
    });
  }

  for (const edge of spec.edges) {
    const branch = edge.when;
    const edgeKey = edgeKeyFor({ source: edge.from, target: edge.to, branch });
    const layout = edgeLayoutMap.get(edgeKey);
    const edgeId = `e-${edge.from}-${edge.to}-${branch ?? "any"}`;
    if (visual.selectedEdgeKey === edgeKey) {
      selectedEdgeId = edgeId;
    }
    editorEdges.push({
      id: edgeId,
      source: edge.from,
      target: edge.to,
      sourceHandle: layout?.sourceHandle,
      targetHandle: layout?.targetHandle,
      data: {
        branch,
        edgeKey,
        bendPoints: layout?.bendPoints,
      },
    });
  }

  return {
    schemaVersion: "1.0",
    reactFlowVersion: "11",
    nodes: editorNodes,
    edges: editorEdges,
    viewport: visual.viewport,
    selectedNodeId: visual.selectedNodeId,
    selectedEdgeId,
  };
}

export function editorGraphToDraftBundle(
  editorGraph: FridayWorkflowEditorGraphV1,
  previousDraft: FridayWorkflowDraftEntity,
): { spec: FridayWorkflowSpecV1; visual: FridayWorkflowVisualGraphV1 } {
  const triggerNode = editorGraph.nodes.find((node) => node.data.type === "trigger");
  const stepNodes = editorGraph.nodes.filter((node) => node.data.type !== "trigger");
  const triggerEdge = editorGraph.edges.find((edge) => edge.source === "__trigger__");
  const startStepId = triggerEdge?.target ?? "";

  const steps: FridayWorkflowSpecStep[] = stepNodes.map((node) => {
    const stepType = node.data.stepType ?? nodeTypeToDefaultStepType(node.data.type);
    const stepRef = node.data.stepRef ?? node.data.name;
    const args = buildRawArgs(node.data);
    return {
      id: node.data.id,
      type: stepType,
      ref: stepType === "skill_call" || stepType === "tool_call" ? stepRef : node.data.stepRef,
      args,
      condition:
        stepType === "condition"
          ? (node.data.stepCondition ?? ("expression" in node.data.config ? node.data.config.expression : undefined))
          : undefined,
      timeoutSec: node.data.timeoutMs ? Math.ceil(node.data.timeoutMs / 1000) : undefined,
      retry: node.data.retry,
    };
  });

  const specEdges: FridayWorkflowSpecEdge[] = editorGraph.edges
    .filter((edge) => edge.source !== "__trigger__")
    .map((edge) => ({
      from: edge.source,
      to: edge.target,
      when: isBranch(edge.data?.branch) ? edge.data.branch : undefined,
    }));

  const trigger = triggerNode
    ? nodeConfigToTrigger(triggerNode.data.config, previousDraft.spec.trigger)
    : previousDraft.spec.trigger;

  const spec: FridayWorkflowSpecV1 = {
    ...previousDraft.spec,
    startStepId,
    trigger,
    steps,
    edges: specEdges,
  };

  const selectedEdge = editorGraph.selectedEdgeId
    ? editorGraph.edges.find((edge) => edge.id === editorGraph.selectedEdgeId)
    : undefined;

  const visual: FridayWorkflowVisualGraphV1 = {
    schemaVersion: "1.0",
    workflowId: previousDraft.workflowId,
    viewport: editorGraph.viewport ?? { x: 0, y: 0, zoom: 1 },
    selectedNodeId: editorGraph.selectedNodeId,
    selectedEdgeKey: selectedEdge
      ? edgeKeyFor({
        source: selectedEdge.source,
        target: selectedEdge.target,
        branch: selectedEdge.data?.branch,
      })
      : undefined,
    panelLayout: previousDraft.visual.panelLayout,
    nodes: editorGraph.nodes.map((node) => ({
      nodeId: node.id,
      x: node.position.x,
      y: node.position.y,
      width: node.width,
      height: node.height,
    })),
    edges: editorGraph.edges.map((edge) => ({
      edgeKey: edgeKeyFor({ source: edge.source, target: edge.target, branch: edge.data?.branch }),
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      bendPoints: edge.data?.bendPoints,
    })),
  };

  return { spec, visual };
}

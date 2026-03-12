import type {
  FridayWorkflowSpecV1,
  FridayWorkflowVisualGraphV1,
  WorkflowFailurePolicyV2,
  WorkflowNodeType,
  FridayWorkflowNodeConfig,
} from "@/lib/api/types";

// ─── Default failure policy ───

export const DEFAULT_FAILURE_POLICY: WorkflowFailurePolicyV2 = {
  onFailure: "fail_fast",
  notifyUser: true,
};

// ─── Default spec for new workflows ───

export function createDefaultSpec(workflowId: string, name: string): FridayWorkflowSpecV1 {
  return {
    schemaVersion: "1.0",
    workflowId,
    name,
    description: "",
    startStepId: "",
    trigger: { type: "manual" },
    inputs: [],
    steps: [],
    edges: [],
    outputs: [],
    errorPolicy: DEFAULT_FAILURE_POLICY,
    tests: [],
  };
}

// ─── Default visual graph ───

export function createDefaultVisual(workflowId: string): FridayWorkflowVisualGraphV1 {
  return {
    schemaVersion: "1.0",
    workflowId,
    viewport: { x: 0, y: 0, zoom: 1 },
    panelLayout: { leftOpen: true, rightOpen: false, bottomOpen: false },
    nodes: [],
    edges: [],
  };
}

// ─── Default raw graph for workflow creation ───

export function createDefaultRawGraph() {
  return {
    nodes: [],
    edges: [],
  };
}

// ─── Default node config by type ───

export function getDefaultNodeConfig(type: WorkflowNodeType): FridayWorkflowNodeConfig {
  switch (type) {
    case "trigger":
      return { triggerType: "webhook", method: "POST" as const };
    case "action":
      return { actionType: "skill" as const, skillId: "" };
    case "condition":
      return { conditionType: "if" as const, expression: "" };
    case "data":
      return { transformType: "template" as const, expression: "" };
    case "ai":
      return { actionType: "ai_completion" as const, prompt: "" };
    case "approval":
      return { approverRole: "owner" as const };
  }
}

// ─── Default node name counter ───

const nodeTypeCounters = new Map<string, number>();

export function getNextNodeName(type: WorkflowNodeType, existingNames: string[]): string {
  const labels: Record<WorkflowNodeType, string> = {
    trigger: "Trigger",
    action: "Action",
    condition: "Condition",
    data: "Data",
    ai: "AI",
    approval: "Approval",
  };

  const prefix = labels[type];
  let counter = nodeTypeCounters.get(type) ?? 0;

  let name: string;
  do {
    counter++;
    name = `${prefix} ${counter}`;
  } while (existingNames.includes(name));

  nodeTypeCounters.set(type, counter);
  return name;
}

export function resetNodeCounters(): void {
  nodeTypeCounters.clear();
}

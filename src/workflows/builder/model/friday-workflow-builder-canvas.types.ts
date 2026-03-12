import type { UUID } from "../../model/friday-workflow.types.js";

// ─── Viewport ───

export interface FridayWorkflowCanvasViewportV1 {
  x: number;
  y: number;
  zoom: number;
}

// ─── Panel Layout ───

export interface FridayWorkflowCanvasPanelLayoutV1 {
  leftOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
}

// ─── Node Layout ───

export interface FridayWorkflowBuilderNodeLayoutV1 {
  nodeId: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  zIndex?: number;
}

// ─── Edge Layout ───

export interface FridayWorkflowBuilderEdgeLayoutV1 {
  edgeKey: string; // `${from}:${to}:${when ?? "any"}`
  sourceHandle?: string;
  targetHandle?: string;
  bendPoints?: Array<{ x: number; y: number }>;
}

// ─── Visual Graph ───

export interface FridayWorkflowVisualGraphV1 {
  schemaVersion: "1.0";
  workflowId: UUID;
  viewport: FridayWorkflowCanvasViewportV1;
  selectedNodeId?: string;
  selectedEdgeKey?: string;
  panelLayout: FridayWorkflowCanvasPanelLayoutV1;
  nodes: FridayWorkflowBuilderNodeLayoutV1[];
  edges: FridayWorkflowBuilderEdgeLayoutV1[];
}

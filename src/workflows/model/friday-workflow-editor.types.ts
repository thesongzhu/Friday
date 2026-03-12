// ─── Workflow Editor Types (React Flow compatible) ───

import type { FridayWorkflowNodeDefinition } from "./friday-workflow-engine.types.js";

export interface FridayWorkflowEditorGraphV1 {
  schemaVersion: "1.0";
  reactFlowVersion: "11";
  nodes: FridayWorkflowEditorNode[];
  edges: FridayWorkflowEditorEdge[];
  viewport?: FridayWorkflowEditorViewport;
}

export interface FridayWorkflowEditorNode {
  id: string;
  type: "workflow_node";
  position: { x: number; y: number };
  width?: number;
  height?: number;
  data: FridayWorkflowNodeDefinition;
}

export interface FridayWorkflowEditorEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  data?: {
    condition?: string;
    branch?: string;
  };
}

export interface FridayWorkflowEditorViewport {
  x: number;
  y: number;
  zoom: number;
}

import type {
  JsonValue,
  WorkflowFailurePolicyV2,
  WorkflowNodeType,
} from "./friday-workflow.types.js";

// ─── Typed JSON accessor ───

// ─── Graph validation error ───

export class FridayGraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FridayGraphValidationError";
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeWorkflowNodeType(value: unknown): WorkflowNodeType | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  switch (value.trim()) {
    case "trigger":
    case "action":
    case "condition":
    case "data":
    case "ai":
    case "approval":
      return value.trim() as WorkflowNodeType;
    case "start":
      return "trigger";
    case "tool_call":
    case "skill_call":
      return "action";
    case "transform":
      return "data";
    case "human_approval":
      return "approval";
    default:
      return null;
  }
}

/**
 * Validate that a raw graph object has the required structural fields.
 * Returns an array of error messages (empty = valid).
 */
export function validateGraphStructure(raw: Record<string, unknown>): string[] {
  const errors: string[] = [];

  // Determine the nodes/edges source
  let nodes: unknown[];
  let edges: unknown[];

  const graphObj = raw.graph as Record<string, unknown> | undefined;
  if (graphObj && typeof graphObj === "object" && Array.isArray(graphObj.nodes)) {
    nodes = graphObj.nodes;
    edges = Array.isArray(graphObj.edges) ? graphObj.edges : [];
  } else if (Array.isArray(raw.nodes)) {
    nodes = raw.nodes;
    edges = Array.isArray(raw.edges) ? raw.edges : [];
  } else {
    errors.push("Graph must contain a 'nodes' array (either at top level or under 'graph')");
    return errors;
  }

  if (!Array.isArray(edges)) {
    errors.push("Graph 'edges' must be an array");
  }

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node == null || typeof node !== "object") {
      errors.push(`nodes[${i}]: must be an object`);
      continue;
    }
    const n = node as Record<string, unknown>;
    if (typeof n.id !== "string" || n.id === "") {
      errors.push(`nodes[${i}]: missing or invalid 'id' (must be a non-empty string)`);
    }
    // Accept both 'type' and 'kind' for node definitions (kind is a common alias)
    const nodeType = typeof n.type === "string" && n.type !== "" ? n.type : typeof n.kind === "string" && n.kind !== "" ? n.kind : "";
    if (nodeType === "") {
      errors.push(`nodes[${i}]: missing or invalid 'type' (must be a non-empty string)`);
    }
    // Position: required for visual editor graphs, optional for compiled graphs
    if ("position" in n && n.position != null) {
      if (typeof n.position !== "object") {
        errors.push(`nodes[${i}]: 'position' must be an object with x/y coordinates`);
      }
    }
    // Data/config: at least one must be present
    if (n.data === undefined && n.config === undefined) {
      errors.push(`nodes[${i}]: must have 'data' or 'config'`);
    }
  }

  return errors;
}

/**
 * Parse a `JsonValue` (from a DB entity's JSON column) into a compiled workflow graph.
 * Consolidates the single unavoidable cast: the DB stores `graphJson` as `JsonValue`
 * but the value is always a serialized `FridayCompiledWorkflowGraphV2`.
 *
 * Handles both compiled graphs (schemaVersion "2.0" with nested `graph.nodes`)
 * and raw/generated graphs that have `nodes`/`edges` at the top level.
 *
 * Throws `FridayGraphValidationError` if the graph structure is fundamentally invalid.
 */
export function parseGraphJson(graphJson: JsonValue): FridayCompiledWorkflowGraphV2 {
  if (graphJson == null || typeof graphJson !== "object" || Array.isArray(graphJson)) {
    throw new FridayGraphValidationError("Graph JSON must be a non-null object");
  }

  const raw = graphJson as Record<string, unknown>;

  // If `graph.nodes` already exists, it's a proper compiled graph
  if (raw.graph && typeof raw.graph === "object" && Array.isArray((raw.graph as Record<string, unknown>).nodes)) {
    return raw as unknown as FridayCompiledWorkflowGraphV2;
  }

  // If `nodes` exists at the top level (raw/generated graph), wrap it
  if (Array.isArray(raw.nodes)) {
    const normalized: FridayCompiledWorkflowGraphV2 = {
      schemaVersion: (raw.schemaVersion as "2.0") ?? "2.0",
      workflowId: (raw.workflowId as string) ?? "",
      workflowVersionId: (raw.workflowVersionId as string) ?? "",
      sourceSpecSchemaVersion: (raw.sourceSpecSchemaVersion as "1.0") ?? "1.0",
      graph: {
        nodes: raw.nodes.map((node, index) => {
          const rawNode = readRecord(node) ?? {};
          const nodeId = readString(rawNode.id) ?? `node-${index + 1}`;
          const normalizedType =
            normalizeWorkflowNodeType(rawNode.type ?? rawNode.kind)
            ?? (readString(rawNode.type ?? rawNode.kind) as WorkflowNodeType | undefined)
            ?? "action";
          const config =
            readRecord(rawNode.config)
            ?? readRecord(rawNode.data)
            ?? {};
          return {
            id: nodeId,
            type: normalizedType,
            label: readString(rawNode.label) ?? readString(rawNode.name) ?? nodeId,
            config: config as Record<string, JsonValue>,
            retryPolicy: rawNode.retryPolicy as FridayNodeRetryPolicy | undefined,
            timeoutMs: typeof rawNode.timeoutMs === "number" ? rawNode.timeoutMs : undefined,
          };
        }),
        edges: (Array.isArray(raw.edges) ? raw.edges : []).map((edge, index) => {
          const rawEdge = readRecord(edge) ?? {};
          const sourceNodeId =
            readString(rawEdge.sourceNodeId)
            ?? readString(rawEdge.source)
            ?? readString(rawEdge.from)
            ?? "";
          const targetNodeId =
            readString(rawEdge.targetNodeId)
            ?? readString(rawEdge.target)
            ?? readString(rawEdge.to)
            ?? "";
          const condition = readString(rawEdge.condition) ?? readString(rawEdge.when);
          return {
            id: readString(rawEdge.id) ?? `edge-${index + 1}:${sourceNodeId}:${targetNodeId}:${condition ?? "success"}`,
            sourceNodeId,
            targetNodeId,
            sourcePort: readString(rawEdge.sourcePort),
            targetPort: readString(rawEdge.targetPort),
            condition,
            priority: typeof rawEdge.priority === "number" ? rawEdge.priority : undefined,
          };
        }),
        variables: (raw.variables ?? {}) as Record<string, JsonValue>,
      },
      failurePolicy: (raw.failurePolicy as WorkflowFailurePolicyV2) ?? { onFailure: "fail_fast" },
      tests: (Array.isArray(raw.tests) ? raw.tests : []) as FridayWorkflowTest[],
      checksum: (raw.checksum as string) ?? "",
    };
    return normalized;
  }

  throw new FridayGraphValidationError(
    "Graph must contain a 'nodes' array (either at top level or under 'graph')",
  );
}

// ─── Compiled Graph Nodes ───

export interface FridayWorkflowNode {
  id: string;
  type: WorkflowNodeType;
  label: string;
  config: Record<string, JsonValue>;
  retryPolicy?: FridayNodeRetryPolicy;
  timeoutMs?: number;
}

export interface FridayNodeRetryPolicy {
  maxAttempts: number;
  backoff: "none" | "fixed" | "exponential";
  baseDelayMs: number;
  maxDelayMs: number;
  retryOn: string[];
}

// ─── Compiled Graph Edges ───

export interface FridayWorkflowEdge {
  id: string;
  sourceNodeId: string;
  sourcePort?: string;
  targetNodeId: string;
  targetPort?: string;
  condition?: string;
  priority?: number;
}

// ─── Compiled Workflow Graph V2 ───

export interface FridayCompiledWorkflowGraphV2 {
  schemaVersion: "2.0";
  workflowId: string;
  workflowVersionId: string;
  sourceSpecSchemaVersion: "1.0";
  graph: {
    nodes: FridayWorkflowNode[];
    edges: FridayWorkflowEdge[];
    variables?: Record<string, JsonValue>;
  };
  failurePolicy: WorkflowFailurePolicyV2;
  tests: FridayWorkflowTest[];
  checksum: string;
}

// ─── Workflow Test ───

export interface FridayWorkflowTest {
  name: string;
  description?: string;
  inputs: Record<string, unknown>;
  mocks?: Record<
    string,
    { output: Record<string, unknown>; status?: "completed" | "failed" }
  >;
  assertions: FridayWorkflowTestAssertion[];
}

export interface FridayWorkflowTestAssertion {
  path: string;
  operator: "==" | "!=" | ">" | "<" | "contains" | "matches";
  expected: unknown;
}

// ─── Adjacency structures (produced by DAG scheduler) ───

export interface FridayDagAdjacency {
  /** nodeId → list of successor nodeIds */
  outbound: Map<string, string[]>;
  /** nodeId → list of predecessor nodeIds */
  inbound: Map<string, string[]>;
  /** nodes with zero inbound edges (entry points, including trigger nodes) */
  entryNodes: string[];
  /** topological order */
  topoOrder: string[];
}

// ─── Execution Plan (produced by compiler + scheduler for a run) ───

export interface FridayWorkflowExecutionPlan {
  runId: string;
  workflowId: string;
  workflowVersionId: string;
  compiledGraph: FridayCompiledWorkflowGraphV2;
  adjacency: FridayDagAdjacency;
  failurePolicy: WorkflowFailurePolicyV2;
  /** nodeId → FridayWorkflowNode lookup */
  nodeMap: Map<string, FridayWorkflowNode>;
}

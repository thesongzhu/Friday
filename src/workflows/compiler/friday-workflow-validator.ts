import type { FridayCompiledWorkflowGraphV2 } from "../model/friday-workflow-graph.types.js";
import { createFridayExpressionEvaluator } from "../engine/friday-workflow-expression-evaluator.js";

// ─── Types ───

export interface FridayWorkflowValidationError {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface FridayWorkflowValidationResult {
  valid: boolean;
  errors: FridayWorkflowValidationError[];
}

// ─── Interface ───

export interface FridayWorkflowValidator {
  validate(graph: FridayCompiledWorkflowGraphV2): FridayWorkflowValidationResult;
}

// ─── Factory ───

export function createFridayWorkflowValidator(): FridayWorkflowValidator {
  const exprEval = createFridayExpressionEvaluator();

  return {
    validate(graph) {
      const errors: FridayWorkflowValidationError[] = [];

      // 1. Schema version check
      if (graph.schemaVersion !== "2.0") {
        errors.push({
          code: "WORKFLOW_INVALID_SCHEMA_VERSION",
          message: `Expected schemaVersion '2.0', got '${graph.schemaVersion}'`,
        });
      }

      // 2. Checksum present
      if (!graph.checksum) {
        errors.push({
          code: "WORKFLOW_MISSING_CHECKSUM",
          message: "Graph checksum is required",
        });
      }

      // 3. Non-empty graph
      if (graph.graph.nodes.length === 0) {
        errors.push({
          code: "WORKFLOW_EMPTY_GRAPH",
          message: "Graph must contain at least one node",
        });
        return { valid: false, errors };
      }

      // 4. Unique node ids
      const nodeIds = new Set<string>();
      for (const node of graph.graph.nodes) {
        if (nodeIds.has(node.id)) {
          errors.push({
            code: "WORKFLOW_DUPLICATE_NODE_ID",
            message: `Duplicate node id '${node.id}'`,
            nodeId: node.id,
          });
        }
        nodeIds.add(node.id);
      }

      // 5. Unique edge ids
      const edgeIds = new Set<string>();
      for (const edge of graph.graph.edges) {
        if (edgeIds.has(edge.id)) {
          errors.push({
            code: "WORKFLOW_DUPLICATE_EDGE_ID",
            message: `Duplicate edge id '${edge.id}'`,
            edgeId: edge.id,
          });
        }
        edgeIds.add(edge.id);
      }

      // 6. Edge references valid
      for (const edge of graph.graph.edges) {
        if (!nodeIds.has(edge.sourceNodeId)) {
          errors.push({
            code: "WORKFLOW_EDGE_REFERENCES_MISSING_NODE",
            message: `Edge '${edge.id}' references missing source node '${edge.sourceNodeId}'`,
            edgeId: edge.id,
          });
        }
        if (!nodeIds.has(edge.targetNodeId)) {
          errors.push({
            code: "WORKFLOW_EDGE_REFERENCES_MISSING_NODE",
            message: `Edge '${edge.id}' references missing target node '${edge.targetNodeId}'`,
            edgeId: edge.id,
          });
        }
      }

      // Build adjacency for further checks
      const outbound = new Map<string, string[]>();
      const inbound = new Map<string, string[]>();
      for (const node of graph.graph.nodes) {
        outbound.set(node.id, []);
        inbound.set(node.id, []);
      }
      for (const edge of graph.graph.edges) {
        if (nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId)) {
          outbound.get(edge.sourceNodeId)!.push(edge.targetNodeId);
          inbound.get(edge.targetNodeId)!.push(edge.sourceNodeId);
        }
      }

      // 7. At least one entry node
      const entryNodes: string[] = [];
      for (const node of graph.graph.nodes) {
        if (inbound.get(node.id)!.length === 0) {
          entryNodes.push(node.id);
        }
      }
      if (entryNodes.length === 0) {
        errors.push({
          code: "WORKFLOW_NO_ENTRY_NODE",
          message: "Graph must have at least one node with no inbound edges",
        });
      }

      // 8. Acyclic check via DFS (also validates connectivity)
      {
        const WHITE = 0,
          GRAY = 1,
          BLACK = 2;
        const color = new Map<string, number>();
        for (const id of nodeIds) color.set(id, WHITE);

        let cycleDetected = false;

        function dfs(nodeId: string): void {
          color.set(nodeId, GRAY);
          for (const succ of outbound.get(nodeId) ?? []) {
            const c = color.get(succ);
            if (c === GRAY) {
              cycleDetected = true;
              return;
            }
            if (c === WHITE) {
              dfs(succ);
              if (cycleDetected) return;
            }
          }
          color.set(nodeId, BLACK);
        }

        for (const id of nodeIds) {
          if (color.get(id) === WHITE) {
            dfs(id);
            if (cycleDetected) break;
          }
        }

        if (cycleDetected) {
          errors.push({
            code: "WORKFLOW_CYCLE_DETECTED",
            message: "Graph contains a cycle",
          });
        }
      }

      // 9. Connected graph — undirected connectivity check
      //    All nodes must belong to a single connected component when
      //    edges are treated as undirected.
      if (graph.graph.nodes.length > 1) {
        // Build undirected adjacency
        const undirected = new Map<string, string[]>();
        for (const node of graph.graph.nodes) {
          undirected.set(node.id, []);
        }
        for (const edge of graph.graph.edges) {
          if (nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId)) {
            undirected.get(edge.sourceNodeId)!.push(edge.targetNodeId);
            undirected.get(edge.targetNodeId)!.push(edge.sourceNodeId);
          }
        }

        const visited = new Set<string>();
        const queue = [graph.graph.nodes[0].id];
        while (queue.length > 0) {
          const nodeId = queue.shift()!;
          if (visited.has(nodeId)) continue;
          visited.add(nodeId);
          for (const neighbor of undirected.get(nodeId) ?? []) {
            if (!visited.has(neighbor)) {
              queue.push(neighbor);
            }
          }
        }

        for (const id of nodeIds) {
          if (!visited.has(id)) {
            errors.push({
              code: "WORKFLOW_GRAPH_DISCONNECTED",
              message: `Node '${id}' is not reachable from any entry node`,
              nodeId: id,
            });
          }
        }
      }

      // 10. At least one terminal path
      {
        const terminalNodes = [...nodeIds].filter(
          (id) => outbound.get(id)!.length === 0,
        );
        if (terminalNodes.length === 0 && graph.graph.nodes.length > 0) {
          errors.push({
            code: "WORKFLOW_NO_TERMINAL_PATH",
            message:
              "Graph must have at least one path reaching a node with no outbound edges",
          });
        }
      }

      // 11. Node-type-specific validation
      for (const node of graph.graph.nodes) {
        if (
          node.type === "condition" &&
          outbound.get(node.id)!.length === 0
        ) {
          errors.push({
            code: "WORKFLOW_CONDITION_NO_OUTBOUND",
            message: `Condition node '${node.id}' must have at least one outbound edge`,
            nodeId: node.id,
          });
        }

        if (node.type === "action") {
          const config = node.config as Record<string, unknown>;
          if (!config.skillId && !config.ref) {
            errors.push({
              code: "WORKFLOW_ACTION_MISSING_REF",
              message: `Action node '${node.id}' must have a 'skillId' or 'ref' in config`,
              nodeId: node.id,
            });
          }
        }
      }

      // 12. Edge condition syntax validation
      for (const edge of graph.graph.edges) {
        if (edge.condition) {
          try {
            exprEval.parse(edge.condition);
          } catch (err) {
            console.warn("[friday][workflow-validator] invalid condition expression:", err instanceof Error ? err.message : String(err));
            errors.push({
              code: "WORKFLOW_EXPRESSION_INVALID",
              message: `Edge '${edge.id}' has invalid condition expression: '${edge.condition}'`,
              edgeId: edge.id,
            });
          }
        }
      }

      return { valid: errors.length === 0, errors };
    },
  };
}
